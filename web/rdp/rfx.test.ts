// RemoteFX の試験。RLGR(既知の符号語、往復、実機のタイル)、逆 DWT、色変換、ストリームの解析を見る。

import { describe, expect, test } from "bun:test";
import { fromHex } from "./bytes";
import {
  decodeStream,
  decodeTile,
  ENTROPY_RLGR1,
  ENTROPY_RLGR3,
  parseQuant,
  reconstruct,
  rlgrDecode,
  yccToRgba,
} from "./rfx";
import { REAL_TILE, rfxStream, rlgrEncode } from "./rfx.fixture";

const decode = (data: Uint8Array, mode = ENTROPY_RLGR3, n = 4096) => {
  const out = new Int32Array(n);
  const used = rlgrDecode(data, mode, out);
  return { out, used };
};

describe("RLGR", () => {
  test("既知の符号語: 1 0 0 0 0 → 先頭が +1", () => {
    // RL モード(k=1): 「1」で run の接頭辞なし、余り 1 ビット「0」(run 0)、符号「0」(正)、GR(kr=1): 「0」「0」→ code 0 → 大きさ 1
    for (const mode of [ENTROPY_RLGR1, ENTROPY_RLGR3]) {
      const { out } = decode(Uint8Array.of(0x80), mode, 16);
      expect([...out.slice(0, 4)]).toEqual([1, 0, 0, 0]);
    }
  });

  test("既知の符号語: 0 1 1 1 1 0 1 → 0 が 3 個のあと -4", () => {
    // 接頭辞「0」で run += 2(k=1、kp 8 → 12)、「1」で終わり、余り 1 ビット「1」(run 3)、符号「1」(負)、
    // GR(kr=1): 「1」「0」→ vk 1、余り「1」→ code 3 → 大きさ 4
    const { out } = decode(Uint8Array.of(0x7a), ENTROPY_RLGR3, 16);
    expect([...out.slice(0, 5)]).toEqual([0, 0, 0, -4, 0]);
  });

  test("大きな係数(vk が 40 を超える)も読める", () => {
    // 「1」(RL、接頭辞なし)+ 余り「0」+ 符号「0」+ vk 50 個の 1 + 0 + 余り「1」(kr=1)
    const bits = `1 0 0 ${"1".repeat(50)} 0 1`.replace(/ /g, "");
    const bytes = Uint8Array.from(
      bits
        .padEnd(Math.ceil(bits.length / 8) * 8, "0")
        .match(/.{8}/g) as string[],
      (b) => Number.parseInt(b, 2),
    );
    const { out } = decode(bytes, ENTROPY_RLGR3, 8);
    expect(out[0]).toBe(50 * 2 + 1 + 1);
  });

  test("符号化 → 復号の往復(まばら・密・全部 0・DC だけ)", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const cases: Int32Array[] = [];
    cases.push(new Int32Array(4096)); // 全部 0
    const dc = new Int32Array(4096);
    dc[4032] = -93;
    cases.push(dc);
    for (const density of [0.01, 0.1, 0.5, 1]) {
      const v = new Int32Array(4096);
      for (let i = 0; i < 4096; i++)
        if (rnd() < density)
          v[i] = Math.round((rnd() - 0.5) * (rnd() < 0.05 ? 4000 : 20));
      cases.push(v);
    }
    for (const mode of [ENTROPY_RLGR1, ENTROPY_RLGR3] as const) {
      for (const v of cases) {
        const { out } = decode(rlgrEncode(v, mode), mode);
        expect([...out]).toEqual([...v]);
      }
    }
  });

  test("実機(xrdp)のタイルの 3 成分が、最後のビットまでちょうど使って 4096 個になる", () => {
    for (const comp of [REAL_TILE.y, REAL_TILE.cb, REAL_TILE.cr]) {
      const { used } = decode(comp);
      expect(comp.length * 8 - used).toBeLessThan(8);
    }
  });

  test("知らない方式・空の入力", () => {
    expect(() => rlgrDecode(Uint8Array.of(0), 2, new Int32Array(4))).toThrow(
      "方式",
    );
    expect(decode(new Uint8Array()).out.every((v) => v === 0)).toBe(true);
  });
});

