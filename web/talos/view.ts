// Talos のダッシュボードの画面。つなぐ先の一覧で talos の先を選んで「開く」と、画面いっぱいの端末(SOL と同じ見た目)に
// talosctl dashboard を出す。上の常に出ているバーに名前・種類・期限の知らせ・電源の操作(2 回押しで確定)・「閉じる」。
// AMT と違ってこの画面で入れるものは無い(talosctl の鍵は mado の PC にあり、mado.json で決まる)。

import { gray, openTerminal, type Tty } from "../term";
import { TwoPress } from "../two-press";
import {
  DashboardSession,
  expiryNote,
  explainDashboardError,
  explainPowerResult,
  TALOS_POWER,
  type TalosPowerAction,
  type TalosPowerResult,
} from "./dashboard";

export type TalosTarget = {
  name: string;
  /** notAfter は talosconfig の証明書の期限 */
  talos?: { notAfter?: string };
};

export type TalosDeps = {
  /** /api/token を取る(使い捨ての中継のトークン) */
  newToken: (target: string) => Promise<string>;
  /** /ws の URL。ダッシュボードはその隣の /ws/talos */
  ws: string;
  /** 電源の操作を頼む(POST /api/talos/<名前>/<操作>) */
  power: (
    target: string,
    action: TalosPowerAction["key"],
  ) => Promise<TalosPowerResult>;
};

const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

/** talosctl が終わったあと、代替画面・色・カーソルを戻す(talosctl が書いた失敗の理由は消さない) */
const RESTORE = "\x1b[?1049l\x1b[0m\x1b[?25h";

export class TalosView {
  private readonly root = $<HTMLElement>("#talos");
  private readonly status = $<HTMLElement>("#talos-status");
  private readonly reopenButton = $<HTMLButtonElement>("#talos-reopen");
  private readonly termEl = $<HTMLElement>("#talos-term");
  private readonly actions = $<HTMLElement>("#talos-actions");
  /** 電源のボタン。open で作る */
  private power?: TwoPress<TalosPowerAction>;
  /** 電源の操作を頼んでいる間。その間は電源のボタンを受けない */
  private powerBusy = false;
  private tty?: Tty;
  private dash?: DashboardSession;
  private connecting = false;
  private closed?: () => void;

  constructor(
    private readonly target: TalosTarget,
    private readonly deps: TalosDeps,
  ) {}

  /** 画面を出して端末を作り、すぐダッシュボードを開く。xterm.js を読めなければ例外 */
  async open(): Promise<void> {
    $<HTMLElement>("#talos-name").textContent = this.target.name;
    this.showExpiry();
    this.reopenButton.hidden = true;
    const power = new TwoPress<TalosPowerAction>(
      this.actions,
      this.status,
      (text, kind) => this.note(text, kind),
      (a) => a.key,
      (a) => void this.changePower(a),
    );
    this.power = power;
    // 止める準備はするが、ノードは止まる(戻せない)ので、乗せたときと 2 回目を待つ間は赤い字
    this.actions.replaceChildren(
      ...TALOS_POWER.map((a) => power.button(a, a.description, true)),
    );
    this.root.hidden = false;
    this.root.addEventListener("click", this.onClick);
    try {
      this.tty = await openTerminal(this.termEl);
    } catch (e) {
      this.close();
      throw e;
    }
    const term = this.tty.term;
    const enc = new TextEncoder();
    // キー入力はそのまま talosctl に届く(F1〜F4 で画面を切り替え、q か Ctrl+C で終わる)
    term.onData((s) => this.dash?.send(enc.encode(s)));
    term.onBinary((s) =>
      this.dash?.send(Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)),
    );
    // ダッシュボードは端末の大きさで描くので、変わったら talosctl に伝える(ConPTY の大きさを変える)
    term.onResize(({ cols, rows }) => this.dash?.resize(cols, rows));
    void this.connect();
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
      const action = TALOS_POWER.find((a) => a.key === b.dataset.power);
      if (action && !this.powerBusy) this.power?.press(action);
      return;
    }
    // 別のボタンを押したら、電源の 2 回目の待ちは取り消す
    this.power?.disarm(true);
    if (b.dataset.talos === "reopen") void this.connect();
    else if (b.dataset.talos === "close") this.close();
  };

  /** 2 回目で頼む。結果(受け付けた・失敗とその理由)をバーの状態の文に出す */
  private async changePower(action: TalosPowerAction): Promise<void> {
    this.powerBusy = true;
    this.note(`${action.label}…`);
    try {
      const r = await this.deps.power(this.target.name, action.key);
      const { text, kind } = explainPowerResult(action, r);
      this.note(text, kind);
    } catch (e) {
      this.note(
        `${action.label}できませんでした: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      this.powerBusy = false;
    }
  }

  /** /ws/talos につなぐ。mado が talosctl を動かす */
  private async connect(): Promise<void> {
    const tty = this.tty;
    if (!tty || this.dash || this.connecting) return;
    const term = tty.term;
    this.connecting = true;
    this.reopenButton.hidden = true;
    this.showExpiry();
    term.reset();
    term.writeln(gray("ダッシュボードを開いています…"));
    try {
      const token = await this.deps.newToken(this.target.name);
      const dash = await DashboardSession.open(
        this.deps.ws.replace(/\/ws$/, "/ws/talos"),
        token,
        term.cols,
        term.rows,
      );
      if (this.tty !== tty) {
        // 開いている間に閉じられた
        dash.close();
        return;
      }
      this.dash = dash;
      dash.onData = (b) => term.write(b);
      term.focus();
      void dash.done.then((reason) => {
        if (this.dash !== dash) return;
        this.dash = undefined;
        const text = explainDashboardError(reason);
        term.write(RESTORE);
        term.writeln(`\r\n${gray(text)}`);
        if (/^exited 0$|^closed$|^$/.test(reason)) this.showExpiry();
        else this.note(text, "error");
        this.ended();
      });
    } catch (e) {
      if (this.tty !== tty) return;
      const text = `ダッシュボードを開けませんでした: ${e instanceof Error ? e.message : String(e)}`;
      term.writeln(`\x1b[31m✕\x1b[0m ${text}`);
      this.note(text, "error");
      this.ended();
    } finally {
      this.connecting = false;
    }
  }

  /** 終わったら「もう一度開く」を出す。焦点を置くので、Enter でも開き直せる */
  private ended(): void {
    if (this.root.hidden) return;
    this.reopenButton.hidden = false;
    this.reopenButton.focus();
  }

  /** talosconfig の期限が近ければバーに出す */
  private showExpiry(): void {
    const expiry = expiryNote(this.target.talos?.notAfter, new Date());
    this.note(expiry?.text ?? "", expiry?.kind);
  }

  /** バーの状態の文。kind があれば頭にアイコン(style.css の .note) */
  private note(text: string, kind?: "error" | "ok" | "warn"): void {
    this.status.textContent = text;
    if (kind) this.status.dataset.kind = kind;
    else delete this.status.dataset.kind;
  }

  close(): void {
    this.power?.dispose();
    this.power = undefined;
    this.actions.replaceChildren();
    const dash = this.dash;
    this.dash = undefined;
    dash?.close();
    this.tty?.dispose();
    this.tty = undefined;
    this.reopenButton.hidden = true;
    this.note("");
    this.root.removeEventListener("click", this.onClick);
    this.root.hidden = true;
    this.closed?.();
  }
}
