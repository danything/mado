// mado: OIDC でログインして、ブラウザから RDP する小さなゲートウェイ。
//
//   https://<host>/          画面(IronRDP の Web クライアント)
//   https://<host>/login     OIDC のログインへ
//   https://<host>/callback  OIDC から戻ってくる口
//   https://<host>/api/session  ログイン中なら、中継に使う使い捨てのトークン
//   wss://<host>/ws          RDCleanPath の中継(gateway.ts)
//   http://<host>/.well-known/acme-challenge/*  Let's Encrypt の確認(80 番。ほかは https へ)

import type { BunRequest, Server } from "bun";
import index from "../web/index.html";
import { Acme } from "./acme.ts";
import { loadConfig, origin } from "./config.ts";
import { Relay } from "./gateway.ts";
import {
	Forbidden,
	Oidc,
	type Pending,
	randomToken,
	safeReturn,
	type User,
} from "./oidc.ts";
import { Signer } from "./sign.ts";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const { config, file } = await loadConfig(Bun.argv);
log(
	`mado: ${file} を読んだ(${config.host}、RDP は ${config.rdp.host}:${config.rdp.port})`,
);

const signer = await Signer.open(config.dataDir);
const base = origin(config);
const oidc = new Oidc(config.oidc, `${base}/callback`);
const secure = config.tls === "acme";

const SESSION = "mado";
const PENDING = "mado_login";
/** ログインしていられる時間。切れたら OIDC に行き直す(Entra 側にセッションがあれば一瞬で戻る) */
const SESSION_SECONDS = 8 * 60 * 60;
/** /api/session が出す中継のトークンの寿命。ページが受け取ってすぐ使う */
const RELAY_TOKEN_SECONDS = 60;

type Session = User;
type RelayToken = { sub: string; jti: string };
type WsData = { user: Session; relay?: Relay };

const cookie = (maxAge: number) => ({
	httpOnly: true,
	secure,
	sameSite: "lax" as const,
	path: "/",
	maxAge,
});
const sessionOf = (req: BunRequest) =>
	signer.verify<Session>(req.cookies.get(SESSION));
const text = (status: number, body: string) =>
	new Response(body, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});

/** 使ったトークン(jti → 期限)。使い回しを弾く */
const used = new Map<string, number>();
function consume(token: string | undefined, sub: string): boolean {
	const t = signer.verify<RelayToken & { exp: number }>(token);
	if (!t || t.sub !== sub || used.has(t.jti)) return false;
	used.set(t.jti, t.exp);
	const now = Date.now() / 1000;
	for (const [k, exp] of used) if (exp < now) used.delete(k);
	return true;
}

const routes = {
	"/": index,

	"/login": async (req: BunRequest) => {
		const to = safeReturn(new URL(req.url).searchParams.get("to"));
		const { url, pending } = await oidc.start(to);
		req.cookies.set(PENDING, signer.sign(pending, 600), cookie(600));
		return Response.redirect(url, 302);
	},

	"/callback": async (req: BunRequest) => {
		const params = new URL(req.url).searchParams;
		const pending = signer.verify<Pending>(req.cookies.get(PENDING));
		req.cookies.delete(PENDING, { path: "/" });
		if (params.get("error"))
			return text(
				403,
				`ログインできなかった: ${params.get("error_description") ?? params.get("error")}`,
			);
		const code = params.get("code");
		if (!pending || !code || params.get("state") !== pending.state) {
			return text(
				400,
				"ログインの途中の情報が合わない。最初からやり直して(/login)",
			);
		}
		try {
			const user = await oidc.finish(code, pending);
			req.cookies.set(
				SESSION,
				signer.sign(user, SESSION_SECONDS),
				cookie(SESSION_SECONDS),
			);
			log(`login: ${user.name} (${user.sub})`);
			return Response.redirect(pending.to, 302);
		} catch (e) {
			log(`login failed: ${(e as Error).message}`);
			return text(
				e instanceof Forbidden ? 403 : 502,
				`ログインできなかった: ${(e as Error).message}`,
			);
		}
	},

	"/logout": (req: BunRequest) => {
		req.cookies.delete(SESSION, { path: "/" });
		return text(200, "ログアウトした");
	},

	"/api/session": (req: BunRequest) => {
		const s = sessionOf(req);
		if (!s) return Response.json({ login: "/login?to=/" }, { status: 401 });
		const token = signer.sign(
			{ sub: s.sub, jti: randomToken(16) } satisfies RelayToken,
			RELAY_TOKEN_SECONDS,
		);
		return Response.json(
			{ name: s.name, token, ws: `${base.replace(/^http/, "ws")}/ws` },
			{ headers: { "cache-control": "no-store" } },
		);
	},

	"/ws": (req: BunRequest, server: Server<WsData>) => {
		// 別のサイトのページから、この Cookie を使ってつながせない
		if (req.headers.get("origin") !== base) return text(403, "origin が違う");
		const user = sessionOf(req);
		if (!user) return text(401, "ログインしていない");
		if (server.upgrade(req, { data: { user } })) return undefined;
		return text(400, "WebSocket で来て");
	},
};

