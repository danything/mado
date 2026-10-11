// GFX のブラウザ側: 面を canvas に持ち、フレームの終わりに変わったところを画面(Display)へ写す。H.264 は WebCodecs の VideoDecoder。

import type { Display } from "./display";
import {
	type AvcDecoder,
	codecString,
	type GfxOps,
	type Rect,
	type VideoFrameLike,
} from "./gfx";

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

type Surface = {
	canvas: OffscreenCanvas | HTMLCanvasElement;
	ctx: Canvas2D;
	width: number;
	height: number;
	map?: { x: number; y: number };
	/** 前の present() から変わったところ(和集合の矩形) */
	dirty?: Rect;
};

function makeCanvas(
	w: number,
	h: number,
): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Canvas2D } {
	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(w, h);
		const ctx = canvas.getContext("2d", { willReadFrequently: false });
		if (ctx) return { canvas, ctx };
	}
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas が使えない");
	return { canvas, ctx };
}

export class CanvasGfxOps implements GfxOps {
	private surfaces = new Map<number, Surface>();
	private cache = new Map<number, ImageData>();

	constructor(private display: Display) {}

	private surface(id: number): Surface {
		const s = this.surfaces.get(id);
		if (!s) throw new Error(`GFX: 無い面 ${id}`);
		return s;
	}

	private touch(s: Surface, x: number, y: number, w: number, h: number): void {
		const r = { left: x, top: y, right: x + w, bottom: y + h };
		const d = s.dirty;
		s.dirty = d
			? {
					left: Math.min(d.left, r.left),
					top: Math.min(d.top, r.top),
					right: Math.max(d.right, r.right),
					bottom: Math.max(d.bottom, r.bottom),
				}
			: r;
	}

	resetOutput(width: number, height: number): void {
		this.display.resize(width, height);
	}

	createSurface(id: number, width: number, height: number): void {
		const { canvas, ctx } = makeCanvas(width, height);
		this.surfaces.set(id, { canvas, ctx, width, height });
	}

	deleteSurface(id: number): void {
		this.surfaces.delete(id);
	}

	mapSurface(id: number, x: number, y: number): void {
		const s = this.surface(id);
		s.map = { x, y };
		this.touch(s, 0, 0, s.width, s.height);
	}

