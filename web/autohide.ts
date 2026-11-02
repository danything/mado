// RDP の画面(canvas)の上に重ねる操作の 1 行を、使っていないときは隠す(画面を広く使うため)。
// 決め方は denpa のプレーヤーの操作列(src/lib/components/player/controls.svelte.ts)に揃える:
// 触らなくなって 2.5 秒で引っ込め、キーボードで触っている間とメニューを開いている間は残す。マウスが窓の外へ出たらすぐ引っ込める。
// 違うのは呼び出し方だけ。マウスはリモートの操作に使うので、動かすたびに出るとリモートの窓のタイトルバーが押せない。
// 画面の上の端に寄せたときだけ出す(RDP のクライアントと同じ)。
// AMT の SOL は画面を広く使う必要が薄いので、バーを引っ込めない(style.css の .pinned)。
// 動きは CSS(style.css の .overlay)で、ここは data-shown を付け外しするだけ

/** 触らなくなってから消えるまで(denpa の LINGER と同じ) */
export const LINGER_MS = 2500;
/** 上の端から何 px までを、バーを呼び出す場所にするか(指は太いので広め) */
const EDGE_PX = 8;
const EDGE_TOUCH_PX = 32;

export type AutoHide = {
  /** しばらく出す */
  reveal(ms?: number): void;
  stop(): void;
};

export function autoHide(bar: HTMLElement): AutoHide {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 止まったカーソルの下で中身が動いただけでも pointermove が来るので、本当に動いたときだけ数える
  let lastX = Number.NaN;
  let lastY = Number.NaN;

  /** キーボードで触っている間、メニューを開いている間、指を乗せている間は残す */
  const busy = () =>
    bar.matches(":hover") ||
    bar.matches(":has(:focus-visible)") ||
    bar.querySelector("details[open]") !== null;

  const hideLater = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(function check() {
      if (busy()) {
        timer = setTimeout(check, LINGER_MS);
        return;
      }
      delete bar.dataset.shown;
    }, ms);
  };

  const reveal = (ms = LINGER_MS) => {
    bar.dataset.shown = "";
    hideLater(ms);
  };

  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === "mouse") {
      if (e.clientX === lastX && e.clientY === lastY) return;
      lastX = e.clientX;
      lastY = e.clientY;
    } else if (e.type !== "pointerdown") return; // 指は押したときだけ(滑らせただけでは出さない)
    const edge = e.pointerType === "mouse" ? EDGE_PX : EDGE_TOUCH_PX;
    if (e.clientY <= edge || bar.contains(e.target as Node)) reveal();
  };
  /** マウスが窓の外へ出たら、すぐ引っ込める */
  const onOut = (e: MouseEvent) => {
    if (e.relatedTarget === null) hideLater(0);
  };
  const onFocus = () => reveal();
  const onLeave = () => hideLater(LINGER_MS);

  addEventListener("pointermove", onPointer);
  addEventListener("pointerdown", onPointer);
  document.addEventListener("mouseout", onOut);
  bar.addEventListener("focusin", onFocus);
  bar.addEventListener("focusout", onLeave);
  // details の toggle は泡立たないので、捕まえる側で受ける
  bar.addEventListener("toggle", onFocus, true);
  // 開いた直後は、どこに何があるか分かるように少し長く出す
  reveal(LINGER_MS * 2);

  return {
    reveal,
    stop() {
      clearTimeout(timer);
      removeEventListener("pointermove", onPointer);
      removeEventListener("pointerdown", onPointer);
      document.removeEventListener("mouseout", onOut);
      bar.removeEventListener("focusin", onFocus);
      bar.removeEventListener("focusout", onLeave);
      bar.removeEventListener("toggle", onFocus, true);
      delete bar.dataset.shown;
    },
  };
}
