import { describe, expect, test } from "bun:test";

import { holdTab } from "./hold-tab";

function fakeWindow(keyboard?: object) {
  const listeners = new Map<string, EventListener>();
  return {
    win: {
      navigator: { keyboard },
      addEventListener: (t: string, f: EventListener) => listeners.set(t, f),
      removeEventListener: (t: string, f: EventListener) => {
        if (listeners.get(t) === f) listeners.delete(t);
      },
    } as unknown as Window,
    listeners,
  };
}

describe("holdTab", () => {
  test("つないでいる間は閉じる前に確かめさせ、外すと戻す", () => {
    const { win, listeners } = fakeWindow();
    const release = holdTab(win);
    const unload = listeners.get("beforeunload");
    expect(unload).toBeDefined();
    let prevented = false;
    unload?.({ preventDefault: () => (prevented = true) } as unknown as Event);
    expect(prevented).toBe(true);
    release();
    expect(listeners.has("beforeunload")).toBe(false);
  });

  test("Keyboard Lock があればキーを取り、外すと放す", async () => {
    const calls: string[] = [];
    const { win } = fakeWindow({
      lock: async () => void calls.push("lock"),
      unlock: () => void calls.push("unlock"),
    });
    const release = holdTab(win);
    release();
    expect(calls).toEqual(["lock", "unlock"]);
  });

  test("Keyboard Lock に断られても止まらない", async () => {
    const { win } = fakeWindow({
      lock: () => Promise.reject(new Error("not allowed")),
      unlock: () => {},
    });
    const release = holdTab(win);
    await Promise.resolve();
    release();
  });
});
