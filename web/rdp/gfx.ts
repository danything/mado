// Graphics Pipeline([MS-RDPEGFX]、動的チャネル Microsoft::Windows::RDS::Graphics)。
// サーバーが面(surface)を作り、コーデック(H.264 の AVC420 / AVC444、ClearCodec、Planar、RemoteFX Progressive、生)で描き、面を画面へ写す。
// サーバーからの PDU は ZGFX で包まれて来る。こちらからの PDU(Caps・Frame Acknowledge)は包まない。
// 描画は GfxOps(ブラウザでは canvas、試験では偽物)に任せ、H.264 の復号は AvcDecoder(ブラウザでは VideoDecoder)に任せる。

import { FrameLatency, gfxTimestampMs } from "./autoscale";
import { decodePlanar } from "./bitmap";
import { Reader, Writer } from "./bytes";
import { ClearDecoder } from "./clearcodec";
import type { DynamicChannel, DynamicHandler } from "./dvc";
import {
	clipTile,
	ProgressiveDecoder,
	type ProgressivePart,
	type ProgressiveTile,
	parseProgressive,
} from "./progressive";
import { decodeStream } from "./rfx";
import type { TilePool } from "./rfxpool";
import { clampRects, type Yuv420, Yuv444 } from "./yuv444";
import { Zgfx } from "./zgfx";

export const GRAPHICS = "Microsoft::Windows::RDS::Graphics";

export const CMD = {
	WIRETOSURFACE_1: 0x0001,
	WIRETOSURFACE_2: 0x0002,
	DELETEENCODINGCONTEXT: 0x0003,
	SOLIDFILL: 0x0004,
	SURFACETOSURFACE: 0x0005,
	SURFACETOCACHE: 0x0006,
	CACHETOSURFACE: 0x0007,
	EVICTCACHEENTRY: 0x0008,
	CREATESURFACE: 0x0009,
	DELETESURFACE: 0x000a,
	STARTFRAME: 0x000b,
	ENDFRAME: 0x000c,
	FRAMEACKNOWLEDGE: 0x000d,
	RESETGRAPHICS: 0x000e,
	MAPSURFACETOOUTPUT: 0x000f,
	CACHEIMPORTOFFER: 0x0010,
	CACHEIMPORTREPLY: 0x0011,
	CAPSADVERTISE: 0x0012,
	CAPSCONFIRM: 0x0013,
	MAPSURFACETOWINDOW: 0x0015,
	QOEFRAMEACKNOWLEDGE: 0x0016,
	MAPSURFACETOSCALEDOUTPUT: 0x0017,
	MAPSURFACETOSCALEDWINDOW: 0x0018,
} as const;

export const CODEC = {
	UNCOMPRESSED: 0x0000,
	CAVIDEO: 0x0003,
	CLEARCODEC: 0x0008,
	CAPROGRESSIVE: 0x0009,
	PLANAR: 0x000a,
	AVC420: 0x000b,
	ALPHA: 0x000c,
	AVC444: 0x000e,
	AVC444V2: 0x000f,
} as const;

/**
 * 能力の版([MS-RDPEGFX] 2.2.3)。版 8.1 は AVC420 を使えるかを AVC420_ENABLED で、版 10 以上は使えないことを AVC_DISABLED で伝える。
 * 版 10 以上で AVC_DISABLED を付けないと AVC444 / AVC444v2 も使えることになる。
 * GPU の無い Windows 11 は 8.1 の AVC420 では H.264 を使わず版 8 を選んだ。版 10 以上なら H.264(AVC444)を使う
 */
const CAPVERSION_8 = 0x00080004;
const CAPVERSION_81 = 0x00080105;
/** 版 10.0 〜 10.7。10.1 だけ capsData が 16 バイト(予約で 0) */
const CAPVERSION_10 = [
	0x000a0002, 0x000a0100, 0x000a0200, 0x000a0301, 0x000a0400, 0x000a0502,
	0x000a0600, 0x000a0701,
];
const CAPVERSION_101 = 0x000a0100;
const CAPVERSION_107 = 0x000a0701;
const CAPS_FLAG_AVC420_ENABLED = 0x10;
const CAPS_FLAG_AVC_DISABLED = 0x20;
/** 版 10.7: MapSurfaceToScaledOutput / Window を送らせない(拡縮して写すことはしない) */
const CAPS_FLAG_SCALEDMAP_DISABLE = 0x80;

const PIXEL_FORMAT_ARGB = 0x21;

/** H.264 の復号がこれだけ続けて失敗したら、復号器が使えないとみなす(30fps で 2 秒ほど) */
const AVC_GIVE_UP = 60;

