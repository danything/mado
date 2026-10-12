// RemoteFX Progressive([MS-RDPEGFX] 2.2.4.2)。GFX の WireToSurface2 で CAPROGRESSIVE として来る。
// 64x64 のタイルを、まず TILE_FIRST / TILE_SIMPLE で粗く送り、あとから TILE_UPGRADE で細かくしていく。
// 面ごと、タイルごとに覚えておくものは 3 つ。逆量子化した係数 current、符号 sign、どのビットまで来たか bitPos。
// upgrade では、足りない下のビットを SRL と RAW の 2 つのビット列から係数に足して、復号し直す。
// RLGR と色変換は RemoteFX(rfx.ts)と同じ。逆 DWT には、帯を 33 / 31 などに分ける「外挿」の形(RFX_DWT_REDUCE_EXTRAPOLATE)がある。
// C の整数の割り算や INT16 のあふれといった細かいところは、FreeRDP の progressive.c に合わせる。

import { Reader } from "./bytes";
import {
	BANDS,
	cutTile,
	ENTROPY_RLGR1,
	inverseDwt,
	type Rect,
	rlgrDecode,
	TILE,
	type TilePart,
	yccToRgba,
} from "./rfx";

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
/** quality がこの値なら、progressive の量子化は全部 0 になる。最初から最後の段にあたる */
const FULL_QUALITY = 0xff;

const MAX_RECTS = 1 << 12;
const MAX_TILES = 1 << 12;

/** 10 の帯の値。順は rfx.ts の BANDS と同じで HL1 LH1 HH1 HL2 LH2 HH2 HL3 LH3 HH3 LL3 */
type Quant = number[];
type Yuv<T> = [T, T, T];

/** 外挿の形の帯の [位置, 大きさ]。通常の形は rfx.ts の BANDS を使う。1 段目は低域 33・高域 31、2 段目は 17・16、3 段目は 9・8 */
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
 * 量子化の 5 バイトを BANDS の順に並べ替える。5 バイトには 4 ビットずつ、下位から LL3 HL3 / LH3 HH3 / HL2 LH2 / HH2 HL1 / LH1 HH1 が入る。
 * RemoteFX の TS_RFX_CODEC_QUANT とは HL と LH の並びが違う
 */
export function parseProgressiveQuant(b: Uint8Array): Quant {
	const n = (i: number) =>
		i & 1 ? (b[i >> 1] as number) >> 4 : (b[i >> 1] as number) & 15;
	return [n(7), n(8), n(9), n(4), n(5), n(6), n(1), n(2), n(3), n(0)];
}

/** 1 つのタイルについて、upgrade のために覚えておくもの */
type Tile = {
	/** 逆量子化した係数。DWT の前の値 */
	current: Yuv<Int16Array>;
	/** 最初の段の量子化された値。upgrade でどちらのビット列から読むかを、これで決める */
	sign: Yuv<Int16Array>;
	/** 帯ごとに、どのビットまで来たか。量子化と progressive の量子化を足したもの */
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
	rects: Rect[];
	quants: Quant[];
	/** quality の番号ごとの、Y・Cb・Cr の progressive の量子化 */
	progQuants: Yuv<Quant>[];
	extrapolate: boolean;
};

/**
 * 1 枚のタイルを復号する仕事。構造化複製できるものだけで作るので、Worker へ渡せる。
 * upgrade のための係数などタイルの状態は、復号する側の ProgressiveTiles が surface と key で持つ
 */
export type ProgressiveTileJob = {
	surface: number;
	/** yIdx * 65536 + xIdx */
	key: number;
	/** WBT_TILE_SIMPLE / FIRST / UPGRADE */
	type: number;
	quant: Yuv<Quant>;
	prog: Yuv<Quant>;
	/** TILE_FIRST / SIMPLE で、前の係数に足すとき(RFX_TILE_DIFFERENCE) */
	diff: boolean;
	extrapolate: boolean;
	/** FIRST / SIMPLE は Y・Cb・Cr の 3 つ。UPGRADE は成分ごとに SRL と RAW があるので 6 つ */
	data: Uint8Array[];
};

