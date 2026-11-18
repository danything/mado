// 表示上の位置から RDP の座標への変換、fit、指の操作の試験。DOM は使わず、指の操作は偽の canvas で試す。

import { describe, expect, test } from "bun:test";

import { concat, Reader, Writer } from "./bytes";
import type { RdpClient } from "./client";
import {
  bindInput,
  type Display,
  fitSize,
  syncModifiers,
  toRdpPoint,
} from "./display";
import {
  EVENTID,
  PROTOCOL,
  readHeader,
  readTouchEvent,
  TICK_MS,
  TOUCH_DOWN,
  TOUCH_UP,
  TouchInput,
} from "./rdpei";

describe("toRdpPoint", () => {
  const rect = { left: 100, top: 50, width: 640, height: 360 };
  test("等倍の半分に縮小されている表示を戻す", () => {
    expect(toRdpPoint(100, 50, rect, 1280, 720)).toEqual({ x: 0, y: 0 });
    expect(toRdpPoint(420, 230, rect, 1280, 720)).toEqual({ x: 640, y: 360 });
  });
  test("範囲外は端に収める", () => {
    expect(toRdpPoint(0, 0, rect, 1280, 720)).toEqual({ x: 0, y: 0 });
    expect(toRdpPoint(9999, 9999, rect, 1280, 720)).toEqual({
      x: 1279,
      y: 719,
    });
  });
  test("大きさ 0 の矩形は原点", () => {
    expect(
      toRdpPoint(5, 5, { left: 0, top: 0, width: 0, height: 0 }, 100, 100),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("fitSize", () => {
  test("縦横比を保って収める", () => {
    expect(fitSize(1280, 720, 640, 640)).toEqual({ width: 640, height: 360 });
    expect(fitSize(1280, 720, 2560, 720)).toEqual({ width: 1280, height: 720 });
  });
  test("0 は 0", () => {
    expect(fitSize(0, 720, 100, 100)).toEqual({ width: 0, height: 0 });
  });
});

describe("syncModifiers(修飾キーの状態を合わせる)", () => {
  const ev = (
    code: string,
    mods: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {},
  ) => ({
    code,
    shiftKey: !!mods.shift,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
  });

  test("Shift の keydown が来ずに Shift 付きのキーが来たら、先に Shift を押す", () => {
    const down = new Set<string>();
    expect(syncModifiers(ev("Digit5", { shift: true }), down)).toEqual([
      { code: "ShiftLeft", down: true },
    ]);
    expect(down.has("ShiftLeft")).toBe(true);
    // 2 つ目は合っているので何も送らない
    expect(syncModifiers(ev("KeyE", { shift: true }), down)).toEqual([]);
  });

  test("Shift を離した keyup が来なかったら、次のキーの前に離す(右も左も)", () => {
    const down = new Set(["ShiftLeft", "ShiftRight", "ControlLeft"]);
    expect(syncModifiers(ev("KeyA", { ctrl: true }), down)).toEqual([
      { code: "ShiftLeft", down: false },
      { code: "ShiftRight", down: false },
    ]);
    expect([...down]).toEqual(["ControlLeft"]);
  });

  test("修飾キー自身のイベントでは、その種類は合わせない", () => {
    const down = new Set<string>();
    expect(syncModifiers(ev("ShiftLeft", { shift: true }), down)).toEqual([]);
    expect(
      syncModifiers(ev("ControlRight", { ctrl: false, alt: true }), down),
    ).toEqual([{ code: "AltLeft", down: true }]);
  });
});

// ---- 指の操作(bindInput)。canvas とクライアントは偽物で、ポインタイベントは Event に値を足して作る ----

class FakeCanvas extends EventTarget {
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 640, height: 360 };
  }
  focus() {}
  setPointerCapture() {}
}

const pointer = (
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
  pointerType = "touch",
) =>
  Object.assign(new Event(type, { cancelable: true }), {
    pointerId,
    pointerType,
    clientX,
    clientY,
  });

function bindTouch(ready: boolean) {
  let now = 0;
  const timers: (() => void)[] = [];
  const touchSent: Uint8Array[] = [];
  const touch = new TouchInput({
    maxContacts: 5,
    now: () => now,
    schedule: (fn) => timers.push(fn),
  });
  const channel = { id: 1, send: (d: Uint8Array) => touchSent.push(d) };
  touch.onOpen(channel);
  const makeReady = () =>
    touch.onData(
      concat(
        new Writer(6).u16(EVENTID.SC_READY).u32(10).done(),
        new Writer(4).u32(PROTOCOL.V200).done(),
      ),
      channel,
    );
  if (ready) makeReady();
  const canvas = new FakeCanvas();
  const mouse: Uint8Array[] = [];
  const client = { sendInput: (evs: Uint8Array[]) => mouse.push(...evs) };
  const display = { width: 1280, height: 720 };
  const stop = bindInput(
    canvas as unknown as HTMLCanvasElement,
    client as unknown as RdpClient,
    display as unknown as Display,
    touch,
  );
  /** タイマーを 1 つずつ(離していない指が残っても止まるよう、10 回まで)進めて、送ったタッチの接触を [id, flags, x, y] で返す */
  const flush = () => {
    for (let i = 0; timers.length > 0 && i < 10; i++) {
      now += TICK_MS;
      timers.shift()?.();
    }
    return touchSent
      .filter((d) => readHeader(d)?.eventId === EVENTID.TOUCH)
      .flatMap((d) =>
        readTouchEvent((readHeader(d) as { body: Reader }).body).frames.map(
          (f) => f.contacts.map((c) => [c.contactId, c.contactFlags, c.x, c.y]),
        ),
      );
  };
  /** マウスの入力の pointerFlags */
  const mouseFlags = () =>
    mouse.map((b) => new DataView(b.buffer, b.byteOffset).getUint16(1, true));
  return { canvas, touch, makeReady, flush, mouse, mouseFlags, stop };
}

const MOVE = 0x0800;
const LEFT_DOWN = 0x8000 | 0x1000;
const LEFT_UP = 0x1000;

describe("bindInput の指", () => {
  test("相手がタッチを受けるなら、RDP の座標でタッチとして送り、マウスは送らない", () => {
    const b = bindTouch(true);
    const down = pointer("pointerdown", 7, 100, 50);
    b.canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    b.canvas.dispatchEvent(pointer("pointerup", 7, 100, 50));
    expect(b.flush()).toEqual([
      [[0, TOUCH_DOWN, 200, 100]],
      [[0, TOUCH_UP, 200, 100]],
    ]);
    expect(b.mouse).toEqual([]);
  });

  test("相手がタッチを受けなければ、タップを左クリックにする", () => {
    const b = bindTouch(false);
    b.canvas.dispatchEvent(pointer("pointerdown", 7, 100, 50));
    b.canvas.dispatchEvent(pointer("pointerup", 7, 100, 50));
    expect(b.mouseFlags()).toEqual([MOVE, LEFT_DOWN, LEFT_UP]);
    expect(b.flush()).toEqual([]);
  });

  test("送り方は 1 本目の指で決め、全部離すまで変えない", () => {
    const b = bindTouch(false);
    b.canvas.dispatchEvent(pointer("pointerdown", 1, 100, 100));
    b.makeReady();
    // 途中で使えるようになっても、2 本目はマウスの側(2 本指のスクロール)に入る
    b.canvas.dispatchEvent(pointer("pointerdown", 2, 200, 100));
    // 2 本目を 100px 上へ: 真ん中は 50px 上がり、ホイール 1 ノッチになる
    b.canvas.dispatchEvent(pointer("pointermove", 2, 200, 0));
    b.canvas.dispatchEvent(pointer("pointerup", 1, 100, 100));
    b.canvas.dispatchEvent(pointer("pointerup", 2, 200, 0));
    expect(b.flush()).toEqual([]);
    expect(b.mouseFlags()).toEqual([0x0200 | 0x0100 | (0x100 - 120)]);
    // 全部離したあとの指は、タッチで送る
    b.canvas.dispatchEvent(pointer("pointerdown", 3, 10, 10));
    expect(b.flush()[0]).toEqual([[0, TOUCH_DOWN, 20, 20]]);
  });

  test("指から来たマウスのイベントは捨てる", () => {
    const b = bindTouch(true);
    b.canvas.dispatchEvent(pointer("pointerdown", 1, 100, 100));
    b.canvas.dispatchEvent(pointer("pointerup", 1, 100, 100));
    // Chromium は sourceCapabilities で分かる
    b.canvas.dispatchEvent(
      Object.assign(new Event("mousedown", { cancelable: true }), {
        button: 0,
        clientX: 100,
        clientY: 100,
        sourceCapabilities: { firesTouchEvents: true },
      }),
    );
    // 分からないブラウザでも、指を離した直後のマウスは捨てる
    b.canvas.dispatchEvent(
      Object.assign(new Event("mousemove"), { clientX: 120, clientY: 100 }),
    );
    expect(b.mouse).toEqual([]);
  });

  test("指でないポインタは、ポインタイベントでは扱わない", () => {
    const b = bindTouch(true);
    const down = pointer("pointerdown", 1, 100, 100, "mouse");
    b.canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    expect(b.flush()).toEqual([]);
  });

  test("解除したら受けない", () => {
    // 解除は window の mouseup も外す
    const g = globalThis as { window?: unknown };
    g.window ??= new EventTarget();
    const b = bindTouch(true);
    b.stop();
    b.canvas.dispatchEvent(pointer("pointerdown", 1, 100, 100));
    expect(b.flush()).toEqual([]);
  });
});
