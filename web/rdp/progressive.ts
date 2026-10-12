// RemoteFX Progressive([MS-RDPEGFX] 2.2.4.2。GFX の WireToSurface2 で来る CAPROGRESSIVE)。
// 64x64 のタイルを、まず粗く(TILE_FIRST / TILE_SIMPLE)送り、あとから細かく(TILE_UPGRADE)していく。
// タイルごとに、逆量子化した係数(current)・符号(sign)・どのビットまで来たか(bitPos)を面ごとに覚えておき、
// upgrade では足りない下のビット(SRL と RAW の 2 つのビット列)を係数に足して、復号し直す。
// RLGR と色変換は RemoteFX(rfx.ts)と同じ。逆 DWT は、帯を 33 / 31 などに分ける「外挿」の形(RFX_DWT_REDUCE_EXTRAPOLATE)がある。
// 細かいところ(C の整数の割り算、INT16 のあふれ)は FreeRDP の progressive.c に合わせる。

import { Reader } from "./bytes";
import { ENTROPY_RLGR1, inverseDwt, rlgrDecode, TILE, yccToRgba } from "./rfx";

const WBT_SYNC = 0xccc0;
const WBT_FRAME_BEGIN = 0xccc1;
const WBT_FRAME_END = 0xccc2;
const WBT_CONTEXT = 0xccc3;
const WBT_REGION = 0xccc4;
const WBT_TILE_SIMPLE = 0xccc5;
const WBT_TILE_FIRST = 0xccc6;
const WBT_TILE_UPGRADE = 0xccc7;

const SYNC_MAGIC = 0xcaccacca;
const RFX_DWT_REDUCE_EXTRAPOLATE = 0x01;
const RFX_TILE_DIFFERENCE = 0x01;
/** quality がこれなら、progressive の量子化は全部 0(最初から最後の段) */
const FULL_QUALITY = 0xff;

const MAX_RECTS = 1 << 12;
const MAX_TILES = 1 << 12;

/** 10 の帯の値(rfx.ts の BANDS の順: HL1 LH1 HH1 HL2 LH2 HH2 HL3 LH3 HH3 LL3) */
type Quant = number[];
type Yuv<T> = [T, T, T];

export type ProgressiveRect = { x: number; y: number; w: number; h: number };

/** 面に描く部分(タイルを Region の矩形で切ったもの)。位置は面の座標 */
export type ProgressivePart = ProgressiveRect & { rgba: Uint8ClampedArray };

/** 帯の [位置, 大きさ]。通常の形は RemoteFX と同じ */
const NORMAL: [number, number][] = [
	[0, 1024],
	[1024, 1024],
	[2048, 1024],
	[3072, 256],
	[3328, 256],
	[3584, 256],
	[3840, 64],
	[3904, 64],
	[3968, 64],
	[4032, 64],
];
/** 外挿の形: 1 段目は低域 33・高域 31、2 段目は 17・16、3 段目は 9・8 */
const EXTRAPOLATED: [number, number][] = [
	[0, 1023], // HL1 31x33
	[1023, 1023], // LH1 33x31
	[2046, 961], // HH1 31x31
	[3007, 272], // HL2 16x17
	[3279, 272], // LH2 17x16
	[3551, 256], // HH2 16x16
	[3807, 72], // HL3 8x9
	[3879, 72], // LH3 9x8
	[3951, 64], // HH3 8x8
	[4015, 81], // LL3 9x9
];

const ZERO: Quant = new Array(10).fill(0);

/**
 * 量子化の 5 バイト(4 ビットずつ、下位から LL3 HL3 / LH3 HH3 / HL2 LH2 / HH2 HL1 / LH1 HH1)→ BANDS の順。
 * RemoteFX(TS_RFX_CODEC_QUANT)とは HL と LH の並びが違う
 */
export function parseProgressiveQuant(b: Uint8Array): Quant {
	const n = (i: number) =>
		i & 1 ? (b[i >> 1] as number) >> 4 : (b[i >> 1] as number) & 15;
	return [n(7), n(8), n(9), n(4), n(5), n(6), n(1), n(2), n(3), n(0)];
}

