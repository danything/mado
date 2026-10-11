// つなぐ手順の全部([MS-RDPBCGR] 1.3.1.1)。RDCleanPath → CredSSP → MCS → Client Info → ライセンス → 能力 → 同期。
// 終わったら、画面の更新と入力を流せる状態(Session)を返す。

import { concat, Reader } from "./bytes";
import { credssp } from "./credssp";
import * as mcs from "./mcs";
import { identity } from "./ntlm";
import * as pdu from "./pdu";
import * as cleanpath from "./rdcleanpath";
import { type Transport, WsStream } from "./stream";
import * as x224 from "./x224";

export type ConnectOptions = {
	/** mado の /ws */
	url: string;
	/** /api/token でもらった使い捨てのトークン */
	token: string;
	/** つなぐ先(トークンで決まるので、サーバーは見ない) */
	destination: string;
	username: string;
	password: string;
	width: number;
	height: number;
	keyboardLayout?: number;
	/** 静的チャネル。ID は同じ順で Session.channels に入る */
	channels?: mcs.StaticChannel[];
	onLog?: (line: string) => void;
	/** 中止(つなぐのに時間がかかりすぎたとき、利用者が取り消したとき) */
	signal?: AbortSignal;
	/** 試験用。NLA を使わない RDP サーバー(TLS だけ)も許す */
	allowTls?: boolean;
	/** 試験用。LICENSE_REQUEST にダミーの NEW_LICENSE_REQUEST で答える(xrdp は中身を見ない)。本物のライセンス交渉(PLATFORM_CHALLENGE 以降)はしないので、xrdp 以外では先へ進めない */
	dummyLicense?: boolean;
};

export type Session = {
	stream: Transport;
	userId: number;
	ioChannelId: number;
	/** 静的チャネルの名前 → チャネル ID */
	channels: Map<string, number>;
	/** 静的チャネルの名前 → オプション(SHOW_PROTOCOL を付けて送るかの判断に) */
	channelOptions: Map<string, number>;
	shareId: number;
	serverCapabilities: Map<number, Uint8Array>;
	/** 宣言したキーボード配列(再アクティベーションでも同じものを言う) */
	keyboardLayout: number;
	width: number;
	height: number;
	/** 同期の途中で届いた Fast-Path の PDU(画面の更新を取りこぼさない) */
	pending: x224.Pdu[];
	/** 同期の途中で届いた静的チャネル(drdynvc など)のデータ */
	pendingChannel: { channelId: number; data: Uint8Array }[];
};

export async function connect(o: ConnectOptions): Promise<Session> {
	const log = o.onLog ?? (() => {});
	const stream = await WsStream.open(o.url);
	if (o.signal?.aborted) {
		stream.close();
		throw new Error("つなぐのに時間がかかりすぎた(または取り消した)");
	}
	const abort = () => stream.close();
	o.signal?.addEventListener("abort", abort, { once: true });
	try {
		// 1. RDCleanPath: mado が RDP サーバーと TLS まで張る
		stream.write(
			cleanpath.request(
				x224.connectionRequest(x224.PROTOCOL.HYBRID),
				o.token,
				o.destination,
			),
		);
		const resp = await cleanpath.readResponse(stream);
		const cert = resp.certChain[0];
		if (!cert) throw new Error("RDP サーバーの証明書が届かない");
		log("RDCleanPath OK");
		const session = await establish(stream, o, resp.x224, cert);
		o.signal?.removeEventListener("abort", abort);
		return session;
	} catch (e) {
		o.signal?.removeEventListener("abort", abort);
		stream.close();
		if (o.signal?.aborted)
			throw new Error("つなぐのに時間がかかりすぎた(または取り消した)");
		throw e;
	}
}

/**
 * TLS が張れて、X.224 Connection Confirm とサーバーの証明書がある状態から、つながるまで進める。
 * connect() が WebSocket でここまで来る。試験は TCP + TLS で直接ここに来る
 */