/** キャッシュの枠の数の上限(SMALL_CACHE を付けないとき) */
const MAX_CACHE_SLOTS = 25600;
const MAX_SURFACE_SIDE = 8192;
/** 面の数と、全部の面の画素数の合計の上限(4 バイト / 画素で 512MB) */
const MAX_SURFACES = 64;
const MAX_SURFACE_PIXELS = 1 << 27;
/** 画像キャッシュの合計の上限(4 バイト / 画素)。超えたら古いものから捨てる */
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

export type Rect = { left: number; top: number; right: number; bottom: number };

/** 面への描画。GFX の座標は面の左上から、right / bottom は含まない */
export interface GfxOps {
	/** 画面(出力)の大きさ。ResetGraphics で来る */
	resetOutput(width: number, height: number): void;
	createSurface(
		id: number,
		width: number,
		height: number,
		alpha: boolean,
	): void;
	deleteSurface(id: number): void;
	/** 面を画面のどこに写すか */
	mapSurface(id: number, x: number, y: number): void;
	/** RGBA(上の行から)を面に描く */
	putRgba(
		id: number,
		x: number,
		y: number,
		w: number,
		h: number,
		rgba: Uint8ClampedArray,
	): void;
	fill(id: number, rects: Rect[], rgba: [number, number, number, number]): void;
	copyRect(src: number, rect: Rect, dst: number, x: number, y: number): void;
	toCache(slot: number, id: number, rect: Rect): void;
	fromCache(slot: number, id: number, x: number, y: number): void;
	evict(slot: number): void;
	/** 面の矩形のアルファだけを置き換える(ALPHA コーデック) */
	setAlpha(id: number, rect: Rect, alpha: Uint8Array): void;
	/** 復号した H.264 の 1 枚(destRect の大きさ)のうち、regions(destRect からの相対)だけを面へ */
	drawVideo(id: number, frame: unknown, dest: Rect, regions: Rect[]): void;
	/** フレームの終わり: 変わったところを画面へ写す */
	present(): void;
}

/** H.264(Annex B)の復号。結果の 1 枚を返す(何も出なければ null)。使い終わった 1 枚は ops.drawVideo のあとで close する */
export interface AvcDecoder {
	decode(
		annexB: Uint8Array,
		key: boolean,
		width: number,
		height: number,
	): Promise<VideoFrameLike | null>;
	/**
	 * AVC444 用: 復号した 1 枚を YUV420 の 3 面で返す(何も出なければ null)。decode と同じ流れ(同じ復号器)で復号する。
	 * これがあるときだけ版 10 以上(AVC444 を使える)を宣言する
	 */
	decodeYuv?(
		annexB: Uint8Array,
		key: boolean,
		width: number,
		height: number,
	): Promise<Yuv420 | null>;
	close(): void;
}

export type VideoFrameLike = { close(): void };

/**
 * H.264 を使えるか(VideoDecoder が無い・H.264 を復号できないブラウザでは undefined)。
 * hardware は GPU で復号できるとき(待ち時間と CPU の負荷が小さい)
 */
export async function avcSupport(): Promise<{ hardware: boolean } | undefined> {
	const VD = (globalThis as { VideoDecoder?: typeof VideoDecoder })
		.VideoDecoder;
	if (!VD) return undefined;
	const supported = async (hardwareAcceleration: HardwareAcceleration) => {
		try {
			const r = await VD.isConfigSupported({
				codec: "avc1.42E01F",
				optimizeForLatency: true,
				hardwareAcceleration,
			});
			return r.supported === true;
		} catch {
			return false;
		}
	};
	if (await supported("prefer-hardware")) return { hardware: true };
	if (await supported("no-preference")) return { hardware: false };
	return undefined;
}

// ---- PDU ----

function header(cmd: number, body: Uint8Array): Uint8Array {
	return new Writer(body.length + 8)
		.u16(cmd)
		.u16(0)
		.u32(body.length + 8)
		.bytes(body)
		.done();
}

/**
 * CapsAdvertise(FreeRDP の rdpgfx_send_supported_caps と同じ組み合わせ): 版 8 と 8.1(avc420 なら AVC420_ENABLED)、
 * それに版 10.0 〜 10.7。版 10 以上は、AVC444 を使える(avc444)ときは何も付けず、H.264 を使わないときは AVC_DISABLED を付ける。
 * AVC420 だけ使えるときは版 10 以上を宣言しない(AVC444 で送られても困る)
 */
