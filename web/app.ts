// 画面。自前の RDP クライアント(web/rdp)で RDP を話し、mado の /ws(RDCleanPath)を通して PC につなぐ。
// Windows のユーザー名とパスワードはブラウザの中の CredSSP が使うだけで、mado のサーバーには届かない。

import { attachChannels, type Channels } from "./rdp/channels";
import { RdpClient } from "./rdp/client";
import { connect } from "./rdp/connect";
import { bindInput, Display, watchSize } from "./rdp/display";
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
		gfx?: boolean;
	};
	if (last.target && session.targets.includes(last.target))
		select.value = last.target;
	const sizes = field("size") as HTMLSelectElement;
	if (last.size && [...sizes.options].some((o) => o.value === last.size))
		sizes.value = last.size;
	if (last.username) field("username").value = last.username;
	(field("gfx") as HTMLInputElement).checked = last.gfx === true;
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

form.addEventListener("submit", async (e) => {
	e.preventDefault();
	const target = select.value;
	const size = field("size").value;
	const username = field("username").value;
	const wantGfx = (field("gfx") as HTMLInputElement).checked;
	try {
		localStorage.setItem(
			REMEMBER,
			JSON.stringify({ target, size, username, gfx: wantGfx }),
		);
	} catch {}
	const submit = form.querySelector("button[type=submit]") as HTMLButtonElement;
	// つないでいる途中に Enter でもう一度送られても、二つ目はつながない
	if (submit.getAttribute("aria-busy") === "true") return;
	submit.setAttribute("aria-busy", "true");
	status.textContent = "つないでいます…";
	const stops: (() => void)[] = [];
	try {
		// トークンは使い捨てで寿命が短いので、つなぐ直前に取る。つなぐ先はトークンに入り、サーバーが決める
		const { token } = await getJson<{ token: string }>(
			`/api/token?target=${encodeURIComponent(target)}`,
		);
		// 画面の場所を出してから大きさを測る(clientHeight を読むとレイアウトがその場で決まる)
		home.hidden = true;
		toolbar.hidden = false;
		$<HTMLElement>("#current").textContent = target;
		screen.classList.remove("idle");
		const { width, height } = desktopSize(size);
		// H.264 は、ブラウザが復号できるときだけ頼む
		const gfx = wantGfx && (await avcSupported());
		const abort = new AbortController();
		connecting = abort;
		const timer = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
		const rdp = await connect({
			url: session.ws,
			token,
			destination: target,
			username,
			password: field("password").value,
			keyboardLayout: await detectKeyboardLayout(),
			width: even(width),
			height,
			signal: abort.signal,
			gfx,
		}).finally(() => {
			clearTimeout(timer);
			connecting = undefined;
		});
		const client = new RdpClient(rdp, display, { pool: createPool() });
		const gfxClient = gfx
			? new GfxClient(new CanvasGfxOps(display), new WebCodecsAvc())
			: undefined;
		/** H.264 の画面が回復できない形で壊れたときの理由(切断して、つなぎ直してもらう) */
		let fatal: string | undefined;
		if (gfxClient) {
			gfxClient.onError = (e) => console.warn("GFX:", e);
			gfxClient.onFatal = (e) => {
				console.error("GFX:", e);
				fatal = "H.264 の画面が壊れた。つなぎ直してください";
				client.close();
			};
		}
		const channels = attachChannels(client, writeClipboard, { gfx: gfxClient });
		current = { client, channels };
		if (gfxClient) stops.push(() => gfxClient.onClose());
		stops.push(bindInput(display.canvas, client, display));
		stops.push(watchClipboard(display.canvas, channels));
		// 窓の大きさが変わったら、RDP の解像度も(画素数の割合をかけて)変える
		const scale = autoScale(size);
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
		status.textContent = `切れた: ${fatal ?? reason}`;
	} catch (err) {
		status.textContent = `つなげなかった: ${describe(err)}`;
	}
	for (const stop of stops) stop();
	current = undefined;
	display.clear();
	submit.removeAttribute("aria-busy");
	toolbar.hidden = true;
	screen.classList.add("idle");
	home.hidden = false;
	field("password").value = "";
});

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
	else if (action === "fullscreen") void screen.requestFullscreen();
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
