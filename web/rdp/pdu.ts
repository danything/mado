// 接続の手順([MS-RDPBCGR] 1.3.1.1)で使う PDU。Client Info、ライセンス、Share Control / Share Data、能力セット。

import { Reader, Writer } from "./bytes";
import { keyboardSubType, keyboardType } from "./mcs";

/** MCS のユーザー ID のうち、サーバー(Share Control の出し元)は 1002 */
export const SERVER_ID = 0x03ea;

// ---- Basic Security Header ----
// TLS の上でも、Client Info とライセンスの PDU には付く

export const SEC_LICENSE_PKT = 0x0080;
export const SEC_INFO_PKT = 0x0040;

export function securityHeader(flags: number): Uint8Array {
	return new Writer(4).u16(flags).u16(0).done();
}

// ---- Client Info ----

export type ClientInfo = {
	domain: string;
	user: string;
	password: string;
};

const INFO_MOUSE = 0x1;
const INFO_DISABLECTRLALTDEL = 0x2;
const INFO_AUTOLOGON = 0x8;
const INFO_UNICODE = 0x10;
const INFO_MAXIMIZESHELL = 0x20;
const INFO_LOGONNOTIFY = 0x40;
const INFO_ENABLEWINDOWSKEY = 0x100;
const INFO_LOGONERRORS = 0x10000;

/**
 * 重い描画を切って、送る量を減らす。壁紙、ドラッグ中のウィンドウの中身、メニューのアニメーション、テーマ、カーソルの影を止める。
 * 文字の縁は滑らかにする
 */
const PERF_FLAGS = 0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x80;

/** Client Info PDU の中身。Security Header は含まない。パスワードは CredSSP に渡したものと同じ */
export function clientInfo(info: ClientInfo): Uint8Array {
	const z = (s: string) => new Writer(s.length * 2 + 2).utf16(s, true).done();
	const domain = z(info.domain);
	const user = z(info.user);
	const password = z(info.password);
	const shell = z("");
	const dir = z("");
	const address = z("127.0.0.1");
	const clientDir = z("");
	// cb* は終端の NUL を含まない
	return (
		new Writer(512)
			.u32(0) // CodePage(Unicode のときは使われない)
			.u32(
				INFO_MOUSE |
					INFO_DISABLECTRLALTDEL |
					INFO_AUTOLOGON |
					INFO_UNICODE |
					INFO_MAXIMIZESHELL |
					INFO_LOGONNOTIFY |
					INFO_ENABLEWINDOWSKEY |
					INFO_LOGONERRORS,
			)
			.u16(domain.length - 2)
			.u16(user.length - 2)
			.u16(password.length - 2)
			.u16(shell.length - 2)
			.u16(dir.length - 2)
			.bytes(domain)
			.bytes(user)
			.bytes(password)
			.bytes(shell)
			.bytes(dir)
			// TS_EXTENDED_INFO_PACKET
			.u16(2) // AF_INET
			.u16(address.length)
			.bytes(address)
			.u16(clientDir.length)
			.bytes(clientDir)
			.bytes(timeZone())
			.u32(0) // clientSessionId
			.u32(PERF_FLAGS)
			.u16(0) // cbAutoReconnectCookie
			.done()
	);
}

/** TS_TIME_ZONE_INFORMATION(172 バイト)。名前と切り替えの日付は空にし、Bias にブラウザの値を入れる */
function timeZone(): Uint8Array {
	return new Writer(172)
		.i32(new Date().getTimezoneOffset())
		.zeros(64 + 16)
		.i32(0)
		.zeros(64 + 16)
		.i32(0)
		.done();
}

// ---- ライセンス ----

const LICENSE_REQUEST = 0x01;
const LICENSE_NEW_REQUEST = 0x13;
const LICENSE_ERROR_ALERT = 0xff;
const STATUS_VALID_CLIENT = 7;

/**
 * Security Header のあとのライセンスの PDU を読む。
 * 「ライセンス不要」なら "valid" を返す。Windows はこちら。
 * LICENSE_REQUEST で交渉を求められたら "request" を返す。xrdp などはこちら。ほかのエラーは例外にする
 */
