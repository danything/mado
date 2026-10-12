// NTLMv2([MS-NLMP])。CredSSP の中で使う。Kerberos には対応せず、ローカル アカウントと NTLM で認証する。
// NEGOTIATE → CHALLENGE → AUTHENTICATE(MIC 付き)のあと、署名と封印(RC4)で pubKeyAuth と資格情報を包む。

import { concat, equal, Reader, utf16le, Writer } from "./bytes";
import { hmacMd5, md4, md5, Rc4, random } from "./crypto";

const SIGNATURE = new TextEncoder().encode("NTLMSSP\0");

const F = {
	UNICODE: 0x1,
	OEM: 0x2,
	REQUEST_TARGET: 0x4,
	SIGN: 0x10,
	SEAL: 0x20,
	LM_KEY: 0x80,
	NTLM: 0x200,
	DOMAIN_SUPPLIED: 0x1000,
	ALWAYS_SIGN: 0x8000,
	EXTENDED_SESSIONSECURITY: 0x80000,
	TARGET_INFO: 0x800000,
	VERSION: 0x2000000,
	N128: 0x20000000,
	KEY_EXCH: 0x40000000,
	N56: 0x80000000,
} as const;

const NEGOTIATE_FLAGS =
	F.N56 |
	F.OEM |
	F.N128 |
	F.ALWAYS_SIGN |
	F.EXTENDED_SESSIONSECURITY |
	F.NTLM |
	F.REQUEST_TARGET |
	F.UNICODE |
	F.VERSION |
	F.LM_KEY |
	F.SEAL |
	F.KEY_EXCH |
	F.SIGN;

/** Windows 10 の版。中身は見られないので、形だけ合わせる */
const VERSION = Uint8Array.of(10, 0, 0x61, 0x4a, 0, 0, 0, 15);

const AV_EOL = 0;
const AV_FLAGS = 6;
const AV_TIMESTAMP = 7;

const magic = (s: string) => new TextEncoder().encode(`${s}\0`);
const CLIENT_SIGN = magic(
	"session key to client-to-server signing key magic constant",
);
const SERVER_SIGN = magic(
	"session key to server-to-client signing key magic constant",
);
const CLIENT_SEAL = magic(
	"session key to client-to-server sealing key magic constant",
);
const SERVER_SEAL = magic(
	"session key to server-to-client sealing key magic constant",
);

export type Identity = { user: string; domain: string; password: string };

/** 「DOMAIN\user」はドメインとユーザーに分ける。「user@domain」は UPN なので、ドメイン欄を空にしてそのまま送る */
export function identity(username: string, password: string): Identity {
	const i = username.indexOf("\\");
	if (i >= 0)
		return {
			domain: username.slice(0, i),
			user: username.slice(i + 1),
			password,
		};
	return { domain: "", user: username, password };
}

export function ntowfv2(id: Identity): Uint8Array {
	return hmacMd5(
		md4(utf16le(id.password)),
		utf16le(id.user.toUpperCase() + id.domain),
	);
}

type AvPair = { id: number; value: Uint8Array };

function readAvPairs(b: Uint8Array): AvPair[] {
	const r = new Reader(b);
	const out: AvPair[] = [];
	while (r.left >= 4) {
		const id = r.u16();
		const len = r.u16();
		if (id === AV_EOL) break;
		out.push({ id, value: r.bytes(len) });
	}
	return out;
}

function writeAvPairs(pairs: AvPair[]): Uint8Array {
	const w = new Writer();
	for (const p of pairs) w.u16(p.id).u16(p.value.length).bytes(p.value);
	return w.u16(AV_EOL).u16(0).done();
}

export type Challenge = {
	raw: Uint8Array;
	flags: number;
	serverChallenge: Uint8Array;
	targetInfo: Uint8Array;
};

export function parseChallenge(raw: Uint8Array): Challenge {
	const r = new Reader(raw);
	if (!equal(r.bytes(8), SIGNATURE))
		throw new Error("NTLM: NTLMSSP の印が無い");
	if (r.u32() !== 2) throw new Error("NTLM: CHALLENGE ではない");
	r.skip(8); // TargetNameFields
	const flags = r.u32();
	const serverChallenge = r.bytes(8);
	r.skip(8);
	const tiLen = r.u16();
	r.u16();
	const tiOff = r.u32();
	if (tiOff + tiLen > raw.length) throw new Error("NTLM: TargetInfo が範囲外");
	return {
		raw,
		flags,
		serverChallenge,
		targetInfo: raw.slice(tiOff, tiOff + tiLen),
	};
}

/** 1 本の NTLM のやりとり。終わったら seal / unseal で包む */
export class Ntlm {
	negotiate: Uint8Array;
	private sendSign: Uint8Array = new Uint8Array();
	private recvSign: Uint8Array = new Uint8Array();
	private sendSeal?: Rc4;
	private recvSeal?: Rc4;
	private sendSeq = 0;
	private recvSeq = 0;

	constructor(
		private id: Identity,
		/** 試験用。既定は本物の乱数と時刻 */
		private opts: {
			clientChallenge?: Uint8Array;
			sessionKey?: Uint8Array;
			now?: bigint;
		} = {},
	) {
		this.negotiate = new Writer(40)
			.bytes(SIGNATURE)
			.u32(1)
			.u32(NEGOTIATE_FLAGS)
			.zeros(16) // DomainNameFields / WorkstationFields
			.bytes(VERSION)
			.done();
	}

