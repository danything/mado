// 試験用: ZGFX の簡単な符号化器(文字・一致・生の並び)。zgfx.test.ts と tools/zgfx-bench.ts が使う

import { ZGFX_TOKENS } from "./zgfx";

export class BitWriter {
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

export function writeMatch(
	w: BitWriter,
	distance: number,
	count: number,
): void {
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
export function encode(data: Uint8Array, rawFrom = data.length): Uint8Array {
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
