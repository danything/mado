// 回線の自動検出([MS-RDPBCGR] 2.2.14、3.2.5.4 / 3.3.5.4)。サーバーが MCS のメッセージ チャネルで RTT と帯域を測り、
// その結果で GFX / H.264 の画質とフレームの間隔を変える。クライアントは問われたものに答え、最後に届いた結果を覚えておく。
// 測るのは、つなぐ途中のライセンスのあと Demand Active の前と、つないだあと(continuous)。

import { concat, Reader, Writer } from "./bytes";
import { securityHeader } from "./pdu";

/** Basic Security Header の flags。サーバーの要求とクライアントの応答 */
export const SEC_AUTODETECT_REQ = 0x1000;
export const SEC_AUTODETECT_RSP = 0x2000;

const TYPE_ID_AUTODETECT_REQUEST = 0x00;
const TYPE_ID_AUTODETECT_RESPONSE = 0x01;

/** requestType(サーバー → クライアント) */
export const REQUEST = {
	RTT_CONTINUOUS: 0x0001,
	RTT_CONNECTTIME: 0x1001,
	BW_START_CONTINUOUS: 0x0014,
	BW_START_TUNNEL: 0x0114,
	BW_START_CONNECTTIME: 0x1014,
	BW_PAYLOAD: 0x0002,
	BW_STOP_CONNECTTIME: 0x002b,
	BW_STOP_CONTINUOUS: 0x0429,
	BW_STOP_TUNNEL: 0x0629,
	NETCHAR_BASE_AVERAGE_RTT: 0x0840,
	NETCHAR_BANDWIDTH_AVERAGE_RTT: 0x0880,
	NETCHAR_ALL: 0x08c0,
} as const;

/** responseType(クライアント → サーバー) */
export const RESPONSE = {
	RTT: 0x0000,
	BW_RESULTS_CONNECTTIME: 0x0003,
	BW_RESULTS_CONTINUOUS: 0x000b,
} as const;

/** サーバーが測って Network Characteristics Result で知らせてきた回線の様子。単位は ms と kbps */
export type NetworkInfo = {
	baseRtt?: number;
	averageRtt?: number;
	bandwidth?: number;
};

export type AutoDetectRequest = {
	sequenceNumber: number;
	requestType: number;
	/** つなぐ途中の Bandwidth Measure Payload / Stop の payload の長さ */
	payloadLength: number;
	/** Network Characteristics Result の中身 */
	network?: NetworkInfo;
};

/** Security Header の後ろの Auto-Detect Request を読む。形が違えば undefined */
export function parseRequest(b: Uint8Array): AutoDetectRequest | undefined {
	const r = new Reader(b);
	if (r.left < 6) return undefined;
	const headerLength = r.u8();
	const typeId = r.u8();
	if (typeId !== TYPE_ID_AUTODETECT_REQUEST || headerLength < 6)
		return undefined;
	const sequenceNumber = r.u16();
	const requestType = r.u16();
	const req: AutoDetectRequest = {
		sequenceNumber,
		requestType,
		payloadLength: 0,
	};
	if (
		requestType === REQUEST.BW_PAYLOAD ||
		requestType === REQUEST.BW_STOP_CONNECTTIME
	) {
		if (r.left < 2) return undefined;
		req.payloadLength = r.u16();
		if (r.left < req.payloadLength) return undefined;
	} else if ((requestType & 0xff3f) === 0x0800) {
		// 0x0840 / 0x0880 / 0x08C0。0x40 は baseRTT、0x80 は bandwidth があるしるし。averageRTT はいつもある
		const n =
			((requestType & 0x40) !== 0 ? 1 : 0) +
			((requestType & 0x80) !== 0 ? 1 : 0) +
			1;
		if (r.left < n * 4) return undefined;
		const network: NetworkInfo = {};
		if (requestType & 0x40) network.baseRtt = r.u32();
		if (requestType & 0x80) network.bandwidth = r.u32();
		network.averageRtt = r.u32();
		req.network = network;
	}
	return req;
}

/** Security Header の後ろに付ける RTT Measure Response */
export function rttResponse(sequenceNumber: number): Uint8Array {
	return new Writer(6)
		.u8(6)
		.u8(TYPE_ID_AUTODETECT_RESPONSE)
		.u16(sequenceNumber)
		.u16(RESPONSE.RTT)
		.done();
}