	putRgba(
		id: number,
		x: number,
		y: number,
		w: number,
		h: number,
		rgba: Uint8ClampedArray,
	): void {
		const s = this.surface(id);
		s.ctx.putImageData(
			new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h),
			x,
			y,
		);
		this.touch(s, x, y, w, h);
	}

	fill(
		id: number,
		rects: Rect[],
		rgba: [number, number, number, number],
	): void {
		const s = this.surface(id);
		for (const r of rects) {
			const w = r.right - r.left;
			const h = r.bottom - r.top;
			if (w <= 0 || h <= 0) continue;
			// putImageData は合成せずに置き換える(アルファを持つ面でもそのまま)
			const img = new ImageData(w, h);
			for (let i = 0; i < w * h; i++) img.data.set(rgba, i * 4);
			s.ctx.putImageData(img, r.left, r.top);
			this.touch(s, r.left, r.top, w, h);
		}
	}

	copyRect(src: number, rect: Rect, dst: number, x: number, y: number): void {
		const w = rect.right - rect.left;
		const h = rect.bottom - rect.top;
		if (w <= 0 || h <= 0) return;
		const img = this.surface(src).ctx.getImageData(rect.left, rect.top, w, h);
		const d = this.surface(dst);
		d.ctx.putImageData(img, x, y);
		this.touch(d, x, y, w, h);
	}

	toCache(slot: number, id: number, rect: Rect): void {
		const w = rect.right - rect.left;
		const h = rect.bottom - rect.top;
		if (w <= 0 || h <= 0) return;
		this.cache.set(
			slot,
			this.surface(id).ctx.getImageData(rect.left, rect.top, w, h),
		);
	}

	fromCache(slot: number, id: number, x: number, y: number): void {
		const img = this.cache.get(slot);
		if (!img) return;
		const s = this.surface(id);
		s.ctx.putImageData(img, x, y);
		this.touch(s, x, y, img.width, img.height);
	}

	evict(slot: number): void {
		this.cache.delete(slot);
	}

	setAlpha(id: number, rect: Rect, alpha: Uint8Array): void {
		const w = rect.right - rect.left;
		const h = rect.bottom - rect.top;
		const s = this.surface(id);
		const img = s.ctx.getImageData(rect.left, rect.top, w, h);
		for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = alpha[i] as number;
		s.ctx.putImageData(img, rect.left, rect.top);
		this.touch(s, rect.left, rect.top, w, h);
	}

	drawVideo(id: number, frame: unknown, dest: Rect, regions: Rect[]): void {
		const s = this.surface(id);
		const src = frame as CanvasImageSource;
		const list = regions.length
			? regions
			: [
					{
						left: 0,
						top: 0,
						right: dest.right - dest.left,
						bottom: dest.bottom - dest.top,
					},
				];
		for (const r of list) {
			const w = r.right - r.left;
			const h = r.bottom - r.top;
			if (w <= 0 || h <= 0) continue;
			s.ctx.drawImage(
				src,
				r.left,
				r.top,
				w,
				h,
				dest.left + r.left,
				dest.top + r.top,
				w,
				h,
			);
			this.touch(s, dest.left + r.left, dest.top + r.top, w, h);
		}
	}

	present(): void {
		for (const s of this.surfaces.values()) {
			const d = s.dirty;
			if (!d || !s.map) continue;
			s.dirty = undefined;
			const w = Math.min(d.right, s.width) - d.left;
			const h = Math.min(d.bottom, s.height) - d.top;
			if (w <= 0 || h <= 0) continue;
			this.display.blit(
				s.canvas,
				d.left,
				d.top,
				w,
				h,
				s.map.x + d.left,
				s.map.y + d.top,
			);
		}
	}
}

/** WebCodecs の VideoDecoder で H.264(Annex B)を復号する。結果は timestamp で対応づける */
export class WebCodecsAvc implements AvcDecoder {
	private decoder?: VideoDecoder;
	private codec?: string;
	private needKey = true;
	private ts = 0;
	private waiting = new Map<number, (f: VideoFrameLike | null) => void>();

	decode(stream: Uint8Array, key: boolean): Promise<VideoFrameLike | null> {
		const codec = codecString(stream);
		if (
			codec &&
			(codec !== this.codec || !this.decoder || this.decoder.state === "closed")
		)
			this.reset(codec);
		const decoder = this.decoder;
		if (!decoder || decoder.state !== "configured")
			return Promise.resolve(null);
		// 鍵フレーム(IDR)から始める
		if (this.needKey) {
			if (!key) return Promise.resolve(null);
			this.needKey = false;
		}
		const timestamp = this.ts++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.waiting.delete(timestamp)) resolve(null);
			}, 1000);
			this.waiting.set(timestamp, (f) => {
				clearTimeout(timer);
				resolve(f);
			});
			try {
				decoder.decode(
					new EncodedVideoChunk({
						type: key ? "key" : "delta",
						timestamp,
						data: stream,
					}),
				);
			} catch {
				this.waiting.delete(timestamp);
				clearTimeout(timer);
				this.needKey = true;
				resolve(null);
			}
		});
	}

	private reset(codec: string): void {
		this.close();
		this.codec = codec;
		this.needKey = true;
		this.decoder = new VideoDecoder({
			output: (frame) => {
				const r = this.waiting.get(frame.timestamp);
				if (r) {
					this.waiting.delete(frame.timestamp);
					r(frame);
				} else frame.close();
			},
			error: () => {
				// 復号器が壊れたら、次の鍵フレームの SPS で作り直す
				this.needKey = true;
				this.codec = undefined;
				for (const r of this.waiting.values()) r(null);
				this.waiting.clear();
			},
		});
		this.decoder.configure({ codec, optimizeForLatency: true });
	}

	close(): void {
		for (const r of this.waiting.values()) r(null);
		this.waiting.clear();
		if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
		this.decoder = undefined;
	}
}