export function checkLicense(b: Uint8Array): "valid" | "request" {
	const r = new Reader(b);
	const type = r.u8();
	r.u8(); // flags(版)
	r.u16(); // wMsgSize
	if (type === LICENSE_REQUEST) return "request";
	if (type !== LICENSE_ERROR_ALERT)
		throw new Error(`ライセンスの PDU が想定外 (0x${type.toString(16)})`);
	const code = r.u32();
	if (code !== STATUS_VALID_CLIENT)
		throw new Error(`ライセンスのエラー (0x${code.toString(16)})`);
	return "valid";
}

/**
 * 試験用。LICENSE_REQUEST に NEW_LICENSE_REQUEST で答える。pre-master secret は暗号化せず、乱数のまま入れる。
 * xrdp は中身を見ないので通る。本物のライセンス サーバーには通らない
 */
export function dummyNewLicenseRequest(): Uint8Array {
	const blob = (type: number, data: Uint8Array) =>
		new Writer(data.length + 4).u16(type).u16(data.length).bytes(data).done();
	const name = new TextEncoder().encode("mado\0");
	const body = new Writer(160)
		.u32(1) // KEY_EXCHANGE_ALG_RSA
		.u32(0x04000100) // PlatformId
		.bytes(crypto.getRandomValues(new Uint8Array(32))) // ClientRandom
		.bytes(blob(0x0002, crypto.getRandomValues(new Uint8Array(72))))
		.bytes(blob(0x000f, name))
		.bytes(blob(0x0010, name))
		.done();
	return new Writer(body.length + 4)
		.u8(LICENSE_NEW_REQUEST)
		.u8(0x83) // 版 3 + EXTENDED_ERROR_MSG_SUPPORTED
		.u16(body.length + 4)
		.bytes(body)
		.done();
}

// ---- Share Control / Share Data ----

export const PDUTYPE = {
	DEMAND_ACTIVE: 0x1,
	CONFIRM_ACTIVE: 0x3,
	DEACTIVATE_ALL: 0x6,
	DATA: 0x7,
	SERVER_REDIR: 0xa,
} as const;

export const PDUTYPE2 = {
	UPDATE: 0x02,
	CONTROL: 0x14,
	POINTER: 0x1b,
	INPUT: 0x1c,
	SYNCHRONIZE: 0x1f,
	REFRESH_RECT: 0x21,
	SUPPRESS_OUTPUT: 0x23,
	SHUTDOWN_REQUEST: 0x24,
	SHUTDOWN_DENIED: 0x25,
	SAVE_SESSION_INFO: 0x26,
	FONTLIST: 0x27,
	FONTMAP: 0x28,
	SET_ERROR_INFO: 0x2f,
	MONITOR_LAYOUT: 0x37,
	FRAME_ACKNOWLEDGE: 0x38,
} as const;

export type ShareControl = { type: number; source: number; body: Uint8Array };

export function parseShareControl(b: Uint8Array): ShareControl {
	const r = new Reader(b);
	const total = r.u16();
	// 0x8000 台の値は Fast-Path 側と取り違えないための印で、ここには来ない
	const type = r.u16() & 0xf;
	const source = r.u16();
	return { type, source, body: r.bytes(Math.min(total, b.length) - 6) };
}

export function shareControl(
	type: number,
	source: number,
	body: Uint8Array,
): Uint8Array {
	return new Writer(body.length + 6)
		.u16(body.length + 6)
		.u16(0x10 | type) // protocolVersion 1
		.u16(source)
		.bytes(body)
		.done();
}

/** Share Data PDU を Share Control で包む。uncompressedLength は pduType2 から末尾までの長さで、payload より 4 バイト長い */
export function shareData(
	userId: number,
	shareId: number,
	type2: number,
	payload: Uint8Array,
): Uint8Array {
	const body = new Writer(payload.length + 12)
		.u32(shareId)
		.u8(0) // pad
		.u8(1) // streamId: STREAM_LOW
		.u16(payload.length + 4)
		.u8(type2)
		.u8(0) // compressedType
		.u16(0) // compressedLength
		.bytes(payload)
		.done();
	return shareControl(PDUTYPE.DATA, userId, body);
}

export type ShareData = { type2: number; payload: Uint8Array };

