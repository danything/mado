// Intel AMT のリダイレクトのプロトコルで SOL(Serial over LAN)を話す。
// mado の /ws/amt が AMT の 16994(TLS なら 16995)に TCP でつなぐので、ここはその上のバイト列だけを扱う。
// メッセージの形は Intel の Device Management Toolkit の UI Toolkit(src/core/AMTRedirector.ts、Apache-2.0)と
// MeshCentral の amt-redir に合わせて書いた。コードは写していない。
//
//   → 0x10 StartRedirectionSession("SOL ")      ← 0x11 返事(13 バイト + OEM)
//   → 0x13 AuthenticateSession(種類を問う)      ← 0x14 使える認証の種類
//   → 0x13 Digest(ユーザー名だけ)              ← 0x14 realm と nonce(と qop)
//   → 0x13 Digest の応答                        ← 0x14 結果
//   → 0x20 SOL の設定                           ← 0x21 返事(23 バイト)
//   → 0x27 制御線                               ← 0x2A 端末の出力 / 0x29 制御線 / 0x2B 生存確認
//   → 0x28 キー入力、0x2B 生存確認(2 秒ごと)

import { concat, Reader, Writer } from "../rdp/bytes";
import type { Transport } from "../rdp/stream";
import { digestResponse, newCnonce } from "./digest";

export const MSG = {
  startRedirection: 0x10,
  startRedirectionReply: 0x11,
  endRedirection: 0x12,
  authenticate: 0x13,
  authenticateReply: 0x14,
  startSol: 0x20,
  startSolReply: 0x21,
  endSol: 0x22,
  solControls: 0x27,
  solDataToHost: 0x28,
  solControlsFromHost: 0x29,
  solDataFromHost: 0x2a,
  heartbeat: 0x2b,
  recording: 0xf0,
} as const;

/** 認証の種類(AuthenticateSession の authType) */
export const AUTH = { query: 0, basic: 1, digestLegacy: 3, digest: 4 } as const;

/** リダイレクトの Digest で使う uri */
export const REDIRECT_URI = "/RedirectionService";

/** AMT がユーザー名かパスワードを受け付けなかった */
export class RedirectAuthError extends Error {}

const ascii = new TextEncoder();
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

/** 1 バイトの長さ + 文字列 */
function lstr(w: Writer, s: string): void {
  const b = ascii.encode(s);
  if (b.length > 255) throw new Error("リダイレクトの文字列が長すぎます");
  w.u8(b.length).bytes(b);
}

/** AuthenticateSession。本文の長さを数えて頭を付ける */
export function authenticate(authType: number, body: Uint8Array): Uint8Array {
  return new Writer(9 + body.length)
    .u8(MSG.authenticate)
    .zeros(3)
    .u8(authType)
    .u32(body.length)
    .bytes(body)
    .done();
}

/** Digest の 1 回目。ユーザー名だけで、ほかは空 */
export function digestHello(username: string, authType: number): Uint8Array {
  const w = new Writer();
  lstr(w, username);
  w.u8(0).u8(0); // realm、nonce
  lstr(w, REDIRECT_URI);
  w.u8(0).u8(0).u8(0); // cnonce、nc、response
  if (authType === AUTH.digest) w.u8(0); // qop
  return authenticate(authType, w.done());
}

/** Digest の challenge(0x14 の authData)を読む */
export function parseDigestChallenge(
  data: Uint8Array,
  authType: number,
): { realm: string; nonce: string; qop?: string } {
  const r = new Reader(data);
  const realm = latin1(r.bytes(r.u8()));
  const nonce = latin1(r.bytes(r.u8()));
  const qop = authType === AUTH.digest ? latin1(r.bytes(r.u8())) : undefined;
  return { realm, nonce, qop };
}

