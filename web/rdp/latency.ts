// 回線と端末の混み具合を測る(診断に出す)。GFX のフレームにサーバーが付けた時刻から、こちらで描き終えるまでの遅れで測る。
// 時計がずれているので遅れそのものは分からない。それでも、いちばん小さかった遅れとの差は分かる。この差を溜まった遅れと呼ぶ。
// WebRTC の遅延ベースの輻輳制御と同じ考え方。
// 混んだときに送る量を減らすのはサーバーで、こちらは Frame Acknowledge で未描画のフレームの数を返すだけ(gfx.ts)。
// 解像度は下げない。Windows は表示の倍率を 100% のまま画素だけ減らすので、窓いっぱいに引き伸ばすと字やウィンドウが大きく見える

/** 1 日の ms。GFX の時刻には日付が無く、時・分・秒・ms だけ */
const DAY = 86_400_000;
/** いちばん小さい遅れを探す範囲 */
const BASE_WINDOW_MS = 30_000;
/** 遅れがこれより大きく跳んだら、時計が飛んだとみなす。本当に混んでいても、一度にここまでは溜まらない */
const CLOCK_JUMP_MS = 5000;
/** 溜まった遅れを出すのに要るフレームの数 */
const MIN_SAMPLES = 5;

/** RDPGFX_START_FRAME_PDU の timestamp を、その日の 0 時からの ms にする。timestamp は下から ms 10 ビット、秒 6、分 6、時 10 */
export function gfxTimestampMs(t: number): number {
  const ms = t & 0x3ff;
  const s = (t >>> 10) & 0x3f;
  const m = (t >>> 16) & 0x3f;
  const h = (t >>> 22) & 0x3ff;
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

/** フレームが作られてから描き終えるまでの遅れのうち、溜まった分を測る */
export class FrameLatency {
  private samples: { at: number; delay: number }[] = [];
  /** 最後に測った、溜まった遅れ(ms) */
  queued?: number;
  /** 最後に測った時刻。古ければ使わない */
  at = 0;

  /** serverMs はフレームの時刻で、その日の 0 時からの ms。nowUtc はこちらの Date.now()、mono は performance.now() */
  add(serverMs: number, nowUtc: number, mono: number): void {
    // 日付をまたいでも、差を ±12 時間に収める
    let delay = ((((nowUtc % DAY) - serverMs) % DAY) + DAY) % DAY;
    if (delay > DAY / 2) delay -= DAY;
    // 起動直後の時刻合わせなどで、どちらかの時計が飛んだ。前の遅れとは比べられないので測り直す
    const last = this.samples.at(-1);
    if (last && Math.abs(delay - last.delay) > CLOCK_JUMP_MS) this.samples = [];
    while (this.samples[0] && mono - this.samples[0].at > BASE_WINDOW_MS)
      this.samples.shift();
    this.samples.push({ at: mono, delay });
    let base = delay;
    for (const s of this.samples) base = Math.min(base, s.delay);
    // フレームが少ないうちは、いちばん小さい遅れが当てにならない
    this.queued = this.samples.length >= MIN_SAMPLES ? delay - base : undefined;
    this.at = mono;
  }
}
