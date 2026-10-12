// Surface Commands([MS-RDPBCGR] 2.2.9.2)。Fast-Path の SURFCMDS の更新には、複数のコマンドが並ぶ。
// コマンドは Set Surface Bits / Stream Surface Bits(コーデックで符号化したビットマップ)と Frame Marker。
//
// サーバーが復号より速く送ってくると、溜まった更新を順に全部復号することになり、遅れが膨らむ。そこで SurfaceRenderer は復号を後回しにする。
// 同じ左上にある古いもの(RemoteFX のタイルや旧ビットマップ)は、新しいものが描く範囲にすっぽり入るときに限って復号しない。
// 旧ビットマップも同じ列に載せて、受けた順に描く。Windows は RemoteFX を使わないとき planar などで送ってくる。

import { type BitmapRect, bgraToRgba } from "./bitmap";
import { Reader } from "./bytes";
import {
	cutTile,
	decodeTile,
	parseTiles,
	type RawTile,
	type Rect,
	TILE,
} from "./rfx";
import { type DecodeJob, decodeJob, SyncPool, type TilePool } from "./rfxpool";

const CMD_SET_SURFACE_BITS = 0x0001;
const CMD_FRAME_MARKER = 0x0004;
const CMD_STREAM_SURFACE_BITS = 0x0006;

const EX_COMPRESSED_BITMAP_HEADER_PRESENT = 0x01;

/** Frame Marker の frameAction の End。0 は Begin */
const FRAME_END = 1;

/** codecId 0 は「コーデックなし」で、生のビットマップ。RemoteFX の ID は能力セットで決める */
const CODEC_NONE = 0;

/** 1 つのビットマップの縦横の上限 */
const MAX_SIDE = 16384;

export type SurfaceDraw = (
	x: number,
	y: number,
	w: number,
	h: number,
	rgba: Uint8ClampedArray,
) => void;

type ScreenSize = { width: number; height: number };

type SurfaceEvents = {
	draw: SurfaceDraw;
	/** Frame Marker。0 が始まりで 1 が終わり */
	frame?(action: number, frameId: number): void;
	/** これを渡すと、RemoteFX は復号せずにこれへ渡す。bits は Surface Bits の本体で、復号は呼び出し側が後でする。右下では切らないので渡さない */
	rfx?(bits: Uint8Array, left: number, top: number): void;
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
				r.skip(4); // destRight, destBottom。commandArea を参照
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
					if (ev.rfx) ev.rfx(bits, left, top);
					else {
						const area = commandArea(left, top, screen);
						for (const t of parseTiles(bits))
							drawTile(
								decodeTile(t.mode, t.data, t.quant),
								t,
								left,
								top,
								area,
								ev.draw,
							);
					}
				} else if (codecId === CODEC_NONE) {
					if (bpp !== 32)
						throw new Error(`生の Surface Bits は 32bpp だけ (${bpp})`);
					drawRaw(bits, left, top, width, height, screen, ev.draw);
				}
				// 知らないコーデックは描かない。能力で宣言していないので来ないはず
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

/** 矩形 a が b をすっぽり含むか */
const contains = (a: Rect, b: Rect) =>
	a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

/** RGBA の画像(幅 stride)から矩形を切り出す。矩形は画像の中の座標 */
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

/**
 * RemoteFX のタイルを描いてよい範囲。コマンドの左上から画面の右下まで。
 * コマンドの右下(destRight / destBottom)では切らない。FreeRDP と同じで、タイルを切るのは Region の矩形と画面だけ。
 * 以前は右下でも切っていて、Windows では Region からはみ出たタイルが描かれず、黒い四角が残った
 */
function commandArea(
	left: number,
	top: number,
	screen: ScreenSize,
): Rect | null {
	return intersect(
		{ x: left, y: top, w: screen.width - left, h: screen.height - top },
		{ x: 0, y: 0, w: screen.width, h: screen.height },
	);
}

