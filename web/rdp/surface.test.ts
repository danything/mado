// Surface Commands の試験: コマンドの切り出し、RemoteFX の矩形の切り取り、生のビットマップ、不正な入力。

import { describe, expect, test } from "bun:test";
import { concat, Writer } from "./bytes";
import { REAL_TILE, rfxStream, rlgrEncode } from "./rfx.fixture";
import {
	handleSurfaceCommands,
	parseRfxTiles,
	type SurfaceDraw,
	SurfaceRenderer,
} from "./surface";

const RFX_ID = 3;

function setBits(
	cmd: number,
	dest: [number, number, number, number],
	codecId: number,
	width: number,
	height: number,
	data: Uint8Array,
	flags = 0,
): Uint8Array {
	const w = new Writer(32 + data.length)
		.u16(cmd)
		.u16(dest[0])
		.u16(dest[1])
		.u16(dest[2])
		.u16(dest[3])
		.u8(32)
		.u8(flags)
		.u8(0)
		.u8(codecId)
		.u16(width)
		.u16(height)
		.u32(data.length);
	if (flags & 1) w.zeros(16);
	return w.bytes(data).done();
}

const frameMarker = (action: number, id: number) =>
	new Writer(8).u16(4).u16(action).u32(id).done();

function run(data: Uint8Array, screen = { width: 1280, height: 720 }) {
	const draws: string[] = [];
	const frames: string[] = [];
	const draw: SurfaceDraw = (x, y, w, h, rgba) => {
		expect(rgba.length).toBe(w * h * 4);
		draws.push(`${x},${y} ${w}x${h}`);
	};
	handleSurfaceCommands(data, RFX_ID, screen, {
		draw,
		frame: (a, id) => frames.push(`${a}:${id}`),
	});
	return { draws, frames };
}

const tile = (x: number, y: number) => ({
	x,
	y,
	y_: REAL_TILE.y,
	cb: REAL_TILE.cb,
	cr: REAL_TILE.cr,
});

describe("Surface Commands", () => {
	test("Frame Marker と RemoteFX を 1 つの更新にまとめて受ける", () => {
		const rfx = rfxStream(
			[{ x: 0, y: 0, w: 128, h: 64 }],
			[tile(0, 0), tile(64, 0)],
		);
		const { draws, frames } = run(
			concat(
				frameMarker(0, 7),
				setBits(0x0006, [100, 200, 228, 264], RFX_ID, 128, 64, rfx),
				frameMarker(1, 7),
			),
		);
		expect(frames).toEqual(["0:7", "1:7"]);
		// 矩形はコマンドの左上(100, 200)からの位置
		expect(draws).toEqual(["100,200 64x64", "164,200 64x64"]);
	});

	test("Region の矩形でタイルを切る(タイルのうち矩形の内側だけを描く)", () => {
		const rfx = rfxStream([{ x: 10, y: 20, w: 30, h: 8 }], [tile(0, 0)]);
		const { draws } = run(setBits(0x0001, [0, 0, 64, 64], RFX_ID, 64, 64, rfx));
		expect(draws).toEqual(["10,20 30x8"]);
	});

	test("複数の矩形に分かれた Region", () => {
		const rfx = rfxStream(
			[
				{ x: 0, y: 0, w: 4, h: 4 },
				{ x: 60, y: 60, w: 4, h: 4 },
			],
			[tile(0, 0)],
		);
		const { draws } = run(setBits(0x0001, [0, 0, 64, 64], RFX_ID, 64, 64, rfx));
		expect(draws).toEqual(["0,0 4x4", "60,60 4x4"]);
	});

	test("画面の外は描かない", () => {
		const rfx = rfxStream([{ x: 0, y: 0, w: 64, h: 64 }], [tile(0, 0)]);
		const { draws } = run(
			setBits(0x0001, [1260, 700, 1324, 764], RFX_ID, 64, 64, rfx),
			{ width: 1280, height: 720 },
		);
		expect(draws).toEqual(["1260,700 20x20"]);
	});

	test("拡張ヘッダー(16 バイト)つきのビットマップ", () => {
		const rfx = rfxStream([{ x: 0, y: 0, w: 64, h: 64 }], [tile(0, 0)]);
		const { draws } = run(
			setBits(0x0001, [0, 0, 64, 64], RFX_ID, 64, 64, rfx, 1),
		);
		expect(draws).toEqual(["0,0 64x64"]);
	});

	test("コーデックなし(codecId 0)の生の BGRA", () => {
		const bgra = Uint8Array.of(1, 2, 3, 0, 4, 5, 6, 0); // 2 x 1
		let got: Uint8ClampedArray | undefined;
		handleSurfaceCommands(
			setBits(0x0006, [10, 10, 12, 11], 0, 2, 1, bgra),
			RFX_ID,
			{ width: 100, height: 100 },
			{ draw: (_x, _y, _w, _h, rgba) => (got = rgba) },
		);
		expect([...(got ?? [])]).toEqual([3, 2, 1, 255, 6, 5, 4, 255]);
	});

	test("知らないコーデックは描かずに読み飛ばす", () => {
		const { draws, frames } = run(
			concat(
				setBits(0x0001, [0, 0, 8, 8], 9, 8, 8, new Uint8Array(10)),
				frameMarker(1, 1),
			),
		);
		expect(draws).toEqual([]);
		expect(frames).toEqual(["1:1"]);
	});

	test("不正な長さ・知らないコマンド・短い生ビットマップは例外", () => {
		const good = setBits(0x0001, [0, 0, 8, 8], RFX_ID, 8, 8, new Uint8Array(4));
		expect(() => run(good.slice(0, good.length - 1))).toThrow("長さ");
		expect(() => run(Uint8Array.of(0x99, 0x00, 0, 0))).toThrow("知らない");
		expect(() =>
			run(setBits(0x0001, [0, 0, 8, 8], 0, 8, 8, new Uint8Array(4))),
		).toThrow("短い");
		expect(() =>
			run(setBits(0x0001, [0, 0, 8, 8], RFX_ID, 60000, 8, new Uint8Array(4))),
		).toThrow("大きすぎる");
	});
});