/** Digest の応答 */
export function digestAnswer(
  username: string,
  password: string,
  ch: { realm: string; nonce: string; qop?: string },
  authType: number,
  cnonce: string = newCnonce(),
): Uint8Array {
  const nc = "00000002";
  const qop = authType === AUTH.digest ? ch.qop || "auth" : undefined;
  const response = digestResponse({
    username,
    password,
    realm: ch.realm,
    nonce: ch.nonce,
    method: "POST",
    uri: REDIRECT_URI,
    qop,
    nc,
    cnonce,
  });
  const w = new Writer();
  lstr(w, username);
  lstr(w, ch.realm);
  lstr(w, ch.nonce);
  lstr(w, REDIRECT_URI);
  lstr(w, cnonce);
  lstr(w, nc);
  lstr(w, response);
  if (qop) lstr(w, qop);
  return authenticate(authType, w.done());
}

/** 届いたメッセージ 1 つ */
export type Message = { type: number; data: Uint8Array };

/** メッセージを 1 つ読む。長さは種類で決まる */
export async function readMessage(io: Transport): Promise<Message> {
  const type = (await io.peek(1))[0] as number;
  const whole = async (n: number) => ({ type, data: await io.read(n) });
  switch (type) {
    case MSG.startRedirectionReply: {
      const h = await io.peek(4);
      if (h[1] !== 0) return whole(4);
      const oem = (await io.peek(13))[12] as number;
      return whole(13 + oem);
    }
    case MSG.authenticateReply: {
      const h = await io.peek(9);
      const len = new DataView(h.buffer, h.byteOffset).getUint32(5, true);
      if (len > 64 * 1024) throw new Error("AMT: 認証の返事が大きすぎます");
      return whole(9 + len);
    }
    case MSG.startSolReply:
      return whole(23);
    case MSG.solControlsFromHost:
      return whole(10);
    case MSG.solDataFromHost: {
      const h = await io.peek(10);
      return whole(10 + ((h[8] as number) | ((h[9] as number) << 8)));
    }
    case MSG.heartbeat:
      return whole(8);
    case MSG.recording:
      return whole(1);
    default:
      throw new Error(`AMT: 知らないメッセージです(0x${type.toString(16)})`);
  }
}

/** 生存確認や記録の知らせなど、手順の途中に挟まってもよいもの */
const isNoise = (m: Message) =>
  m.type === MSG.heartbeat ||
  m.type === MSG.recording ||
  m.type === MSG.solControlsFromHost;

async function expect(io: Transport, type: number): Promise<Message> {
  for (;;) {
    const m = await readMessage(io);
    if (m.type === type) return m;
    if (!isNoise(m))
      throw new Error(
        `AMT: 0x${type.toString(16)} を待っていましたが、0x${m.type.toString(16)} が届きました`,
      );
  }
}

/** 0x14 を読み解く */
function authReply(m: Message): {
  status: number;
  authType: number;
  data: Uint8Array;
} {
  return {
    status: m.data[1] as number,
    authType: m.data[4] as number,
    data: m.data.subarray(9),
  };
}

export type SolOptions = {
  username: string;
  password: string;
  /** 生存確認の間隔。試験では短くする */
  heartbeatMs?: number;
  /** cnonce を決める(試験用) */
  cnonce?: string;
};

/**
 * SOL の 1 本。start で認証まで済ませ、あとは onData に端末の出力を渡す。send でキー入力を送る
 */
export class SolSession {
  onData: (b: Uint8Array) => void = () => {};
  private seq = 0;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  /** 受信が終わったら(切れたら)解決する。理由の文 */
  readonly done: Promise<string>;
  private resolveDone!: (reason: string) => void;

  private constructor(private readonly io: Transport) {
    this.done = new Promise((r) => {
      this.resolveDone = r;
    });
  }

