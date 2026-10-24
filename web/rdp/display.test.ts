// 表示上の位置から RDP の座標への変換と、fit の試験。DOM を使わない部分だけを試す。

import { describe, expect, test } from "bun:test";
import { fitSize, syncModifiers, toRdpPoint } from "./display";

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
