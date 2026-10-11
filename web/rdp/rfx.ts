// RemoteFX([MS-RDPRFX])。ストリーム(Sync / Codec Versions / Channels / Context / Frame Begin / Region / Tileset / Frame End)を読み、
// 64x64 のタイルを復号して RGBA にする。タイルの復号は RLGR → サブバンドの並べ → LL3 の差分 → 逆量子化 → 逆 DWT(3 段)→ YCbCr → RGB。

import { Reader } from "./bytes";

export const TILE = 64;
const TILE_PIXELS = TILE * TILE;

const WBT_SYNC = 0xccc0;
const WBT_CODEC_VERSIONS = 0xccc1;
const WBT_CHANNELS = 0xccc2;
const WBT_CONTEXT = 0xccc3;
const WBT_FRAME_BEGIN = 0xccc4;
const WBT_FRAME_END = 0xccc5;
const WBT_REGION = 0xccc6;
const WBT_EXTENSION = 0xccc7;
const CBT_REGION = 0xcac1;
const CBT_TILESET = 0xcac2;
const CBT_TILE = 0xcac3;

export const ENTROPY_RLGR1 = 0x01;
export const ENTROPY_RLGR3 = 0x04;

/** 1 つのメッセージのタイル数の上限(8K でも 2000 余り)。空のタイルでも 64x64x4 バイトずつ確保するので、最悪でも 64MB に収める */
const MAX_TILES = 1 << 12;
const MAX_RECTS = 1 << 12;
const MAX_QUANT = 16;

export type Rect = { x: number; y: number; w: number; h: number };

export type RfxTile = {
	/** タイルの位置(画素。xIdx * 64, yIdx * 64) */
	x: number;
	y: number;
	/** 64 x 64、上の行から */
	rgba: Uint8ClampedArray;
	/** このタイルを描いてよい領域(Region の矩形)。空なら全体 */
	rects: Rect[];
};

// ---- RLGR ----

/** kp / krp の上限(k / kr は最大 10)。FreeRDP も 80 */
const KPMAX = 80;
const LSGR = 3;
const UP_GR = 4;
const DN_GR = 6;
const UQ_GR = 3;
const DQ_GR = 3;

class Bits {
	private pos = 0;
	/** 入力を読み尽くしたあとに読もうとした */
	over = false;
	constructor(private data: Uint8Array) {}

	bit(): number {
		const i = this.pos >> 3;
		if (i >= this.data.length) {
			this.over = true;
			return 0;
		}
		const b = ((this.data[i] as number) >> (7 - (this.pos & 7))) & 1;
		this.pos++;
		return b;
	}

	bits(n: number): number {
		let v = 0;
		for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
		return v >>> 0;
	}

	get left(): number {
		return this.data.length * 8 - this.pos;
	}

	/** 読んだビット数 */
	get used(): number {
		return this.pos;
	}
}

/** 符号なしの 2 つ折り(0, 1, 2, 3, 4 → 0, -1, 1, -2, 2) */
const unfold = (n: number) => (n & 1 ? -((n + 1) >> 1) : n >> 1);

