// 2 回押しで確定するボタン(AMT と Talos の電源の操作)。窓は出さない(denpa の「聞き返しの 2 回目」と同じ)。
// 1 回目でボタンの文を「もう一度押すと再起動」に変え、バーの状態の文にも出す。ARM_MS 以内にもう一度押すと実行し、押さなければ戻す。
// ボタンは container の中の button[data-power]。値はその操作の key。

/** 1 回目のあと、2 回目を待つ時間 */
export const ARM_MS = 3000;
/** 1 回目からこれより早い 2 回目は受けない(ダブルクリック) */
export const MIN_SECOND_MS = 400;

export type Note = (text: string, kind?: "error" | "ok" | "warn") => void;

export class TwoPress<A extends { label: string }> {
  private armed?: {
    action: A;
    timer: ReturnType<typeof setTimeout>;
    message: string;
    /** 1 回目を押した時刻。ダブルクリックを 2 回押しとみなさない */
    at: number;
    /** 1 回目の前の状態の文。待ちをやめたら戻す */
    before: { text: string; kind?: "error" | "ok" };
  };

  /**
   * @param container ボタンを並べる要素。キーの押しっぱなしをここで捨てる
   * @param status バーの状態の文(aria-live。読み上げにも伝わる)
   * @param keyOf 操作を data-power の値にする
   * @param run 2 回目で呼ぶ
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly status: HTMLElement,
    private readonly note: Note,
    private readonly keyOf: (a: A) => string,
    private readonly run: (a: A) => void,
  ) {
    container.addEventListener("keydown", this.onKey);
  }

  /** 2 回目を待っている操作 */
  get pending(): A | undefined {
    return this.armed?.action;
  }

  /** ボタンを作る。戻せない操作(danger)は、乗せたときと 2 回目を待つ間は赤い字(style.css) */
  button(action: A, title: string, danger = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.power = this.keyOf(action);
    b.title = title;
    b.className = danger ? "secondary danger" : "secondary";
    this.paint(b, action);
    return b;
  }

  buttons(): NodeListOf<HTMLButtonElement> {
    return this.container.querySelectorAll<HTMLButtonElement>(
      "button[data-power]",
    );
  }

  /** ボタンの文。2 回目を待っている間は「もう一度押すと…」 */
  private paint(b: HTMLButtonElement, action: A): void {
    const armed =
      this.armed !== undefined &&
      this.keyOf(this.armed.action) === this.keyOf(action);
    b.textContent = armed ? `もう一度押すと${action.label}` : action.label;
    b.toggleAttribute("data-armed", armed);
  }

  private repaint(action: A): void {
    for (const b of this.buttons())
      if (b.dataset.power === this.keyOf(action)) this.paint(b, action);
  }

  /** ボタンを押した。1 回目なら待ち、待っている操作の 2 回目なら run */
  press(action: A): void {
    const key = this.keyOf(action);
    if (this.armed && this.keyOf(this.armed.action) === key) {
      // 素早いダブルクリックは 1 回目だけとみなす
      if (performance.now() - this.armed.at < MIN_SECOND_MS) return;
      this.disarm(false);
      this.run(action);
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
    this.repaint(action);
    this.note(message);
  }

  /** 2 回目の待ちをやめ、ボタンの文を戻す。clearNote なら待ちの知らせを前の文に戻す */
  disarm(clearNote: boolean): void {
    const a = this.armed;
    if (!a) return;
    clearTimeout(a.timer);
    this.armed = undefined;
    this.repaint(a.action);
    if (clearNote && this.status.textContent === a.message)
      this.note(a.before.text, a.before.kind);
  }

  /** Enter の押しっぱなしは keydown ごとに click になるので、繰り返しは捨てる(2 回押しをすり抜けさせない) */
  private onKey = (e: KeyboardEvent) => {
    if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
  };

  dispose(): void {
    this.disarm(true);
    this.container.removeEventListener("keydown", this.onKey);
  }
}
