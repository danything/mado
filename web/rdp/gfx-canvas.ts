// GFX のブラウザ側: 面を canvas に持ち、フレームの終わりに変わったところを画面(Display)へ写す。H.264 は WebCodecs の VideoDecoder。

import type { Display } from "./display";
import {
	type AvcDecoder,
	codecString,
	type GfxOps,
	type Rect,
	type VideoFrameLike,
} from "./gfx";
import { videoFrameYuv, type Yuv420 } from "./yuv444";

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

type Surface = {
	canvas: OffscreenCanvas | HTMLCanvasElement;
	ctx: Canvas2D;
	width: number;
	height: number;
	/** アルファを持つ面(ARGB)。持たない面は全部不透明なので、重ねて描いても置き換えと同じになる */
	alpha: boolean;
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
	private cache = new Map<number, OffscreenCanvas | HTMLCanvasElement>();

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
		// 画面が消えたかもしれないので、残っている面は次の present で全部写し直す
		for (const s of this.surfaces.values())
			this.touch(s, 0, 0, s.width, s.height);
	}

	createSurface(
		id: number,
		width: number,
		height: number,
		alpha: boolean,
	): void {
		const { canvas, ctx } = makeCanvas(width, height);
		this.surfaces.set(id, { canvas, ctx, width, height, alpha });
	}

	/**
	 * 面の矩形を、draw で描いたもので置き換える(putImageData と同じく合成しない)。
	 * getImageData / putImageData は GPU から読み戻すので遅い(スクロールの写しで 30 倍ほど)。drawImage と fillRect で GPU の上のまま済ませる
	 */
	private replace(
		s: Surface,
		x: number,
		y: number,
		w: number,
		h: number,
		draw: (ctx: Canvas2D) => void,
	): void {
		if (!s.alpha) {
			draw(s.ctx);
		} else {
			// 透明を含む絵でも下の絵と混ぜない。copy は描いた外まで消すので、矩形で切ってから
			s.ctx.save();
			s.ctx.beginPath();
			s.ctx.rect(x, y, w, h);
			s.ctx.clip();
			s.ctx.globalCompositeOperation = "copy";
			draw(s.ctx);
			s.ctx.restore();
		}
		this.touch(s, x, y, w, h);
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
		const [r, g, b, a] = rgba;
		const color = `rgb(${r} ${g} ${b} / ${a / 255})`;
		for (const rc of rects) {
			const w = rc.right - rc.left;
			const h = rc.bottom - rc.top;
			if (w <= 0 || h <= 0) continue;
			this.replace(s, rc.left, rc.top, w, h, (ctx) => {
				ctx.fillStyle = color;
				ctx.fillRect(rc.left, rc.top, w, h);
			});
		}
	}

	copyRect(src: number, rect: Rect, dst: number, x: number, y: number): void {
		const w = rect.right - rect.left;
		const h = rect.bottom - rect.top;
		if (w <= 0 || h <= 0) return;
		// 同じ面の中で重なっていても、drawImage は元を写してから描く
		const from = this.surface(src).canvas;
		this.replace(this.surface(dst), x, y, w, h, (ctx) =>
			ctx.drawImage(from, rect.left, rect.top, w, h, x, y, w, h),
		);
	}

	toCache(slot: number, id: number, rect: Rect): void {
		const w = rect.right - rect.left;
		const h = rect.bottom - rect.top;
		if (w <= 0 || h <= 0) return;
		// 新しい透明な canvas に描くので、合成しても置き換えと同じ
		const c = makeCanvas(w, h);
		c.ctx.drawImage(
			this.surface(id).canvas,
			rect.left,
			rect.top,
			w,
			h,
			0,
			0,
			w,
			h,
		);
		this.cache.set(slot, c.canvas);
	}

	fromCache(slot: number, id: number, x: number, y: number): void {
		const c = this.cache.get(slot);
		if (!c) return;
		this.replace(this.surface(id), x, y, c.width, c.height, (ctx) =>
			ctx.drawImage(c, x, y),
		);
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

	/**
	 * フレームの終わり。描画の周期(vsync)に 1 回だけ画面へ写す: 周期の最初のフレームはすぐ写し(待たせない)、
	 * 同じ周期に続いて来たものは、周期の終わりにまとめて 1 回写す(変わったところは面ごとに和集合で残っている)
	 */
	present(): void {
		if (this.waitingTick) {
			this.pendingFlush = true;
			return;
		}
		this.flush();
		this.waitingTick = true;
		nextTick(() => {
			this.waitingTick = false;
			if (!this.pendingFlush) return;
			this.pendingFlush = false;
			this.present();
		});
	}

	/** この描画の周期に、もう写した */
	private waitingTick = false;
	/** 周期の終わりに写すものがある */
	private pendingFlush = false;

	private flush(): void {
		// 変わった範囲(画面の座標)を集める
		const changed: Rect[] = [];
		for (const s of this.surfaces.values()) {
			const d = s.dirty;
			s.dirty = undefined;
			if (!d || !s.map) continue;
			const r = clip(d, { left: 0, top: 0, right: s.width, bottom: s.height });
			if (r)
				changed.push({
					left: s.map.x + r.left,
					top: s.map.y + r.top,
					right: s.map.x + r.right,
					bottom: s.map.y + r.bottom,
				});
		}
		// 変わった範囲ごとに、そこに掛かる全部の面を作成の順(後のものが上)に描き直す。面が重なっていても、変わっていない面が消えない
		for (const c of changed) {
			let first = true;
			for (const s of this.surfaces.values()) {
				if (!s.map) continue;
				const onScreen = {
					left: s.map.x,
					top: s.map.y,
					right: s.map.x + s.width,
					bottom: s.map.y + s.height,
				};
				const r = clip(c, onScreen);
				if (!r) continue;
				const w = r.right - r.left;
				const h = r.bottom - r.top;
				const sx = r.left - s.map.x;
				const sy = r.top - s.map.y;
				// 最初の面は置き換え(消してから描く)、後の面は重ねる
				if (first) this.display.blit(s.canvas, sx, sy, w, h, r.left, r.top);
				else this.display.blitOver(s.canvas, sx, sy, w, h, r.left, r.top);
				first = false;
			}
		}
	}
}

