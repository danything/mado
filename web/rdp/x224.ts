// TPKT と X.224([MS-RDPBCGR] 2.2.1)。接続要求と接続確認、TPKT / Fast-Path の PDU の切り出し。

import { concat, Reader, Writer } from "./bytes";
import type { ByteStream } from "./stream";

export const PROTOCOL = {
  RDP: 0,
  SSL: 1,
  HYBRID: 2,
} as const;

/** RDP_NEG_REQ 付きの X.224 Connection Request。TPKT ヘッダーも含め、RDCleanPath の x224_pdu にそのまま入れる */
export function connectionRequest(
  protocols: number = PROTOCOL.HYBRID,
): Uint8Array {
  const body = new Writer(16)
    .u8(0xe0) // CR
    .u16be(0) // DST-REF
    .u16be(0) // SRC-REF
    .u8(0) // クラス 0
    .u8(1) // RDP_NEG_REQ
    .u8(0) // flags
    .u16(8) // length
    .u32(protocols)
    .done();
  // 先頭の 1 バイトは LI で、あとに続く長さ
  return tpkt(concat(Uint8Array.of(body.length), body));
}

/** TPKT で包む。長さはヘッダーを含めた全体 */
function tpkt(payload: Uint8Array): Uint8Array {
  return concat(
    new Writer(4)
      .u8(3)
      .u8(0)
      .u16be(payload.length + 4)
      .done(),
    payload,
  );
}

/** X.224 Data TPDU(02 f0 80)を付けて TPKT で包む。MCS の PDU はこれで運ぶ */
export function data(payload: Uint8Array): Uint8Array {
  return tpkt(concat(Uint8Array.of(2, 0xf0, 0x80), payload));
}

export type ConnectionConfirm =
  | { ok: true; selectedProtocol: number; flags: number }
  | { ok: false; failureCode: number };

const FAILURES: Record<number, string> = {
  1: "サーバーが TLS を要求している(SSL_REQUIRED_BY_SERVER)",
  2: "サーバーは TLS を使わない(SSL_NOT_ALLOWED_BY_SERVER)",
  3: "サーバーに証明書が無い(SSL_CERT_NOT_ON_SERVER)",
  4: "要求した方式が合わない(INCONSISTENT_FLAGS)",
  5: "サーバーが NLA(CredSSP)を要求している(HYBRID_REQUIRED_BY_SERVER)",
  6: "サーバーが TLS を要求している(SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER)",
};

export function failureMessage(code: number): string {
  return FAILURES[code] ?? `RDP サーバーが接続を断った (${code})`;
}

/** TPKT ヘッダー付きの X.224 Connection Confirm を読む。RDP_NEG_RSP が無ければ標準 RDP とみなす */
export function parseConnectionConfirm(pdu: Uint8Array): ConnectionConfirm {
  const r = new Reader(pdu);
  if (r.u8() !== 3) throw new Error("X.224: TPKT ではない");
  r.skip(3);
  const li = r.u8();
  const end = r.pos + li;
  if (r.u8() !== 0xd0) throw new Error("X.224: Connection Confirm ではない");
  r.skip(5); // DST-REF, SRC-REF, クラス
  if (r.pos + 8 > end)
    return { ok: true, selectedProtocol: PROTOCOL.RDP, flags: 0 };
  const type = r.u8();
  const flags = r.u8();
  r.u16();
  const value = r.u32();
  if (type === 3) return { ok: false, failureCode: value };
  if (type !== 2) throw new Error(`X.224: 知らないネゴシエーション ${type}`);
  return { ok: true, selectedProtocol: value, flags };
}

export type Pdu =
  | { kind: "slowpath"; data: Uint8Array }
  | { kind: "fastpath"; data: Uint8Array };

/**
 * 次の PDU を 1 つ切り出す。先頭が 0x03 なら TPKT で、data は X.224 Data の 3 バイトの後ろ。
 * それ以外は Fast-Path で、data はヘッダーの後ろ。Fast-Path は先頭の action が 0 のものしか来ない
 */
export async function readPdu(s: ByteStream): Promise<Pdu> {
  const first = (await s.peek(1))[0] as number;
  if (first === 3) {
    const h = await s.peek(4);
    const len = ((h[2] as number) << 8) | (h[3] as number);
    // 短すぎる長さのまま読むとヘッダーの途中で止まって、以降の流れがずれる
    if (len < 7) throw new Error(`TPKT: 長さが不正 (${len})`);
    const all = await s.read(len);
    // X.224 Data TPDU は 02 f0 80。Connection Confirm などほかのものは丸ごと返す
    if (all[4] === 2 && all[5] === 0xf0 && all[6] === 0x80)
      return { kind: "slowpath", data: all.subarray(7) };
    return { kind: "slowpath", data: all.subarray(4) };
  }
  const h = await s.peek(2);
  let len = h[1] as number;
  let head = 2;
  if (len & 0x80) {
    const h3 = await s.peek(3);
    len = (((h3[1] as number) & 0x7f) << 8) | (h3[2] as number);
    head = 3;
  }
  if (len < head) throw new Error(`Fast-Path: 長さが不正 (${len})`);
  const all = await s.read(len);
  return { kind: "fastpath", data: all.subarray(head) };
}