/** 1 つのタイルの、upgrade のために覚えておくもの */
type Tile = {
	/** 逆量子化した係数(DWT の前) */
	current: Yuv<Int16Array>;
	/** 最初の段の量子化された値(upgrade で、どちらのビット列から読むかを決める) */
	sign: Yuv<Int16Array>;
	/** 帯ごとに、どのビットまで来たか(量子化 + progressive の量子化) */
	bitPos: Yuv<Quant>;
};

function newTile(): Tile {
	const a = () => new Int16Array(4096);
	return {
		current: [a(), a(), a()],
		sign: [a(), a(), a()],
		bitPos: [ZERO, ZERO, ZERO],
	};
}

type Region = {
	rects: ProgressiveRect[];
	quants: Quant[];
	/** quality の番号 → Y・Cb・Cr の progressive の量子化 */
	progQuants: Yuv<Quant>[];
	extrapolate: boolean;
};

/**
 * 1 枚のタイルの復号の仕事。Worker へ渡せる形(構造化複製できるものだけ)。
 * タイルの状態(upgrade のための係数)は、復号する側(ProgressiveTiles)が surface と key で持つ
 */
export type ProgressiveTileJob = {
	surface: number;
	/** yIdx * 65536 + xIdx */
	key: number;
	/** WBT_TILE_SIMPLE / FIRST / UPGRADE */
	type: number;
	quant: Yuv<Quant>;
	prog: Yuv<Quant>;
	/** TILE_FIRST / SIMPLE のとき、前の係数に足す(RFX_TILE_DIFFERENCE) */
	diff: boolean;
	extrapolate: boolean;
	/** FIRST / SIMPLE は Y・Cb・Cr の 3 つ、UPGRADE は成分ごとに SRL と RAW の 6 つ */
	data: Uint8Array[];
};

/** 読み取ったタイル。復号の仕事と、面のどこに描くか */
export type ProgressiveTile = {
	job: ProgressiveTileJob;
	x: number;
	y: number;
	rects: ProgressiveRect[];
};

/** タイルの状態を持って復号する。Worker ではタイルの位置ごとに受け持つ Worker を決めて、同じタイルは同じ Worker で復号する */
export class ProgressiveTiles {
	/** 面 → (key → タイル) */
	private surfaces = new Map<number, Map<number, Tile>>();

	deleteSurface(id: number): void {
		this.surfaces.delete(id);
	}

	/** 64x64 の RGBA を返す */
	decode(j: ProgressiveTileJob): Uint8ClampedArray {
		let tiles = this.surfaces.get(j.surface);
		if (!tiles) {
			tiles = new Map();
			this.surfaces.set(j.surface, tiles);
		}
		let tile = tiles.get(j.key);
		if (!tile) {
			tile = newTile();
			tiles.set(j.key, tile);
		}
		return j.type === WBT_TILE_UPGRADE
			? upgrade(tile, j.quant, j.prog, j.data, j.extrapolate)
			: first(
					tile,
					j.quant,
					j.prog,
					j.data as Yuv<Uint8Array>,
					j.diff,
					j.extrapolate,
				);
	}
}

/**
 * WireToSurface2 の bitmapData を読み、復号するタイルを並べる(復号はしない)。
 * width / height は面の大きさ。面の外のタイルは描けないので飛ばす(PDU 全体は捨てない)
 */
export function parseProgressive(
	surface: number,
	data: Uint8Array,
	width: number,
	height: number,
): ProgressiveTile[] {
	const out: ProgressiveTile[] = [];
	const r = new Reader(data);
	while (r.left >= 6) {
		const type = r.u16();
		const len = r.u32();
		if (len < 6 || len - 6 > r.left)
			throw new Error(`Progressive: ブロックの長さが不正 (${len})`);
		const body = r.sub(len - 6);
		switch (type) {
			case WBT_SYNC:
				if (body.u32() !== SYNC_MAGIC)
					throw new Error("Progressive: Sync の署名が違う");
				break;
			case WBT_FRAME_BEGIN:
			case WBT_FRAME_END:
			case WBT_CONTEXT:
				break;
			case WBT_REGION:
				region(body, surface, width, height, out);
				break;
			default:
				throw new Error(`Progressive: 知らないブロック 0x${type.toString(16)}`);
		}
	}
	return out;
}

