// 試験用の偽の Intel AMT。WS-Man(Digest、列挙、電源の操作)と、リダイレクト(Digest、SOL)の最低限だけを話す。
// bun test と tools/amt-e2e で使う。本物の AMT の返事の形は Intel の AMT SDK と UI Toolkit に合わせた。

import { concat, Reader, Writer } from "../rdp/bytes";
import { StreamClosed, type Transport } from "../rdp/stream";
import { digestResponse, parseDigestParams } from "./digest";
import { AUTH, MSG, REDIRECT_URI } from "./redirect";

export const FAKE = {
  username: "admin",
  password: "P@ssw0rd!",
  realm: "Digest:0123456789ABCDEF0123456789ABCDEF",
};

/** 届いたかたまりを溜めて要る分だけ切り出す。片方の口。push で届いたことにする */
export class BufferedTransport implements Transport {
  private chunks: Uint8Array[] = [];
  private have = 0;
  private waiter?: () => void;
  private closed?: Error;

  constructor(
    private readonly send: (b: Uint8Array) => void,
    private readonly onClose: () => void = () => {},
  ) {}

  push(b: Uint8Array): void {
    if (b.length === 0) return;
    this.chunks.push(b);
    this.have += b.length;
    this.wake();
  }

  end(e: Error = new StreamClosed("closed")): void {
    this.closed ??= e;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  private async fill(n: number): Promise<void> {
    while (this.have < n) {
      if (this.closed) throw this.closed;
      await new Promise<void>((r) => {
        this.waiter = r;
      });
    }
  }

  async peek(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const all = concat(...this.chunks);
    this.chunks = [all];
    return all.subarray(0, n);
  }

  async read(n: number): Promise<Uint8Array> {
    const b = (await this.peek(n)).slice();
    const all = this.chunks[0] as Uint8Array;
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    this.have -= n;
    return b;
  }

  write(b: Uint8Array): void {
    if (!this.closed) this.send(b.slice());
  }

  close(): void {
    this.end();
    this.onClose();
  }
}

/** つながった 2 つの口(ブラウザ側と AMT 側) */
export function pipe(): [BufferedTransport, BufferedTransport] {
  const a: BufferedTransport = new BufferedTransport(
    (x) => b.push(x),
    () => b.end(),
  );
  const b: BufferedTransport = new BufferedTransport(
    (x) => a.push(x),
    () => a.end(),
  );
  return [a, b];
}

// ---- WS-Man ----

export type WsmanRequest = { authorization?: string; body: string };
export type WsmanReply = {
  status: number;
  /** WWW-Authenticate */
  authenticate?: string;
  body: string;
};

const envelopeOf = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><a:Envelope xmlns:a="http://www.w3.org/2003/05/soap-envelope" xmlns:b="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:g="http://schemas.xmlsoap.org/ws/2004/09/enumeration" xmlns:h="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_AssociatedPowerManagementService"><a:Header></a:Header><a:Body>${body}</a:Body></a:Envelope>`;

/** 偽の AMT の WS-Man。Digest を確かめ、電源の状態を覚える */
export class FakeWsman {
  powerState = 2;
  /** 頼まれた電源の操作 */
  readonly requests: number[] = [];
  /** 届いた Authorization(そのまま届いたかを見る) */
  readonly authorizations: string[] = [];
  private nonce = "";
  private usedNc = new Set<string>();

  constructor(
    private readonly username = FAKE.username,
    private readonly password = FAKE.password,
  ) {
    this.newNonce();
  }

  private newNonce(): void {
    this.nonce = crypto.randomUUID().replaceAll("-", "");
    this.usedNc.clear();
  }

  /** nonce を切らす(次の要求は stale で断る) */
  expireNonce(): void {
    this.newNonce();
  }

  /** 断るたびに新しい nonce を出す(別のクライアントが同じ nonce で nc を使い終えていても、取り直せば通る) */
  private challenge(): WsmanReply {
    this.newNonce();
    return {
      status: 401,
      authenticate: `Digest realm="${FAKE.realm}", nonce="${this.nonce}", stale="false", qop="auth"`,
      body: "",
    };
  }