/** RLGR1 / RLGR3 の復号。out を先頭から埋め、読み切れなかった残りは 0。使ったビット数を返す */
export function rlgrDecode(
	data: Uint8Array,
	mode: number,
	out: Int32Array,
): number {
	if (mode !== ENTROPY_RLGR1 && mode !== ENTROPY_RLGR3)
		throw new Error(`RemoteFX: 知らないエントロピー方式 ${mode}`);
	const total = out.length;
	out.fill(0);
	const bits = new Bits(data);
	let k = 1;
	let kp = k << LSGR;
	let kr = 1;
	let krp = kr << LSGR;
	let n = 0;

	/** Golomb-Rice の 1 つの符号。kr / krp を更新する */
	const grCode = (): number => {
		let vk = 0;
		while (bits.bit() === 1) {
			vk++;
		}
		// 大きな係数(DC など)では、vk は 40 を超えることがある。入力の長さが上限になる
		const code = vk * (1 << kr) + (kr ? bits.bits(kr) : 0);
		if (code > 0x7fffffff) throw new Error("RemoteFX: RLGR の符号が大きすぎる");
		if (vk === 0) krp = Math.max(0, krp - 2);
		else if (vk > 1) krp = Math.min(KPMAX, krp + vk);
		kr = krp >> LSGR;
		return code;
	};

	while (n < total && bits.left > 0) {
		if (k) {
			// ランレングス モード: 0 の並びを、「0 の接頭辞 + k ビット」で表す
			let run = 0;
			for (;;) {
				if (bits.over) return bits.used;
				if (bits.bit()) break;
				run += 1 << k;
				kp = Math.min(kp + UP_GR, KPMAX);
				k = kp >> LSGR;
			}
			run += bits.bits(k);
			n += Math.min(run, total - n); // 0 は out が 0 で埋まっている
			if (n >= total) return bits.used;
			const negative = bits.bit() === 1;
			const mag = grCode() + 1;
			kp = Math.max(0, kp - DN_GR);
			k = kp >> LSGR;
			out[n++] = negative ? -mag : mag;
		} else {
			// Golomb-Rice モード
			const code = grCode();
			if (mode === ENTROPY_RLGR1) {
				if (code === 0) kp = Math.min(kp + UQ_GR, KPMAX);
				else kp = Math.max(0, kp - DQ_GR);
				k = kp >> LSGR;
				out[n++] = unfold(code);
			} else {
				// RLGR3: 1 つの符号に 2 つの値(ビット数 + 下位のビット)
				const idx = code === 0 ? 0 : 32 - Math.clz32(code);
				const v1 = bits.bits(idx);
				const v2 = code - v1;
				if (v1 && v2) kp = Math.max(0, kp - 2 * DQ_GR);
				else if (!v1 && !v2) kp = Math.min(kp + 2 * UQ_GR, KPMAX);
				k = kp >> LSGR;
				out[n++] = unfold(v1);
				if (n < total) out[n++] = unfold(v2);
			}
		}
	}
	return bits.used;
}

// ---- 逆量子化・逆 DWT・色変換 ----

/** 係数の並び(1 成分 4096): HL1 LH1 HH1 | HL2 LH2 HH2 | HL3 LH3 HH3 | LL3 */
const BANDS: [offset: number, size: number][] = [
	[0, 1024], // HL1
	[1024, 1024], // LH1
	[2048, 1024], // HH1
	[3072, 256], // HL2
	[3328, 256], // LH2
	[3584, 256], // HH2
	[3840, 64], // HL3
	[3904, 64], // LH3
	[3968, 64], // HH3
	[4032, 64], // LL3
];

/** Quant の 5 バイト(4 ビットずつ、LL3 LH3 / HL3 HH3 / LH2 HL2 / HH2 LH1 / HL1 HH1)→ BANDS の順の値 */
export function parseQuant(b: Uint8Array): number[] {
	const n = (i: number) =>
		i & 1 ? (b[i >> 1] as number) >> 4 : (b[i >> 1] as number) & 15;
	const ll3 = n(0);
	const lh3 = n(1);
	const hl3 = n(2);
	const hh3 = n(3);
	const lh2 = n(4);
	const hl2 = n(5);
	const hh2 = n(6);
	const lh1 = n(7);
	const hl1 = n(8);
	const hh1 = n(9);
	return [hl1, lh1, hh1, hl2, lh2, hh2, hl3, lh3, hh3, ll3];
}

/** 1 成分の 4096 係数を、逆量子化・逆 DWT して、4096 の画素値(5 ビットの小数つき)にする(in place) */
export function reconstruct(buf: Int32Array, quant: number[]): void {
	// LL3 は隣との差分で入っている
	for (let i = 4033; i < 4096; i++)
		buf[i] = (buf[i] as number) + (buf[i - 1] as number);
	for (const [i, [offset, size]] of BANDS.entries()) {
		const shift = Math.max(0, (quant[i] as number) - 1);
		if (shift)
			for (let j = offset; j < offset + size; j++)
				buf[j] = (buf[j] as number) << shift;
	}
	const tmp = new Int32Array(4096);
	idwt(buf, 3840, tmp, 8);
	idwt(buf, 3072, tmp, 16);
	idwt(buf, 0, tmp, 32);
}

