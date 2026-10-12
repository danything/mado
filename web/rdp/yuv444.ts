// AVC444 / AVC444v2([MS-RDPEGFX] 2.2.4.5・2.2.4.6・3.3.8.3)の YUV444 の組み立て。
// 主の絵(YUV420 そのまま)と補助の絵(4:4:4 で足りない色差を YUV420 の形に詰めたもの)を、面ごとの YUV444 の面に重ねる。
// 並べ方と色差の戻し方は FreeRDP の prim_YUV.c(general_LumaToYUV444・ChromaV1ToYUV444・ChromaV2ToYUV444・ChromaFilter)と同じ。

import type { Rect } from "./gfx";

/** 復号した YUV420 の 1 枚(I420 の 3 面)。width / height は面の大きさ(切り取り前の符号化の大きさのことがある) */
export type Yuv420 = {
	width: number;
	height: number;
	y: Uint8Array;
	u: Uint8Array;
	v: Uint8Array;
	yStride: number;
	uStride: number;
	vStride: number;
};

/** 色差を戻したとき、元(主の絵)とこれより近ければ元のまま(圧縮の雑音で色がにじまないように。FreeRDP の CONDITIONAL_CLIP) */
const FILTER_THRESHOLD = 30;

const clip = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 面 1 枚ぶんの YUV444。主の絵と補助の絵が別々に(または片方だけ)来るので、前のものを持っておく */
export class Yuv444 {
	readonly y: Uint8Array;
	readonly u: Uint8Array;
	readonly v: Uint8Array;
	/** 最後の主の絵(偶数の行・列の色差を戻すのに使う) */
	private main?: Yuv420;

	constructor(
		readonly width: number,
		readonly height: number,
	) {
		this.y = new Uint8Array(width * height);
		this.u = new Uint8Array(width * height).fill(128);
		this.v = new Uint8Array(width * height).fill(128);
	}

	/** 主の絵: Y はそのまま、色差は 2x2 に広げる(補助の絵が来るまでは 4:2:0 の色) */
	luma(p: Yuv420, rects: Rect[]): void {
		this.main = p;
		const W = this.width;
		for (const r0 of rects) {
			const r = this.even(r0, p);
			if (!r) continue;
			for (let y = r.top; y < r.bottom; y++) {
				const s = y * p.yStride;
				this.y.set(p.y.subarray(s + r.left, s + r.right), y * W + r.left);
			}
			for (let y = r.top; y < r.bottom; y += 2) {
				const su = (y >> 1) * p.uStride;
				const sv = (y >> 1) * p.vStride;
				const d0 = y * W;
				const d1 = y + 1 < r.bottom ? d0 + W : d0;
				for (let x = r.left; x < r.right; x += 2) {
					const cu = p.u[su + (x >> 1)] as number;
					const cv = p.v[sv + (x >> 1)] as number;
					this.u[d0 + x] = cu;
					this.v[d0 + x] = cv;
					this.u[d1 + x] = cu;
					this.v[d1 + x] = cv;
					if (x + 1 < r.right) {
						this.u[d0 + x + 1] = cu;
						this.v[d0 + x + 1] = cv;
						this.u[d1 + x + 1] = cu;
						this.v[d1 + x + 1] = cv;
					}
				}
			}
		}
	}