/** 復号したタイルを、Region の矩形と面で切る */
export function clipTile(
	t: ProgressiveTile,
	rgba: Uint8ClampedArray,
	width: number,
	height: number,
): ProgressivePart[] {
	const out: ProgressivePart[] = [];
	clip(rgba, t.x, t.y, t.rects, width, height, out);
	return out;
}

/** Progressive の復号器(その場で復号する。Worker を使わないとき・試験用)。タイルの状態を面ごとに持つ(面を消したら deleteSurface) */
export class ProgressiveDecoder {
	private tiles = new ProgressiveTiles();

	deleteSurface(id: number): void {
		this.tiles.deleteSurface(id);
	}

	/** 1 つの WireToSurface2 の bitmapData を復号し、面に描く部分を返す。width / height は面の大きさ */
	decode(
		surfaceId: number,
		data: Uint8Array,
		width: number,
		height: number,
	): ProgressivePart[] {
		const out: ProgressivePart[] = [];
		for (const t of parseProgressive(surfaceId, data, width, height))
			out.push(...clipTile(t, this.tiles.decode(t.job), width, height));
		return out;
	}
}

function region(
	r: Reader,
	surface: number,
	width: number,
	height: number,
	out: ProgressiveTile[],
): void {
	const tileSize = r.u8();
	const numRects = r.u16();
	const numQuant = r.u8();
	const numProgQuant = r.u8();
	const flags = r.u8();
	const numTiles = r.u16();
	r.u32(); // tileDataSize
	if (tileSize !== TILE)
		throw new Error(`Progressive: タイルの大きさ ${tileSize}`);
	if (numRects > MAX_RECTS || numTiles > MAX_TILES)
		throw new Error("Progressive: Region が大きすぎる");
	const reg: Region = {
		rects: [],
		quants: [],
		progQuants: [],
		extrapolate: (flags & RFX_DWT_REDUCE_EXTRAPOLATE) !== 0,
	};
	for (let i = 0; i < numRects; i++)
		reg.rects.push({ x: r.u16(), y: r.u16(), w: r.u16(), h: r.u16() });
	for (let i = 0; i < numQuant; i++)
		reg.quants.push(parseProgressiveQuant(r.bytes(5)));
	for (let i = 0; i < numProgQuant; i++) {
		r.u8(); // quality
		reg.progQuants.push([
			parseProgressiveQuant(r.bytes(5)),
			parseProgressiveQuant(r.bytes(5)),
			parseProgressiveQuant(r.bytes(5)),
		]);
	}
	for (let i = 0; i < numTiles; i++) {
		const type = r.u16();
		const len = r.u32();
		if (len < 6 || len - 6 > r.left)
			throw new Error(`Progressive: タイルの長さが不正 (${len})`);
		const t = r.sub(len - 6);
		const quant = [t.u8(), t.u8(), t.u8()].map((q) => reg.quants[q]);
		const xIdx = t.u16();
		const yIdx = t.u16();
		if (quant.some((q) => !q))
			throw new Error("Progressive: 量子化の番号が範囲外");
		let job: Omit<
			ProgressiveTileJob,
			"surface" | "key" | "quant" | "extrapolate"
		>;
		switch (type) {
			case WBT_TILE_SIMPLE:
			case WBT_TILE_FIRST: {
				const tileFlags = t.u8();
				const quality = type === WBT_TILE_FIRST ? t.u8() : FULL_QUALITY;
				const lens = [t.u16(), t.u16(), t.u16()];
				t.u16(); // tailLen
				job = {
					type,
					prog: progQuant(reg, quality),
					diff: (tileFlags & RFX_TILE_DIFFERENCE) !== 0,
					data: lens.map((n) => t.bytes(n)),
				};
				break;
			}
			case WBT_TILE_UPGRADE: {
				const quality = t.u8();
				const lens = [t.u16(), t.u16(), t.u16(), t.u16(), t.u16(), t.u16()];
				job = {
					type,
					prog: progQuant(reg, quality),
					diff: false,
					data: lens.map((n) => t.bytes(n)),
				};
				break;
			}
			default:
				throw new Error(`Progressive: 知らないタイル 0x${type.toString(16)}`);
		}
		// 面の外のタイルは描けないので飛ばす(ほかのタイルは描く)
		if (xIdx * TILE >= width || yIdx * TILE >= height) continue;
		out.push({
			job: {
				...job,
				surface,
				key: yIdx * 65536 + xIdx,
				quant: quant as Yuv<Quant>,
				extrapolate: reg.extrapolate,
			},
			x: xIdx * TILE,
			y: yIdx * TILE,
			rects: reg.rects,
		});
	}
}

