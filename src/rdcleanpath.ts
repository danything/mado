// RDCleanPath の PDU(Devolutions の IronRDP の crates/ironrdp-rdcleanpath と同じ形)。
//
// ブラウザは RDP の TLS を自分で張れない。そこでブラウザは最初に RDCleanPath の要求(X.224 の接続要求入り)を送り、
// ゲートウェイが RDP サーバーと X.224 → TLS までを代わりにやって、サーバーの応答(X.224 の接続確認)と
// 証明書の連なりを返す。そのあとは平文の RDP をゲートウェイが TLS に包んで流す。証明書を返すのは、
// ブラウザ側の CredSSP がサーバーの公開鍵に結びつけた認証をするため。
//
//   RDCleanPathPdu ::= SEQUENCE {            -- 文脈タグはすべて EXPLICIT
//     version            [0] INTEGER,         -- 3390
//     error              [1] RDCleanPathErr OPTIONAL,
//     destination        [2] UTF8String OPTIONAL,
//     proxy_auth         [3] UTF8String OPTIONAL,
//     server_auth        [4] UTF8String OPTIONAL,
//     preconnection_blob [5] UTF8String OPTIONAL,
//     x224_connection_pdu [6] OCTET STRING OPTIONAL,
//     server_cert_chain  [7] SEQUENCE OF OCTET STRING OPTIONAL,
//     server_addr        [9] UTF8String OPTIONAL }
//   RDCleanPathErr ::= SEQUENCE {
//     error_code [0] INTEGER, http_status_code [1] INTEGER OPTIONAL,
//     wsa_last_error [2] INTEGER OPTIONAL, tls_alert_code [3] INTEGER OPTIONAL }

import {
	concat,
	integer,
	octets,
	readAll,
	readInteger,
	readOctets,
	readTlv,
	readUtf8,
	Tag,
	tlv,
	utf8,
} from "./der.ts";

export const VERSION = 3390;
export const GENERAL_ERROR = 1;
export const NEGOTIATION_ERROR = 2;

export type Request = {
	version: number;
	destination?: string;
	proxyAuth?: string;
	preconnectionBlob?: string;
	x224?: Uint8Array;
};

export type RdCleanPathError = {
	code: number;
	httpStatus?: number;
	wsaLastError?: number;
	tlsAlert?: number;
};

/** 届いたぶんで PDU が揃っていれば読む。揃っていなければ null(続きを待つ) */
export function parseRequest(
	buf: Uint8Array,
): { request: Request; rest: Uint8Array } | null {
	const outer = readTlv(buf);
	if (!outer) return null;
	if (outer.tag !== Tag.Sequence)
		throw new Error("RDCleanPath: not a SEQUENCE");
	const req: Request = { version: 0 };
	for (const field of readAll(outer.value)) {
		const inner = readTlv(field.value);
		if (!inner) throw new Error("RDCleanPath: empty field");
		switch (field.tag) {
			case Tag.context(0):
				req.version = Number(readInteger(inner));
				break;
			case Tag.context(2):
				req.destination = readUtf8(inner);
				break;
			case Tag.context(3):
				req.proxyAuth = readUtf8(inner);
				break;
			case Tag.context(5):
				req.preconnectionBlob = readUtf8(inner);
				break;
			case Tag.context(6):
				req.x224 = readOctets(inner);
				break;
			// server_auth [4] などは使わない
		}
	}
	return { request: req, rest: buf.subarray(outer.end) };
}

const field = (n: number, value: Uint8Array) => tlv(Tag.context(n), value);

export function encodeResponse(
	x224: Uint8Array,
	certChain: Uint8Array[],
	serverAddr: string,
): Uint8Array {
	return tlv(
		Tag.Sequence,
		field(0, integer(VERSION)),
		field(6, octets(x224)),
		field(7, tlv(Tag.Sequence, ...certChain.map(octets))),
		field(9, utf8(serverAddr)),
	);
}

export function encodeError(
	err: RdCleanPathError,
	x224?: Uint8Array,
): Uint8Array {
	const e: Uint8Array[] = [field(0, integer(err.code))];
	if (err.httpStatus !== undefined) e.push(field(1, integer(err.httpStatus)));
	if (err.wsaLastError !== undefined)
		e.push(field(2, integer(err.wsaLastError)));
	if (err.tlsAlert !== undefined) e.push(field(3, integer(err.tlsAlert)));
	const parts = [
		field(0, integer(VERSION)),
		field(1, tlv(Tag.Sequence, concat(e))),
	];
	if (x224) parts.push(field(6, octets(x224)));
	return tlv(Tag.Sequence, ...parts);
}
