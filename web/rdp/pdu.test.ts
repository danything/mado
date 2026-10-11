// 接続の PDU と TSRequest の試験。Share Data の並びは、実際のクライアントが送る Synchronize / Control / Font List と同じ。

import { describe, expect, test } from "bun:test";
import { concat, fromHex, hex } from "./bytes";
import { parseTsRequest, writeTsRequest } from "./credssp";
import * as pdu from "./pdu";

describe("Share Data", () => {
	const user = 1007;
	const share = 0x103ea;

	test("Synchronize", () => {
		expect(
			hex(
				pdu.shareData(
					user,
					share,
					pdu.PDUTYPE2.SYNCHRONIZE,
					pdu.synchronize(1002),
				),
			),
		).toBe("16001700ef03ea030100000108001f0000000100ea03");
	});

	test("Control(Cooperate)", () => {
		expect(
			hex(
				pdu.shareData(
					user,
					share,
					pdu.PDUTYPE2.CONTROL,
					pdu.control(pdu.CONTROL.COOPERATE),
				),
			),
		).toBe("1a001700ef03ea0301000001" + "0c001400000004000000000000" + "00");
	});

	test("Font List", () => {
		expect(
			hex(pdu.shareData(user, share, pdu.PDUTYPE2.FONTLIST, pdu.fontList())),
		).toBe("1a001700ef03ea03010000010c0027000000000000000300" + "3200");
	});

	test("読み戻し", () => {
		const raw = pdu.shareData(
			user,
			share,
			pdu.PDUTYPE2.CONTROL,
			pdu.control(pdu.CONTROL.GRANTED, 1007, 1002),
		);
		const sc = pdu.parseShareControl(raw);
		expect(sc.type).toBe(pdu.PDUTYPE.DATA);
		expect(sc.source).toBe(user);
		const sd = pdu.parseShareData(sc.body);
		expect(sd.type2).toBe(pdu.PDUTYPE2.CONTROL);
		expect(hex(sd.payload)).toBe("0200ef03ea030000");
	});
});

describe("Client Info", () => {
	test("欄の長さ(NUL を含まない)", () => {
		const b = pdu.clientInfo({ domain: "D", user: "alice", password: "pw" });
		const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
		expect([8, 10, 12, 14, 16].map((o) => dv.getUint16(o, true))).toEqual([
			2, 10, 4, 0, 0,
		]);
		// 本文 = 固定 18 + 文字列(NUL 付き)+ 拡張情報
		const strings = 4 + 12 + 6 + 2 + 2;
		const extended = 2 + 2 + 20 + 2 + 2 + 172 + 4 + 4 + 2;
		expect(b.length).toBe(18 + strings + extended);
	});
});

describe("Demand / Confirm Active", () => {
	test("Confirm Active は能力セットの数と長さが合う", () => {
		const caps = pdu.clientCapabilities({
			width: 1280,
			height: 720,
			keyboardLayout: 0x411,
		});
		const raw = pdu.confirmActive(1007, share(), caps);
		const sc = pdu.parseShareControl(raw);
		expect(sc.type).toBe(pdu.PDUTYPE.CONFIRM_ACTIVE);
		expect(raw.length).toBe(new DataView(raw.buffer).getUint16(0, true));
		const dv = new DataView(
			sc.body.buffer,
			sc.body.byteOffset,
			sc.body.byteLength,
		);
		expect(dv.getUint32(0, true)).toBe(share());
		expect(dv.getUint16(4, true)).toBe(pdu.SERVER_ID); // originatorId
		const lenSource = dv.getUint16(6, true);
		expect(lenSource).toBe(6);
		// lengthCombinedCapabilities = 能力セット + numberCapabilities / pad(4)
		expect(dv.getUint16(8, true)).toBe(
			caps.reduce((n, c) => n + c.length, 0) + 4,
		);
		expect(dv.getUint16(10 + lenSource, true)).toBe(caps.length);
	});

	test("能力セットの大きさ(仕様の固定長)", () => {
		const len = (c: Uint8Array) =>
			new DataView(c.buffer, c.byteOffset).getUint16(2, true);
		const caps = pdu.clientCapabilities({
			width: 1,
			height: 1,
			keyboardLayout: 0,
		});
		const by = new Map(
			caps.map((c) => [
				new DataView(c.buffer, c.byteOffset).getUint16(0, true),
				len(c),
			]),
		);
		expect(by.get(pdu.CAP.GENERAL)).toBe(24);
		expect(by.get(pdu.CAP.BITMAP)).toBe(28);
		expect(by.get(pdu.CAP.ORDER)).toBe(88);
		expect(by.get(pdu.CAP.INPUT)).toBe(88);
		expect(by.get(pdu.CAP.POINTER)).toBe(10);
		expect(by.get(pdu.CAP.GLYPH_CACHE)).toBe(52);
		for (const c of caps) expect(len(c)).toBe(c.length);
	});

	test("Demand Active を読む", () => {
		const body = concat(
			fromHex("ea030100"), // shareId
			fromHex("0400"), // lengthSourceDescriptor
			fromHex("0c00"),
			new TextEncoder().encode("RDP\0"),
			fromHex("0100 0000"),
			fromHex("0d00 0800 01020304"), // 能力セット 1 つ(type 0x0d)
			fromHex("00000000"),
		);
		const d = pdu.parseDemandActive(body);
		expect(d.shareId).toBe(share());
		expect(hex(d.capabilities.get(0x0d) ?? new Uint8Array())).toBe("01020304");
	});
});

describe("ライセンス", () => {
	test("STATUS_VALID_CLIENT なら valid", () => {
		expect(
			pdu.checkLicense(fromHex("ff03140007000000020000000400" + "00000000")),
		).toBe("valid");
	});
	test("LICENSE_REQUEST は request、ほかのエラーは例外", () => {
		expect(
			pdu.checkLicense(fromHex("0103 0800 00000000".replace(/ /g, ""))),
		).toBe("request");
		expect(() =>
			pdu.checkLicense(
				fromHex("ff03 1400 01000000 02000000 00000000".replace(/ /g, "")),
			),
		).toThrow("ライセンス");
	});
});

describe("CredSSP の TSRequest", () => {
	test("書いて読み戻す", () => {
		const raw = writeTsRequest({
			version: 6,
			negoToken: Uint8Array.of(1, 2, 3),
			pubKeyAuth: Uint8Array.of(9),
			clientNonce: new Uint8Array(32).fill(7),
		});
		const t = parseTsRequest(raw);
		expect(t.version).toBe(6);
		expect(hex(t.negoToken ?? new Uint8Array())).toBe("010203");
		expect(hex(t.pubKeyAuth ?? new Uint8Array())).toBe("09");
		expect(t.clientNonce?.length).toBe(32);
	});

	test("errorCode は符号なしで読む", () => {
		// version 6、errorCode 0xC000006D(符号付きの INTEGER で、負数として 4 バイトで来る)
		const raw = fromHex("300da003020106a4060204c000006d");
		expect(parseTsRequest(raw).errorCode).toBe(0xc000006d);
	});
});

function share(): number {
	return 0x103ea;
}
