// ポインタの復号と、セッションのループ(偽の通信路で)の試験。

import { describe, expect, test } from "bun:test";
import { concat, fromHex, Reader, Writer } from "./bytes";
import { RdpClient, type Screen } from "./client";
import type { Session } from "./connect";
import { UPDATE } from "./fastpath";
import * as mcs from "./mcs";
import * as pdu from "./pdu";
import * as pointer from "./pointer";
import { REAL_TILE, rfxStream, rlgrEncode } from "./rfx.fixture";
import { type DecodeJob, decodeJob, type TilePool } from "./rfxpool";
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
		channelOptions: new Map([["drdynvc", 0xc0800000]]),
		shareId: 0x103ea,
		serverCapabilities: new Map(),
		keyboardLayout: 0x0411,
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
		// ビットマップの復号は後回し(吐き出しのとき)なので、ポインタの変更が先に出る
		expect(screen.events).toEqual([
			"resize 64x48",
			"cursor none",
			"draw 10,20 1x1",
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

describe("メッセージ チャネル(回線の自動検出)", () => {
	test("RTT の要求に同じチャネルで答え、知らせてきた回線の様子を覚える", async () => {
		const ind = (data: Uint8Array) =>
			x224.data(
				mcs
					.sendDataRequest(1002, 1008, data)
					.map((b, i) => (i === 0 ? 0x68 : b)),
			);
		const rtt = fromHex("00100000" + "060007000110");
		const netchar = new Writer()
			.bytes(fromHex("00100000" + "06000800c008"))
			.u32(3)
			.u32(80000)
			.u32(5)
			.done();
		const stream = scripted([ind(rtt), ind(netchar)]);
		const client = new RdpClient(
			{ ...fakeSession(stream), messageChannelId: 1008 },
			new Recorder(),
		);
		await client.run();
		// Input 同期のあとに、RTT Measure Response(Share Control としては読まない)
		expect(stream.written.length).toBe(2);
		expect(stream.written[1]).toEqual(
			x224.data(
				mcs.sendDataRequest(1007, 1008, fromHex("00200000" + "060107000000")),
			),
		);
		expect(client.network).toEqual({
			info: { baseRtt: 3, bandwidth: 80000, averageRtt: 5 },
			answered: { rtt: 1, bandwidth: 0 },
		});
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

describe("RemoteFX の間引きと Frame Acknowledge", () => {
	/** Fast-Path の PDU(ヘッダー 1 + 長さ 1〜2 + 更新)。127 バイトを超える長さは 2 バイト */
	const fastPdu = (update: Uint8Array) =>
		update.length + 2 < 0x80
			? concat(Uint8Array.of(0, update.length + 2), update)
			: concat(
					Uint8Array.of(
						0,
						0x80 | ((update.length + 3) >> 8),
						(update.length + 3) & 0xff,
					),
					update,
				);
	const RFX_ID = 3;
	const rfxTile = (x: number, y: number) => ({
		x,
		y,
		y_: REAL_TILE.y,
		cb: REAL_TILE.cb,
		cr: REAL_TILE.cr,
	});
	const zero = rlgrEncode(new Int32Array(4096), 4);
	const dcTile = (x: number, y: number, v: number) => {
		const yv = new Int32Array(4096);
		yv[4032] = v;
		return { x, y, y_: rlgrEncode(yv, 4), cb: zero, cr: zero };
	};
	const full = [{ x: 0, y: 0, w: 64, h: 64 }];
	const bits = (
		cmd: number,
		dest: number[],
		codec: number,
		w: number,
		h: number,
		data: Uint8Array,
	) =>
		new Writer(32 + data.length)
			.u16(cmd)
			.u16(dest[0] as number)
			.u16(dest[1] as number)
			.u16(dest[2] as number)
			.u16(dest[3] as number)
			.u8(32)
			.u8(0)
			.u8(0)
			.u8(codec)
			.u16(w)
			.u16(h)
			.u32(data.length)
			.bytes(data)
			.done();
	const marker = (action: number, id: number) =>
		new Writer(8).u16(4).u16(action).u32(id).done();
	const surfCmds = (...cmds: Uint8Array[]) => {
		const data = concat(...cmds);
		const update = new Writer()
			.u8(UPDATE.SURFCMDS)
			.u16(data.length)
			.bytes(data)
			.done();
		return fastPdu(update);
	};
	const rfxAt = (tiles: ReturnType<typeof rfxTile>[]) =>
		bits(0x0006, [0, 0, 64, 64], RFX_ID, 64, 64, rfxStream(full, tiles));

	/** Send Data Request(クライアント → サーバー)から Frame Acknowledge の frameId を取り出す */
	function ackId(written: Uint8Array): number | undefined {
		if (written[0] !== 3) return undefined; // Fast-Path Input など
		const data = written.subarray(7); // TPKT(4)+ X.224 Data(3)
		const r = new Reader(data);
		r.u8(); // 0x64
		r.skip(4); // initiator, channelId
		r.u8(); // priority / segmentation
		const len = r.u8();
		if (len & 0x80) r.u8(); // 長さは 2 バイト
		const body = r.rest();
		const sc = pdu.parseShareControl(body);
		const sd = pdu.parseShareData(sc.body);
		return sd.type2 === pdu.PDUTYPE2.FRAME_ACKNOWLEDGE
			? new Reader(sd.payload).u32()
			: undefined;
	}

	test("同じ位置のタイルは最新だけを描き、全フレームに応答を返す(描いたあとで)", async () => {
		const a = surfCmds(marker(0, 1), rfxAt([rfxTile(0, 0)]), marker(1, 1));
		const b = surfCmds(marker(0, 2), rfxAt([dcTile(0, 0, 300)]), marker(1, 2));
		const c = surfCmds(marker(0, 3), rfxAt([dcTile(0, 0, -300)]), marker(1, 3));
		const screen = new Recorder();
		const stream = scripted([a, b, c]);
		const client = new RdpClient(fakeSession(stream), screen);
		await client.run();
		expect(screen.events).toEqual(["resize 64x48", "draw 0,0 64x48"]);
		expect(client.decodeStats).toEqual({ coalesced: 2, skipped: 0 });
		const acks = stream.written.map(ackId).filter((x) => x !== undefined);
		expect(acks).toEqual([1, 2, 3]);
	});

	test("旧ビットマップとタイルが混ざっても受けた順に描く(後のタイルに覆われた前のタイルは描かない)", async () => {
		const bitmap = new Writer()
			.u16(1)
			.u16(1)
			.u16(30)
			.u16(30)
			.u16(30)
			.u16(30)
			.u16(1)
			.u16(1)
			.u16(16)
			.u16(0)
			.u16(2)
			.bytes(fromHex("00f8"))
			.done();
		const legacy = new Writer().u8(1).u16(bitmap.length).bytes(bitmap).done();
		const legacyPdu = fastPdu(legacy);
		const screen = new Recorder();
		const stream = scripted([
			surfCmds(rfxAt([rfxTile(0, 0)])),
			legacyPdu,
			surfCmds(rfxAt([dcTile(0, 0, 300)])),
		]);
		await new RdpClient(fakeSession(stream), screen).run();
		expect(screen.events).toEqual([
			"resize 64x48",
			"draw 30,30 1x1",
			"draw 0,0 64x48",
		]);
	});

	test("切れたときに、溜めたタイルを描いてから終わる", async () => {
		const screen = new Recorder();
		const stream = scripted([surfCmds(rfxAt([rfxTile(0, 0)]), marker(1, 5))]);
		const reason = await new RdpClient(fakeSession(stream), screen).run();
		expect(reason).toContain("connection closed");
		expect(screen.events).toContain("draw 0,0 64x48");
		expect(stream.written.map(ackId).filter((x) => x !== undefined)).toEqual([
			5,
		]);
	});
});

describe("非同期のプールでの順序", () => {
	test("旧ビットマップは、復号中のタイルが描き終わってから描く", async () => {
		const done: (() => void)[] = [];
		const pool = {
			async: true,
			run: (job: DecodeJob) =>
				new Promise<Uint8ClampedArray>((resolve) =>
					done.push(() => resolve(decodeJob(job))),
				),
			terminate() {},
		} satisfies TilePool;
		const full = [{ x: 0, y: 0, w: 64, h: 64 }];
		const surf = (data: Uint8Array) => {
			const u = new Writer().u8(4).u16(data.length).bytes(data).done();
			const len = u.length + 3;
			return concat(Uint8Array.of(0, 0x80 | (len >> 8), len & 0xff), u);
		};
		const cmds = concat(
			new Writer(8).u16(4).u16(0).u32(7).done(),
			new Writer(32 + 0)
				.u16(0x0006)
				.u16(0)
				.u16(0)
				.u16(64)
				.u16(64)
				.u8(32)
				.u8(0)
				.u8(0)
				.u8(3)
				.u16(64)
				.u16(64)
				.u32(
					rfxStream(full, [
						{ x: 0, y: 0, y_: REAL_TILE.y, cb: REAL_TILE.cb, cr: REAL_TILE.cr },
					]).length,
				)
				.bytes(
					rfxStream(full, [
						{ x: 0, y: 0, y_: REAL_TILE.y, cb: REAL_TILE.cb, cr: REAL_TILE.cr },
					]),
				)
				.done(),
			new Writer(8).u16(4).u16(1).u32(7).done(),
		);
		const events: string[] = [];
		const screen: Screen = {
			resize: () => events.push("resize"),
			draw: (x, y, w, h) => events.push(`draw ${x},${y} ${w}x${h}`),
			setCursor() {},
		};
		const stream = scripted([surf(cmds)]);
		const client = new RdpClient(fakeSession(stream), screen, { pool });
		const ended = client.run();
		const settle = () => new Promise((r) => setTimeout(r, 20));
		await settle();
		// 通信が閉じて run は終わっても、タイルはまだ復号中なので、何も描いていない
		expect(events.filter((e) => e.startsWith("draw"))).toEqual([]);
		expect(stream.written.length).toBe(1); // Input の同期だけ。Frame Acknowledge はまだ
		for (const f of done) f();
		await ended;
		await settle();
		expect(events.filter((e) => e.startsWith("draw"))).toEqual([
			"draw 0,0 64x48",
		]);
		// 描いたあとに、Frame Acknowledge を返した
		expect(stream.written.length).toBe(2);
	});
});
