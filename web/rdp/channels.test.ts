// 静的チャネルの断片、drdynvc、DisplayControl、クリップボードの試験。

import { describe, expect, test } from "bun:test";
import { concat, fromHex, hex, Writer } from "./bytes";
import * as cliprdr from "./cliprdr";
import {
	clampMonitorSize,
	DISPLAYCONTROL,
	DisplayControl,
	DynamicChannels,
	monitorLayout,
} from "./dvc";
import { CHUNK_SIZE, ChannelAssembler, splitChannelData } from "./vchannel";

const text = (s: string) => new TextEncoder().encode(s);

describe("静的チャネルの断片", () => {
	test("1 つに収まるなら FIRST | LAST", () => {
		const [c, ...rest] = splitChannelData(Uint8Array.of(1, 2, 3));
		expect(rest).toEqual([]);
		expect(hex(c as Uint8Array)).toBe("03000000030000000102" + "03");
	});

	test("大きなメッセージは分けて、組み立てると元に戻る", () => {
		const data = Uint8Array.from(
			{ length: CHUNK_SIZE * 2 + 10 },
			(_, i) => i & 0xff,
		);
		const chunks = splitChannelData(data, 0x10);
		expect(chunks.length).toBe(3);
		const asm = new ChannelAssembler();
		expect(asm.push(chunks[0] as Uint8Array)).toBeNull();
		expect(asm.push(chunks[1] as Uint8Array)).toBeNull();
		const back = asm.push(chunks[2] as Uint8Array);
		expect(back && hex(back)).toBe(hex(data));
		// フラグ: 最初は FIRST | SHOW_PROTOCOL、最後は LAST | SHOW_PROTOCOL
		const flags = (c: Uint8Array) =>
			new DataView(c.buffer, c.byteOffset).getUint32(4, true);
		expect(flags(chunks[0] as Uint8Array)).toBe(0x11);
		expect(flags(chunks[1] as Uint8Array)).toBe(0x10);
		expect(flags(chunks[2] as Uint8Array)).toBe(0x12);
	});

	test("空のメッセージも 1 つの断片", () => {
		expect(splitChannelData(new Uint8Array()).length).toBe(1);
	});

	test("先頭のない断片・大きすぎる長さ・圧縮は例外", () => {
		const asm = new ChannelAssembler(100);
		expect(() => asm.push(fromHex("0100000002000000aa"))).toThrow("最初の断片");
		expect(() => asm.push(fromHex("ffffff0001000000aa"))).toThrow("大きすぎる");
		expect(() => asm.push(fromHex("0100000003002000aa"))).toThrow("圧縮");
	});
});

describe("drdynvc", () => {
	function setup() {
		const sent: Uint8Array[] = [];
		const dvc = new DynamicChannels((d) => sent.push(d));
		const got: string[] = [];
		dvc.register("test", {
			onOpen: (c) => got.push(`open ${c.id}`),
			onData: (d) => got.push(`data ${hex(d)}`),
			onClose: () => got.push("close"),
		});
		return { dvc, sent, got };
	}

	test("Capabilities Request には版 2 で答える", () => {
		const { dvc, sent } = setup();
		dvc.onStatic(fromHex("5000030033003300330033 00".replace(/ /g, "")));
		expect(hex(sent[0] as Uint8Array)).toBe("50000200");
	});

	test("Create で開いて成功を返し、Data を渡し、Close で閉じる", () => {
		const { dvc, sent, got } = setup();
		dvc.onStatic(concat(fromHex("1005"), text("test\0")));
		expect(hex(sent[0] as Uint8Array)).toBe("100500000000");
		dvc.onStatic(fromHex("3005aabb"));
		dvc.onStatic(fromHex("4005"));
		expect(got).toEqual(["open 5", "data aabb", "close"]);
		expect(hex(sent[1] as Uint8Array)).toBe("4005");
	});

	test("知らないチャネルの Create は失敗で返す", () => {
		const { dvc, sent } = setup();
		dvc.onStatic(concat(fromHex("1007"), text("nope\0")));
		// creationStatus 0xC0000001
		expect(hex(sent[0] as Uint8Array)).toBe("1007010000c0");
	});

	test("Data First + Data で分かれたメッセージを 1 つにする", () => {
		const { dvc, got } = setup();
		dvc.onStatic(concat(fromHex("1005"), text("test\0")));
		// DATA_FIRST: ID 1 バイト、Length 1 バイト(sp = 0)、全体 4 バイト
		dvc.onStatic(fromHex("2005040102"));
		dvc.onStatic(fromHex("30050304"));
		expect(got).toEqual(["open 5", "data 01020304"]);
	});

	test("2 バイトの ID は cbId 1", () => {
		const { dvc, sent } = setup();
		dvc.onStatic(concat(fromHex("110301"), text("test\0")));
		expect(hex(sent[0] as Uint8Array)).toBe("11030100000000");
	});

	test("大きな送信は Data First と Data に分ける", () => {
		const { dvc, sent } = setup();
		dvc.sendData(9, new Uint8Array(3000));
		expect(sent.length).toBeGreaterThanOrEqual(2);
		expect(sent[0]?.[0]).toBe((0x2 << 4) | (2 << 2));
		expect(sent[1]?.[0]).toBe(0x30);
		for (const s of sent) expect(s.length).toBeLessThanOrEqual(1590);
		// 先頭は header + id + length(4)、続きは header + id
		const total =
			(sent[0] as Uint8Array).length -
			6 +
			sent.slice(1).reduce((n, s) => n + s.length - 2, 0);
		expect(total).toBe(3000);
	});
});

