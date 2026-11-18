// 指の操作の状態機械の試験。DOM を使わない

import { describe, expect, test } from "bun:test";

import { DRAG_SLOP_PX, SCROLL_GAIN, TouchGestures } from "./touch";

describe("1 本指", () => {
  test("動かさずに離すと、その位置でクリック", () => {
    const g = new TouchGestures();
    expect(g.down(1, { x: 10, y: 20 })).toEqual([]);
    expect(g.move(1, { x: 12, y: 21 })).toEqual([]);
    expect(g.up(1, { x: 12, y: 21 })).toEqual([
      { kind: "move", x: 10, y: 20 },
      { kind: "down", x: 10, y: 20 },
      { kind: "up", x: 10, y: 20 },
    ]);
  });
  test("押したまま動かすと、置いた位置から左ボタンのドラッグ", () => {
    const g = new TouchGestures();
    g.down(1, { x: 0, y: 0 });
    expect(g.move(1, { x: DRAG_SLOP_PX, y: 0 })).toEqual([
      { kind: "move", x: 0, y: 0 },
      { kind: "down", x: 0, y: 0 },
      { kind: "move", x: DRAG_SLOP_PX, y: 0 },
    ]);
    expect(g.move(1, { x: 30, y: 5 })).toEqual([{ kind: "move", x: 30, y: 5 }]);
    expect(g.up(1, { x: 30, y: 5 })).toEqual([{ kind: "up", x: 30, y: 5 }]);
  });
});

describe("2 本指", () => {
  test("指を上へ滑らせると、下へのホイール", () => {
    const g = new TouchGestures();
    g.down(1, { x: 100, y: 200 });
    expect(g.down(2, { x: 200, y: 200 })).toEqual([]);
    g.move(1, { x: 100, y: 180 });
    // 2 本とも 20px 上へ: 真ん中は 1 本目で 10px、2 本目でさらに 10px 上がる
    expect(g.move(2, { x: 200, y: 180 })).toEqual([
      { kind: "wheel", dx: 0, dy: 10 * SCROLL_GAIN },
    ]);
  });
  test("スクロールのあと指を 1 本ずつ離しても、クリックにならない", () => {
    const g = new TouchGestures();
    g.down(1, { x: 0, y: 0 });
    g.down(2, { x: 100, y: 0 });
    g.move(2, { x: 100, y: -50 });
    expect(g.up(2, { x: 100, y: -50 })).toEqual([]);
    expect(g.move(1, { x: 0, y: -40 })).toEqual([]);
    expect(g.up(1, { x: 0, y: -40 })).toEqual([]);
    // 全部離したら、次の 1 本指はまたクリックになる
    g.down(3, { x: 5, y: 5 });
    expect(g.up(3, { x: 5, y: 5 })).toHaveLength(3);
  });
  test("ドラッグ中に 2 本目を置くと、ボタンを離してからスクロール", () => {
    const g = new TouchGestures();
    g.down(1, { x: 0, y: 0 });
    g.move(1, { x: 20, y: 0 });
    expect(g.down(2, { x: 60, y: 0 })).toEqual([{ kind: "up", x: 20, y: 0 }]);
    expect(g.move(2, { x: 60, y: 10 })).toEqual([
      { kind: "wheel", dx: 0, dy: -5 * SCROLL_GAIN },
    ]);
  });
});

test("知らない指の移動と離しは無視する", () => {
  const g = new TouchGestures();
  expect(g.move(9, { x: 1, y: 1 })).toEqual([]);
  expect(g.up(9, { x: 1, y: 1 })).toEqual([]);
});

describe("取り消された指", () => {
  test("まだ押していなければ、クリックにしない", () => {
    const g = new TouchGestures();
    g.down(1, { x: 10, y: 20 });
    expect(g.cancel(1)).toEqual([]);
    // 次の指はまたクリックになる
    g.down(2, { x: 5, y: 5 });
    expect(g.up(2, { x: 5, y: 5 })).toHaveLength(3);
  });
  test("ドラッグ中なら、最後の位置でボタンを離す", () => {
    const g = new TouchGestures();
    g.down(1, { x: 0, y: 0 });
    g.move(1, { x: 20, y: 0 });
    expect(g.cancel(1)).toEqual([{ kind: "up", x: 20, y: 0 }]);
  });
  test("知らない指は無視する", () => {
    expect(new TouchGestures().cancel(3)).toEqual([]);
  });
});