export function capsAdvertise(avc420: boolean, avc444 = false): Uint8Array {
	const sets: [number, number][] = [
		[CAPVERSION_8, 0],
		[CAPVERSION_81, avc420 ? CAPS_FLAG_AVC420_ENABLED : 0],
	];
	if (!avc420 || avc444) {
		const flags = avc444 ? 0 : CAPS_FLAG_AVC_DISABLED;
		for (const v of CAPVERSION_10)
			sets.push([
				v,
				v === CAPVERSION_107 ? flags | CAPS_FLAG_SCALEDMAP_DISABLE : flags,
			]);
	}
	const w = new Writer(160).u16(sets.length);
	for (const [v, flags] of sets) {
		if (v === CAPVERSION_101) w.u32(v).u32(16).zeros(16);
		else w.u32(v).u32(4).u32(flags);
	}
	return header(CMD.CAPSADVERTISE, w.done());
}

/** CapsConfirm: サーバーが選んだ版と flags */
export function parseCapsConfirm(body: Uint8Array): {
	version: number;
	flags: number;
} {
	const r = new Reader(body);
	const version = r.u32();
	const len = r.u32();
	return { version, flags: len >= 4 ? r.u32() : 0 };
}

/** 版の名前(0x000A0701 → "10.7") */
export function capsVersionName(version: number): string {
	return `${version >>> 16}.${(version >>> 8) & 0xff}`;
}

/**
 * Frame Acknowledge。queueDepth は、受け取ったがまだ描いていないフレームの数(0 は「分からない」)。
 * サーバーはこれを見て送る頻度を決めるので、端末が遅ければ送る量が減る
 */
export function frameAcknowledge(
	frameId: number,
	totalFramesDecoded: number,
	queueDepth = 0,
): Uint8Array {
	return header(
		CMD.FRAMEACKNOWLEDGE,
		new Writer(12).u32(queueDepth).u32(frameId).u32(totalFramesDecoded).done(),
	);
}

type GfxPdu = { cmd: number; body: Uint8Array };

/** Worker に先に頼んだ Progressive の復号 */
type Prefetched =
	| { tiles: ProgressiveTile[]; rgba: Uint8ClampedArray[] }
	| { error: unknown };

/** 伸長したデータに並ぶ PDU を切り出す */
export function splitPdus(data: Uint8Array): GfxPdu[] {
	const r = new Reader(data);
	const out: GfxPdu[] = [];
	while (r.left >= 8) {
		const cmd = r.u16();
		r.u16(); // flags
		const len = r.u32();
		if (len < 8 || len - 8 > r.left)
			throw new Error(`GFX: PDU の長さが不正 (${len})`);
		out.push({ cmd, body: r.bytes(len - 8) });
	}
	return out;
}

function readRect(r: Reader): Rect {
	return { left: r.u16(), top: r.u16(), right: r.u16(), bottom: r.u16() };
}

type Avc420 = {
	regions: Rect[];
	quality: { qp: number; quality: number }[];
	stream: Uint8Array;
};

/** RDPGFX_AVC420_BITMAP_STREAM: メタブロック(領域の矩形と品質)+ H.264 の Annex B */
export function parseAvc420(data: Uint8Array): Avc420 {
	const r = new Reader(data);
	const n = r.u32();
	if (n > 4096) throw new Error("AVC420: 領域が多すぎる");
	const regions: Rect[] = [];
	for (let i = 0; i < n; i++) regions.push(readRect(r));
	const quality: { qp: number; quality: number }[] = [];
	for (let i = 0; i < n; i++) {
		const qp = r.u8();
		quality.push({ qp: qp & 0x3f, quality: r.u8() });
	}
	return { regions, quality, stream: r.rest() };
}

type Avc444 = { luma?: Avc420; chroma?: Avc420 };

/**
 * RDPGFX_AVC444_BITMAP_STREAM(AVC444v2 も同じ形): 先頭の u32 の下 30 ビットが 1 つ目の AVC420(メタブロックを含む)の長さ、
 * 上 2 ビット(LC)が中身。0 = 1 つ目が主の絵・2 つ目が補助の絵、1 = 主の絵だけ、2 = 補助の絵だけ(どちらも 1 つ目に)
 */
export function parseAvc444(data: Uint8Array): Avc444 {
	const r = new Reader(data);
	const info = r.u32();
	const lc = info >>> 30;
	switch (lc) {
		case 0: {
			const luma = parseAvc420(r.bytes(info & 0x3fffffff));
			return { luma, chroma: parseAvc420(r.rest()) };
		}
		case 1:
			return { luma: parseAvc420(r.rest()) };
		case 2:
			return { chroma: parseAvc420(r.rest()) };
		default:
			throw new Error("AVC444: LC が不正");
	}
}

/** Annex B の NAL を順に(開始符号 00 00 01 / 00 00 00 01 の後ろ) */
function* nalUnits(stream: Uint8Array): Generator<Uint8Array> {
	let i = 0;
	let start = -1;
	while (i + 2 < stream.length) {
		if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
			if (start >= 0) {
				let end = i;
				if (end > start && stream[end - 1] === 0) end--;
				yield stream.subarray(start, end);
			}
			i += 3;
			start = i;
		} else i++;
	}
	if (start >= 0 && start < stream.length) yield stream.subarray(start);
}

