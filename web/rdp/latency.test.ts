import { describe, expect, test } from "bun:test";

import { FrameLatency, gfxTimestampMs } from "./latency";

describe("フレームの遅れ", () => {
  test("GFX の時刻(ms・秒・分・時)", () => {
    // 13:05:07.250
    const t = 250 | (7 << 10) | (5 << 16) | (13 << 22);
    expect(gfxTimestampMs(t)).toBe(((13 * 60 + 5) * 60 + 7) * 1000 + 250);
  });

  test("いちばん小さい遅れとの差を、溜まった遅れとする。時計のずれは消える", () => {
    const l = new FrameLatency();
    const offset = 3_600_000; // こちらの時計が 1 時間進んでいる
    const day = Date.UTC(2026, 9, 12);
    // フレームが 5 枚たまるまでは出さない
    for (let i = 0; i < 4; i++)
      l.add(i * 100, day + i * 100 + offset + 20, i * 100);
    expect(l.queued).toBeUndefined();
    l.add(1000, day + 1000 + offset + 20, 1000);
    expect(l.queued).toBe(0);
    l.add(2000, day + 2000 + offset + 320, 2000);
    expect(l.queued).toBe(300);
    l.add(3000, day + 3000 + offset + 30, 3000);
    expect(l.queued).toBe(10);
    // 30 秒より古いものは、いちばん小さい遅れに使わない
    for (let t = 40_000; t < 45_000; t += 1000)
      l.add(t, day + t + offset + 100, t);
    expect(l.queued).toBe(0);
  });

  test("時計が飛んだら測り直す。日付をまたいでも差は小さいまま", () => {
    const l = new FrameLatency();
    const day = Date.UTC(2026, 9, 12);
    for (let i = 0; i < 5; i++) l.add(i * 100, day + i * 100 + 20, i * 100);
    // サーバーの時計が 9 秒戻っただけで、遅れが 9 秒溜まったのではない
    l.add(1000 - 9000 + 86_400_000, day + 1000 + 20, 1000);
    expect(l.queued).toBeUndefined();
    const m = new FrameLatency();
    // サーバーは 23:59:59.9xx、こちらは翌日 00:00:00.0xx
    for (let i = 0; i < 5; i++)
      m.add((86_399_950 + i * 10) % 86_400_000, day + 86_400_000 + i * 10, i);
    m.add(10, day + 86_400_000 + 60, 6);
    expect(m.queued).toBe(0);
  });
});
