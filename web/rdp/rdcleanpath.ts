// RDCleanPath(server/RdCleanPath.cs と同じ形)。最初に X.224 の接続要求を包んで送り、
// mado が RDP サーバーと TLS まで張ったら、X.224 の接続確認とサーバーの証明書の鎖が返ってくる。

import * as der from "./der";
import type { WsStream } from "./stream";
import { failureMessage, parseConnectionConfirm } from "./x224";

const VERSION = 3390;

export function request(
	x224: Uint8Array,
	token: string,
	destination: string,
): Uint8Array {
	return der.tlv(
		der.SEQUENCE,
		der.field(0, der.integer(VERSION)),
		der.field(2, der.utf8(destination)),
		der.field(3, der.utf8(token)),
		der.field(6, der.octets(x224)),
	);
}

export type Response = { x224: Uint8Array; certChain: Uint8Array[] };

export class RdCleanPathError extends Error {
	constructor(
		message: string,
		readonly x224?: Uint8Array,
	) {
		super(message);
	}
}

/** X.224 の接続確認に失敗の理由(RDP_NEG_FAILURE)があれば、それを言う */
function negotiationFailure(raw: Uint8Array | undefined): string {
	const base = "RDP サーバーが接続を断った";
	try {
		const cc = raw && parseConnectionConfirm(raw);
		if (cc && !cc.ok) return failureMessage(cc.failureCode);
	} catch {}
	return `${base}(ネゴシエーション)`;
}

/** 応答を 1 つ読む(DER の長さで切る) */
export async function readResponse(s: WsStream): Promise<Response> {
	const head = await s.peek(2);
	let headLen = 2;
	let len = head[1] as number;
	if (len & 0x80) {
		const n = len & 0x7f;
		const h = await s.peek(2 + n);
		len = 0;
		for (let i = 0; i < n; i++) len = len * 256 + (h[2 + i] as number);
		headLen += n;
	}
	if (len > 1 << 20) throw new Error("RDCleanPath: 応答が大きすぎる");
	const raw = await s.read(headLen + len);
	const f = der.fields(der.mustRead(raw).value);
	const x224 = f.get(6)?.value;
	const err = f.get(1);
	if (err) {
		const e = der.fields(err.value);
		const code = e.get(0) ? der.readInteger(e.get(0) as der.Tlv) : 0;
		const http = e.get(1) ? der.readInteger(e.get(1) as der.Tlv) : undefined;
		const what =
			code === 2
				? negotiationFailure(x224)
				: http === 401
					? "中継の許可が切れた(ページを読み込み直す)"
					: http === 502
						? "RDP サーバーにつなげなかった"
						: `中継の失敗 (${code}${http ? `/${http}` : ""})`;
		throw new RdCleanPathError(what, x224);
	}
	const chain = f.get(7);
	if (!x224 || !chain) throw new Error("RDCleanPath: incomplete response");
	return {
		x224,
		certChain: der.readAll(chain.value).map((t) => t.value),
	};
}
