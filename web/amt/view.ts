// Intel AMT の画面。SOL の端末(xterm.js)が主で、電源(WS-Man)・IDE-R・リダイレクトの設定は上の常に出ているバー。
// 開くとすぐ SOL につなぐ。バーは RDP と違って引っ込めない(SOL は画面を広く使う必要が薄く、状態をいつも見せたい)。
// AMT のユーザー名とパスワードはこの画面を閉じるまでメモリに置くだけで、保存も mado への送信もしない。

import { WsStream } from "../rdp/stream";
import { gray, openTerminal, type Tty, type Xterm } from "../term";
import { LoginRequired, WsmanClient } from "./client";
import { IderSession } from "./ider";
import { SolSession } from "./redirect";
import { SerialText } from "./serial-text";
import { isOn, type PowerInfo, powerStateName, returnValueText } from "./wsman";

export type AmtLogin = { target: string; username: string; password: string };

export type AmtDeps = {
  /** /api/token を取る(使い捨ての中継のトークン) */
  newToken: (target: string) => Promise<string>;
  /** /ws の URL。SOL と IDE-R はその隣の /ws/amt */
  ws: string;
};

/** 電源の操作。value は CIM の PowerState */
type PowerAction = {
  value: number;
  label: string;
  /** ボタンの title に出す説明 */
  description: string;
  /** 電源が入っているときだけ意味がある */
  whenOn?: boolean;
  /** AMT がリクエストできる状態として挙げたときだけ出す(OS 側の対応が要るもの) */
  optional?: boolean;
  danger?: boolean;
};

// 電源の入れ直し(5)は強制再起動とほぼ同じで紛らわしいので出さない
export const POWER_ACTIONS: PowerAction[] = [
  { value: 2, label: "電源オン", description: "電源を入れます" },
  {
    value: 12,
    label: "シャットダウン",
    description:
      "OS にシャットダウンを頼みます。OS が対応していないと何も起きません",
    whenOn: true,
    optional: true,
  },
  {
    value: 14,
    label: "再起動",
    description: "OS に再起動を頼みます。OS が対応していないと何も起きません",
    whenOn: true,
    optional: true,
  },
  {
    value: 10,
    label: "強制再起動",
    description:
      "リセットボタンと同じです。OS を止めずに再起動するので、保存していないデータは失われます",
    whenOn: true,
    danger: true,
  },
  {
    value: 8,
    label: "強制電源オフ",
    description:
      "電源ボタンの長押しと同じです。OS を止めずに電源を切るので、保存していないデータは失われます",
    whenOn: true,
    danger: true,
  },
];

/** いま使える操作。AMT がリクエストできる状態を挙げていればそれに従い、挙げていなければ今の電源の状態で決める */
export function powerButtons(info: PowerInfo | undefined): PowerAction[] {
  const listed = info?.available ?? [];
  return POWER_ACTIONS.filter((a) =>
    listed.length > 0
      ? listed.includes(a.value)
      : a.optional
        ? false
        : info?.state === undefined
          ? true
          : a.whenOn
            ? isOn(info.state)
            : !isOn(info.state),
  );
}

/** 電源のボタンの 1 回目のあと、2 回目を待つ時間 */
const ARM_MS = 3000;
/** 1 回目からこれより早い 2 回目は受けない(ダブルクリック) */
const MIN_SECOND_MS = 400;

const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

/** 状態を読み直す間隔。操作の後は早めに読む */
const POLL_MS = 15_000;

export class AmtView {
  private readonly root = $<HTMLElement>("#amt");
  private readonly state = $<HTMLElement>("#amt-state");
  private readonly status = $<HTMLElement>("#amt-status");
  private readonly actions = $<HTMLElement>("#amt-actions");
  /** 1 回目を押して 2 回目を待っている電源の操作 */
  private armed?: {
    action: PowerAction;
    timer: ReturnType<typeof setTimeout>;
    message: string;
    /** 1 回目を押した時刻。ダブルクリックを 2 回押しとみなさない */
    at: number;
    /** 1 回目の前の状態の文。待ちをやめたら戻す */
    before: { text: string; kind?: "error" | "ok" };
  };
  /** 電源の操作を AMT に頼んでいる間。その間は電源のボタンを受けない */
  private powerBusy = false;
  private readonly term = $<HTMLElement>("#sol");
  private readonly solButton = $<HTMLButtonElement>("#amt-sol");
  private readonly confirmDialog = $<HTMLDialogElement>("#confirm");
  private readonly iderFile = $<HTMLInputElement>("#ider-file");
  private readonly iderBoot = $<HTMLButtonElement>("#ider-boot");
  private readonly iderStop = $<HTMLButtonElement>("#ider-stop");
  private ider?: IderSession;
  private readonly enableRedirectionButton = $<HTMLButtonElement>(
    "#amt-enable-redirection",
  );
  private wsman: WsmanClient;
  private info?: PowerInfo;
  private poll?: ReturnType<typeof setTimeout>;
  private sol?: SolSession;
  private solConnecting = false;
  /** UTF-8 の途中で止まったバイトを出すタイマー(connectSol) */
  private solFlush?: ReturnType<typeof setTimeout>;
  private tty?: Tty;
  private closed?: () => void;

