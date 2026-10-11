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
import { Acme, daysLeft } from "./acme.ts";
import { loadConfig, origin, type Target } from "./config.ts";
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
import { serveStatus } from "./status.ts";
import { EXIT_UPDATED, Updater } from "./update.ts";
import { VERSION } from "./version.ts";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const { config, file } = await loadConfig(Bun.argv);
log(
	`mado: ${file} を読んだ(${config.host}、つなぐ先 ${config.targets.map((t) => `${t.name}=${t.host}:${t.port}`).join(" ")})`,
);

const signer = await Signer.open(config.dataDir);
const base = origin(config);
const oidc = new Oidc(config.oidc, `${base}/callback`);
const secure = config.tls === "acme";

const SESSION = "mado";
const PENDING = "mado_login";
/** ログインしていられる時間。切れたら OIDC に行き直す(Entra 側にセッションがあれば一瞬で戻る) */
const SESSION_SECONDS = 8 * 60 * 60;
/** /api/token が出す中継のトークンの寿命。ページが受け取ってすぐ使う */
const RELAY_TOKEN_SECONDS = 60;

type Session = User;
/** 誰が・どこへ。つなぐ先はここで決まり、ブラウザが RDCleanPath に入れてくる行き先は見ない */
type RelayToken = { sub: string; target: string; jti: string };
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

const targetOf = (name: string | null | undefined) =>
	config.targets.find((t) => t.name === name) ?? null;

/** 使ったトークン(jti → 期限)。使い回しを弾く */
const used = new Map<string, number>();
function consume(token: string | undefined, sub: string): Target | null {
	const t = signer.verify<RelayToken & { exp: number }>(token);
	if (!t || t.sub !== sub || used.has(t.jti)) return null;
	used.set(t.jti, t.exp);
	const now = Date.now() / 1000;
	for (const [k, exp] of used) if (exp < now) used.delete(k);
	return targetOf(t.target);
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
		return Response.json(
			{
				name: s.name,
				version: VERSION,
				targets: config.targets.map((t) => t.name),
				ws: `${base.replace(/^http/, "ws")}/ws`,
			},
			{ headers: { "cache-control": "no-store" } },
		);
	},

	/** つなぐ直前に取る、使い捨ての中継のトークン(?target=<name>) */
	"/api/token": (req: BunRequest) => {
		const s = sessionOf(req);
		if (!s) return Response.json({ login: "/login?to=/" }, { status: 401 });
		const target = targetOf(new URL(req.url).searchParams.get("target"));
		if (!target) return text(404, "そのつなぐ先は無い");
		const token = signer.sign(
			{
				sub: s.sub,
				target: target.name,
				jti: randomToken(16),
			} satisfies RelayToken,
			RELAY_TOKEN_SECONDS,
		);
		return Response.json(
			{ token },
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

/** つないでいる WebSocket。誰もいないときだけ自動更新で入れ替える */
const sessions = new Set<Bun.ServerWebSocket<WsData>>();
let certDaysLeft: number | null = null;

const websocket = {
	// RDP は何も操作していないと静かになる。WebSocket の ping で保たせ、切るのは最長の 960 秒まで待つ
	idleTimeout: 960,
	maxPayloadLength: 16 * 1024 * 1024,
	open(ws: Bun.ServerWebSocket<WsData>) {
		const { user } = ws.data;
		ws.data.relay = new Relay(
			ws,
			(auth) => consume(auth, user.sub),
			(m) => log(`${user.name}: ${m}`),
		);
		sessions.add(ws);
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
		sessions.delete(ws);
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
		certDaysLeft = Math.floor(daysLeft(cert));
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

// --- 状態の口と自動更新 ------------------------------------------------------------------------
const startedAt = new Date().toISOString();
// exe として動いているときだけ自分を入れ替える(bun run で動かしているときは入れ替える exe が無い)
const updater = new Updater(
	{ repo: config.update.repo, exePath: process.execPath },
	log,
);
const canUpdate = config.update.enabled && Bun.isStandaloneExecutable;
if (canUpdate) await updater.cleanup();

/** 新しい版があり、誰もつないでいなければ入れ替えて終わる(起こし直すのは外側) */
async function tryUpdate(): Promise<boolean> {
	if (!canUpdate) return false;
	const state = await updater.check();
	if (!state.available || sessions.size > 0) return false;
	if (!(await updater.apply(() => sessions.size === 0))) return false;
	// POST /update の返事を返し切ってから終わる(すぐ終わると呼んだ側に「返事が途中で切れた」と出る)
	setTimeout(() => process.exit(EXIT_UPDATED), 1500);
	return true;
}

if (config.statusPort) {
	// 使えなくても本体(画面と中継)は止めない
	try {
		serveStatus(
			config.statusPort,
			() => ({
				version: VERSION,
				origin: base,
				startedAt,
				sessions: sessions.size,
				certDaysLeft,
				update: updater.state,
			}),
			async () => ({ updated: await tryUpdate(), state: updater.state }),
		);
		log(`状態の口: http://127.0.0.1:${config.statusPort}/status`);
	} catch (e) {
		log(`状態の口を開けない (${config.statusPort}): ${(e as Error).message}`);
	}
}
if (canUpdate) {
	const every = config.update.checkHours * 60 * 60 * 1000;
	const run = () =>
		tryUpdate().catch((e) => log(`update failed: ${(e as Error).message}`));
	// 起動直後は避けて 5 分後に 1 回、あとは checkHours ごと。つないでいて入れ替えられなかったときは 10 分ごとに試す
	setTimeout(run, 5 * 60 * 1000);
	setInterval(run, every);
	setInterval(
		() => {
			if (updater.state.available) void run();
		},
		10 * 60 * 1000,
	);
}
log(`mado ${VERSION}`);