/** 1 段の逆 DWT。buf[at..] に HL LH HH LL(各 n*n)が並んでいて、2n x 2n の画素で置き換える */
function idwt(buf: Int32Array, at: number, tmp: Int32Array, n: number): void {
	const nn = n * n;
	const hl = at;
	const lh = at + nn;
	const hh = at + nn * 2;
	const ll = at + nn * 3;
	const w = n * 2;
	// 水平: 低域(LL, HL)→ tmp[0..], 高域(LH, HH)→ tmp[n * 2n..]
	for (let y = 0; y < n; y++) {
		horiz(buf, ll + y * n, hl + y * n, tmp, y * w, n);
		horiz(buf, lh + y * n, hh + y * n, tmp, nn * 2 + y * w, n);
	}
	// 垂直: 列ごとに、低域の行と高域の行から 2n 行を作る
	const lo = 0;
	const hi = nn * 2;
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < n; y++) {
			const h0 = tmp[hi + (y > 0 ? y - 1 : 0) * w + x] as number;
			const h1 = tmp[hi + y * w + x] as number;
			buf[at + 2 * y * w + x] =
				(tmp[lo + y * w + x] as number) - ((h0 + h1 + 1) >> 1);
		}
		for (let y = 0; y < n; y++) {
			const even = buf[at + 2 * y * w + x] as number;
			const next = y < n - 1 ? (buf[at + (2 * y + 2) * w + x] as number) : even;
			buf[at + (2 * y + 1) * w + x] =
				((tmp[hi + y * w + x] as number) << 1) + ((even + next) >> 1);
		}
	}
}

