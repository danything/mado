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
  /** AMT が頼める状態として挙げたときだけ出す(OS 側の対応が要るもの) */
  optional?: boolean;
  danger?: boolean;
};

export const POWER_ACTIONS: PowerAction[] = [
  { value: 2, label: "電源を入れる", confirm: "電源を入れる。" },
  {
    value: 12,
    label: "OS に止めてもらう",
    confirm:
      "OS に正しく止めるよう頼む。OS 側が AMT からの頼みに対応していないと何も起きない。",
    whenOn: true,
    optional: true,
  },
  {
    value: 14,
    label: "OS に再起動してもらう",
    confirm:
      "OS に正しく再起動するよう頼む。OS 側が AMT からの頼みに対応していないと何も起きない。",
    whenOn: true,
    optional: true,
  },
  {
    value: 10,
    label: "リセット",
    confirm:
      "リセットボタンを押したのと同じ。OS は止まらずに再起動し、保存していないデータは失われる。",
    whenOn: true,
    danger: true,
  },
  {
    value: 5,
    label: "電源を入れ直す",
    confirm:
      "電源を切ってから入れ直す。OS は止まらず、保存していないデータは失われる。",
    whenOn: true,
    danger: true,
  },
  {
    value: 8,
    label: "電源を切る(強制)",
    confirm:
      "電源ボタンの長押しと同じ。OS は止まらずに電源が切れ、保存していないデータは失われる。",
    whenOn: true,
    danger: true,
  },
];

/** 出す操作と、押せるかどうか。AMT が頼める状態を挙げていればそれに従う */
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
        b.className = action.danger
          ? "secondary outline danger"
          : "secondary outline";
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
      this.note(`${action.label}: ${returnValueText(rv)}`);
    } catch (e) {
      this.handle(e);
    }
    // 状態が変わるまで少しかかる
    this.schedule(3000);
  }

  /** 確かめる窓。OK なら true。危ない操作は最初にやめるほうを選んでおく */
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

  private note(text: string): void {
    this.status.textContent = text;
  }

  private handle(e: unknown): void {
    if (e instanceof LoginRequired) {
      location.href = `/login?to=${encodeURIComponent(location.pathname)}`;
      return;
    }
    this.note(e instanceof Error ? e.message : String(e));
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
      term.writeln("\x1b[90mSOL につないでいます…\x1b[0m");
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
      term.writeln("\x1b[90mつないだ。キー入力はそのまま送る\x1b[0m");
      this.solButton.textContent = "SOL を切る";
      term.focus();
      void sol.done.then((reason) => {
        if (this.sol !== sol) return;
        this.sol = undefined;
        this.solButton.textContent = "SOL をつなぐ";
        this.xterm?.writeln(`\r\n\x1b[90mSOL が切れた: ${reason}\x1b[0m`);
      });
    } catch (e) {
      this.xterm?.writeln(
        `\x1b[31mSOL につなげなかった: ${e instanceof Error ? e.message : String(e)}\x1b[0m`,
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
    this.solButton.textContent = "SOL をつなぐ";
    this.note("");
    this.root.removeEventListener("click", this.onClick);
    this.root.hidden = true;
    this.closed?.();
  }
}