/** 復号したタイルを、Region の矩形と描いてよい範囲(画面の座標)で切って描く。タイルと矩形の位置はコマンドの左上 (left, top) からの相対 */
function drawTile(
	rgba: Uint8ClampedArray,
	t: { x: number; y: number; rects: Rect[] },
	left: number,
	top: number,
	area: Rect | null,
	draw: SurfaceDraw,
): void {
	if (!area) return;
	const rects = t.rects.length
		? t.rects
		: [{ x: t.x, y: t.y, w: TILE, h: TILE }];
	// area の左上は (left, top) なので、相対の座標では右下だけで切ればよい
	const width = area.x + area.w - left;
	const height = area.y + area.h - top;
	for (const p of cutTile(rgba, t.x, t.y, rects, width, height))
		draw(p.x + left, p.y + top, p.w, p.h, p.rgba);
}

/** コーデックなし。32 ビットの BGRA が上の行から並ぶ。大きさを超える分は切る */
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
	const rgba = bgraToRgba(bits, width * height);
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
	/** RemoteFX のタイル。旧ビットマップなら undefined で、bitmap がある */
	tile?: RawTile;
	/** 旧ビットマップの矩形と、描く大きさ。幅が 4 の倍数に揃えてあるときは右の余りを切る */
	bitmap?: { rect: BitmapRect; w: number; h: number };
	/** 位置の索引の鍵。画面の座標での左上 */
	key: string;
	left: number;
	top: number;
	area: Rect | null;
	/** 後のタイルに完全に置き換えられたか */
	dead: boolean;
	/** Worker での復号の状態。非同期のプールのときに使う */
	state: "waiting" | "done" | "failed";
	rgba?: Uint8ClampedArray;
	/** 実際に描く範囲を囲む矩形(画面の座標)。後のタイルがこれを全部描くなら、このタイルは要らない */
	bounds: Rect;
};

/** 保留しているものの復号の仕事 */
function jobOf(e: Pending): DecodeJob {
	if (e.tile)
		return {
			kind: "rfx",
			mode: e.tile.mode,
			data: e.tile.data,
			quant: e.tile.quant,
		};
	return {
		kind: "bitmap",
		rect: (e.bitmap as NonNullable<Pending["bitmap"]>).rect,
	};
}

/** プールに回した 1 回ぶんの吐き出し。順番に描き、フレームの応答を返し、あとに予約された処理を流す */
type Batch = {
	jobs: Pending[];
	ended: number[];
	after: (() => void)[];
};

/** 溜めてよいタイルの数。これを超えたらすぐ吐き出す */
const MAX_PENDING = 8192;

type SurfaceRendererOptions = {
	draw: SurfaceDraw;
	/** 終わったフレーム(Frame Marker の End)を描き終えたら、frameId ごとに呼ぶ。ここで Frame Acknowledge を返す */
	ack?(frameId: number): void;
	/** 吐き出しの予約。既定は setTimeout(0) で、受信ループがバッファにある PDU を読み終えてから走る */
	schedule?(fn: () => void): void;
	/** タイルの復号の置き場。既定は SyncPool で、その場で復号する。非同期のプールなら並列に復号して、揃った順に描く */
	pool?: TilePool;
};

/**
 * Surface Commands を、RemoteFX の復号を後回しにして処理する。
 * 同じ位置のタイルは最新のものだけを復号する。復号が Worker のプールで非同期になっても、描く順序と Frame Acknowledge の順序は保つ。
 * 旧ビットマップは bitmaps() で同じ列に載せる。順序が意味を持つほかの更新は ordered() で包む。生のビットマップや画面の大きさの変更がそれにあたる
 */
export class SurfaceRenderer {
	private entries: Pending[] = [];
	/** タイルの位置(絶対座標)から、まだ描いていないタイルを引く。復号中のものも含む */
	private byKey = new Map<string, Pending[]>();
	private ended: number[] = [];
	private scheduled = false;
	private draw: SurfaceDraw;
	private ack?: (frameId: number) => void;
	private schedule: (fn: () => void) => void;
	private pool: TilePool;
	/** プールに回して、まだ描き終えていない吐き出し。古い順に並ぶ */
	private batches: Batch[] = [];
	/** 復号できずに捨てたタイルの数。診断用 */
	skipped = 0;
	/** 後のタイルに置き換えられて、復号しなかったか結果を捨てたタイルの数。診断用 */
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

