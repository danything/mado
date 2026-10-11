// 署名付きの小さな値(Cookie とページに渡すトークン)。中身は JSON、HMAC-SHA256 で署名する。
// 鍵は dataDir/session.key(初回に作る)。鍵を消せば、出したものは全部使えなくなる。

import { timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export class Signer {
	private constructor(private key: Uint8Array) {}

	static async open(dataDir: string): Promise<Signer> {
		const file = Bun.file(path.join(dataDir, "session.key"));
		if (await file.exists())
			return new Signer(new Uint8Array(await file.arrayBuffer()));
		await mkdir(dataDir, { recursive: true });
		const key = crypto.getRandomValues(new Uint8Array(32));
		await Bun.write(file, key);
		return new Signer(key);
	}

	/** exp(秒)付きで署名する */
	sign(value: object, ttlSeconds: number): string {
		const body = Buffer.from(
			JSON.stringify({ ...value, exp: now() + ttlSeconds }),
		).toString("base64url");
		return `${body}.${this.mac(body)}`;
	}

	/** 署名と期限を確かめて中身を返す。だめなら null */
	verify<T extends object>(token: string | null | undefined): T | null {
		if (!token) return null;
		const dot = token.indexOf(".");
		if (dot < 0) return null;
		const body = token.slice(0, dot);
		const mac = Buffer.from(token.slice(dot + 1), "base64url");
		const want = Buffer.from(this.mac(body), "base64url");
		if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
		try {
			const v = JSON.parse(Buffer.from(body, "base64url").toString()) as T & {
				exp: number;
			};
			return v.exp > now() ? v : null;
		} catch {
			return null;
		}
	}

	private mac(body: string): string {
		return new Bun.CryptoHasher("sha256", this.key)
			.update(body)
			.digest("base64url");
	}
}

const now = () => Math.floor(Date.now() / 1000);
