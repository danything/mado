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
  /** リクエストされた電源の操作 */
  readonly requests: number[] = [];
  /** 起動の設定の操作の順(get / put / role / order)。put は UseIDER と IDERBootDevice を確かめる */
  readonly boot: string[] = [];
  /** リダイレクトの受け口と EnabledState(32771 = SOL・IDE-R とも有効) */
  redirection = { listener: true, state: 32771 };
  /** リダイレクトの設定の操作(state / put)。put に AccessLog が入っていたら put-bad */
  readonly redirectionOps: string[] = [];
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
    if (body.includes("AMT_RedirectionService")) {
      if (body.includes("RequestStateChange_INPUT")) {
        const s = /<r:RequestedState>(\d+)<\/r:RequestedState>/.exec(body);
        this.redirection.state = Number(s?.[1]);
        this.redirectionOps.push("state");
        return envelopeOf(
          `<g:RequestStateChange_OUTPUT><g:ReturnValue>0</g:ReturnValue></g:RequestStateChange_OUTPUT>`,
        );
      }
      if (body.includes("transfer/Put")) {
        this.redirectionOps.push(
          body.includes("AccessLog") ? "put-bad" : "put",
        );
        this.redirection.listener = body.includes(
          "<r:ListenerEnabled>true</r:ListenerEnabled>",
        );
        return envelopeOf(
          `<g:AMT_RedirectionService></g:AMT_RedirectionService>`,
        );
      }
      return envelopeOf(
        `<g:AMT_RedirectionService xmlns:g="http://intel.com/wbem/wscim/1/amt-schema/1/AMT_RedirectionService">` +
          `<g:AccessLog>a</g:AccessLog><g:AccessLog>b</g:AccessLog>` +
          `<g:CreationClassName>AMT_RedirectionService</g:CreationClassName><g:ElementName>Intel(r) AMT Redirection Service</g:ElementName>` +
          `<g:EnabledState>${this.redirection.state}</g:EnabledState><g:ListenerEnabled>${this.redirection.listener}</g:ListenerEnabled>` +
          `<g:Name>Intel(r) AMT Redirection Service</g:Name><g:SystemCreationClassName>CIM_ComputerSystem</g:SystemCreationClassName>` +
          `<g:SystemName>Intel(r) AMT</g:SystemName></g:AMT_RedirectionService>`,
      );
    }
    if (body.includes("transfer/Get") && body.includes("AMT_BootSettingData"))
      return envelopeOf(
        `<g:AMT_BootSettingData xmlns:g="http://intel.com/wbem/wscim/1/amt-schema/1/AMT_BootSettingData">` +
          `<g:BIOSLastStatus>2</g:BIOSLastStatus><g:BIOSLastStatus>0</g:BIOSLastStatus>` +
          `<g:BIOSPause>false</g:BIOSPause><g:BIOSSetup>false</g:BIOSSetup><g:BootMediaIndex>0</g:BootMediaIndex>` +
          `<g:ElementName>Intel(r) AMT Boot Configuration Settings</g:ElementName><g:FirmwareVerbosity>0</g:FirmwareVerbosity>` +
          `<g:IDERBootDevice>0</g:IDERBootDevice><g:InstanceID>Intel(r) AMT:BootSettingData 0</g:InstanceID>` +
          `<g:OptionsCleared>true</g:OptionsCleared><g:UseIDER>false</g:UseIDER><g:UseSOL>false</g:UseSOL>` +
          `</g:AMT_BootSettingData>`,
      );
    if (body.includes("transfer/Put") && body.includes("AMT_BootSettingData")) {
      const ok =
        body.includes("<r:UseIDER>true</r:UseIDER>") &&
        body.includes("<r:IDERBootDevice>1</r:IDERBootDevice>") &&
        !body.includes("OptionsCleared") &&
        !body.includes("BIOSLastStatus") &&
        body.includes(
          "<r:InstanceID>Intel(r) AMT:BootSettingData 0</r:InstanceID>",
        );
      this.boot.push(ok ? "put" : "put-bad");
      return envelopeOf(`<g:AMT_BootSettingData></g:AMT_BootSettingData>`);
    }
    if (body.includes("SetBootConfigRole_INPUT")) {
      this.boot.push(body.includes("<r:Role>1</r:Role>") ? "role" : "role-bad");
      return envelopeOf(
        `<g:SetBootConfigRole_OUTPUT><g:ReturnValue>0</g:ReturnValue></g:SetBootConfigRole_OUTPUT>`,
      );
    }
    if (body.includes("ChangeBootOrder_INPUT")) {
      this.boot.push("order");
      return envelopeOf(
        `<g:ChangeBootOrder_OUTPUT><g:ReturnValue>0</g:ReturnValue></g:ChangeBootOrder_OUTPUT>`,
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

/** StartRedirectionSession から Digest の認証まで。種類(SOL か IDER)を返す。認証に失敗したら undefined */
async function fakeAuth(
  io: Transport,
  o: FakeRedirectOptions,
): Promise<"SOL" | "IDER" | undefined> {
  const username = o.username ?? FAKE.username;
  const password = o.password ?? FAKE.password;
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const start = await io.read(8);
  const kind = latin1(start.subarray(4));
  if (start[0] !== MSG.startRedirection || (kind !== "SOL " && kind !== "IDER"))
    throw new Error("StartRedirectionSession が違います");
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
      throw new Error("AuthenticateSession ではありません");
    const len = new DataView(h.buffer, h.byteOffset).getUint32(5, true);
    return { authType: h[4] as number, data: await io.read(len) };
  };
  const query = await readAuth();
  if (query.authType !== AUTH.query)
    throw new Error("最初は種類を問うはずです");
  io.write(authReply(0, AUTH.query, new Uint8Array([AUTH.basic, AUTH.digest])));
  const hello = await readAuth();
  if (hello.authType !== AUTH.digest) throw new Error("Digest ではありません");
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
    return undefined;
  }
  io.write(authReply(0, AUTH.digest, new Uint8Array()));
  return kind === "IDER" ? "IDER" : "SOL";
}

