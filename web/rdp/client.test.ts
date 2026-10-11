// ポインタの復号と、セッションのループ(偽の通信路で)の試験。

import { describe, expect, test } from "bun:test";
import { concat, fromHex, Writer } from "./bytes";
import { RdpClient, type Screen } from "./client";
import type { Session } from "./connect";
import * as mcs from "./mcs";
import * as pdu from "./pdu";
import * as pointer from "./pointer";
import { StreamClosed, type Transport } from "./stream";
import * as x224 from "./x224";

describe("ポインタ", () => {
	test("24bpp: 下の行から、BGR、AND マスクが 1 で黒は透明", () => {
		const body = new Writer()
			.u16(24) // xorBpp
			.u16(3) // cacheIndex
			.u16(1)
			.u16(0) // hotspot
			.u16(2)
			.u16(2) // 2x2
			.u16(4) // andMask 長(1 行 2 バイト x 2)
			.u16(12) // xorMask 長(1 行 6 バイト x 2)
			// XOR: 下の行(赤・黒)、上の行(緑・青)。BGR
			.bytes(fromHex("0000ff" + "000000"))
			.bytes(fromHex("00ff00" + "ff0000"))
			// AND: 下の行 = 0b01xxxxxx(2 画素目が透明)、上の行 = 0
			.bytes(fromHex("4000" + "0000"))
			.done();
		const { index, cursor } = pointer.parseNewPointer(body);
		expect(index).toBe(3);
		expect([cursor.width, cursor.height, cursor.hotX, cursor.hotY]).toEqual([
			2, 2, 1, 0,
		]);
		// 上の行: 緑、青
		expect([...cursor.rgba.subarray(0, 8)]).toEqual([
			0, 255, 0, 255, 0, 0, 255, 255,
		]);
		// 下の行: 赤、(黒 + AND = 透明)
		expect([...cursor.rgba.subarray(8, 16)]).toEqual([
			255, 0, 0, 255, 0, 0, 0, 0,
		]);
	});

	test("32bpp はアルファを使う", () => {
		const body = new Writer()
			.u16(32)
			.u16(0)
			.u16(0)
			.u16(0)
			.u16(1)
			.u16(1)
			.u16(2)
			.u16(4)
			.bytes(fromHex("11223380"))
			.bytes(fromHex("0000"))
			.done();
		expect([...pointer.parseNewPointer(body).cursor.rgba]).toEqual([
			0x33, 0x22, 0x11, 0x80,
		]);
	});

	test("大きすぎるポインタは例外", () => {
		const body = new Writer()
			.u16(32)
			.u16(0)
			.u16(0)
			.u16(0)
			.u16(5000)
			.u16(5000)
			.u16(0)
			.u16(0)
			.done();
		expect(() => pointer.parseNewPointer(body)).toThrow("大きすぎる");
	});
});

/** 溜めたものを順に返し、尽きたら閉じる通信路 */
function scripted(pdus: Uint8Array[]): Transport & { written: Uint8Array[] } {
	let buf = concat(...pdus);
	const written: Uint8Array[] = [];
	return {
		written,
		async peek(n) {
			if (buf.length < n) throw new StreamClosed("connection closed (1006)");
			return buf.subarray(0, n);
		},
		async read(n) {
			if (buf.length < n) throw new StreamClosed("connection closed (1006)");
			const o = buf.subarray(0, n);
			buf = buf.subarray(n);
			return o;
		},
		write(b) {
			written.push(b);
		},
		close() {},
	};
}

function fakeSession(stream: Transport): Session {
	return {
		stream,
		userId: 1007,
		ioChannelId: 1003,
		channels: new Map([["drdynvc", 1004]]),
		shareId: 0x103ea,
		serverCapabilities: new Map(),
		width: 64,
		height: 48,
		pending: [],
		pendingChannel: [],
	};
}

class Recorder implements Screen {
	events: string[] = [];
	resize(w: number, h: number) {
		this.events.push(`resize ${w}x${h}`);
	}
	draw(x: number, y: number, w: number, h: number) {
		this.events.push(`draw ${x},${y} ${w}x${h}`);
	}
	setCursor(c: unknown) {
		this.events.push(
			`cursor ${c === null ? "none" : typeof c === "string" ? c : "shape"}`,
		);
	}
}

