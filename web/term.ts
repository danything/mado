// 端末(xterm.js)。AMT の SOL と Talos のダッシュボードで使う。開くときに読み込む(RDP だけ使うときは xterm.js を読まない)。
// 置く場所には class="tty" を付ける(style.css。キー入力を受ける隠れた欄を画面の外に置く)。

export type Xterm = import("@xterm/xterm").Terminal;

export type Tty = {
  term: Xterm;
  /** 端末と大きさの見張りを片付け、置き場所を空にする */
  dispose(): void;
};

/** el に端末を開く。大きさは el に合わせ、el の大きさが変われば合わせ直す(term.onResize が来る) */
export async function openTerminal(el: HTMLElement): Promise<Tty> {
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
  term.open(el);
  // xterm.js がキー入力を受ける隠れた textarea を、ブラウザが「文章を書く欄」とみなして、Edge の「Ask Edge to help me write」や
  // その目印(端末の左上の青い点)を出していた。端末には要らないので、書く手伝い・スペルチェック・自動補完を切る
  if (term.textarea) {
    const ta = term.textarea;
    ta.setAttribute("writingsuggestions", "false");
    ta.setAttribute("spellcheck", "false");
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("autocapitalize", "off");
  }
  fit.fit();
  const resize = new ResizeObserver(() => fit.fit());
  resize.observe(el);
  return {
    term,
    dispose() {
      resize.disconnect();
      term.dispose();
      el.replaceChildren();
    },
  };
}

/** 端末に書く、mado からの控えた知らせ(灰色) */
export const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
