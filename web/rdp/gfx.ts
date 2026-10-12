// Graphics Pipeline([MS-RDPEGFX]、動的チャネル Microsoft::Windows::RDS::Graphics)。
// サーバーが面(surface)を作り、コーデック(H.264 の AVC420、ClearCodec、Planar、RemoteFX Progressive、生)で描き、面を画面へ写す。
// サーバーからの PDU は ZGFX で包まれて来る。こちらからの PDU(Caps・Frame Acknowledge)は包まない。
// 描画は GfxOps(ブラウザでは canvas、試験では偽物)に任せ、H.264 の復号は AvcDecoder(ブラウザでは VideoDecoder)に任せる。

import { decodePlanar } from "./bitmap";
import { Reader, Writer } from "./bytes";
import { ClearDecoder } from "./clearcodec";
import type { DynamicChannel, DynamicHandler } from "./dvc";
import { ProgressiveDecoder } from "./progressive";
import { decodeStream } from "./rfx";
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

/** 版 8.1 で AVC420 を使う。版 10 以上は AVC444 も使えることになるので宣言しない */
const CAPVERSION_8 = 0x00080004;
const CAPVERSION_81 = 0x00080105;
const CAPS_FLAG_AVC420_ENABLED = 0x10;

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
	close(): void;
}

export type VideoFrameLike = { close(): void };

/** H.264 を使えるか(VideoDecoder が無い・H.264 を復号できないブラウザでは使わない) */
export async function avcSupported(): Promise<boolean> {
	const VD = (globalThis as { VideoDecoder?: typeof VideoDecoder })
		.VideoDecoder;
	if (!VD) return false;
	try {
		const r = await VD.isConfigSupported({
			codec: "avc1.42E01F",
			optimizeForLatency: true,
		});
		return r.supported === true;
	} catch {
		return false;
	}
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

/** CapsAdvertise: 版 8.1 と版 8。avc なら版 8.1 で AVC420 を使えると伝える(H.264 を復号できないときは伝えない) */
export function capsAdvertise(avc: boolean): Uint8Array {
	const w = new Writer(32).u16(2);
	w.u32(CAPVERSION_81)
		.u32(4)
		.u32(avc ? CAPS_FLAG_AVC420_ENABLED : 0);
	w.u32(CAPVERSION_8).u32(4).u32(0);
	return header(CMD.CAPSADVERTISE, w.done());
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
	/** H.264 の復号が続けて失敗した数(1 枚でも出れば 0 に戻す) */
	private avcFailures = 0;
	/** 診断用 */
	readonly stats = {
		frames: 0,
		avc: 0,
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

	/** avc を渡したときだけ H.264 を使えると伝える */
	constructor(
		private ops: GfxOps,
		private avc?: AvcDecoder,
	) {}

	/** サーバーが GFX のチャネルを開いた(開かなければ旧来の描画のまま) */
	get active(): boolean {
		return this.channel !== undefined;
	}

	/** H.264 を使えると伝えたか */
	get avcEnabled(): boolean {
		return this.avc !== undefined;
	}

	onOpen(channel: DynamicChannel): void {
		this.channel = channel;
		channel.send(capsAdvertise(this.avc !== undefined));
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
			this.chain = this.chain
				.then(() => this.handle(p))
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

	private async handle(p: GfxPdu): Promise<void> {
		const r = new Reader(p.body);
		switch (p.cmd) {
			case CMD.CAPSCONFIRM:
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
				this.ops.createSurface(id, width, height, alpha);
				break;
			}
			case CMD.DELETESURFACE: {
				const id = r.u16();
				const old = this.surfaces.get(id);
				if (old) this.surfacePixels -= old.width * old.height;
				this.surfaces.delete(id);
				this.progressive.deleteSurface(id);
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
				// 拡縮は宣言していないので来ないはず。来たら等倍で写す
				const id = r.u16();
				r.u16();
				this.ops.mapSurface(id, r.u32(), r.u32());
				break;
			}
			case CMD.STARTFRAME:
				break;
			case CMD.ENDFRAME: {
				// 先に数を戻す(下で例外になっても、溜まった数がずれないように)
				this.queuedFrames = Math.max(0, this.queuedFrames - 1);
				const frameId = r.u32();
				this.ops.present();
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
				this.wireToSurface2(r);
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
	private wireToSurface2(r: Reader): void {
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
		for (const p of this.progressive.decode(
			id,
			data,
			surface.width,
			surface.height,
		))
			this.ops.putRgba(id, p.x, p.y, p.w, p.h, p.rgba);
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
			case CODEC.PLANAR:
				// GFX の Planar は上の行から(旧ビットマップは下から)
				this.stats.planar++;
				this.ops.putRgba(
					id,
					dest.left,
					dest.top,
					w,
					h,
					decodePlanar(data, w, h, true),
				);
				break;
			case CODEC.CLEARCODEC:
				this.stats.clear++;
				this.ops.putRgba(
					id,
					dest.left,
					dest.top,
					w,
					h,
					this.clear.decode(data, w, h),
				);
				break;
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
			case CODEC.ALPHA:
				this.ops.setAlpha(id, dest, alphaCodec(data, w, h));
				break;
			default:
				// AVC444 は宣言していないので来ないはず
				this.stats.skipped++;
		}
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
