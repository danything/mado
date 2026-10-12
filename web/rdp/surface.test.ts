// Surface Commands の試験: コマンドの切り出し、RemoteFX の矩形の切り取り、生のビットマップ、不正な入力。

import { describe, expect, test } from "bun:test";
import type { BitmapJob, BitmapRect } from "./bitmap";
import { concat, Writer } from "./bytes";
import { REAL_TILE, rfxStream, rlgrEncode } from "./rfx.fixture";
import { type DecodeJob, decodeJob, type TilePool } from "./rfxpool";
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

	test("Region で左半分だけ描く新しいタイルは、全体を描いた古いタイルを置き換えない(Windows で前の絵が残った)", () => {
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
				rfxStream([{ x: 0, y: 0, w: 32, h: 64 }], [tileB(0, 0)]),
			),
		);
		scheduled[0]?.();
		expect(r.coalesced).toBe(0);
		expect(draws).toEqual(["0,0 64x64", "0,0 32x64"]);
	});

	test("コマンドの右下(destRight / destBottom)では切らない。切るのは Region と画面だけ(FreeRDP と同じ)", () => {
		const { draws, scheduled, cmds } = setup();
		cmds(
			setBits(
				0x0006,
				[0, 0, 16, 16],
				RFX_ID,
				64,
				64,
				rfxStream(full, [tile(0, 0)]),
			),
		);
		scheduled[0]?.();
		expect(draws).toEqual(["0,0 64x64"]);
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

describe("SurfaceRenderer(非同期のプール)", () => {
	type Job = {
		job: DecodeJob;
		resolve(v: Uint8ClampedArray): void;
		reject(e: Error): void;
	};

	/** 完了の時機と順序を、試験が決めるプール */
	class ManualPool implements TilePool {
		readonly async = true;
		jobs: Job[] = [];
		private run(job: DecodeJob): Promise<Uint8ClampedArray> {
			return new Promise((resolve, reject) =>
				this.jobs.push({ job, resolve, reject }),
			);
		}
		decode(
			...[mode, data, quant]: Parameters<TilePool["decode"]>
		): Promise<Uint8ClampedArray> {
			return this.run({ kind: "rfx", mode, data, quant });
		}
		decodeBitmap(rect: BitmapJob): Promise<Uint8ClampedArray> {
			return this.run({ kind: "bitmap", rect });
		}
		finish(i: number): void {
			const j = this.jobs[i] as Job;
			j.resolve(decodeJob(j.job));
		}
		fail(i: number): void {
			(this.jobs[i] as Job).reject(new Error("worker"));
		}
		terminate(): void {}
	}

	const tick = () => new Promise<void>((r) => setTimeout(r, 0));
	const full = [{ x: 0, y: 0, w: 64, h: 64 }];
	const cmd = (x: number, y: number) =>
		setBits(
			0x0006,
			[x, y, x + 64, y + 64],
			RFX_ID,
			64,
			64,
			rfxStream(full, [tile(0, 0)]),
		);

	function setup() {
		const log: string[] = [];
		const pool = new ManualPool();
		const r = new SurfaceRenderer({
			draw: (x, y, w, h) => log.push(`draw ${x},${y} ${w}x${h}`),
			ack: (id) => log.push(`ack ${id}`),
			schedule: () => {},
			pool,
		});
		const feed = (...parts: Uint8Array[]) =>
			r.handle(concat(...parts), RFX_ID, { width: 1280, height: 720 });
		return { r, pool, log, feed };
	}

	test("復号が逆順に終わっても、描くのと Frame Acknowledge は吐き出した順", async () => {
		const { r, pool, log, feed } = setup();
		feed(frameMarker(0, 1), cmd(0, 0), frameMarker(1, 1));
		r.flush();
		feed(frameMarker(0, 2), cmd(64, 0), frameMarker(1, 2));
		r.flush();
		expect(pool.jobs.length).toBe(2);
		pool.finish(1); // 2 つ目が先に終わる
		await tick();
		expect(log).toEqual([]);
		pool.finish(0);
		await tick();
		expect(log).toEqual([
			"draw 0,0 64x64",
			"ack 1",
			"draw 64,0 64x64",
			"ack 2",
		]);
		expect(r.inFlight).toBe(0);
	});

	test("復号中のタイルより新しい同じ位置のタイルが来たら、古い結果は捨てる", async () => {
		const { r, pool, log, feed } = setup();
		feed(frameMarker(0, 1), cmd(0, 0), frameMarker(1, 1));
		r.flush();
		feed(frameMarker(0, 2), cmd(0, 0), frameMarker(1, 2));
		r.flush();
		pool.finish(0);
		pool.finish(1);
		await tick();
		expect(log).toEqual(["ack 1", "draw 0,0 64x64", "ack 2"]);
		expect(r.coalesced).toBe(1);
	});

	test("生のビットマップは、復号中のタイルを描き終えてから描く", async () => {
		const { pool, log, feed } = setup();
		feed(cmd(0, 0));
		const raw = setBits(
			0x0001,
			[100, 100, 101, 100],
			0,
			2,
			1,
			new Uint8Array(8),
		);
		feed(raw);
		// タイルはまだ復号中なので、生のビットマップも描かれない
		expect(log).toEqual([]);
		pool.finish(0);
		await tick();
		expect(log).toEqual(["draw 0,0 64x64", "draw 100,100 2x1"]);
	});

	test("復号に失敗したタイルは捨てて、ほかを描き、応答も返す", async () => {
		const { r, pool, log, feed } = setup();
		feed(frameMarker(0, 1), cmd(0, 0), cmd(64, 0), frameMarker(1, 1));
		r.flush();
		pool.fail(0);
		pool.finish(1);
		await tick();
		expect(log).toEqual(["draw 64,0 64x64", "ack 1"]);
		expect(r.skipped).toBe(1);
	});

	test("ordered は、復号中のものが無ければすぐ流す", () => {
		const { r, log } = setup();
		r.ordered(() => log.push("now"));
		expect(log).toEqual(["now"]);
	});
	/** 16bpp の生の 1 色の矩形 */
	const bmp = (
		left: number,
		top: number,
		w: number,
		h: number,
		color = 0xf800,
	): BitmapRect => {
		const data = new Uint8Array(w * h * 2);
		for (let i = 0; i < w * h; i++) {
			data[i * 2] = color & 0xff;
			data[i * 2 + 1] = color >> 8;
		}
		return {
			left,
			top,
			right: left + w - 1,
			bottom: top + h - 1,
			width: w,
			height: h,
			bpp: 16,
			compressed: false,
			data,
		};
	};
	const screen = { width: 1280, height: 720 };

	test("旧ビットマップと RemoteFX のタイルが混ざって、逆順に終わっても、受けた順に描く", async () => {
		const { r, pool, log, feed } = setup();
		r.bitmaps([bmp(200, 0, 8, 8)], screen);
		feed(frameMarker(0, 1), cmd(0, 0), frameMarker(1, 1));
		r.bitmaps([bmp(300, 0, 8, 8)], screen);
		r.flush();
		expect(pool.jobs.length).toBe(3);
		pool.finish(2);
		pool.finish(1);
		await tick();
		expect(log).toEqual([]);
		pool.finish(0);
		await tick();
		expect(log).toEqual([
			"draw 200,0 8x8",
			"draw 0,0 64x64",
			"draw 300,0 8x8",
			"ack 1",
		]);
	});

	test("後の旧ビットマップがすっぽり覆うなら、古いものは復号しない。一部だけ覆うなら捨てない", async () => {
		const { r, pool, log } = setup();
		r.bitmaps([bmp(0, 0, 64, 64, 0x001f)], screen);
		r.bitmaps([bmp(0, 0, 64, 64)], screen); // 同じ位置・同じ大きさ: 前を捨てる
		r.bitmaps([bmp(100, 0, 64, 64)], screen);
		r.bitmaps([bmp(100, 0, 32, 64)], screen); // 左半分だけ: 前は捨てない
		r.flush();
		expect(r.coalesced).toBe(1);
		expect(pool.jobs.length).toBe(3);
		for (let i = 2; i >= 0; i--) pool.finish(i);
		await tick();
		expect(log).toEqual([
			"draw 0,0 64x64",
			"draw 100,0 64x64",
			"draw 100,0 32x64",
		]);
	});

	test("旧ビットマップが同じ位置の RemoteFX のタイルをすっぽり覆うなら、タイルは復号しない(逆に覆わないなら残す)", async () => {
		const { r, pool, log, feed } = setup();
		feed(cmd(0, 0));
		r.bitmaps([bmp(0, 0, 64, 64)], screen);
		feed(cmd(64, 0));
		r.bitmaps([bmp(64, 0, 16, 16)], screen);
		r.flush();
		expect(r.coalesced).toBe(1);
		expect(pool.jobs.length).toBe(3);
		for (let i = 0; i < 3; i++) pool.finish(i);
		await tick();
		expect(log).toEqual([
			"draw 0,0 64x64",
			"draw 64,0 64x64",
			"draw 64,0 16x16",
		]);
	});

	test("幅が 4 の倍数に揃えられた矩形は、右の余りを切って描く。画面の外は描かない", async () => {
		const { r, pool, log } = setup();
		const wide = bmp(10, 10, 8, 2);
		r.bitmaps([{ ...wide, right: 15 }], screen); // 描くのは 6 列
		r.bitmaps([bmp(2000, 0, 8, 8)], screen);
		r.flush();
		expect(pool.jobs.length).toBe(1);
		pool.finish(0);
		await tick();
		expect(log).toEqual(["draw 10,10 6x2"]);
	});
});