/** SPS から WebCodecs の codec 文字列(avc1.PPCCLL)を作る。SPS が無ければ undefined */
export function codecString(stream: Uint8Array): string | undefined {
	for (const nal of nalUnits(stream)) {
		if (((nal[0] as number) & 0x1f) === 7 && nal.length >= 4) {
			const hex2 = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
			return `avc1.${hex2(nal[1] as number)}${hex2(nal[2] as number)}${hex2(nal[3] as number)}`;
		}
	}
	return undefined;
}

/** IDR(NAL の種類 5)を含むか */
export function isKeyFrame(stream: Uint8Array): boolean {
	for (const nal of nalUnits(stream))
		if (((nal[0] as number) & 0x1f) === 5) return true;
	return false;
}

// ---- 受ける側 ----

/** GFX のチャネルの受け手。PDU を順に処理し(H.264 の復号を待つあいだも順序を保つ)、フレームの終わりで応答する */
export class GfxClient implements DynamicHandler {
	private zgfx = new Zgfx();
	private clear = new ClearDecoder();
	private progressive = new ProgressiveDecoder();
	private channel?: DynamicChannel;
	/** 処理の順序を保つ鎖(H.264 の復号は非同期) */
	private chain: Promise<void> = Promise.resolve();
	private surfaces = new Map<
		number,
		{ width: number; height: number; alpha: boolean }
	>();
	/** キャッシュの番号 → 大きさ(バイト)。入れた順(古いものから捨てる) */
	private cacheSlots = new Map<number, number>();
	private cacheBytes = 0;
	private surfacePixels = 0;
	/** ZGFX の伸長に失敗した。履歴が壊れたので、以後の絵は正しくならない */
	private broken = false;
	private totalFrames = 0;
	/** 受け取って、まだ描き終えていないフレーム(EndFrame)の数 */
	private queuedFrames = 0;
	/** いま描いているフレームの、サーバーの時刻(StartFrame) */
	private frameTimestamp?: number;
	/** フレームが作られてから描き終えるまでの遅れのうち、溜まった分(回線・端末の混み具合) */
	readonly latency = new FrameLatency();
	/** H.264 の復号が続けて失敗した数(1 枚でも出れば 0 に戻す) */
	private avcFailures = 0;
	/** AVC444 の YUV444(面ごと。主の絵と補助の絵が別々に来るので前のものを持つ) */
	private yuv444 = new Map<number, Yuv444>();
	/** サーバーが選んだ能力の版と flags(CapsConfirm) */
	confirmed?: { version: number; flags: number };
	/** 診断用 */
	readonly stats = {
		frames: 0,
		avc: 0,
		avc444: 0,
		/** AVC444 の復号を待った時間と、YUV444 を組み立てて RGBA にした時間の合計(ms) */
		avc444DecodeMs: 0,
		avc444ConvertMs: 0,
		/** ClearCodec・Progressive・Planar の復号にかかった時間の合計(ms。メインスレッド) */
		clearMs: 0,
		progressiveMs: 0,
		planarMs: 0,
		clear: 0,
		planar: 0,
		uncompressed: 0,
		rfx: 0,
		progressive: 0,
		skipped: 0,
		solidFill: 0,
		surfaceToSurface: 0,
		toCache: 0,
		fromCache: 0,
		cacheMiss: 0,
	};

	/** ClearCodec で描けなかった部分(NSCodec など)の数(診断用) */
	get clearUnsupported(): number {
		return this.clear.unsupported;
	}
	/** PDU 1 つの失敗(そのフレームの一部を飛ばして続ける) */
	onError?: (e: unknown) => void;
	/** 回復できない失敗(ZGFX の履歴が壊れた)。以後のデータは捨てる。つなぎ直すしかない */
	onFatal?: (e: unknown) => void;
	/** H.264 の復号が続けて失敗した(復号器が使えない)。H.264 なしでつなぎ直すとよい。1 度だけ呼ぶ */
	onAvcBroken?: () => void;

	/** Progressive のタイルを復号する Worker(無ければ、その場で復号する) */
	private pool?: TilePool;

	/** avc を渡したときだけ H.264 を使えると伝える。pool を渡すと、Progressive は Worker で並列に復号する */
	constructor(
		private ops: GfxOps,
		private avc?: AvcDecoder,
		pool?: TilePool,
	) {
		if (pool?.async) this.pool = pool;
	}

	/** サーバーが GFX のチャネルを開いた(開かなければ旧来の描画のまま) */
	get active(): boolean {
		return this.channel !== undefined;
	}

	/** 受け取って、まだ描き終えていないフレームの数 */
	get backlog(): number {
		return this.queuedFrames;
	}

