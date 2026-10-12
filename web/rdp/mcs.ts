// MCS([T.125])と GCC([T.124])。Connect Initial / Response は BER、そのあとの PDU は PER。
// データブロックは [MS-RDPBCGR] 2.2.1.3〜2.2.1.4、そのあとの PDU は 2.2.1.5〜2.2.1.16 にある。

import { Reader, Writer } from "./bytes";
import * as der from "./der";

/** MCS のユーザー ID とチャネル ID は、PER では 1001 を引いた値で運ぶ */
const BASE = 1001;

/** キーボード配列の既定は日本語(0x0411)。米国は 0x0409 */
export const DEFAULT_KEYBOARD_LAYOUT = 0x0411;

// ---- クライアントのデータブロック ----

export type ClientCore = {
	width: number;
	height: number;
	/** X.224 Connection Confirm で選ばれた方式 */
	selectedProtocol: number;
	clientName: string;
	keyboardLayout?: number;
	/** SUPPORT_DYNVC_GFX_PROTOCOL を立てて、GFX(Graphics Pipeline)を使えると伝える */
	gfx?: boolean;
	/** 回線の自動検出を頼む。既定は true。頼まないときは LAN と伝える */
	autodetect?: boolean;
};

/** 静的チャネル。名前は NUL を含めて 8 バイトなので、7 文字まで */
export type StaticChannel = { name: string; options: number };

export const DRDYNVC: StaticChannel = { name: "drdynvc", options: 0xc0800000 };
export const CLIPRDR: StaticChannel = { name: "cliprdr", options: 0xc0a00000 };

/** キーボードの種類。日本語配列は 7(日本語キーボード)、ほかは 4(IBM enhanced 101/102 キー) */
export const keyboardType = (layout: number) =>
	(layout & 0xffff) === 0x0411 ? 7 : 4;
/** 日本語キーボードの副種類は 2(106/109 キー) */
export const keyboardSubType = (layout: number) =>
	(layout & 0xffff) === 0x0411 ? 2 : 0;

function block(type: number, body: Uint8Array): Uint8Array {
	return new Writer(body.length + 4)
		.u16(type)
		.u16(body.length + 4)
		.bytes(body)
		.done();
}

/** earlyCapabilityFlags の SUPPORT_NETCHAR_AUTODETECT と、connectionType の LAN / AUTODETECT */
const SUPPORT_NETCHAR_AUTODETECT = 0x0080;
const CONNECTION_TYPE_LAN = 6;
const CONNECTION_TYPE_AUTODETECT = 7;

function clientCore(c: ClientCore): Uint8Array {
	const layout = c.keyboardLayout ?? DEFAULT_KEYBOARD_LAYOUT;
	const autodetect = c.autodetect ?? true;
	return block(
		0xc001,
		new Writer(216)
			.u32(0x00080004) // RDP 5.0 以降
			.u16(c.width)
			.u16(c.height)
			.u16(0xca01) // colorDepth: 8bpp。古い欄で、実際の値は下の highColorDepth
			.u16(0xaa03) // SASSequence
			.u32(layout)
			.u32(0x0000_4a61) // clientBuild
			.utf16Fixed(c.clientName, 32)
			.u32(keyboardType(layout))
			.u32(keyboardSubType(layout))
			.u32(12) // keyboardFunctionKey
			.zeros(64) // imeFileName
			.u16(0xca01) // postBeta2ColorDepth
			.u16(1) // clientProductId
			.u32(0) // serialNumber
			.u16(24) // highColorDepth: 24。32 は WANT_32BPP_SESSION で頼む
			.u16(0x0001 | 0x0002 | 0x0004 | 0x0008) // supportedColorDepths: 24 / 16 / 15 / 32
			// earlyCapabilityFlags: ERRINFO_PDU | WANT_32BPP_SESSION | STATUSINFO_PDU | VALID_CONNECTION_TYPE
			// 回線を測ってもらうときは SUPPORT_NETCHAR_AUTODETECT、GFX を使うときは SUPPORT_DYNVC_GFX_PROTOCOL も立てる
			.u16(
				0x0001 |
					0x0002 |
					0x0004 |
					0x0020 |
					(autodetect ? SUPPORT_NETCHAR_AUTODETECT : 0) |
					(c.gfx ? 0x0100 : 0),
			)
			.zeros(64) // clientDigProductId
			// connectionType。測ってもらうなら AUTODETECT にし、サーバーが測った結果で画質を決める。
			// 測らないなら LAN にする。LAN でないとコーデックを使わないサーバーがある
			.u8(autodetect ? CONNECTION_TYPE_AUTODETECT : CONNECTION_TYPE_LAN)
			.u8(0) // pad
			.u32(c.selectedProtocol)
			.done(),
	);
}

