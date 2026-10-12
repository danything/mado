// ビットマップの更新([MS-RDPBCGR] 2.2.9.1.1.3.1.2)。矩形の並びを読み、生または Interleaved RLE([MS-RDPEGDI] 3.1.9)を RGBA に直す。
// 色の深さは 15 / 16 / 24 / 32(32 は生のみ)。画面は 16 ビットで頼む(connect.ts の能力セット)。

import { Reader } from "./bytes";

export type BitmapRect = {
	left: number;
	top: number;
	/** 含む(右端の列) */
	right: number;
	bottom: number;
	/** 復号する大きさ(右端が 4 の倍数に揃えられていて、right - left + 1 より大きいことがある) */
	width: number;
	height: number;
	bpp: number;
	compressed: boolean;
	data: Uint8Array;
};

/** 1 つの矩形の画素数の上限(普通は 64x64 など小さい) */
const MAX_PIXELS = 1 << 24;

const BITMAP_COMPRESSION = 0x0001;
const NO_BITMAP_COMPRESSION_HDR = 0x0400;

/** TS_UPDATE_BITMAP_DATA(updateType から) */
export function parseBitmapUpdate(payload: Uint8Array): BitmapRect[] {
	const r = new Reader(payload);
	r.u16(); // updateType
	const n = r.u16();
	const out: BitmapRect[] = [];
	for (let i = 0; i < n; i++) {
		const left = r.u16();
		const top = r.u16();
		const right = r.u16();
		const bottom = r.u16();
		const width = r.u16();
		const height = r.u16();
		const bpp = r.u16();
		const flags = r.u16();
		const len = r.u16();
		const compressed = (flags & BITMAP_COMPRESSION) !== 0;
		const hdr = compressed && !(flags & NO_BITMAP_COMPRESSION_HDR) ? 8 : 0;
		if (len < hdr) throw new Error("ビットマップの長さが不正");
		r.skip(hdr);
		out.push({
			left,
			top,
			right,
			bottom,
			width,
			height,
			bpp,
			compressed,
			data: r.bytes(len - hdr),
		});
	}
	return out;
}

/** 復号に要るもの(位置は要らない)。Worker へはこれだけを渡す */
export type BitmapJob = Pick<
	BitmapRect,
	"width" | "height" | "bpp" | "compressed" | "data"
>;

/** 矩形を RGBA(上の行から、width x height)にする */
export function decodeBitmap(b: BitmapJob | BitmapRect): Uint8ClampedArray {
	if (b.bpp === 8) throw new Error("8 ビット色の画面は使えない");
	if (b.width * b.height > MAX_PIXELS)
		throw new Error("ビットマップが大きすぎる");
	if (b.compressed && b.bpp === 32)
		return decodePlanar(b.data, b.width, b.height);
	const px = b.bpp === 15 ? 2 : b.bpp >> 3; // 1 画素のバイト数
	const rowBytes = b.width * px;
	const src = b.compressed
		? rleDecompress(b.data, b.width, b.height, px)
		: b.data;
	if (src.length < rowBytes * b.height)
		throw new Error(
			`ビットマップが短い (${src.length} < ${rowBytes * b.height})`,
		);
	const out = new Uint8ClampedArray(b.width * b.height * 4);
	for (let y = 0; y < b.height; y++) {
		// 行は下から上へ並んでいる
		let s = (b.height - 1 - y) * rowBytes;
		let d = y * b.width * 4;
		for (let x = 0; x < b.width; x++) {
			switch (b.bpp) {
				case 16: {
					const p = (src[s] as number) | ((src[s + 1] as number) << 8);
					const r5 = (p >> 11) & 31;
					const g6 = (p >> 5) & 63;
					const b5 = p & 31;
					out[d] = (r5 << 3) | (r5 >> 2);
					out[d + 1] = (g6 << 2) | (g6 >> 4);
					out[d + 2] = (b5 << 3) | (b5 >> 2);
					s += 2;
					break;
				}
				case 15: {
					const p = (src[s] as number) | ((src[s + 1] as number) << 8);
					const r5 = (p >> 10) & 31;
					const g5 = (p >> 5) & 31;
					const b5 = p & 31;
					out[d] = (r5 << 3) | (r5 >> 2);
					out[d + 1] = (g5 << 3) | (g5 >> 2);
					out[d + 2] = (b5 << 3) | (b5 >> 2);
					s += 2;
					break;
				}
				case 24:
					out[d] = src[s + 2] as number;
					out[d + 1] = src[s + 1] as number;
					out[d + 2] = src[s] as number;
					s += 3;
					break;
				case 32:
					out[d] = src[s + 2] as number;
					out[d + 1] = src[s + 1] as number;
					out[d + 2] = src[s] as number;
					s += 4;
					break;
				default:
					throw new Error(`色の深さ ${b.bpp} は使えない`);
			}
			out[d + 3] = 255;
			d += 4;
		}
	}
	return out;
}

