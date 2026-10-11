// Let's Encrypt から証明書を取る ACME(RFC 8555)のクライアント。HTTP-01 だけ。
//
// **ライブラリは入れない。** 使うのは新しいアカウント・注文・認可・確定・ダウンロードの決まった順の POST だけで、
// 署名(JWS ES256)は WebCrypto、CSR は der.ts と node:crypto で足りる。
//
// dataDir に置くもの: acme-account.json(アカウントの鍵と URL)、tls.key / tls.crt(証明書の鍵と連なり)。

import {
	generateKeyPairSync,
	sign as nodeSign,
	X509Certificate,
} from "node:crypto";
import path from "node:path";
import { bitString, integer, oid, Tag, tlv, utf8 } from "./der.ts";

const DIRECTORY = {
	production: "https://acme-v02.api.letsencrypt.org/directory",
	staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
};

/** 残りがこれを切ったら取り直す */
export const RENEW_BEFORE_DAYS = 30;

type Directory = { newNonce: string; newAccount: string; newOrder: string };
type Account = { jwk: JsonWebKey; url?: string };

const b64url = (b: Uint8Array | string) =>
	Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b).toString(
		"base64url",
	);

export class Acme {
	private nonce: string | null = null;
	private dir!: Directory;
	private key!: CryptoKey;
	private account!: Account;
	private thumbprint!: string;

	constructor(
		private opts: {
			host: string;
			email: string;
			staging: boolean;
			dataDir: string;
		},
		/** HTTP-01 の答えを 80 番で返す口に渡す(token → keyAuthorization) */
		private challenges: Map<string, string>,
		private log: (msg: string) => void,
	) {}

	private get files() {
		const d = this.opts.dataDir;
		return {
			account: path.join(d, "acme-account.json"),
			key: path.join(d, "tls.key"),
			cert: path.join(d, "tls.crt"),
		};
	}

	/** 置いてある証明書。期限が近い(または無い)なら取り直す */
	async ensure(): Promise<{ key: string; cert: string; renewed: boolean }> {
		const f = this.files;
		const [key, cert] = [Bun.file(f.key), Bun.file(f.cert)];
		if ((await key.exists()) && (await cert.exists())) {
			const pem = await cert.text();
			if (daysLeft(pem) > RENEW_BEFORE_DAYS)
				return { key: await key.text(), cert: pem, renewed: false };
		}
		const issued = await this.issue();
		await Bun.write(f.key, issued.key);
		await Bun.write(f.cert, issued.cert);
		return { ...issued, renewed: true };
	}

	private async issue(): Promise<{ key: string; cert: string }> {
		await this.init();
		this.log(`acme: ${this.opts.host} の証明書を取る`);
		const { body: order, location: orderUrl } = await this.post<{
			authorizations: string[];
			finalize: string;
		}>(this.dir.newOrder, {
			identifiers: [{ type: "dns", value: this.opts.host }],
		});

		for (const authzUrl of order.authorizations) {
			const { body: authz } = await this.post<{
				status: string;
				challenges: { type: string; url: string; token: string }[];
			}>(authzUrl);
			if (authz.status === "valid") continue;
			const ch = authz.challenges.find((c) => c.type === "http-01");
			if (!ch) throw new Error("acme: http-01 の課題が無い");
			this.challenges.set(ch.token, `${ch.token}.${this.thumbprint}`);
			try {
				await this.post(ch.url, {});
				await this.poll(authzUrl, "認可");
			} finally {
				this.challenges.delete(ch.token);
			}
		}

		const { privateKey, publicKey } = generateKeyPairSync("ec", {
			namedCurve: "prime256v1",
		});
		const csr = buildCsr(
			this.opts.host,
			publicKey.export({ type: "spki", format: "der" }),
			(data) => nodeSign("sha256", data, privateKey),
		);
		await this.post(order.finalize, { csr: b64url(csr) });
		const done = await this.poll<{ certificate: string }>(
			orderUrl as string,
			"注文",
		);
		const res = await this.postRaw(
			done.certificate,
			undefined,
			"application/pem-certificate-chain",
		);
		const cert = await res.text();
		this.log(`acme: 取れた(残り ${Math.floor(daysLeft(cert))} 日)`);
		return {
			key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
			cert,
		};
	}