	/** H.264 を使えると伝えたか */
	get avcEnabled(): boolean {
		return this.avc !== undefined;
	}

	/** AVC444 も使えると伝えたか(版 10 以上) */
	get avc444Enabled(): boolean {
		return this.avc?.decodeYuv !== undefined;
	}

	/** サーバーが選んだ版(診断用。例 "10.7 flags=0x80") */
	get confirmedVersion(): string | undefined {
		const c = this.confirmed;
		return c && `${capsVersionName(c.version)} flags=0x${c.flags.toString(16)}`;
	}

	onOpen(channel: DynamicChannel): void {
		this.channel = channel;
		channel.send(capsAdvertise(this.avcEnabled, this.avc444Enabled));
	}

	onClose(): void {
		this.channel = undefined;
		this.avc?.close();
	}

	onData(data: Uint8Array): void {
		if (this.broken) return;
		let pdus: GfxPdu[];
		try {
			pdus = splitPdus(this.zgfx.decompress(data));
		} catch (e) {
			// 伸長の途中で失敗すると、履歴が中途半端なまま残り、以後の一致がずれる
			this.broken = true;
			this.stats.skipped++;
			(this.onFatal ?? this.onError)?.(e);
			return;
		}
		for (const p of pdus) {
			if (p.cmd === CMD.ENDFRAME) this.queuedFrames++;
			// Progressive は届いた順にすぐ Worker へ渡す(前のフレームを描いている間に復号が進む)。描くのは順番どおり
			const pre = this.pool && this.prefetch(this.pool, p);
			this.chain = this.chain
				.then(() => this.handle(p, pre))
				.catch((e) => {
					this.stats.skipped++;
					this.onError?.(e);
				});
		}
	}

	/** 溜まっている処理が終わるまで待つ(試験用) */
	idle(): Promise<void> {
		return this.chain;
	}

	/**
	 * Worker で復号するものを先に頼む。面を作る・消すときは、タイルの状態を捨てるよう全部の Worker へ(後のタイルより先に届く)。
	 * 面の大きさはまだ分からない(CreateSurface を処理する前のこともある)ので、面で切るのは描くとき
	 */
	private prefetch(pool: TilePool, p: GfxPdu): Promise<Prefetched> | undefined {
		const r = new Reader(p.body);
		if (p.cmd === CMD.CREATESURFACE || p.cmd === CMD.DELETESURFACE) {
			const surface = r.u16();
			for (let i = 0; i < pool.lanes; i++)
				void pool
					.runOn(i, { kind: "progressiveReset", surface })
					.catch(() => {});
			return undefined;
		}
		if (p.cmd !== CMD.WIRETOSURFACE_2) return undefined;
		try {
			const surface = r.u16();
			if (r.u16() !== CODEC.CAPROGRESSIVE) return undefined;
			r.u32(); // codecContextId
			r.u8(); // pixelFormat
			const tiles = parseProgressive(
				surface,
				r.bytes(r.u32()),
				MAX_SURFACE_SIDE,
				MAX_SURFACE_SIDE,
			);
			return Promise.all(
				tiles.map((t) =>
					pool.runOn((t.x + t.y) / 64, { kind: "progressive", tile: t.job }),
				),
			).then(
				(rgba) => ({ tiles, rgba }),
				(error: unknown) => ({ error }),
			);
		} catch (error) {
			return Promise.resolve({ error });
		}
	}

