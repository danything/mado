// NSCodec の試験。ClearCodec のサブコーデック 1 として来る。試験側の符号化器での往復と、Windows の実データを確かめる。

import { describe, expect, test } from "bun:test";

import { Writer } from "./bytes";
import { nscodec, nscRle } from "./clearcodec";

/** 試験用の面の RLE。復号器と対になる形で、最後の 4 バイトはそのまま置く */
function rleEncode(plane: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (plane.length - i > 4) {
    const v = plane[i] as number;
    let n = 1;
    while (i + n < plane.length - 4 && plane[i + n] === v) n++;
    if (n >= 2) {
      out.push(v, v);
      if (n - 2 < 0xff) out.push(n - 2);
      else
        out.push(0xff, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
      i += n;
    } else {
      out.push(v);
      i++;
    }
  }
  for (; i < plane.length; i++) out.push(plane[i] as number);
  return Uint8Array.from(out);
}

function stream(
  planes: [Uint8Array, Uint8Array, Uint8Array, Uint8Array | null],
  cll: number,
  subsample: boolean,
  rle: boolean,
): Uint8Array {
  const enc = planes.map((p) =>
    p === null ? new Uint8Array() : rle ? rleEncode(p) : p,
  );
  const w = new Writer();
  for (const p of enc) w.u32(p.length);
  w.u8(cll)
    .u8(subsample ? 1 : 0)
    .u16(0);
  for (const p of enc) w.bytes(p);
  return w.done();
}

describe("NSCodec", () => {
  test("Co / Cg が 0 なら灰色。アルファの面が無ければ不透明", () => {
    const y = new Uint8Array(4 * 2).fill(100);
    const z = new Uint8Array(8);
    const rgba = nscodec(stream([y, z, z, null], 1, false, false), 4, 2);
    expect([...rgba.subarray(0, 4)]).toEqual([100, 100, 100, 255]);
  });

  test("YCoCg → RGB(色の削減 1 = ずらさない)。Co = 10 なら R が上がり B が下がる", () => {
    const y = new Uint8Array(2).fill(100);
    const co = new Uint8Array(2).fill(10);
    const cg = new Uint8Array(2).fill(0);
    const a = new Uint8Array(2).fill(128);
    const rgba = nscodec(stream([y, co, cg, a], 1, false, false), 2, 1);
    expect([...rgba.subarray(0, 4)]).toEqual([110, 100, 90, 128]);
  });

  test("色差は 8 ビットのままずらしてから符号付きに読む(色の削減 3 = 2 ビット)", () => {
    // 0x30 << 2 = 0xC0 → -64(符号付きにしてからずらすと +192 になってしまう)
    const y = Uint8Array.of(128);
    const co = Uint8Array.of(0x30);
    const cg = Uint8Array.of(0);
    const rgba = nscodec(stream([y, co, cg, null], 3, false, false), 1, 1);
    expect([...rgba.subarray(0, 3)]).toEqual([64, 128, 192]);
  });

  test("RLE と色差の間引き(Y の幅は 8 の倍数、Co / Cg は縦横半分)の往復", () => {
    const w = 5;
    const h = 3;
    const rw = 8;
    const rh = 4;
    const y = new Uint8Array(rw * h);
    for (let i = 0; i < y.length; i++) y[i] = 50 + (i % rw) * 10;
    const co = new Uint8Array((rw / 2) * (rh / 2)).fill(0);
    const cg = new Uint8Array((rw / 2) * (rh / 2));
    cg[0] = 4; // 左上の 2x2 だけ緑寄り
    const a = new Uint8Array(w * h).fill(255);
    for (const rle of [false, true]) {
      const rgba = nscodec(stream([y, co, cg, a], 1, true, rle), w, h);
      // (0,0) と (1,1) は Cg = 4 を共有、(2,0) は 0
      expect([...rgba.subarray(0, 3)]).toEqual([46, 54, 46]);
      const p11 = (1 * w + 1) * 4;
      expect([...rgba.subarray(p11, p11 + 3)]).toEqual([56, 64, 56]);
      const p20 = 2 * 4;
      expect([...rgba.subarray(p20, p20 + 3)]).toEqual([70, 70, 70]);
    }
  });

  test("RLE: 長い並び(0xFF + 4 バイトの長さ)と、最後の 4 バイトはそのまま", () => {
    const plane = new Uint8Array(400).fill(7);
    plane.set([1, 2, 3, 4], 396);
    expect([...nscRle(rleEncode(plane), plane.length)]).toEqual([...plane]);
  });

  test("不正な入力は例外", () => {
    expect(() => nscRle(Uint8Array.of(1, 1), 10)).toThrow("足りない");
    expect(() =>
      nscodec(
        stream(
          [Uint8Array.of(1), Uint8Array.of(0), Uint8Array.of(0), null],
          0,
          false,
          false,
        ),
        1,
        1,
      ),
    ).toThrow("色の削減");
  });

  test("Windows 11 の実データ(タスクバーの 124x24。色の削減・RLE あり)", () => {
    const data = Uint8Array.from(
      atob(
        "ogIAAAsAAAALAAAAAAAAAAMAAADg4Ebh5OQA5+zu7i36+kb48/Lq4+Ln7u4r+vpL9Oji6e7uKfr6TfTl5u7uKPr6T+nj7e7uJvr6UO3j7u4U+P//AP7+AP38+/r6Afn49/b2APXu+vpR6eXu7hP//wD+/fz7+wD6+gD5+Pf3APb19QD06vr6Uufo7u4S/v38/AD7+voA+fkA+Pf29fUB9PPp+vpS9eLu7hL9/Pv6+gH5+Pf29fUB9PPy8gDo+vpT6ufu7hH7+voB+fj39vYA9fUA9PPzAPLx8Of6+lP44u7uEOz6+gD5+Pf3APb19QD09ADz8vHw8AHm+vpU5evu7gqNRENDAEE+y8nJAMjHxsYBxcPC0/Hw8ADv7uX6+lTt5+7uCkRDQkE/O8nIx8cAxsYAxcPCwgHA8O/vAO7t4/r6VPPk7u4KQ0JBQD46x8cBxsXEw8LCAMDAAe/u7ezsAOL6+lT14+7uCkFBAD8+PTnHxsXFAMTCwgDBwMAAv73t7QDs6+sA4fr6VPjh7u4KQD49PQA8OMbFxMLCAcHAv769vQDs6+sB6uD6+lT44e7uCj49PDs6NsTDwsIAwcC/vwC+vby76+sA6uno3/r6VPXj7u4KPTw7Ojg0wsIAwcEAwL++vby8ALu66unpAOjn3fr6VPPk7u4KPDs5ODczwcEAwL++vgC9vLu7ALm5AOno5+bmAN36+lTt5+7uCjo4OAA3NTG8v76+AL28u7sAurm5ALjn5uYC2/r6VOXr7u4KODc2NDQAMY2wr66uAqyrqqoAqdTUA976+lP44u7uCzc1NDMyLy4tKyopKCYlJCQBIu7uBPr6U+rn7u4LNTQzMTAvLSsqKgAoJyYlJCQAIiDu7gT6+lL14u7uDDMzADEwLy0sKyooJycAJiUjIiEg7u4A7u7u7gAA/5wLAAAAAAAAAAD/nAsAAAAAAAA=",
      ),
      (c) => c.charCodeAt(0),
    );
    const rgba = nscodec(data, 124, 24);
    let light = 0;
    let dark = 0;
    for (let i = 0; i < 124 * 24; i++) {
      const v =
        ((rgba[i * 4] as number) +
          (rgba[i * 4 + 1] as number) +
          (rgba[i * 4 + 2] as number)) /
        3;
      if (v > 200) light++;
      if (v < 120) dark++;
    }
    // タスクバーの明るい地に、アイコンの暗い画素が少しある
    expect(light).toBeGreaterThan(124 * 24 * 0.5);
    expect(dark).toBeGreaterThan(0);
  });
});