	private async init() {
		const res = await fetch(
			this.opts.staging ? DIRECTORY.staging : DIRECTORY.production,
		);
		if (!res.ok)
			throw new Error(`acme: ディレクトリを読めない (${res.status})`);
		this.dir = (await res.json()) as Directory;

		const file = Bun.file(this.files.account);
		if (await file.exists()) {
			this.account = (await file.json()) as Account;
		} else {
			const pair = (await crypto.subtle.generateKey(
				{ name: "ECDSA", namedCurve: "P-256" },
				true,
				["sign", "verify"],
			)) as CryptoKeyPair;
			this.account = {
				jwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
			};
		}
		this.key = await crypto.subtle.importKey(
			"jwk",
			this.account.jwk,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["sign"],
		);
		const { crv, kty, x, y } = this.account.jwk;
		// RFC 7638: 必須の要素だけを辞書順で並べた JSON の SHA-256
		const canonical = JSON.stringify({ crv, kty, x, y });
		this.thumbprint = b64url(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(canonical),
				),
			),
		);

		if (!this.account.url) {
			const { location } = await this.post(this.dir.newAccount, {
				termsOfServiceAgreed: true,
				contact: [`mailto:${this.opts.email}`],
			});
			if (!location) throw new Error("acme: アカウントの URL が返ってこない");
			this.account.url = location;
			await Bun.write(file, JSON.stringify(this.account));
		}
	}

	/** 状態が valid になるまで待つ(Retry-After があれば従う) */
	private async poll<T>(url: string, what: string): Promise<T> {
		for (let i = 0; i < 30; i++) {
			const { body, retryAfter } = await this.post<
				T & { status: string; error?: unknown }
			>(url);
			if (body.status === "valid") return body;
			if (body.status === "invalid")
				throw new Error(`acme: ${what}が通らない ${JSON.stringify(body)}`);
			await Bun.sleep((retryAfter ?? 2) * 1000);
		}
		throw new Error(`acme: ${what}が終わらない`);
	}

	/** payload を省くと POST-as-GET */
	private async post<T = unknown>(
		url: string,
		payload?: object,
	): Promise<{ body: T; location: string | null; retryAfter: number | null }> {
		const res = await this.postRaw(url, payload);
		const retry = Number(res.headers.get("retry-after"));
		return {
			body: (await res.json()) as T,
			location: res.headers.get("location"),
			retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null,
		};
	}

	private async postRaw(
		url: string,
		payload?: object,
		accept = "application/json",
		retried = false,
	): Promise<Response> {
		const nonce = this.nonce ?? (await this.newNonce());
		this.nonce = null;
		const protectedHeader: Record<string, unknown> = {
			alg: "ES256",
			nonce,
			url,
		};
		if (this.account.url) protectedHeader.kid = this.account.url;
		else {
			const { crv, kty, x, y } = this.account.jwk;
			protectedHeader.jwk = { crv, kty, x, y };
		}
		const p = b64url(JSON.stringify(protectedHeader));
		const body = payload === undefined ? "" : b64url(JSON.stringify(payload));
		// WebCrypto の ECDSA の署名は r || s の形で、JWS の ES256 と同じ
		const sig = new Uint8Array(
			await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				this.key,
				new TextEncoder().encode(`${p}.${body}`),
			),
		);
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/jose+json", accept },
			body: JSON.stringify({
				protected: p,
				payload: body,
				signature: b64url(sig),
			}),
		});
		this.nonce = res.headers.get("replay-nonce");
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as {
				type?: string;
				detail?: string;
			};
			// nonce の使い回しを弾かれたら、新しい nonce で 1 回だけやり直す(RFC 8555 6.5)
			if (!retried && err.type === "urn:ietf:params:acme:error:badNonce")
				return this.postRaw(url, payload, accept, true);
			throw new Error(
				`acme: ${url} (${res.status}) ${err.type ?? ""} ${err.detail ?? ""}`.trim(),
			);
		}
		return res;
	}

	private async newNonce(): Promise<string> {
		const res = await fetch(this.dir.newNonce, { method: "HEAD" });
		const nonce = res.headers.get("replay-nonce");
		if (!nonce) throw new Error("acme: nonce が取れない");
		return nonce;
	}
}

/** PKCS#10 の署名要求。CN と SAN(dNSName)に host を 1 つ入れ、ECDSA P-256 + SHA-256 で署名する */
export function buildCsr(
	host: string,
	spki: Buffer,
	sign: (data: Uint8Array) => Buffer,
): Uint8Array {
	const name = tlv(
		Tag.Sequence,
		tlv(Tag.Set, tlv(Tag.Sequence, oid("2.5.4.3"), utf8(host))),
	);
	// GeneralName の dNSName は [2] IMPLICIT IA5String
	const san = tlv(Tag.Sequence, tlv(0x82, new TextEncoder().encode(host)));
	const extensions = tlv(
		Tag.Sequence,
		tlv(Tag.Sequence, oid("2.5.29.17"), tlv(Tag.OctetString, san)),
	);
	// attributes [0] IMPLICIT SET OF Attribute。extensionRequest(PKCS#9)に SAN を入れる
	const attributes = tlv(
		Tag.context(0),
		tlv(Tag.Sequence, oid("1.2.840.113549.1.9.14"), tlv(Tag.Set, extensions)),
	);
	const info = tlv(
		Tag.Sequence,
		integer(0),
		name,
		new Uint8Array(spki),
		attributes,
	);
	const ecdsaWithSha256 = tlv(Tag.Sequence, oid("1.2.840.10045.4.3.2"));
	return tlv(
		Tag.Sequence,
		info,
		ecdsaWithSha256,
		bitString(new Uint8Array(sign(info))),
	);
}

/** PEM の最初の証明書の残り日数 */
export function daysLeft(pem: string): number {
	return (
		(Date.parse(new X509Certificate(pem).validTo) - Date.now()) / 86_400_000
	);
}