	/** CHALLENGE を受けて AUTHENTICATE を作る */
	authenticate(challengeRaw: Uint8Array): Uint8Array {
		const ch = parseChallenge(challengeRaw);
		const pairs = readAvPairs(ch.targetInfo);
		const ts = pairs.find((p) => p.id === AV_TIMESTAMP);
		const timestamp = ts
			? new Reader(ts.value).u64()
			: (this.opts.now ?? fileTime());
		// サーバーが時刻を送ってきたら、MsvAvFlags の 0x2 を立てて MIC を付ける
		const useMic = !!ts;
		const authPairs = pairs.filter((p) => p.id !== AV_FLAGS);
		if (useMic)
			authPairs.push({ id: AV_FLAGS, value: Uint8Array.of(2, 0, 0, 0) });
		const targetInfo = concat(writeAvPairs(authPairs), new Uint8Array(4));

		const clientChallenge = this.opts.clientChallenge ?? random(8);
		const key = ntowfv2(this.id);
		const temp = new Writer()
			.u8(1)
			.u8(1)
			.zeros(6)
			.u64(timestamp)
			.bytes(clientChallenge)
			.zeros(4)
			.bytes(targetInfo)
			.done();
		const ntProof = hmacMd5(key, ch.serverChallenge, temp);
		const ntResponse = concat(ntProof, temp);
		// MIC を付けるときは、LM の応答を 24 バイトの 0 にする
		const lmResponse = useMic
			? new Uint8Array(24)
			: concat(
					hmacMd5(key, ch.serverChallenge, clientChallenge),
					clientChallenge,
				);
		const keyExchangeKey = hmacMd5(key, ntProof);

		let flags =
			F.N56 |
			F.N128 |
			F.ALWAYS_SIGN |
			F.EXTENDED_SESSIONSECURITY |
			F.NTLM |
			F.REQUEST_TARGET |
			F.UNICODE |
			F.TARGET_INFO |
			F.VERSION |
			F.SEAL |
			F.SIGN;
		if (ch.flags & F.KEY_EXCH) flags |= F.KEY_EXCH;
		if (this.id.domain) flags |= F.DOMAIN_SUPPLIED;

		let sessionKey: Uint8Array = keyExchangeKey;
		let encryptedKey: Uint8Array = new Uint8Array();
		if (flags & F.KEY_EXCH) {
			sessionKey = this.opts.sessionKey ?? random(16);
			encryptedKey = new Rc4(keyExchangeKey).apply(sessionKey);
		}

		const domain = utf16le(this.id.domain);
		const user = utf16le(this.id.user);
		const payload = [
			lmResponse,
			ntResponse,
			domain,
			user,
			new Uint8Array(),
			encryptedKey,
		];
		const w = new Writer(512).bytes(SIGNATURE).u32(3);
		let off = 64 + 8 + 16;
		// ヘッダーの欄は LM, NT, Domain, User, Workstation, EncryptedRandomSessionKey の順。
		// 中身は sspi-rs と同じく Domain, User, Workstation, LM, NT, Key の順に置く
		const order = [2, 3, 4, 0, 1, 5];
		const offsets: number[] = [];
		for (const i of order) {
			offsets[i] = off;
			off += (payload[i] as Uint8Array).length;
		}
		for (let i = 0; i < 6; i++) {
			const len = (payload[i] as Uint8Array).length;
			w.u16(len)
				.u16(len)
				.u32(offsets[i] as number);
		}
		w.u32(flags).bytes(VERSION);
		const micAt = w.mark(16);
		for (const i of order) w.bytes(payload[i] as Uint8Array);
		const msg = w.done();
		if (useMic)
			msg.set(hmacMd5(sessionKey, this.negotiate, ch.raw, msg), micAt);

		this.sendSign = md5(concat(sessionKey, CLIENT_SIGN));
		this.recvSign = md5(concat(sessionKey, SERVER_SIGN));
		this.sendSeal = new Rc4(md5(concat(sessionKey, CLIENT_SEAL)));
		this.recvSeal = new Rc4(md5(concat(sessionKey, SERVER_SEAL)));
		return msg;
	}

	/** EncryptMessage と同じく、16 バイトの署名のあとに封印した中身を続ける */
	seal(data: Uint8Array): Uint8Array {
		const seal = this.sendSeal;
		if (!seal) throw new Error("NTLM: 認証の前に封印しようとした");
		const seq = this.sendSeq++;
		const seqBytes = new Writer(4).u32(seq).done();
		const digest = hmacMd5(this.sendSign, seqBytes, data);
		const sealed = seal.apply(data);
		const checksum = seal.apply(digest.subarray(0, 8));
		return concat(
			new Writer(16).u32(1).bytes(checksum).u32(seq).done(),
			sealed,
		);
	}

	unseal(msg: Uint8Array): Uint8Array {
		const seal = this.recvSeal;
		if (!seal) throw new Error("NTLM: 認証の前に封印しようとした");
		if (msg.length < 16) throw new Error("NTLM: 封印したメッセージが短い");
		const r = new Reader(msg);
		r.u32();
		const checksum = r.bytes(8);
		const seq = r.u32();
		if (seq !== this.recvSeq) throw new Error("NTLM: 続き番号が合わない");
		this.recvSeq++;
		const data = seal.apply(r.rest());
		const digest = hmacMd5(this.recvSign, new Writer(4).u32(seq).done(), data);
		if (!equal(seal.apply(digest.subarray(0, 8)), checksum))
			throw new Error("NTLM: 署名が合わない");
		return data;
	}
}

/** 1601 年からの経過時間。単位は 100 ナノ秒 */
function fileTime(): bigint {
	return (BigInt(Date.now()) + 11644473600000n) * 10000n;
}