	/**
	 * 補助の絵: 足りない色差(偶数の行・列以外)を埋め、偶数の行・列は主の絵の平均から戻す。
	 * v1: 補助の Y は 16 行ごとに前の 8 行が U、後の 8 行が V の奇数行。補助の U / V は U / V の偶数行・奇数列。
	 * v2: 補助の Y は左半分が U、右半分が V の奇数列。補助の U / V は左右の 4 分の 1 ずつが U / V の奇数行の 4 の倍数の列(U)と +2 の列(V)
	 */
	chroma(p: Yuv420, v2: boolean, rects: Rect[]): boolean {
		const main = this.main;
		if (!main) return false; // 主の絵がまだ無い。戻せないので待つ
		const W = this.width;
		const U = this.u;
		const V = this.v;
		for (const r0 of rects) {
			const r = this.even(r0);
			if (!r) continue;
			if (!v2) {
				// B4 / B5: 奇数行の全部の列
				for (let y = r.top + 1; y < r.bottom; y += 2) {
					const k = y >> 1;
					const base = (k >> 3) * 16 + (k & 7);
					const ru = base;
					const rv = base + 8;
					const d = y * W;
					if (ru < p.height)
						U.set(
							p.y.subarray(ru * p.yStride + r.left, ru * p.yStride + r.right),
							d + r.left,
						);
					if (rv < p.height)
						V.set(
							p.y.subarray(rv * p.yStride + r.left, rv * p.yStride + r.right),
							d + r.left,
						);
				}
				// B6 / B7: 偶数行の奇数列
				for (let y = r.top; y < r.bottom && y < p.height; y += 2) {
					const su = (y >> 1) * p.uStride;
					const sv = (y >> 1) * p.vStride;
					const d = y * W;
					for (let x = r.left + 1; x < r.right; x += 2) {
						U[d + x] = p.u[su + (x >> 1)] as number;
						V[d + x] = p.v[sv + (x >> 1)] as number;
					}
				}
			} else {
				const halfW = W >> 1;
				const quarterW = W >> 2;
				// B4 / B5: 全部の行の奇数列(補助の Y の左半分が U、右半分が V)
				for (let y = r.top; y < r.bottom && y < p.height; y++) {
					const s = y * p.yStride;
					const d = y * W;
					for (let x = r.left + 1; x < r.right; x += 2) {
						U[d + x] = p.y[s + (x >> 1)] as number;
						V[d + x] = p.y[s + halfW + (x >> 1)] as number;
					}
				}
				// B6 - B9: 奇数行の偶数列。4 の倍数の列は補助の U、+2 の列は補助の V(どちらも左 4 分の 1 が U、次の 4 分の 1 が V)
				for (let y = r.top + 1; y < r.bottom; y += 2) {
					const k = y >> 1;
					if (k >= p.height >> 1) continue;
					const su = k * p.uStride;
					const sv = k * p.vStride;
					const d = y * W;
					for (let x = r.left; x < r.right; x += 2) {
						const j = x >> 2;
						if ((x & 3) === 0) {
							U[d + x] = p.u[su + j] as number;
							V[d + x] = p.u[su + quarterW + j] as number;
						} else {
							U[d + x] = p.v[sv + j] as number;
							V[d + x] = p.v[sv + quarterW + j] as number;
						}
					}
				}
			}
			this.filter(main, r);
		}
		return true;
	}

	/** 偶数の行・列: 主の絵の色差は 2x2 の平均なので、4 倍から残りの 3 つを引いて戻す */
	private filter(main: Yuv420, r: Rect): void {
		const W = this.width;
		const U = this.u;
		const V = this.v;
		for (let y = r.top; y + 1 < r.bottom; y += 2) {
			const su = (y >> 1) * main.uStride;
			const sv = (y >> 1) * main.vStride;
			const d0 = y * W;
			const d1 = d0 + W;
			for (let x = r.left; x + 1 < r.right; x += 2) {
				const mu = main.u[su + (x >> 1)] as number;
				const mv = main.v[sv + (x >> 1)] as number;
				const cu = clip(
					4 * mu -
						(U[d0 + x + 1] as number) -
						(U[d1 + x] as number) -
						(U[d1 + x + 1] as number),
				);
				const cv = clip(
					4 * mv -
						(V[d0 + x + 1] as number) -
						(V[d1 + x] as number) -
						(V[d1 + x + 1] as number),
				);
				U[d0 + x] = Math.abs(cu - mu) < FILTER_THRESHOLD ? mu : cu;
				V[d0 + x] = Math.abs(cv - mv) < FILTER_THRESHOLD ? mv : cv;
			}
		}
	}

	/** 矩形を RGBA に(BT.709・フル レンジ。FreeRDP の YUV2R / YUV2G / YUV2B と同じ係数) */
	rgba(r: Rect): Uint8ClampedArray {
		const w = r.right - r.left;
		const h = r.bottom - r.top;
		const out = new Uint8ClampedArray(w * h * 4);
		const W = this.width;
		let o = 0;
		for (let y = r.top; y < r.bottom; y++) {
			let i = y * W + r.left;
			for (let x = 0; x < w; x++, i++) {
				const Y = (this.y[i] as number) * 256;
				const d = (this.u[i] as number) - 128;
				const e = (this.v[i] as number) - 128;
				// Uint8ClampedArray が 0..255 に切る
				out[o++] = (Y + 403 * e) >> 8;
				out[o++] = (Y - 48 * d - 120 * e) >> 8;
				out[o++] = (Y + 475 * d) >> 8;
				out[o++] = 255;
			}
		}
		return out;
	}

