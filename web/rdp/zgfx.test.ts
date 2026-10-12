// ZGFX(RDP8 bulk)の伸長の試験。文字、一致、生の並びだけを使う簡単な符号化器で往復する。

import { describe, expect, test } from "bun:test";
import { hex } from "./bytes";
import { segmentedUncompressed, Zgfx } from "./zgfx";
import { BitWriter, encode, writeMatch } from "./zgfx.fixture";

const text = (s: string) => new TextEncoder().encode(s);

describe("ZGFX", () => {
	test("圧縮しないセグメントはそのまま", () => {
		const z = new Zgfx();
		expect(
			hex(z.decompress(segmentedUncompressed(Uint8Array.of(1, 2, 3)))),
		).toBe("010203");
	});

	test("文字だけ(固定の符号を持つバイトと 8 ビットの文字)", () => {
		const data = Uint8Array.from([0, 1, 2, 0xff, 0x66, 0x41, 0x80, 0x3a, 0x99]);
		expect(hex(new Zgfx().decompress(encode(data)))).toBe(hex(data));
	});

	test("一致(繰り返し、長さ 3 と長い一致、重なりのある一致)", () => {
		const data = text(
			"abcabcabcabcabcabcabcabc-hello hello hello-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		expect(new TextDecoder().decode(new Zgfx().decompress(encode(data)))).toBe(
			new TextDecoder().decode(data),
		);
	});

	test("生の並び(distance 0)", () => {
		const data = text("xyzxyzxyz RAW BYTES HERE");
		expect(
			new TextDecoder().decode(new Zgfx().decompress(encode(data, 9))),
		).toBe("xyzxyzxyz RAW BYTES HERE");
	});

	test("履歴はメッセージをまたいで続く", () => {
		const z = new Zgfx();
		const first = text("the quick brown fox ");
		z.decompress(encode(first));
		// 2 つ目は、1 つ目の内容を距離で指す一致だけで作る
		const w = new BitWriter();
		writeMatch(w, first.length, first.length - 1);
		const body = w.done();
		const pdu = Uint8Array.from([0xe0, 0x24, ...body]);
		expect(new TextDecoder().decode(z.decompress(pdu))).toBe(
			"the quick brown fox",
		);
	});

	test("複数のセグメント", () => {
		const a = encode(text("hello "));
		const b = encode(text("world"));
		// a, b は 0xe0 付きなので、descriptor を外して RDP8_BULK_ENCODED_DATA にする
		const segs = [a.subarray(1), b.subarray(1)];
		const total = 11;
		const parts: number[] = [0xe1, 2, 0, total, 0, 0, 0];
		for (const s of segs)
			parts.push(s.length & 0xff, (s.length >> 8) & 0xff, 0, 0, ...s);
		expect(
			new TextDecoder().decode(new Zgfx().decompress(Uint8Array.from(parts))),
		).toBe("hello world");
	});

	test("ランダムな往復", () => {
		for (let k = 0; k < 30; k++) {
			const n = 50 + k * 37;
			const data = new Uint8Array(n);
			for (let i = 0; i < n; i++)
				data[i] =
					i % (3 + k) === 0 ? (Math.random() * 256) | 0 : (data[i - 1] ?? 7);
			expect(hex(new Zgfx().decompress(encode(data)))).toBe(hex(data));
		}
	});

	test("不正な入力", () => {
		expect(() => new Zgfx().decompress(Uint8Array.of(0x12))).toThrow(
			"descriptor",
		);
		expect(() =>
			new Zgfx().decompress(Uint8Array.of(0xe1, 1, 0, 9, 0, 0, 0)),
		).toThrow();
	});
});
