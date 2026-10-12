// RemoteFX([MS-RDPRFX])。ストリーム(Sync / Codec Versions / Channels / Context / Frame Begin / Region / Tileset / Frame End)を読み、
// 64x64 のタイルを復号して RGBA にする。タイルの復号は RLGR → サブバンドの並べ → LL3 の差分 → 逆量子化 → 逆 DWT(3 段)→ YCbCr → RGB。

import { Reader } from "./bytes";

export const TILE = 64;
const TILE_PIXELS = TILE * TILE;

/** WBT_SYNC(0xccc0)〜 WBT_EXTENSION(0xccc7)。復号に要るのは Region と Tileset(Extension)だけで、ほかは読み飛ばす */
const WBT_FIRST = 0xccc0;
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

/** 復号前のタイル: 位置(画素。xIdx * 64, yIdx * 64)と、圧縮されたままの 3 成分 */
export type RawTile = {
	x: number;
	y: number;
	mode: number;
	data: [Uint8Array, Uint8Array, Uint8Array];
	quant: [number[], number[], number[]];
	/** このタイルを描いてよい領域(Region の矩形)。空なら全体 */
	rects: Rect[];
};

export type RfxTile = Pick<RawTile, "x" | "y" | "rects"> & {
	/** 64 x 64、上の行から */
	rgba: Uint8ClampedArray;
};

// ---- RLGR ----

/** kp / krp の上限(k / kr は最大 10)。FreeRDP も 80 */
const KPMAX = 80;
const LSGR = 3;
const UP_GR = 4;
const DN_GR = 6;
const UQ_GR = 3;
const DQ_GR = 3;

/** ビット列の読み手。32 ビットの窓を一度に取って、1 ビットずつ読まずに済ませる */
class Bits {
	pos = 0;
	/** 入力を読み尽くしたあとに読もうとした */
	over = false;
	private total: number;
	constructor(private data: Uint8Array) {
		this.total = data.length * 8;
	}

	/** pos から 32 ビット(入力を超えたぶんは 0) */
	private window(): number {
		const d = this.data;
		const i = this.pos >> 3;
		const s = this.pos & 7;
		const n = d.length;
		// 入力の中ほどなら、境界検査なしで読む
		if (i + 4 < n) {
			const w =
				((d[i] as number) << 24) |
				((d[i + 1] as number) << 16) |
				((d[i + 2] as number) << 8) |
				(d[i + 3] as number);
			return s ? (w << s) | ((d[i + 4] as number) >> (8 - s)) : w;
		}
		const b0 = i < n ? (d[i] as number) : 0;
		const b1 = i + 1 < n ? (d[i + 1] as number) : 0;
		const b2 = i + 2 < n ? (d[i + 2] as number) : 0;
		const b3 = i + 3 < n ? (d[i + 3] as number) : 0;
		let w = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
		if (s) w = (w << s) | ((i + 4 < n ? (d[i + 4] as number) : 0) >> (8 - s));
		return w;
	}

	/** 1 の並びを数えて、終わりの 0 を読み飛ばす。入力が尽きたら over を立てて、尽きるまでの 1 の数を返す */
	unary(): number {
		let ones = 0;
		for (;;) {
			const w = this.window();
			const run = Math.clz32(~w);
			if (run < 32) {
				// 窓の中に 0 がある。ただし窓の末尾のゼロ詰めを 0 と数えない
				const avail = this.total - this.pos;
				if (run >= avail) {
					this.pos = this.total;
					this.over = true;
					return ones + avail;
				}
				this.pos += run + 1;
				return ones + run;
			}
			// 窓が全部 1(入力の中の 32 ビット)。続きを数える
			ones += 32;
			this.pos += 32;
		}
	}

	/** n ビット(0 〜 31)を数として読む。入力を超えたぶんは 0 */
	bits(n: number): number {
		if (n === 0) return 0;
		if (n > 16) return this.bits(n - 16) * 65536 + this.bits(16);
		const avail = this.total - this.pos;
		const v = this.window() >>> (32 - n);
		if (n > avail) {
			this.over = true;
			this.pos = this.total;
		} else this.pos += n;
		return v;
	}

	bit(): number {
		if (this.pos >= this.total) {
			this.over = true;
			return 0;
		}
		const b =
			((this.data[this.pos >> 3] as number) >> (7 - (this.pos & 7))) & 1;
		this.pos++;
		return b;
	}

