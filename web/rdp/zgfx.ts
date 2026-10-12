// RDP8 の bulk 圧縮(ZGFX、[MS-RDPEGFX] 2.2.5 / 3.1.9.1)を伸長する。GFX でサーバーから来る PDU はこれで包まれている。
// RDP_SEGMENTED_DATA には 1 つか複数のセグメントが入る。各セグメントの RDP8_BULK_ENCODED_DATA を伸長して、つなげる。
// 履歴は 2.5MB の輪で、セッションを通して続く。だから 1 つの Zgfx を使い続ける。

const SEGMENTED_SINGLE = 0xe0;
const SEGMENTED_MULTIPART = 0xe1;
const PACKET_COMPRESSED = 0x20;
const HISTORY_SIZE = 2_500_000;
/** 1 つのメッセージの伸長後の大きさの上限 */
const MAX_OUTPUT = 1 << 26;

type Token = {
	/** 接頭辞のビット数と値 */
	prefixLength: number;
	prefixCode: number;
	/** 続くビット数 */
	valueBits: number;
	/** 0 なら文字(literal)、1 なら一致(match。履歴の距離) */
	match: boolean;
	valueBase: number;
};

/** [MS-RDPEGFX] 3.1.9.1.2 の表。短い接頭辞から順に試す */
const TOKENS: Token[] = (
	[
		[1, 0b0, 8, 0, 0],
		[5, 0b10001, 5, 1, 0],
		[5, 0b10010, 7, 1, 32],
		[5, 0b10011, 9, 1, 160],
		[5, 0b10100, 10, 1, 672],
		[5, 0b10101, 12, 1, 1696],
		[5, 0b11000, 0, 0, 0x00],
		[5, 0b11001, 0, 0, 0x01],
		[6, 0b101100, 14, 1, 5792],
		[6, 0b101101, 15, 1, 22176],
		[6, 0b110100, 0, 0, 0x02],
		[6, 0b110101, 0, 0, 0x03],
		[6, 0b110110, 0, 0, 0xff],
		[7, 0b1011100, 18, 1, 54944],
		[7, 0b1011101, 20, 1, 317088],
		[7, 0b1101110, 0, 0, 0x04],
		[7, 0b1101111, 0, 0, 0x05],
		[7, 0b1110000, 0, 0, 0x06],
		[7, 0b1110001, 0, 0, 0x07],
		[7, 0b1110010, 0, 0, 0x08],
		[7, 0b1110011, 0, 0, 0x09],
		[7, 0b1110100, 0, 0, 0x0a],
		[7, 0b1110101, 0, 0, 0x0b],
		[7, 0b1110110, 0, 0, 0x3a],
		[7, 0b1110111, 0, 0, 0x3b],
		[7, 0b1111000, 0, 0, 0x3c],
		[7, 0b1111001, 0, 0, 0x3d],
		[7, 0b1111010, 0, 0, 0x3e],
		[7, 0b1111011, 0, 0, 0x3f],
		[7, 0b1111100, 0, 0, 0x40],
		[7, 0b1111101, 0, 0, 0x80],
		[8, 0b10111100, 20, 1, 1365664],
		[8, 0b10111101, 21, 1, 2414240],
		[8, 0b11111100, 0, 0, 0x0c],
		[8, 0b11111101, 0, 0, 0x38],
		[8, 0b11111110, 0, 0, 0x39],
		[8, 0b11111111, 0, 0, 0x66],
		[9, 0b101111100, 22, 1, 4510880],
		[9, 0b101111101, 23, 1, 8705184],
		[9, 0b101111110, 24, 1, 17093792],
		[9, 0b101111111, 25, 1, 33870752],
	] as const
).map(([prefixLength, prefixCode, valueBits, match, valueBase]) => ({
	prefixLength,
	prefixCode,
	valueBits,
	match: match === 1,
	valueBase,
}));

export { TOKENS as ZGFX_TOKENS };