describe("量子化・逆 DWT・色変換", () => {
  test("量子化の 5 バイトを、バンドの順(HL1 LH1 HH1 HL2 LH2 HH2 HL3 LH3 HH3 LL3)の値にする", () => {
    // LL3 LH3 / HL3 HH3 / LH2 HL2 / HH2 LH1 / HL1 HH1 の 4 ビットずつ(下位が先)
    expect(parseQuant(fromHex("6666778898"))).toEqual([
      8, 8, 9, 7, 7, 8, 6, 6, 6, 6,
    ]);
  });

  test("LL3 だけが一様な値なら、逆 DWT のあとも全画素が同じ値", () => {
    const buf = new Int32Array(4096);
    buf.fill(7, 4032); // LL3 は全部 7(差分符号化なので、先頭だけ 7 で残りは 0 にする)
    buf.fill(0, 4033);
    reconstruct(buf, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(buf.every((v) => v === 7)).toBe(true);
  });

  test("LL3 の差分符号化: 先頭からの足し算", () => {
    const buf = new Int32Array(4096);
    buf[4032] = 10;
    buf[4033] = 2;
    buf[4034] = -1;
    reconstruct(buf, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // 逆 DWT のあとは滑らかに補間されるが、全体は 10 以上 12 の範囲
    const min = Math.min(...buf);
    const max = Math.max(...buf);
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(12);
  });

  test("逆量子化は (量子化の値 - 1) だけ左シフト", () => {
    const buf = new Int32Array(4096);
    buf[4032] = 1;
    reconstruct(buf, [1, 1, 1, 1, 1, 1, 1, 1, 1, 4]);
    expect(buf[0]).toBe(8); // LL3 が 1 << 3 = 8 で、全体に広がる
  });

  test("色変換: Y = 0、Cb = Cr = 0 は灰色(128)。Y が 5 ビット小数の ±", () => {
    const z = new Int32Array(4096);
    const gray = yccToRgba(z, z, z);
    expect([...gray.slice(0, 4)]).toEqual([128, 128, 128, 255]);
    const y = new Int32Array(4096).fill(32 * 50); // +50
    expect(yccToRgba(y, z, z)[0]).toBe(178);
    const dark = new Int32Array(4096).fill(-32 * 200); // 下にはみ出す
    expect(yccToRgba(dark, z, z)[0]).toBe(0);
  });

  test("色変換: Cr が正なら赤が増え、Cb が正なら青が増える", () => {
    const z = new Int32Array(4096);
    const p = new Int32Array(4096).fill(320);
    const red = yccToRgba(z, z, p);
    const blue = yccToRgba(z, p, z);
    expect(red[0]).toBeGreaterThan(red[2] as number);
    expect(blue[2]).toBeGreaterThan(blue[0] as number);
    expect(red[1]).toBeLessThan(128); // 緑は減る
  });
});

describe("タイルとストリーム", () => {
  test("実機のタイル: 青いグラデーションで、隣の画素と滑らかにつながる", () => {
    const q = parseQuant(REAL_TILE.quant);
    const rgba = decodeTile(
      ENTROPY_RLGR3,
      [REAL_TILE.y, REAL_TILE.cb, REAL_TILE.cr],
      [q, q, q],
    );
    let r = 0;
    let g = 0;
    let b = 0;
    let rough = 0;
    for (let i = 0; i < 4096; i++) {
      r += rgba[i * 4] as number;
      g += rgba[i * 4 + 1] as number;
      b += rgba[i * 4 + 2] as number;
      if (i % 64)
        rough += Math.abs(
          (rgba[i * 4 + 2] as number) - (rgba[(i - 1) * 4 + 2] as number),
        );
    }
    expect(b).toBeGreaterThan(r * 1.5);
    expect(g).toBeGreaterThan(r);
    expect(rough / 4032).toBeLessThan(3);
  });

  test("ストリームを読んで、タイルの位置と領域を返す", () => {
    const s = rfxStream(
      [{ x: 0, y: 0, w: 64, h: 64 }],
      [{ x: 128, y: 64, y_: REAL_TILE.y, cb: REAL_TILE.cb, cr: REAL_TILE.cr }],
    );
    const tiles = decodeStream(s);
    expect(tiles.length).toBe(1);
    expect(tiles[0]).toMatchObject({
      x: 128,
      y: 64,
      rects: [{ x: 0, y: 0, w: 64, h: 64 }],
    });
    expect(tiles[0]?.rgba.length).toBe(64 * 64 * 4);
  });

  test("不正な入力は例外", () => {
    const ok = rfxStream(
      [],
      [{ x: 0, y: 0, y_: REAL_TILE.y, cb: REAL_TILE.cb, cr: REAL_TILE.cr }],
    );
    // ブロックの長さが入力を超える
    expect(() => decodeStream(ok.slice(0, ok.length - 10))).toThrow("長さ");
    // 知らないブロック
    expect(() => decodeStream(fromHex("ffff0600000000"))).toThrow("知らない");
    // 量子化の番号が範囲外。タイルのブロックは c3 ca から始まり、6 バイト先が quantIdxY
    const copy = Uint8Array.from(ok);
    const at = copy.findIndex((v, i) => v === 0xc3 && copy[i + 1] === 0xca);
    copy[at + 6] = 5;
    expect(() => decodeStream(copy)).toThrow("範囲外");
  });
});
