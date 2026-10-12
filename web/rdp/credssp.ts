// CredSSP([MS-CSSP])。TLS の上で NTLM を回し、サーバーの公開鍵に結びつける。そのあとユーザー名とパスワードを封印して渡す。
// TLS は mado が張っているので、ここで読み書きする TSRequest は平文。公開鍵は RDCleanPath が返した証明書から取る。
//
//   TSRequest ::= SEQUENCE { version [0] INTEGER, negoTokens [1] NegoData OPTIONAL, authInfo [2] OCTET STRING OPTIONAL,
//     pubKeyAuth [3] OCTET STRING OPTIONAL, errorCode [4] INTEGER OPTIONAL, clientNonce [5] OCTET STRING OPTIONAL }
//   NegoData ::= SEQUENCE OF SEQUENCE { negoToken [0] OCTET STRING }

import { concat, equal, utf16le } from "./bytes";
import { random, sha256 } from "./crypto";
import * as der from "./der";
import { identity, Ntlm } from "./ntlm";
import type { ByteStream } from "./stream";

/** 受け取ってよい TSRequest の大きさの上限 */
const MAX_PDU = 1 << 20;
const VERSION = 6;
const enc = new TextEncoder();
const CLIENT_SERVER = enc.encode("CredSSP Client-To-Server Binding Hash\0");
const SERVER_CLIENT = enc.encode("CredSSP Server-To-Client Binding Hash\0");

type TsRequest = {
	version: number;
	negoToken?: Uint8Array;
	authInfo?: Uint8Array;
	pubKeyAuth?: Uint8Array;
	errorCode?: number;
	clientNonce?: Uint8Array;
};

export function writeTsRequest(t: TsRequest): Uint8Array {
	const parts = [der.field(0, der.integer(t.version))];
	if (t.negoToken)
		parts.push(
			der.field(
				1,
				der.tlv(
					der.SEQUENCE,
					der.tlv(der.SEQUENCE, der.field(0, der.octets(t.negoToken))),
				),
			),
		);
	if (t.authInfo) parts.push(der.field(2, der.octets(t.authInfo)));
	if (t.pubKeyAuth) parts.push(der.field(3, der.octets(t.pubKeyAuth)));
	if (t.clientNonce) parts.push(der.field(5, der.octets(t.clientNonce)));
	return der.tlv(der.SEQUENCE, ...parts);
}

export function parseTsRequest(raw: Uint8Array): TsRequest {
	const f = der.fields(der.mustRead(raw).value);
	const v = f.get(0);
	const t: TsRequest = { version: v ? der.readInteger(v) : 0 };
	const nego = f.get(1);
	if (nego) {
		const first = der.readAll(nego.value)[0];
		if (first) t.negoToken = der.fields(first.value).get(0)?.value;
	}
	t.authInfo = f.get(2)?.value;
	t.pubKeyAuth = f.get(3)?.value;
	const e = f.get(4);
	if (e) {
		// NTSTATUS は符号付きの INTEGER で来る
		let x = 0;
		for (const b of e.value) x = ((x << 8) | b) >>> 0;
		t.errorCode = x;
	}
	t.clientNonce = f.get(5)?.value;
	return t;
}

async function readTsRequest(s: ByteStream): Promise<TsRequest> {
	const head = await s.peek(2);
	if (head[0] !== der.SEQUENCE)
		throw new Error("CredSSP: サーバーの応答が TSRequest でない");
	const t = parseTsRequest(
		await der.readFrom(s, MAX_PDU, "CredSSP: TSRequest が大きすぎる"),
	);
	if (t.errorCode !== undefined) throw new Error(ntStatus(t.errorCode));
	return t;
}

function ntStatus(code: number): string {
	const known: Record<number, string> = {
		3221225581: "ユーザー名かパスワードが違う",
		3221225582: "このアカウントは使えない(制限)",
		3221225586: "このアカウントは無効",
		3221225585: "パスワードの期限が切れている",
		3221226020: "パスワードを変える必要がある",
		3221226036: "アカウントがロックされている",
		3221225819: "このユーザーはリモートからログオンできない",
	};
	const hex = `0x${code.toString(16).padStart(8, "0")}`;
	return known[code] ? `${known[code]} (${hex})` : `CredSSP の失敗 (${hex})`;
}

/** パスワードを入れる TSCredentials。中の文字列は UTF-16LE */
function tsCredentials(
	domain: string,
	user: string,
	password: string,
): Uint8Array {
	const u16 = utf16le;
	const creds = der.tlv(
		der.SEQUENCE,
		der.field(0, der.octets(u16(domain))),
		der.field(1, der.octets(u16(user))),
		der.field(2, der.octets(u16(password))),
	);
	return der.tlv(
		der.SEQUENCE,
		der.field(0, der.integer(1)),
		der.field(1, der.octets(creds)),
	);
}

export async function credssp(
	s: ByteStream,
	serverCert: Uint8Array,
	username: string,
	password: string,
): Promise<void> {
	const id = identity(username, password);
	const ntlm = new Ntlm(id);
	const publicKey = der.subjectPublicKey(serverCert);
	const nonce = random(32);

	s.write(writeTsRequest({ version: VERSION, negoToken: ntlm.negotiate }));
	const challenge = await readTsRequest(s);
	if (!challenge.negoToken)
		throw new Error("CredSSP: サーバーが NTLM の CHALLENGE を返さない");
	const peerVersion = challenge.version;
	// 版は、お互いに話せる低いほうに合わせる
	const version = Math.min(VERSION, peerVersion);
	const auth = ntlm.authenticate(challenge.negoToken);

	// サーバーの公開鍵に結びつける。v5 からはハッシュを封印して送る。
	// それより前は公開鍵そのものを封印して送り、サーバーは 1 足したものを返してくる
	const clientPub =
		peerVersion >= 5
			? await sha256(CLIENT_SERVER, nonce, publicKey)
			: publicKey;
	s.write(
		writeTsRequest({
			version,
			negoToken: auth,
			pubKeyAuth: ntlm.seal(clientPub),
			clientNonce: peerVersion >= 5 ? nonce : undefined,
		}),
	);
	const reply = await readTsRequest(s);
	if (!reply.pubKeyAuth)
		throw new Error("CredSSP: サーバーが公開鍵の確認を返さない");
	const serverPub = ntlm.unseal(reply.pubKeyAuth);
	const expected =
		peerVersion >= 5
			? await sha256(SERVER_CLIENT, nonce, publicKey)
			: increment(publicKey);
	if (!equal(serverPub, expected))
		throw new Error("CredSSP: サーバーの公開鍵が証明書と合わない");

	s.write(
		writeTsRequest({
			version,
			authInfo: ntlm.seal(tsCredentials(id.domain, id.user, password)),
		}),
	);
}

/** リトル エンディアンの数として 1 足す。CredSSP v2〜4 の公開鍵の応答に使う */
function increment(b: Uint8Array): Uint8Array {
	const o = concat(b);
	for (let i = 0; i < o.length; i++) {
		o[i] = ((o[i] as number) + 1) & 0xff;
		if (o[i] !== 0) break;
	}
	return o;
}
