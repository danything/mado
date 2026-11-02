// Intel AMT の画面。電源の状態と操作(WS-Man)、SOL の端末(xterm.js)。
// AMT のユーザー名とパスワードはこの画面を閉じるまでメモリに置くだけで、保存も mado への送信もしない。

import { WsStream } from "../rdp/stream";
import { LoginRequired, WsmanClient } from "./client";
import { IderSession } from "./ider";
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
  private readonly iderFile = $<HTMLInputElement>("#ider-file");
  private readonly iderBoot = $<HTMLButtonElement>("#ider-boot");
  private readonly iderStop = $<HTMLButtonElement>("#ider-stop");
  private readonly iderStatus = $<HTMLElement>("#ider-status");
  private ider?: IderSession;
  private readonly redirectionText = $<HTMLElement>("#amt-redirection");
  private readonly enableRedirectionButton = $<HTMLButtonElement>(
    "#amt-enable-redirection",
  );
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
    this.iderFile.addEventListener("change", this.onFile);
    this.onFile();
    void this.refreshRedirection();
    this.schedule(POLL_MS);
  }

  /** リダイレクト(SOL・IDE-R)の受け口の状態を読んで出す。読めなくても電源の画面は使える */
  private async refreshRedirection(): Promise<void> {
    try {
      const r = await this.wsman.redirection();
      const on = (v: boolean) => (v ? "有効" : "無効");
      this.redirectionText.textContent = `受け口 ${on(r.listener)}・SOL ${on(r.sol)}・IDE-R ${on(r.ider)}`;
      this.enableRedirectionButton.hidden = r.listener && r.sol && r.ider;
    } catch (e) {
      this.redirectionText.textContent = `読めませんでした(${e instanceof Error ? e.message : String(e)})`;
      this.enableRedirectionButton.hidden = false;
    }
  }

  /** SOL・IDE-R を有効にする。AMT の設定を変えるので先に確かめる */
  private async enableRedirection(): Promise<void> {
    if (
      !(await this.ask(
        `${this.login.target}: SOL・IDE-R を有効にする`,
        "AMT の設定を変え、SOL と IDE-R を有効にして、リダイレクトの受け口(16994 / 16995)を開きます。LAN の中から、AMT のユーザー名とパスワードで SOL と IDE-R を使えるようになります。",
        "SOL・IDE-R を有効にする",
      ))
    )
      return;
    const b = this.enableRedirectionButton;
    b.setAttribute("aria-busy", "true");
    try {
      await this.wsman.enableRedirection();
      this.note("SOL・IDE-R を有効にしました", "ok");
    } catch (e) {
      this.handle(e);
    } finally {
      b.removeAttribute("aria-busy");
      await this.refreshRedirection();
    }
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
    else if (b === this.iderBoot) void this.bootFromIder();
    else if (b === this.enableRedirectionButton) void this.enableRedirection();
    else if (b === this.iderStop) this.ider?.close();
  };

  private onFile = () => {
    this.iderBoot.disabled = !this.iderFile.files?.length || !!this.ider;
  };

  // ---- IDE-R ----

  /**
   * 選んだ ISO を IDE-R の CD-ROM として見せ、次の起動をそこからにして電源を入れる(入っていればリセット)。
   * ISO はブラウザが読んで AMT に送る。mado は AMT へのバイト列を中継するだけ。転送の間はタブを閉じられない
   */
  private async bootFromIder(): Promise<void> {
    const file = this.iderFile.files?.[0];
    if (!file || this.ider) return;
    const on = isOn(this.info?.state);
    const mb = (file.size / 1024 / 1024).toFixed(
      file.size < 10 * 1024 * 1024 ? 1 : 0,
    );
    if (
      !(await this.ask(
        `${this.login.target}: IDE-R の CD から起動`,
        `${file.name}(${mb} MB)を CD-ROM として見せ、そこから起動します。` +
          (on
            ? "いまは電源が入っているので、OS を止めずにリセットします。保存していないデータは失われます。"
            : "電源を入れます。") +
          "起動の間はこのタブを開いたままにしてください。閉じると CD が抜け、起動が止まります。",
        "IDE-R の CD から起動",
        on,
      ))
    )
      return;
    this.iderBoot.disabled = true;
    this.iderBoot.setAttribute("aria-busy", "true");
    this.iderNote("IDE-R を準備しています…");
    let ider: IderSession | undefined;
    try {
      const token = await this.deps.newToken(this.login.target);
      const io = await WsStream.open(this.deps.ws.replace(/\/ws$/, "/ws/amt"));
      io.write(new TextEncoder().encode(`${token}\n`));
      try {
        ider = await IderSession.start(io, {
          username: this.login.username,
          password: this.login.password,
          cd: file,
        });
      } catch (e) {
        io.close();
        throw e;
      }
      this.ider = ider;
      this.iderStop.hidden = false;
      window.addEventListener("beforeunload", keepOpen);
      const started = ider;
      started.onProgress = (s) =>
        this.iderNote(
          `転送 ${(s.bytesRead / 1024 / 1024).toFixed(1)} MB・最後に読まれたセクタ ${s.lastLba}。タブを閉じると起動が止まります`,
        );
      void started.done.then((reason) => {
        if (this.ider !== started) return;
        this.ider = undefined;
        window.removeEventListener("beforeunload", keepOpen);
        this.iderStop.hidden = true;
        this.onFile();
        this.iderNote(`IDE-R を終了しました: ${reason}`);
      });
      const r = await this.wsman.bootFromIder();
      this.iderNote(
        r.result === 0 || r.result === 4096
          ? `${r.state === 10 ? "リセット" : "電源オン"}を受け付けました。SOL に接続すると起動の様子が見えます。タブは閉じないでください`
          : `電源の操作に失敗しました: ${returnValueText(r.result)}`,
        r.result === 0 || r.result === 4096 ? "ok" : "error",
      );
      this.schedule(3000);
    } catch (e) {
      ider?.close();
      if (e instanceof LoginRequired) this.handle(e);
      else
        this.iderNote(
          `IDE-R で起動できませんでした: ${explainRedirectError(e)}`,
          "error",
        );
    } finally {
      this.iderBoot.removeAttribute("aria-busy");
      this.onFile();
    }
  }

  private iderNote(text: string, kind?: "error" | "ok"): void {
    this.iderStatus.textContent = text;
    if (kind) this.iderStatus.dataset.kind = kind;
    else delete this.iderStatus.dataset.kind;
  }

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
        `\x1b[31m✕\x1b[0m SOL に接続できませんでした: ${explainRedirectError(e)}`,
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
    this.ider?.close();
    this.ider = undefined;
    window.removeEventListener("beforeunload", keepOpen);
    this.iderStop.hidden = true;
    this.iderFile.removeEventListener("change", this.onFile);
    this.iderNote("");
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

/** IDE-R の転送の間は、タブを閉じる前にブラウザに確かめさせる */
function keepOpen(e: BeforeUnloadEvent): void {
  e.preventDefault();
}

/**
 * リダイレクトにつなげなかった理由を、次にすることが分かる文にする。
 * mado は AMT の 16994 / 16995 に届かないと「cannot reach AMT」で閉じる(ふつうはリダイレクトが無効なとき)
 */
export function explainRedirectError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes("cannot reach AMT"))
    return "AMT のリダイレクトが無効です。「SOL・IDE-R を有効にする」を押すか、MEBx で有効にしてください";
  if (m.includes("AMT TLS failed"))
    return "AMT と TLS でつなげませんでした。AMT の TLS の設定と cert_sha256 を確かめてください";
  return m;
}
