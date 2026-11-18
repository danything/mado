// 更新のあと、開いたままのページを読み直す(stale.ts)の試験。DOM は使わず、偽の事件の先とタイマーで試す。

import { describe, expect, test } from "bun:test";

import { CHECK_MS, type StaleDeps, watchStale } from "./stale";

function setup(over: Partial<StaleDeps> & { server?: string } = {}) {
  const log: string[] = [];
  const events = new EventTarget();
  let tick: (() => void) | undefined;
  let interval: number | undefined;
  const state = { server: over.server ?? "v1.0.0", idle: true, visible: true };
  const w = watchStale({
    loaded: "v1.0.0",
    fetchVersion: async () => {
      log.push("fetch");
      return state.server;
    },
    idle: () => state.idle,
    reload: () => log.push("reload"),
    notify: (v) => log.push(`notify ${v}`),
    visible: () => state.visible,
    events,
    setInterval: (fn, ms) => {
      tick = fn;
      interval = ms;
      return 1;
    },
    clearInterval: () => {
      tick = undefined;
    },
    ...over,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { w, log, events, state, flush, tick: () => tick?.(), interval };
}

describe("watchStale", () => {
  test("版が同じなら何もしない", async () => {
    const t = setup();
    await t.w.check();
    expect(t.log).toEqual(["fetch"]);
  });

  test("版が変わっていて、読み直してよいなら読み直す", async () => {
    const t = setup({ server: "v1.0.1" });
    await t.w.check();
    expect(t.log).toEqual(["fetch", "reload"]);
  });

  test("つないでいる間は読み直さず、知らせるだけ。空いたら次の確かめで読み直す", async () => {
    const t = setup({ server: "v1.0.1" });
    t.state.idle = false;
    await t.w.check();
    await t.w.check();
    expect(t.log).toEqual(["fetch", "notify v1.0.1"]);
    t.state.idle = true;
    await t.w.check();
    // 分かった版を覚えているので、聞き直さない
    expect(t.log).toEqual(["fetch", "notify v1.0.1", "reload"]);
  });

  test("版を聞けないときは何もしない", async () => {
    const t = setup({ fetchVersion: async () => undefined });
    await t.w.check();
    const u = setup({
      fetchVersion: () => Promise.reject(new Error("止まっている")),
    });
    await u.w.check();
    expect([...t.log, ...u.log]).toEqual([]);
  });

  test("裏から戻ったとき・pageshow・online・時々確かめる。隠れている間は聞かない", async () => {
    const t = setup({ server: "v1.0.1" });
    t.state.idle = false;
    expect(t.interval).toBe(CHECK_MS);
    t.state.visible = false;
    t.events.dispatchEvent(new Event("visibilitychange"));
    t.tick();
    await t.flush();
    expect(t.log).toEqual([]);
    t.state.visible = true;
    t.events.dispatchEvent(new Event("visibilitychange"));
    await t.flush();
    expect(t.log).toEqual(["fetch", "notify v1.0.1"]);
    t.state.idle = true;
    t.events.dispatchEvent(new Event("pageshow"));
    await t.flush();
    expect(t.log).toEqual(["fetch", "notify v1.0.1", "reload"]);
  });

  test("stop のあとは確かめない", async () => {
    const t = setup({ server: "v1.0.1" });
    t.w.stop();
    t.events.dispatchEvent(new Event("online"));
    t.tick();
    await t.flush();
    expect(t.log).toEqual([]);
  });
});