/** TLS / CredSSP の上では RDP 自身の暗号は使わないので、どちらも 0 */
function clientSecurity(): Uint8Array {
	return block(0xc002, new Writer(8).u32(0).u32(0).done());
}

function clientNet(channels: StaticChannel[]): Uint8Array {
	const w = new Writer(4 + channels.length * 12).u32(channels.length);
	for (const c of channels) {
		const name = new Uint8Array(8);
		name.set(new TextEncoder().encode(c.name).subarray(0, 7));
		w.bytes(name).u32(c.options);
	}
	return block(0xc003, w.done());
}

function clientCluster(): Uint8Array {
	// REDIRECTION_SUPPORTED | REDIRECTION_VERSION4(4 << 2)
	return block(
		0xc004,
		new Writer(8)
			.u32(0x1 | (4 << 2))
			.u32(0)
			.done(),
	);
}

/** Client Message Channel Data。回線の自動検出に使う MCS のメッセージ チャネルを頼む。flags は 0 */
function clientMessageChannel(): Uint8Array {
	return block(0xc006, new Writer(4).u32(0).done());
}

/** PER の長さ。0x80 未満は 1 バイト、それ以上は 0x8000 | n の 2 バイト */
export function perLength(n: number): Uint8Array {
	return n < 0x80 ? Uint8Array.of(n) : Uint8Array.of(0x80 | (n >> 8), n & 0xff);
}

function readPerLength(r: Reader): number {
	const b = r.u8();
	return b & 0x80 ? ((b & 0x7f) << 8) | r.u8() : b;
}

/** GCC Conference Create Request で包んだクライアントのデータ */
export function gccCreateRequest(
	core: ClientCore,
	channels: StaticChannel[],
): Uint8Array {
	const w = new Writer(256)
		.bytes(clientCore(core))
		.bytes(clientCluster())
		.bytes(clientSecurity())
		.bytes(clientNet(channels));
	if (core.autodetect ?? true) w.bytes(clientMessageChannel());
	const blocks = w.done();
	// ConferenceCreateRequest。拡張ビット 0x00、選択 0x08、会議名 "1"(numeric)、user data 1 つ、h221NonStandard の鍵 "Duca"。
	// ここまでで先頭の 7 + 長さ 2 + この 12 + 長さ 2 の 23 バイトになる。この 23 バイトを決め打ちで読み飛ばすサーバーがある
	const inner = new Writer(blocks.length + 32)
		.bytes(Uint8Array.of(0x00, 0x08, 0x00, 0x10, 0x00, 0x01, 0xc0, 0x00))
		.bytes(new TextEncoder().encode("Duca"))
		.bytes(perLength(blocks.length))
		.bytes(blocks)
		.done();
	return new Writer(inner.length + 16)
		.bytes(Uint8Array.of(0x00, 0x05, 0x00, 0x14, 0x7c, 0x00, 0x01))
		.bytes(perLength(inner.length))
		.bytes(inner)
		.done();
}

/** 符号を付けない最短の INTEGER。実際のクライアントも 65535 を 02 02 ff ff で送る */
const uint = (v: number) =>
	der.tlv(
		der.INTEGER,
		v > 0xff ? Uint8Array.of(v >> 8, v & 0xff) : Uint8Array.of(v),
	);

const domainParams = (
	channels: number,
	users: number,
	tokens: number,
	prio: number,
	throughput: number,
	height: number,
	pduSize: number,
	version: number,
) =>
	der.tlv(
		der.SEQUENCE,
		...[
			channels,
			users,
			tokens,
			prio,
			throughput,
			height,
			pduSize,
			version,
		].map(uint),
	);

/** MCS Connect Initial(BER、[APPLICATION 101])。X.224 Data で包む前の中身 */
export function connectInitial(userData: Uint8Array): Uint8Array {
	return der.tlv(
		0x7f65,
		der.octets(Uint8Array.of(1)), // callingDomainSelector
		der.octets(Uint8Array.of(1)), // calledDomainSelector
		der.tlv(der.BOOLEAN, Uint8Array.of(0xff)), // upwardFlag
		domainParams(34, 2, 0, 1, 0, 1, 0xffff, 2), // target
		domainParams(1, 1, 1, 1, 0, 1, 0x420, 2), // minimum
		domainParams(0xffff, 0xfc17, 0xffff, 1, 0, 1, 0xffff, 2), // maximum
		der.octets(userData),
	);
}

// ---- サーバーの応答 ----

export type ServerData = {
	/** 画面と入力が通る I/O チャネルの ID */
	ioChannelId: number;
	/** 要求した静的チャネルに割り当てられた ID。要求した順に並ぶ */
	channelIds: number[];
	/** SC_CORE の clientRequestedProtocols / earlyCapabilityFlags。無ければ 0 */
	earlyCapabilityFlags: number;
	/** 回線の自動検出に使うメッセージ チャネルの ID。頼まなかったときや、サーバーが使わないときは無い */
	messageChannelId?: number;
};

