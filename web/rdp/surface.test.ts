// Surface Commands の試験: コマンドの切り出し、RemoteFX の矩形の切り取り、生のビットマップ、不正な入力。

import { describe, expect, test } from "bun:test";
import { concat, Writer } from "./bytes";
import { REAL_TILE, rfxStream } from "./rfx.fixture";
import { handleSurfaceCommands, type SurfaceDraw } from "./surface";

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