  handle(req: WsmanRequest): WsmanReply {
    if (!req.authorization) return this.challenge();
    this.authorizations.push(req.authorization);
    const p = parseDigestParams(req.authorization);
    if (
      !p ||
      p.realm !== FAKE.realm ||
      p.nonce !== this.nonce ||
      p.uri !== "/wsman" ||
      p.username !== this.username ||
      p.qop !== "auth" ||
      !p.nc ||
      this.usedNc.has(p.nc)
    )
      return this.challenge();
    const want = digestResponse({
      username: this.username,
      password: this.password,
      realm: FAKE.realm,
      nonce: this.nonce,
      method: "POST",
      uri: "/wsman",
      qop: "auth",
      nc: p.nc,
      cnonce: p.cnonce,
    });
    if (p.response !== want) return this.challenge();
    this.usedNc.add(p.nc);
    return { status: 200, body: this.soap(req.body) };
  }

  private soap(body: string): string {
    if (body.includes("/enumeration/Enumerate"))
      return envelopeOf(
        `<g:EnumerateResponse><g:EnumerationContext>ctx-1</g:EnumerationContext></g:EnumerateResponse>`,
      );
    if (body.includes("/enumeration/Pull")) {
      const on = this.powerState === 2;
      const available = on ? [5, 8, 10] : [2];
      return envelopeOf(
        `<g:PullResponse><g:Items><h:CIM_AssociatedPowerManagementService>` +
          available
            .map(
              (v) =>
                `<h:AvailableRequestedPowerStates>${v}</h:AvailableRequestedPowerStates>`,
            )
            .join("") +
          `<h:PowerState>${this.powerState}</h:PowerState><h:RequestedPowerState>2</h:RequestedPowerState>` +
          `</h:CIM_AssociatedPowerManagementService></g:Items><g:EndOfSequence></g:EndOfSequence></g:PullResponse>`,
      );
    }
    const m = /<r:PowerState>(\d+)<\/r:PowerState>/.exec(body);
    if (body.includes("RequestPowerStateChange_INPUT") && m) {
      const v = Number(m[1]);
      this.requests.push(v);
      this.powerState = v === 2 || v === 5 || v === 10 ? 2 : 8;
      return envelopeOf(
        `<g:RequestPowerStateChange_OUTPUT xmlns:g="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_PowerManagementService"><g:ReturnValue>0</g:ReturnValue></g:RequestPowerStateChange_OUTPUT>`,
      );
    }
    return envelopeOf(
      `<a:Fault><a:Code><a:Value>a:Sender</a:Value></a:Code><a:Reason><a:Text xml:lang="en-US">The action is not supported by the service.</a:Text></a:Reason></a:Fault>`,
    );
  }
}

// ---- リダイレクト(SOL) ----

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

/** AuthenticateSessionReply(0x14) */
function authReply(
  status: number,
  authType: number,
  data: Uint8Array,
): Uint8Array {
  return new Writer(9 + data.length)
    .u8(MSG.authenticateReply)
    .u8(status)
    .zeros(2)
    .u8(authType)
    .u32(data.length)
    .bytes(data)
    .done();
}

function lstrs(...s: string[]): Uint8Array {
  const w = new Writer();
  for (const x of s) {
    const b = new TextEncoder().encode(x);
    w.u8(b.length).bytes(b);
  }
  return w.done();
}

/** SOL の端末の出力(0x2A) */
export function solData(seq: number, data: Uint8Array): Uint8Array {
  return new Writer(10 + data.length)
    .u8(MSG.solDataFromHost)
    .zeros(3)
    .u32(seq)
    .u16(data.length)
    .bytes(data)
    .done();
}

export type FakeRedirectOptions = {
  username?: string;
  password?: string;
  /** つないだらすぐ送る端末の出力 */
  banner?: string;
};

/**
 * 偽の AMT のリダイレクト。Digest を確かめ、SOL を開く。届いたキー入力は大文字にして端末の出力として返す。
 * 終わり方(認証の失敗、SOL の終わり、切断)を返す
 */
export async function serveRedirect(
  io: Transport,
  o: FakeRedirectOptions = {},
): Promise<"auth-failed" | "ended" | "closed"> {
  const username = o.username ?? FAKE.username;
  const password = o.password ?? FAKE.password;
  const nonce = crypto.randomUUID().replaceAll("-", "");
  let seq = 0;
  try {
    const start = await io.read(8);
    if (
      start[0] !== MSG.startRedirection ||
      latin1(start.subarray(4)) !== "SOL "
    )
      throw new Error("StartRedirectionSession が違う");
    // 13 バイト。最後が OEM の長さ(0)
    io.write(
      new Uint8Array([
        MSG.startRedirectionReply,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ]),
    );
    const readAuth = async () => {
      const h = await io.read(9);
      if (h[0] !== MSG.authenticate)
        throw new Error("AuthenticateSession でない");
      const len = new DataView(h.buffer, h.byteOffset).getUint32(5, true);
      return { authType: h[4] as number, data: await io.read(len) };
    };
    const query = await readAuth();
    if (query.authType !== AUTH.query) throw new Error("最初は種類を問うはず");
    io.write(
      authReply(0, AUTH.query, new Uint8Array([AUTH.basic, AUTH.digest])),
    );
    const hello = await readAuth();
    if (hello.authType !== AUTH.digest) throw new Error("Digest でない");
    io.write(authReply(1, AUTH.digest, lstrs(FAKE.realm, nonce, "auth")));
    const answer = await readAuth();
    const r = new Reader(answer.data);
    const field = () => latin1(r.bytes(r.u8()));
    const [user, realm, n, uri, cnonce, nc, response, qop] = [
      field(),
      field(),
      field(),
      field(),
      field(),
      field(),
      field(),
      field(),
    ];
    const want = digestResponse({
      username,
      password,
      realm: FAKE.realm,
      nonce,
      method: "POST",
      uri: REDIRECT_URI,
      qop: "auth",
      nc,
      cnonce,
    });
    if (
      user !== username ||
      realm !== FAKE.realm ||
      n !== nonce ||
      uri !== REDIRECT_URI ||
      qop !== "auth" ||
      response !== want
    ) {
      io.write(authReply(1, AUTH.digest, new Uint8Array()));
      io.close();
      return "auth-failed";
    }
    io.write(authReply(0, AUTH.digest, new Uint8Array()));
    const sol = await io.read(24);
    if (sol[0] !== MSG.startSol) throw new Error("SOL の設定が来ない");
    io.write(concat(new Uint8Array([MSG.startSolReply]), new Uint8Array(22)));
    const controls = await io.read(14);
    if (controls[0] !== MSG.solControls) throw new Error("制御線が来ない");
    // 途中に生存確認と記録の知らせを挟む(クライアントは読み飛ばす)
    io.write(new Uint8Array([MSG.recording]));
    io.write(new Writer(8).u8(MSG.heartbeat).zeros(3).u32(seq++).done());
    if (o.banner) io.write(solData(seq++, new TextEncoder().encode(o.banner)));
    for (;;) {
      const t = (await io.peek(1))[0];
      if (t === MSG.solDataToHost) {
        const h = await io.read(10);
        const len = (h[8] as number) | ((h[9] as number) << 8);
        const data = await io.read(len);
        io.write(
          solData(seq++, new TextEncoder().encode(latin1(data).toUpperCase())),
        );
      } else if (t === MSG.heartbeat) {
        await io.read(8);
      } else if (t === MSG.endSol) {
        await io.read(8);
      } else if (t === MSG.endRedirection) {
        await io.read(4);
        io.close();
        return "ended";
      } else {
        throw new Error(`知らないメッセージ ${t}`);
      }
    }
  } catch (e) {
    if (e instanceof StreamClosed) return "closed";
    throw e;
  }
}