export function parseShareData(body: Uint8Array): ShareData {
	const r = new Reader(body);
	r.u32(); // shareId
	r.skip(2); // pad, streamId
	r.u16(); // uncompressedLength
	const type2 = r.u8();
	const compressed = r.u8();
	r.u16();
	if (compressed & 0x20)
		throw new Error("圧縮された Share Data PDU は受けられない");
	return { type2, payload: r.rest() };
}

/** Frame Acknowledge PDU(TS_FRAME_ACKNOWLEDGE_PDU、[MS-RDPBCGR])の本体。描き終えたフレームの ID を入れる */
export const frameAcknowledge = (frameId: number) =>
	new Writer(4).u32(frameId).done();

export const synchronize = (targetUser: number) =>
	new Writer(4).u16(1).u16(targetUser).done();

export const CONTROL = {
	REQUEST: 1,
	GRANTED: 2,
	DETACH: 3,
	COOPERATE: 4,
} as const;

export const control = (action: number, grantId = 0, controlId = 0) =>
	new Writer(8).u16(action).u16(grantId).u32(controlId).done();

export const fontList = () =>
	new Writer(8).u16(0).u16(0).u16(0x0003).u16(0x0032).done();

/** Set Error Info。サーバーが切る理由で、0 は異常なし */
export function parseErrorInfo(payload: Uint8Array): number {
	return new Reader(payload).u32();
}

// ---- Demand Active / Confirm Active ----

export type DemandActive = {
	shareId: number;
	/** 能力セットの type → 中身 */
	capabilities: Map<number, Uint8Array>;
};

export function parseDemandActive(body: Uint8Array): DemandActive {
	const r = new Reader(body);
	const shareId = r.u32();
	const lenSource = r.u16();
	r.u16(); // lengthCombinedCapabilities
	r.skip(lenSource);
	const n = r.u16();
	r.u16(); // pad
	const capabilities = new Map<number, Uint8Array>();
	for (let i = 0; i < n && r.left >= 4; i++) {
		const type = r.u16();
		const len = r.u16();
		capabilities.set(type, r.bytes(len - 4));
	}
	return { shareId, capabilities };
}

export const CAP = {
	GENERAL: 0x01,
	BITMAP: 0x02,
	ORDER: 0x03,
	POINTER: 0x08,
	INPUT: 0x0d,
	SOUND: 0x0c,
	FONT: 0x0e,
	BRUSH: 0x0f,
	GLYPH_CACHE: 0x10,
	CONTROL: 0x05,
	ACTIVATION: 0x07,
	VIRTUAL_CHANNEL: 0x14,
	MULTIFRAGMENT_UPDATE: 0x1a,
	LARGE_POINTER: 0x1b,
	SURFACE_COMMANDS: 0x1c,
	BITMAP_CODECS: 0x1d,
	FRAME_ACKNOWLEDGE: 0x1e,
} as const;

/** Frame Acknowledge 能力で伝える、応答していないフレームの最大数 */
export const MAX_UNACKNOWLEDGED_FRAMES = 3;

/** RemoteFX の codecId。クライアントが決めて宣言する */
export const RFX_CODEC_ID = 3;

/** RemoteFX のコーデック GUID、76772F12-BD72-4463-AFB3-B73C9C6F7886。GUID は先頭 3 つの欄がリトル エンディアン */
export const RFX_GUID = Uint8Array.of(
	0x12,
	0x2f,
	0x77,
	0x76,
	0x72,
	0xbd,
	0x63,
	0x44,
	0xaf,
	0xb3,
	0xb7,
	0x3c,
	0x9c,
	0x6f,
	0x78,
	0x86,
);

/**
 * Bitmap Codecs 能力の bitmapCodecCount 以降。載せるのは RemoteFX だけ。
 * 中身は 49 バイトの TS_RFX_CLNT_CAPS_CONTAINER で、RLGR1 と RLGR3、64x64 のタイル、ICT、DWT 5/3、画像モードを伝える
 */