describe("SurfaceRenderer(復号を後回しにして、同じ位置は最新だけ)", () => {
	// 別の見た目のタイル: Y の LL3(4032 番)に値を置いた
	const dc = (v: number) => {
		const y = new Int32Array(4096);
		y[4032] = v;
		return rlgrEncode(y, 4);
	};
	const zero = rlgrEncode(new Int32Array(4096), 4);
	const tileB = (x: number, y: number, v = 300) => ({
		x,
		y,
		y_: dc(v),
		cb: zero,
		cr: zero,
	});
	const full = [{ x: 0, y: 0, w: 64, h: 64 }];

	function setup(screen = { width: 1280, height: 720 }) {
		const draws: string[] = [];
		const pixels: number[][] = [];
		const acks: number[] = [];
		const scheduled: (() => void)[] = [];
		const r = new SurfaceRenderer({
			draw: (x, y, w, h, rgba) => {
				draws.push(`${x},${y} ${w}x${h}`);
				pixels.push([...rgba.subarray(0, 4)]);
			},
			ack: (id) => acks.push(id),
			schedule: (fn) => scheduled.push(fn),
		});
		const cmds = (...parts: Uint8Array[]) =>
			r.handle(concat(...parts), RFX_ID, screen);
		return { r, draws, pixels, acks, scheduled, cmds };
	}

	/** 1 つのタイルだけを、すぐ復号したときの先頭の画素 */
	function direct(rfx: Uint8Array): number[] {
		let first: number[] = [];
		handleSurfaceCommands(
			setBits(0x0006, [0, 0, 64, 64], RFX_ID, 64, 64, rfx),
			RFX_ID,
			{ width: 1280, height: 720 },
			{ draw: (_x, _y, _w, _h, rgba) => (first = [...rgba.subarray(0, 4)]) },
		);
		return first;
	}

	test("同じ位置のタイルが 2 フレーム来たら、復号して描くのは最新だけ(応答は両方のフレーム)", () => {
		const a = rfxStream(full, [tile(0, 0)]);
		const b = rfxStream(full, [tileB(0, 0)]);
		const { r, draws, pixels, acks, scheduled, cmds } = setup();
		cmds(
			frameMarker(0, 1),
			setBits(0x0006, [0, 0, 64, 64], RFX_ID, 64, 64, a),
			frameMarker(1, 1),
			frameMarker(0, 2),
			setBits(0x0006, [0, 0, 64, 64], RFX_ID, 64, 64, b),
			frameMarker(1, 2),
		);
		// 受けた時点では何も描かない。吐き出しの予約は 1 回だけ
		expect(draws).toEqual([]);
		expect(acks).toEqual([]);
		expect(scheduled.length).toBe(1);
		scheduled[0]?.();
		expect(draws).toEqual(["0,0 64x64"]);
		expect(pixels[0]).toEqual(direct(b));
		expect(pixels[0]).not.toEqual(direct(a));
		expect(acks).toEqual([1, 2]);
		expect(r.coalesced).toBe(1);
		expect(r.pending).toBe(0);
	});

	test("位置が違うタイルは、どちらも描く(受けた順に)", () => {
		const { draws, scheduled, cmds } = setup();
		cmds(
			setBits(
				0x0006,
				[0, 0, 128, 64],
				RFX_ID,
				128,
				64,
				rfxStream([{ x: 0, y: 0, w: 128, h: 64 }], [tile(0, 0), tile(64, 0)]),
			),
			setBits(
				0x0006,
				[0, 64, 64, 128],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tile(0, 0)]),
			),
		);
		scheduled[0]?.();
		expect(draws).toEqual(["0,0 64x64", "64,0 64x64", "0,64 64x64"]);
	});

	test("コマンドの左上が違っても、画面上の位置が同じなら置き換える", () => {
		const { draws, scheduled, cmds, r } = setup();
		cmds(
			setBits(
				0x0006,
				[128, 64, 192, 128],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tile(0, 0)]),
			),
			setBits(
				0x0006,
				[64, 64, 192, 128],
				RFX_ID,
				128,
				64,
				rfxStream([{ x: 0, y: 0, w: 128, h: 64 }], [tileB(64, 0)]),
			),
		);
		scheduled[0]?.();
		expect(draws).toEqual(["128,64 64x64"]);
		expect(r.coalesced).toBe(1);
	});

	test("矩形で切った(一部だけ描く)新しいタイルは、古いタイルを置き換えない", () => {
		const { draws, scheduled, cmds, r } = setup();
		cmds(
			setBits(
				0x0006,
				[0, 0, 64, 64],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tile(0, 0)]),
			),
			setBits(
				0x0006,
				[0, 0, 64, 64],
				RFX_ID,
				64,
				64,
				rfxStream([{ x: 10, y: 10, w: 8, h: 8 }], [tileB(0, 0)]),
			),
		);
		scheduled[0]?.();
		expect(draws).toEqual(["0,0 64x64", "10,10 8x8"]);
		expect(r.coalesced).toBe(0);
		// そのあと全体を描くタイルが来たら、両方を置き換える
		cmds(
			setBits(
				0x0006,
				[0, 0, 64, 64],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tileB(0, 0, 100)]),
			),
		);
		scheduled[1]?.();
		expect(draws.slice(2)).toEqual(["0,0 64x64"]);
	});

	test("生のビットマップが間に入ったら、その前に保留を描く(順序を保つ)", () => {
		const { draws, scheduled, cmds } = setup();
		const bgra = Uint8Array.of(1, 2, 3, 0, 4, 5, 6, 0);
		cmds(
			setBits(
				0x0006,
				[0, 0, 64, 64],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tile(0, 0)]),
			),
			setBits(0x0006, [10, 10, 12, 11], 0, 2, 1, bgra),
			setBits(
				0x0006,
				[0, 0, 64, 64],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tileB(0, 0)]),
			),
		);
		expect(draws).toEqual(["0,0 64x64", "10,10 2x1"]); // 後のタイルはまだ保留
		scheduled[0]?.();
		expect(draws).toEqual(["0,0 64x64", "10,10 2x1", "0,0 64x64"]);
	});

	test("flush() は予約を待たずに描いて、応答を返す", () => {
		const { r, draws, acks, cmds } = setup();
		cmds(
			setBits(
				0x0006,
				[0, 0, 64, 64],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tile(0, 0)]),
			),
			frameMarker(1, 9),
		);
		r.flush();
		expect(draws.length).toBe(1);
		expect(acks).toEqual([9]);
		r.flush(); // 2 回目は何もしない
		expect(draws.length).toBe(1);
		expect(acks).toEqual([9]);
	});

	test("画面の外のタイルは保留しない。それでもフレームの応答は返す", () => {
		const { r, draws, acks, cmds } = setup({ width: 100, height: 100 });
		cmds(
			setBits(
				0x0006,
				[640, 640, 704, 704],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tile(0, 0)]),
			),
			frameMarker(1, 3),
		);
		expect(r.pending).toBe(0);
		r.flush();
		expect(draws).toEqual([]);
		expect(acks).toEqual([3]);
	});

	test("画面に一部だけかかるタイルは、見える部分を描く", () => {
		const { r, draws, cmds } = setup({ width: 1280, height: 720 });
		cmds(
			setBits(
				0x0006,
				[1260, 700, 1324, 764],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tile(0, 0)]),
			),
		);
		r.flush();
		expect(draws).toEqual(["1260,700 20x20"]);
	});

	test("不正な入力は handle で例外にする(保留に入れない)", () => {
		const { r, cmds } = setup();
		const good = setBits(
			0x0006,
			[0, 0, 64, 64],
			RFX_ID,
			64,
			64,
			rfxStream(full, [tile(0, 0)]),
		);
		expect(() => cmds(good.slice(0, good.length - 1))).toThrow("長さ");
		expect(() => cmds(Uint8Array.of(0x99, 0, 0, 0))).toThrow("知らない");
		const badBlock = setBits(
			0x0006,
			[0, 0, 64, 64],
			RFX_ID,
			64,
			64,
			Uint8Array.of(0xc7, 0xcc, 99, 0, 0, 0),
		);
		expect(() => cmds(badBlock)).toThrow("長さ");
		expect(r.pending).toBe(0);
	});

	test("parseRfxTiles は復号せずに位置と圧縮データを取り出す", () => {
		const tiles = parseRfxTiles(
			rfxStream([{ x: 0, y: 0, w: 128, h: 64 }], [tile(64, 0), tile(0, 64)]),
		);
		expect(tiles.map((t) => [t.x, t.y])).toEqual([
			[64, 0],
			[0, 64],
		]);
		expect(tiles[0]?.data[0].length).toBe(REAL_TILE.y.length);
		expect(tiles[0]?.rects).toEqual([{ x: 0, y: 0, w: 128, h: 64 }]);
	});
});
