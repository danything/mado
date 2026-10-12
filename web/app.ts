// 画面。自前の RDP クライアント(web/rdp)で RDP を話し、mado の /ws(RDCleanPath)を通して PC につなぐ。
// Windows のユーザー名とパスワードはブラウザの中の CredSSP が使うだけで、mado のサーバーには届かない。

import { attachChannels, type Channels } from "./rdp/channels";
import { RdpClient } from "./rdp/client";
import { connect } from "./rdp/connect";
import { bindInput, Display, watchSize } from "./rdp/display";
import { UPDATE } from "./rdp/fastpath";
import { avcSupported, GfxClient } from "./rdp/gfx";
import { CanvasGfxOps, WebCodecsAvc } from "./rdp/gfx-canvas";
import * as input from "./rdp/input";
import { createPool } from "./rdp/rfxpool";

type SessionInfo = {
	name: string;
	version: string;
	targets: string[];
	ws: string;
};

const $ = <T extends HTMLElement>(sel: string) =>
	document.querySelector(sel) as T;
const home = $<HTMLElement>("#home");
const form = $<HTMLFormElement>("#login");
const status = $<HTMLElement>("#status");
const toolbar = $<HTMLElement>("#toolbar");
const screen = $<HTMLElement>("#screen");
const field = (name: string) =>
	form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;

/** 前回選んだつなぐ先・画面の大きさ・ユーザー名(パスワードは覚えない) */
const REMEMBER = "mado:last";

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { cache: "no-store" });
	if (res.status === 401) {
		location.href = `/login?to=${encodeURIComponent(location.pathname)}`;
		throw new Error("login required");
	}
	if (!res.ok) throw new Error(`${url} (${res.status})`);
	return res.json();
}

const session = await getJson<SessionInfo>("/api/session");
$<HTMLElement>("#who").textContent = `${session.name} でログイン中`;
$<HTMLElement>("#version").textContent = `mado ${session.version}`;
const select = field("target") as HTMLSelectElement;
for (const name of session.targets) select.add(new Option(name, name));
// つなぐ先が 1 つなら選ぶ欄は出さない
$<HTMLElement>("#target-field").hidden = session.targets.length < 2;
try {
	const last = JSON.parse(localStorage.getItem(REMEMBER) ?? "{}") as {
		target?: string;
		size?: string;
		username?: string;
	};
	if (last.target && session.targets.includes(last.target))
		select.value = last.target;
	const sizes = field("size") as HTMLSelectElement;
	if (last.size && [...sizes.options].some((o) => o.value === last.size))
		sizes.value = last.size;
	if (last.username) field("username").value = last.username;
} catch {}
home.hidden = false;

const display = new Display(screen);

/** つなぐのに待つ長さ(CredSSP・ライセンス・同期まで) */
const CONNECT_TIMEOUT_MS = 30_000;

let current: { client: RdpClient; channels: Channels } | undefined;
/** つないでいる最中の取り消し用 */
let connecting: AbortController | undefined;
/** 最後に、ブラウザのクリップボードとリモートの間でやりとりした文字列(往復を防ぐ) */
let lastClipboard: string | undefined;

/**
 * 画面の送り方。上ほど遅延が小さく、送る量も少ない。
 * - avc: GFX + H.264(ブラウザが H.264 を復号できるとき)
 * - gfx: GFX(ClearCodec・Progressive など。H.264 なし)
 * - bitmap: 旧来の描画(RemoteFX・ビットマップ)
 * GFX を使えないサーバーは GFX のチャネルを開かないので、そのまま旧来の描画になる。
 * つないだあとで壊れたら、一つ下に切り替えて裏でつなぎ直す
 */
type Mode = "avc" | "gfx" | "bitmap";
const MODE_NAMES: Record<Mode, string> = {
	avc: "GFX + H.264",
	gfx: "GFX",
	bitmap: "ビットマップ / RemoteFX",
};