function progQuant(reg: Region, quality: number): Yuv<Quant> {
	if (quality === FULL_QUALITY) return [ZERO, ZERO, ZERO];
	const q = reg.progQuants[quality];
	if (!q) throw new Error("Progressive: quality の番号が範囲外");
	return q;
}

/** タイルを Region の矩形と面で切る */
function clip(
	rgba: Uint8ClampedArray,
	tx: number,
	ty: number,
	rects: ProgressiveRect[],
	width: number,
	height: number,
	out: ProgressivePart[],
): void {
	for (const rc of rects) {
		const x0 = Math.max(tx, rc.x);
		const y0 = Math.max(ty, rc.y);
		const x1 = Math.min(tx + TILE, rc.x + rc.w, width);
		const y1 = Math.min(ty + TILE, rc.y + rc.h, height);
		if (x1 <= x0 || y1 <= y0) continue;
		const w = x1 - x0;
		const h = y1 - y0;
		const part = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++) {
			const s = ((y0 - ty + y) * TILE + (x0 - tx)) * 4;
			part.set(rgba.subarray(s, s + w * 4), y * w * 4);
		}
		out.push({ x: x0, y: y0, w, h, rgba: part });
	}
}

// ---- タイルの復号 ----

const COEF = new Int32Array(4096);
const WIDE = new Int32Array(4096);
const PIXELS: Yuv<Int16Array> = [
	new Int16Array(4096),
	new Int16Array(4096),
	new Int16Array(4096),
];

/** 帯ごとの「ビットの位置」= 量子化 + progressive の量子化 */
const add = (a: Quant, b: Quant): Quant =>
	a.map((v, i) => v + (b[i] as number));
/** 逆量子化のずらし = ビットの位置 - 1(5 ビットの小数を残す) */
const shiftOf = (bitPos: Quant): Quant => bitPos.map((v) => Math.max(0, v - 1));

/** TILE_FIRST / TILE_SIMPLE: RLGR → 符号を覚える → LL3 の差分 → 逆量子化 →(差分なら前の係数に足す)→ 覚える → 逆 DWT */
function first(
	tile: Tile,
	quant: Yuv<Quant>,
	prog: Yuv<Quant>,
	data: Yuv<Uint8Array>,
	diff: boolean,
	extrapolate: boolean,
): Uint8ClampedArray {
	const bands = extrapolate ? EXTRAPOLATED : NORMAL;
	for (let c = 0; c < 3; c++) {
		const bitPos = add(quant[c] as Quant, prog[c] as Quant);
		tile.bitPos[c] = bitPos;
		const shift = shiftOf(bitPos);
		const buf = PIXELS[c] as Int16Array;
		const current = tile.current[c] as Int16Array;
		rlgrDecode(data[c] as Uint8Array, ENTROPY_RLGR1, COEF);
		buf.set(COEF);
		(tile.sign[c] as Int16Array).set(buf);
		const [llAt, llLen] = bands[9] as [number, number];
		for (let i = llAt + 1; i < llAt + llLen; i++)
			buf[i] = (buf[i] as number) + (buf[i - 1] as number);
		for (let b = 0; b < 10; b++) {
			const s = shift[b] as number;
			if (!s) continue;
			const [at, len] = bands[b] as [number, number];
			for (let i = at; i < at + len; i++) buf[i] = (buf[i] as number) << s;
		}
		if (diff)
			for (let i = 0; i < 4096; i++)
				buf[i] = (buf[i] as number) + (current[i] as number);
		current.set(buf);
		dwt(buf, extrapolate);
	}
	return yccToRgba(PIXELS[0], PIXELS[1], PIXELS[2]);
}

