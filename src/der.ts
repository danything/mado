// RDCleanPath と証明書の署名要求(CSR、acme.ts)に要るだけの DER(ASN.1)の読み書き。
// 長さは長形式まで読む(サーバー証明書の連なりは 127 バイトを超える)。

export const Tag = {
	Integer: 0x02,
	BitString: 0x03,
	OctetString: 0x04,
	Oid: 0x06,
	Utf8String: 0x0c,
	Sequence: 0x30,
	Set: 0x31,
	/** [n] EXPLICIT(構造化・文脈タグ) */
	context: (n: number) => 0xa0 | n,
} as const;

export type Tlv = { tag: number; value: Uint8Array; end: number };

/** `buf[at]` から 1 つ読む。足りなければ null(続きを待つ) */
export function readTlv(buf: Uint8Array, at = 0): Tlv | null {
	if (buf.length < at + 2) return null;
	const tag = buf[at] as number;
	let len = buf[at + 1] as number;
	let head = 2;
	if (len & 0x80) {
		const n = len & 0x7f;
		if (n === 0 || n > 4)
			throw new Error(`DER: unsupported length form (${n})`);
		if (buf.length < at + 2 + n) return null;
		len = 0;
		for (let i = 0; i < n; i++) len = len * 256 + (buf[at + 2 + i] as number);
		head += n;
	}
	const start = at + head;
	if (buf.length < start + len) return null;
	return { tag, value: buf.subarray(start, start + len), end: start + len };
}

/** 中身を順に全部読む(SEQUENCE や文脈タグの中) */
export function readAll(buf: Uint8Array): Tlv[] {
	const out: Tlv[] = [];
	let at = 0;
	while (at < buf.length) {
		const t = readTlv(buf, at);
		if (!t) throw new Error("DER: truncated");
		out.push(t);
		at = t.end;
	}
	return out;
}

function lengthBytes(n: number): number[] {
	if (n < 0x80) return [n];
	const b: number[] = [];
	for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff);
	return [0x80 | b.length, ...b];
}

export function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
	const body = concat(parts);
	return concat([Uint8Array.of(tag, ...lengthBytes(body.length)), body]);
}

export function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** 0 以上の整数(2 の補数で最小の長さ。先頭が 0x80 以上なら 0x00 を足す) */
export function integer(n: number | bigint): Uint8Array {
	let v = BigInt(n);
	if (v < 0n) throw new Error("DER: negative integers are not used");
	const b: number[] = [];
	do {
		b.unshift(Number(v & 0xffn));
		v >>= 8n;
	} while (v > 0n);
	if ((b[0] as number) & 0x80) b.unshift(0);
	return tlv(Tag.Integer, Uint8Array.from(b));
}

export function readInteger(t: Tlv): bigint {
	if (t.tag !== Tag.Integer)
		throw new Error(`DER: expected INTEGER, got 0x${t.tag.toString(16)}`);
	let v = 0n;
	for (const x of t.value) v = (v << 8n) | BigInt(x);
	return v;
}

export const utf8 = (s: string) =>
	tlv(Tag.Utf8String, new TextEncoder().encode(s));

export function readUtf8(t: Tlv): string {
	if (t.tag !== Tag.Utf8String)
		throw new Error(`DER: expected UTF8String, got 0x${t.tag.toString(16)}`);
	return new TextDecoder().decode(t.value);
}

export const octets = (b: Uint8Array) => tlv(Tag.OctetString, b);

/** 使わないビットは 0 個(署名や鍵はバイト単位) */
export const bitString = (b: Uint8Array) =>
	tlv(Tag.BitString, Uint8Array.of(0), b);

/** "1.2.840.10045.4.3.2" の形 */
export function oid(dotted: string): Uint8Array {
	const [a, b, ...rest] = dotted.split(".").map(Number) as [
		number,
		number,
		...number[],
	];
	const out = [a * 40 + b];
	for (const n of rest) {
		const b7: number[] = [];
		for (let v = n; ; v = Math.floor(v / 128)) {
			b7.unshift((v & 0x7f) | (b7.length ? 0x80 : 0));
			if (v < 128) break;
		}
		out.push(...b7);
	}
	return tlv(Tag.Oid, Uint8Array.from(out));
}

export function readOctets(t: Tlv): Uint8Array {
	if (t.tag !== Tag.OctetString)
		throw new Error(`DER: expected OCTET STRING, got 0x${t.tag.toString(16)}`);
	return t.value;
}
