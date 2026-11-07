// RDP でつないでいる間、ブラウザのショートカット(Ctrl+W・Ctrl+T・Ctrl+N など)でタブを失わないようにする。
// ブラウザはこれらを preventDefault で止めさせないので、2 段で守る:
// - 全画面のときは Keyboard Lock でキーを丸ごと取り、接続先に送る(Chromium だけ。全画面を抜けるには Esc を長押し)。
//   つなぐときに全画面に入る(app.ts)
// - 全画面でないときや Keyboard Lock の無いブラウザでは、閉じる前にブラウザに確かめさせる(beforeunload)

type KeyboardLock = { lock(codes?: string[]): Promise<void>; unlock(): void };

/** つないでいる間だけ呼ぶ。戻り値で元に戻す */
export function holdTab(win: Window = window): () => void {
  const keyboard = (
    win.navigator as Navigator & { keyboard?: Partial<KeyboardLock> }
  ).keyboard;
  const confirmClose = (e: BeforeUnloadEvent) => e.preventDefault();
  win.addEventListener("beforeunload", confirmClose);
  // 全画面でないときに呼んでも断られない。全画面に入った間だけ効く
  keyboard?.lock?.().catch(() => {});
  return () => {
    win.removeEventListener("beforeunload", confirmClose);
    keyboard?.unlock?.();
  };
}