/**
 * 偽の AMT のリダイレクト。Digest を確かめ、SOL を開く。届いたキー入力は大文字にして端末の出力として返す。
 * 終わり方(認証の失敗、SOL の終わり、切断)を返す
 */
export async function serveRedirect(
  io: Transport,
  o: FakeRedirectOptions = {},
): Promise<"auth-failed" | "ended" | "closed"> {
  try {
    const kind = await fakeAuth(io, o);
    if (!kind) return "auth-failed";
    if (kind !== "SOL") throw new Error("SOL ではありません");
    return await serveSol(io, o);
  } catch (e) {
    if (e instanceof StreamClosed) return "closed";
    throw e;
  }
}

async function serveSol(
  io: Transport,
  o: FakeRedirectOptions,
): Promise<"ended" | "closed"> {
  let seq = 0;
  const sol = await io.read(24);
  if (sol[0] !== MSG.startSol) throw new Error("SOL の設定が届きません");
  io.write(concat(new Uint8Array([MSG.startSolReply]), new Uint8Array(22)));
  const controls = await io.read(14);
  if (controls[0] !== MSG.solControls) throw new Error("制御線が届きません");
  // 途中に生存確認と記録の通知を挟む(クライアントは読み飛ばす)
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
      throw new Error(`知らないメッセージです(${t})`);
    }
  }
}

// ---- IDE-R ----

/** 試験の ISO。セクタ i の中身は (i + 位置) を 251 で割った余り。偽の AMT も同じものを作って比べる */
export function fakeIso(blocks: number): Uint8Array {
  const b = new Uint8Array(blocks * 2048);
  for (let i = 0; i < b.length; i++) b[i] = ((i >> 11) + i) % 251;
  return b;
}

/** 偽の AMT が IDE-R で確かめたこと */
export type IderReport = {
  /** READ_CAPACITY で読めたセクタの数 */
  blocks: number;
  /** READ_10 で読めたもの */
  read: Uint8Array;
  /** 範囲の外を読んだときの sense key */
  outOfRangeSense: number;
  /** PING に PONG が返ったか */
  pong: boolean;
};

/**
 * 偽の AMT の IDE-R。認証のあと OPEN_SESSION に答え、次の起動で有効にする頼みを受け、
 * BIOS の代わりに TEST_UNIT_READY・READ_CAPACITY・READ_10(緩衝より大きい)・範囲の外の READ_10・PING を送る
 */
