// 設定ファイル(TOML)。置き場所は `--config <path>`、無ければ exe と同じフォルダの mado.toml。

import path from "node:path";

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
	rdp: { host: string; port: number };
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
	rdp?: { host?: string; port?: number };
};

export async function loadConfig(
	argv: string[],
): Promise<{ config: Config; file: string }> {
	const i = argv.indexOf("--config");
	const file = path.resolve(
		i >= 0 && argv[i + 1]
			? argv[i + 1]
			: path.join(path.dirname(process.execPath), "mado.toml"),
	);
	const raw = Bun.TOML.parse(await Bun.file(file).text()) as Raw;
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
		rdp: { host: raw.rdp?.host ?? "127.0.0.1", port: raw.rdp?.port ?? 3389 },
	};
	if (config.tls === "acme" && !config.acme.email)
		throw new Error(`${file}: acme.email が要る`);
	return { config, file };
}

/** 外から見た URL の起点(https、tls = off なら http + ポート) */
export function origin(c: Config): string {
	if (c.tls === "off")
		return `http://${c.host}${c.listen.http === 80 ? "" : `:${c.listen.http}`}`;
	return `https://${c.host}${c.listen.https === 443 ? "" : `:${c.listen.https}`}`;
}
