// 入力の符号化の試験。

import { describe, expect, test } from "bun:test";
import { hex } from "./bytes";
import * as input from "./input";

describe("キーボード", () => {
	test("押す・離す", () => {
		expect(hex(input.keyEvent("KeyA", true) ?? new Uint8Array())).toBe("001e");
		expect(hex(input.keyEvent("KeyA", false) ?? new Uint8Array())).toBe("201e");
	});
	test("拡張キーは E0 の印が付く", () => {
		expect(hex(input.keyEvent("ArrowUp", true) ?? new Uint8Array())).toBe(
			"4048",
		);
		expect(hex(input.keyEvent("ControlRight", false) ?? new Uint8Array())).toBe(
			"601d",
		);
	});
	test("知らないキーは undefined", () => {
		expect(input.keyEvent("Unidentified", true)).toBeUndefined();
	});
	test("Unicode", () => {
		expect(hex(input.unicodeEvent(0x3042, true))).toBe("044230");
		expect(hex(input.unicodeEvent(0x3042, false))).toBe("244230");
	});
	test("物理キーが重ならない(スキャンコード + 拡張で一意)", () => {
		const seen = new Set<string>();
		for (const code of [
			"Escape",
			"KeyA",
			"KeyZ",
			"Digit0",
			"Enter",
			"NumpadEnter",
			"ControlLeft",
			"ControlRight",
			"AltLeft",
			"AltRight",
			"Home",
			"Numpad7",
			"ArrowUp",
			"Numpad8",
			"Delete",
			"NumpadDecimal",
			"PageUp",
			"Numpad9",
			"MetaLeft",
			"IntlYen",
		]) {
			const s = input.scancode(code);
			expect(s).toBeDefined();
			const k = `${s?.[0]}/${s?.[1]}`;
			expect(seen.has(k)).toBe(false);
			seen.add(k);
		}
	});
});

describe("マウス", () => {
	test("移動", () => {
		expect(hex(input.mouseMove(100, 200))).toBe(
			"20" + "0008" + "6400" + "c800",
		);
	});
	test("ボタン(左・中・右)", () => {
		expect(hex(input.mouseButton(0, true, 1, 2) ?? new Uint8Array())).toBe(
			"20" + "0090" + "0100" + "0200",
		);
		expect(hex(input.mouseButton(2, false, 1, 2) ?? new Uint8Array())).toBe(
			"20" + "0020" + "0100" + "0200",
		);
		expect(hex(input.mouseButton(1, true, 1, 2) ?? new Uint8Array())).toBe(
			"20" + "00c0" + "0100" + "0200",
		);
	});
	test("戻る・進む", () => {
		expect(hex(input.mouseButton(3, true, 5, 6) ?? new Uint8Array())).toBe(
			"40" + "0180" + "0500" + "0600",
		);
	});
	test("ホイール: 下へ回すと負", () => {
		expect(hex(input.mouseWheel(100))).toBe("20" + "8803" + "0000" + "0000");
		expect(hex(input.mouseWheel(-100))).toBe("20" + "7802" + "0000" + "0000");
	});
	test("座標は 0〜65535 に収める", () => {
		expect(hex(input.mouseMove(-5, 70000))).toBe(
			"20" + "0008" + "0000" + "ffff",
		);
	});
});

describe("Fast-Path Input", () => {
	test("1 イベント", () => {
		const pdu = input.fastPathInput([
			input.keyEvent("KeyA", true) as Uint8Array,
		]);
		expect(hex(pdu)).toBe("04" + "04" + "001e");
	});
	test("複数イベントと長さ", () => {
		const ev = input.mouseMove(1, 1);
		const pdu = input.fastPathInput([ev, ev, ev]);
		expect(pdu[0]).toBe(3 << 2);
		expect(pdu[1]).toBe(pdu.length);
	});
	test("長い PDU は 2 バイトの長さ", () => {
		const ev = input.mouseMove(1, 1);
		const pdu = input.fastPathInput(Array.from({ length: 15 }, () => ev));
		// 2 + 105 = 107 < 128 なので 1 バイト
		expect(pdu[1]).toBe(107);
		const unicode = input.unicodeEvent(0x41, true);
		expect(input.fastPathInput([unicode]).length).toBe(1 + 1 + 3);
	});
	test("0 個・16 個以上は例外", () => {
		expect(() => input.fastPathInput([])).toThrow();
		expect(() =>
			input.fastPathInput(Array.from({ length: 16 }, () => input.syncEvent())),
		).toThrow();
	});
});