	private async handle(p: GfxPdu, pre?: Promise<Prefetched>): Promise<void> {
		const r = new Reader(p.body);
		switch (p.cmd) {
			case CMD.CAPSCONFIRM:
				this.confirmed = parseCapsConfirm(p.body);
				break;
			case CMD.DELETEENCODINGCONTEXT: // Progressive の文脈。タイルの状態は面ごとに持つので使わない(FreeRDP と同じ)
				break;
			case CMD.RESETGRAPHICS: {
				const width = r.u32();
				const height = r.u32();
				if (width > MAX_SURFACE_SIDE || height > MAX_SURFACE_SIDE)
					throw new Error("GFX: 画面が大きすぎる");
				this.ops.resetOutput(width, height);
				break;
			}
			case CMD.CREATESURFACE: {
				const id = r.u16();
				const width = r.u16();
				const height = r.u16();
				const format = r.u8();
				if (width > MAX_SURFACE_SIDE || height > MAX_SURFACE_SIDE)
					throw new Error("GFX: 面が大きすぎる");
				const alpha = format === PIXEL_FORMAT_ARGB;
				const old = this.surfaces.get(id);
				const pixels = this.surfacePixels - (old ? old.width * old.height : 0);
				if (
					(!old && this.surfaces.size >= MAX_SURFACES) ||
					pixels + width * height > MAX_SURFACE_PIXELS
				) {
					// 作らない。この面を指すコマンドは「無い面」で飛ばされる
					this.stats.skipped++;
					break;
				}
				this.surfacePixels = pixels + width * height;
				this.surfaces.set(id, { width, height, alpha });
				this.progressive.deleteSurface(id);
				this.yuv444.delete(id);
				this.ops.createSurface(id, width, height, alpha);
				break;
			}
			case CMD.DELETESURFACE: {
				const id = r.u16();
				const old = this.surfaces.get(id);
				if (old) this.surfacePixels -= old.width * old.height;
				this.surfaces.delete(id);
				this.progressive.deleteSurface(id);
				this.yuv444.delete(id);
				this.ops.deleteSurface(id);
				break;
			}
			case CMD.MAPSURFACETOOUTPUT: {
				const id = r.u16();
				r.u16();
				this.ops.mapSurface(id, r.u32(), r.u32());
				break;
			}
			case CMD.MAPSURFACETOSCALEDOUTPUT: {
				// 版 10.7 は SCALEDMAP_DISABLE で断っている(10.7 より前の版でも拡縮は使われないはず)。来たら等倍で写す
				const id = r.u16();
				r.u16();
				this.ops.mapSurface(id, r.u32(), r.u32());
				break;
			}
			case CMD.STARTFRAME:
				this.frameTimestamp = r.u32();
				break;
			case CMD.ENDFRAME: {
				// 先に数を戻す(下で例外になっても、溜まった数がずれないように)
				this.queuedFrames = Math.max(0, this.queuedFrames - 1);
				const frameId = r.u32();
				this.ops.present();
				// 遅れは「描き終えた」時刻で測る。画面へ写すのは描画の周期の終わりになることがあるが、その差(1 周期まで)は溜まった遅れには効かない
				if (this.frameTimestamp !== undefined)
					this.latency.add(
						gfxTimestampMs(this.frameTimestamp),
						Date.now(),
						performance.now(),
					);
				this.frameTimestamp = undefined;
				this.totalFrames++;
				this.stats.frames++;
				this.channel?.send(
					frameAcknowledge(frameId, this.totalFrames, this.queuedFrames),
				);
				break;
			}
			case CMD.SOLIDFILL: {
				const id = r.u16();
				const b = r.u8();
				const g = r.u8();
				const red = r.u8();
				r.u8(); // XA
				const n = r.u16();
				const rects: Rect[] = [];
				for (let i = 0; i < n; i++) rects.push(readRect(r));
				this.stats.solidFill++;
				this.ops.fill(id, rects, [red, g, b, 255]);
				break;
			}
			case CMD.SURFACETOSURFACE: {
				const src = r.u16();
				const dst = r.u16();
				const rect = readRect(r);
				const n = r.u16();
				this.stats.surfaceToSurface++;
				for (let i = 0; i < n; i++)
					this.ops.copyRect(src, rect, dst, r.u16(), r.u16());
				break;
			}
			case CMD.SURFACETOCACHE: {
				const id = r.u16();
				r.skip(8); // cacheKey
				const slot = r.u16();
				if (slot >= MAX_CACHE_SLOTS)
					throw new Error("GFX: キャッシュの番号が不正");
				const rect = readRect(r);
				const bytes =
					Math.max(0, rect.right - rect.left) *
					Math.max(0, rect.bottom - rect.top) *
					4;
				this.forgetCache(slot);
				// 合計の上限を超えるなら、古いものから捨てる(後で指されたら、その描画は飛ばす)
				for (const [old] of this.cacheSlots) {
					if (this.cacheBytes + bytes <= MAX_CACHE_BYTES) break;
					this.forgetCache(old);
					this.ops.evict(old);
				}
				this.cacheSlots.set(slot, bytes);
				this.cacheBytes += bytes;
				this.stats.toCache++;
				this.ops.toCache(slot, id, rect);
				break;
			}
			case CMD.CACHETOSURFACE: {
				const slot = r.u16();
				const id = r.u16();
				const n = r.u16();
				if (!this.cacheSlots.has(slot)) {
					// 上限で捨てたもの(またはサーバーの誤り)。その描画だけ飛ばす
					this.stats.cacheMiss++;
					break;
				}
				this.stats.fromCache++;
				for (let i = 0; i < n; i++)
					this.ops.fromCache(slot, id, r.u16(), r.u16());
				break;
			}
			case CMD.EVICTCACHEENTRY: {
				const slot = r.u16();
				this.forgetCache(slot);
				this.ops.evict(slot);
				break;
			}
			case CMD.CACHEIMPORTREPLY:
				break; // キャッシュの持ち込みは申し出ていない
			case CMD.WIRETOSURFACE_1:
				await this.wireToSurface(r);
				break;
			case CMD.WIRETOSURFACE_2:
				await this.wireToSurface2(r, pre);
				break;
		}
	}