/** 接頭辞は最長 9 ビット。先頭 9 ビットで引く表を作る。接頭辞の符号はどれもほかの接頭辞にならないので、一意に決まる */
const PREFIX_BITS = 9;
const PREFIX_TABLE: (Token | undefined)[] = (() => {
	const table: (Token | undefined)[] = new Array(1 << PREFIX_BITS);
	for (const t of TOKENS) {
		const shift = PREFIX_BITS - t.prefixLength;
		const base = t.prefixCode << shift;
		for (let i = 0; i < 1 << shift; i++) table[base + i] = t;
	}
	return table;
})();

/** 上位ビットから読む。32 ビットの窓でまとめて取り出す */
class BitReader {
	private pos = 0;
	constructor(
		private data: Uint8Array,
		/** 使ってよいビット数 */
		private limit: number,
	) {}
	get left(): number {
		return this.limit - this.pos;
	}
	/** 今の位置から n ビット(1〜25)を、進めずに見る。入力の終わりより先は 0 */
	peek(n: number): number {
		const p = this.pos;
		const i = p >> 3;
		const d = this.data;
		const len = d.length;
		const w =
			(((i < len ? (d[i] as number) : 0) << 24) |
				((i + 1 < len ? (d[i + 1] as number) : 0) << 16) |
				((i + 2 < len ? (d[i + 2] as number) : 0) << 8) |
				(i + 3 < len ? (d[i + 3] as number) : 0)) >>>
			0;
		return ((w << (p & 7)) >>> 0) >>> (32 - n);
	}
	skip(n: number): void {
		if (this.pos + n > this.limit) throw new Error("ZGFX: 入力が足りない");
		this.pos += n;
	}
	bits(n: number): number {
		if (n === 0) return 0;
		if (this.pos + n > this.limit) throw new Error("ZGFX: 入力が足りない");
		if (n <= 25) {
			const v = this.peek(n);
			this.pos += n;
			return v;
		}
		// 26 ビット以上は 2 回に分けて読む。一致の長さの続きで使う
		const hi = this.bits(n - 16);
		return hi * 65536 + this.bits(16);
	}
	/** 次のバイトの境目まで読み飛ばす */
	align(): void {
		this.pos = (this.pos + 7) & ~7;
	}
	get bytePos(): number {
		return this.pos >> 3;
	}
	skipBytes(n: number): void {
		this.pos += n * 8;
	}
}

/** 伸長の出力。倍々に伸ばす */
class Output {
	buf = new Uint8Array(64 * 1024);
	len = 0;
	reserve(n: number): void {
		const need = this.len + n;
		if (need > MAX_OUTPUT) throw new Error("ZGFX: 大きすぎる");
		if (need <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < need) size *= 2;
		const b = new Uint8Array(Math.min(size, MAX_OUTPUT));
		b.set(this.buf.subarray(0, this.len));
		this.buf = b;
	}
}

export class Zgfx {
	private history = new Uint8Array(HISTORY_SIZE);
	private index = 0;

	/** RDP_SEGMENTED_DATA を伸長する */
	decompress(data: Uint8Array): Uint8Array {
		if (data.length < 1) throw new Error("ZGFX: 空");
		const desc = data[0] as number;
		if (desc === SEGMENTED_SINGLE) return this.segment(data.subarray(1));
		if (desc !== SEGMENTED_MULTIPART)
			throw new Error(`ZGFX: 知らない descriptor 0x${desc.toString(16)}`);
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		if (data.length < 7) throw new Error("ZGFX: 短い");
		const count = dv.getUint16(1, true);
		const total = dv.getUint32(3, true);
		if (total > MAX_OUTPUT) throw new Error("ZGFX: 大きすぎる");
		const out = new Uint8Array(total);
		let at = 7;
		let o = 0;
		for (let i = 0; i < count; i++) {
			if (at + 4 > data.length) throw new Error("ZGFX: セグメントが足りない");
			const size = dv.getUint32(at, true);
			at += 4;
			if (at + size > data.length) throw new Error("ZGFX: セグメントが短い");
			const seg = this.segment(data.subarray(at, at + size));
			at += size;
			if (o + seg.length > total) throw new Error("ZGFX: 大きさが合わない");
			out.set(seg, o);
			o += seg.length;
		}
		if (o !== total) throw new Error("ZGFX: 大きさが合わない");
		return out;
	}