// ---- Interleaved RLE ----

const REGULAR_BG_RUN = 0x00;
const REGULAR_FG_RUN = 0x01;
const REGULAR_FGBG_IMAGE = 0x02;
const REGULAR_COLOR_RUN = 0x03;
const REGULAR_COLOR_IMAGE = 0x04;
const LITE_SET_FG_FG_RUN = 0x0c;
const LITE_SET_FG_FGBG_IMAGE = 0x0d;
const LITE_DITHERED_RUN = 0x0e;
const MEGA_MEGA_BG_RUN = 0xf0;
const MEGA_MEGA_FG_RUN = 0xf1;
const MEGA_MEGA_FGBG_IMAGE = 0xf2;
const MEGA_MEGA_COLOR_RUN = 0xf3;
const MEGA_MEGA_COLOR_IMAGE = 0xf4;
const MEGA_MEGA_SET_FG_RUN = 0xf6;
const MEGA_MEGA_SET_FGBG_IMAGE = 0xf7;
const MEGA_MEGA_DITHERED_RUN = 0xf8;
const SPECIAL_FGBG_1 = 0xf9;
const SPECIAL_FGBG_2 = 0xfa;
const WHITE = 0xfd;
const BLACK = 0xfe;

function codeOf(header: number): number {
	if ((header & 0xc0) !== 0xc0) return header >> 5; // 0..4
	if ((header & 0xf0) === 0xf0) return header; // 0xf0..0xff
	return header >> 4; // 0xc..0xe
}