	private forgetCache(slot: number): void {
		const b = this.cacheSlots.get(slot);
		if (b === undefined) return;
		this.cacheBytes -= b;
		this.cacheSlots.delete(slot);
	}

	/** WireToSurface2: 宣言しなくても、版 8 以上の Windows は Progressive で送ってくる(写真・新しく見えた部分など) */
	private async wireToSurface2(
		r: Reader,
		pre?: Promise<Prefetched>,
	): Promise<void> {
		const id = r.u16();
		const codec = r.u16();
		r.u32(); // codecContextId
		r.u8(); // pixelFormat
		const data = r.bytes(r.u32());
		const surface = this.surfaces.get(id);
		if (!surface) throw new Error(`GFX: 無い面 ${id}`);
		if (codec !== CODEC.CAPROGRESSIVE) {
			this.stats.skipped++;
			return;
		}
		this.stats.progressive++;
		// progressiveMs: その場で復号するときは復号の時間、Worker のときは描く順番が来てから待った時間
		const t0 = performance.now();
		const parts: ProgressivePart[] = [];
		if (pre) {
			const done = await pre;
			if ("error" in done) throw done.error;
			for (const [i, t] of done.tiles.entries())
				parts.push(
					...clipTile(
						t,
						done.rgba[i] as Uint8ClampedArray,
						surface.width,
						surface.height,
					),
				);
		} else
			parts.push(
				...this.progressive.decode(id, data, surface.width, surface.height),
			);
		this.stats.progressiveMs += performance.now() - t0;
		for (const p of parts) this.ops.putRgba(id, p.x, p.y, p.w, p.h, p.rgba);
	}

	private async wireToSurface(r: Reader): Promise<void> {
		const id = r.u16();
		const codec = r.u16();
		const format = r.u8();
		const dest = readRect(r);
		const len = r.u32();
		const data = r.bytes(len);
		const w = dest.right - dest.left;
		const h = dest.bottom - dest.top;
		if (w <= 0 || h <= 0) return;
		if (!this.surfaces.has(id)) throw new Error(`GFX: 無い面 ${id}`);
		switch (codec) {
			case CODEC.UNCOMPRESSED: {
				if (data.length < w * h * 4) throw new Error("GFX: 生の画素が短い");
				const rgba = new Uint8ClampedArray(w * h * 4);
				const argb = format === PIXEL_FORMAT_ARGB;
				for (let i = 0; i < w * h; i++) {
					rgba[i * 4] = data[i * 4 + 2] as number;
					rgba[i * 4 + 1] = data[i * 4 + 1] as number;
					rgba[i * 4 + 2] = data[i * 4] as number;
					rgba[i * 4 + 3] = argb ? (data[i * 4 + 3] as number) : 255;
				}
				this.stats.uncompressed++;
				this.ops.putRgba(id, dest.left, dest.top, w, h, rgba);
				break;
			}
			case CODEC.PLANAR: {
				// GFX の Planar は上の行から(旧ビットマップは下から)
				this.stats.planar++;
				const t0 = performance.now();
				const rgba = decodePlanar(data, w, h, true);
				this.stats.planarMs += performance.now() - t0;
				this.ops.putRgba(id, dest.left, dest.top, w, h, rgba);
				break;
			}
			case CODEC.CLEARCODEC: {
				this.stats.clear++;
				const t0 = performance.now();
				const rgba = this.clear.decode(data, w, h);
				this.stats.clearMs += performance.now() - t0;
				this.ops.putRgba(id, dest.left, dest.top, w, h, rgba);
				break;
			}
			case CODEC.CAVIDEO: {
				// RemoteFX: タイルの位置と領域は destRect からの相対
				this.stats.rfx++;
				for (const t of decodeStream(data)) {
					const rects = t.rects.length ? t.rects : [{ x: 0, y: 0, w, h }];
					for (const rc of rects) {
						const x0 = Math.max(t.x, rc.x);
						const y0 = Math.max(t.y, rc.y);
						const x1 = Math.min(t.x + 64, rc.x + rc.w, w);
						const y1 = Math.min(t.y + 64, rc.y + rc.h, h);
						if (x1 <= x0 || y1 <= y0) continue;
						const cw = x1 - x0;
						const ch = y1 - y0;
						const part = new Uint8ClampedArray(cw * ch * 4);
						for (let y = 0; y < ch; y++) {
							const s = ((y0 - t.y + y) * 64 + (x0 - t.x)) * 4;
							part.set(t.rgba.subarray(s, s + cw * 4), y * cw * 4);
						}
						this.ops.putRgba(id, dest.left + x0, dest.top + y0, cw, ch, part);
					}
				}
				break;
			}
			case CODEC.AVC420: {
				if (!this.avc) throw new Error("GFX: H.264 の復号器が無い");
				const m = parseAvc420(data);
				this.stats.avc++;
				const frame = await this.avc.decode(
					m.stream,
					isKeyFrame(m.stream),
					w,
					h,
				);
				if (!frame) {
					this.stats.skipped++;
					// 鍵フレームを待つ間も null なので、すぐには諦めない
					if (++this.avcFailures === AVC_GIVE_UP) this.onAvcBroken?.();
					break;
				}
				this.avcFailures = 0;
				try {
					this.ops.drawVideo(id, frame, dest, m.regions);
				} finally {
					frame.close();
				}
				break;
			}
			case CODEC.AVC444:
			case CODEC.AVC444V2:
				await this.avc444(id, codec === CODEC.AVC444V2, dest, data);
				break;
			case CODEC.ALPHA:
				this.ops.setAlpha(id, dest, alphaCodec(data, w, h));
				break;
			default:
				this.stats.skipped++;
		}
	}

