// Surface Commands([MS-RDPBCGR] 2.2.9.2)。Fast-Path の SURFCMDS の更新に、複数のコマンドが並ぶ:
// Set Surface Bits / Stream Surface Bits(コーデックで符号化されたビットマップ)と Frame Marker。

import { Reader } from "./bytes";
import { decodeStream, type Rect } from "./rfx";

const CMD_SET_SURFACE_BITS = 0x0001;
const CMD_FRAME_MARKER = 0x0004;
const CMD_STREAM_SURFACE_BITS = 0x0006;

const EX_COMPRESSED_BITMAP_HEADER_PRESENT = 0x01;

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

export type SurfaceEvents = {
	draw: SurfaceDraw;
	/** Frame Marker(0 = 始まり、1 = 終わり) */
	frame?(action: number, frameId: number): void;
};

/**
 * Surface Commands の列を処理する。画面の大きさ(width x height)の外は描かない。
 * rfxCodecId は、サーバーと決めた RemoteFX の codecId
 */
export function handleSurfaceCommands(
	data: Uint8Array,
	rfxCodecId: number,
	screen: { width: number; height: number },
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
				r.u8(); // bpp
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
					drawRfx(bits, left, top, right, bottom, screen, ev.draw);
				} else if (codecId === CODEC_NONE) {
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

function drawRfx(
	bits: Uint8Array,
	left: number,
	top: number,
	right: number,
	bottom: number,
	screen: { width: number; height: number },
	draw: SurfaceDraw,
): void {
	const area = intersect(
		{
			x: left,
			y: top,
			w: Math.max(0, right - left),
			h: Math.max(0, bottom - top),
		},
		{ x: 0, y: 0, w: screen.width, h: screen.height },
	);
	for (const t of decodeStream(bits)) {
		// Region の矩形(コマンドの左上からの位置)ごとに、タイルとの共通部分だけを描く
		const tile: Rect = { x: t.x, y: t.y, w: 64, h: 64 };
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
				crop(t.rgba, 64, {
					x: abs.x - left - t.x,
					y: abs.y - top - t.y,
					w: abs.w,
					h: abs.h,
				}),
			);
		}
	}
}

/** コーデックなし: 32 ビットの BGRA(上の行から)。大きさを超える分は切る */
function drawRaw(
	bits: Uint8Array,
	left: number,
	top: number,
	width: number,
	height: number,
	screen: { width: number; height: number },
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
