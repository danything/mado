// 画面。IronRDP の Web クライアント(WASM)で RDP を話し、mado の /ws(RDCleanPath)を通して PC につなぐ。
// Windows のユーザー名とパスワードはブラウザの中の CredSSP が使うだけで、mado のサーバーには届かない。

import "@devolutions/iron-remote-desktop";
import type { UserInteraction } from "@devolutions/iron-remote-desktop";
import {
	Backend,
	displayControl,
	init,
} from "@devolutions/iron-remote-desktop-rdp";

type SessionInfo = { name: string; token: string; ws: string };

const $ = <T extends HTMLElement>(sel: string) =>
	document.querySelector(sel) as T;
const form = $<HTMLFormElement>("#login");
const status = $<HTMLParagraphElement>("#status");
const toolbar = $<HTMLElement>("#toolbar");
const screen = $<HTMLElement>("#screen");

async function session(): Promise<SessionInfo> {
	const res = await fetch("/api/session", { cache: "no-store" });
	if (res.status === 401) {
		location.href = `/login?to=${encodeURIComponent(location.pathname)}`;
		throw new Error("login required");
	}
	if (!res.ok) throw new Error(`/api/session (${res.status})`);
	return res.json();
}

const first = await session();
$<HTMLParagraphElement>("#who").textContent = `${first.name} でログイン中`;
form.hidden = false;

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
	const data = new FormData(form);
	status.textContent = "つないでいます…";
	try {
		// トークンは使い捨てで寿命が短いので、つなぐ直前に取り直す
		const s = await session();
		// 画面の場所を出してから大きさを測る(clientHeight を読むとレイアウトがその場で決まる)
		form.hidden = true;
		toolbar.hidden = false;
		screen.classList.remove("idle");
		const config = ui
			.configBuilder()
			.withUsername(String(data.get("username")))
			.withPassword(String(data.get("password")))
			// つなぐ先はサーバーの設定で決まっている(ここの値は見られない)
			.withDestination("mado")
			.withProxyAddress(s.ws)
			.withAuthToken(s.token)
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
	toolbar.hidden = true;
	screen.classList.add("idle");
	form.hidden = false;
	(form.elements.namedItem("password") as HTMLInputElement).value = "";
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
