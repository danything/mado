// ビットマップの復号と Fast-Path の断片の組み立ての試験。

import { describe, expect, test } from "bun:test";
import {
	decodeBitmap,
	decodePlanar,
	parseBitmapUpdate,
	rleDecompress,
} from "./bitmap";
import { fromHex, hex, Writer } from "./bytes";
import { Reassembler, UPDATE } from "./fastpath";

describe("生のビットマップ", () => {
	test("16bpp は下の行から並んでいて、RGB565 を RGBA にする", () => {
		// 2x2: 下の行(先に来る)が 赤・緑、上の行が 青・白
		const data = fromHex("00f8e007" + "1f00ffff");
		const rgba = decodeBitmap({
			left: 0,
			top: 0,
			right: 1,
			bottom: 1,
			width: 2,
			height: 2,
			bpp: 16,
			compressed: false,
			data,
		});
		// 上の行
		expect([...rgba.subarray(0, 8)]).toEqual([
			0, 0, 255, 255, 255, 255, 255, 255,
		]);
		// 下の行
		expect([...rgba.subarray(8, 16)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	test("24bpp は BGR", () => {
		const rgba = decodeBitmap({
			left: 0,
			top: 0,
			right: 0,
			bottom: 0,
			width: 1,
			height: 1,
			bpp: 24,
			compressed: false,
			data: Uint8Array.of(3, 2, 1),
		});
		expect([...rgba]).toEqual([1, 2, 3, 255]);
	});

	test("短いデータは例外", () => {
		expect(() =>
			decodeBitmap({
				left: 0,
				top: 0,
				right: 3,
				bottom: 3,
				width: 4,
				height: 4,
				bpp: 16,
				compressed: false,
				data: new Uint8Array(4),
			}),
		).toThrow("短い");
	});

	test("矩形の並びを読む", () => {
		const w = new Writer()
			.u16(1)
			.u16(1) // updateType, numberRectangles
			.u16(10)
			.u16(20)
			.u16(11)
			.u16(21)
			.u16(2)
			.u16(2)
			.u16(16)
			.u16(0)
			.u16(8)
			.bytes(new Uint8Array(8))
			.done();
		const [r] = parseBitmapUpdate(w);
		expect(r).toMatchObject({
			left: 10,
			top: 20,
			right: 11,
			bottom: 21,
			width: 2,
			height: 2,
			bpp: 16,
			compressed: false,
		});
		expect(r?.data.length).toBe(8);
	});
});

describe("Interleaved RLE (16bpp = 2 バイト)", () => {
	const run = (s: string, w: number, h: number) =>
		hex(rleDecompress(fromHex(s), w, h, 2));

	test("COLOR_RUN: 同じ色を並べる", () => {
		// 0x60 | 4 = COLOR_RUN 4 画素、色 1234
		expect(run("64" + "3412", 4, 1)).toBe("3412".repeat(4));
	});

	test("最初の行の BG_RUN は黒、FG_RUN は白(fg の初期値)", () => {
		expect(run("03", 3, 1)).toBe("0000".repeat(3));
		expect(run("22", 2, 1)).toBe("ffff".repeat(2));
	});

	test("2 行目の BG_RUN は上の行をそのまま写す", () => {
		// 1 行目: COLOR_RUN 2 画素(aabb)、2 行目: BG_RUN 2 画素
		expect(run("62" + "bbaa" + "02", 2, 2)).toBe(
			"bbaa".repeat(2) + "bbaa".repeat(2),
		);
	});

	test("2 行目の FG_RUN は、上の行と fg の XOR", () => {
		// 1 行目: COLOR_RUN(0f0f)、2 行目: LITE_SET_FG_FG_RUN 2 画素、fg = ffff
		expect(run("62" + "0f0f" + "c2" + "ffff", 2, 2)).toBe(
			"0f0f0f0f" + "f0f0f0f0",
		);
	});

	test("COLOR_IMAGE: そのまま写す", () => {
		// 0x80 | 2 = COLOR_IMAGE 2 画素
		expect(run("82" + "01020304", 2, 1)).toBe("01020304");
	});

	test("FGBG_IMAGE: ビットマスクで fg / bg", () => {
		// 0x40 | 1 = 8 画素、マスク 0b00000101 → 1 行目: 0, 2 番目が fg(白)、ほかは黒(最初の行の bg は 0)
		const out = run("41" + "05", 8, 1);
		expect(out).toBe(
			["ffff", "0000", "ffff", "0000", "0000", "0000", "0000", "0000"].join(""),
		);
	});

	test("MEGA_MEGA_COLOR_RUN: 2 バイトの長さ", () => {
		// 0xf3 + 長さ 300(le)+ 色
		expect(run("f3" + "2c01" + "3412", 300, 1)).toBe("3412".repeat(300));
	});

	test("DITHERED_RUN: 2 色を交互に", () => {
		// 0xe0 | 2 = 2 組、色 AAAA と BBBB
		expect(run("e2" + "aaaa" + "bbbb", 4, 1)).toBe("aaaabbbb".repeat(2));
	});

	test("WHITE / BLACK", () => {
		expect(run("fd" + "fe", 2, 1)).toBe("ffff" + "0000");
	});

	test("出力があふれたら例外", () => {
		expect(() => run("64" + "3412", 2, 1)).toThrow("あふれ");
	});
});

describe("Fast-Path の更新", () => {
	const upd = (code: number, frag: number, data: string) => {
		const d = fromHex(data);
		return new Writer()
			.u8(code | (frag << 4))
			.u16(d.length)
			.bytes(d)
			.done();
	};

	test("1 つの PDU に複数の更新", () => {
		const r = new Reassembler();
		const out = r.push(
			Uint8Array.from([
				...upd(UPDATE.SYNCHRONIZE, 0, ""),
				...upd(UPDATE.BITMAP, 0, "0102"),
			]),
		);
		expect(out.map((u) => [u.code, hex(u.data)])).toEqual([
			[3, ""],
			[1, "0102"],
		]);
	});

	test("断片(最初・途中・最後)を 1 つに組み立てる", () => {
		const r = new Reassembler();
		expect(r.push(upd(UPDATE.BITMAP, 2, "01"))).toEqual([]);
		expect(r.push(upd(UPDATE.BITMAP, 3, "02"))).toEqual([]);
		const out = r.push(upd(UPDATE.BITMAP, 1, "03"));
		expect(out.map((u) => [u.code, hex(u.data)])).toEqual([[1, "010203"]]);
	});
});

describe("不正な入力", () => {
	test("32bpp の圧縮(planar)で入力が足りなければ例外", () => {
		expect(() =>
			decodeBitmap({
				left: 0,
				top: 0,
				right: 0,
				bottom: 0,
				width: 1,
				height: 1,
				bpp: 32,
				compressed: true,
				data: new Uint8Array(4),
			}),
		).toThrow("足りない");
	});

	test("巨大な矩形は確保しない", () => {
		expect(() =>
			decodeBitmap({
				left: 0,
				top: 0,
				right: 0xfffe,
				bottom: 0xfffe,
				width: 0xffff,
				height: 0xffff,
				bpp: 16,
				compressed: false,
				data: new Uint8Array(4),
			}),
		).toThrow("大きすぎる");
	});

	test("圧縮ヘッダー分より短い長さ", () => {
		const w = new Writer()
			.u16(1)
			.u16(1)
			.u16(0)
			.u16(0)
			.u16(1)
			.u16(1)
			.u16(2)
			.u16(2)
			.u16(16)
			.u16(1)
			.u16(4)
			.done();
		expect(() => parseBitmapUpdate(w)).toThrow("長さ");
	});

	test("RLE の命令の追加バイトが入力に無い", () => {
		expect(() => rleDecompress(fromHex("e0"), 4, 1, 2)).toThrow("足りない");
		expect(() => rleDecompress(fromHex("f3"), 4, 1, 2)).toThrow("足りない");
		expect(() => rleDecompress(fromHex("41"), 8, 1, 2)).toThrow("足りない");
	});

	test("先頭のない断片は例外", () => {
		const r = new Reassembler();
		expect(() => r.push(Uint8Array.of(0x11, 1, 0, 9))).toThrow("最初の断片");
		expect(() => new Reassembler().push(Uint8Array.of(0x31, 1, 0, 9))).toThrow(
			"最初の断片",
		);
	});
});

describe("Planar (RDP 6.0、32bpp の圧縮)", () => {
	const NA = 0x20;
	const RLE = 0x10;
	const rgba = (a: Uint8ClampedArray) => [...a];

	/** 面(下の行から並べた行)を RLE にする試験用の符号化器。短い繰り返しは raw 1 + run、長いものは nRun 1 / 2 */
	function encodeRow(sym: number[]): number[] {
		const out: number[] = [];
		let i = 0;
		while (i < sym.length) {
			let n = 1;
			while (i + n < sym.length && sym[i + n] === sym[i]) n++;
			if (n >= 4) {
				let run = n - 1;
				if (run <= 15) out.push((1 << 4) | run, sym[i] as number);
				else {
					out.push(1 << 4, sym[i] as number);
					while (run > 0) {
						const r = Math.min(run, 47);
						if (r < 16) out.push((0 << 4) | r);
						else if (r < 32) out.push(((r - 16) << 4) | 1);
						else out.push(((r - 32) << 4) | 2);
						run -= r;
					}
				}
				i += n;
			} else {
				const raw = Math.min(15, sym.length - i);
				out.push(raw << 4, ...sym.slice(i, i + raw));
				i += raw;
			}
		}
		return out;
	}
	const delta = (d: number) => (d >= 0 ? d << 1 : ((-d - 1) << 1) | 1);
	function encodePlane(rows: number[][]): number[] {
		return rows.flatMap((row, y) =>
			encodeRow(
				y === 0
					? row
					: row.map(
							(v, x) =>
								delta(
									((v - ((rows[y - 1] as number[])[x] as number) + 128) &
										0xff) -
										128,
								) & 0xff,
						),
			),
		);
	}
	const planeRows = (p: number[], w: number) =>
		Array.from({ length: p.length / w }, (_, y) => p.slice(y * w, (y + 1) * w));

	test("生の面(アルファ無し): 行は下から並び、出力は上の行から", () => {
		// 2x2。面の最初の行 = 下の行
		const r = [10, 20, 30, 40];
		const g = [11, 21, 31, 41];
		const b = [12, 22, 32, 42];
		const out = decodePlanar(Uint8Array.of(NA, ...r, ...g, ...b), 2, 2);
		expect(rgba(out)).toEqual([
			30, 31, 32, 255, 40, 41, 42, 255, 10, 11, 12, 255, 20, 21, 22, 255,
		]);
	});

	test("生の面(アルファ有り): 先頭の面はアルファで、画面は不透明として描く", () => {
		const out = decodePlanar(Uint8Array.of(0, 9, 1, 2, 3), 1, 1);
		expect(rgba(out)).toEqual([1, 2, 3, 255]);
	});

	test("RLE: 生 1 + 繰り返し 3 (手計算)", () => {
		// 制御 0x13 = 生 1、繰り返し 3 → 値 7 が 4 つ
		const data = Uint8Array.of(NA | RLE, 0x13, 7, 0x13, 8, 0x13, 9);
		expect(rgba(decodePlanar(data, 4, 1))).toEqual([
			7, 8, 9, 255, 7, 8, 9, 255, 7, 8, 9, 255, 7, 8, 9, 255,
		]);
	});

	test("RLE: 2 行目は上の行との符号付き差分", () => {
		// 行 0: 10 10。行 1: +1 → 2、-1 → 1 なので 11、9
		const plane = [0x20, 10, 10, 0x20, 2, 1];
		const data = Uint8Array.of(NA | RLE, ...plane, ...plane, ...plane);
		const out = rgba(decodePlanar(data, 2, 2));
		// 上の行 = 面の 2 行目
		expect(out.slice(0, 8)).toEqual([11, 11, 11, 255, 9, 9, 9, 255]);
		expect(out.slice(8)).toEqual([10, 10, 10, 255, 10, 10, 10, 255]);
	});

	test("RLE: 2 行目の繰り返しは直前の差分", () => {
		// 行 0: 5 5 5 5。行 1: 生 1(差分 +2 → 4)+ 繰り返し 3 → すべて 5 + 2
		const data = Uint8Array.of(
			NA | RLE,
			...[0x13, 5, 0x13, 4],
			...[0x13, 5, 0x13, 4],
			...[0x13, 5, 0x13, 4],
		);
		const out = rgba(decodePlanar(data, 4, 2));
		expect(out.slice(0, 4)).toEqual([7, 7, 7, 255]);
		expect(out.slice(12, 16)).toEqual([7, 7, 7, 255]);
	});

	test("RLE: 往復(長い繰り返し・差分・アルファ有り無し)", () => {
		const w = 90;
		const h = 6;
		const mk = (f: (x: number, y: number) => number) =>
			Array.from(
				{ length: w * h },
				(_, i) => f(i % w, Math.floor(i / w)) & 0xff,
			);
		const A = mk(() => 255);
		const R = mk((x, y) => (x < 70 ? 200 : x * 3 + y));
		const G = mk((x, y) => (y % 2 ? 40 : x));
		const B = mk((x, y) => x * y);
		for (const withAlpha of [false, true]) {
			const planes = withAlpha ? [A, R, G, B] : [R, G, B];
			const data = Uint8Array.from([
				(withAlpha ? 0 : NA) | RLE,
				...planes.flatMap((p) => encodePlane(planeRows(p, w))),
				0, // 終わりの詰め物
			]);
			const out = decodePlanar(data, w, h);
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					const i = ((h - 1 - y) * w + x) | 0;
					const d = (y * w + x) * 4;
					expect([out[d], out[d + 1], out[d + 2], out[d + 3]]).toEqual([
						R[i],
						G[i],
						B[i],
						255,
					]);
				}
		}
	});

	test("YCoCg(CLL 1): Y=100、Co=10、Cg=5 → R=105、G=105、B=85", () => {
		const data = Uint8Array.of(NA | 1, 100, 10, 5);
		expect(rgba(decodePlanar(data, 1, 1))).toEqual([105, 105, 85, 255]);
	});

	test("YCoCg: CLL 2 は色差を 1 ビット左へ戻し、符号付きで読む", () => {
		// Co = (int8)0xf6 = -10 → << 1 = -20、Cg = 0。R = 50 - 20、B = 50 + 20、G = 50
		expect(
			rgba(decodePlanar(Uint8Array.of(NA | 2, 50, 0xf6, 0), 1, 1)),
		).toEqual([30, 50, 70, 255]);
	});

	test("decodeBitmap は 32bpp の圧縮を planar として読む", () => {
		const out = decodeBitmap({
			left: 0,
			top: 0,
			right: 0,
			bottom: 0,
			width: 1,
			height: 1,
			bpp: 32,
			compressed: true,
			data: Uint8Array.of(NA, 1, 2, 3),
		});
		expect([...out]).toEqual([1, 2, 3, 255]);
	});

	test("不正な入力", () => {
		expect(() => decodePlanar(Uint8Array.of(NA | 0x08, 1, 2, 3), 1, 1)).toThrow(
			"CS",
		);
		expect(() => decodePlanar(new Uint8Array(), 1, 1)).toThrow("足りない");
		expect(() => decodePlanar(Uint8Array.of(NA | RLE, 0x13, 1), 4, 1)).toThrow(
			"足りない",
		);
		// 1 行に収まらない繰り返し(幅 2 に、生 1 + 繰り返し 3)
		expect(() =>
			decodePlanar(Uint8Array.of(NA | RLE, 0x13, 1, 0x13, 1, 0x13, 1), 2, 1),
		).toThrow("あふれ");
		expect(() =>
			decodePlanar(Uint8Array.of(NA | RLE, 0x30, 1, 2, 3), 2, 1),
		).toThrow("あふれ");
		expect(() => decodePlanar(new Uint8Array(1), 0xffff, 0xffff)).toThrow(
			"大きすぎる",
		);
	});
});
