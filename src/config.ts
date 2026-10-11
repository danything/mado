// 設定ファイル(JSON)。置き場所は `--config <path>`、無ければ exe と同じフォルダの mado.json。

import path from "node:path";

/** つなぐ先の RDP。画面で名前を選ぶ */
export type Target = { name: string; host: string; port: number };

export type Config = {
	/** 外から開く名前(証明書と OIDC のリダイレクト先に使う) */
	host: string;
	/** 証明書・鍵・セッションの鍵を置くフォルダ。既定は設定ファイルと同じフォルダの data */
	dataDir: string;
	listen: { https: number; http: number; hostname: string };
	/** off にすると TLS も ACME も使わず、http だけで待ち受ける(localhost で試すとき) */
	tls: "acme" | "off";
	acme: { email: string; staging: boolean };
	oidc: {
		issuer: string;
		clientId: string;
		clientSecret: string;
		/** ID トークンの roles にこれが無ければ入れない。空なら確かめない */
		requiredRole: string;
	};
	/** 1 つ以上。並びのまま画面に出す */
	targets: Target[];
	/** 127.0.0.1 の状態の口(status.ts)。0 なら開けない */
	statusPort: number;
	/** 自分で新しい版に入れ替える(update.ts)。checkHours ごとに GitHub のリリースを見る */
	update: { enabled: boolean; checkHours: number; repo: string };
};

type Raw = {
	host?: string;
	data_dir?: string;
	tls?: string;
	listen?: { https?: number; http?: number; hostname?: string };
	acme?: { email?: string; staging?: boolean };
	oidc?: {
		issuer?: string;
		client_id?: string;
		client_secret?: string;
		/** client_secret の代わりにファイルから読む(1 行目) */
		client_secret_file?: string;
		required_role?: string;
	};
	/** 省くとこのマシンの RDP(127.0.0.1:3389)だけ */
	targets?: { name?: string; host?: string; port?: number }[];
	status?: { port?: number };
	update?: { enabled?: boolean; check_hours?: number; repo?: string };
};

export async function loadConfig(
	argv: string[],
): Promise<{ config: Config; file: string }> {
	const i = argv.indexOf("--config");
	const file = path.resolve(
		i >= 0 && argv[i + 1]
			? argv[i + 1]
			: path.join(path.dirname(process.execPath), "mado.json"),
	);
	if (file.endsWith(".toml"))
		throw new Error(
			`${file}: 設定は v0.2 から JSON(mado.json)。README の「使い方」の形に書き直して`,
		);
	let raw: Raw;
	try {
		raw = (await Bun.file(file).json()) as Raw;
	} catch (e) {
		throw new Error(`${file}: JSON として読めない (${(e as Error).message})`);
	}
	const dir = path.dirname(file);
	const need = (v: string | undefined, name: string) => {
		if (!v) throw new Error(`${file}: ${name} が要る`);
		return v;
	};

	const o = raw.oidc ?? {};
	let clientSecret = o.client_secret;
	if (!clientSecret && o.client_secret_file) {
		clientSecret = (
			await Bun.file(path.resolve(dir, o.client_secret_file)).text()
		).split(/\r?\n/)[0];
	}
	const tls = raw.tls ?? "acme";
	if (tls !== "acme" && tls !== "off")
		throw new Error(`${file}: tls は acme か off`);

	const config: Config = {
		host: need(raw.host, "host"),
		dataDir: path.resolve(dir, raw.data_dir ?? "data"),
		listen: {
			https: raw.listen?.https ?? 443,
			http: raw.listen?.http ?? 80,
			hostname: raw.listen?.hostname ?? "::",
		},
		tls,
		acme: { email: raw.acme?.email ?? "", staging: raw.acme?.staging ?? false },
		oidc: {
			issuer: need(o.issuer, "oidc.issuer"),
			clientId: need(o.client_id, "oidc.client_id"),
			clientSecret: need(
				clientSecret,
				"oidc.client_secret または oidc.client_secret_file",
			),
			requiredRole: o.required_role ?? "",
		},
		targets: readTargets(raw, file),
		statusPort: raw.status?.port ?? 8788,
		update: {
			enabled: raw.update?.enabled ?? true,
			checkHours: raw.update?.check_hours ?? 6,
			repo: raw.update?.repo ?? "danything/mado",
		},
	};
	if (config.tls === "acme" && !config.acme.email)
		throw new Error(`${file}: acme.email が要る`);
	return { config, file };
}

function readTargets(raw: Raw, file: string): Target[] {
	if (raw.targets === undefined)
		return [{ name: "localhost", host: "127.0.0.1", port: 3389 }];
	if (!Array.isArray(raw.targets) || raw.targets.length === 0)
		throw new Error(`${file}: targets は 1 つ以上の配列`);
	const seen = new Set<string>();
	return raw.targets.map((t, i) => {
		const at = `${file}: targets[${i}]`;
		if (typeof t?.host !== "string" || !t.host)
			throw new Error(`${at}.host が要る`);
		const name = t.name ?? t.host;
		if (typeof name !== "string" || !name)
			throw new Error(`${at}.name は空でない文字列`);
		const port = t.port ?? 3389;
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error(`${at}.port は 1〜65535 の整数`);
		if (seen.has(name)) throw new Error(`${at}.name が重なっている (${name})`);
		seen.add(name);
		return { name, host: t.host, port };
	});
}

/** 外から見た URL の起点(https、tls = off なら http + ポート) */
export function origin(c: Config): string {
	if (c.tls === "off")
		return `http://${c.host}${c.listen.http === 80 ? "" : `:${c.listen.http}`}`;
	return `https://${c.host}${c.listen.https === 443 ? "" : `:${c.listen.https}`}`;
}