/** TILE_UPGRADE: 成分ごとに SRL と RAW の 2 つのビット列。足りないビットを係数に足して、逆 DWT し直す */
function upgrade(
	tile: Tile,
	quant: Yuv<Quant>,
	prog: Yuv<Quant>,
	data: Uint8Array[],
	extrapolate: boolean,
): Uint8ClampedArray {
	const bands = extrapolate ? EXTRAPOLATED : NORMAL;
	for (let c = 0; c < 3; c++) {
		const bitPos = add(quant[c] as Quant, prog[c] as Quant);
		const old = tile.bitPos[c] as Quant;
		const numBits = bitPos.map((v, i) => (old[i] as number) - v);
		const shift = shiftOf(bitPos);
		tile.bitPos[c] = bitPos;
		const current = tile.current[c] as Int16Array;
		const sign = tile.sign[c] as Int16Array;
		const srl = new Bits(data[c * 2] as Uint8Array);
		const raw = new Bits(data[c * 2 + 1] as Uint8Array);
		const state: SrlState = { kp: 8, nz: 0, unary: false };
		for (let b = 0; b < 10; b++) {
			const n = numBits[b] as number;
			if (n <= 0) continue;
			const [at, len] = bands[b] as [number, number];
			const s = shift[b] as number;
			if (b === 9) {
				// LL3 は全部 RAW から
				for (let i = at; i < at + len; i++)
					current[i] = (current[i] as number) + (raw.bits(n) << s);
				continue;
			}
			for (let i = at; i < at + len; i++) {
				const sg = sign[i] as number;
				let v: number;
				if (sg > 0) v = raw.bits(n);
				else if (sg < 0) v = -raw.bits(n);
				else {
					// まだ 0 だった係数は SRL から(ここで初めて符号が決まる)
					v = srlRead(state, srl, n);
					sign[i] = v;
				}
				current[i] = (current[i] as number) + (v << s);
			}
		}
		const buf = PIXELS[c] as Int16Array;
		buf.set(current);
		dwt(buf, extrapolate);
	}
	return yccToRgba(PIXELS[0], PIXELS[1], PIXELS[2]);
}

/** MSB から読むビット列。尽きたら 0 */
class Bits {
	private pos = 0;
	constructor(private data: Uint8Array) {}
	bit(): number {
		const i = this.pos >> 3;
		const b =
			i < this.data.length
				? ((this.data[i] as number) >> (7 - (this.pos & 7))) & 1
				: 0;
		this.pos++;
		return b;
	}
	bits(n: number): number {
		let v = 0;
		for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
		return v;
	}
}

type SrlState = { kp: number; nz: number; unary: boolean };

/** SRL(符号つきのランレングス)の 1 つの値。0 の並びは適応的な Golomb、0 でない値は符号 + 大きさの unary */
function srlRead(st: SrlState, bs: Bits, numBits: number): number {
	if (st.nz) {
		st.nz--;
		return 0;
	}
	const k = st.kp >> 3;
	if (!st.unary) {
		if (!bs.bit()) {
			// 0 の並びが 1 << k 個
			st.nz = (1 << k) - 1;
			st.kp = Math.min(80, st.kp + 4);
			return 0;
		}
		// 0 の並びが k ビットの数だけ(1 << k 未満)。そのあとに 0 でない値
		st.nz = k ? bs.bits(k) : 0;
		st.unary = true;
		if (st.nz) {
			st.nz--;
			return 0;
		}
	}
	st.unary = false;
	const negative = bs.bit() === 1;
	st.kp = Math.max(0, st.kp - 6);
	let mag = 1;
	if (numBits > 1) {
		const max = (1 << numBits) - 1;
		while (mag < max) {
			if (bs.bit()) break;
			mag++;
		}
	}
	return negative ? -mag : mag;
}

