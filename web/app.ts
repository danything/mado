// 画面。web/rdp の RDP クライアントで、mado の /ws(RDCleanPath)を通して PC につなぐ。
// Windows のユーザー名とパスワードはブラウザの中の CredSSP で使う。mado のサーバーには届かない。

import { AutoScale } from "./rdp/autoscale";
import { attachChannels, type Channels } from "./rdp/channels";
import { RdpClient } from "./rdp/client";
import { connect } from "./rdp/connect";
import { bindInput, Display, watchSize } from "./rdp/display";
import { UPDATE } from "./rdp/fastpath";
import { avcSupport, GfxClient } from "./rdp/gfx";
import { CanvasGfxOps, WebCodecsAvc } from "./rdp/gfx-canvas";
import * as input from "./rdp/input";
import { createPool } from "./rdp/rfxpool";

type SessionInfo = {
	name: string;
	version: string;
	targets: string[];
	ws: string;
	/** WebTransport の URL。サーバーが UDP で待っているときだけある */
	wt?: string;
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

/** 前回のつなぐ先とユーザー名。パスワードは覚えない */
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
		username?: string;
	};
	if (last.target && session.targets.includes(last.target))
		select.value = last.target;
	if (last.username) field("username").value = last.username;
} catch {}
home.hidden = false;

const display = new Display(screen);

/** つながるまで待つ時間。CredSSP、ライセンス、同期までを含む */
const CONNECT_TIMEOUT_MS = 30_000;

let current: { client: RdpClient; channels: Channels } | undefined;
/** つないでいる最中の取り消し用 */
let connecting: AbortController | undefined;
/** ブラウザのクリップボードとリモートの間で最後にやりとりした文字列。同じ文字列が行き来しないように覚えておく */
let lastClipboard: string | undefined;

/**
 * 画面の送り方。上ほど遅延が小さく、送る量も少ない。
 * - avc: GFX + H.264。ブラウザが H.264 を復号できるときに使う
 * - gfx: H.264 なしの GFX。ClearCodec や Progressive を使う
 * - bitmap: 旧来の描画。RemoteFX とビットマップ
 * GFX を使えないサーバーは GFX のチャネルを開かないので、そのまま旧来の描画になる。
 * つないだあとで壊れたら、一つ下の方式で裏からつなぎ直す
 */
type Mode = "avc" | "gfx" | "bitmap";
const MODE_NAMES: Record<Mode, string> = {
	avc: "GFX + H.264",
	gfx: "GFX",
	bitmap: "ビットマップ / RemoteFX",
};

/** つないだ相手と認証の情報。つなぎ直しに使う。パスワードは画面を閉じるまでメモリに置くだけで、保存しない */
type Login = {
	target: string;
	username: string;
	password: string;
};

/** 1 回つないで切れるまで。fallback があれば、その方式でつなぎ直す */
type SessionEnd = { message: string; fallback?: Mode };

/** 方式を切り替えた記録(診断用) */
const switches: string[] = [];
/** 画素数を自動で変えた記録。診断に新しいものから 5 つ出す */
const scaleSwitches: string[] = [];
/** いまの画素数の割合(診断用) */
let currentScale: () => number = () => 1;
/** 混み具合を見る間隔 */
const AUTO_SAMPLE_MS = 2000;