export function bitmapCodecs(): Uint8Array {
	const icap = (entropy: number) =>
		new Writer(8)
			.u16(0x0100) // version 1.0
			.u16(0x0040) // tileSize
			.u8(0x02) // flags: CODEC_MODE(画像モード)
			.u8(0x01) // colConvBits: ICT
			.u8(0x01) // transformBits: DWT 5/3
			.u8(entropy)
			.done();
	const props = new Writer(49)
		.u32(49) // length
		.u32(0x01) // captureFlags: CARDP_CAPS_CAPTURE_NON_CAC
		.u32(37) // capsLength
		.u16(0xcbc0) // TS_RFX_CAPS: CBY_CAPS
		.u32(8)
		.u16(1) // numCapsets
		.u16(0xcbc1) // TS_RFX_CAPSET: CBY_CAPSET
		.u32(29)
		.u8(0x01) // codecId(固定)
		.u16(0xcfc0) // capsetType: CLY_CAPSET
		.u16(2) // numIcaps
		.u16(8) // icapLen
		.bytes(icap(0x01)) // RLGR1
		.bytes(icap(0x04)) // RLGR3
		.done();
	return new Writer(props.length + 24)
		.u8(1) // bitmapCodecCount
		.bytes(RFX_GUID)
		.u8(RFX_CODEC_ID)
		.u16(props.length)
		.bytes(props)
		.done();
}

/**
 * Demand Active に載ったサーバーの Bitmap Codecs 能力から、RemoteFX の codecId を探す。
 * サーバーが ID を載せていればそれを使う。xrdp のように載せていなければ、こちらが宣言した RFX_CODEC_ID を使う
 */
export function serverRfxCodecId(caps: Map<number, Uint8Array>): number {
	const b = caps.get(CAP.BITMAP_CODECS);
	if (!b || b.length < 1) return RFX_CODEC_ID;
	try {
		const r = new Reader(b);
		const n = r.u8();
		for (let i = 0; i < n; i++) {
			const guid = r.bytes(16);
			const id = r.u8();
			r.skip(r.u16());
			if (guid.every((v, j) => v === RFX_GUID[j]) && id !== 0) return id;
		}
	} catch {}
	return RFX_CODEC_ID;
}

export type ClientCaps = {
	width: number;
	height: number;
	keyboardLayout: number;
	/** Multifragment Update で受ける、1 つの更新の最大の大きさ */
	maxRequestSize?: number;
};

function cap(type: number, body: Uint8Array): Uint8Array {
	return new Writer(body.length + 4)
		.u16(type)
		.u16(body.length + 4)
		.bytes(body)
		.done();
}