export async function serveIder(
  io: Transport,
  o: FakeRedirectOptions & { readLba?: number; readCount?: number } = {},
): Promise<IderReport | "auth-failed"> {
  const kind = await fakeAuth(io, o);
  if (!kind) return "auth-failed";
  if (kind !== "IDER") throw new Error("IDER ではありません");
  let seq = 0;
  const head = (type: number) =>
    new Writer(8).u8(type).zeros(3).u32(seq++).done();
  const open = await io.read(18);
  if (open[0] !== 0x40) throw new Error("OPEN_SESSION が届きません");
  // 30 バイト: 版 1.0、読みと書きの緩衝 8192、プロトコル 0、追加の長さ 0
  const reply = new Writer(22)
    .u8(1)
    .u8(0)
    .u8(1)
    .u8(0)
    .zeros(4)
    .u16(8192)
    .u16(8192)
    .zeros(10)
    .done();
  io.write(concat(head(0x41), reply));
  const toggle = await io.read(13);
  if (toggle[0] !== 0x48 || toggle[8] !== 3)
    throw new Error("REGS_TOGGLE が届きません");
  io.write(concat(head(0x49), new Writer(5).u8(3).u32(1).done()));
  io.write(concat(head(0x49), new Writer(5).u8(2).u32(2).done()));

  /** クライアントの返事を 1 つ読む。0x51 は終わり、0x54 はデータ */
  const readReply = async () => {
    const h = await io.read(8);
    switch (h[0]) {
      case 0x51:
        return { type: 0x51, body: await io.read(23) };
      case 0x54: {
        const fixed = await io.read(26);
        const len = (fixed[1] as number) | ((fixed[2] as number) << 8);
        return {
          type: 0x54,
          body: fixed,
          data: await io.read(len),
          last: ((h[3] as number) & 2) !== 0,
        };
      }
      case 0x45:
      case 0x47:
        return { type: h[0] as number, body: new Uint8Array() };
      default:
        throw new Error(`知らない返事です(${h[0]})`);
    }
  };
  /** SCSI の命令を送る。28 バイト。装置は CD(0xB0)、DMA なし */
  const scsi = (cdb: number[]) => {
    const m = new Uint8Array(20);
    m[6] = 0xb0;
    m.set(cdb, 8);
    io.write(concat(head(0x50), m));
  };
  /** 終わりまでのデータを集める */
  const collect = async () => {
    const parts: Uint8Array[] = [];
    for (;;) {
      const r = await readReply();
      if (r.type === 0x51) return { parts, end: r.body };
      if (r.type !== 0x54 || !r.data) throw new Error("データでない返事です");
      parts.push(r.data);
      if (r.last) return { parts, end: undefined };
    }
  };

  scsi([0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const ready = await readReply();
  if (ready.type !== 0x51 || ready.body[19] !== 0x50)
    throw new Error("TEST_UNIT_READY が正常に終わりません");

  scsi([0x25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const cap = concat(...(await collect()).parts);
  const blocks =
    new DataView(cap.buffer, cap.byteOffset).getUint32(0, false) + 1;

  const lba = o.readLba ?? 16;
  const count = o.readCount ?? 5;
  scsi([
    0x28,
    0,
    (lba >>> 24) & 255,
    (lba >>> 16) & 255,
    (lba >>> 8) & 255,
    lba & 255,
    0,
    count >> 8,
    count & 255,
    0,
    0,
    0,
  ]);
  const read = concat(...(await collect()).parts);

  const far = blocks + 10;
  scsi([
    0x28,
    0,
    (far >>> 24) & 255,
    (far >>> 16) & 255,
    (far >>> 8) & 255,
    far & 255,
    0,
    0,
    1,
    0,
    0,
    0,
  ]);
  const bad = await readReply();
  const outOfRangeSense = bad.body[20] as number;

  io.write(head(0x44));
  const pong = (await readReply()).type === 0x45;
  io.close();
  return { blocks, read, outOfRangeSense, pong };
}

/** 偽の AMT のリダイレクトの口。最初の 8 バイトで SOL か IDE-R かを見て分ける(tools/amt-e2e/fake-amt.ts) */
export async function serveAny(
  io: Transport,
  o: FakeRedirectOptions = {},
): Promise<string> {
  const start = await io.peek(8);
  if (latin1(start.subarray(4)) !== "IDER") return serveRedirect(io, o);
  const r = await serveIder(io, o);
  if (r === "auth-failed") return r;
  const want = fakeIso(r.blocks).subarray(16 * 2048, 21 * 2048);
  const same =
    r.read.length === want.length && r.read.every((v, i) => v === want[i]);
  return `ider blocks=${r.blocks} read=${same ? "ok" : "NG"} outOfRange=${r.outOfRangeSense} pong=${r.pong}`;
}