form.addEventListener("submit", async (e) => {
	e.preventDefault();
	const login: Login = {
		target: select.value,
		username: field("username").value,
		password: field("password").value,
	};
	try {
		const { target, username } = login;
		localStorage.setItem(REMEMBER, JSON.stringify({ target, username }));
	} catch {}
	const submit = form.querySelector("button[type=submit]") as HTMLButtonElement;
	// つないでいる途中に Enter でもう一度送られても、二つ目はつながない
	if (submit.getAttribute("aria-busy") === "true") return;
	submit.setAttribute("aria-busy", "true");
	status.textContent = "つないでいます…";
	switches.length = 0;
	scaleSwitches.length = 0;
	// H.264 は、ブラウザが復号できるときだけ頼む
	const avc = await avcSupport();
	let mode: Mode = avc ? "avc" : "gfx";
	for (;;) {
		const end = await runSession(login, mode, avc?.hardware === true);
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

async function runSession(
	login: Login,
	mode: Mode,
	hardware: boolean,
): Promise<SessionEnd> {
	const stops: (() => void)[] = [];
	try {
		// トークンは使い捨てで寿命が短いので、つなぐ直前に取る。つなぐ先はトークンに入っていて、サーバーが決める
		const { token } = await getJson<{ token: string }>(
			`/api/token?target=${encodeURIComponent(login.target)}`,
		);
		// 画面の場所を表示してから大きさを測る。clientHeight を読んだ時点でレイアウトが決まる
		home.hidden = true;
		toolbar.hidden = false;
		$<HTMLElement>("#current").textContent = login.target;
		screen.classList.remove("idle");
		const { width, height } = desktopSize();
		const abort = new AbortController();
		connecting = abort;
		const timer = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
		const rdp = await connect({
			url: session.ws,
			wt: session.wt,
			token,
			newToken: async () =>
				(
					await getJson<{ token: string }>(
						`/api/token?target=${encodeURIComponent(login.target)}`,
					)
				).token,
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
						mode === "avc" ? new WebCodecsAvc(hardware) : undefined,
						pool,
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
		stops.push(
			watchDiag(() => diagText(client, gfxClient, pool.async, rdp.transport)),
		);
		stops.push(bindInput(display.canvas, client, display));
		stops.push(watchClipboard(display.canvas, channels));
		// 窓の大きさが変わったら RDP の解像度も変える。GFX のときは、混んでいれば解像度を下げる
		const auto = new AutoScale(1);
		const resize = (w: number, h: number) => {
			const width = even(Math.round(w * auto.scale));
			const height = Math.round(h * auto.scale);
			// いまと同じ大きさなら送らない。Windows は同じ大きさでも画面を作り直し、GPU があると数十秒絵が来なくなる
			if (width === display.width && height === display.height) return;
			channels.displayControl.resize(width, height);
		};
		stops.push(watchSize(screen, resize));
		let started = false;
		const sampler = setInterval(() => {
			if (!gfxClient?.active || gfxClient.stats.frames === 0) return;
			const now = performance.now();
			// 最初の絵が来てしばらくは、全面の送り直しで混んで見えるので待つ
			if (!started) {
				started = true;
				auto.pause(now + 10_000);
			}
			const l = gfxClient.latency;
			// 最近のフレームが無いのは画面が静かなときなので、混んでいないとみなす
			const queued = now - l.at < AUTO_SAMPLE_MS * 1.5 ? l.queued : undefined;
			const next = auto.sample({ queued, backlog: gfxClient.backlog }, now);
			if (next === undefined) return;
			scaleSwitches.push(
				`${new Date().toLocaleTimeString()} 解像度 ${Math.round(next * 100)}% 遅延+${Math.round(queued ?? 0)}ms 未描画 ${gfxClient.backlog}`,
			);
			scaleSwitches.splice(0, scaleSwitches.length - 5);
			resize(screen.clientWidth, screen.clientHeight);
		}, AUTO_SAMPLE_MS);
		stops.push(() => clearInterval(sampler));
		currentScale = () => auto.scale;
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
	transport: string | undefined,
): string {
	// GFX を頼んでも、サーバーがチャネルを開かなければ旧来の描画のまま
	const mode: Mode = gfx?.active ? (gfx.avcEnabled ? "avc" : "gfx") : "bitmap";
	const lines = [
		`mado ${session.version}  中継: ${transport ?? "-"}  方式: ${MODE_NAMES[mode]}  復号: ${workers ? "Worker" : "メインスレッド"}`,
		`画面 ${display.canvas.width}x${display.canvas.height}  表示 ${display.canvas.clientWidth}x${display.canvas.clientHeight}`,
		`更新: ${
			Object.entries(client.stats)
				.map(([k, v]) => `${UPDATE_NAMES[Number(k)] ?? k}=${v}`)
				.join(" ") || "-"
		}`,
		// 間引き・捨てたは、RemoteFX のタイルと旧ビットマップの両方を数える
		`旧ビットマップ: 間引き=${client.decodeStats.coalesced} 捨てた=${client.decodeStats.skipped}`,
		networkText(client.network),
	];
	if (switches.length) lines.push("切り替え:", ...switches);
	if (gfx?.active)
		lines.push(
			`負荷: 遅延+${Math.round(gfx.latency.queued ?? 0)}ms  未描画 ${gfx.backlog}  解像度 ${Math.round(currentScale() * 100)}%`,
			...scaleSwitches,
		);
	if (gfx?.active)
		lines.push(
			`GFX: 版=${gfx.confirmedVersion ?? "-"} ${Object.entries(gfx.stats)
				.map(([k, v]) => `${k}=${Math.round(v)}`)
				.join(" ")} clear未対応=${gfx.clearUnsupported}`,
		);
	if (recentErrors.length) lines.push("エラー:", ...recentErrors);
	return lines.join("\n");
}

/** 回線の自動検出でサーバーが測った値と、こちらが応答した回数 */
function networkText(n: RdpClient["network"]): string {
	const ms = (v?: number) => (v === undefined ? "-" : `${v}ms`);
	const info = n.info
		? `rtt=${ms(n.info.averageRtt)}(最小 ${ms(n.info.baseRtt)}) 帯域=${n.info.bandwidth === undefined ? "-" : `${n.info.bandwidth}kbps`}`
		: "-";
	return `回線: ${info}  応答: rtt=${n.answered.rtt} 帯域=${n.answered.bandwidth}`;
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

/** リモートでコピーされた文字列をブラウザのクリップボードに入れる。権限が無ければ何もしない */
function writeClipboard(text: string): void {
	lastClipboard = text;
	void navigator.clipboard?.writeText(text).catch(() => {});
}

/** 画面にフォーカスが来たら、ブラウザのクリップボードの文字列をリモートへ知らせる。前と同じなら知らせない */
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

/** つなぐときの RDP の解像度。窓の大きさそのまま。混んでいたら、つないだあとで下げる */
function desktopSize(): { width: number; height: number } {
	return {
		width: screen.clientWidth || innerWidth,
		height: screen.clientHeight || innerHeight,
	};
}

/**
 * キーボード配列。OS の配列がはっきり US の形なら米国(0x0409)、それ以外は日本語(0x0411)。
 * 配列を調べられないブラウザ(Chromium 以外)では日本語にする
 */
async function detectKeyboardLayout(): Promise<number> {
	const kb = (
		navigator as Navigator & {
			keyboard?: { getLayoutMap(): Promise<Map<string, string>> };
		}
	).keyboard;
	try {
		const map = await kb?.getLayoutMap();
		// ¥ や ろ のキーがある、[ の位置が @、' の位置が : になっている、のどれかなら JIS。
		// どれも無く、' と [ が US の位置にあれば米国
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
