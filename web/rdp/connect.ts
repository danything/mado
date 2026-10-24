// つなぐ手順([MS-RDPBCGR] 1.3.1.1)。RDCleanPath → CredSSP → MCS → Client Info → ライセンス → 能力 → 同期の順に進める。
// 終わると、画面の更新と入力を流せる Session を返す。

import { AutoDetect } from "./autodetect";
import { concat, Reader } from "./bytes";
import { credssp } from "./credssp";
import { Reassembler, type Update } from "./fastpath";
import * as mcs from "./mcs";
import { Bulk } from "./mppc";
import { identity } from "./ntlm";
import * as pdu from "./pdu";
import * as cleanpath from "./rdcleanpath";
import { type Transport, WsStream, WtStream } from "./stream";
import * as x224 from "./x224";

export type ConnectOptions = {
  /** mado の /ws */
  url: string;
  /** mado の /wt(WebTransport)。あれば先に試し、だめなら黙って /ws を使う */
  wt?: string;
  /** /api/token でもらった使い捨てのトークン */
  token: string;
  /**
   * トークンを取り直す。WebTransport が開けずに WebSocket に移るときに使う。
   * サーバーが CONNECT でトークンを使ったあとで、ブラウザの待ち時間が切れることがある
   */
  newToken?: () => Promise<string>;
  /** つなぐ先。実際の行き先はトークンで決まるので、サーバーはこれを見ない */
  destination: string;
  username: string;
  password: string;
  width: number;
  height: number;
  keyboardLayout?: number;
  /** 静的チャネル。ID は同じ順で Session.channels に入る */
  channels?: mcs.StaticChannel[];
  onLog?: (line: string) => void;
  /** 中止の合図。時間がかかりすぎたときや、利用者が取り消したときに使う */
  signal?: AbortSignal;
  /** GFX(Graphics Pipeline)を頼む。受け手の GfxClient は attachChannels に渡す */
  gfx?: boolean;
  /** 試験用。NLA を使わない RDP サーバー(TLS だけ)も許す */
  allowTls?: boolean;
  /**
   * 試験用。LICENSE_REQUEST にダミーの NEW_LICENSE_REQUEST で答える。xrdp は中身を見ないので通る。
   * PLATFORM_CHALLENGE から先の本物の交渉はしないので、xrdp 以外では先へ進めない
   */
  dummyLicense?: boolean;
  /** 回線の自動検出を頼む。サーバーが RTT と帯域を測って画質を変える。既定は true */
  autodetect?: boolean;
  /** バルク圧縮(RDP 5.0)を頼む。旧ビットマップやチャネルのデータが小さくなる。既定は true */
  compression?: boolean;
};

export type Session = {
  stream: Transport;
  /** 中継に使っている方式。試験で TCP から直接つないだときは無い */
  transport?: TransportKind;
  userId: number;
  ioChannelId: number;
  /** 静的チャネルの名前 → チャネル ID */
  channels: Map<string, number>;
  /** 静的チャネルの名前 → オプション。送るときに SHOW_PROTOCOL を付けるかをこれで決める */
  channelOptions: Map<string, number>;
  shareId: number;
  serverCapabilities: Map<number, Uint8Array>;
  /** 宣言したキーボード配列。再アクティベーションでも同じものを伝える */
  keyboardLayout: number;
  width: number;
  height: number;
  /**
   * 同期の途中で届いた Fast-Path の更新。あとで流して、画面の更新を取りこぼさないようにする。
   * 圧縮の履歴は Share Data と共通なので、届いた順に伸長してから溜める
   */
  pending: Update[];
  /** 同期の途中で届いた、drdynvc などの静的チャネルのデータ */
  pendingChannel: { channelId: number; data: Uint8Array }[];
  /** 回線の自動検出に使うメッセージ チャネルの ID。サーバーが使わないときは無い */
  messageChannelId?: number;
  /** 回線の自動検出の受け手。つなぐ途中で使ったものを、つないだあとも使い続ける */
  autodetect?: AutoDetect;
  /** つなぐ途中で使った Fast-Path の組み立て。断片と圧縮の履歴を引き継ぐ */
  fast?: Reassembler;
  /** I/O チャネル(Fast-Path と Share Data)の圧縮の文脈。圧縮を頼まなかったときは無い */
  bulk?: Bulk;
  /** 静的チャネルの圧縮の文脈。I/O チャネルとは別の履歴にする */
  channelBulk?: Bulk;
};

