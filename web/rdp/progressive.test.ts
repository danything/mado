// RemoteFX Progressive の試験。量子化の並び、SRL、最初の段(外挿と通常の逆 DWT)、Region の矩形での切り取り、差分、upgrade を見る。

import { describe, expect, test } from "bun:test";
import { concat, Writer } from "./bytes";
import {
	ProgressiveFrame,
	ProgressiveTiles,
	parseProgressive,
	parseProgressiveQuant,
	srlValues,
} from "./progressive";
import type { TilePart } from "./rfx";
import { rlgrEncode } from "./rfx.fixture";

/** その場で復号する。gfx.ts と同じく ProgressiveTiles で復号し、ProgressiveFrame で切る。フレームは PDU ごとに始め直す */
class Decoder {
	private tiles = new ProgressiveTiles();
	deleteSurface(id: number): void {
		this.tiles.deleteSurface(id);
	}
	decode(
		surface: number,
		data: Uint8Array,
		width: number,
		height: number,
	): TilePart[] {
		const msg = parseProgressive(surface, data, width, height);
		const rgba = msg.tiles.map((t) => this.tiles.decode(t.job));
		return new ProgressiveFrame().draw(surface, msg, rgba, width, height);
	}
}

const block = (type: number, body: Uint8Array) =>
	new Writer()
		.u16(type)
		.u32(body.length + 6)
		.bytes(body)
		.done();

/** 量子化の 5 バイト。送られる順に LL3 HL3 LH3 HH3 HL2 LH2 HH2 HL1 LH1 HH1 と並べて渡す */
const quant = (v: number[]) =>
	Uint8Array.from(
		{ length: 5 },
		(_, i) => (v[2 * i] as number) | ((v[2 * i + 1] as number) << 4),
	);
const all = (n: number) => quant(new Array(10).fill(n));

/** DC だけの係数(LL3 の先頭)を RLGR1 で符号化したもの */
function dc(v: number, extrapolate = true): Uint8Array {
	const c = new Int32Array(4096);
	c[extrapolate ? 4015 : 4032] = v;
	return rlgrEncode(c, 1);
}

const EMPTY = new Uint8Array(0);

function simple(x: number, y: number, flags: number, yData: Uint8Array) {
	return block(
		0xccc5,
		new Writer()
			.u8(0)
			.u8(0)
			.u8(0)
			.u16(x)
			.u16(y)
			.u8(flags)
			.u16(yData.length)
			.u16(0)
			.u16(0)
			.u16(0)
			.bytes(yData)
			.done(),
	);
}

function first(x: number, y: number, quality: number, yData: Uint8Array) {
	return block(
		0xccc6,
		new Writer()
			.u8(0)
			.u8(0)
			.u8(0)
			.u16(x)
			.u16(y)
			.u8(0)
			.u8(quality)
			.u16(yData.length)
			.u16(0)
			.u16(0)
			.u16(0)
			.bytes(yData)
			.done(),
	);
}

function upgrade(
	x: number,
	y: number,
	quality: number,
	ySrl: Uint8Array,
	yRaw: Uint8Array,
) {
	return block(
		0xccc7,
		new Writer()
			.u8(0)
			.u8(0)
			.u8(0)
			.u16(x)
			.u16(y)
			.u8(quality)
			.u16(ySrl.length)
			.u16(yRaw.length)
			.u16(0)
			.u16(0)
			.u16(0)
			.u16(0)
			.bytes(ySrl)
			.bytes(yRaw)
			.done(),
	);
}

type R = { x: number; y: number; w: number; h: number };

function region(
	tiles: Uint8Array[],
	opts: { rects?: R[]; prog?: Uint8Array[][]; extrapolate?: boolean } = {},
) {
	const rects = opts.rects ?? [{ x: 0, y: 0, w: 64, h: 64 }];
	const prog = opts.prog ?? [];
	const data = concat(...tiles);
	const w = new Writer()
		.u8(64)
		.u16(rects.length)
		.u8(1)
		.u8(prog.length)
		.u8(opts.extrapolate === false ? 0 : 1)
		.u16(tiles.length)
		.u32(data.length);
	for (const r of rects) w.u16(r.x).u16(r.y).u16(r.w).u16(r.h);
	w.bytes(all(6));
	for (const p of prog) {
		w.u8(0);
		for (const q of p) w.bytes(q);
	}
	return block(0xccc4, w.bytes(data).done());
}