	/** RDP8_BULK_ENCODED_DATA。先頭 1 バイトが header で、続きがデータ */
	private segment(seg: Uint8Array): Uint8Array {
		if (seg.length < 1) throw new Error("ZGFX: セグメントが空");
		const header = seg[0] as number;
		const body = seg.subarray(1);
		if (!(header & PACKET_COMPRESSED)) {
			for (const b of body) this.push(b);
			return body.slice();
		}
		if (body.length < 1) throw new Error("ZGFX: 圧縮データが空");
		// 最後のバイトは、その前のバイトの末尾の使わないビットの数
		const unused = body[body.length - 1] as number;
		const bytes = body.subarray(0, body.length - 1);
		const r = new BitReader(bytes, bytes.length * 8 - unused);
		const out = new Output();
		const hist = this.history;
		while (r.left > 0) {
			// 末尾の詰め物。使わないビットは数えてあるので、残りが接頭辞に足りなければ終わり
			const token = PREFIX_TABLE[r.peek(PREFIX_BITS)];
			if (!token) throw new Error("ZGFX: 知らない符号");
			if (token.prefixLength > r.left) break;
			r.skip(token.prefixLength);
			if (!token.match) {
				out.reserve(1);
				const v = token.valueBase + r.bits(token.valueBits);
				out.buf[out.len++] = v;
				this.push(v);
				continue;
			}
			const distance = token.valueBase + r.bits(token.valueBits);
			if (distance !== 0) {
				let count: number;
				if (r.bits(1) === 0) count = 3;
				else {
					count = 4;
					let extra = 2;
					while (r.bits(1) === 1) {
						count *= 2;
						extra++;
						if (extra > 31) throw new Error("ZGFX: 長さが大きすぎる");
					}
					count += r.bits(extra);
				}
				if (distance > HISTORY_SIZE) throw new Error("ZGFX: 距離が大きすぎる");
				out.reserve(count);
				const o = out.buf;
				let at = out.len;
				let from = this.index - distance;
				if (from < 0) from += HISTORY_SIZE;
				let to = this.index;
				for (let i = 0; i < count; i++) {
					const v = hist[from] as number;
					o[at++] = v;
					hist[to] = v;
					if (++from === HISTORY_SIZE) from = 0;
					if (++to === HISTORY_SIZE) to = 0;
				}
				out.len = at;
				this.index = to;
			} else {
				// 符号化しない並び。15 ビットの長さのあと、バイトの境目から生のバイトが続く
				const count = r.bits(15);
				r.align();
				const at = r.bytePos;
				if (at + count > bytes.length) throw new Error("ZGFX: 生の並びが短い");
				out.reserve(count);
				for (let i = 0; i < count; i++) {
					const v = bytes[at + i] as number;
					out.buf[out.len++] = v;
					this.push(v);
				}
				r.skipBytes(count);
			}
		}
		return out.buf.slice(0, out.len);
	}

	/** 履歴の輪に 1 バイト足す */
	private push(b: number): void {
		this.history[this.index] = b;
		this.index = this.index + 1 === HISTORY_SIZE ? 0 : this.index + 1;
	}
}

/** 試験用。圧縮しない RDP_SEGMENTED_DATA を 1 セグメントで作る */
export function segmentedUncompressed(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length + 2);
	out[0] = SEGMENTED_SINGLE;
	out[1] = 0x04; // RDP8、圧縮なし
	out.set(data, 2);
	return out;
}