/** bpp バイトの画素単位で動く。結果は下の行から並ぶ width * height * bpp バイト */
export function rleDecompress(
	src: Uint8Array,
	width: number,
	height: number,
	bpp: number,
): Uint8Array {
	if (width * height > MAX_PIXELS) throw new Error("RLE: 大きすぎる");
	const rowDelta = width * bpp;
	const out = new Uint8Array(rowDelta * height);
	let s = 0;
	let d = 0;
	const fg = new Uint8Array(bpp).fill(0xff);
	let insertFg = false;

	const above = (i: number) =>
		d + i >= rowDelta ? (out[d + i - rowDelta] as number) : 0;
	const put = (v: number, i: number) => {
		out[d + i] = v;
	};
	const firstLine = () => d < rowDelta;

	/** 1 画素ぶんを d に書く: 上の行と fg の XOR(最初の行は fg そのもの) */
	const writeFg = () => {
		for (let i = 0; i < bpp; i++)
			put(firstLine() ? (fg[i] as number) : above(i) ^ (fg[i] as number), i);
		d += bpp;
	};
	const writeBg = () => {
		for (let i = 0; i < bpp; i++) put(firstLine() ? 0 : above(i), i);
		d += bpp;
	};
	const readPixel = (): Uint8Array => {
		if (s + bpp > src.length) throw new Error("RLE: 入力が足りない");
		const p = src.subarray(s, s + bpp);
		s += bpp;
		return p;
	};
	/** 命令の追加バイト(長さ・マスク)を、入力の範囲を見て読む */
	const byteAt = (i: number): number => {
		if (i >= src.length) throw new Error("RLE: 入力が足りない");
		return src[i] as number;
	};
	const need = (n: number) => {
		if (d + n * bpp > out.length) throw new Error("RLE: 出力があふれた");
	};

	while (s < src.length) {
		const header = src[s] as number;
		const code = codeOf(header);
		let run = 0;
		switch (code) {
			case REGULAR_FGBG_IMAGE:
			case LITE_SET_FG_FGBG_IMAGE: {
				const mask = code === REGULAR_FGBG_IMAGE ? 0x1f : 0x0f;
				run = header & mask;
				if (run === 0) {
					run = byteAt(s + 1) + 1;
					s += 2;
				} else {
					run *= 8;
					s += 1;
				}
				break;
			}
			case MEGA_MEGA_BG_RUN:
			case MEGA_MEGA_FG_RUN:
			case MEGA_MEGA_FGBG_IMAGE:
			case MEGA_MEGA_COLOR_RUN:
			case MEGA_MEGA_COLOR_IMAGE:
			case MEGA_MEGA_SET_FG_RUN:
			case MEGA_MEGA_SET_FGBG_IMAGE:
			case MEGA_MEGA_DITHERED_RUN:
				run = byteAt(s + 1) | (byteAt(s + 2) << 8);
				s += 3;
				break;
			case SPECIAL_FGBG_1:
			case SPECIAL_FGBG_2:
			case WHITE:
			case BLACK:
				s += 1;
				break;
			default: {
				const lite = code >= LITE_SET_FG_FG_RUN && code <= LITE_DITHERED_RUN;
				run = header & (lite ? 0x0f : 0x1f);
				if (run === 0) {
					run = byteAt(s + 1) + (lite ? 16 : 32);
					s += 2;
				} else s += 1;
			}
		}

		if (code === REGULAR_BG_RUN || code === MEGA_MEGA_BG_RUN) {
			need(run);
			let n = run;
			if (insertFg && n > 0) {
				writeFg();
				n--;
			}
			while (n-- > 0) writeBg();
			// 続けて背景の run が来たら、その最初の画素は fg が入る
			insertFg = true;
			continue;
		}
		insertFg = false;

		// SET_FG の命令は、run の長さのあとに前景色が続く
		if (
			code === LITE_SET_FG_FG_RUN ||
			code === MEGA_MEGA_SET_FG_RUN ||
			code === LITE_SET_FG_FGBG_IMAGE ||
			code === MEGA_MEGA_SET_FGBG_IMAGE
		)
			fg.set(readPixel());

		switch (code) {
			case LITE_SET_FG_FG_RUN:
			case MEGA_MEGA_SET_FG_RUN:
			case REGULAR_FG_RUN:
			case MEGA_MEGA_FG_RUN:
				need(run);
				for (let i = 0; i < run; i++) writeFg();
				break;
			case LITE_DITHERED_RUN:
			case MEGA_MEGA_DITHERED_RUN: {
				const a = readPixel();
				const b = readPixel();
				need(run * 2);
				for (let i = 0; i < run; i++) {
					out.set(a, d);
					d += bpp;
					out.set(b, d);
					d += bpp;
				}
				break;
			}
			case REGULAR_COLOR_RUN:
			case MEGA_MEGA_COLOR_RUN: {
				const p = readPixel();
				need(run);
				for (let i = 0; i < run; i++) {
					out.set(p, d);
					d += bpp;
				}
				break;
			}
			case REGULAR_COLOR_IMAGE:
			case MEGA_MEGA_COLOR_IMAGE: {
				const len = run * bpp;
				if (s + len > src.length) throw new Error("RLE: 入力が足りない");
				need(run);
				out.set(src.subarray(s, s + len), d);
				s += len;
				d += len;
				break;
			}
			case LITE_SET_FG_FGBG_IMAGE:
			case MEGA_MEGA_SET_FGBG_IMAGE:
			case REGULAR_FGBG_IMAGE:
			case MEGA_MEGA_FGBG_IMAGE: {
				need(run);
				let left = run;
				while (left > 0) {
					const mask = byteAt(s++);
					const bits = Math.min(8, left);
					for (let b = 0; b < bits; b++)
						(mask >> b) & 1 ? writeFg() : writeBg();
					left -= bits;
				}
				break;
			}
			case SPECIAL_FGBG_1:
			case SPECIAL_FGBG_2: {
				const mask = code === SPECIAL_FGBG_1 ? 0x03 : 0x05;
				need(8);
				for (let b = 0; b < 8; b++) (mask >> b) & 1 ? writeFg() : writeBg();
				break;
			}
			case WHITE:
				need(1);
				out.fill(0xff, d, d + bpp);
				d += bpp;
				break;
			case BLACK:
				need(1);
				d += bpp;
				break;
			default:
				throw new Error(`RLE: 知らない命令 0x${header.toString(16)}`);
		}
	}
	return out;
}