	get left(): number {
		return this.total - this.pos;
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
	const rlgr1 = mode === ENTROPY_RLGR1;

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
			// Golomb-Rice の 1 つの符号(kr / krp を更新する)
			const vk = bits.unary();
			const code = vk * (1 << kr) + (kr ? bits.bits(kr) : 0);
			if (code > 0x7fffffff)
				throw new Error("RemoteFX: RLGR の符号が大きすぎる");
			if (vk === 0) krp = krp > 2 ? krp - 2 : 0;
			else if (vk > 1) krp = Math.min(KPMAX, krp + vk);
			kr = krp >> LSGR;
			const mag = code + 1;
			kp = kp > DN_GR ? kp - DN_GR : 0;
			k = kp >> LSGR;
			out[n++] = negative ? -mag : mag;
		} else {
			// Golomb-Rice モード
			const vk = bits.unary();
			const code = vk * (1 << kr) + (kr ? bits.bits(kr) : 0);
			if (code > 0x7fffffff)
				throw new Error("RemoteFX: RLGR の符号が大きすぎる");
			if (vk === 0) krp = krp > 2 ? krp - 2 : 0;
			else if (vk > 1) krp = Math.min(KPMAX, krp + vk);
			kr = krp >> LSGR;
			if (rlgr1) {
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
	for (let i = 0; i < BANDS.length; i++) {
		const shift = Math.max(0, (quant[i] as number) - 1);
		if (!shift) continue;
		const band = BANDS[i] as [number, number];
		const end = band[0] + band[1];
		for (let j = band[0]; j < end; j++) buf[j] = (buf[j] as number) << shift;
	}
	idwt(buf, 3840, 8);
	idwt(buf, 3072, 16);
	idwt(buf, 0, 32);
}

/** 逆 DWT の作業場所(1 回に 1 つのタイルしか動かないので、使い回す) */
const TMP = new Int32Array(4096);

/**
 * 1 段の逆 DWT。buf[at..] に HL LH HH LL(各 n*n)が並んでいて、2n x 2n の画素で置き換える。
 * 水平・垂直とも、行の中を連続して舐める形にしてある(列ごとに飛ばない)
 */
function idwt(buf: Int32Array, at: number, n: number): void {
	const tmp = TMP;
	const nn = n * n;
	const hl = at;
	const lh = at + nn;
	const hh = at + nn * 2;
	const ll = at + nn * 3;
	const w = n * 2;
	const hi = nn * 2;
	// 水平: 低域(LL, HL)→ tmp[0..]、高域(LH, HH)→ tmp[hi..]。各行は 2n 画素
	for (let y = 0; y < n; y++) {
		horiz(buf, ll + y * n, hl + y * n, tmp, y * w, n);
		horiz(buf, lh + y * n, hh + y * n, tmp, hi + y * w, n);
	}
	// 垂直: 行ごとに、偶数行 E[y] = lo[y] - ((hi[y-1] + hi[y] + 1) >> 1)、奇数行 = (hi[y] << 1) + ((E[y] + E[y+1]) >> 1)
	for (let y = 0; y < n; y++) {
		const lo = y * w;
		const h1 = hi + y * w;
		const h0 = y > 0 ? h1 - w : h1;
		const even = at + 2 * y * w;
		for (let x = 0; x < w; x++)
			buf[even + x] =
				(tmp[lo + x] as number) -
				(((tmp[h0 + x] as number) + (tmp[h1 + x] as number) + 1) >> 1);
		if (y > 0) {
			// 1 つ前の奇数行(E[y-1] と E[y] の間)
			const odd = even - w;
			const prev = odd - w;
			const hp = h0;
			for (let x = 0; x < w; x++)
				buf[odd + x] =
					((tmp[hp + x] as number) << 1) +
					(((buf[prev + x] as number) + (buf[even + x] as number)) >> 1);
		}
	}
	// 最後の奇数行は、次の偶数行が無いので自分自身
	const last = at + (2 * n - 1) * w;
	const lastEven = last - w;
	const hLast = hi + (n - 1) * w;
	for (let x = 0; x < w; x++)
		buf[last + x] =
			((tmp[hLast + x] as number) << 1) + (buf[lastEven + x] as number);
}

/** 水平方向の 1 行: 低域 l[0..n) と高域 h[0..n) から、dst[d..d+2n)。偶数 = l - ((h[x-1] + h[x] + 1) >> 1)、奇数 = (h << 1) + ((偶数 + 次の偶数) >> 1) */
function horiz(
	src: Int32Array,
	l: number,
	h: number,
	dst: Int32Array,
	d: number,
	n: number,
): void {
	let hPrev = src[h] as number;
	let ePrev = 0;
	for (let x = 0; x < n; x++) {
		const hCur = src[h + x] as number;
		const e = (src[l + x] as number) - ((hPrev + hCur + 1) >> 1);
		dst[d + 2 * x] = e;
		if (x > 0) dst[d + 2 * x - 1] = (hPrev << 1) + ((ePrev + e) >> 1);
		hPrev = hCur;
		ePrev = e;
	}
	// 最後の奇数は、次の偶数が無いので自分自身
	dst[d + 2 * n - 1] = (hPrev << 1) + ePrev;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Y・Cb・Cr(5 ビットの小数つき、Y は -128 のオフセット)→ RGBA。16.16 の固定小数 + 5 ビット = 21 ビットの右シフト */
export function yccToRgba(
	y: Int32Array,
	cb: Int32Array,
	cr: Int32Array,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(TILE_PIXELS * 4);
	// 1 画素を 32 ビット 1 回で書く(リトル エンディアンなら R が下位)
	const out32 = LITTLE_ENDIAN ? new Uint32Array(out.buffer) : undefined;
	for (let i = 0; i < TILE_PIXELS; i++) {
		const yy = ((y[i] as number) + 4096) << 16;
		const b = cb[i] as number;
		const r = cr[i] as number;
		let rr = (yy + 91916 * r) >> 21;
		let gg = (yy - 22527 * b - 46819 * r) >> 21;
		let bb = (yy + 115992 * b) >> 21;
		rr = rr < 0 ? 0 : rr > 255 ? 255 : rr;
		gg = gg < 0 ? 0 : gg > 255 ? 255 : gg;
		bb = bb < 0 ? 0 : bb > 255 ? 255 : bb;
		if (out32) out32[i] = 0xff000000 | (bb << 16) | (gg << 8) | rr;
		else {
			const o = i * 4;
			out[o] = rr;
			out[o + 1] = gg;
			out[o + 2] = bb;
			out[o + 3] = 255;
		}
	}
	return out;
}

/** 1 つのタイルの作業用の係数(使い回す。rlgrDecode が先頭で 0 に埋め直す) */
const PLANES = [
	new Int32Array(4096),
	new Int32Array(4096),
	new Int32Array(4096),
] as [Int32Array, Int32Array, Int32Array];

/** 1 つのタイル: 3 成分のデータ(Y / Cb / Cr)と量子化の値 → RGBA */
export function decodeTile(
	mode: number,
	data: [Uint8Array, Uint8Array, Uint8Array],
	quant: [number[], number[], number[]],
): Uint8ClampedArray {
	for (let i = 0; i < 3; i++) {
		const buf = PLANES[i] as Int32Array;
		rlgrDecode(data[i] as Uint8Array, mode, buf);
		reconstruct(buf, quant[i] as number[]);
	}
	return yccToRgba(PLANES[0], PLANES[1], PLANES[2]);
}

// ---- ストリーム ----

/** RemoteFX のデータ(1 つの Surface コマンドの bitmapData)から、描くべきタイルを取り出して復号する */
export function decodeStream(data: Uint8Array): RfxTile[] {
	return parseTiles(data).map((t) => ({
		x: t.x,
		y: t.y,
		rects: t.rects,
		rgba: decodeTile(t.mode, t.data, t.quant),
	}));
}

/** RemoteFX のストリームから、タイルの位置と圧縮データを取り出す(復号はしない。復号は Worker でも、その場でもよい) */
export function parseTiles(data: Uint8Array): RawTile[] {
	const r = new Reader(data);
	const tiles: RawTile[] = [];
	let rects: Rect[] = [];
	while (r.left >= 6) {
		const type = r.u16();
		const len = r.u32();
		if (len < 6 || len - 6 > r.left)
			throw new Error(`RemoteFX: ブロックの長さが不正 (${len})`);
		const body = r.sub(len - 6);
		if (type === WBT_REGION) rects = parseRegion(body);
		else if (type === WBT_EXTENSION) parseTileset(body, rects, tiles);
		else if (type < WBT_FIRST || type > WBT_EXTENSION)
			throw new Error(`RemoteFX: 知らないブロック 0x${type.toString(16)}`);
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

function parseTileset(r: Reader, rects: Rect[], out: RawTile[]): void {
	r.skip(2); // codecId, channelId
	if (r.u16() !== CBT_TILESET)
		throw new Error("RemoteFX: Tileset の種類が違う");
	r.u16(); // idx
	const mode = (r.u16() >> 10) & 0xf; // properties の et(エントロピーの方式)
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
		const q = [t.u8(), t.u8(), t.u8()].map((i) => quants[i]);
		const xIdx = t.u16();
		const yIdx = t.u16();
		const yLen = t.u16();
		const cbLen = t.u16();
		const crLen = t.u16();
		if (q.some((v) => !v)) throw new Error("RemoteFX: 量子化の番号が範囲外");
		out.push({
			x: xIdx * TILE,
			y: yIdx * TILE,
			mode,
			data: [t.bytes(yLen), t.bytes(cbLen), t.bytes(crLen)],
			quant: q as [number[], number[], number[]],
			rects,
		});
	}
}