/** Security Header の後ろに付ける Bandwidth Measure Results。timeDelta は ms */
export function bandwidthResults(
	sequenceNumber: number,
	responseType: number,
	timeDelta: number,
	byteCount: number,
): Uint8Array {
	return new Writer(14)
		.u8(14)
		.u8(TYPE_ID_AUTODETECT_RESPONSE)
		.u16(sequenceNumber)
		.u16(responseType)
		.u32(timeDelta)
		.u32(byteCount)
		.done();
}

/** 測っている途中の帯域。つなぐ途中は payload の長さを数え、つないだあとは届いた PDU をすべて数える */
type Measuring = { start: number; bytes: number; connectTime: boolean };

/** メッセージ チャネルに届いたものに答える。つなぐ途中で作り、つないだあとも同じものを使う */
export class AutoDetect {
	private measuring?: Measuring;
	/** 最後に知らせてきた回線の様子 */
	network?: NetworkInfo;
	/** 答えた数。診断に出す */
	readonly stats = { rtt: 0, bandwidth: 0 };

	/** 時計(ms)。試験では差し替える */
	constructor(private now: () => number = () => performance.now()) {}

	/** 届いた PDU の大きさを、つないだあとの帯域の測定に足す。測っていないときは何もしない */
	received(bytes: number): void {
		if (this.measuring && !this.measuring.connectTime)
			this.measuring.bytes += bytes;
	}

	/** メッセージ チャネルの PDU を Security Header から読む。応答があれば Security Header を付けて返す */
	handle(data: Uint8Array): Uint8Array | undefined {
		if (data.length < 4) return undefined;
		const flags = (data[0] as number) | ((data[1] as number) << 8);
		// Heartbeat や Multitransport は頼んでいないので来ないはず。来ても読み飛ばす
		if (!(flags & SEC_AUTODETECT_REQ)) return undefined;
		const req = parseRequest(data.subarray(4));
		if (!req) return undefined;
		const body = this.answer(req);
		return body && concat(securityHeader(SEC_AUTODETECT_RSP), body);
	}

	private answer(req: AutoDetectRequest): Uint8Array | undefined {
		switch (req.requestType) {
			case REQUEST.RTT_CONTINUOUS:
			case REQUEST.RTT_CONNECTTIME:
				this.stats.rtt++;
				return rttResponse(req.sequenceNumber);
			case REQUEST.BW_START_CONTINUOUS:
			case REQUEST.BW_START_TUNNEL:
			case REQUEST.BW_START_CONNECTTIME:
				this.measuring = {
					start: this.now(),
					bytes: 0,
					connectTime: req.requestType === REQUEST.BW_START_CONNECTTIME,
				};
				return undefined;
			case REQUEST.BW_PAYLOAD:
				// つないだあとは received() が PDU 全体を数えている。二重に数えないよう、ここで足すのはつなぐ途中に限る
				if (this.measuring?.connectTime)
					this.measuring.bytes += req.payloadLength;
				return undefined;
			case REQUEST.BW_STOP_CONNECTTIME:
			case REQUEST.BW_STOP_CONTINUOUS:
			case REQUEST.BW_STOP_TUNNEL:
				return this.stop(req);
			case REQUEST.NETCHAR_BASE_AVERAGE_RTT:
			case REQUEST.NETCHAR_BANDWIDTH_AVERAGE_RTT:
			case REQUEST.NETCHAR_ALL:
				// 知らせてこなかった値は前のものを残す
				this.network = { ...this.network, ...req.network };
				return undefined;
		}
		return undefined; // Network Characteristics Sync など、知らないものには答えない
	}

	/** Bandwidth Measure Stop。始めてからの時間と数えたバイト数を返す。Start が無ければ 0 で答える */
	private stop(req: AutoDetectRequest): Uint8Array {
		const m = this.measuring;
		this.measuring = undefined;
		const connectTime = req.requestType === REQUEST.BW_STOP_CONNECTTIME;
		// Stop の payload も、つないだあとは received() が数えている
		const bytes = (m?.bytes ?? 0) + (m?.connectTime ? req.payloadLength : 0);
		const delta = m ? Math.max(0, Math.round(this.now() - m.start)) : 0;
		this.stats.bandwidth++;
		return bandwidthResults(
			req.sequenceNumber,
			connectTime
				? RESPONSE.BW_RESULTS_CONNECTTIME
				: RESPONSE.BW_RESULTS_CONTINUOUS,
			delta,
			bytes,
		);
	}
}