// ---- RDP 6.0 Planar([MS-RDPEGDI] 2.2.2.5.1。32bpp の圧縮) ----

const PLANAR_CLL = 0x07;
const PLANAR_CS = 0x08;
const PLANAR_RLE = 0x10;
const PLANAR_NA = 0x20;

/** 面を伸ばす作業用(使い回す。出力の RGBA だけは毎回新しく作る) */
let scratch = new Uint8Array(0);

/**
 * RLE で圧縮された 1 つの面(w x h バイト)を plane[off .. off + w * h) に伸ばす。src の at から読み、読み終えた位置を返す。
 * 走査線ごとに、制御バイト(上位 4 ビット = 生バイト数、下位 4 ビット = 繰り返し)の列。
 * 最初の行は値そのもの、2 行目からは上の行との差分(符号付き)。繰り返しは直前の値(差分の行では直前の差分)
 */
function planeRle(
	src: Uint8Array,
	at: number,
	w: number,
	h: number,
	plane: Uint8Array,
	off: number,
): number {
	const n = src.length;
	let s = at;
	for (let y = 0; y < h; y++) {
		const end = off + (y + 1) * w;
		let d = end - w;
		// 直前の値(最初の行)/ 直前の差分(2 行目から)
		let last = 0;
		while (d < end) {
			if (s >= n) throw new Error("Planar: 入力が足りない");
			const c = src[s++] as number;
			let raw = c >> 4;
			let run = c & 0x0f;
			if (run === 1) {
				run = raw + 16;
				raw = 0;
			} else if (run === 2) {
				run = raw + 32;
				raw = 0;
			}
			if (d + raw > end) {
				// 生の値が行からあふれる。前と同じく、あふれる手前まで読めなければ「足りない」
				if (s + (end - d) + 1 > n) throw new Error("Planar: 入力が足りない");
				throw new Error("Planar: 1 行があふれた");
			}
			if (s + raw > n) throw new Error("Planar: 入力が足りない");
			if (y === 0) {
				for (let i = 0; i < raw; i++) {
					last = src[s++] as number;
					plane[d++] = last;
				}
				if (d + run > end) throw new Error("Planar: 1 行があふれた");
				if (run) {
					plane.fill(last, d, d + run);
					d += run;
				}
			} else {
				for (let i = 0; i < raw; i++) {
					const v = src[s++] as number;
					last = v & 1 ? -((v >> 1) + 1) : v >> 1;
					plane[d] = ((plane[d - w] as number) + last) & 0xff;
					d++;
				}
				if (d + run > end) throw new Error("Planar: 1 行があふれた");
				for (let i = 0; i < run; i++) {
					plane[d] = ((plane[d - w] as number) + last) & 0xff;
					d++;
				}
			}
		}
	}
	return s;
}