	/**
	 * AVC444 / AVC444v2: 主の絵と補助の絵を同じ復号器で順に復号し(1 本の H.264 の流れ。FreeRDP と同じ)、面ごとの YUV444 に重ねて描く。
	 * 片方だけ来たときは、もう片方は前のものを使う
	 */
	private async avc444(
		id: number,
		v2: boolean,
		dest: Rect,
		data: Uint8Array,
	): Promise<void> {
		const decodeYuv = this.avc?.decodeYuv?.bind(this.avc);
		if (!decodeYuv) throw new Error("GFX: AVC444 の復号器が無い");
		const w = dest.right - dest.left;
		const h = dest.bottom - dest.top;
		const m = parseAvc444(data);
		this.stats.avc444++;
		let st = this.yuv444.get(id);
		if (!st || st.width !== w || st.height !== h) {
			st = new Yuv444(w, h);
			this.yuv444.set(id, st);
		}
		// 片方が出なくても、もう片方は復号器に渡す(参照の鎖を切らない)
		const t0 = performance.now();
		// 2 つとも先に復号器へ渡してから待つ(1 つ目の出力を待ってから 2 つ目を渡すと、その分だけ遅れる)。渡す順は主・副のまま
		const lumaP =
			m.luma && decodeYuv(m.luma.stream, isKeyFrame(m.luma.stream), w, h);
		const chromaP =
			m.chroma && decodeYuv(m.chroma.stream, isKeyFrame(m.chroma.stream), w, h);
		const luma = lumaP && (await lumaP);
		const chroma = chromaP && (await chromaP);
		const t1 = performance.now();
		this.stats.avc444DecodeMs += Math.round(t1 - t0);
		const drawn: Rect[] = [];
		if (m.luma && luma) {
			const rects = clampRects(m.luma.regions, w, h);
			st.luma(luma, rects);
			drawn.push(...rects);
		}
		if (m.chroma && chroma) {
			const rects = clampRects(m.chroma.regions, w, h);
			if (st.chroma(chroma, v2, rects)) drawn.push(...rects);
		}
		if ((m.luma && !luma) || (m.chroma && !chroma)) {
			this.stats.skipped++;
			// 鍵フレームを待つ間も null なので、すぐには諦めない
			if (++this.avcFailures === AVC_GIVE_UP) this.onAvcBroken?.();
		} else this.avcFailures = 0;
		const seen = new Set<string>();
		for (const r of drawn) {
			const key = `${r.left},${r.top},${r.right},${r.bottom}`;
			if (seen.has(key)) continue;
			seen.add(key);
			this.ops.putRgba(
				id,
				dest.left + r.left,
				dest.top + r.top,
				r.right - r.left,
				r.bottom - r.top,
				st.rgba(r),
			);
		}
		this.stats.avc444ConvertMs += Math.round(performance.now() - t1);
	}
}

/** ALPHA コーデック([MS-RDPEGFX] 2.2.4.3): 署名 "AL"、圧縮の有無、生または (値, 長さ) の並び */
export function alphaCodec(data: Uint8Array, w: number, h: number): Uint8Array {
	const r = new Reader(data);
	if (r.u16() !== 0x414c) throw new Error("ALPHA: 署名が違う");
	const compressed = r.u16();
	const out = new Uint8Array(w * h);
	if (!compressed) {
		out.set(r.bytes(w * h));
		return out;
	}
	let p = 0;
	while (p < out.length) {
		const v = r.u8();
		let n = r.u8();
		if (n === 0xff) {
			n = r.u16();
			if (n === 0xffff) n = r.u32();
		}
		if (p + n > out.length) throw new Error("ALPHA: あふれた");
		out.fill(v, p, p + n);
		p += n;
	}
	return out;
}