export type TransportKind = "WebTransport" | "WebSocket";

/** WebTransport の ready を待つ時間。UDP が通らない回線では来ないので、短く切って WebSocket に移る */
export const WT_TIMEOUT_MS = 1500;

export type TransportOpeners = {
  wt?: (url: string, timeoutMs: number) => Promise<Transport>;
  ws: (url: string) => Promise<Transport>;
};

const defaultOpeners = (): TransportOpeners => ({
  wt:
    typeof WebTransport === "undefined"
      ? undefined
      : (url, ms) => WtStream.open(url, ms),
  ws: (url) => WsStream.open(url),
});

/**
 * 中継への道を開く。WebTransport が使えれば先に試し、開けなければ WebSocket にする。
 * WebTransport には Cookie が付かないので、/wt?token= にトークンを付ける。サーバーは CONNECT でトークンを使い、
 * RDCleanPath の要求にも同じトークンを求める。WebSocket に移るときは、newToken があればトークンを取り直す。
 * 返す token は RDCleanPath の要求に入れるもの
 */
export async function openTransport(
  o: Pick<ConnectOptions, "url" | "wt" | "token" | "newToken" | "onLog">,
  openers: TransportOpeners = defaultOpeners(),
): Promise<{ stream: Transport; kind: TransportKind; token: string }> {
  const log = o.onLog ?? (() => {});
  let token = o.token;
  if (o.wt && openers.wt) {
    try {
      return {
        stream: await openers.wt(
          `${o.wt}?token=${encodeURIComponent(o.token)}`,
          WT_TIMEOUT_MS,
        ),
        kind: "WebTransport",
        token,
      };
    } catch (e) {
      log(
        `WebTransport が使えないので WebSocket にする (${e instanceof Error ? e.message : e})`,
      );
      if (o.newToken) token = await o.newToken();
    }
  }
  return { stream: await openers.ws(o.url), kind: "WebSocket", token };
}

const ABORTED = "つなぐのに時間がかかりすぎたか、取り消した";

export async function connect(
  o: ConnectOptions,
  openers?: TransportOpeners,
): Promise<Session> {
  const log = o.onLog ?? (() => {});
  const { stream, kind, token } = await openTransport(o, openers);
  log(`中継: ${kind}`);
  if (o.signal?.aborted) {
    stream.close();
    throw new Error(ABORTED);
  }
  const abort = () => stream.close();
  o.signal?.addEventListener("abort", abort, { once: true });
  try {
    // 1. RDCleanPath: mado が RDP サーバーと TLS まで張る
    stream.write(
      cleanpath.request(
        x224.connectionRequest(x224.PROTOCOL.HYBRID),
        token,
        o.destination,
      ),
    );
    const resp = await cleanpath.readResponse(stream);
    const cert = resp.certChain[0];
    if (!cert) throw new Error("RDP サーバーの証明書が届かない");
    log("RDCleanPath OK");
    const session = await establish(stream, o, resp.x224, cert);
    session.transport = kind;
    return session;
  } catch (e) {
    stream.close();
    if (o.signal?.aborted) throw new Error(ABORTED);
    throw e;
  } finally {
    o.signal?.removeEventListener("abort", abort);
  }
}

/**
 * TLS が張れて、X.224 Connection Confirm とサーバーの証明書を受け取ったところから、つながるまで進める。
 * connect() は mado の中継と RDCleanPath でここまで来る。試験は TCP + TLS で直接ここから始める
 */
