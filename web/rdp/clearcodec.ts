// ClearCodec([MS-RDPEGFX] 2.2.4.1)。GFX で文字や UI の部品に使われる。
// 残差(residual)→ 帯(bands、縦の棒 vBar のキャッシュ)→ サブコーデック(生 / RLEX。NSCodec は未対応)の順に重ねる。
// グリフのキャッシュと vBar のキャッシュはセッションを通して持つので、1 つの ClearDecoder を使い続ける。

import { Reader } from "./bytes";

const FLAG_GLYPH_INDEX = 0x01;
const FLAG_GLYPH_HIT = 0x02;
const FLAG_CACHE_RESET = 0x04;

const VBAR_STORAGE = 32768;
const SHORT_VBAR_STORAGE = 16384;
const GLYPH_STORAGE = 4000;
/** グリフにしてよい大きさ(画素数) */
const GLYPH_MAX_PIXELS = 1024 * 1024;
const MAX_PIXELS = 1 << 24;

/** BGR の 3 バイトずつの並び(縦の棒) */
type VBar = Uint8Array;

export class ClearDecoder {
	private vBars: (VBar | undefined)[] = new Array(VBAR_STORAGE);
	private shortVBars: (VBar | undefined)[] = new Array(SHORT_VBAR_STORAGE);
	private vBarCursor = 0;
	private shortVBarCursor = 0;
	private glyphs: (
		| { w: number; h: number; rgba: Uint8ClampedArray }
		| undefined
	)[] = new Array(GLYPH_STORAGE);
	/** NSCodec のように未対応のサブコーデックが来た数(診断用) */
	unsupported = 0;

	/** w x h の RGBA(上の行から、不透明)を返す */
	decode(data: Uint8Array, w: number, h: number): Uint8ClampedArray {
		if (w <= 0 || h <= 0 || w * h > MAX_PIXELS)
			throw new Error("ClearCodec: 大きさが不正");
		const r = new Reader(data);
		const flags = r.u8();
		r.u8(); // seqNumber
		let glyphIndex = -1;
		if (flags & FLAG_GLYPH_INDEX) {
			glyphIndex = r.u16();
			if (glyphIndex >= GLYPH_STORAGE)
				throw new Error("ClearCodec: グリフの番号が不正");
		}
		if (flags & FLAG_CACHE_RESET) {
			this.vBarCursor = 0;
			this.shortVBarCursor = 0;
		}
		if (flags & FLAG_GLYPH_HIT) {
			const g = this.glyphs[glyphIndex];
			if (!g) throw new Error("ClearCodec: キャッシュに無いグリフ");
			if (g.w * g.h !== w * h)
				throw new Error("ClearCodec: グリフの大きさが合わない");
			return g.rgba.slice();
		}
		const out = new Uint8ClampedArray(w * h * 4);
		for (let i = 3; i < out.length; i += 4) out[i] = 255;
		if (r.left > 0) {
			const residualBytes = r.u32();
			const bandsBytes = r.u32();
			const subcodecBytes = r.u32();
			if (residualBytes) residual(r.bytes(residualBytes), out, w, h);
			if (bandsBytes) this.bands(r.bytes(bandsBytes), out, w, h);
			if (subcodecBytes) this.subcodecs(r.bytes(subcodecBytes), out, w, h);
		}
		if (glyphIndex >= 0 && w * h <= GLYPH_MAX_PIXELS)
			this.glyphs[glyphIndex] = { w, h, rgba: out.slice() };
		return out;
	}

	private bands(
		data: Uint8Array,
		out: Uint8ClampedArray,
		w: number,
		h: number,
	): void {
		const r = new Reader(data);
		while (r.left > 0) {
			const xStart = r.u16();
			const xEnd = r.u16();
			const yStart = r.u16();
			const yEnd = r.u16();
			const bg = r.bytes(3);
			if (xEnd < xStart || yEnd < yStart)
				throw new Error("ClearCodec: 帯の範囲が不正");
			const height = yEnd - yStart + 1;
			for (let x = xStart; x <= xEnd; x++) {
				const header = r.u16();
				let bar: VBar;
				if ((header & 0xc000) === 0x4000) {
					// SHORT_VBAR_CACHE_HIT: 短い棒 + 上の余白(yOn)
					const short = this.shortVBars[header & 0x3fff];
					if (!short) throw new Error("ClearCodec: キャッシュに無い短い棒");
					bar = this.fullBar(short, r.u8(), height, bg);
				} else if ((header & 0xc000) === 0x0000) {
					// SHORT_VBAR_CACHE_MISS: 短い棒の画素がここに来る
					const yOn = header & 0xff;
					const yOff = (header >> 8) & 0x3f;
					if (yOff < yOn) throw new Error("ClearCodec: 短い棒の範囲が不正");
					const short = r.bytes((yOff - yOn) * 3).slice();
					this.shortVBars[this.shortVBarCursor] = short;
					this.shortVBarCursor =
						(this.shortVBarCursor + 1) % SHORT_VBAR_STORAGE;
					bar = this.fullBar(short, yOn, height, bg);
				} else {
					// VBAR_CACHE_HIT
					const hit = this.vBars[header & 0x7fff];
					if (!hit) throw new Error("ClearCodec: キャッシュに無い棒");
					bar = hit;
					if (bar.length !== height * 3)
						throw new Error("ClearCodec: 棒の高さが合わない");
					this.drawBar(bar, x, yStart, height, out, w, h);
					continue;
				}
				this.vBars[this.vBarCursor] = bar;
				this.vBarCursor = (this.vBarCursor + 1) % VBAR_STORAGE;
				this.drawBar(bar, x, yStart, height, out, w, h);
			}
		}
	}