function stream(...blocks: Uint8Array[]) {
	return concat(
		block(0xccc0, new Writer().u32(0xcaccacca).u16(0x0100).done()),
		block(0xccc3, new Writer().u8(0).u16(64).u8(0).done()),
		block(0xccc1, new Writer().u32(1).u16(1).done()),
		...blocks,
		block(0xccc2, EMPTY),
	);
}

/** すべての部分のすべての画素が同じ灰色なら、その値 */
function gray(parts: TilePart[]): number {
	const v = parts[0]?.rgba[0] as number;
	for (const p of parts)
		for (let i = 0; i < p.rgba.length; i += 4) {
			expect([p.rgba[i], p.rgba[i + 1], p.rgba[i + 2], p.rgba[i + 3]]).toEqual([
				v,
				v,
				v,
				255,
			]);
		}
	return v;
}

describe("Progressive", () => {
	test("量子化の 5 バイト → BANDS の順(RemoteFX と HL / LH の並びが違う)", () => {
		expect(
			parseProgressiveQuant(Uint8Array.of(0x21, 0x43, 0x65, 0x87, 0xa9)),
		).toEqual([8, 9, 10, 5, 6, 7, 2, 3, 4, 1]);
	});

	test("SRL: 0 の並びと、符号 + 大きさの unary", () => {
		// k=1:「1」+ 1 ビット「0」で 0 は無し → 符号「1」、大きさ「1」で -1。
		// kp 2(k=0):「1」→ 符号「0」、「0」「0」で最大の 3。kp 0:「0」→ 0 が 1 個、kp 4:「0」→ 0 が 1 個
		expect(srlValues(Uint8Array.of(0b10111000, 0), 2, 4)).toEqual([
			-1, 3, 0, 0,
		]);
		// numBits 1 なら大きさは読まない
		expect(srlValues(Uint8Array.of(0b10000000), 1, 2)).toEqual([1, 0]);
	});

	test("TILE_SIMPLE: DC だけなら一様な灰色(外挿・通常の逆 DWT とも)。Region の矩形と面で切る", () => {
		for (const extrapolate of [true, false]) {
			const d = new Decoder();
			const parts = d.decode(
				1,
				stream(
					region([simple(0, 0, 0, dc(10, extrapolate))], {
						extrapolate,
						rects: [
							{ x: 0, y: 0, w: 10, h: 5 },
							{ x: 60, y: 0, w: 100, h: 100 },
						],
					}),
				),
				100,
				40,
			);
			expect(parts.map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
				[0, 0, 10, 5],
				[60, 0, 4, 40],
			]);
			// 係数 10 << 5 = 320、(320 + 4096) >> 5 = 138
			expect(gray(parts)).toBe(138);
		}
	});

	test("空のタイルは灰色(128)。2 つ目のタイルの位置", () => {
		const d = new Decoder();
		const parts = d.decode(
			1,
			stream(
				region([simple(1, 0, 0, EMPTY)], {
					rects: [{ x: 0, y: 0, w: 200, h: 64 }],
				}),
			),
			100,
			64,
		);
		expect(parts.map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
			[64, 0, 36, 64],
		]);
		expect(gray(parts)).toBe(128);
	});

	test("差分(RFX_TILE_DIFFERENCE)は前の係数に足す。面を消すと前の係数も消える", () => {
		const d = new Decoder();
		const run = () =>
			gray(d.decode(1, stream(region([simple(0, 0, 1, dc(5))])), 64, 64));
		expect(
			gray(d.decode(1, stream(region([simple(0, 0, 0, dc(10))])), 64, 64)),
		).toBe(138);
		// 320 + 160 = 480 → 143
		expect(run()).toBe(143);
		// 別の面には効かない
		expect(
			gray(d.decode(2, stream(region([simple(0, 0, 1, dc(5))])), 64, 64)),
		).toBe(133);
		d.deleteSurface(1);
		expect(run()).toBe(133);
	});

	test("TILE_FIRST(粗い段)→ TILE_UPGRADE(最後の段): 足りない下のビットを足す", () => {
		const d = new Decoder();
		// quality 0 では、Y の全部の帯が 2 ビット粗くなる。ビットの位置は 8、ずらしは 7
		const prog = [[all(2), all(0), all(0)]];
		const a = d.decode(
			1,
			stream(region([first(0, 0, 0, dc(10))], { prog })),
			64,
			64,
		);
		// 10 << 7 = 1280 → (1280 + 4096) >> 5 = 168
		expect(gray(a)).toBe(168);
		// 最後の段(0xff)では各帯 2 ビット。LL3 以外は係数が 0 なので SRL から読み、空なので 0 の並びになる。LL3 の 81 個は RAW から「01」ずつ読み、+1 << 5 になる
		const raw = new Uint8Array(21).fill(0x55);
		const b = d.decode(
			1,
			stream(region([upgrade(0, 0, 0xff, EMPTY, raw)], { prog })),
			64,
			64,
		);
		// 1280 + 32 = 1312 → 169
		expect(gray(b)).toBe(169);
	});

	test("upgrade: LL3 は符号によらず RAW の値をそのまま足す", () => {
		const d = new Decoder();
		const prog = [[all(2), all(0), all(0)]];
		d.decode(1, stream(region([first(0, 0, 0, dc(-10))], { prog })), 64, 64);
		// LL3 は符号によらず RAW の値をそのまま足す: -1280 + 3 * 32 = -1184 → (−1184 + 4096) >> 5 = 91
		const raw = new Uint8Array(21).fill(0xff);
		const b = d.decode(
			1,
			stream(region([upgrade(0, 0, 0xff, EMPTY, raw)], { prog })),
			64,
			64,
		);
		expect(gray(b)).toBe(91);
	});

	test("粗い段 + upgrade は、同じ係数を一度に送った TILE_SIMPLE と同じ画素になる(0 でなかった係数は RAW から、符号つき)", () => {
		const coef = (hl0: number, ll: number) => {
			const c = new Int32Array(4096);
			c[0] = hl0;
			c[1] = -hl0;
			c[4015] = ll;
			return rlgrEncode(c, 1);
		};
		const prog = [[all(2), all(0), all(0)]];
		const d = new Decoder();
		d.decode(
			1,
			stream(region([first(0, 0, 0, coef(1, 10))], { prog })),
			64,
			64,
		);
		// HL1 の 2 つ(+1 と -1)に「11」ずつ、LL3 の 81 個に「01」ずつ
		const raw = new Uint8Array(21).fill(0x55);
		raw[0] = 0xf5;
		const [up] = d.decode(
			1,
			stream(region([upgrade(0, 0, 0xff, EMPTY, raw)], { prog })),
			64,
			64,
		);
		// (1 << 2) + 3 = 7、(10 << 2) + 1 = 41
		const [whole] = new Decoder().decode(
			1,
			stream(region([simple(0, 0, 0, coef(7, 41))])),
			64,
			64,
		);
		expect(up?.rgba).toEqual(whole?.rgba as Uint8ClampedArray);
		expect(new Set(whole?.rgba).size).toBeGreaterThan(2);
	});

	test("面の外のタイルは飛ばし、ほかのタイルは描く", () => {
		const out = new Decoder().decode(
			1,
			stream(region([simple(1, 0, 0, EMPTY), simple(0, 0, 0, EMPTY)])),
			64,
			64,
		);
		expect(out.length).toBeGreaterThan(0);
	});

	test("不正な入力は例外", () => {
		const d = new Decoder();
		expect(() => d.decode(1, block(0xccc9, EMPTY), 64, 64)).toThrow(
			"知らないブロック",
		);
		expect(() =>
			d.decode(1, block(0xccc0, new Writer().u32(1).u16(0x100).done()), 64, 64),
		).toThrow("署名");
		expect(() =>
			d.decode(1, stream(region([first(0, 0, 3, EMPTY)])), 64, 64),
		).toThrow("quality");
		expect(() =>
			d.decode(1, Uint8Array.of(0xc0, 0xcc, 99, 0, 0, 0), 64, 64),
		).toThrow("長さ");
	});
});