  constructor(
    private readonly login: AmtLogin,
    private readonly deps: AmtDeps,
  ) {
    this.wsman = new WsmanClient(login.target, login.username, login.password);
  }

  /** 認証を確かめる。最初の状態を読めたら画面を出し、SOL につなぐ。だめなら例外 */
  async open(): Promise<void> {
    this.info = await this.wsman.power();
    $<HTMLElement>("#amt-name").textContent = this.login.target;
    this.renderPower();
    this.root.hidden = false;
    this.root.addEventListener("click", this.onClick);
    this.actions.addEventListener("keydown", this.onPowerKey);
    this.iderFile.addEventListener("change", this.onFile);
    this.schedule(POLL_MS);
    let term: Xterm;
    try {
      term = await this.terminal();
    } catch (e) {
      // xterm.js を読めなければ、半端に開いたままにしない
      this.close();
      throw e;
    }
    if (await this.checkRedirection()) void this.connectSol();
    else
      term.writeln(
        gray(
          "SOL・IDE-R が無効です。上のバーの「SOL・IDE-R を有効にする」で有効にできます",
        ),
      );
  }

  /** リダイレクト(SOL・IDE-R)の受け口が使えるかを読む。無効なら有効にするボタンを出す。読めなければ試してみる */
  private async checkRedirection(): Promise<boolean> {
    try {
      const r = await this.wsman.redirection();
      const ok = r.listener && r.sol && r.ider;
      this.enableRedirectionButton.hidden = ok;
      return ok;
    } catch {
      return true;
    }
  }