/** 水平方向の 1 行: 低域 l[0..n) と高域 h[0..n) から、dst[0..2n) */
function horiz(
	src: Int32Array,
	l: number,
	h: number,
	dst: Int32Array,
	d: number,
	n: number,
): void {
	for (let x = 0; x < n; x++) {
		const hPrev = src[h + (x > 0 ? x - 1 : 0)] as number;
		const hCur = src[h + x] as number;
		dst[d + 2 * x] = (src[l + x] as number) - ((hPrev + hCur + 1) >> 1);
	}
	for (let x = 0; x < n; x++) {
		const even = dst[d + 2 * x] as number;
		const next = x < n - 1 ? (dst[d + 2 * x + 2] as number) : even;
		dst[d + 2 * x + 1] = ((src[h + x] as number) << 1) + ((even + next) >> 1);
	}
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Y・Cb・Cr(5 ビットの小数つき、Y は -128 のオフセット)→ RGBA。16.16 の固定小数 + 5 ビット = 21 ビットの右シフト */
export function yccToRgba(
	y: Int32Array,
	cb: Int32Array,
	cr: Int32Array,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(TILE_PIXELS * 4);
	for (let i = 0; i < TILE_PIXELS; i++) {
		const yy = ((y[i] as number) + 4096) << 16;
		const b = cb[i] as number;
		const r = cr[i] as number;
		out[i * 4] = clamp8((yy + 91916 * r) >> 21);
		out[i * 4 + 1] = clamp8((yy - 22527 * b - 46819 * r) >> 21);
		out[i * 4 + 2] = clamp8((yy + 115992 * b) >> 21);
		out[i * 4 + 3] = 255;
	}
	return out;
}

/** 1 つのタイル: 3 成分のデータ(Y / Cb / Cr)と量子化の値 → RGBA */
export function decodeTile(
	mode: number,
	data: [Uint8Array, Uint8Array, Uint8Array],
	quant: [number[], number[], number[]],
): Uint8ClampedArray {
	const planes = data.map((d, i) => {
		const buf = new Int32Array(4096);
		rlgrDecode(d, mode, buf);
		reconstruct(buf, quant[i] as number[]);
		return buf;
	}) as [Int32Array, Int32Array, Int32Array];
	return yccToRgba(planes[0], planes[1], planes[2]);
}

// ---- ストリーム ----

/** RemoteFX のデータ(1 つの Surface コマンドの bitmapData)から、描くべきタイルを取り出す */
export function decodeStream(data: Uint8Array): RfxTile[] {
	const r = new Reader(data);
	const tiles: RfxTile[] = [];
	let rects: Rect[] = [];
	while (r.left >= 6) {
		const type = r.u16();
		const len = r.u32();
		if (len < 6 || len - 6 > r.left)
			throw new Error(`RemoteFX: ブロックの長さが不正 (${len})`);
		const body = r.sub(len - 6);
		switch (type) {
			case WBT_SYNC:
			case WBT_CODEC_VERSIONS:
			case WBT_CHANNELS:
			case WBT_CONTEXT:
			case WBT_FRAME_BEGIN:
			case WBT_FRAME_END:
				break; // 復号に要る情報は、Tileset が持っている
			case WBT_REGION:
				rects = parseRegion(body);
				break;
			case WBT_EXTENSION:
				parseTileset(body, rects, tiles);
				break;
			default:
				throw new Error(`RemoteFX: 知らないブロック 0x${type.toString(16)}`);
		}
	}
	return tiles;
}

function parseRegion(r: Reader): Rect[] {
	r.skip(2); // codecId, channelId
	r.u8(); // regionFlags
	const n = r.u16();
	if (n > MAX_RECTS) throw new Error("RemoteFX: 矩形が多すぎる");
	const rects: Rect[] = [];
	for (let i = 0; i < n; i++)
		rects.push({ x: r.u16(), y: r.u16(), w: r.u16(), h: r.u16() });
	if (r.u16() !== CBT_REGION) throw new Error("RemoteFX: Region の種類が違う");
	return rects;
}

function parseTileset(r: Reader, rects: Rect[], out: RfxTile[]): void {
	r.skip(2); // codecId, channelId
	if (r.u16() !== CBT_TILESET)
		throw new Error("RemoteFX: Tileset の種類が違う");
	r.u16(); // idx
	const props = r.u16();
	const mode = (props >> 10) & 0xf;
	const numQuant = r.u8();
	const tileSize = r.u8();
	const numTiles = r.u16();
	r.u32(); // tilesDataSize
	if (tileSize !== TILE)
		throw new Error(`RemoteFX: タイルの大きさ ${tileSize}`);
	if (numQuant > MAX_QUANT || numTiles > MAX_TILES)
		throw new Error("RemoteFX: Tileset が大きすぎる");
	const quants: number[][] = [];
	for (let i = 0; i < numQuant; i++) quants.push(parseQuant(r.bytes(5)));
	for (let i = 0; i < numTiles; i++) {
		const type = r.u16();
		const len = r.u32();
		if (type !== CBT_TILE) throw new Error("RemoteFX: タイルの種類が違う");
		if (len < 19 || len - 6 > r.left)
			throw new Error(`RemoteFX: タイルの長さが不正 (${len})`);
		const t = r.sub(len - 6);
		const qy = t.u8();
		const qcb = t.u8();
		const qcr = t.u8();
		const xIdx = t.u16();
		const yIdx = t.u16();
		const yLen = t.u16();
		const cbLen = t.u16();
		const crLen = t.u16();
		const q = [qy, qcb, qcr].map((i) => quants[i]);
		if (q.some((v) => !v)) throw new Error("RemoteFX: 量子化の番号が範囲外");
		const rgba = decodeTile(
			mode,
			[t.bytes(yLen), t.bytes(cbLen), t.bytes(crLen)],
			q as [number[], number[], number[]],
		);
		out.push({ x: xIdx * TILE, y: yIdx * TILE, rgba, rects });
	}
}
