// Surface Commands([MS-RDPBCGR] 2.2.9.2)。Fast-Path の SURFCMDS の更新に、複数のコマンドが並ぶ:
// Set Surface Bits / Stream Surface Bits(コーデックで符号化されたビットマップ)と Frame Marker。
//
// RemoteFX のタイルは独立で、同じ位置の新しいタイルは古いものを完全に置き換える。サーバーが復号より速く送ってくると
// 溜まった更新を順に全部復号して遅れが膨らむので、SurfaceRenderer は復号を後回しにして、同じ位置は最新だけを復号する。

import { Reader } from "./bytes";
import { decodeTile, parseQuant, type Rect, TILE } from "./rfx";
import { SyncPool, type TilePool } from "./rfxpool";

const CMD_SET_SURFACE_BITS = 0x0001;
const CMD_FRAME_MARKER = 0x0004;
const CMD_STREAM_SURFACE_BITS = 0x0006;

const EX_COMPRESSED_BITMAP_HEADER_PRESENT = 0x01;

/** Frame Marker の frameAction */
export const FRAME_BEGIN = 0;
export const FRAME_END = 1;

/** codecId 0 は「コーデックなし」(生のビットマップ)。RemoteFX の ID は能力セットで決める */
export const CODEC_NONE = 0;

/** 1 つのビットマップの縦横の上限(安全のため) */
const MAX_SIDE = 16384;

export type SurfaceDraw = (
	x: number,
	y: number,
	w: number,
	h: number,
	rgba: Uint8ClampedArray,
) => void;

type ScreenSize = { width: number; height: number };

export type SurfaceEvents = {
	draw: SurfaceDraw;
	/** Frame Marker(0 = 始まり、1 = 終わり) */
	frame?(action: number, frameId: number): void;
	/** 渡すと、RemoteFX は復号せずにこれへ渡す(bits は Surface Bits の本体。復号は呼び出し側が後でする) */
	rfx?(
		bits: Uint8Array,
		left: number,
		top: number,
		right: number,
		bottom: number,
	): void;
};

/**
 * Surface Commands の列を処理する。画面の大きさ(width x height)の外は描かない。
 * rfxCodecId は、サーバーと決めた RemoteFX の codecId
 */
export function handleSurfaceCommands(
	data: Uint8Array,
	rfxCodecId: number,
	screen: ScreenSize,
	ev: SurfaceEvents,
): void {
	const r = new Reader(data);
	while (r.left >= 2) {
		const cmd = r.u16();
		switch (cmd) {
			case CMD_SET_SURFACE_BITS:
			case CMD_STREAM_SURFACE_BITS: {
				const left = r.u16();
				const top = r.u16();
				const right = r.u16();
				const bottom = r.u16();
				const bpp = r.u8();
				const flags = r.u8();
				r.u8(); // reserved
				const codecId = r.u8();
				const width = r.u16();
				const height = r.u16();
				const len = r.u32();
				if (flags & EX_COMPRESSED_BITMAP_HEADER_PRESENT) r.skip(16);
				if (len > r.left) throw new Error(`Surface Bits の長さが不正 (${len})`);
				const bits = r.bytes(len);
				if (width > MAX_SIDE || height > MAX_SIDE)
					throw new Error("Surface Bits が大きすぎる");
				if (codecId === rfxCodecId && codecId !== CODEC_NONE) {
					if (ev.rfx) ev.rfx(bits, left, top, right, bottom);
					else {
						const area = commandArea(left, top, right, bottom, screen);
						for (const t of parseRfxTiles(bits))
							drawTile(decodeRfxTile(t), t, left, top, area, ev.draw);
					}
				} else if (codecId === CODEC_NONE) {
					if (bpp !== 32)
						throw new Error(`生の Surface Bits は 32bpp だけ (${bpp})`);
					drawRaw(bits, left, top, width, height, screen, ev.draw);
				}
				// 知らないコーデックは描かない(能力で宣言していないので来ない)
				break;
			}
			case CMD_FRAME_MARKER: {
				const action = r.u16();
				const id = r.u32();
				ev.frame?.(action, id);
				break;
			}
			default:
				throw new Error(`知らない Surface コマンド 0x${cmd.toString(16)}`);
		}
	}
}

/** 矩形 a を、画面 b の中に切る。空なら null */
function intersect(a: Rect, b: Rect): Rect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const x2 = Math.min(a.x + a.w, b.x + b.w);
	const y2 = Math.min(a.y + a.h, b.y + b.h);
	return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}