  /** SOL・IDE-R を有効にする。AMT の設定を変えるので先に確かめる。できたら SOL につなぐ */
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
    }
    if ((await this.checkRedirection()) && !this.sol) void this.connectSol();
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
    if (b.dataset.power) {
      this.pressPower(Number(b.dataset.power));
      return;
    }
    // 別のボタンを押したら、電源の 2 回目の待ちは取り消す
    this.disarm(true);
    if (b.dataset.amt === "sol") void this.toggleSol();
    else if (b.dataset.amt === "close") this.close();
    else if (b === this.iderBoot) this.iderFile.click();
    else if (b === this.enableRedirectionButton) void this.enableRedirection();
    else if (b === this.iderStop) this.ider?.close();
  };

  private onFile = () => {
    const file = this.iderFile.files?.[0];
    // 同じ ISO をもう一度選んでも change が来るように、選んだら空にする
    this.iderFile.value = "";
    if (file) void this.bootFromIder(file);
  };

  // ---- IDE-R ----

  /**
   * 選んだ ISO を IDE-R の CD-ROM として見せ、次の起動をそこからにして電源を入れる(入っていればリセット)。
   * ISO はブラウザが読んで AMT に送る。mado は AMT へのバイト列を中継するだけ。転送の間はタブを閉じられない
   */
  private async bootFromIder(file: File): Promise<void> {
    if (this.ider) return;
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
    this.note("IDE-R を準備しています…");
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
        this.note(
          `IDE-R ${(s.bytesRead / 1024 / 1024).toFixed(1)} MB・セクタ ${s.lastLba}。タブを閉じると起動が止まります`,
        );
      void started.done.then((reason) => {
        if (this.ider !== started) return;
        this.ider = undefined;
        window.removeEventListener("beforeunload", keepOpen);
        this.iderStop.hidden = true;
        this.iderBoot.disabled = false;
        this.note(`IDE-R を終了しました: ${reason}`);
      });
      const r = await this.wsman.bootFromIder();
      const ok = r.result === 0 || r.result === 4096;
      this.note(
        ok
          ? `${r.state === 10 ? "リセット" : "電源オン"}を受け付けました。タブは閉じないでください`
          : `電源の操作に失敗しました: ${returnValueText(r.result)}`,
        ok ? "ok" : "error",
      );
      // 起動の様子は SOL に出る。つないでいなければつなぐ
      if (ok && !this.sol) void this.connectSol();
      this.schedule(3000);
    } catch (e) {
      ider?.close();
      if (e instanceof LoginRequired) this.handle(e);
      else
        this.note(
          `IDE-R で起動できませんでした: ${explainRedirectError(e)}`,
          "error",
        );
    } finally {
      this.iderBoot.removeAttribute("aria-busy");
      this.iderBoot.disabled = !!this.ider;
    }
  }

  private schedule(ms: number): void {
    clearTimeout(this.poll);
    this.poll = setTimeout(() => void this.refresh(), ms);
  }

  private async refresh(): Promise<void> {
    try {
      this.info = await this.wsman.power();
      this.renderPower();
    } catch (e) {
      this.handle(e);
    }
    if (!this.root.hidden) this.schedule(POLL_MS);
  }

  private renderPower(): void {
    const s = this.info?.state;
    this.state.textContent = powerStateName(s);
    this.state.dataset.on = String(isOn(s));
    // 15 秒ごとに読み直すので、出す操作が変わったときだけ作り直す(押しかけのボタンと焦点を消さない)
    const actions = powerButtons(this.info);
    const shown = [...this.powerButtonElements()]
      .map((b) => b.dataset.power)
      .join();
    if (shown === actions.map((a) => String(a.value)).join()) return;
    if (this.armed && !actions.includes(this.armed.action)) this.disarm(true);
    const focused = this.actions.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.power
      : undefined;
    this.actions.replaceChildren(
      ...actions.map((action) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.power = String(action.value);
        b.title = action.description;
        // 戻せない操作は控えのボタンで、乗せたときと 2 回目を待つ間は赤い字(塗らない)
        b.className = action.danger ? "secondary danger" : "secondary";
        this.paintPower(b, action);
        return b;
      }),
    );
    if (focused !== undefined) {
      const bs = [...this.powerButtonElements()];
      (bs.find((b) => b.dataset.power === focused) ?? bs[0])?.focus();
    }
  }

  private powerButtonElements(): NodeListOf<HTMLButtonElement> {
    return this.actions.querySelectorAll<HTMLButtonElement>(
      "button[data-power]",
    );
  }

  /** ボタンの文。2 回目を待っている間は「もう一度押すと…」 */
  private paintPower(b: HTMLButtonElement, action: PowerAction): void {
    const armed = this.armed?.action === action;
    b.textContent = armed ? `もう一度押すと${action.label}` : action.label;
    b.toggleAttribute("data-armed", armed);
  }

  /** 電源のボタンは 2 回押しで確定する。1 回目で文を変え、ARM_MS 以内にもう一度押したら実行する */
  private pressPower(value: number): void {
    const action = POWER_ACTIONS.find((a) => a.value === value);
    if (!action || this.powerBusy) return;
    if (this.armed?.action === action) {
      // 素早いダブルクリックは 1 回目だけとみなす
      if (performance.now() - this.armed.at < MIN_SECOND_MS) return;
      this.disarm(false);
      void this.changePower(action);
      return;
    }
    this.disarm(true);
    const message = `もう一度押すと${action.label}します`;
    const kind = this.status.dataset.kind;
    this.armed = {
      action,
      message,
      at: performance.now(),
      before: {
        text: this.status.textContent ?? "",
        kind: kind === "error" || kind === "ok" ? kind : undefined,
      },
      timer: setTimeout(() => this.disarm(true), ARM_MS),
    };
    for (const b of this.powerButtonElements())
      if (b.dataset.power === String(value)) this.paintPower(b, action);
    // #amt-status は aria-live なので、読み上げにも伝わる
    this.note(message);
  }

  /** 2 回目の待ちをやめ、ボタンの文を戻す。clearNote なら待ちの知らせを前の文に戻す */
  private disarm(clearNote: boolean): void {
    const a = this.armed;
    if (!a) return;
    clearTimeout(a.timer);
    this.armed = undefined;
    for (const b of this.powerButtonElements())
      if (b.dataset.power === String(a.action.value))
        this.paintPower(b, a.action);
    if (clearNote && this.status.textContent === a.message)
      this.note(a.before.text, a.before.kind);
  }

  /** Enter の押しっぱなしは keydown ごとに click になるので、繰り返しは捨てる(2 回押しをすり抜けさせない) */
  private onPowerKey = (e: KeyboardEvent) => {
    if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
  };

  private async changePower(action: PowerAction): Promise<void> {
    const value = action.value;
    this.note(`${action.label}…`);
    this.powerBusy = true;
    try {
      const rv = await this.wsman.changePower(value);
      this.note(
        `${action.label}: ${returnValueText(rv)}`,
        rv === 0 || rv === 4096 ? "ok" : "error",
      );
    } catch (e) {
      this.handle(e);
    } finally {
      this.powerBusy = false;
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
      d.addEventListener(
        "close",
        () => {
          resolve(d.returnValue === "ok");
          // 窓を閉じたら、キー入力を端末に戻す
          this.tty?.term.focus();
        },
        { once: true },
      );
      d.showModal();
      (danger ? cancel : okButton).focus();
    });
  }

  /** バーの状態の文。kind があれば頭にアイコン(style.css の .note) */
  private note(text: string, kind?: "error" | "ok" | "warn"): void {
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

  private toggleSol(): Promise<void> {
    if (this.sol) {
      this.sol.close();
      return Promise.resolve();
    }
    return this.connectSol();
  }

  private async connectSol(): Promise<void> {
    if (this.sol || this.solConnecting) return;
    this.solConnecting = true;
    this.solButton.setAttribute("aria-busy", "true");
    try {
      const term = await this.terminal();
      term.writeln(gray("SOL に接続しています…"));
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
      // BIOS の CP437 と Linux の UTF-8 の両方を読む(serial-text.ts)。UTF-8 の途中で止まったら少し待って出す
      const text = new SerialText();
      sol.onData = (b) => {
        clearTimeout(this.solFlush);
        term.write(text.decode(b));
        if (text.waiting)
          this.solFlush = setTimeout(() => term.write(text.flush()), 100);
      };
      term.writeln(
        gray(
          "接続しました。キー入力はそのまま送ります。OS が何も書かなければ何も出ません(起動の間は出ます)",
        ),
      );
      this.solButton.textContent = "SOL を切断";
      term.focus();
      void sol.done.then((reason) => {
        if (this.sol !== sol) return;
        this.sol = undefined;
        clearTimeout(this.solFlush);
        this.solButton.textContent = "SOL に接続";
        this.tty?.term.writeln(
          `\r\n${gray(`SOL が切断されました: ${reason}`)}`,
        );
      });
    } catch (e) {
      this.solButton.textContent = "SOL に接続";
      this.tty?.term.writeln(
        `\x1b[31m✕\x1b[0m SOL に接続できませんでした: ${explainRedirectError(e)}`,
      );
    } finally {
      this.solConnecting = false;
      this.solButton.removeAttribute("aria-busy");
    }
  }

  /** 端末は AMT の画面を開くときに読み込む(RDP だけ使うときは xterm.js を読まない) */
  private async terminal(): Promise<Xterm> {
    if (this.tty) return this.tty.term;
    const tty = await openTerminal(this.term);
    const enc = new TextEncoder();
    // キー入力は SOL に送る
    tty.term.onData((s) => this.sol?.send(enc.encode(s)));
    tty.term.onBinary((s) =>
      this.sol?.send(Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)),
    );
    this.tty = tty;
    return tty.term;
  }

  close(): void {
    clearTimeout(this.poll);
    this.ider?.close();
    this.ider = undefined;
    window.removeEventListener("beforeunload", keepOpen);
    this.iderStop.hidden = true;
    this.iderBoot.disabled = false;
    this.iderFile.removeEventListener("change", this.onFile);
    this.disarm(true);
    this.actions.replaceChildren();
    this.enableRedirectionButton.hidden = true;
    this.sol?.close();
    this.sol = undefined;
    clearTimeout(this.solFlush);
    this.tty?.dispose();
    this.tty = undefined;
    // つないだら「SOL を切断」にする(connectSol)
    this.solButton.textContent = "SOL に接続";
    this.note("");
    this.root.removeEventListener("click", this.onClick);
    this.actions.removeEventListener("keydown", this.onPowerKey);
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
    return "AMT のリダイレクトが無効です。上のバーの「SOL・IDE-R を有効にする」を押すか、MEBx で有効にしてください";
  if (m.includes("AMT TLS failed"))
    return "AMT と TLS でつなげませんでした。AMT の TLS の設定と cert_sha256 を確かめてください";
  return m;
}