  /** リダイレクトを始めて、Digest で認証し、SOL を開く */
  static async start(io: Transport, o: SolOptions): Promise<SolSession> {
    const s = new SolSession(io);
    // 0x10 StartRedirectionSession: "SOL "
    io.write(
      new Uint8Array([MSG.startRedirection, 0, 0, 0, 0x53, 0x4f, 0x4c, 0x20]),
    );
    const start = await expect(io, MSG.startRedirectionReply);
    if (start.data[1] !== 0)
      throw new Error(
        `AMT が SOL を始めませんでした(状態 ${start.data[1]})。AMT の設定で SOL が有効か確かめてください`,
      );
    // 使える認証の種類を問う
    io.write(authenticate(AUTH.query, new Uint8Array()));
    const query = authReply(await expect(io, MSG.authenticateReply));
    const kinds = [...query.data];
    // Basic はパスワードがそのまま流れるので使わない
    const authType = kinds.includes(AUTH.digest)
      ? AUTH.digest
      : kinds.includes(AUTH.digestLegacy)
        ? AUTH.digestLegacy
        : undefined;
    if (authType === undefined)
      throw new Error(
        `AMT が Digest 認証を使えません(使えるもの: ${kinds.join(",") || "なし"})`,
      );
    io.write(digestHello(o.username, authType));
    const ch = authReply(await expect(io, MSG.authenticateReply));
    if (ch.status !== 1 || ch.authType !== authType)
      throw new RedirectAuthError(
        `AMT から Digest の challenge が届きません(状態 ${ch.status})`,
      );
    io.write(
      digestAnswer(
        o.username,
        o.password,
        parseDigestChallenge(ch.data, authType),
        authType,
        o.cnonce,
      ),
    );
    const result = authReply(await expect(io, MSG.authenticateReply));
    if (result.status !== 0)
      throw new RedirectAuthError("AMT のユーザー名かパスワードが違います");
    // 0x20 SOL の設定。値は UI Toolkit と同じ(送る緩衝 10000、送信の待ち 100ms、受信の待ち 10000ms、受信をまとめる 100ms、AMT からの生存確認なし)
    io.write(
      new Writer(24)
        .u8(MSG.startSol)
        .zeros(3)
        .u32(s.seq++)
        .u16(10000)
        .u16(100)
        .u16(0)
        .u16(10000)
        .u16(100)
        .u16(0)
        .u32(0)
        .done(),
    );
    await expect(io, MSG.startSolReply);
    // 0x27 制御線(UI Toolkit と同じ値)
    io.write(
      concat(
        new Writer(8).u8(MSG.solControls).zeros(3).u32(s.seq++).done(),
        new Uint8Array([0, 0, 0x1b, 0, 0, 0]),
      ),
    );
    s.timer = setInterval(() => s.heartbeat(), o.heartbeatMs ?? 2000);
    void s.loop();
    return s;
  }

  private heartbeat(): void {
    if (this.closed) return;
    this.io.write(
      new Writer(8).u8(MSG.heartbeat).zeros(3).u32(this.seq++).done(),
    );
  }

  private async loop(): Promise<void> {
    let reason = "切断されました";
    try {
      for (;;) {
        const m = await readMessage(this.io);
        if (m.type === MSG.solDataFromHost) this.onData(m.data.subarray(10));
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    } finally {
      this.stop();
      this.resolveDone(reason);
    }
  }

  /** キー入力を送る。1 つのメッセージは 64KB 未満に分ける */
  send(b: Uint8Array): void {
    if (this.closed) return;
    for (let i = 0; i < b.length; i += 4096) {
      const part = b.subarray(i, i + 4096);
      this.io.write(
        new Writer(10 + part.length)
          .u8(MSG.solDataToHost)
          .zeros(3)
          .u32(this.seq++)
          .u16(part.length)
          .bytes(part)
          .done(),
      );
    }
  }

  private stop(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  /** SOL とリダイレクトを終えて閉じる */
  close(): void {
    if (!this.closed) {
      this.io.write(
        new Writer(8).u8(MSG.endSol).zeros(3).u32(this.seq++).done(),
      );
      this.io.write(new Uint8Array([MSG.endRedirection, 0, 0, 0]));
    }
    this.stop();
    this.io.close();
  }
}
