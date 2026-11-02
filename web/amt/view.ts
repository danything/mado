// Intel AMT の画面。電源の状態と操作(WS-Man)、SOL の端末(xterm.js)。
// AMT のユーザー名とパスワードはこの画面を閉じるまでメモリに置くだけで、保存も mado への送信もしない。

import { WsStream } from "../rdp/stream";
import { LoginRequired, WsmanClient } from "./client";
import { SolSession } from "./redirect";
import { isOn, type PowerInfo, powerStateName, returnValueText } from "./wsman";

type Xterm = import("@xterm/xterm").Terminal;

export type AmtLogin = { target: string; username: string; password: string };

export type AmtDeps = {
  /** /api/token を取る(使い捨ての中継のトークン) */
  newToken: (target: string) => Promise<string>;
  /** /ws の URL。SOL はその隣の /ws/amt */
  ws: string;
};

/** 電源の操作。value は CIM の PowerState */
type PowerAction = {
  value: number;
  label: string;
  confirm: string;
  /** 電源が入っているときだけ意味がある */
  whenOn?: boolean;
  /** AMT がリクエストできる状態として挙げたときだけ出す(OS 側の対応が要るもの) */
  optional?: boolean;
  danger?: boolean;
};

export const POWER_ACTIONS: PowerAction[] = [
  { value: 2, label: "電源オン", confirm: "電源を入れます。" },
  {
    value: 12,
    label: "OS のシャットダウン",
    confirm:
      "OS にシャットダウンをリクエストします。OS 側が対応していないと何も起きません。",
    whenOn: true,
    optional: true,
  },
  {
    value: 14,
    label: "OS の再起動",
    confirm:
      "OS に再起動をリクエストします。OS 側が対応していないと何も起きません。",
    whenOn: true,
    optional: true,
  },
  {
    value: 10,
    label: "リセット",
    confirm:
      "リセットボタンを押したのと同じです。OS を止めずに再起動するので、保存していないデータは失われます。",
    whenOn: true,
    danger: true,
  },
  {
    value: 5,
    label: "電源の入れ直し",
    confirm:
      "電源を切ってから入れ直します。OS を止めないので、保存していないデータは失われます。",
    whenOn: true,
    danger: true,
  },
  {
    value: 8,
    label: "強制電源オフ",
    confirm:
      "電源ボタンの長押しと同じです。OS を止めずに電源を切るので、保存していないデータは失われます。",
    whenOn: true,
    danger: true,
  },
];

/** 出す操作と、押せるかどうか。AMT がリクエストできる状態を挙げていればそれに従う */
export function powerButtons(
  info: PowerInfo | undefined,
): { action: PowerAction; enabled: boolean }[] {
  const listed = info?.available ?? [];
  return POWER_ACTIONS.filter(
    (a) => !a.optional || listed.includes(a.value),
  ).map((action) => ({
    action,
    enabled:
      listed.length > 0
        ? listed.includes(action.value)
        : info?.state === undefined
          ? true
          : action.whenOn
            ? isOn(info.state)
            : !isOn(info.state),
  }));
}

const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

/** 状態を読み直す間隔。操作の後は早めに読む */
const POLL_MS = 15_000;

export class AmtView {
  private readonly root = $<HTMLElement>("#amt");
  private readonly state = $<HTMLElement>("#amt-state");
  private readonly status = $<HTMLElement>("#amt-status");
  private readonly actions = $<HTMLElement>("#amt-actions");
  private readonly term = $<HTMLElement>("#sol");
  private readonly solButton = $<HTMLButtonElement>("#amt-sol");
  private readonly confirmDialog = $<HTMLDialogElement>("#confirm");
  private wsman: WsmanClient;
  private info?: PowerInfo;
  private poll?: ReturnType<typeof setTimeout>;
  private sol?: SolSession;
  private solConnecting = false;
  private xterm?: Xterm;
  private resize?: ResizeObserver;
  private closed?: () => void;

  constructor(
    private readonly login: AmtLogin,
    private readonly deps: AmtDeps,
  ) {
    this.wsman = new WsmanClient(login.target, login.username, login.password);
  }

  /** 認証を確かめる。最初の状態を読めたら画面を出す。だめなら例外 */
  async open(): Promise<void> {
    this.info = await this.wsman.power();
    $<HTMLElement>("#amt-name").textContent = this.login.target;
    this.renderPower();
    this.root.hidden = false;
    this.root.addEventListener("click", this.onClick);
    this.schedule(POLL_MS);
  }

  /** 閉じるまで待つ */
  wait(): Promise<void> {
    return new Promise((r) => {
      this.closed = r;
    });
  }

