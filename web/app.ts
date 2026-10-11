// 画面。IronRDP の Web クライアント(WASM)で RDP を話し、mado の /ws(RDCleanPath)を通して PC につなぐ。
// Windows のユーザー名とパスワードはブラウザの中の CredSSP が使うだけで、mado のサーバーには届かない。

import "@devolutions/iron-remote-desktop";
import type { UserInteraction } from "@devolutions/iron-remote-desktop";
import {
	Backend,
	displayControl,
	init,
} from "@devolutions/iron-remote-desktop-rdp";

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

/** 前回選んだつなぐ先とユーザー名(パスワードは覚えない) */
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

await init("INFO");
const el = document.createElement("iron-remote-desktop") as HTMLElement & {
	module: unknown;
};
el.module = Backend;
el.setAttribute("scale", "fit");
el.setAttribute("flexcenter", "true");
el.setAttribute("verbose", "false");
const ready = new Promise<UserInteraction>((resolve) =>
	el.addEventListener(
		"ready",
		(e) => resolve((e as CustomEvent).detail.irgUserInteraction),
		{ once: true },
	),
);
screen.append(el);
const ui = await ready;
ui.setEnableClipboard(true);

form.addEventListener("submit", async (e) => {
	e.preventDefault();
	const target = select.value;
	const username = field("username").value;
	try {
		localStorage.setItem(REMEMBER, JSON.stringify({ target, username }));
	} catch {}
	const submit = form.querySelector("button[type=submit]") as HTMLButtonElement;
	// つないでいる途中に Enter でもう一度送られても、二つ目はつながない
	if (submit.getAttribute("aria-busy") === "true") return;
	submit.setAttribute("aria-busy", "true");
	status.textContent = "つないでいます…";
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
		const config = ui
			.configBuilder()
			.withUsername(username)
			.withPassword(field("password").value)
			// サーバーは見ない(つなぐ先はトークンで決まる)
			.withDestination(target)
			.withProxyAddress(session.ws)
			.withAuthToken(token)
			.withDesktopSize({
				width: screen.clientWidth || innerWidth,
				height: screen.clientHeight || innerHeight,
			})
			.withExtension(displayControl(true))
			.build();
		ui.setVisibility(true);
		const info = await ui.connect(config);
		status.textContent = "";
		const end = await info.run();
		status.textContent = `切れた: ${end.reason()}`;
	} catch (err) {
		status.textContent = `つなげなかった: ${describe(err)}`;
	}
	submit.removeAttribute("aria-busy");
	toolbar.hidden = true;
	screen.classList.add("idle");
	home.hidden = false;
	field("password").value = "";
});

toolbar.addEventListener("click", (e) => {
	const action = (e.target as HTMLElement).closest("button")?.dataset.action;
	if (action === "ctrl-alt-del") ui.ctrlAltDel();
	else if (action === "meta") ui.metaKey();
	else if (action === "fullscreen") void screen.requestFullscreen();
	else if (action === "disconnect") ui.shutdown();
});

/** IronRDP の例外は backtrace() を持つ */
function describe(err: unknown): string {
	if (
		err &&
		typeof err === "object" &&
		"backtrace" in err &&
		typeof err.backtrace === "function"
	) {
		return String(err.backtrace());
	}
	return err instanceof Error ? err.message : String(err);
}