describe("DisplayControl", () => {
	test("大きさは 200〜8192、幅は偶数に収める", () => {
		expect(clampMonitorSize(1281, 720)).toEqual({ width: 1280, height: 720 });
		expect(clampMonitorSize(100, 50)).toEqual({ width: 200, height: 200 });
		expect(clampMonitorSize(99999, 99999)).toEqual({
			width: 8192,
			height: 8192,
		});
	});

	test("MONITOR_LAYOUT_PDU の並び", () => {
		const b = monitorLayout(1280, 720);
		expect(b.length).toBe(56);
		const dv = new DataView(b.buffer);
		expect(dv.getUint32(0, true)).toBe(2); // type
		expect(dv.getUint32(4, true)).toBe(56); // length
		expect(dv.getUint32(8, true)).toBe(40); // MonitorLayoutSize
		expect(dv.getUint32(12, true)).toBe(1); // NumMonitors
		expect(dv.getUint32(16, true)).toBe(1); // PRIMARY
		expect(dv.getUint32(28, true)).toBe(1280);
		expect(dv.getUint32(32, true)).toBe(720);
		expect(dv.getUint32(48, true)).toBe(100); // DesktopScaleFactor
	});

	test("Caps を受けるまで待ってから送る(最後の 1 つだけ)", () => {
		const sent: Uint8Array[] = [];
		const dvc = new DynamicChannels((d) => sent.push(d));
		const dc = new DisplayControl();
		dvc.register(DISPLAYCONTROL, dc);
		dc.resize(800, 600); // まだ開いていない
		dc.resize(1024, 768);
		dvc.onStatic(concat(fromHex("1003"), text(`${DISPLAYCONTROL}\0`)));
		expect(dc.available).toBe(false);
		// Caps: type 5、length 20、MaxNumMonitors 1、A、B
		dvc.onStatic(
			concat(
				fromHex("3003"),
				new Writer(20).u32(5).u32(20).u32(1).u32(1).u32(1).done(),
			),
		);
		expect(dc.available).toBe(true);
		const layouts = sent.filter((s) => s[0] === 0x30);
		expect(layouts.length).toBe(1);
		const body = (layouts[0] as Uint8Array).subarray(2);
		expect(new DataView(body.buffer, body.byteOffset).getUint32(28, true)).toBe(
			1024,
		);
	});
});

describe("クリップボード", () => {
	function setup() {
		const sent: Uint8Array[] = [];
		const remote: string[] = [];
		const cb = new cliprdr.Clipboard(
			(d) => sent.push(d),
			(t) => remote.push(t),
		);
		return { cb, sent, remote };
	}
	const msg = (type: number, flags: number, data = "") =>
		fromHex(
			hex(
				new Writer(8)
					.u16(type)
					.u16(flags)
					.u32(data.length / 2)
					.done(),
			) + data,
		);

	test("文字列の符号化(UTF-16LE、NUL 終わり、改行は CRLF)", () => {
		expect(hex(cliprdr.encodeText("a\nb"))).toBe("61000d000a0062000000");
		expect(cliprdr.decodeText(fromHex("61000d000a00620000007a00"))).toBe(
			"a\nb",
		);
	});

	test("Monitor Ready で能力と(空の)書式の一覧を返す", () => {
		const { cb, sent } = setup();
		cb.onStatic(msg(1, 0));
		expect(hex(sent[0] as Uint8Array)).toBe(
			"07000000100000000100000001000c000200000002000000",
		);
		expect(hex(sent[1] as Uint8Array)).toBe("020000000000000000".slice(0, 16));
	});

	test("こちらでコピーしたら書式の一覧を送り、要求されたら渡す", () => {
		const { cb, sent } = setup();
		cb.onStatic(msg(1, 0));
		sent.length = 0;
		cb.setLocalText("hi");
		expect(hex(sent[0] as Uint8Array)).toBe("02000000060000000d0000000000");
		cb.onStatic(msg(4, 0, "0d000000"));
		expect(hex(sent[1] as Uint8Array)).toBe("0500010006000000680069000000");
	});

	test("Monitor Ready の前にコピーしていたら、そのあと一覧に入れる", () => {
		const { cb, sent } = setup();
		cb.setLocalText("x");
		expect(sent.length).toBe(0);
		cb.onStatic(msg(1, 0));
		expect(hex(sent[1] as Uint8Array)).toBe("02000000060000000d0000000000");
	});

	test("サーバーの書式の一覧に文字列があれば、要求して、受けた文字列を渡す", () => {
		const { cb, sent, remote } = setup();
		cb.onStatic(msg(2, 0, "0d0000000000"));
		expect(hex(sent[0] as Uint8Array)).toBe("0300010000000000"); // List Response OK
		expect(hex(sent[1] as Uint8Array)).toBe("040000000400000" + "00d000000"); // Data Request
		cb.onStatic(msg(5, 1, "680069000000"));
		expect(remote).toEqual(["hi"]);
	});

	test("文字列が無い一覧には要求しない。持っていない書式の要求には失敗を返す", () => {
		const { cb, sent } = setup();
		cb.onStatic(msg(2, 0, "020000000000"));
		expect(sent.length).toBe(1);
		cb.onStatic(msg(4, 0, "0d000000"));
		expect(hex(sent[1] as Uint8Array)).toBe("0500020000000000");
	});
});
