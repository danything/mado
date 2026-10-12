// マウス ポインタ([MS-RDPBCGR] 2.2.9.1.1.4)。形を RGBA にして、画面側が CSS の cursor にする。

import { Reader } from "./bytes";

export type Cursor = {
	width: number;
	height: number;
	hotX: number;
	hotY: number;
	/** 上の行から */
	rgba: Uint8ClampedArray;
};

const MAX_SIDE = 384;

/** 新しいポインタ(Fast-Path の 0xB、Slow-Path の POINTER)。large なら大きさの欄が 32 ビット */
export function parseNewPointer(
	b: Uint8Array,
	large = false,
): { index: number; cursor: Cursor } {
	const r = new Reader(b);
	const xorBpp = r.u16();
	return parseColorBody(r, xorBpp, large);
}

/** 24 ビットのポインタ(Fast-Path の COLOR、Slow-Path の COLOR) */
export function parseColorPointer(b: Uint8Array): {
	index: number;
	cursor: Cursor;
} {
	return parseColorBody(new Reader(b), 24, false);
}

export function parseCachedPointer(b: Uint8Array): number {
	return new Reader(b).u16();
}

function parseColorBody(
	r: Reader,
	xorBpp: number,
	large: boolean,
): { index: number; cursor: Cursor } {
	const index = r.u16();
	const hotX = r.u16();
	const hotY = r.u16();
	const width = r.u16();
	const height = r.u16();
	const andLen = large ? r.u32() : r.u16();
	const xorLen = large ? r.u32() : r.u16();
	if (width > MAX_SIDE || height > MAX_SIDE)
		throw new Error(`ポインタが大きすぎる (${width}x${height})`);
	const xor = r.bytes(xorLen);
	const and = r.bytes(andLen);
	return {
		index,
		cursor: {
			width,
			height,
			hotX,
			hotY,
			rgba: decode(width, height, xorBpp, xor, and),
		},
	};
}

/**
 * XOR マスク(色)と AND マスク(1 ビット、1 が透明)を RGBA にする。どちらも下の行から、行は 2 バイトの境界。
 * 32 ビットは XOR マスクのアルファを使う。AND が 1 で XOR が 0 でない画素は「画面を反転」だが、近似で色をそのまま出す
 */
function decode(
	w: number,
	h: number,
	bpp: number,
	xor: Uint8Array,
	and: Uint8Array,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(w * h * 4);
	const bytes = bpp / 8;
	const xorRow = bpp === 1 ? ((w + 15) >> 4) << 1 : ((w * bytes + 1) >> 1) << 1;
	const andRow = ((w + 15) >> 4) << 1;
	if (xor.length < xorRow * h) throw new Error("ポインタの色が短い");
	for (let y = 0; y < h; y++) {
		const sy = h - 1 - y;
		for (let x = 0; x < w; x++) {
			const d = (y * w + x) * 4;
			const transparent =
				and.length >= andRow * h
					? (((and[sy * andRow + (x >> 3)] as number) >> (7 - (x & 7))) & 1) ===
						1
					: false;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 255;
			const s = sy * xorRow;
			switch (bpp) {
				case 1: {
					const v = ((xor[s + (x >> 3)] as number) >> (7 - (x & 7))) & 1;
					r = g = b = v ? 255 : 0;
					break;
				}
				case 16: {
					const p =
						(xor[s + x * 2] as number) | ((xor[s + x * 2 + 1] as number) << 8);
					r = ((p >> 11) & 31) << 3;
					g = ((p >> 5) & 63) << 2;
					b = (p & 31) << 3;
					break;
				}
				case 24:
					b = xor[s + x * 3] as number;
					g = xor[s + x * 3 + 1] as number;
					r = xor[s + x * 3 + 2] as number;
					break;
				case 32:
					b = xor[s + x * 4] as number;
					g = xor[s + x * 4 + 1] as number;
					r = xor[s + x * 4 + 2] as number;
					a = xor[s + x * 4 + 3] as number;
					break;
				default:
					throw new Error(`ポインタの色の深さ ${bpp} は使えない`);
			}
			// 32 ビットはアルファが透明を決める。それ以外は AND マスク
			if (bpp !== 32 && transparent && r === 0 && g === 0 && b === 0) a = 0;
			else if (bpp !== 32 && transparent) a = 255;
			out[d] = r;
			out[d + 1] = g;
			out[d + 2] = b;
			out[d + 3] = a;
		}
	}
	return out;
}