/** Confirm Active に載せるクライアントの能力セット。Orders による描画はすべて断り、ビットマップと Surface Commands で受ける */
export function clientCapabilities(c: ClientCaps): Uint8Array[] {
	return [
		cap(
			CAP.GENERAL,
			new Writer(20)
				.u16(1) // OSMAJORTYPE_WINDOWS
				.u16(3) // OSMINORTYPE_WINDOWS_NT
				.u16(0x0200)
				.u16(0)
				.u16(0) // compressionTypes
				// FASTPATH_OUTPUT_SUPPORTED | LONG_CREDENTIALS_SUPPORTED | NO_BITMAP_COMPRESSION_HDR
				.u16(0x0001 | 0x0004 | 0x0400)
				.u16(0)
				.u16(0)
				.u16(0)
				.u8(0) // refreshRectSupport
				.u8(0) // suppressOutputSupport
				.done(),
		),
		cap(
			CAP.BITMAP,
			new Writer(24)
				.u16(32) // preferredBitsPerPixel
				.u16(1)
				.u16(1)
				.u16(1)
				.u16(c.width)
				.u16(c.height)
				.u16(0)
				.u16(1) // desktopResizeFlag
				.u16(1) // bitmapCompressionFlag
				.u8(0)
				.u8(0x02) // DRAW_ALLOW_DYNAMIC_COLOR_FIDELITY
				.u16(1) // multipleRectangleSupport
				.u16(0)
				.done(),
		),
		cap(
			CAP.ORDER,
			new Writer(84)
				.zeros(16) // terminalDescriptor
				.u32(0)
				.u16(1)
				.u16(20)
				.u16(0)
				.u16(1) // maximumOrderLevel: ORD_LEVEL_1_ORDERS
				.u16(0) // numberFonts
				.u16(0x0002 | 0x0008 | 0x0020) // NEGOTIATEORDERSUPPORT | ZEROBOUNDSDELTASSUPPORT | COLORINDEXSUPPORT
				.zeros(32) // orderSupport: どの Order も受けない
				.u16(0)
				.u16(0)
				.u32(0)
				.u32(0x38400) // desktopSaveSize
				.u16(0)
				.u16(0)
				.u16(0) // textANSICodePage
				.u16(0)
				.done(),
		),
		cap(CAP.POINTER, new Writer(6).u16(1).u16(20).u16(20).done()),
		cap(
			CAP.INPUT,
			new Writer(84)
				// INPUT_FLAG_SCANCODES | MOUSEX | UNICODE | FASTPATH_INPUT2
				.u16(0x0001 | 0x0004 | 0x0010 | 0x0020)
				.u16(0)
				.u32(c.keyboardLayout)
				.u32(keyboardType(c.keyboardLayout))
				.u32(keyboardSubType(c.keyboardLayout))
				.u32(12)
				.zeros(64)
				.done(),
		),
		cap(CAP.VIRTUAL_CHANNEL, new Writer(8).u32(0).u32(1600).done()),
		cap(CAP.SOUND, new Writer(4).u16(0).u16(0).done()),
		cap(CAP.FONT, new Writer(4).u16(1).u16(0).done()),
		cap(CAP.GLYPH_CACHE, new Writer(48).zeros(40).u32(0).u16(0).u16(0).done()),
		cap(CAP.BRUSH, new Writer(4).u32(0).done()),
		cap(CAP.CONTROL, new Writer(8).u16(0).u16(0).u16(2).u16(2).done()),
		cap(CAP.ACTIVATION, new Writer(8).u16(0).u16(0).u16(0).u16(0).done()),
		cap(
			CAP.MULTIFRAGMENT_UPDATE,
			new Writer(4).u32(c.maxRequestSize ?? 0x200000).done(),
		),
		cap(CAP.LARGE_POINTER, new Writer(2).u16(1).done()),
		// Surface Commands(Set / Stream Surface Bits + Frame Marker)と、RemoteFX のコーデック
		cap(
			CAP.SURFACE_COMMANDS,
			new Writer(8)
				.u32(0x02 | 0x10 | 0x40)
				.u32(0)
				.done(),
		),
		cap(CAP.BITMAP_CODECS, bitmapCodecs()),
		// Frame Acknowledge。応答していないフレームがこの数に達すると、サーバーは送るのを待つ。
		// こちらの復号が遅いときに、サーバーが送り続けて詰まることがなくなる。2 では往復の遅い回線で止まりやすいので 3 にした
		cap(
			CAP.FRAME_ACKNOWLEDGE,
			new Writer(4).u32(MAX_UNACKNOWLEDGED_FRAMES).done(),
		),
	];
}

/**
 * Demand Active への返事。Confirm Active のあとに同期の PDU(Synchronize、Control の Cooperate と Request、Font List)を続け、
 * I/O チャネルへ順に送る。つなぐときと、画面の大きさが変わって再アクティベーションするときに使う
 */
export function activationPdus(
	userId: number,
	shareId: number,
	caps: ClientCaps,
): Uint8Array[] {
	const data = (type2: number, payload: Uint8Array) =>
		shareData(userId, shareId, type2, payload);
	return [
		confirmActive(userId, shareId, clientCapabilities(caps)),
		data(PDUTYPE2.SYNCHRONIZE, synchronize(SERVER_ID)),
		data(PDUTYPE2.CONTROL, control(CONTROL.COOPERATE)),
		data(PDUTYPE2.CONTROL, control(CONTROL.REQUEST)),
		data(PDUTYPE2.FONTLIST, fontList()),
	];
}

/** Share Control で包んだ Confirm Active PDU */
export function confirmActive(
	userId: number,
	shareId: number,
	caps: Uint8Array[],
): Uint8Array {
	const source = new TextEncoder().encode("MSTSC\0");
	const combined = caps.reduce((n, c) => n + c.length, 0) + 4;
	const w = new Writer(combined + 32)
		.u32(shareId)
		.u16(SERVER_ID) // originatorId
		.u16(source.length)
		.u16(combined)
		.bytes(source)
		.u16(caps.length)
		.u16(0);
	for (const c of caps) w.bytes(c);
	return shareControl(PDUTYPE.CONFIRM_ACTIVE, userId, w.done());
}
