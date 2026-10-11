// 画面。自前の RDP クライアント(web/rdp)で RDP を話し、mado の /ws(RDCleanPath)を通して PC につなぐ。
// Windows のユーザー名とパスワードはブラウザの中の CredSSP が使うだけで、mado のサーバーには届かない。

import { attachChannels, type Channels } from "./rdp/channels";
import { RdpClient } from "./rdp/client";
import { connect } from "./rdp/connect";
import { bindInput, Display, watchSize } from "./rdp/display";
import * as input from "./rdp/input";

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

form.addEventListener("submit", async (e) => {
	e.preventDefault();
	const target = select.value;
	const size = field("size").value;
	const username = field("username").value;
	try {
		localStorage.setItem(REMEMBER, JSON.stringify({ target, size, username }));
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
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), CONNECT_TIMEOUT_MS);
		const rdp = await connect({
			url: session.ws,
			token,
			destination: target,
			username,
			password: field("password").value,
			width: even(width),
			height,
			signal: abort.signal,
		}).finally(() => clearTimeout(timer));
		const client = new RdpClient(rdp, display);
		const channels = attachChannels(client, writeClipboard);
		current = { client, channels };
		stops.push(bindInput(display.canvas, client, display));
		stops.push(watchClipboard(display.canvas, channels));
		// 「窓に合わせる」のときだけ、窓の大きさが変わったら RDP の解像度も変える
		if (size === "auto")
			stops.push(
				watchSize(screen, (w, h) => channels.displayControl.resize(even(w), h)),
			);
		display.canvas.focus();
		status.textContent = "";
		const reason = await client.run();
		status.textContent = `切れた: ${reason}`;
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
	else if (action === "disconnect") current?.client.close();
});

// ---- クリップボード ----

/** リモートでコピーされた文字列を、ブラウザのクリップボードへ(権限が無ければ黙って諦める) */
function writeClipboard(text: string): void {
	void navigator.clipboard?.writeText(text).catch(() => {});
}

/** 画面にフォーカスが来たとき、ブラウザのクリップボードの文字列をリモートへ知らせる(変わっていたときだけ) */
function watchClipboard(canvas: HTMLElement, channels: Channels): () => void {
	let last: string | undefined;
	const sync = async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (text !== last) {
				last = text;
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
 * RDP の解像度。「窓に合わせる」なら画面の場所の大きさ、ほかは選んだ大きさ(小さいほど描く量が減って軽い)。
 * 固定の大きさでも、表示は窓に合わせて拡大縮小される(scale="fit")
 */
function desktopSize(size: string): { width: number; height: number } {
	const m = size.match(/^(\d+)x(\d+)$/);
	if (m) return { width: Number(m[1]), height: Number(m[2]) };
	return {
		width: screen.clientWidth || innerWidth,
		height: screen.clientHeight || innerHeight,
	};
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
