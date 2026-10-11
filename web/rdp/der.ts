// DER / BER の最低限。RDCleanPath と CredSSP の TSRequest、証明書から公開鍵を抜くのと、MCS の Connect Initial / Response に使う。
// タグは 1 バイト目そのまま(0x30 = SEQUENCE、0xa0 + n = 文脈 [n] の構造型)。MCS の 0x7f65 のような 2 バイトのタグも数として扱う。

import { concat } from "./bytes";

export const SEQUENCE = 0x30;
export const INTEGER = 0x02;
export const OCTET_STRING = 0x04;
export const BIT_STRING = 0x03;
export const BOOLEAN = 0x01;
export const ENUMERATED = 0x0a;
export const UTF8_STRING = 0x0c;
export const ctx = (n: number) => 0xa0 + n;

export type Tlv = {
	tag: number;
	/** 中身 */
	value: Uint8Array;
	/** この TLV の全体(タグから中身の終わりまで) */
	raw: Uint8Array;
};

/** buf の先頭から TLV を 1 つ読む。揃っていなければ null */
export function read(buf: Uint8Array, at = 0): (Tlv & { end: number }) | null {
	let p = at;
	if (p >= buf.length) return null;
	let tag = buf[p++] as number;
	if ((tag & 0x1f) === 0x1f) {
		// 長い形のタグ(MCS の APPLICATION 101 など)
		let b: number;
		do {
			if (p >= buf.length) return null;
			b = buf[p++] as number;
			tag = (tag << 8) | b;
		} while (b & 0x80);
	}
	if (p >= buf.length) return null;
	let len = buf[p++] as number;
	if (len & 0x80) {
		const n = len & 0x7f;
		if (n === 0 || n > 4) throw new Error(`DER: unsupported length form ${n}`);
		if (p + n > buf.length) return null;
		len = 0;
		for (let i = 0; i < n; i++) len = len * 256 + (buf[p++] as number);
	}
	if (p + len > buf.length) return null;
	return {
		tag,
		value: buf.subarray(p, p + len),
		raw: buf.subarray(at, p + len),
		end: p + len,
	};
}

export function mustRead(buf: Uint8Array, at = 0): Tlv & { end: number } {
	const t = read(buf, at);
	if (!t) throw new Error("DER: truncated");
	return t;
}

/** 中身に並んでいる TLV を全部 */
export function readAll(buf: Uint8Array): Tlv[] {
	const out: Tlv[] = [];
	let p = 0;
	while (p < buf.length) {
		const t = mustRead(buf, p);
		out.push(t);
		p = t.end;
	}
	return out;
}

/** SEQUENCE の中の文脈タグ [n] を引く(EXPLICIT なので中身の TLV を返す) */
export function fields(seq: Uint8Array): Map<number, Tlv> {
	const m = new Map<number, Tlv>();
	for (const f of readAll(seq)) {
		if ((f.tag & 0xe0) === 0xa0) m.set(f.tag & 0x1f, mustRead(f.value));
	}
	return m;
}

export function length(n: number): Uint8Array {
	if (n < 0x80) return Uint8Array.of(n);
	if (n < 0x100) return Uint8Array.of(0x81, n);
	if (n < 0x10000) return Uint8Array.of(0x82, n >> 8, n & 0xff);
	return Uint8Array.of(0x83, n >> 16, (n >> 8) & 0xff, n & 0xff);
}

function tagBytes(tag: number): Uint8Array {
	if (tag < 0x100) return Uint8Array.of(tag);
	if (tag < 0x10000) return Uint8Array.of(tag >> 8, tag & 0xff);
	return Uint8Array.of(tag >> 16, (tag >> 8) & 0xff, tag & 0xff);
}

export function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
	const body = concat(...parts);
	return concat(tagBytes(tag), length(body.length), body);
}

export function integer(v: number): Uint8Array {
	const b: number[] = [];
	let x = v;
	do {
		b.unshift(x & 0xff);
		x = Math.floor(x / 256);
	} while (x > 0);
	if ((b[0] as number) & 0x80) b.unshift(0);
	return tlv(INTEGER, Uint8Array.from(b));
}

export function readInteger(t: Tlv): number {
	let v = 0;
	for (const b of t.value) v = v * 256 + b;
	return v;
}

export const octets = (b: Uint8Array) => tlv(OCTET_STRING, b);
export const utf8 = (s: string) =>
	tlv(UTF8_STRING, new TextEncoder().encode(s));
export const field = (n: number, v: Uint8Array) => tlv(ctx(n), v);

/**
 * 証明書(DER)から SubjectPublicKeyInfo の subjectPublicKey(BIT STRING の中身、先頭の未使用ビット数は除く)を抜く。
 * CredSSP の pubKeyAuth はこれに結びつける
 *
 *   Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 *   TBSCertificate ::= SEQUENCE { [0] version OPTIONAL, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo, ... }
 */
export function subjectPublicKey(cert: Uint8Array): Uint8Array {
	const c = mustRead(cert);
	const tbs = mustRead(c.value);
	const items = readAll(tbs.value);
	const offset = items[0]?.tag === ctx(0) ? 1 : 0;
	const spki = items[offset + 5];
	if (!spki || spki.tag !== SEQUENCE) throw new Error("cert: no SPKI");
	const [, bits] = readAll(spki.value);
	if (!bits || bits.tag !== BIT_STRING) throw new Error("cert: no key");
	return bits.value.subarray(1);
}