/** つないだ相手と認証(つなぎ直しに使う。パスワードは画面を閉じるまでメモリにだけ置く) */
type Login = {
	target: string;
	size: string;
	username: string;
	password: string;
};

/** 1 回つないで切れるまで。fallback があれば、その方式でつなぎ直す */
type SessionEnd = { message: string; fallback?: Mode };

/** 方式を切り替えた記録(診断用) */
const switches: string[] = [];

form.addEventListener("submit", async (e) => {
	e.preventDefault();
	const login: Login = {
		target: select.value,
		size: field("size").value,
		username: field("username").value,
		password: field("password").value,
	};
	try {
		const { target, size, username } = login;
		localStorage.setItem(REMEMBER, JSON.stringify({ target, size, username }));
	} catch {}
	const submit = form.querySelector("button[type=submit]") as HTMLButtonElement;
	// つないでいる途中に Enter でもう一度送られても、二つ目はつながない
	if (submit.getAttribute("aria-busy") === "true") return;
	submit.setAttribute("aria-busy", "true");
	status.textContent = "つないでいます…";
	switches.length = 0;
	// H.264 は、ブラウザが復号できるときだけ頼む
	let mode: Mode = (await avcSupported()) ? "avc" : "gfx";
	for (;;) {
		const end = await runSession(login, mode);
		if (!end.fallback) {
			status.textContent = end.message;
			break;
		}
		switches.push(
			`${new Date().toLocaleTimeString()} ${MODE_NAMES[mode]} → ${MODE_NAMES[end.fallback]}(${end.message})`,
		);
		mode = end.fallback;
	}
	current = undefined;
	display.clear();
	submit.removeAttribute("aria-busy");
	toolbar.hidden = true;
	screen.classList.add("idle");
	home.hidden = false;
	field("password").value = "";
});

async function runSession(login: Login, mode: Mode): Promise<SessionEnd> {
	const stops: (() => void)[] = [];
	try {
		// トークンは使い捨てで寿命が短いので、つなぐ直前に取る。つなぐ先はトークンに入り、サーバーが決める
		const { token } = await getJson<{ token: string }>(
			`/api/token?target=${encodeURIComponent(login.target)}`,
		);
		// 画面の場所を出してから大きさを測る(clientHeight を読むとレイアウトがその場で決まる)
		home.hidden = true;
		toolbar.hidden = false;
		$<HTMLElement>("#current").textContent = login.target;
		screen.classList.remove("idle");
		const { width, height } = desktopSize(login.size);
		const abort = new AbortController();
		connecting = abort;
		const timer = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
		const rdp = await connect({
			url: session.ws,
			token,
			destination: login.target,
			username: login.username,
			password: login.password,
			keyboardLayout: await detectKeyboardLayout(),
			width: even(width),
			height,
			signal: abort.signal,
			gfx: mode !== "bitmap",
		}).finally(() => {
			clearTimeout(timer);
			connecting = undefined;
		});
		const pool = createPool();
		const client = new RdpClient(rdp, display, { pool });
		const gfxClient =
			mode === "bitmap"
				? undefined
				: new GfxClient(
						new CanvasGfxOps(display),
						mode === "avc" ? new WebCodecsAvc() : undefined,
					);
		/** 壊れて、一つ下の方式でつなぎ直すとき */
		let fallback: SessionEnd | undefined;
		if (gfxClient) {
			gfxClient.onError = (e) => {
				console.warn("GFX:", e);
				noteError(`GFX: ${describe(e)}`);
			};
			gfxClient.onFatal = (e) => {
				console.error("GFX:", e);
				fallback = {
					message: `GFX が壊れた: ${describe(e)}`,
					fallback: "bitmap",
				};
				client.close();
			};
			gfxClient.onAvcBroken = () => {
				console.warn("GFX: H.264 を復号できない");
				fallback = { message: "H.264 を復号できない", fallback: "gfx" };
				client.close();
			};
		}
		const channels = attachChannels(client, writeClipboard, { gfx: gfxClient });
		current = { client, channels };
		if (gfxClient) stops.push(() => gfxClient.onClose());
		stops.push(watchDiag(() => diagText(client, gfxClient, pool.async)));
		stops.push(bindInput(display.canvas, client, display));
		stops.push(watchClipboard(display.canvas, channels));
		// 窓の大きさが変わったら、RDP の解像度も(画素数の割合をかけて)変える
		const scale = autoScale(login.size);
		stops.push(
			watchSize(screen, (w, h) =>
				channels.displayControl.resize(
					even(Math.round(w * scale)),
					Math.round(h * scale),
				),
			),
		);
		display.canvas.focus();
		status.textContent = "";
		const reason = await client.run();
		return fallback ?? { message: `切れた: ${reason}` };
	} catch (err) {
		return { message: `つなげなかった: ${describe(err)}` };
	} finally {
		for (const stop of stops) stop();
	}
}

