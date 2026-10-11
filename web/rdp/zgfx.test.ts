// ZGFX(RDP8 bulk)の伸長の試験。試験側の簡単な符号化器(文字・一致・生の並び)で往復する。

import { describe, expect, test } from "bun:test";
import { hex } from "./bytes";
import { segmentedUncompressed, ZGFX_TOKENS, Zgfx } from "./zgfx";

class BitWriter {
	private bytes: number[] = [];
	private cur = 0;
	private n = 0;
	bits(v: number, count: number): this {
		for (let i = count - 1; i >= 0; i--) {
			this.cur = (this.cur << 1) | (Math.floor(v / 2 ** i) & 1);
			if (++this.n === 8) {
				this.bytes.push(this.cur);
				this.cur = 0;
				this.n = 0;
			}
		}
		return this;
	}
	align(): this {
		if (this.n) this.bits(0, 8 - this.n);
		return this;
	}
	raw(b: Uint8Array): this {
		for (const x of b) this.bytes.push(x);
		return this;
	}
	/** 末尾に「使わないビットの数」を足して返す */
	done(): Uint8Array {
		let unused = 0;
		if (this.n) {
			unused = 8 - this.n;
			this.bits(0, unused);
		}
		return Uint8Array.from([...this.bytes, unused]);
	}
}

const literalTokens = ZGFX_TOKENS.filter((t) => !t.match);
const matchTokens = ZGFX_TOKENS.filter((t) => t.match);

function writeLiteral(w: BitWriter, b: number): void {
	const fixed = literalTokens.find(
		(t) => t.valueBits === 0 && t.valueBase === b,
	);
	if (fixed) w.bits(fixed.prefixCode, fixed.prefixLength);
	else w.bits(0, 1).bits(b, 8);
}

function writeMatch(w: BitWriter, distance: number, count: number): void {
	const t = matchTokens.find(
		(t) => distance >= t.valueBase && distance < t.valueBase + 2 ** t.valueBits,
	);
	if (!t) throw new Error("distance");
	w.bits(t.prefixCode, t.prefixLength).bits(
		distance - t.valueBase,
		t.valueBits,
	);
	if (count === 3) w.bits(0, 1);
	else {
		let m = 0;
		while (count >= 4 * 2 ** (m + 1)) m++;
		w.bits(1, 1);
		for (let i = 0; i < m; i++) w.bits(1, 1);
		w.bits(0, 1).bits(count - 4 * 2 ** m, 2 + m);
	}
}

/** 欲張りの一致探し(同じセグメントの中だけ)。rawFrom 以降は「生の並び」で送る */
function encode(data: Uint8Array, rawFrom = data.length): Uint8Array {
	const w = new BitWriter();
	let i = 0;
	while (i < rawFrom) {
		let best = 0;
		let bestD = 0;
		for (let d = 1; d <= i && d < 5000; d++) {
			let n = 0;
			while (i + n < rawFrom && data[i + n] === data[i + n - d] && n < 600) n++;
			if (n > best) {
				best = n;
				bestD = d;
			}
		}
		if (best >= 3) {
			writeMatch(w, bestD, best);
			i += best;
		} else writeLiteral(w, data[i++] as number);
	}
	if (rawFrom < data.length) {
		// distance 0 の一致 = 生の並び
		w.bits(0b10001, 5)
			.bits(0, 5)
			.bits(data.length - rawFrom, 15)
			.align();
		w.raw(data.subarray(rawFrom));
	}
	const body = w.done();
	const out = new Uint8Array(body.length + 2);
	out[0] = 0xe0;
	out[1] = 0x24; // RDP8 + PACKET_COMPRESSED
	out.set(body, 2);
	return out;
}

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