/** MCS Connect Response から、サーバーのデータブロックを読む */
export function parseConnectResponse(raw: Uint8Array): ServerData {
	const top = der.mustRead(raw);
	if (top.tag !== 0x7f66) throw new Error("MCS: Connect Response ではない");
	const items = der.readAll(top.value);
	const result = items[0] ? der.readInteger(items[0]) : -1;
	if (result !== 0) throw new Error(`MCS: 接続を断られた (result ${result})`);
	const user = items[3];
	if (!user) throw new Error("MCS: Connect Response に userData が無い");
	const gcc = user.value;
	// ConferenceCreateResponse の中の "McDn" の後ろに、PER の長さ付きでブロックが並ぶ
	let at = -1;
	for (let i = 0; i + 4 <= gcc.length; i++) {
		if (
			gcc[i] === 0x4d &&
			gcc[i + 1] === 0x63 &&
			gcc[i + 2] === 0x44 &&
			gcc[i + 3] === 0x6e
		) {
			at = i + 4;
			break;
		}
	}
	if (at < 0) throw new Error("GCC: McDn が見つからない");
	const r = new Reader(gcc, at);
	const len = readPerLength(r);
	const blocks = r.sub(Math.min(len, r.left));

	const out: ServerData = {
		ioChannelId: 0,
		channelIds: [],
		earlyCapabilityFlags: 0,
	};
	while (blocks.left >= 4) {
		const type = blocks.u16();
		const size = blocks.u16();
		const b = blocks.sub(size - 4);
		if (type === 0x0c01) {
			b.u32(); // version
			if (b.left >= 4) b.u32(); // clientRequestedProtocols
			if (b.left >= 4) out.earlyCapabilityFlags = b.u32();
		} else if (type === 0x0c03) {
			out.ioChannelId = b.u16();
			const n = b.u16();
			for (let i = 0; i < n; i++) out.channelIds.push(b.u16());
		} else if (type === 0x0c04 && b.left >= 2) {
			// SC_MCS_MSGCHANNEL: 0 は割り当てなし
			out.messageChannelId = b.u16() || undefined;
		}
	}
	if (!out.ioChannelId)
		throw new Error("GCC: サーバーが I/O チャネルを返さない");
	return out;
}

// ---- Connect のあとの PDU(PER) ----

export const erectDomainRequest = () =>
	Uint8Array.of(0x04, 0x01, 0x00, 0x01, 0x00);
export const attachUserRequest = () => Uint8Array.of(0x28);

export function parseAttachUserConfirm(b: Uint8Array): number {
	const r = new Reader(b);
	if (r.u8() >> 2 !== 11) throw new Error("MCS: Attach User Confirm ではない");
	const result = r.u8();
	if (result !== 0) throw new Error(`MCS: Attach User を断られた (${result})`);
	return r.u16be() + BASE;
}

export function channelJoinRequest(
	userId: number,
	channelId: number,
): Uint8Array {
	return new Writer(5)
		.u8(0x38)
		.u16be(userId - BASE)
		.u16be(channelId)
		.done();
}

export function parseChannelJoinConfirm(b: Uint8Array): number {
	const r = new Reader(b);
	if (r.u8() >> 2 !== 15) throw new Error("MCS: Channel Join Confirm ではない");
	const result = r.u8();
	if (result !== 0) throw new Error(`MCS: チャネルに入れなかった (${result})`);
	r.u16be(); // initiator
	r.u16be(); // requested
	return r.u16be();
}

/** Send Data Request(クライアント → サーバー) */
export function sendDataRequest(
	userId: number,
	channelId: number,
	data: Uint8Array,
): Uint8Array {
	return new Writer(data.length + 8)
		.u8(0x64)
		.u16be(userId - BASE)
		.u16be(channelId)
		.u8(0x70) // 優先度 high、先頭かつ最後の断片
		.bytes(perLength(data.length))
		.bytes(data)
		.done();
}

/** サーバーが切った。エラーではなく、ふつうの終わり */
export class Disconnected extends Error {}

export type SendData = { channelId: number; data: Uint8Array };

/** Send Data Indication(サーバー → クライアント)を読む。切断の通知なら例外にする */
export function parseSendDataIndication(b: Uint8Array): SendData {
	const r = new Reader(b);
	const choice = r.u8() >> 2;
	if (choice === 8)
		throw new Disconnected("サーバーが切断した(Disconnect Provider Ultimatum)");
	if (choice !== 26)
		throw new Error(`MCS: Send Data Indication ではない (${choice})`);
	r.u16be(); // initiator
	const channelId = r.u16be();
	r.u8(); // priority / segmentation
	const len = readPerLength(r);
	return { channelId, data: r.bytes(len) };
}