// ---- 診断表示(ツールバーの「診断」) ----

const diag = $<HTMLPreElement>("#diag");
/** 直近のエラー(新しい順に 5 つまで) */
const recentErrors: string[] = [];
function noteError(text: string): void {
	recentErrors.unshift(`${new Date().toLocaleTimeString()} ${text}`);
	recentErrors.length = Math.min(recentErrors.length, 5);
}

window.addEventListener("error", (e) => noteError(e.message));
window.addEventListener("unhandledrejection", (e) =>
	noteError(describe(e.reason)),
);

/** Fast-Path の更新の種類の名前(fastpath.ts の UPDATE から) */
const UPDATE_NAMES: Record<number, string> = Object.fromEntries(
	Object.entries(UPDATE).map(([name, code]) => [code, name.toLowerCase()]),
);

function diagText(
	client: RdpClient,
	gfx: GfxClient | undefined,
	workers: boolean,
): string {
	// GFX を頼んでも、サーバーがチャネルを開かなければ旧来の描画のまま
	const mode: Mode = gfx?.active ? (gfx.avcEnabled ? "avc" : "gfx") : "bitmap";
	const lines = [
		`mado ${session.version}  方式: ${MODE_NAMES[mode]}  復号の場所: ${workers ? "Worker" : "その場"}`,
		`画面 ${display.canvas.width}x${display.canvas.height}  表示 ${display.canvas.clientWidth}x${display.canvas.clientHeight}`,
		`更新: ${
			Object.entries(client.stats)
				.map(([k, v]) => `${UPDATE_NAMES[Number(k)] ?? k}=${v}`)
				.join(" ") || "-"
		}`,
		// 間引き・捨てたは、RemoteFX のタイルと旧ビットマップの両方を数える
		`復号: 間引き=${client.decodeStats.coalesced} 捨てた=${client.decodeStats.skipped}`,
		networkText(client.network),
	];
	if (switches.length) lines.push("切り替え:", ...switches);
	if (gfx?.active)
		lines.push(
			`GFX: ${Object.entries(gfx.stats)
				.map(([k, v]) => `${k}=${v}`)
				.join(" ")} clear未対応=${gfx.clearUnsupported}`,
		);
	if (recentErrors.length) lines.push("エラー:", ...recentErrors);
	return lines.join("\n");
}

/** サーバーが測った回線(回線の自動検出)。測っていなければ答えた数だけ */
function networkText(n: RdpClient["network"]): string {
	const ms = (v?: number) => (v === undefined ? "-" : `${v}ms`);
	const info = n.info
		? `rtt=${ms(n.info.averageRtt)}(最小 ${ms(n.info.baseRtt)}) 帯域=${n.info.bandwidth === undefined ? "-" : `${n.info.bandwidth}kbps`}`
		: "-";
	return `回線: ${info}  測定に答えた数: rtt=${n.answered.rtt} 帯域=${n.answered.bandwidth}`;
}

/** 診断を開いた瞬間に書くためのもの(つないでいる間だけ) */
let diagNow: (() => void) | undefined;