	/** 矩形を面に収め、色差の 2x2 に合わせて偶数に広げる。p を渡すと、その絵にある範囲にも収める */
	private even(r: Rect, p?: Yuv420): Rect | undefined {
		const right = Math.min(
			this.width,
			p ? p.width : this.width,
			r.right + (r.right & 1),
		);
		const bottom = Math.min(
			this.height,
			p ? p.height : this.height,
			r.bottom + (r.bottom & 1),
		);
		const left = Math.max(0, r.left & ~1);
		const top = Math.max(0, r.top & ~1);
		return right > left && bottom > top
			? { left, top, right, bottom }
			: undefined;
	}
}

/** 描く範囲: 面に収めた矩形(regions が空なら全体) */
export function clampRects(regions: Rect[], w: number, h: number): Rect[] {
	if (!regions.length) return [{ left: 0, top: 0, right: w, bottom: h }];
	const out: Rect[] = [];
	for (const r of regions) {
		const left = Math.max(0, r.left);
		const top = Math.max(0, r.top);
		const right = Math.min(w, r.right);
		const bottom = Math.min(h, r.bottom);
		if (right > left && bottom > top) out.push({ left, top, right, bottom });
	}
	return out;
}

/** WebCodecs の VideoFrame のうち、ここで使うところ */
export type VideoFrameYuv = {
	format: string | null;
	codedWidth: number;
	codedHeight: number;
	visibleRect: { x: number; y: number; width: number; height: number } | null;
	allocationSize(options?: { rect?: DOMRectInit }): number;
	copyTo(
		dest: Uint8Array,
		options?: { rect?: DOMRectInit },
	): Promise<{ offset: number; stride: number }[]>;
};

/**
 * VideoFrame から I420 の 3 面を取り出す(NV12 は U / V に分ける)。それ以外の形式は undefined。
 * 補助の絵(v1)は 16 行に揃えた下の端も使うので、できれば切り取る前の全体(codedRect)を読む
 */
export async function videoFrameYuv(
	frame: VideoFrameYuv,
): Promise<Yuv420 | undefined> {
	const format = frame.format;
	if (format !== "I420" && format !== "I420A" && format !== "NV12")
		return undefined;
	const coded = {
		x: 0,
		y: 0,
		width: frame.codedWidth,
		height: frame.codedHeight,
	};
	let rect: DOMRectInit | undefined = coded;
	let size: number;
	try {
		size = frame.allocationSize({ rect });
	} catch {
		rect = undefined;
		size = frame.allocationSize();
	}
	const width = rect ? coded.width : (frame.visibleRect?.width ?? 0);
	const height = rect ? coded.height : (frame.visibleRect?.height ?? 0);
	const buf = new Uint8Array(size);
	const layout = await frame.copyTo(buf, rect ? { rect } : undefined);
	const [py, p1, p2] = layout;
	if (!py || !p1) return undefined;
	const y = buf.subarray(py.offset, py.offset + py.stride * height);
	const ch = (height + 1) >> 1;
	if (format !== "NV12") {
		if (!p2) return undefined;
		return {
			width,
			height,
			y,
			u: buf.subarray(p1.offset, p1.offset + p1.stride * ch),
			v: buf.subarray(p2.offset, p2.offset + p2.stride * ch),
			yStride: py.stride,
			uStride: p1.stride,
			vStride: p2.stride,
		};
	}
	// NV12: UV が交互に並ぶ 1 面
	const cw = (width + 1) >> 1;
	const u = new Uint8Array(cw * ch);
	const v = new Uint8Array(cw * ch);
	for (let j = 0; j < ch; j++) {
		const s = p1.offset + j * p1.stride;
		const d = j * cw;
		for (let i = 0; i < cw; i++) {
			u[d + i] = buf[s + 2 * i] as number;
			v[d + i] = buf[s + 2 * i + 1] as number;
		}
	}
	return {
		width,
		height,
		y,
		u,
		v,
		yStride: py.stride,
		uStride: cw,
		vStride: cw,
	};
}