	/** 短い棒の上下を背景色で埋めて、帯の高さの棒にする */
	private fullBar(
		short: VBar,
		yOn: number,
		height: number,
		bg: Uint8Array,
	): VBar {
		const bar = new Uint8Array(height * 3);
		const n = short.length / 3;
		for (let y = 0; y < height; y++) {
			const src =
				y >= yOn && y < yOn + n
					? short.subarray((y - yOn) * 3, (y - yOn) * 3 + 3)
					: bg;
			bar.set(src, y * 3);
		}
		return bar;
	}

	private drawBar(
		bar: VBar,
		x: number,
		y0: number,
		height: number,
		out: Uint8ClampedArray,
		w: number,
		h: number,
	): void {
		if (x >= w) return;
		for (let i = 0; i < height; i++) {
			const y = y0 + i;
			if (y >= h) break;
			const d = (y * w + x) * 4;
			out[d] = bar[i * 3 + 2] as number;
			out[d + 1] = bar[i * 3 + 1] as number;
			out[d + 2] = bar[i * 3] as number;
		}
	}

	private subcodecs(
		data: Uint8Array,
		out: Uint8ClampedArray,
		w: number,
		h: number,
	): void {
		const r = new Reader(data);
		while (r.left > 0) {
			const x0 = r.u16();
			const y0 = r.u16();
			const sw = r.u16();
			const sh = r.u16();
			const len = r.u32();
			const id = r.u8();
			const body = r.bytes(len);
			if (sw * sh > MAX_PIXELS)
				throw new Error("ClearCodec: サブコーデックが大きすぎる");
			let bgr: Uint8Array;
			if (id === 0) {
				if (body.length < sw * sh * 3)
					throw new Error("ClearCodec: 生の画素が短い");
				bgr = body;
			} else if (id === 2) {
				bgr = rlex(body, sw * sh);
			} else {
				// NSCodec(1)は未対応。この部分は描かない
				this.unsupported++;
				continue;
			}
			for (let y = 0; y < sh; y++) {
				const ty = y0 + y;
				if (ty >= h) break;
				for (let x = 0; x < sw; x++) {
					const tx = x0 + x;
					if (tx >= w) break;
					const s = (y * sw + x) * 3;
					const d = (ty * w + tx) * 4;
					out[d] = bgr[s + 2] as number;
					out[d + 1] = bgr[s + 1] as number;
					out[d + 2] = bgr[s] as number;
				}
			}
		}
	}
}

/** 長さ: 1 バイト、0xFF なら 2 バイト、0xFFFF なら 4 バイト */
function runLength(r: Reader): number {
	let n = r.u8();
	if (n === 0xff) {
		n = r.u16();
		if (n === 0xffff) n = r.u32();
	}
	return n;
}

/** 残差: (B, G, R, 長さ)の並びで、上の行から全面を埋める */
function residual(
	data: Uint8Array,
	out: Uint8ClampedArray,
	w: number,
	h: number,
): void {
	const r = new Reader(data);
	const total = w * h;
	let p = 0;
	while (r.left > 0 && p < total) {
		const b = r.u8();
		const g = r.u8();
		const red = r.u8();
		const n = runLength(r);
		if (p + n > total) throw new Error("ClearCodec: 残差があふれた");
		for (let i = 0; i < n; i++, p++) {
			out[p * 4] = red;
			out[p * 4 + 1] = g;
			out[p * 4 + 2] = b;
		}
	}
	if (p !== total) throw new Error("ClearCodec: 残差が足りない");
}

/** RLEX: パレット + (並びの長さ、続き)。結果は BGR の 3 バイトずつ */
export function rlex(data: Uint8Array, pixels: number): Uint8Array {
	const r = new Reader(data);
	const count = r.u8();
	if (count === 0 || count > 127)
		throw new Error("ClearCodec: RLEX のパレットが不正");
	const palette = r.bytes(count * 3);
	// stopIndex のビット数: floor(log2(count - 1)) + 1
	const bits = count === 1 ? 1 : 32 - Math.clz32(count - 1);
	const out = new Uint8Array(pixels * 3);
	let p = 0;
	const put = (idx: number) => {
		if (p >= pixels) throw new Error("ClearCodec: RLEX があふれた");
		if (idx >= count) throw new Error("ClearCodec: RLEX の色の番号が不正");
		out.set(palette.subarray(idx * 3, idx * 3 + 3), p * 3);
		p++;
	};
	while (p < pixels) {
		const t = r.u8();
		const stop = t & ((1 << bits) - 1);
		const depth = t >> bits;
		const run = runLength(r);
		const start = stop - depth;
		if (start < 0) throw new Error("ClearCodec: RLEX の範囲が不正");
		for (let i = 0; i < run; i++) put(start);
		for (let i = 0; i <= depth; i++) put(start + i);
	}
	return out;
}