/** 開いている間だけ 1 秒ごとに書き直す */
function watchDiag(text: () => string): () => void {
	diagNow = () => {
		diag.textContent = text();
	};
	const t = setInterval(() => {
		if (!diag.hidden) diag.textContent = text();
	}, 1000);
	return () => {
		clearInterval(t);
		diagNow = undefined;
		diag.hidden = true;
	};
}

/** キーを押して離す(Ctrl+Alt+Del のような組み合わせ用) */
function tap(codes: string[]): void {
	const events: Uint8Array[] = [];
	for (const c of codes) {
		const ev = input.keyEvent(c, true);
		if (ev) events.push(ev);
	}
	for (const c of [...codes].reverse()) {
		const ev = input.keyEvent(c, false);
		if (ev) events.push(ev);
	}
	current?.client.sendInput(events);
}

toolbar.addEventListener("click", (e) => {
	const action = (e.target as HTMLElement).closest("button")?.dataset.action;
	if (action === "ctrl-alt-del") tap(["ControlLeft", "AltLeft", "Delete"]);
	else if (action === "meta") tap(["MetaLeft"]);
	else if (action === "diag") {
		diag.hidden = !diag.hidden;
		if (!diag.hidden) diagNow?.();
	} else if (action === "fullscreen") void screen.requestFullscreen();
	else if (action === "disconnect") {
		current?.client.close();
		connecting?.abort();
	}
});

// ---- クリップボード ----

/** リモートでコピーされた文字列を、ブラウザのクリップボードへ(権限が無ければ黙って諦める) */
function writeClipboard(text: string): void {
	lastClipboard = text;
	void navigator.clipboard?.writeText(text).catch(() => {});
}

/** 画面にフォーカスが来たとき、ブラウザのクリップボードの文字列をリモートへ知らせる(変わっていたときだけ) */
function watchClipboard(canvas: HTMLElement, channels: Channels): () => void {
	const sync = async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (text !== lastClipboard) {
				lastClipboard = text;
				channels.clipboard.setLocalText(text);
			}
		} catch {}
	};
	canvas.addEventListener("focus", sync);
	void sync();
	return () => canvas.removeEventListener("focus", sync);
}

/** 幅は偶数でないと DisplayControl に断られる */
const even = (n: number) => n - (n % 2);

/**
 * RDP の解像度。窓(画面の場所)の大きさ × 画素数の割合。減らしたぶんは、表示で窓に合わせて拡大される(小さいほど描く量が減って軽い)
 */
function desktopSize(size: string): { width: number; height: number } {
	const k = autoScale(size);
	return {
		width: Math.round((screen.clientWidth || innerWidth) * k),
		height: Math.round((screen.clientHeight || innerHeight) * k),
	};
}

/** 画素数の割合(auto は 1、auto@0.5 は 0.5)。分からない値は 1 */
function autoScale(size: string): number {
	const m = size.match(/^auto(?:@([\d.]+))?$/);
	const k = m?.[1] ? Number(m[1]) : 1;
	return k > 0 && k <= 1 ? k : 1;
}

/**
 * キーボード配列。OS の配列がはっきり US の形なら米国(0x0409)、それ以外は日本語(0x0411)。
 * 調べられないブラウザ(Chromium 以外)は日本語にする
 */
async function detectKeyboardLayout(): Promise<number> {
	const kb = (
		navigator as Navigator & {
			keyboard?: { getLayoutMap(): Promise<Map<string, string>> };
		}
	).keyboard;
	try {
		const map = await kb?.getLayoutMap();
		// JIS の目印: ¥・ろのキーがある、または [ の位置が @・' の位置が : になる。どれも無く、US の形(' と [)なら米国
		if (map) {
			const jis =
				map.has("IntlYen") ||
				map.has("IntlRo") ||
				map.get("BracketLeft") === "@" ||
				map.get("Quote") === ":";
			const us = map.get("BracketLeft") === "[" && map.get("Quote") === "'";
			if (!jis && us) return 0x0409;
		}
	} catch {}
	return 0x0411;
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
