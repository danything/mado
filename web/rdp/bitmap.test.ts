// ビットマップの復号と Fast-Path の断片の組み立ての試験。

import { describe, expect, test } from "bun:test";
import { decodeBitmap, parseBitmapUpdate, rleDecompress } from "./bitmap";
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
	test("32bpp の圧縮は未対応と言う", () => {
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
		).toThrow("planar");
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
