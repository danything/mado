// 表示 → RDP 座標の変換と fit の試験(DOM を使わない部分)。

import { describe, expect, test } from "bun:test";
import { fitSize, toRdpPoint } from "./display";

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