/** SRL のビット列の先頭から n 個の値(状態は初めから。試験用) */
export function srlValues(
	data: Uint8Array,
	numBits: number,
	n: number,
): number[] {
	const st: SrlState = { kp: 8, nz: 0, unary: false };
	const bs = new Bits(data);
	return Array.from({ length: n }, () => srlRead(st, bs, numBits));
}

// ---- 逆 DWT ----

/** C の INT16 への代入(あふれは折り返す) */
const s16 = (v: number) => (v << 16) >> 16;
/** C の整数の割り算(0 へ切り捨て) */
const half = (v: number) => (v / 2) | 0;

const TMP = new Int16Array(4096);

function dwt(buf: Int16Array, extrapolate: boolean): void {
	if (!extrapolate) {
		WIDE.set(buf);
		inverseDwt(WIDE);
		buf.set(WIDE);
		return;
	}
	dwtBlock(buf, 3807, 3);
	dwtBlock(buf, 3007, 2);
	dwtBlock(buf, 0, 1);
}

/** 外挿の形の 1 段。buf[at..] に HL(L 行 x H 列)LH(H x L)HH(H x H)LL(L x L)が並び、(L+H) x (L+H) の画素で置き換える */
function dwtBlock(buf: Int16Array, at: number, level: number): void {
	const nL = (64 >> level) + 1;
	const nH = level === 1 ? 31 : (64 + (1 << (level - 1))) >> level;
	const hl = at;
	const lh = hl + nH * nL;
	const hh = lh + nL * nH;
	const ll = hh + nH * nH;
	const w = nL + nH;
	const hi = nL * w;
	// 水平: LL + HL → 低域の行(L 行)、LH + HH → 高域の行(H 行)
	for (let y = 0; y < nL; y++)
		lift(buf, ll + y * nL, hl + y * nH, 1, TMP, y * w, 1, nL, nH);
	for (let y = 0; y < nH; y++)
		lift(buf, lh + y * nL, hh + y * nH, 1, TMP, hi + y * w, 1, nL, nH);
	// 垂直: 列ごと
	for (let x = 0; x < w; x++) lift(TMP, x, hi + x, w, buf, at + x, w, nL, nH);
}

/** 1 本の逆変換。低域 nL 個と高域 nH 個から nL + nH 個。lo / hi の歩幅は step、出力の歩幅は dStep */
function lift(
	s: Int16Array,
	lo: number,
	hi: number,
	step: number,
	d: Int16Array,
	o: number,
	dStep: number,
	nL: number,
	nH: number,
): void {
	let h0 = s[hi] as number;
	let l0 = s[lo] as number;
	hi += step;
	lo += step;
	let x0 = s16(l0 - h0);
	let x2 = x0;
	for (let j = 0; j < nH - 1; j++) {
		const h1 = s[hi] as number;
		l0 = s[lo] as number;
		hi += step;
		lo += step;
		x2 = s16(l0 - half(h0 + h1));
		d[o] = x0;
		d[o + dStep] = half(x0 + x2) + 2 * h0;
		o += 2 * dStep;
		x0 = x2;
		h0 = h1;
	}
	if (nL <= nH) {
		d[o] = x2;
		d[o + dStep] = x2 + 2 * h0;
	} else if (nL === nH + 1) {
		x0 = s16((s[lo] as number) - h0);
		d[o] = x2;
		d[o + dStep] = half(x0 + x2) + 2 * h0;
		d[o + 2 * dStep] = x0;
	} else {
		x0 = s16((s[lo] as number) - half(h0));
		d[o] = x2;
		d[o + dStep] = half(x0 + x2) + 2 * h0;
		d[o + 2 * dStep] = x0;
		d[o + 3 * dStep] = half(x0 + (s[lo + step] as number));
	}
}