/** 色差の 8 ビットの値 → 符号付きの色差(色の削減のレベルごと。表にして使い回す) */
const chromaTables: Int16Array[] = [];
function chromaTable(cll: number): Int16Array {
	let t = chromaTables[cll];
	if (!t) {
		t = new Int16Array(256);
		for (let v = 0; v < 256; v++)
			t[v] = (((v << (cll - 1)) & 0xff) << 24) >> 24;
		chromaTables[cll] = t;
	}
	return t;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Planar の 32bpp を RGBA(上の行から)にする。面は [アルファ]、赤、緑、青(CLL が 0 でないときは Y、Co、Cg)の順。
 * 行は下から上へ並ぶ(ほかの旧ビットマップと同じ)。色の間引き(CS)は未対応
 */
export function decodePlanar(
	data: Uint8Array,
	w: number,
	h: number,
	/** GFX の Planar は上の行から並ぶ */
	topDown = false,
): Uint8ClampedArray {
	if (w * h > MAX_PIXELS) throw new Error("ビットマップが大きすぎる");
	if (data.length < 1) throw new Error("Planar: 入力が足りない");
	const header = data[0] as number;
	const cll = header & PLANAR_CLL;
	if (header & PLANAR_CS) throw new Error("Planar: 色の間引き(CS)は未対応");
	const rle = (header & PLANAR_RLE) !== 0;
	const noAlpha = (header & PLANAR_NA) !== 0;
	const count = noAlpha ? 3 : 4;
	const size = w * h;
	// 色の面 3 つ(アルファは読むだけ。旧ビットマップの画面は不透明として描く)の、入力の中か作業用の中での位置
	let src: Uint8Array;
	const offs = [0, 0, 0];
	if (rle) {
		if (scratch.length < size * 4) scratch = new Uint8Array(size * 4);
		let at = 1;
		for (let i = 0; i < count; i++)
			at = planeRle(data, at, w, h, scratch, i * size);
		src = scratch;
		const first = noAlpha ? 0 : 1;
		for (let i = 0; i < 3; i++) offs[i] = (first + i) * size;
	} else {
		if (1 + count * size > data.length)
			throw new Error("Planar: 入力が足りない");
		src = data;
		const first = 1 + (noAlpha ? 0 : size);
		for (let i = 0; i < 3; i++) offs[i] = first + i * size;
	}
	const o0 = offs[0] as number;
	const o1 = offs[1] as number;
	const o2 = offs[2] as number;
	const out = new Uint8ClampedArray(size * 4);
	const out32 = LITTLE_ENDIAN ? new Uint32Array(out.buffer) : undefined;
	// YCoCg: Co と Cg は、8 ビットのまま (cll - 1) ビット左へずらしてから、符号付き 8 ビットとして読む(ずらしたあふれは捨てる)。
	// FreeRDP の YCoCgToRGB と同じ順。符号付きにしてからずらすと、濃い色で符号が逆になり、赤と青が入れ替わって見えた
	const chroma = cll ? chromaTable(cll) : undefined;
	for (let y = 0; y < h; y++) {
		const row = (topDown ? y : h - 1 - y) * w;
		let d = y * w;
		for (let x = 0; x < w; x++, d++) {
			const a = src[o0 + row + x] as number;
			const b = src[o1 + row + x] as number;
			const c = src[o2 + row + x] as number;
			let r: number;
			let g: number;
			let bl: number;
			if (cll === 0) {
				r = a;
				g = b;
				bl = c;
			} else {
				const co = (chroma as Int16Array)[b] as number;
				const cg = (chroma as Int16Array)[c] as number;
				const t = a - cg;
				r = t + co;
				g = a + cg;
				bl = t - co;
				r = r < 0 ? 0 : r > 255 ? 255 : r;
				g = g < 0 ? 0 : g > 255 ? 255 : g;
				bl = bl < 0 ? 0 : bl > 255 ? 255 : bl;
			}
			if (out32) out32[d] = (0xff000000 | (bl << 16) | (g << 8) | r) >>> 0;
			else {
				const p = d * 4;
				out[p] = r;
				out[p + 1] = g;
				out[p + 2] = bl;
				out[p + 3] = 255;
			}
		}
	}
	return out;
}