const sameRect = (a: Rect, b: Rect) =>
	a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** RGBA の画像(幅 stride)から矩形(画像の中の座標)を切り出す */
function crop(
	rgba: Uint8ClampedArray,
	stride: number,
	r: Rect,
): Uint8ClampedArray {
	if (r.w === stride && r.x === 0)
		return rgba.subarray(r.y * stride * 4, (r.y + r.h) * stride * 4);
	const out = new Uint8ClampedArray(r.w * r.h * 4);
	for (let y = 0; y < r.h; y++) {
		const s = ((r.y + y) * stride + r.x) * 4;
		out.set(rgba.subarray(s, s + r.w * 4), y * r.w * 4);
	}
	return out;
}

/** コマンドの矩形のうち画面に入る部分(絶対座標)。画面の外なら null */
function commandArea(
	left: number,
	top: number,
	right: number,
	bottom: number,
	screen: ScreenSize,
): Rect | null {
	return intersect(
		{
			x: left,
			y: top,
			w: Math.max(0, right - left),
			h: Math.max(0, bottom - top),
		},
		{ x: 0, y: 0, w: screen.width, h: screen.height },
	);
}

// ---- RemoteFX のタイルの切り出し(復号はしない) ----

const WBT_REGION = 0xccc6;
const WBT_EXTENSION = 0xccc7;
const CBT_REGION = 0xcac1;
const CBT_TILESET = 0xcac2;
const CBT_TILE = 0xcac3;
const MAX_TILES = 1 << 12;
const MAX_RECTS = 1 << 12;
const MAX_QUANT = 16;

/** 復号前のタイル: 位置(コマンドの左上からの画素)と、圧縮されたままの 3 成分 */
export type RawTile = {
	x: number;
	y: number;
	mode: number;
	data: [Uint8Array, Uint8Array, Uint8Array];
	quant: [number[], number[], number[]];
	/** このタイルを描いてよい領域(Region の矩形)。空なら全体 */
	rects: Rect[];
};

/** RemoteFX のストリームから、タイルの位置と圧縮データを取り出す(rfx.ts の decodeStream の、復号しない版) */
export function parseRfxTiles(data: Uint8Array): RawTile[] {
	const r = new Reader(data);
	const tiles: RawTile[] = [];
	let rects: Rect[] = [];
	while (r.left >= 6) {
		const type = r.u16();
		const len = r.u32();
		if (len < 6 || len - 6 > r.left)
			throw new Error(`RemoteFX: ブロックの長さが不正 (${len})`);
		const body = r.sub(len - 6);
		if (type === WBT_REGION) rects = parseRegionRects(body);
		else if (type === WBT_EXTENSION) parseTilesetTiles(body, rects, tiles);
		else if (type < 0xccc0 || type > 0xccc7)
			throw new Error(`RemoteFX: 知らないブロック 0x${type.toString(16)}`);
	}
	return tiles;
}

