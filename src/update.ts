// 自分で新しい版に入れ替える。
//
// GitHub のリリースの最新を見て、今より新しければ mado.exe と mado.exe.sig を落とし、**署名を確かめてから**入れ替える。
// 署名は CI(release.yml)が Ed25519 の秘密鍵で `mado <タグ> <exe の SHA-256>` に付けたもので、確かめる公開鍵は
// 下の PUBLIC_KEY(exe に入っている)。タグも署名の中に入るので、古い版を「最新」と偽って戻させることもできない
// (今より新しい版しか受けない)。
//
// 入れ替えは、動いている exe の名前を mado.exe.old に変え(Windows でも動いている exe の名前は変えられる)、
// 新しいものを mado.exe に置いて、終了コード 75 で終わる。起こし直すのは外側(タスク スケジューラの run.cmd など)。
// 入れ替えるのは誰もつないでいないときだけ。

import { rename, unlink } from "node:fs/promises";
import { VERSION } from "./version.ts";

/** release.yml の秘密鍵(GitHub の secret MADO_SIGNING_KEY)と対になる公開鍵(Ed25519、raw 32 バイトの base64) */
export const PUBLIC_KEY = "d3WxGrdLVi/iQEGT5KnjS+B9KC1nDXB/FuW+ZXGVnjs=";

/** 入れ替えたあとの終了コード(BSD の EX_TEMPFAIL。「もう一度起こして」の意味で使う) */
export const EXIT_UPDATED = 75;

export const signedMessage = (tag: string, sha256hex: string) =>
	`mado ${tag} ${sha256hex}`;

export async function verifySignature(
	message: string,
	signatureB64: string,
	publicKeyB64 = PUBLIC_KEY,
): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			Buffer.from(publicKeyB64, "base64"),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			"Ed25519",
			key,
			Buffer.from(signatureB64.trim(), "base64"),
			new TextEncoder().encode(message),
		);
	} catch {
		return false;
	}
}

/** "v1.2.3" / "1.2.3" を比べる。a が新しければ正 */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) =>
		v
			.replace(/^v/, "")
			.split(/[.-]/)
			.slice(0, 3)
			.map((x) => Number.parseInt(x, 10) || 0);
	const [x, y] = [parse(a), parse(b)];
	for (let i = 0; i < 3; i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return d;
	}
	return 0;
}

export async function sha256File(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

type Release = {
	tag_name: string;
	assets: { name: string; browser_download_url: string }[];
};

export type UpdateState = {
	latest: string | null;
	available: boolean;
	checkedAt: string | null;
	error: string | null;
};

export class Updater {
	state: UpdateState = {
		latest: null,
		available: false,
		checkedAt: null,
		error: null,
	};
	private release: Release | null = null;
	private busy = false;

	constructor(
		private opts: { repo: string; exePath: string },
		private log: (msg: string) => void,
	) {}

	/** 前の入れ替えで残った mado.exe.old を消す(まだ掴まれていたら次の起動で) */
	async cleanup() {
		await unlink(`${this.opts.exePath}.old`).catch(() => {});
	}

	async check(): Promise<UpdateState> {
		try {
			const res = await fetch(
				`https://api.github.com/repos/${this.opts.repo}/releases/latest`,
				{
					headers: {
						accept: "application/vnd.github+json",
						"user-agent": `mado/${VERSION}`,
					},
				},
			);
			if (!res.ok) throw new Error(`GitHub (${res.status})`);
			this.release = (await res.json()) as Release;
			this.state = {
				latest: this.release.tag_name,
				available: compareVersions(this.release.tag_name, VERSION) > 0,
				checkedAt: new Date().toISOString(),
				error: null,
			};
		} catch (e) {
			this.state = {
				...this.state,
				checkedAt: new Date().toISOString(),
				error: (e as Error).message,
			};
		}
		return this.state;
	}

	/** 新しい版を落として確かめ、入れ替える。入れ替えたら true(呼んだ側が EXIT_UPDATED で終わる) */
	async apply(): Promise<boolean> {
		const r = this.release;
		if (!r || !this.state.available || this.busy) return false;
		this.busy = true;
		const exe = this.opts.exePath;
		const fresh = `${exe}.new`;
		try {
			const url = (name: string) => {
				const a = r.assets.find((x) => x.name === name);
				if (!a) throw new Error(`${r.tag_name} に ${name} が無い`);
				return a.browser_download_url;
			};
			const sig = await (await ok(fetch(url("mado.exe.sig")))).text();
			await Bun.write(fresh, await ok(fetch(url("mado.exe"))));
			const digest = await sha256File(fresh);
			if (!(await verifySignature(signedMessage(r.tag_name, digest), sig))) {
				throw new Error(`${r.tag_name} の署名が合わない`);
			}
			await unlink(`${exe}.old`).catch(() => {});
			await rename(exe, `${exe}.old`);
			await rename(fresh, exe);
			this.log(
				`update: ${VERSION} → ${r.tag_name} に入れ替えた。終わって起こし直してもらう`,
			);
			return true;
		} catch (e) {
			this.state.error = (e as Error).message;
			this.log(`update failed: ${(e as Error).message}`);
			await unlink(fresh).catch(() => {});
			return false;
		} finally {
			this.busy = false;
		}
	}
}

async function ok(res: Promise<Response>): Promise<Response> {
	const r = await res;
	if (!r.ok) throw new Error(`${r.url} (${r.status})`);
	return r;
}