describe("RdpClient", () => {
	test("Fast-Path のビットマップと PTR_NULL を画面へ流し、通信が閉じたら理由を返す", async () => {
		// 2x1 の 16bpp ビットマップ(生)、矩形の右端は幅より 1 小さい(幅が揃えられている)
		const bitmap = new Writer()
			.u16(1)
			.u16(1)
			.u16(10)
			.u16(20)
			.u16(10)
			.u16(20)
			.u16(2)
			.u16(1)
			.u16(16)
			.u16(0)
			.u16(4)
			.bytes(fromHex("00f8" + "e007"))
			.done();
		const update = (code: number, data: Uint8Array) =>
			new Writer().u8(code).u16(data.length).bytes(data).done();
		const body = concat(update(1, bitmap), update(5, new Uint8Array()));
		const fast = concat(Uint8Array.of(0, body.length + 2), body);
		const screen = new Recorder();
		const stream = scripted([fast]);
		const reason = await new RdpClient(fakeSession(stream), screen).run();
		expect(reason).toContain("connection closed");
		expect(screen.events).toEqual([
			"resize 64x48",
			"draw 10,20 1x1",
			"cursor none",
		]);
		// つないだ直後に Input の同期を送る
		expect(stream.written[0]?.[0]).toBe(1 << 2);
	});

	test("Slow-Path: SET_ERROR_INFO で切られた理由を返す", async () => {
		const err = pdu.shareData(
			1002,
			0x103ea,
			pdu.PDUTYPE2.SET_ERROR_INFO,
			new Writer(4).u32(0x1).done(),
		);
		const slow = x224.data(
			mcs.sendDataRequest(1002, 1003, err).map((b, i) => (i === 0 ? 0x68 : b)),
		);
		const reason = await new RdpClient(
			fakeSession(scripted([slow])),
			new Recorder(),
		).run();
		expect(reason).toContain("ErrorInfo 0x1");
	});

	test("Demand Active が再び来たら、Confirm Active と同期を返して画面の大きさを変える", async () => {
		const bitmapCap = new Writer()
			.u16(2)
			.u16(28)
			.u16(16)
			.u16(1)
			.u16(1)
			.u16(1)
			.u16(800) // desktopWidth
			.u16(600)
			.zeros(12)
			.done();
		const demand = pdu.shareControl(
			pdu.PDUTYPE.DEMAND_ACTIVE,
			1002,
			concat(
				new Writer()
					.u32(0x2002)
					.u16(4)
					.u16(32)
					.bytes(new Uint8Array(4))
					.u16(1)
					.u16(0)
					.done(),
				bitmapCap,
				new Uint8Array(4),
			),
		);
		const slow = x224.data(
			mcs
				.sendDataRequest(1002, 1003, demand)
				.map((b, i) => (i === 0 ? 0x68 : b)),
		);
		const screen = new Recorder();
		const stream = scripted([slow]);
		await new RdpClient(fakeSession(stream), screen).run();
		expect(screen.events).toEqual(["resize 64x48", "resize 800x600"]);
		// Input 同期 + Confirm Active + Synchronize + Control x2 + Font List
		expect(stream.written.length).toBe(1 + 5);
	});
});

describe("壊れたポインタ", () => {
	test("セッションは続けて、既定のカーソルにする", async () => {
		// 大きすぎる新しいポインタ(Fast-Path の 0xB)
		const bad = new Writer()
			.u16(32)
			.u16(0)
			.u16(0)
			.u16(0)
			.u16(5000)
			.u16(5000)
			.u16(0)
			.u16(0)
			.done();
		const update = new Writer().u8(0xb).u16(bad.length).bytes(bad).done();
		const fast = concat(Uint8Array.of(0, update.length + 2), update);
		const screen = new Recorder();
		const reason = await new RdpClient(
			fakeSession(scripted([fast])),
			screen,
		).run();
		expect(reason).toContain("connection closed");
		expect(screen.events).toEqual(["resize 64x48", "cursor default"]);
	});
});