/**
 * 次の描画の周期に cb を 1 回呼ぶ。requestAnimationFrame は隠れたタブなどで止まるので、50ms で打ち切る(画面が止まったままにしない)
 */
function nextTick(cb: () => void): void {
	let done = false;
	const once = () => {
		if (done) return;
		done = true;
		cb();
	};
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(once);
	setTimeout(once, 50);
}

/** 2 つの矩形の重なり。無ければ undefined */
function clip(a: Rect, b: Rect): Rect | undefined {
	const left = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top);
	const right = Math.min(a.right, b.right);
	const bottom = Math.min(a.bottom, b.bottom);
	return right > left && bottom > top
		? { left, top, right, bottom }
		: undefined;
}

/** 1 フレームの復号を待つ長さ。過ぎたら捨てる */
const AVC_TIMEOUT_MS = 1000;

/** WebCodecs の VideoDecoder で H.264(Annex B)を復号する。結果は timestamp で対応づける */
export class WebCodecsAvc implements AvcDecoder {
	private decoder?: VideoDecoder;
	private codec?: string;
	private needKey = true;
	private ts = 0;
	private waiting = new Map<number, (f: VideoFrameLike | null) => void>();
	/** close() のあと。復号器を作り直さない */
	private closed = false;

	/** hardware: GPU で復号できる(avcSupport で調べたもの)。できないのに頼むと configure で失敗するので、できるときだけ頼む */
	constructor(private hardware = false) {}

	decode(stream: Uint8Array, key: boolean): Promise<VideoFrameLike | null> {
		if (this.closed) return Promise.resolve(null);
		const codec = codecString(stream);
		if (
			codec &&
			(codec !== this.codec || !this.decoder || this.decoder.state === "closed")
		)
			this.reset(codec);
		const decoder = this.decoder;
		if (decoder?.state !== "configured") return Promise.resolve(null);
		// 鍵フレーム(IDR)から始める
		if (this.needKey) {
			if (!key) return Promise.resolve(null);
			this.needKey = false;
		}
		const timestamp = this.ts++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (!this.waiting.delete(timestamp)) return;
				// このフレームを捨てたので、後の差分フレームは壊れた参照になる。次の鍵フレームまで待つ
				this.needKey = true;
				resolve(null);
			}, AVC_TIMEOUT_MS);
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

	/** AVC444 用: 1 枚を復号して YUV420 の 3 面を読み出す(I420 / NV12 でなければ null) */
	async decodeYuv(stream: Uint8Array, key: boolean): Promise<Yuv420 | null> {
		const frame = await this.decode(stream, key);
		if (!frame) return null;
		try {
			return (await videoFrameYuv(frame as VideoFrame)) ?? null;
		} catch {
			return null;
		} finally {
			frame.close();
		}
	}

	private reset(codec: string): void {
		this.shutdown();
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
				// GPU での復号が壊れたなら、作り直すときは GPU を頼まない(大きい絵や別のプロファイルで、GPU の復号器だけ失敗することがある)
				this.hardware = false;
				this.needKey = true;
				this.codec = undefined;
				for (const r of this.waiting.values()) r(null);
				this.waiting.clear();
			},
		});
		this.decoder.configure({
			codec,
			optimizeForLatency: true,
			hardwareAcceleration: this.hardware ? "prefer-hardware" : "no-preference",
		});
	}

	close(): void {
		this.closed = true;
		this.shutdown();
	}

	private shutdown(): void {
		for (const r of this.waiting.values()) r(null);
		this.waiting.clear();
		if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
		this.decoder = undefined;
	}
}