  private onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.dataset.power) void this.changePower(Number(b.dataset.power));
    else if (b.dataset.amt === "refresh") void this.refresh();
    else if (b.dataset.amt === "sol") void this.toggleSol();
    else if (b.dataset.amt === "close") this.close();
  };

  private schedule(ms: number): void {
    clearTimeout(this.poll);
    this.poll = setTimeout(() => void this.refresh(), ms);
  }

  private async refresh(): Promise<void> {
    try {
      this.info = await this.wsman.power();
      this.renderPower();
      this.note("");
    } catch (e) {
      this.handle(e);
    }
    if (!this.root.hidden) this.schedule(POLL_MS);
  }

  private renderPower(): void {
    const s = this.info?.state;
    this.state.textContent = powerStateName(s);
    this.state.dataset.on = String(isOn(s));
    this.actions.replaceChildren(
      ...powerButtons(this.info).map(({ action, enabled }) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.power = String(action.value);
        b.textContent = action.label;
        // 戻せない操作の 1 回目は控えのボタンで、乗せたときだけ赤い字。確定は確認の窓で
        b.className = action.danger ? "secondary danger" : "secondary";
        b.disabled = !enabled;
        return b;
      }),
    );
  }

  private async changePower(value: number): Promise<void> {
    const action = POWER_ACTIONS.find((a) => a.value === value);
    if (!action) return;
    if (
      !(await this.ask(
        `${this.login.target}: ${action.label}`,
        action.confirm,
        action.label,
        action.danger,
      ))
    )
      return;
    this.note(`${action.label}…`);
    try {
      const rv = await this.wsman.changePower(value);
      this.note(
        `${action.label}: ${returnValueText(rv)}`,
        rv === 0 || rv === 4096 ? "ok" : "error",
      );
    } catch (e) {
      this.handle(e);
    }
    // 状態が変わるまで少しかかる
    this.schedule(3000);
  }

  /** 確かめる窓。OK なら true。危ない操作は最初に取消を選んでおく */
  private ask(
    title: string,
    lead: string,
    ok: string,
    danger = false,
  ): Promise<boolean> {
    const d = this.confirmDialog;
    $<HTMLElement>("#confirm-title").textContent = title;
    $<HTMLElement>("#confirm-lead").textContent = lead;
    const okButton = d.querySelector("button[value=ok]") as HTMLButtonElement;
    const cancel = d.querySelector("button[value=cancel]") as HTMLButtonElement;
    okButton.textContent = ok;
    // 戻せない操作の確定は赤い字(塗らない)。窓の見出しの頭に ⚠
    okButton.className = danger ? "danger" : "";
    d.classList.toggle("danger", danger);
    d.returnValue = "";
    return new Promise((resolve) => {
      d.addEventListener("close", () => resolve(d.returnValue === "ok"), {
        once: true,
      });
      d.showModal();
      (danger ? cancel : okButton).focus();
    });
  }

  /** 状態の文。kind があれば頭にアイコン(style.css の .note) */
  private note(text: string, kind?: "error" | "ok"): void {
    this.status.textContent = text;
    if (kind) this.status.dataset.kind = kind;
    else delete this.status.dataset.kind;
  }

  private handle(e: unknown): void {
    if (e instanceof LoginRequired) {
      location.href = `/login?to=${encodeURIComponent(location.pathname)}`;
      return;
    }
    this.note(e instanceof Error ? e.message : String(e), "error");
  }

  // ---- SOL ----

  private async toggleSol(): Promise<void> {
    if (this.sol) {
      this.sol.close();
      return;
    }
    if (this.solConnecting) return;
    this.solConnecting = true;
    this.solButton.setAttribute("aria-busy", "true");
    try {
      const term = await this.terminal();
      term.writeln("\x1b[90mSOL に接続しています…\x1b[0m");
      const token = await this.deps.newToken(this.login.target);
      const io = await WsStream.open(this.deps.ws.replace(/\/ws$/, "/ws/amt"));
      io.write(new TextEncoder().encode(`${token}\n`));
      let sol: SolSession;
      try {
        sol = await SolSession.start(io, {
          username: this.login.username,
          password: this.login.password,
        });
      } catch (e) {
        io.close();
        throw e;
      }
      this.sol = sol;
      sol.onData = (b) => term.write(b);
      term.writeln("\x1b[90m接続しました。キー入力はそのまま送ります\x1b[0m");
      this.solButton.textContent = "SOL を切断";
      term.focus();
      void sol.done.then((reason) => {
        if (this.sol !== sol) return;
        this.sol = undefined;
        this.solButton.textContent = "SOL に接続";
        this.xterm?.writeln(
          `\r\n\x1b[90mSOL が切断されました: ${reason}\x1b[0m`,
        );
      });
    } catch (e) {
      this.xterm?.writeln(
        `\x1b[31m✕\x1b[0m SOL に接続できませんでした: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.solConnecting = false;
      this.solButton.removeAttribute("aria-busy");
    }
  }

  /** 端末は SOL を初めて開くときに読み込む(RDP だけ使うときは xterm.js を読まない) */
  private async terminal(): Promise<Xterm> {
    if (this.xterm) return this.xterm;
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      theme: { background: "#000000" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    this.term.hidden = false;
    term.open(this.term);
    fit.fit();
    const enc = new TextEncoder();
    term.onData((s) => this.sol?.send(enc.encode(s)));
    term.onBinary((s) =>
      this.sol?.send(Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)),
    );
    this.resize = new ResizeObserver(() => fit.fit());
    this.resize.observe(this.term);
    this.xterm = term;
    return term;
  }

  close(): void {
    clearTimeout(this.poll);
    this.sol?.close();
    this.sol = undefined;
    this.resize?.disconnect();
    this.xterm?.dispose();
    this.xterm = undefined;
    this.term.hidden = true;
    this.term.replaceChildren();
    this.solButton.textContent = "SOL に接続";
    this.note("");
    this.root.removeEventListener("click", this.onClick);
    this.root.hidden = true;
    this.closed?.();
  }
}
