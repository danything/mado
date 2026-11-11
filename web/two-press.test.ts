import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { MIN_SECOND_MS, TwoPress } from "./two-press";

type Action = { key: string; label: string; once?: boolean };
const ON: Action = { key: "on", label: "電源オン", once: true };
const OFF: Action = { key: "off", label: "強制電源オフ" };
const RESET: Action = { key: "reset", label: "強制再起動" };

/** bun には DOM が無いので、TwoPress が触るところだけの偽物 */
function setup() {
  const buttons = [ON, OFF, RESET].map((a) => ({
    dataset: { power: a.key } as Record<string, string>,
    textContent: a.label,
    armed: false,
    toggleAttribute(_: string, on: boolean) {
      this.armed = on;
    },
  }));
  const status = {
    textContent: "",
    dataset: {} as Record<string, string>,
  };
  const ran: string[] = [];
  const two = new TwoPress<Action>(
    {
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => buttons,
    } as unknown as HTMLElement,
    status as unknown as HTMLElement,
    (text, kind) => {
      status.textContent = text;
      if (kind) status.dataset.kind = kind;
      else delete status.dataset.kind;
    },
    (a) => a.key,
    (a) => void ran.push(a.key),
  );
  const text = (a: Action) =>
    buttons.find((b) => b.dataset.power === a.key)?.textContent;
  return { two, status, ran, text };
}

// 時刻は試験の間だけ差し替える(ほかの試験に残さない)
let now = 0;
let clock: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
  now = 0;
  clock = spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => clock?.mockRestore());

describe("2 回押しで確定するボタン", () => {
  test("1 回目では実行せず、文を変えて待つ。2 回目で実行する", () => {
    const { two, status, ran, text } = setup();
    two.press(OFF);
    expect(ran).toEqual([]);
    expect(two.pending).toBe(OFF);
    expect(text(OFF)).toBe("もう一度押すと強制電源オフ");
    expect(status.textContent).toBe("もう一度押すと強制電源オフします");
    now += MIN_SECOND_MS + 1;
    two.press(OFF);
    expect(ran).toEqual(["off"]);
    expect(two.pending).toBeUndefined();
    expect(text(OFF)).toBe("強制電源オフ");
    two.dispose();
  });

  test("すぐの 2 回目(ダブルクリック)は受けない", () => {
    const { two, ran } = setup();
    two.press(OFF);
    now += MIN_SECOND_MS - 1;
    two.press(OFF);
    expect(ran).toEqual([]);
    expect(two.pending).toBe(OFF);
    two.dispose();
  });

  test("別の操作を押すと、前の待ちは取り消してそちらを待つ", () => {
    const { two, ran, text } = setup();
    two.press(OFF);
    now += MIN_SECOND_MS + 1;
    two.press(RESET);
    expect(ran).toEqual([]);
    expect(two.pending).toBe(RESET);
    expect(text(OFF)).toBe("強制電源オフ");
    expect(text(RESET)).toBe("もう一度押すと強制再起動");
    two.dispose();
  });

  test("待ちをやめると、文と状態の文を前に戻す", () => {
    const { two, status, text } = setup();
    status.textContent = "電源オン: 受け付けました";
    status.dataset.kind = "ok";
    two.press(OFF);
    expect(status.dataset.kind).toBeUndefined();
    two.disarm(true);
    expect(text(OFF)).toBe("強制電源オフ");
    expect(status.textContent).toBe("電源オン: 受け付けました");
    expect(status.dataset.kind).toBe("ok");
    two.dispose();
  });
});

describe("1 回押しの操作(once)", () => {
  test("電源オンは 1 回目で実行し、文を変えない", () => {
    const { two, status, ran, text } = setup();
    two.press(ON);
    expect(ran).toEqual(["on"]);
    expect(two.pending).toBeUndefined();
    expect(text(ON)).toBe("電源オン");
    expect(status.textContent).toBe("");
    two.dispose();
  });

  test("ほかの操作の 2 回目を待っていたら、それは取り消す", () => {
    const { two, status, ran, text } = setup();
    two.press(OFF);
    two.press(ON);
    expect(ran).toEqual(["on"]);
    expect(two.pending).toBeUndefined();
    expect(text(OFF)).toBe("強制電源オフ");
    expect(status.textContent).toBe("");
    two.dispose();
  });
});