	/** 復号中のタイルの数。プールに回して、まだ描いていないもの */
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
			rfx: (bits, left, top) => {
				const area = commandArea(left, top, screen);
				for (const tile of parseTiles(bits)) this.add(tile, left, top, area);
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
		// このタイルが実際に描く範囲(画面の座標)。Region の矩形、タイル、コマンドの範囲の重なりになる
		const clips = tile.rects.length
			? tile.rects
			: [{ x: tile.x, y: tile.y, w: TILE, h: TILE }];
		const drawn: Rect[] = [];
		for (const c of clips) {
			const p = intersect(
				{ x: c.x + left, y: c.y + top, w: c.w, h: c.h },
				visible,
			);
			if (p) drawn.push(p);
		}
		if (drawn.length === 0) return; // 描く部分が無い
		const bounds = drawn.reduce((u, r) => {
			const x = Math.min(u.x, r.x);
			const y = Math.min(u.y, r.y);
			return {
				x,
				y,
				w: Math.max(u.x + u.w, r.x + r.w) - x,
				h: Math.max(u.y + u.h, r.y + r.h) - y,
			};
		});
		// 1 つの矩形で描く範囲のまとまり。同じ位置の古いタイルは、描く範囲がこれにすっぽり入るときだけ要らない
		// 以前は自分の見える範囲を全部描くかだけで判定していた。すると見える範囲が狭い新しいタイルが古いタイルを捨て、
		// その部分にさらに前の絵が残った。Windows は更新の範囲をタイルより細かく切って送ってくる
		const cover = drawn.find((r) => sameRect(r, bounds));
		this.push(
			{
				tile,
				key: `${abs.x},${abs.y}`,
				left,
				top,
				area,
				dead: false,
				state: "waiting",
				bounds,
			},
			cover,
		);
	}

	/**
	 * 旧ビットマップの更新。矩形が並んで来る。復号を後回しにして、RemoteFX のタイルと混ざっても受けた順に描く。
	 * 同じ左上にある古いものは、タイルでもビットマップでも、この矩形が描く範囲にすっぽり入るときだけ要らない
	 */
	bitmaps(rects: BitmapRect[], screen: ScreenSize): void {
		for (const rect of rects) {
			const w = Math.min(rect.right - rect.left + 1, rect.width);
			const h = Math.min(rect.bottom - rect.top + 1, rect.height);
			if (w <= 0 || h <= 0) continue;
			const bounds = intersect(
				{ x: rect.left, y: rect.top, w, h },
				{ x: 0, y: 0, w: screen.width, h: screen.height },
			);
			if (!bounds) continue; // 画面の外
			this.push(
				{
					bitmap: { rect, w, h },
					key: `${rect.left},${rect.top}`,
					left: rect.left,
					top: rect.top,
					area: null,
					dead: false,
					state: "waiting",
					bounds,
				},
				bounds,
			);
		}
		this.request();
	}

	/** 保留に足す。cover は 1 つの矩形で描く範囲。これが同じ位置の古いものの描く範囲をすっぽり含むなら、古いものは捨てる */
	private push(e: Pending, cover: Rect | undefined): void {
		const list = (this.byKey.get(e.key) ?? []).filter((old) => {
			if (!cover || !contains(cover, old.bounds)) return true;
			if (!old.dead) this.coalesced++;
			old.dead = true;
			return false;
		});
		list.push(e);
		this.byKey.set(e.key, list);
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
	 * 非同期のプールなら、揃ってから順序どおりに描く
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
					this.drawJob(e, decodeJob(jobOf(e)));
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
			this.pool.run(jobOf(e)).then(
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
		}
	}

	private drawJob(e: Pending, rgba: Uint8ClampedArray): void {
		if (e.tile) {
			drawTile(rgba, e.tile, e.left, e.top, e.area, this.draw);
			return;
		}
		const b = e.bitmap as NonNullable<Pending["bitmap"]>;
		const full = b.w === b.rect.width;
		this.draw(
			e.left,
			e.top,
			b.w,
			b.h,
			full ? rgba : crop(rgba, b.rect.width, { x: 0, y: 0, w: b.w, h: b.h }),
		);
	}

	/** 描き終えたものや捨てたものを、位置の索引から外す */
	private forget(e: Pending): void {
		const list = this.byKey.get(e.key);
		if (!list) return;
		const i = list.indexOf(e);
		if (i >= 0) list.splice(i, 1);
		if (list.length === 0) this.byKey.delete(e.key);
	}

	/** Worker を止める。切断のときに呼ぶ */
	dispose(): void {
		this.pool.terminate();
	}
}