export async function establish(
	stream: Transport,
	o: ConnectOptions,
	confirm: Uint8Array,
	cert: Uint8Array,
): Promise<Session> {
	const log = o.onLog ?? (() => {});
	const channels = o.channels ?? [mcs.DRDYNVC, mcs.CLIPRDR];
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
			keyboardLayout: o.keyboardLayout,
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
		if (id === undefined) continue; // サーバーが割り当てなかった(使えない)
		await join(id);
		joined.set(c.name, id);
	}
	log(`Channel Join OK (user ${userId})`);

	const send = (data: Uint8Array) =>
		stream.write(
			x224.data(mcs.sendDataRequest(userId, server.ioChannelId, data)),
		);

	// 5. Client Info
	const id = identity(o.username, o.password);
	send(
		concat(
			pdu.securityHeader(pdu.SEC_INFO_PKT),
			pdu.clientInfo({
				domain: id.domain,
				user: id.user,
				password: id.password,
			}),
		),
	);

	// 6. ライセンス → Demand Active
	const pending: x224.Pdu[] = [];
	const pendingChannel: Session["pendingChannel"] = [];
	let demand: pdu.DemandActive | undefined;
	let licensed = false;
	while (!demand) {
		const data = await readIo(
			stream,
			server.ioChannelId,
			pending,
			pendingChannel,
		);
		if (isShareControl(data)) {
			const sc = pdu.parseShareControl(data);
			if (sc.type === pdu.PDUTYPE.DEMAND_ACTIVE)
				demand = pdu.parseDemandActive(sc.body);
			else if (sc.type === pdu.PDUTYPE.DATA)
				checkErrorInfo(pdu.parseShareData(sc.body));
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
	send(
		pdu.confirmActive(
			userId,
			shareId,
			pdu.clientCapabilities({
				width: o.width,
				height: o.height,
				keyboardLayout: o.keyboardLayout ?? 0x0411,
			}),
		),
	);
	const data2 = (type2: number, payload: Uint8Array) =>
		send(pdu.shareData(userId, shareId, type2, payload));
	data2(pdu.PDUTYPE2.SYNCHRONIZE, pdu.synchronize(pdu.SERVER_ID));
	data2(pdu.PDUTYPE2.CONTROL, pdu.control(pdu.CONTROL.COOPERATE));
	data2(pdu.PDUTYPE2.CONTROL, pdu.control(pdu.CONTROL.REQUEST));
	data2(pdu.PDUTYPE2.FONTLIST, pdu.fontList());

	// サーバーの Synchronize / Control(Cooperate, Granted)/ Font Map を受けたら完了
	for (let done = false; !done; ) {
		const data = await readIo(
			stream,
			server.ioChannelId,
			pending,
			pendingChannel,
		);
		if (!isShareControl(data)) continue;
		const sc = pdu.parseShareControl(data);
		if (sc.type !== pdu.PDUTYPE.DATA) continue;
		const sd = pdu.parseShareData(sc.body);
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
		keyboardLayout: o.keyboardLayout ?? 0x0411,
		width: o.width,
		height: o.height,
		pending,
		pendingChannel,
	};
}

/** Share Control の totalLength が PDU の長さと合い、種類が正しければ Share Control(そうでなければ Security Header) */
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

/** I/O チャネルの Send Data Indication を 1 つ読む。Fast-Path は溜めておく。ほかのチャネルのものも溜めておく */
async function readIo(
	s: Transport,
	ioChannelId: number,
	pending: x224.Pdu[],
	pendingChannel: Session["pendingChannel"],
): Promise<Uint8Array> {
	for (;;) {
		const p = await x224.readPdu(s);
		if (p.kind === "fastpath") {
			pending.push(p);
			continue;
		}
		const ind = mcs.parseSendDataIndication(p.data);
		if (ind.channelId === ioChannelId) return ind.data;
		pendingChannel.push(ind);
	}
}
