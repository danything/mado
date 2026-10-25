// 最低限の DER / BER。RDCleanPath、CredSSP の TSRequest、証明書からの公開鍵の取り出し、MCS の Connect Initial / Response で使う。
// タグは 1 バイト目をそのまま数として扱う。0x30 は SEQUENCE、0xa0 + n は文脈 [n] の構造型。MCS の 0x7f65 のような 2 バイトのタグも 1 つの数にする。

import { concat } from "./bytes";
import type { ByteStream } from "./stream";

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
  /** タグから中身の終わりまでの、この TLV の全体 */
  raw: Uint8Array;
};

/** buf の先頭から TLV を 1 つ読む。揃っていなければ null */
export function read(buf: Uint8Array, at = 0): (Tlv & { end: number }) | null {
  let p = at;
  if (p >= buf.length) return null;
  let tag = buf[p++] as number;
  if ((tag & 0x1f) === 0x1f) {
    // MCS の APPLICATION 101 などの、長い形のタグ
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
    if (n === 0 || n > 4) throw new Error(`DER: 長さの形が使えない (${n})`);
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
  if (!t) throw new Error("DER: 途中で切れている");
  return t;
}

/** 中身に並んでいる TLV をすべて読む */
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

/** SEQUENCE の中の文脈タグ [n] を探す。EXPLICIT なので、中に包まれた TLV を返す */
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
 * DER の証明書から、SubjectPublicKeyInfo の subjectPublicKey を取り出す。
 * 返すのは BIT STRING の中身で、先頭の未使用ビット数は除く。CredSSP の pubKeyAuth はこれに結びつける
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
  if (!spki || spki.tag !== SEQUENCE)
    throw new Error("証明書: 公開鍵の欄(SPKI)が無い");
  const [, bits] = readAll(spki.value);
  if (!bits || bits.tag !== BIT_STRING) throw new Error("証明書: 公開鍵が無い");
  return bits.value.subarray(1);
}

/** 証明書を確かめる画面に出すもの。読めなかった欄は無い */
export type CertInfo = {
  /** subject の CN(commonName)。RDP の自己署名証明書なら PC の名前 */
  commonName?: string;
  notBefore?: Date;
  notAfter?: Date;
};

/** commonName の OID 2.5.4.3 */
const CN_OID = "550403";

/**
 * DER の証明書から、subject の CN と有効期間を読む。見せるためだけのものなので、読めなければ空で返す
 *
 *   Validity ::= SEQUENCE { notBefore Time, notAfter Time }
 *   Name ::= SEQUENCE OF SET OF SEQUENCE { type OID, value }
 */
export function certInfo(cert: Uint8Array): CertInfo {
  try {
    const tbs = mustRead(mustRead(cert).value);
    const items = readAll(tbs.value);
    const offset = items[0]?.tag === ctx(0) ? 1 : 0;
    const info: CertInfo = {};
    const validity = items[offset + 3];
    if (validity?.tag === SEQUENCE) {
      const [from, to] = readAll(validity.value);
      info.notBefore = from && readTime(from);
      info.notAfter = to && readTime(to);
    }
    const subject = items[offset + 4];
    if (subject?.tag === SEQUENCE)
      for (const rdn of readAll(subject.value))
        for (const atv of readAll(rdn.value)) {
          const [type, value] = readAll(atv.value);
          if (type?.tag === 0x06 && value && toHex(type.value) === CN_OID)
            info.commonName = readString(value);
        }
    return info;
  } catch {
    return {};
  }
}

const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** UTCTime(0x17、年は 2 桁)と GeneralizedTime(0x18)。どちらも UTC の Z で終わる形だけ読む */
function readTime(t: Tlv): Date | undefined {
  const s = new TextDecoder().decode(t.value);
  const m =
    t.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
      : t.tag === 0x18
        ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
        : null;
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as number[];
  // UTCTime の年は 50 以上なら 19xx、それ未満なら 20xx(RFC 5280 4.1.2.5.1)
  const year =
    t.tag === 0x17 ? (y as number) + ((y as number) >= 50 ? 1900 : 2000) : y;
  return new Date(Date.UTC(year as number, (mo as number) - 1, d, h, mi, se));
}

/** 名前の値。BMPString(0x1e)は UTF-16BE、そのほか(UTF8String、PrintableString など)は UTF-8 として読む */
function readString(t: Tlv): string {
  if (t.tag === 0x1e) {
    let s = "";
    for (let i = 0; i + 1 < t.value.length; i += 2)
      s += String.fromCharCode(
        ((t.value[i] as number) << 8) | (t.value[i + 1] as number),
      );
    return s;
  }
  return new TextDecoder().decode(t.value);
}

/** 流れから TLV を 1 つ、タグから中身の終わりまで読む。中身が max バイトを超えたら tooLarge の例外にする */
export async function readFrom(
  s: ByteStream,
  max: number,
  tooLarge: string,
): Promise<Uint8Array> {
  const head = await s.peek(2);
  let headLen = 2;
  let len = head[1] as number;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error(`DER: 長さの形が使えない (${n})`);
    const h = await s.peek(2 + n);
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (h[2 + i] as number);
    headLen += n;
  }
  if (len > max) throw new Error(tooLarge);
  return s.read(headLen + len);
}