function parseRegionRects(r: Reader): Rect[] {
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

function parseTilesetTiles(r: Reader, rects: Rect[], out: RawTile[]): void {
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

function decodeRfxTile(t: RawTile): Uint8ClampedArray {
	return decodeTile(t.mode, t.data, t.quant);
}

/** 復号したタイルを、Region の矩形と画面で切って描く */
function drawTile(
	rgba: Uint8ClampedArray,
	t: { x: number; y: number; rects: Rect[] },
	left: number,
	top: number,
	area: Rect | null,
	draw: SurfaceDraw,
): void {
	const tile: Rect = { x: t.x, y: t.y, w: TILE, h: TILE };
	const clips = t.rects.length ? t.rects : [tile];
	for (const clip of clips) {
		const part = intersect(tile, clip);
		if (!part) continue;
		const abs = intersect(
			{ x: part.x + left, y: part.y + top, w: part.w, h: part.h },
			area ?? { x: 0, y: 0, w: 0, h: 0 },
		);
		if (!abs) continue;
		draw(
			abs.x,
			abs.y,
			abs.w,
			abs.h,
			crop(rgba, TILE, {
				x: abs.x - left - t.x,
				y: abs.y - top - t.y,
				w: abs.w,
				h: abs.h,
			}),
		);
	}
}

/** コーデックなし: 32 ビットの BGRA(上の行から)。大きさを超える分は切る */
function drawRaw(
	bits: Uint8Array,
	left: number,
	top: number,
	width: number,
	height: number,
	screen: ScreenSize,
	draw: SurfaceDraw,
): void {
	if (bits.length < width * height * 4)
		throw new Error("Surface Bits(生)が短い");
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		rgba[i * 4] = bits[i * 4 + 2] as number;
		rgba[i * 4 + 1] = bits[i * 4 + 1] as number;
		rgba[i * 4 + 2] = bits[i * 4] as number;
		rgba[i * 4 + 3] = 255;
	}
	const abs = intersect(
		{ x: left, y: top, w: width, h: height },
		{ x: 0, y: 0, w: screen.width, h: screen.height },
	);
	if (abs)
		draw(
			abs.x,
			abs.y,
			abs.w,
			abs.h,
			crop(rgba, width, {
				x: abs.x - left,
				y: abs.y - top,
				w: abs.w,
				h: abs.h,
			}),
		);
}

// ---- 間引き ----

type Pending = {
	tile: RawTile;
	left: number;
	top: number;
	area: Rect | null;
	/** 後のタイルに完全に置き換えられた */
	dead: boolean;
	/** Worker での復号の状態(非同期のプールのとき) */
	state: "waiting" | "done" | "failed";
	rgba?: Uint8ClampedArray;
};

/** プールに回した 1 回ぶんの吐き出し。順番に描き、フレームの応答を返し、あとに予約された処理を流す */
type Batch = {
	jobs: Pending[];
	ended: number[];
	after: (() => void)[];
};

/** 溜めてよいタイルの数(これを超えたら、すぐ吐き出す) */
const MAX_PENDING = 8192;

export type SurfaceRendererOptions = {
	draw: SurfaceDraw;
	/** 終わったフレーム(Frame Marker の End)の描画が済んだら、frameId ごとに呼ぶ(Frame Acknowledge を返す) */
	ack?(frameId: number): void;
	/** 吐き出しの予約。既定は setTimeout(0)(受信ループが、バッファにある PDU を読み終えてから走る) */
	schedule?(fn: () => void): void;
	/** タイルの復号の置き場。既定はその場で復号する(SyncPool)。非同期のプールなら、並列に復号して、揃った順に描く */
	pool?: TilePool;
};

/**
 * Surface Commands を、RemoteFX の復号を後回しにして処理する。
 * 同じ位置のタイルは最新だけを復号する。復号がプール(Worker)で非同期でも、描く順序と Frame Acknowledge の順序は保つ。
 * 順序が意味を持つ更新(生のビットマップ・旧ビットマップ・画面の大きさの変更)は ordered() で包むこと
 */
export class SurfaceRenderer {
	private entries: Pending[] = [];
	/** タイルの位置(絶対座標)→ まだ描いていないタイル(復号中を含む) */
	private byKey = new Map<string, Pending[]>();
	private ended: number[] = [];
	private scheduled = false;
	private draw: SurfaceDraw;
	private ack?: (frameId: number) => void;
	private schedule: (fn: () => void) => void;
	private pool: TilePool;
	/** プールに回して、まだ描き終えていない吐き出し(古い順) */
	private batches: Batch[] = [];
	/** 復号できずに捨てたタイル(診断用) */
	skipped = 0;
	/** 後のタイルに置き換えられて、復号しなかった(結果を捨てた)タイル(診断用) */
	coalesced = 0;

	constructor(o: SurfaceRendererOptions) {
		this.draw = o.draw;
		this.ack = o.ack;
		this.schedule = o.schedule ?? ((fn) => void setTimeout(fn, 0));
		this.pool = o.pool ?? new SyncPool();
	}

	get pending(): number {
		let n = 0;
		for (const e of this.entries) if (!e.dead) n++;
		return n;
	}

	/** 復号中(プールに回して、まだ描いていない)のタイルの数 */
	get inFlight(): number {
		let n = 0;
		for (const b of this.batches) for (const j of b.jobs) if (!j.dead) n++;
		return n;
	}

	handle(data: Uint8Array, rfxCodecId: number, screen: ScreenSize): void {
		handleSurfaceCommands(data, rfxCodecId, screen, {
			// 生のビットマップは順序が意味を持つので、タイルが先に描き終わってから描く
			draw: (x, y, w, h, rgba) =>
				this.ordered(() => this.draw(x, y, w, h, rgba)),
			frame: (action, id) => {
				if (action === FRAME_END) {
					this.ended.push(id);
					this.request();
				}
			},
			rfx: (bits, left, top, right, bottom) => {
				const area = commandArea(left, top, right, bottom, screen);
				for (const tile of parseRfxTiles(bits)) this.add(tile, left, top, area);
				this.request();
			},
		});
	}

	private add(
		tile: RawTile,
		left: number,
		top: number,
		area: Rect | null,
	): void {
		const abs: Rect = { x: tile.x + left, y: tile.y + top, w: TILE, h: TILE };
		const visible = area && intersect(abs, area);
		if (!visible) return; // 画面の外
		// 描く部分が見えるタイル全体なら、同じ位置の古いタイルは要らない(復号中のものも、結果を捨てる)
		const clips = tile.rects.length
			? tile.rects
			: [{ x: 0, y: 0, w: TILE, h: TILE }];
		const full = clips.some((c) => {
			const p = intersect({ x: tile.x, y: tile.y, w: TILE, h: TILE }, c);
			if (!p) return false;
			const a = intersect(
				{ x: p.x + left, y: p.y + top, w: p.w, h: p.h },
				area ?? visible,
			);
			return !!a && sameRect(a, visible);
		});
		const key = `${abs.x},${abs.y}`;
		const e: Pending = { tile, left, top, area, dead: false, state: "waiting" };
		if (full) {
			for (const old of this.byKey.get(key) ?? []) {
				if (!old.dead) this.coalesced++;
				old.dead = true;
			}
			this.byKey.set(key, [e]);
		} else {
			const list = this.byKey.get(key);
			if (list) list.push(e);
			else this.byKey.set(key, [e]);
		}
		this.entries.push(e);
		if (this.entries.length >= MAX_PENDING) this.flush();
	}

	private request(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		this.schedule(() => {
			this.scheduled = false;
			this.flush();
		});
	}

	/**
	 * 溜めたタイルを復号に回す。同期のプールならその場で復号して描き、終わったフレームの応答を返す。
	 * 非同期のプールなら、描くのは揃ってから(順序どおり)
	 */
	flush(): void {
		const entries = this.entries.filter((e) => !e.dead);
		this.entries = [];
		const ended = this.ended;
		this.ended = [];
		if (!this.pool.async && this.batches.length === 0) {
			for (const e of entries) {
				this.forget(e);
				try {
					this.drawJob(e, decodeRfxTile(e.tile));
				} catch {
					this.skipped++; // 壊れたタイルは捨てて、ほかを描く
				}
			}
			for (const id of ended) this.ack?.(id);
			this.byKey.clear();
			return;
		}
		if (entries.length === 0 && ended.length === 0) return;
		const batch: Batch = { jobs: entries, ended, after: [] };
		this.batches.push(batch);
		for (const e of entries) {
			this.pool.decode(e.tile.mode, e.tile.data, e.tile.quant).then(
				(rgba) => {
					e.rgba = rgba;
					e.state = "done";
					this.drain();
				},
				() => {
					e.state = "failed";
					this.drain();
				},
			);
		}
		this.drain();
	}

	/** 順序が意味を持つ処理。溜めたタイルと復号中のタイルをすべて描き終えてから fn を流す */
	ordered(fn: () => void): void {
		this.flush();
		const last = this.batches[this.batches.length - 1];
		if (last) last.after.push(fn);
		else fn();
	}

	/** 先頭の吐き出しから、復号が全部終わったものを順に描く */
	private drain(): void {
		for (;;) {
			const b = this.batches[0];
			if (!b || b.jobs.some((j) => j.state === "waiting")) return;
			this.batches.shift();
			for (const e of b.jobs) {
				this.forget(e);
				if (e.dead) continue; // 後のタイルに置き換えられた
				if (e.state === "done" && e.rgba) {
					try {
						this.drawJob(e, e.rgba);
					} catch {
						this.skipped++;
					}
				} else this.skipped++;
				e.rgba = undefined;
			}
			for (const id of b.ended) this.ack?.(id);
			for (const fn of b.after) fn();
			if (this.batches.length === 0) this.byKey.clear();
		}
	}

	private drawJob(e: Pending, rgba: Uint8ClampedArray): void {
		drawTile(rgba, e.tile, e.left, e.top, e.area, this.draw);
	}

	/** 描き終えた(捨てた)タイルを、位置の索引から外す */
	private forget(e: Pending): void {
		const key = `${e.tile.x + e.left},${e.tile.y + e.top}`;
		const list = this.byKey.get(key);
		if (!list) return;
		const i = list.indexOf(e);
		if (i >= 0) list.splice(i, 1);
		if (list.length === 0) this.byKey.delete(key);
	}

	/** Worker を止める(切断のとき) */
	dispose(): void {
		this.pool.terminate();
	}
}