/** 読み取ったタイル。復号の仕事と、面のどこに描くかを持つ */
export type ProgressiveTile = {
	job: ProgressiveTileJob;
	x: number;
	y: number;
};

/** 読み取った 1 つの WireToSurface2。復号するタイルと、描く矩形を持つ。矩形は Region のもので、タイルの無い矩形もある */
export type ProgressiveMessage = {
	tiles: ProgressiveTile[];
	rects: Rect[];
};

/** タイルの状態を持って復号する。Worker で復号するときは、タイルの位置ごとに受け持つ Worker を決めて、同じタイルは同じ Worker で復号する */
export class ProgressiveTiles {
	/** 面ごとに、key からタイルを引く表 */
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
 * WireToSurface2 の bitmapData を読み、復号するタイルを並べる。復号はしない。
 * width / height は面の大きさ。面の外のタイルは描けないので飛ばす。PDU 全体は捨てない
 */
export function parseProgressive(
	surface: number,
	data: Uint8Array,
	width: number,
	height: number,
): ProgressiveMessage {
	const out: ProgressiveMessage = { tiles: [], rects: [] };
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

/**
 * 1 つの GFX のフレーム(StartFrame から EndFrame まで)の中で復号したタイル。
 * Windows は、同じフレームの前の PDU で送ったタイルを、後の PDU の矩形にも描かせる。矩形だけでタイルの無い PDU も来る。
 * そこで FreeRDP と同じく、PDU ごとに、このフレームで復号したタイル全部をその PDU の矩形で切って描く。
 * その PDU のタイルだけを描いていたときは、窓を動かしたあとの空いたところが描かれず、残像が残った
 */
export class ProgressiveFrame {
	private surfaces = new Map<
		number,
		Map<number, { x: number; y: number; rgba: Uint8ClampedArray }>
	>();

	/** フレームの始まり。StartFrame で呼ぶ */
	reset(): void {
		this.surfaces.clear();
	}

	deleteSurface(id: number): void {
		this.surfaces.delete(id);
	}

	/** msg のタイルを復号した rgba を覚え、面に描く部分を返す。rgba は 64x64 でタイルと同じ順。width / height は面の大きさ */
	draw(
		surface: number,
		msg: ProgressiveMessage,
		rgba: Uint8ClampedArray[],
		width: number,
		height: number,
	): TilePart[] {
		let tiles = this.surfaces.get(surface);
		if (!tiles) {
			tiles = new Map();
			this.surfaces.set(surface, tiles);
		}
		for (const [i, t] of msg.tiles.entries())
			tiles.set(t.job.key, {
				x: t.x,
				y: t.y,
				rgba: rgba[i] as Uint8ClampedArray,
			});
		const out: TilePart[] = [];
		for (const t of tiles.values())
			out.push(...cutTile(t.rgba, t.x, t.y, msg.rects, width, height));
		return out;
	}
}

function region(
	r: Reader,
	surface: number,
	width: number,
	height: number,
	out: ProgressiveMessage,
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
	out.rects.push(...reg.rects);
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
		// 面の外のタイルは描けないので飛ばす。ほかのタイルは描く
		if (xIdx * TILE >= width || yIdx * TILE >= height) continue;
		out.tiles.push({
			job: {
				...job,
				surface,
				key: yIdx * 65536 + xIdx,
				quant: quant as Yuv<Quant>,
				extrapolate: reg.extrapolate,
			},
			x: xIdx * TILE,
			y: yIdx * TILE,
		});
	}
}

function progQuant(reg: Region, quality: number): Yuv<Quant> {
	if (quality === FULL_QUALITY) return [ZERO, ZERO, ZERO];
	const q = reg.progQuants[quality];
	if (!q) throw new Error("Progressive: quality の番号が範囲外");
	return q;
}

// ---- タイルの復号 ----

const COEF = new Int32Array(4096);
const WIDE = new Int32Array(4096);
const PIXELS: Yuv<Int16Array> = [
	new Int16Array(4096),
	new Int16Array(4096),
	new Int16Array(4096),
];

/** 帯ごとのビットの位置。量子化と progressive の量子化の和 */
const add = (a: Quant, b: Quant): Quant =>
	a.map((v, i) => v + (b[i] as number));
/** 逆量子化でずらす量。ビットの位置から 1 を引いたもので、5 ビットの小数が残る */
const shiftOf = (bitPos: Quant): Quant => bitPos.map((v) => Math.max(0, v - 1));

/** TILE_FIRST / TILE_SIMPLE。RLGR、符号を覚える、LL3 の差分、逆量子化、差分なら前の係数に足す、覚える、逆 DWT の順に進む */
function first(
	tile: Tile,
	quant: Yuv<Quant>,
	prog: Yuv<Quant>,
	data: Yuv<Uint8Array>,
	diff: boolean,
	extrapolate: boolean,
): Uint8ClampedArray {
	const bands = extrapolate ? EXTRAPOLATED : BANDS;
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

/** TILE_UPGRADE。成分ごとに SRL と RAW の 2 つのビット列が来る。足りないビットを係数に足して、逆 DWT し直す */
function upgrade(
	tile: Tile,
	quant: Yuv<Quant>,
	prog: Yuv<Quant>,
	data: Uint8Array[],
	extrapolate: boolean,
): Uint8ClampedArray {
	const bands = extrapolate ? EXTRAPOLATED : BANDS;
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
				// LL3 は全部 RAW から読む
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
					// まだ 0 だった係数は SRL から読む。ここで初めて符号が決まる
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

/** SRL(符号つきのランレングス)の値を 1 つ読む。0 の並びは適応的な Golomb で、0 でない値は符号と大きさの unary で来る */
function srlRead(st: SrlState, bs: Bits, numBits: number): number {
	if (st.nz) {
		st.nz--;
		return 0;
	}
	const k = st.kp >> 3;
	if (!st.unary) {
		if (!bs.bit()) {
			// 0 が 1 << k 個並ぶ
			st.nz = (1 << k) - 1;
			st.kp = Math.min(80, st.kp + 4);
			return 0;
		}
		// 0 が k ビットの数だけ並ぶ。1 << k 未満。そのあとに 0 でない値が来る
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

/** SRL のビット列の先頭から n 個の値を読む。状態は初めから。試験用 */
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

/** C の INT16 への代入。あふれたら折り返す */
const s16 = (v: number) => (v << 16) >> 16;
/** C の整数の割り算。0 の方へ切り捨てる */
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

/** 外挿の形の 1 段。buf[at..] には HL(L 行 x H 列)、LH(H x L)、HH(H x H)、LL(L x L)が並ぶ。これを (L+H) x (L+H) の画素で置き換える */
function dwtBlock(buf: Int16Array, at: number, level: number): void {
	const nL = (64 >> level) + 1;
	const nH = level === 1 ? 31 : (64 + (1 << (level - 1))) >> level;
	const hl = at;
	const lh = hl + nH * nL;
	const hh = lh + nL * nH;
	const ll = hh + nH * nH;
	const w = nL + nH;
	const hi = nL * w;
	// 水平。LL と HL から低域の行(L 行)を、LH と HH から高域の行(H 行)を作る
	for (let y = 0; y < nL; y++)
		lift(buf, ll + y * nL, hl + y * nH, 1, TMP, y * w, 1, nL, nH);
	for (let y = 0; y < nH; y++)
		lift(buf, lh + y * nL, hh + y * nH, 1, TMP, hi + y * w, 1, nL, nH);
	// 垂直。列ごとに変換する
	for (let x = 0; x < w; x++) lift(TMP, x, hi + x, w, buf, at + x, w, nL, nH);
}

/** 1 本の逆変換。低域 nL 個と高域 nH 個から nL + nH 個を作る。lo / hi の歩幅は step、出力の歩幅は dStep */
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