export async function establish(
  stream: Transport,
  o: ConnectOptions,
  confirm: Uint8Array,
  cert: Uint8Array,
): Promise<Session> {
  const log = o.onLog ?? (() => {});
  const channels = o.channels ?? [mcs.DRDYNVC, mcs.CLIPRDR];
  const keyboardLayout = o.keyboardLayout ?? mcs.DEFAULT_KEYBOARD_LAYOUT;
  const cc = x224.parseConnectionConfirm(confirm);
  if (!cc.ok) throw new Error(x224.failureMessage(cc.failureCode));
  if (cc.selectedProtocol === x224.PROTOCOL.HYBRID) {
    // 2. CredSSP
    await credssp(stream, cert, o.username, o.password);
    log("CredSSP OK");
  } else if (!(o.allowTls && cc.selectedProtocol === x224.PROTOCOL.SSL)) {
    throw new Error(
      `NLA(CredSSP)以外が選ばれた (${cc.selectedProtocol})。このサーバーは NLA を使う設定にする`,
    );
  }

  // 3. MCS Connect
  const userData = mcs.gccCreateRequest(
    {
      width: o.width,
      height: o.height,
      selectedProtocol: cc.selectedProtocol,
      clientName: "mado",
      keyboardLayout,
      gfx: o.gfx,
      autodetect: o.autodetect,
    },
    channels,
  );
  stream.write(x224.data(mcs.connectInitial(userData)));
  const server = mcs.parseConnectResponse((await readSlow(stream)).data);
  log(
    `MCS Connect OK (io ${server.ioChannelId}, channels ${server.channelIds.join(",")})`,
  );

  // 4. Erect Domain / Attach User / Channel Join
  stream.write(x224.data(mcs.erectDomainRequest()));
  stream.write(x224.data(mcs.attachUserRequest()));
  const userId = mcs.parseAttachUserConfirm((await readSlow(stream)).data);
  const joined = new Map<string, number>();
  const join = async (id: number) => {
    stream.write(x224.data(mcs.channelJoinRequest(userId, id)));
    const got = mcs.parseChannelJoinConfirm((await readSlow(stream)).data);
    if (got !== id) throw new Error(`MCS: チャネル ${id} のはずが ${got}`);
  };
  await join(userId);
  await join(server.ioChannelId);
  for (const [i, c] of channels.entries()) {
    const id = server.channelIds[i];
    if (id === undefined) continue; // サーバーが割り当てなかったチャネルは使えない
    await join(id);
    joined.set(c.name, id);
  }
  // サーバーがメッセージ チャネルを返していれば、静的チャネルのあとに参加する
  const messageChannelId = server.messageChannelId;
  if (messageChannelId !== undefined) await join(messageChannelId);
  log(
    `Channel Join OK (user ${userId}${messageChannelId === undefined ? "" : `, message ${messageChannelId}`})`,
  );

  const send = (data: Uint8Array) =>
    stream.write(
      x224.data(mcs.sendDataRequest(userId, server.ioChannelId, data)),
    );

  // 5. Client Info。圧縮を頼むと、このあとサーバーから届くデータは圧縮されることがある
  const compression = o.compression ?? true;
  const bulk = compression ? new Bulk() : undefined;
  const channelBulk = compression ? new Bulk() : undefined;
  const id = identity(o.username, o.password);
  send(
    concat(
      pdu.securityHeader(pdu.SEC_INFO_PKT),
      pdu.clientInfo({
        domain: id.domain,
        user: id.user,
        password: id.password,
        compression,
      }),
    ),
  );

  // 6. ライセンス → 回線の自動検出 → Demand Active。自動検出はサーバーが始めたときだけ
  const inbox: Inbox = {
    ioChannelId: server.ioChannelId,
    pending: [],
    pendingChannel: [],
    fast: new Reassembler(bulk),
  };
  let autodetect: AutoDetect | undefined;
  if (messageChannelId !== undefined) {
    const ad = new AutoDetect();
    autodetect = ad;
    inbox.message = {
      id: messageChannelId,
      handle: (data) => {
        const reply = ad.handle(data);
        if (reply)
          stream.write(
            x224.data(mcs.sendDataRequest(userId, messageChannelId, reply)),
          );
      },
    };
  }
  let demand: pdu.DemandActive | undefined;
  let licensed = false;
  while (!demand) {
    const data = await readIo(stream, inbox);
    if (isShareControl(data)) {
      const sc = pdu.parseShareControl(data);
      if (sc.type === pdu.PDUTYPE.DEMAND_ACTIVE)
        demand = pdu.parseDemandActive(sc.body);
      else if (sc.type === pdu.PDUTYPE.DATA)
        checkErrorInfo(pdu.parseShareData(sc.body, bulk));
      continue;
    }
    const r = new Reader(data);
    const flags = r.u16();
    r.u16();
    if (flags & pdu.SEC_LICENSE_PKT) {
      const state = pdu.checkLicense(r.rest());
      if (state === "valid") {
        licensed = true;
        log("ライセンス OK");
      } else if (o.dummyLicense) {
        log("ライセンスを求められた(ダミーで答える)");
        send(
          concat(
            pdu.securityHeader(pdu.SEC_LICENSE_PKT),
            pdu.dummyNewLicenseRequest(),
          ),
        );
      } else {
        throw new Error(
          "ライセンスの交渉を求められた。このサーバーはライセンスが要る設定",
        );
      }
    }
  }
  if (!licensed) log("ライセンスの PDU は来なかった");

  // 7. Confirm Active → 同期
  const shareId = demand.shareId;
  for (const p of pdu.activationPdus(userId, shareId, {
    width: o.width,
    height: o.height,
    keyboardLayout,
  }))
    send(p);

  // サーバーの Synchronize / Control(Cooperate, Granted)/ Font Map を受けたら完了
  for (let done = false; !done;) {
    const data = await readIo(stream, inbox);
    if (!isShareControl(data)) continue;
    const sc = pdu.parseShareControl(data);
    if (sc.type !== pdu.PDUTYPE.DATA) continue;
    const sd = pdu.parseShareData(sc.body, bulk);
    checkErrorInfo(sd);
    if (sd.type2 === pdu.PDUTYPE2.FONTMAP) done = true;
  }
  log("接続完了");

  return {
    stream,
    userId,
    ioChannelId: server.ioChannelId,
    channels: joined,
    channelOptions: new Map(channels.map((c) => [c.name, c.options])),
    shareId,
    serverCapabilities: demand.capabilities,
    keyboardLayout,
    width: o.width,
    height: o.height,
    pending: inbox.pending,
    pendingChannel: inbox.pendingChannel,
    messageChannelId,
    autodetect,
    fast: inbox.fast,
    bulk,
    channelBulk,
  };
}

