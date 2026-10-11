// OIDC(認可コード + PKCE)でのログイン。
//
// **ライブラリは入れない**(denpa の src/lib/server/oidc.ts と同じ考え)。使う口は discovery・authorize・
// token・jwks の 4 つだけで、どれも fetch と WebCrypto で足りる。認証まわりで中身の分からない依存を抱えない。
// 相手は Entra ID を想定しているが、使うのは OIDC の標準だけ。
//
// ログインの途中の値(state / nonce / code_verifier)は署名付きの Cookie に持つので、サーバーは何も覚えない。

import type { Config } from "./config.ts";

export type User = { sub: string; name: string };

export type Pending = {
	state: string;
	nonce: string;
	verifier: string;
	to: string;
};

type Discovery = {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
};

type Claims = {
	iss: string;
	sub: string;
	aud: string | string[];
	exp: number;
	nbf?: number;
	nonce?: string;
	name?: string;
	preferred_username?: string;
	roles?: string[];
};

/** 時計のずれの許容(秒) */
const SKEW = 60;

const encoder = new TextEncoder();
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

export const randomToken = (bytes = 32) =>
	b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** 戻る先は自分のところの絶対パスだけ(`//evil.example` で外へ飛ばす踏み台にしない) */
export function safeReturn(to: string | null): string {
	return to?.startsWith("/") && !to.startsWith("//") ? to : "/";
}

export class Oidc {
	private discovered: Discovery | null = null;
	/** kid ごとの公開鍵。相手が鍵を入れ替えたときのために、見つからなければ取り直す */
	private keys = new Map<string, CryptoKey>();

	constructor(
		private c: Config["oidc"],
		private redirectUri: string,
	) {}

	/** 口の一覧。一度読んだら覚える(取れなかったときは覚えず、次にまた取りに行く) */
	private async discover(): Promise<Discovery> {
		if (this.discovered) return this.discovered;
		const url = `${this.c.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
		const res = await fetch(url);
		if (!res.ok)
			throw new Error(`OIDC の設定を読めない (${res.status}) ${url}`);
		const doc = (await res.json()) as Partial<Discovery>;
		for (const k of [
			"issuer",
			"authorization_endpoint",
			"token_endpoint",
			"jwks_uri",
		] as const) {
			if (typeof doc[k] !== "string")
				throw new Error(`OIDC の設定に ${k} が無い`);
		}
		this.discovered = doc as Discovery;
		return this.discovered;
	}

	async start(to: string): Promise<{ url: string; pending: Pending }> {
		const doc = await this.discover();
		const pending: Pending = {
			state: randomToken(),
			nonce: randomToken(),
			verifier: randomToken(),
			to,
		};
		const challenge = b64url(
			new Uint8Array(
				await crypto.subtle.digest("SHA-256", encoder.encode(pending.verifier)),
			),
		);
		const params = new URLSearchParams({
			client_id: this.c.clientId,
			response_type: "code",
			redirect_uri: this.redirectUri,
			scope: "openid profile",
			state: pending.state,
			nonce: pending.nonce,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		return { url: `${doc.authorization_endpoint}?${params}`, pending };
	}

	/** 戻ってきたコードを確かめ切ってユーザーを返す。通さない人なら Forbidden */
	async finish(code: string, pending: Pending): Promise<User> {
		const claims = await this.verify(
			await this.exchange(code, pending.verifier),
			pending.nonce,
		);
		if (
			this.c.requiredRole &&
			!(claims.roles ?? []).includes(this.c.requiredRole)
		) {
			throw new Forbidden(
				`ロール ${this.c.requiredRole} が割り当てられていない`,
			);
		}
		return {
			sub: claims.sub,
			name: claims.name ?? claims.preferred_username ?? claims.sub,
		};
	}

	/** コードを ID トークンに換える。秘密は本文に入れて送る(client_secret_post) */
	private async exchange(code: string, verifier: string): Promise<string> {
		const doc = await this.discover();
		const res = await fetch(doc.token_endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: this.redirectUri,
				client_id: this.c.clientId,
				client_secret: this.c.clientSecret,
				code_verifier: verifier,
			}),
		});
		const body = (await res.json().catch(() => ({}))) as {
			id_token?: string;
			error_description?: string;
		};
		if (!res.ok || typeof body.id_token !== "string") {
			throw new Error(
				`トークンを取得できない (${res.status}) ${body.error_description ?? ""}`.trim(),
			);
		}
		return body.id_token;
	}

	private async publicKey(kid: string): Promise<CryptoKey> {
		const cached = this.keys.get(kid);
		if (cached) return cached;
		const res = await fetch((await this.discover()).jwks_uri);
		if (!res.ok) throw new Error(`署名の鍵を取得できない (${res.status})`);
		const { keys } = (await res.json()) as {
			keys?: (JsonWebKey & { kid?: string })[];
		};
		for (const jwk of keys ?? []) {
			if (!jwk.kid || jwk.kty !== "RSA") continue;
			const key = await crypto.subtle.importKey(
				"jwk",
				{ ...jwk, key_ops: ["verify"], ext: true },
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				true,
				["verify"],
			);
			this.keys.set(jwk.kid, key);
		}
		const found = this.keys.get(kid);
		if (!found) throw new Error(`ID トークンの鍵 (${kid}) が見つからない`);
		return found;
	}

	/** ID トークンの署名まで確かめる(認可コードフローでは省いてよいことになっているが、WebCrypto で数行なので省かない) */
	private async verify(token: string, nonce: string): Promise<Claims> {
		const [h, p, s, ...extra] = token.split(".");
		if (!h || !p || !s || extra.length)
			throw new Error("ID トークンの形が違う");
		const header = JSON.parse(Buffer.from(h, "base64url").toString()) as {
			alg?: string;
			kid?: string;
		};
		// none を受けると署名を見ない道ができる。受けるのは RS256 だけ
		if (header.alg !== "RS256")
			throw new Error(`対応していない署名方式 (${header.alg})`);
		if (!header.kid) throw new Error("ID トークンに鍵の名前が無い");
		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			await this.publicKey(header.kid),
			unb64url(s),
			encoder.encode(`${h}.${p}`),
		);
		if (!ok) throw new Error("ID トークンの署名が合わない");

		const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Claims;
		if (claims.iss !== (await this.discover()).issuer)
			throw new Error("ID トークンの発行元が違う");
		if (![claims.aud].flat().includes(this.c.clientId))
			throw new Error("ID トークンの宛先が違う");
		const now = Math.floor(Date.now() / 1000);
		if (typeof claims.exp !== "number" || claims.exp + SKEW < now)
			throw new Error("ID トークンの期限が切れている");
		if (claims.nbf !== undefined && claims.nbf - SKEW > now)
			throw new Error("ID トークンがまだ有効でない");
		// 出したときの合言葉と一致すること。これが「自分が始めたログイン」の証拠
		if (claims.nonce !== nonce)
			throw new Error("ID トークンの nonce が合わない");
		if (typeof claims.sub !== "string" || !claims.sub)
			throw new Error("ID トークンに sub が無い");
		if (claims.roles !== undefined && !Array.isArray(claims.roles))
			throw new Error("ID トークンの roles の形が違う");
		return claims;
	}
}

export class Forbidden extends Error {}