const websocket = {
	// RDP は何も操作していないと静かになる。WebSocket の ping で保たせ、切るのは最長の 960 秒まで待つ
	idleTimeout: 960,
	maxPayloadLength: 16 * 1024 * 1024,
	open(ws: Bun.ServerWebSocket<WsData>) {
		const { user } = ws.data;
		ws.data.relay = new Relay(
			ws,
			config.rdp,
			(auth) => consume(auth, user.sub),
			(m) => log(`${user.name}: ${m}`),
		);
		log(`ws open: ${user.name}`);
	},
	message(ws: Bun.ServerWebSocket<WsData>, msg: string | Buffer) {
		if (typeof msg === "string") return ws.close(1003, "binary only");
		ws.data.relay?.onMessage(new Uint8Array(msg));
	},
	drain(ws: Bun.ServerWebSocket<WsData>) {
		ws.data.relay?.onDrain();
	},
	close(ws: Bun.ServerWebSocket<WsData>) {
		ws.data.relay?.close();
		log(`ws close: ${ws.data.user.name}`);
	},
};

const notFound = () => text(404, "not found");

if (config.tls === "off") {
	Bun.serve<WsData>({
		port: config.listen.http,
		hostname: config.listen.hostname,
		routes,
		websocket,
		fetch: notFound,
	});
	log(`http で待ち受け: ${base}`);
} else {
	// 80 番: Let's Encrypt の確認と、https への案内だけ
	const challenges = new Map<string, string>();
	Bun.serve({
		port: config.listen.http,
		hostname: config.listen.hostname,
		fetch(req) {
			const url = new URL(req.url);
			const m = url.pathname.match(
				/^\/\.well-known\/acme-challenge\/([\w-]+)$/,
			);
			if (m) {
				const answer = challenges.get(m[1] as string);
				return answer ? text(200, answer) : notFound();
			}
			return Response.redirect(`${base}${url.pathname}${url.search}`, 301);
		},
	});

	const acme = new Acme(
		{ ...config.acme, host: config.host, dataDir: config.dataDir },
		challenges,
		log,
	);
	let https: Server<WsData> | null = null;
	const serveHttps = async () => {
		const { key, cert, renewed } = await acme.ensure();
		if (https && !renewed) return;
		// 証明書を差し替えるときは待ち受けを作り直す(つながっている RDP は切れない。新しい接続から新しい証明書)
		https?.stop();
		https = Bun.serve<WsData>({
			port: config.listen.https,
			hostname: config.listen.hostname,
			tls: { key, cert },
			routes,
			websocket,
			fetch: notFound,
		});
		log(`https で待ち受け: ${base}`);
	};
	await serveHttps();
	// 12 時間ごとに残りを見る(30 日を切ったら取り直す)
	setInterval(
		() =>
			serveHttps().catch((e) => log(`acme failed: ${(e as Error).message}`)),
		12 * 60 * 60 * 1000,
	);
}
