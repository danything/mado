// X.224 / MCS の試験。実機で取った応答と、よく知られたバイト列と突き合わせる。
// 実行: bun test

import { describe, expect, test } from "bun:test";
import { concat, fromHex, hex, Writer } from "./bytes";
import * as der from "./der";
import * as mcs from "./mcs";
import type { ByteStream } from "./stream";
import * as x224 from "./x224";

function fakeStream(b: Uint8Array): ByteStream {
	let rest = b;
	return {
		async peek(n) {
			return rest.subarray(0, n);
		},
		async read(n) {
			const o = rest.subarray(0, n);
			rest = rest.subarray(n);
			return o;
		},
		write() {},
	};
}

describe("X.224", () => {
	test("Connection Request は HYBRID を要求する", () => {
		expect(hex(x224.connectionRequest())).toBe(
			"030000130ee000000000000100080002000000",
		);
	});

	test("Connection Confirm(このPCから取った実物)", () => {
		const cc = x224.parseConnectionConfirm(
			fromHex("030000130ed00000123400022f080002000000"),
		);
		expect(cc).toEqual({ ok: true, selectedProtocol: 2, flags: 0x2f });
	});

	test("Connection Confirm の失敗", () => {
		const cc = x224.parseConnectionConfirm(
			fromHex("030000130ed000001234000301080005000000"),
		);
		expect(cc).toEqual({ ok: false, failureCode: 5 });
	});

	test("PDU の切り出し: TPKT / Fast-Path(短い長さ・長い長さ)", async () => {
		const slow = x224.data(Uint8Array.of(1, 2, 3));
		expect(hex(slow)).toBe("0300000a02f080010203");
		const a = await x224.readPdu(fakeStream(concat(slow, Uint8Array.of(9))));
		expect(a.kind).toBe("slowpath");
		expect(hex(a.data)).toBe("010203");

		const fast = await x224.readPdu(fakeStream(fromHex("0004aabb")));
		expect(fast.kind).toBe("fastpath");
		expect(hex(fast.data)).toBe("aabb");

		const body = new Uint8Array(200).fill(7);
		const long = concat(Uint8Array.of(0x00, 0x80, 203), body);
		const f = await x224.readPdu(fakeStream(long));
		expect(f.data.length).toBe(200);
	});
});

describe("MCS", () => {
	const core: mcs.ClientCore = {
		width: 1280,
		height: 720,
		selectedProtocol: 2,
		clientName: "mado",
	};

	test("Connect Initial のドメイン パラメーター(よく知られた並び)", () => {
		const ci = hex(mcs.connectInitial(Uint8Array.of(1, 2, 3)));
		expect(ci.startsWith("7f65")).toBe(true);
		const params =
			"040101040101" +
			"0101ff" +
			"3019020122020102020100020101020100020101" +
			"0202ffff020102" +
			"3019020101020101020101020101020100020101" +
			"02020420020102" +
			"301c0202ffff0202fc170202ffff020101020100020101" +
			"0202ffff020102" +
			"0403010203";
		expect(ci.endsWith(params)).toBe(true);
	});

	test("GCC のクライアント データ: 先頭の定型と各ブロックの長さ", () => {
		const gcc = mcs.gccCreateRequest(core, [mcs.DRDYNVC, mcs.CLIPRDR]);
		expect(hex(gcc.subarray(0, 7))).toBe("00050014" + "7c0001");
		// 2 バイトの長さ(0x8000 | n)が全体と合う
		const n = ((gcc[7] as number) & 0x7f) * 256 + (gcc[8] as number);
		expect(gcc.length).toBe(9 + n);
		const text = hex(gcc);
		expect(text).toContain("0008001000" + "01c000" + "44756361"); // 会議名 "1" と "Duca"
		// Client Core は 216 バイト、Net は 4 + 4 + 12 * 2
		expect(text).toContain("01c0d800"); // type 0xC001, length 216
		expect(text).toContain("03c0200002000000"); // type 0xC003, length 32, 2 チャネル
		expect(text).toContain(
			`${hex(new TextEncoder().encode("drdynvc"))}00000080c0`,
		);
	});

	test("Connect Response から I/O チャネルと静的チャネルの ID を読む", () => {
		const blocks = new Writer()
			.u16(0x0c01)
			.u16(16)
			.u32(0x00080004)
			.u32(2)
			.u32(0x1)
			.u16(0x0c02)
			.u16(12)
			.u32(0)
			.u32(0)
			.u16(0x0c03)
			.u16(12)
			.u16(1003)
			.u16(2)
			.u16(1004)
			.u16(1005)
			.done();
		const gcc = concat(
			fromHex("000500147c0001" + "0"),
			Uint8Array.of(0x2a, 0x14, 0x76, 0x0a, 0x01, 0x01, 0x00, 0x01, 0xc0, 0x00),
			new TextEncoder().encode("McDn"),
			mcs.perLength(blocks.length),
			blocks,
		);
		const params = der.tlv(
			der.SEQUENCE,
			...[34, 2, 0, 1, 0, 1, 65535, 2].map(der.integer),
		);
		const resp = der.tlv(
			0x7f66,
			der.tlv(der.ENUMERATED, Uint8Array.of(0)),
			der.integer(0),
			params,
			der.octets(gcc),
		);
		expect(mcs.parseConnectResponse(resp)).toEqual({
			ioChannelId: 1003,
			channelIds: [1004, 1005],
			earlyCapabilityFlags: 1,
			messageChannelId: undefined,
		});
	});

	test("PER の PDU", () => {
		expect(hex(mcs.erectDomainRequest())).toBe("0401000100");
		expect(hex(mcs.attachUserRequest())).toBe("28");
		expect(mcs.parseAttachUserConfirm(fromHex("2e000006"))).toBe(1007);
		expect(hex(mcs.channelJoinRequest(1007, 1003))).toBe("38000603eb");
		expect(mcs.parseChannelJoinConfirm(fromHex("3e00000603eb03eb"))).toBe(1003);
		expect(hex(mcs.sendDataRequest(1007, 1003, Uint8Array.of(1, 2, 3)))).toBe(
			"64000603eb7003010203",
		);
		const big = new Uint8Array(300);
		const sent = mcs.sendDataRequest(1007, 1003, big);
		expect(hex(sent.subarray(5, 8))).toBe("70812c");
		// 受信側は Indication(0x68)
		const ind = mcs.parseSendDataIndication(fromHex("68000603eb7003010203"));
		expect(ind.channelId).toBe(1003);
		expect(hex(ind.data)).toBe("010203");
		expect(() => mcs.parseSendDataIndication(fromHex("2180"))).toThrow("切断");
	});
});

describe("キーボード", () => {
	test("日本語配列は種類 7・副種類 2、米国は 4・0", () => {
		expect([mcs.keyboardType(0x0411), mcs.keyboardSubType(0x0411)]).toEqual([
			7, 2,
		]);
		expect([mcs.keyboardType(0x0409), mcs.keyboardSubType(0x0409)]).toEqual([
			4, 0,
		]);
	});
});
