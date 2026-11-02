import { describe, expect, test } from "bun:test";

import { cp437, SerialText } from "./serial-text";

const bytes = (...b: number[]) => Uint8Array.from(b);

describe("SerialText", () => {
  test("ASCII はそのまま", () => {
    expect(new SerialText().decode(new TextEncoder().encode("Talos\r\n"))).toBe(
      "Talos\r\n",
    );
  });

  test("3〜4 バイトの UTF-8 は UTF-8 として読む", () => {
    expect(
      new SerialText().decode(new TextEncoder().encode("電源 ✓ ─┐ 🙂")),
    ).toBe("電源 ✓ ─┐ 🙂");
  });

  test("BIOS の罫線(CP437)は罫線にする", () => {
    // ┌──┐ / │ │ / ═
    expect(
      new SerialText().decode(bytes(0xda, 0xc4, 0xc4, 0xbf, 0xb3, 0x20, 0xcd)),
    ).toBe("┌──┐│ ═");
    // ╔══╗ / ╚══╝ (═╗ と ═╝ は UTF-8 の 2 バイトの並びと同じ形)
    expect(
      new SerialText().decode(
        bytes(0xc9, 0xcd, 0xcd, 0xbb, 0xc8, 0xcd, 0xcd, 0xbc),
      ),
    ).toBe("╔══╗╚══╝");
    expect(new SerialText().decode(bytes(0xb0, 0xb1, 0xb2, 0xdb))).toBe("░▒▓█");
  });

  test("2 バイトの UTF-8 は CP437 として読む(罫線と区別できないため)", () => {
    expect(new SerialText().decode(bytes(0xc3, 0xbc))).toBe("├╝");
  });

  test("表の両端", () => {
    expect(cp437(0x80)).toBe("Ç");
    expect(cp437(0xff)).toBe(" ");
  });

  test("塊の境目で切れた UTF-8 は続きを待つ", () => {
    const s = new SerialText();
    const e = new TextEncoder().encode("あい");
    expect(s.decode(e.subarray(0, 2))).toBe("");
    expect(s.waiting).toBe(true);
    expect(s.decode(e.subarray(2))).toBe("あい");
    expect(s.waiting).toBe(false);
  });

  test("続きが来なければ flush で CP437 として出す", () => {
    const s = new SerialText();
    expect(s.decode(bytes(0x41, 0xe2))).toBe("A");
    expect(s.flush()).toBe("Γ");
  });

  test("続きが UTF-8 の続きでなければ CP437", () => {
    const s = new SerialText();
    expect(s.decode(bytes(0xe2))).toBe("");
    expect(s.decode(bytes(0xcd, 0x41))).toBe("Γ═A");
  });

  test("長すぎる符号(0xE0 0x80 0x80)は CP437", () => {
    expect(new SerialText().decode(bytes(0xe0, 0x80, 0x80))).toBe("αÇÇ");
  });
});