/** totalLength が PDU の長さと合い、種類も正しければ Share Control とみなす。そうでなければ Security Header */
function isShareControl(data: Uint8Array): boolean {
  if (data.length < 6) return false;
  const total = (data[0] as number) | ((data[1] as number) << 8);
  const type = ((data[2] as number) | ((data[3] as number) << 8)) & 0xf;
  return total === data.length && type >= 1 && type <= 0xa;
}

function checkErrorInfo(sd: pdu.ShareData): void {
  if (sd.type2 !== pdu.PDUTYPE2.SET_ERROR_INFO) return;
  const code = pdu.parseErrorInfo(sd.payload);
  if (code !== 0)
    throw new Error(`サーバーが切った (ErrorInfo 0x${code.toString(16)})`);
}

async function readSlow(s: Transport): Promise<{ data: Uint8Array }> {
  const p = await x224.readPdu(s);
  if (p.kind !== "slowpath")
    throw new Error("Fast-Path の PDU が接続の途中に来た");
  return p;
}

/** 接続の途中に届くものの行き先 */
export type Inbox = {
  ioChannelId: number;
  /** Fast-Path の更新。つないだあとで RdpClient が流す */
  pending: Update[];
  /** 静的チャネルのデータ。これも RdpClient があとで流す */
  pendingChannel: Session["pendingChannel"];
  /** 回線の自動検出のメッセージ チャネル。サーバーは答えるまでの時間を測るので、その場で答える */
  message?: { id: number; handle: (data: Uint8Array) => void };
  /** Fast-Path の組み立て。圧縮の履歴が Share Data と共通なので、届いたその場で伸長する */
  fast?: Reassembler;
};

/** I/O チャネルの Send Data Indication を 1 つ読む。Fast-Path とほかのチャネルのデータは溜めておき、メッセージ チャネルにはその場で答える */
export async function readIo(s: Transport, inbox: Inbox): Promise<Uint8Array> {
  for (;;) {
    const p = await x224.readPdu(s);
    if (p.kind === "fastpath") {
      inbox.fast ??= new Reassembler();
      inbox.pending.push(...inbox.fast.push(p.data));
      continue;
    }
    const ind = mcs.parseSendDataIndication(p.data);
    if (ind.channelId === inbox.ioChannelId) return ind.data;
    if (ind.channelId === inbox.message?.id) inbox.message.handle(ind.data);
    else inbox.pendingChannel.push(ind);
  }
}
