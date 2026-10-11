// WebSocket(ブラウザの IronRDP)と RDP サーバーのあいだの中継。
//
// 1. 最初に RDCleanPath の要求を受け取る(複数のメッセージに分かれて来てもよい)
// 2. RDP サーバーに TCP でつなぎ、要求に入っていた X.224 の接続要求を送り、接続確認を受け取る
// 3. 同じソケットの上で TLS を張り、サーバーの証明書の連なりを取る
// 4. RDCleanPath の応答(接続確認 + 証明書)を返し、あとは WebSocket ↔ TLS をそのまま流す
//
// つなぐ先は設定で決めた 1 か所だけ。ブラウザが送ってくる destination は見ない(どこへでも行ける中継にしない)。

import net from "node:net";
import tls from "node:tls";
import type { ServerWebSocket } from "bun";
import {
	encodeError,
	encodeResponse,
	GENERAL_ERROR,
	NEGOTIATION_ERROR,
	parseRequest,
	VERSION,
} from "./rdcleanpath.ts";

/** RDP の自己署名証明書は鍵の用途が Key Encipherment / Data Encipherment だけで、Digital Signature が無い。
 * bun の TLS(BoringSSL)は ECDHE のときにそれを拒むので、RSA の鍵交換に絞る。つなぐのは同じマシンの RDP なので、
 * 前方秘匿性が無いことは問題にならない */
const RDP_TLS: tls.ConnectionOptions = {
	rejectUnauthorized: false,
	maxVersion: "TLSv1.2",
	ciphers: "AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256",
};

/** WebSocket の送りが溜まりすぎたら RDP 側を止める */
const HIGH_WATER = 4 * 1024 * 1024;

export type Target = { host: string; port: number };

export class Relay {
	private pending: Uint8Array = new Uint8Array(0);
	private started = false;
	private tls?: tls.TLSSocket;
	private raw?: net.Socket;
	private closed = false;

	constructor(
		private ws: ServerWebSocket<unknown>,
		private target: Target,
		/** RDCleanPath の proxy_auth を確かめる(ページに埋めた使い捨てのトークン) */
		private authorize: (proxyAuth: string | undefined) => boolean,
		private log: (msg: string) => void,
	) {}

	onMessage(data: Uint8Array) {
		if (this.tls) {
			this.tls.write(data);
			return;
		}
		if (this.started) {
			// 応答を返す前に届いた続き(本来は来ない)。TLS ができたら流す
			this.pending = concat(this.pending, data);
			return;
		}
		this.pending = concat(this.pending, data);
		let parsed: ReturnType<typeof parseRequest>;
		try {
			parsed = parseRequest(this.pending);
		} catch (e) {
			return this.fail(400, `bad RDCleanPath request: ${(e as Error).message}`);
		}
		if (!parsed) return;
		this.started = true;
		this.pending = parsed.rest;
		const { request } = parsed;
		if (request.version !== VERSION)
			return this.fail(
				400,
				`unsupported RDCleanPath version ${request.version}`,
			);
		if (!this.authorize(request.proxyAuth))
			return this.fail(401, "proxy_auth rejected");
		if (!request.x224)
			return this.fail(
				400,
				"no X.224 connection request (VMConnect is not supported)",
			);
		this.connect(request.x224, request.preconnectionBlob).catch((e) =>
			this.fail(502, (e as Error).message),
		);
	}

	private async connect(x224: Uint8Array, pcb: string | undefined) {
		const raw = net.connect(this.target.port, this.target.host);
		this.raw = raw;
		await new Promise<void>((ok, ng) => {
			raw.once("connect", ok);
			raw.once("error", ng);
		});
		if (pcb) raw.write(pcb);
		raw.write(x224);
		const cc = await readTpkt(raw);
		// RDP_NEG_FAILURE(0x03)なら TLS には進まず、そのまま返す(IronRDP が理由を出す)
		if (cc.length >= 12 && cc[11] === 0x03) {
			this.send(encodeError({ code: NEGOTIATION_ERROR }, cc));
			return this.close();
		}
		const sock = tls.connect({ ...RDP_TLS, socket: raw });
		this.tls = sock;
		await new Promise<void>((ok, ng) => {
			sock.once("secureConnect", ok);
			sock.once("error", ng);
		});
		this.send(
			encodeResponse(
				cc,
				certChain(sock),
				`${this.target.host}:${this.target.port}`,
			),
		);
		this.log(`relay up: ${sock.getProtocol()} ${sock.getCipher().name}`);

		sock.on("data", (chunk: Buffer) => {
			this.send(chunk);
			if (this.ws.getBufferedAmount() > HIGH_WATER) sock.pause();
		});
		sock.on("close", () => this.close());
		sock.on("error", (e) => {
			this.log(`rdp error: ${e.message}`);
			this.close();
		});
		if (this.pending.length) {
			sock.write(this.pending);
			this.pending = new Uint8Array(0);
		}
	}

	/** WebSocket の送りが空いた */
	onDrain() {
		if (this.tls?.isPaused()) this.tls.resume();
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.tls?.destroy();
		this.raw?.destroy();
		this.ws.close();
	}

	private send(data: Uint8Array) {
		if (!this.closed) this.ws.sendBinary(data);
	}

	private fail(httpStatus: number, msg: string) {
		this.log(`relay failed: ${msg}`);
		this.send(encodeError({ code: GENERAL_ERROR, httpStatus }));
		this.close();
	}
}

/** TPKT(RFC 1006)を 1 つ読む。ヘッダーの 3〜4 バイト目が全体の長さ */
function readTpkt(sock: net.Socket): Promise<Uint8Array> {
	return new Promise((ok, ng) => {
		let buf: Uint8Array = new Uint8Array(0);
		const onData = (chunk: Buffer) => {
			buf = concat(buf, chunk);
			if (buf.length < 4) return;
			if (buf[0] !== 3)
				return done(new Error("RDP server did not answer with TPKT"));
			const len = ((buf[2] as number) << 8) | (buf[3] as number);
			if (buf.length < len) return;
			if (buf.length > len)
				return done(
					new Error("unexpected data after X.224 connection confirm"),
				);
			done(null, buf);
		};
		const onError = (e: Error) => done(e);
		const done = (e: Error | null, v?: Uint8Array) => {
			sock.off("data", onData);
			sock.off("error", onError);
			if (e) ng(e);
			else ok(v as Uint8Array);
		};
		sock.on("data", onData);
		sock.on("error", onError);
	});
}

/** サーバー自身の証明書から順に、発行者をたどる(自己署名なら 1 枚) */
function certChain(sock: tls.TLSSocket): Uint8Array[] {
	const out: Uint8Array[] = [];
	let c = sock.getPeerCertificate(true) as
		| tls.DetailedPeerCertificate
		| undefined;
	const seen = new Set<string>();
	while (c?.raw && !seen.has(c.fingerprint256)) {
		seen.add(c.fingerprint256);
		out.push(new Uint8Array(c.raw));
		c = c.issuerCertificate;
	}
	if (!out.length) throw new Error("RDP server sent no certificate");
	return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}
