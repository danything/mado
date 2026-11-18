// 指の操作 (Android のタブレットなど) を、RDP のマウスとホイールにする。DOM を使わない状態機械で、display.ts がポインタイベントを渡す。
//
// - 1 本指: 触れて動かさずに離せばクリック。押したまま動かすと左ボタンのドラッグ
// - 2 本指: 2 本の真ん中が動いた分をホイールにする。指を上へ滑らせると、ページは下へ進む (ブラウザでの指のスクロールと同じ向き)
//
// 1 本目を置いてすぐ 2 本目を置くことがあるので、1 本指はすぐには押さない。少し動くか離すまで待ち、その前に 2 本目が来ればスクロールにする

/** 1 本指で、ここまで動いたらドラッグとみなす (CSS px) */
export const DRAG_SLOP_PX = 8;
/** 2 本指のスクロールで、指の移動 (CSS px) にかける倍率。input.WHEEL_NOTCH_PX が 100 なので、指 50px で 1 ノッチ */
export const SCROLL_GAIN = 2;

export type TouchAction =
  | { kind: "move"; x: number; y: number }
  | { kind: "down"; x: number; y: number }
  | { kind: "up"; x: number; y: number }
  /** dx・dy はホイールの量 (ホイールの deltaX・deltaY と同じ向きと単位) */
  | { kind: "wheel"; dx: number; dy: number };

type Pt = { x: number; y: number };

export class TouchGestures {
  private points = new Map<number, Pt>();
  /** 1 本指で、まだ押していない: start は置いた位置 */
  private pending: Pt | null = null;
  private dragging = false;
  /** 2 本指でスクロールしている。指が 1 本になっても、全部離すまではスクロールのまま (クリックにしない) */
  private scrolling = false;
  private center: Pt | null = null;

  /** 指を置いた。p は CSS px の位置 */
  down(id: number, p: Pt): TouchAction[] {
    this.points.set(id, p);
    if (this.points.size === 1 && !this.scrolling) {
      this.pending = p;
      return [];
    }
    // 2 本目: 押す前ならスクロールに切り替える。ドラッグ中なら離してからスクロールにする
    const out: TouchAction[] = [];
    if (this.dragging) {
      const first = this.firstPoint();
      out.push({ kind: "up", x: first.x, y: first.y });
      this.dragging = false;
    }
    this.pending = null;
    this.scrolling = true;
    this.center = this.mid();
    return out;
  }

  /** 指が動いた */
  move(id: number, p: Pt): TouchAction[] {
    if (!this.points.has(id)) return [];
    this.points.set(id, p);
    if (this.scrolling) {
      if (this.points.size < 2 || !this.center) return [];
      const c = this.mid();
      const dx = (this.center.x - c.x) * SCROLL_GAIN;
      const dy = (this.center.y - c.y) * SCROLL_GAIN;
      this.center = c;
      return dx || dy ? [{ kind: "wheel", dx, dy }] : [];
    }
    if (this.pending) {
      if (Math.hypot(p.x - this.pending.x, p.y - this.pending.y) < DRAG_SLOP_PX)
        return [];
      const start = this.pending;
      this.pending = null;
      this.dragging = true;
      return [
        { kind: "move", x: start.x, y: start.y },
        { kind: "down", x: start.x, y: start.y },
        { kind: "move", x: p.x, y: p.y },
      ];
    }
    if (this.dragging) return [{ kind: "move", x: p.x, y: p.y }];
    return [];
  }

  /** 指を離した */
  up(id: number, p: Pt): TouchAction[] {
    return this.release(id, p, true);
  }

  /** ブラウザが指を取り消した (pointercancel)。まだ押していなければクリックにせず、ドラッグ中なら最後の位置で離す */
  cancel(id: number): TouchAction[] {
    const p = this.points.get(id);
    return p ? this.release(id, p, false) : [];
  }

  private release(id: number, p: Pt, click: boolean): TouchAction[] {
    if (!this.points.delete(id)) return [];
    const out: TouchAction[] = [];
    if (this.pending && !click) {
      this.pending = null;
    } else if (this.pending) {
      // 動かさずに離した: その位置でクリック
      const at = this.pending;
      out.push(
        { kind: "move", x: at.x, y: at.y },
        { kind: "down", x: at.x, y: at.y },
        { kind: "up", x: at.x, y: at.y },
      );
      this.pending = null;
    } else if (this.dragging) {
      out.push({ kind: "up", x: p.x, y: p.y });
      this.dragging = false;
    }
    if (this.scrolling) {
      if (this.points.size === 0) {
        this.scrolling = false;
        this.center = null;
      } else {
        this.center = this.mid();
      }
    }
    return out;
  }

  private firstPoint(): Pt {
    return this.points.values().next().value as Pt;
  }

  /** 置いている指のうち、最初の 2 本の真ん中 */
  private mid(): Pt {
    const [a, b] = [...this.points.values()];
    if (!a) return { x: 0, y: 0 };
    if (!b) return a;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}
