// GFX と ClearCodec の試験。PDU、流れ、キャッシュ、Frame Acknowledge、AVC420 を見る。描画と H.264 の復号は偽物を使う。

import { describe, expect, test } from "bun:test";
import { concat, fromHex, hex, Writer } from "./bytes";
import { ClearDecoder, rlex } from "./clearcodec";
import type { DynamicChannel } from "./dvc";
import {
	type AvcDecoder,
	alphaCodec,
	CMD,
	CODEC,
	capsAdvertise,
	capsVersionName,
	codecString,
	frameAcknowledge,
	GfxClient,
	type GfxOps,
	isKeyFrame,
	parseAvc420,
	parseAvc444,
	parseCapsConfirm,
	type Rect,
	splitPdus,
} from "./gfx";
import { type DecodeJob, decodeJob, type TilePool } from "./rfxpool";
import type { Yuv420 } from "./yuv444";
import { segmentedUncompressed } from "./zgfx";

const pdu = (cmd: number, body: Uint8Array) =>
	new Writer()
		.u16(cmd)
		.u16(0)
		.u32(body.length + 8)
		.bytes(body)
		.done();
const rect = (w: Writer, r: Rect) =>
	w.u16(r.left).u16(r.top).u16(r.right).u16(r.bottom);

class Recorder implements GfxOps {
	calls: string[] = [];
	resetOutput(w: number, h: number) {
		this.calls.push(`reset ${w}x${h}`);
	}
	createSurface(id: number, w: number, h: number, alpha: boolean) {
		this.calls.push(`create ${id} ${w}x${h}${alpha ? " alpha" : ""}`);
	}
	deleteSurface(id: number) {
		this.calls.push(`delete ${id}`);
	}
	mapSurface(id: number, x: number, y: number) {
		this.calls.push(`map ${id} ${x},${y}`);
	}
	putRgba(
		id: number,
		x: number,
		y: number,
		w: number,
		h: number,
		rgba: Uint8ClampedArray,
	) {
		this.calls.push(
			`put ${id} ${x},${y} ${w}x${h} ${hex(Uint8Array.from(rgba.subarray(0, 4)))}`,
		);
	}
	fill(id: number, rects: Rect[], c: number[]) {
		this.calls.push(`fill ${id} ${rects.length} ${c.join(",")}`);
	}
	copyRect(src: number, r: Rect, dst: number, x: number, y: number) {
		this.calls.push(
			`copy ${src}:${r.left},${r.top}-${r.right},${r.bottom} -> ${dst}:${x},${y}`,
		);
	}
	toCache(slot: number, id: number, r: Rect) {
		this.calls.push(
			`toCache ${slot} ${id} ${r.right - r.left}x${r.bottom - r.top}`,
		);
	}
	fromCache(slot: number, id: number, x: number, y: number) {
		this.calls.push(`fromCache ${slot} ${id} ${x},${y}`);
	}
	evict(slot: number) {
		this.calls.push(`evict ${slot}`);
	}
	setAlpha(id: number, r: Rect, a: Uint8Array) {
		this.calls.push(`alpha ${id} ${r.left},${r.top} ${a.length}`);
	}
	drawVideo(id: number, frame: unknown, dest: Rect, regions: Rect[]) {
		this.calls.push(
			`video ${id} ${String(frame)} dest ${dest.left},${dest.top} regions ${regions.map((r) => `${r.left},${r.top},${r.right},${r.bottom}`).join(";")}`,
		);
	}
	present() {
		this.calls.push("present");
	}
}

function channel(): DynamicChannel & { sent: Uint8Array[] } {
	const sent: Uint8Array[] = [];
	return { id: 1, sent, send: (d) => sent.push(d) };
}

/** 偽の H.264 復号器。わざと少し遅れて返す */
class FakeAvc implements AvcDecoder {
	calls: string[] = [];
	closed = 0;
	async decode(_s: Uint8Array, key: boolean, w: number, h: number) {
		this.calls.push(`${key ? "key" : "delta"} ${w}x${h}`);
		await new Promise((r) => setTimeout(r, 5));
		const frame = {
			name: `frame${this.calls.length}`,
			close: () => this.closed++,
		};
		frame.toString = () => frame.name;
		return frame;
	}
	close() {}
}

const SPS = fromHex("00000001" + "6764001f" + "acd9");
const IDR = fromHex("00000001" + "65888400");
const P = fromHex("00000001" + "419a2000");

function wire(
	id: number,
	codec: number,
	dest: Rect,
	data: Uint8Array,
	format = 0x20,
): Uint8Array {
	const w = new Writer().u16(id).u16(codec).u8(format);
	rect(w, dest);
	return pdu(CMD.WIRETOSURFACE_1, w.u32(data.length).bytes(data).done());
}

function avc420(regions: Rect[], stream: Uint8Array): Uint8Array {
	const w = new Writer().u32(regions.length);
	for (const r of regions) rect(w, r);
	for (const _ of regions) w.u8(22).u8(100);
	return w.bytes(stream).done();
}

describe("GFX の PDU", () => {
	test("CapsAdvertise: 版 8・8.1・10.0〜10.7(FreeRDP と同じ組み合わせ)", () => {
		const v8 = "04000800" + "04000000" + "00000000";
		const v81 = (f: string) => ["05010800", "04000000", f].join("");
		// 10.0、10.1(capsData は 16 バイトの 0)、10.2〜10.6、10.7
		const v10 = (f: string, f107: string) =>
			[
				["02000a00", "04000000", f],
				["00010a00", "10000000", "00".repeat(16)],
				...["00020a00", "01030a00", "00040a00", "02050a00", "00060a00"].map(
					(v) => [v, "04000000", f],
				),
				["01070a00", "04000000", f107],
			]
				.flat()
				.join("");
		// AVC420 と AVC444 を使えるとき。8.1 に AVC420_ENABLED を付け、10.x には何も付けない。10.7 だけ SCALEDMAP_DISABLE
		expect(hex(capsAdvertise(true, true))).toBe(
			"1200" +
				"0000" +
				"8e000000" +
				"0a00" +
				v8 +
				v81("10000000") +
				v10("00000000", "80000000"),
		);
		// H.264 なしなら、10.x に AVC_DISABLED
		expect(hex(capsAdvertise(false))).toBe(
			"1200" +
				"0000" +
				"8e000000" +
				"0a00" +
				v8 +
				v81("00000000") +
				v10("20000000", "a0000000"),
		);
		// AVC420 しか使えないなら、10.x は宣言しない
		expect(hex(capsAdvertise(true))).toBe(
			["1200", "0000", "22000000", "0200", v8, v81("10000000")].join(""),
		);
	});

	test("CapsConfirm: 選ばれた版と flags", () => {
		expect(
			parseCapsConfirm(new Writer().u32(0x000a0701).u32(4).u32(0x80).done()),
		).toEqual({ version: 0x000a0701, flags: 0x80 });
		expect(
			parseCapsConfirm(new Writer().u32(0x000a0100).u32(16).zeros(16).done()),
		).toEqual({ version: 0x000a0100, flags: 0 });
		expect(capsVersionName(0x000a0701)).toBe("10.7");
		expect(capsVersionName(0x00080105)).toBe("8.1");
		expect(capsVersionName(0x00080004)).toBe("8.0");
		expect(() => parseCapsConfirm(fromHex("0400"))).toThrow();
	});

	test("AVC444 のストリーム: LC で中身が変わる。長さが足りなければ例外", () => {
		const one = avc420([{ left: 0, top: 0, right: 8, bottom: 8 }], IDR);
		const two = avc420([], P);
		const both = new Writer().u32(one.length).bytes(one).bytes(two).done();
		const m = parseAvc444(both);
		expect(m.luma?.regions).toEqual([{ left: 0, top: 0, right: 8, bottom: 8 }]);
		expect(hex(m.luma?.stream as Uint8Array)).toBe(hex(IDR));
		expect(m.chroma?.regions).toEqual([]);
		expect(hex(m.chroma?.stream as Uint8Array)).toBe(hex(P));
		const lumaOnly = parseAvc444(
			new Writer()
				.u32((1 << 30) | one.length)
				.bytes(one)
				.done(),
		);
		expect(lumaOnly.chroma).toBeUndefined();
		expect(hex(lumaOnly.luma?.stream as Uint8Array)).toBe(hex(IDR));
		const chromaOnly = parseAvc444(
			new Writer()
				.u32((2 << 30) | one.length)
				.bytes(one)
				.done(),
		);
		expect(chromaOnly.luma).toBeUndefined();
		expect(chromaOnly.chroma?.regions.length).toBe(1);
		expect(() =>
			parseAvc444(
				new Writer()
					.u32((3 << 30) | one.length)
					.bytes(one)
					.done(),
			),
		).toThrow("LC");
		// 1 つ目の長さが残りより長い
		expect(() =>
			parseAvc444(
				new Writer()
					.u32(one.length + 1)
					.bytes(one)
					.done(),
			),
		).toThrow();
	});

	test("Frame Acknowledge(queueDepth を付けられる)", () => {
		expect(hex(frameAcknowledge(7, 3))).toBe(
			"0d00" + "0000" + "14000000" + "00000000" + "07000000" + "03000000",
		);
		expect(hex(frameAcknowledge(7, 3, 2)).slice(16, 24)).toBe("02000000");
	});

	test("PDU の切り出しと、長さが不正なとき", () => {
		const two = concat(
			pdu(CMD.STARTFRAME, new Uint8Array(8)),
			pdu(CMD.ENDFRAME, new Uint8Array(4)),
		);
		expect(splitPdus(two).map((p) => p.cmd)).toEqual([
			CMD.STARTFRAME,
			CMD.ENDFRAME,
		]);
		expect(() => splitPdus(fromHex("0b000000ff000000"))).toThrow("長さ");
	});

	test("AVC420 のメタブロック、SPS からの codec 文字列、鍵フレーム", () => {
		const m = parseAvc420(
			avc420([{ left: 0, top: 0, right: 64, bottom: 32 }], concat(SPS, IDR)),
		);
		expect(m.regions).toEqual([{ left: 0, top: 0, right: 64, bottom: 32 }]);
		expect(m.quality).toEqual([{ qp: 22, quality: 100 }]);
		expect(codecString(m.stream)).toBe("avc1.64001F");
		expect(isKeyFrame(m.stream)).toBe(true);
		expect(isKeyFrame(P)).toBe(false);
		expect(codecString(P)).toBeUndefined();
	});

	test("ALPHA コーデック(生と RLE)", () => {
		expect([...alphaCodec(fromHex("4c41" + "0000" + "0102"), 2, 1)]).toEqual([
			1, 2,
		]);
		expect([
			...alphaCodec(fromHex("4c41" + "0100" + "8003" + "ff01"), 4, 1),
		]).toEqual([0x80, 0x80, 0x80, 0xff]);
		expect(() => alphaCodec(fromHex("0000"), 1, 1)).toThrow("署名");
	});
});

describe("GfxClient の流れ", () => {
	test("Caps → 面を作って写す → 描く → フレームの終わりで写して応答する", async () => {
		const ops = new Recorder();
		const avc = new FakeAvc();
		const gfx = new GfxClient(ops, avc);
		const ch = channel();
		gfx.onOpen(ch);
		expect(hex(ch.sent[0] as Uint8Array).slice(0, 4)).toBe("1200");

		const fill = new Writer().u16(1).u8(0x30).u8(0x20).u8(0x10).u8(0).u16(1);
		rect(fill, { left: 0, top: 0, right: 8, bottom: 8 });
		const s2s = new Writer().u16(1).u16(1);
		rect(s2s, { left: 0, top: 0, right: 4, bottom: 4 }).u16(1).u16(10).u16(10);
		const toCache = new Writer().u16(1).zeros(8).u16(5);
		rect(toCache, { left: 0, top: 0, right: 4, bottom: 2 });
		const msgs = [
			pdu(
				CMD.CAPSCONFIRM,
				new Writer().u32(0x00080105).u32(4).u32(0x10).done(),
			),
			pdu(
				CMD.RESETGRAPHICS,
				new Writer().u32(800).u32(600).u32(0).zeros(320).done(),
			),
			pdu(
				CMD.CREATESURFACE,
				new Writer().u16(1).u16(800).u16(600).u8(0x20).done(),
			),
			pdu(
				CMD.MAPSURFACETOOUTPUT,
				new Writer().u16(1).u16(0).u32(0).u32(0).done(),
			),
			pdu(CMD.STARTFRAME, new Writer().u32(0).u32(42).done()),
			pdu(CMD.SOLIDFILL, fill.done()),
			wire(
				1,
				CODEC.UNCOMPRESSED,
				{ left: 2, top: 3, right: 3, bottom: 4 },
				fromHex("33221100"),
			),
			wire(
				1,
				CODEC.AVC420,
				{ left: 0, top: 0, right: 64, bottom: 64 },
				avc420([{ left: 0, top: 16, right: 64, bottom: 32 }], concat(SPS, IDR)),
			),
			pdu(CMD.SURFACETOSURFACE, s2s.done()),
			pdu(CMD.SURFACETOCACHE, toCache.done()),
			pdu(
				CMD.CACHETOSURFACE,
				new Writer().u16(5).u16(1).u16(1).u16(20).u16(20).done(),
			),
			pdu(CMD.EVICTCACHEENTRY, new Writer().u16(5).done()),
			pdu(CMD.ENDFRAME, new Writer().u32(42).done()),
		];
		gfx.onData(segmentedUncompressed(concat(...msgs)));
		await gfx.idle();
		expect(ops.calls).toEqual([
			"reset 800x600",
			"create 1 800x600",
			"map 1 0,0",
			"fill 1 1 16,32,48,255",
			"put 1 2,3 1x1 112233ff",
			"video 1 frame1 dest 0,0 regions 0,16,64,32",
			"copy 1:0,0-4,4 -> 1:10,10",
			"toCache 5 1 4x2",
			"fromCache 5 1 20,20",
			"evict 5",
			"present",
		]);
		expect(avc.calls).toEqual(["key 64x64"]);
		expect(avc.closed).toBe(1);
		// Frame Acknowledge。frameId は 42 で、これまでに 1 フレーム
		expect(hex(ch.sent[1] as Uint8Array)).toBe(hex(frameAcknowledge(42, 1)));
	});

	test("H.264 の復号を待つあいだも順序を保つ(後の PDU は先に処理されない)", async () => {
		const ops = new Recorder();
		const gfx = new GfxClient(ops, new FakeAvc());
		gfx.onOpen(channel());
		gfx.onData(
			segmentedUncompressed(
				concat(
					pdu(
						CMD.CREATESURFACE,
						new Writer().u16(1).u16(64).u16(64).u8(0x20).done(),
					),
					wire(
						1,
						CODEC.AVC420,
						{ left: 0, top: 0, right: 64, bottom: 64 },
						avc420([], concat(SPS, IDR)),
					),
				),
			),
		);
		gfx.onData(
			segmentedUncompressed(pdu(CMD.DELETESURFACE, new Writer().u16(1).done())),
		);
		await gfx.idle();
		expect(ops.calls.map((c) => c.split(" ")[0])).toEqual([
			"create",
			"video",
			"delete",
		]);
	});

	test("描き終えていないフレームの数を queueDepth で知らせる", async () => {
		const gfx = new GfxClient(new Recorder(), new FakeAvc());
		const ch = channel();
		gfx.onOpen(ch);
		const create = pdu(
			CMD.CREATESURFACE,
			new Writer().u16(1).u16(64).u16(64).u8(0x20).done(),
		);
		const video = wire(
			1,
			CODEC.AVC420,
			{ left: 0, top: 0, right: 64, bottom: 64 },
			avc420([], concat(SPS, IDR)),
		);
		const end = (id: number) => pdu(CMD.ENDFRAME, new Writer().u32(id).done());
		// 復号を待つ間に 3 フレームが届く
		gfx.onData(segmentedUncompressed(concat(create, video, end(1))));
		gfx.onData(segmentedUncompressed(end(2)));
		gfx.onData(segmentedUncompressed(end(3)));
		await gfx.idle();
		expect(ch.sent.slice(1).map(hex)).toEqual([
			hex(frameAcknowledge(1, 1, 2)),
			hex(frameAcknowledge(2, 2, 1)),
			hex(frameAcknowledge(3, 3, 0)),
		]);
	});

	test("H.264 の復号が続けて失敗したら 1 度だけ知らせる。H.264 なしなら AVC420 を宣言しない", async () => {
		const failing: AvcDecoder = { decode: async () => null, close() {} };
		const gfx = new GfxClient(new Recorder(), failing);
		let broken = 0;
		gfx.onAvcBroken = () => broken++;
		gfx.onOpen(channel());
		expect(gfx.avcEnabled).toBe(true);
		const frames = [
			pdu(
				CMD.CREATESURFACE,
				new Writer().u16(1).u16(64).u16(64).u8(0x20).done(),
			),
		];
		for (let i = 0; i < 100; i++)
			frames.push(
				wire(
					1,
					CODEC.AVC420,
					{ left: 0, top: 0, right: 64, bottom: 64 },
					avc420([], P),
				),
			);
		gfx.onData(segmentedUncompressed(concat(...frames)));
		await gfx.idle();
		expect(broken).toBe(1);

		const plain = new GfxClient(new Recorder());
		const ch = channel();
		expect(plain.active).toBe(false);
		plain.onOpen(ch);
		expect(plain.active).toBe(true);
		expect(plain.avcEnabled).toBe(false);
		expect(hex(ch.sent[0] as Uint8Array)).toBe(hex(capsAdvertise(false)));
	});

	test("壊れた PDU は飛ばして続ける。無い面は例外、無いキャッシュは黙って飛ばす(上限で捨てたもの)", async () => {
		const ops = new Recorder();
		const gfx = new GfxClient(ops);
		const errors: unknown[] = [];
		gfx.onError = (e) => errors.push(e);
		gfx.onOpen(channel());
		gfx.onData(
			segmentedUncompressed(
				concat(
					wire(
						9,
						CODEC.UNCOMPRESSED,
						{ left: 0, top: 0, right: 1, bottom: 1 },
						new Uint8Array(4),
					),
					pdu(CMD.CACHETOSURFACE, new Writer().u16(77).u16(1).u16(0).done()),
					pdu(CMD.ENDFRAME, new Writer().u32(1).done()),
				),
			),
		);
		await gfx.idle();
		expect(errors.length).toBe(1);
		expect(gfx.stats.skipped).toBe(1);
		expect(gfx.stats.cacheMiss).toBe(1);
		expect(ops.calls).toEqual(["present"]);
	});

	test("Planar は上の行から", async () => {
		const ops = new Recorder();
		const gfx = new GfxClient(ops);
		gfx.onOpen(channel());
		// 1x2、生の面、アルファ無し(NA)。上の行が赤、下の行が青
		const planar = Uint8Array.of(0x20, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff);
		gfx.onData(
			segmentedUncompressed(
				concat(
					pdu(
						CMD.CREATESURFACE,
						new Writer().u16(1).u16(8).u16(8).u8(0x20).done(),
					),
					wire(
						1,
						CODEC.PLANAR,
						{ left: 0, top: 0, right: 1, bottom: 2 },
						planar,
					),
				),
			),
		);
		await gfx.idle();
		expect(ops.calls[1]).toBe("put 1 0,0 1x2 ff0000ff");
	});
});

describe("ClearCodec", () => {
	const clearMsg = (
		flags: number,
		glyph: number | undefined,
		residual: Uint8Array,
		bands: Uint8Array,
		sub: Uint8Array,
	) => {
		const w = new Writer().u8(flags).u8(0);
		if (glyph !== undefined) w.u16(glyph);
		return w
			.u32(residual.length)
			.u32(bands.length)
			.u32(sub.length)
			.bytes(residual)
			.bytes(bands)
			.bytes(sub)
			.done();
	};
	const px = (out: Uint8ClampedArray, i: number) =>
		hex(Uint8Array.from(out.subarray(i * 4, i * 4 + 4)));

	test("残差: (B, G, R, 長さ)で埋める。長い長さ(0xFF + 2 バイト)", () => {
		const d = new ClearDecoder();
		const out = d.decode(
			clearMsg(
				0,
				undefined,
				fromHex("102030" + "02" + "aabbcc" + "ff" + "0200"),
				new Uint8Array(),
				new Uint8Array(),
			),
			2,
			2,
		);
		expect([px(out, 0), px(out, 1), px(out, 2), px(out, 3)]).toEqual([
			"302010ff",
			"302010ff",
			"ccbbaaff",
			"ccbbaaff",
		]);
	});

	test("残差が足りなければ例外", () => {
		expect(() =>
			new ClearDecoder().decode(
				clearMsg(
					0,
					undefined,
					fromHex("10203001"),
					new Uint8Array(),
					new Uint8Array(),
				),
				2,
				1,
			),
		).toThrow("足りない");
	});

	test("帯: 短い棒(キャッシュに入れる)と、棒のキャッシュの再利用", () => {
		const d = new ClearDecoder();
		// 帯: x 0..1、y 0..2(高さ 3)、背景は黒。列 0 = 短い棒の MISS(yOn 1、yOff 2 → 1 画素 白)、列 1 = 棒のキャッシュ 0(= 列 0)
		const bands = new Writer()
			.u16(0)
			.u16(1)
			.u16(0)
			.u16(2)
			.bytes(fromHex("000000"))
			.u16((2 << 8) | 1)
			.bytes(fromHex("ffffff"))
			.u16(0x8000 | 0)
			.done();
		const out = d.decode(
			clearMsg(0, undefined, new Uint8Array(), bands, new Uint8Array()),
			2,
			3,
		);
		expect([px(out, 0), px(out, 2), px(out, 4)]).toEqual([
			"000000ff",
			"ffffffff",
			"000000ff",
		]);
		expect([px(out, 1), px(out, 3), px(out, 5)]).toEqual([
			"000000ff",
			"ffffffff",
			"000000ff",
		]);
		// 次の呼び出しで、短い棒のキャッシュ 0 を yOn 0 で使う
		const bands2 = new Writer()
			.u16(0)
			.u16(0)
			.u16(0)
			.u16(1)
			.bytes(fromHex("0000ff"))
			.u16(0x4000 | 0)
			.u8(0)
			.done();
		const out2 = d.decode(
			clearMsg(0, undefined, new Uint8Array(), bands2, new Uint8Array()),
			1,
			2,
		);
		expect([px(out2, 0), px(out2, 1)]).toEqual(["ffffffff", "ff0000ff"]);
	});

	test("サブコーデック: 生と RLEX、知らないもの(3)は描かずに数える", () => {
		const d = new ClearDecoder();
		const raw = fromHex("0000ff");
		const sub = concat(
			new Writer()
				.u16(0)
				.u16(0)
				.u16(1)
				.u16(1)
				.u32(raw.length)
				.u8(0)
				.bytes(raw)
				.done(),
			new Writer().u16(1).u16(0).u16(1).u16(1).u32(1).u8(3).u8(0).done(),
		);
		const out = d.decode(
			clearMsg(0, undefined, new Uint8Array(), new Uint8Array(), sub),
			2,
			1,
		);
		expect(px(out, 0)).toBe("ff0000ff");
		expect(d.unsupported).toBe(1);
	});

	test("RLEX: パレット、run、続き", () => {
		// パレット 3 色(0 = 黒、1 = 赤、2 = 白)。ビット数 2。stop 2、depth 1 → start 1: run 2 で赤 x2、続きで赤・白
		const data = concat(
			fromHex("03" + "000000" + "0000ff" + "ffffff"),
			Uint8Array.of(2 | (1 << 2), 2),
		);
		expect(hex(rlex(data, 4))).toBe(`${"0000ff".repeat(3)}ffffff`);
		expect(() => rlex(data, 3)).toThrow("あふれ");
	});

	test("グリフ: 番号付きで復号したものを、次は GLYPH_HIT で出す", () => {
		const d = new ClearDecoder();
		const first = d.decode(
			clearMsg(
				0x01,
				7,
				fromHex("112233" + "04"),
				new Uint8Array(),
				new Uint8Array(),
			),
			2,
			2,
		);
		const hit = d.decode(Uint8Array.of(0x03, 1, 7, 0), 2, 2);
		expect(hex(Uint8Array.from(hit))).toBe(hex(Uint8Array.from(first)));
		expect(() => d.decode(Uint8Array.of(0x03, 1, 8, 0), 2, 2)).toThrow(
			"グリフ",
		);
	});
});

describe("コマンドの番号([MS-RDPEGFX] 2.2.1.5)", () => {
	test("DELETEENCODINGCONTEXT(0x0003)の後ろがずれていない", () => {
		expect([
			CMD.SOLIDFILL,
			CMD.SURFACETOSURFACE,
			CMD.SURFACETOCACHE,
			CMD.CACHETOSURFACE,
			CMD.EVICTCACHEENTRY,
			CMD.CREATESURFACE,
			CMD.DELETESURFACE,
			CMD.STARTFRAME,
			CMD.ENDFRAME,
		]).toEqual([0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xa, 0xb, 0xc]);
	});
});

describe("レビューの指摘(#33)", () => {
	test("ZGFX の伸長に失敗したら、回復不能として以後のデータを捨てる", async () => {
		const ops = new Recorder();
		const gfx = new GfxClient(ops, new FakeAvc());
		gfx.onOpen(channel());
		const fatal: unknown[] = [];
		const errors: unknown[] = [];
		gfx.onFatal = (e) => fatal.push(e);
		gfx.onError = (e) => errors.push(e);
		// 知らない descriptor。例外は呼び出し元に投げない
		expect(() => gfx.onData(Uint8Array.of(0x12, 0, 0))).not.toThrow();
		expect(fatal.length).toBe(1);
		// 壊れた後は、正しいデータも捨てる
		gfx.onData(
			segmentedUncompressed(
				pdu(CMD.RESETGRAPHICS, new Writer().u32(64).u32(48).u32(0).done()),
			),
		);
		await gfx.idle();
		expect(ops.calls).toEqual([]);
		expect(errors.length).toBe(0);
	});

	test("PDU 1 つの失敗は飛ばして続ける(無い面への描画)", async () => {
		const ops = new Recorder();
		const gfx = new GfxClient(ops, new FakeAvc());
		gfx.onOpen(channel());
		const errors: unknown[] = [];
		gfx.onError = (e) => errors.push(e);
		const bad = wire(
			9,
			CODEC.UNCOMPRESSED,
			{ left: 0, top: 0, right: 1, bottom: 1 },
			new Uint8Array(4),
		);
		const reset = pdu(
			CMD.RESETGRAPHICS,
			new Writer().u32(64).u32(48).u32(0).done(),
		);
		gfx.onData(segmentedUncompressed(concat(bad, reset)));
		await gfx.idle();
		expect(errors.length).toBe(1);
		expect(ops.calls).toEqual(["reset 64x48"]);
	});

	const create = (id: number, w: number, h: number) =>
		pdu(CMD.CREATESURFACE, new Writer().u16(id).u16(w).u16(h).u8(0x20).done());
	const toCache = (slot: number, w: number, h: number) => {
		const b = new Writer().u16(1).zeros(8).u16(slot);
		rect(b, { left: 0, top: 0, right: w, bottom: h });
		return pdu(CMD.SURFACETOCACHE, b.done());
	};
	const fromCache = (slot: number) =>
		pdu(
			CMD.CACHETOSURFACE,
			new Writer().u16(slot).u16(1).u16(1).u16(0).u16(0).done(),
		);

	test("面の数・総画素数の上限を超える面は作らない", async () => {
		const ops = new Recorder();
		const gfx = new GfxClient(ops, new FakeAvc());
		gfx.onOpen(channel());
		// 8192x8192 は 2^26 画素。2 つで上限の 2^27 になり、3 つ目は作らない
		gfx.onData(
			segmentedUncompressed(
				concat(
					create(1, 8192, 8192),
					create(2, 8192, 8192),
					create(3, 8192, 8192),
				),
			),
		);
		await gfx.idle();
		expect(ops.calls.filter((c) => c.startsWith("create")).length).toBe(2);
		expect(gfx.stats.skipped).toBe(1);
		// 1 つ消せば作れる
		gfx.onData(
			segmentedUncompressed(
				concat(
					pdu(CMD.DELETESURFACE, new Writer().u16(1).done()),
					create(3, 8192, 8192),
				),
			),
		);
		await gfx.idle();
		expect(ops.calls.filter((c) => c.startsWith("create")).length).toBe(3);
	});

	test("画像キャッシュの合計の上限を超えたら古いものから捨て、捨てたものを指されたら飛ばす", async () => {
		const ops = new Recorder();
		const gfx = new GfxClient(ops, new FakeAvc());
		gfx.onOpen(channel());
		// 8192x4096x4 は 128MB。2 つで上限の 256MB になり、3 つ目で 1 つ目を捨てる
		gfx.onData(
			segmentedUncompressed(
				concat(
					create(1, 8192, 8192),
					toCache(10, 8192, 4096),
					toCache(11, 8192, 4096),
					toCache(12, 16, 16),
				),
			),
		);
		await gfx.idle();
		expect(ops.calls).toContain("evict 10");
		expect(ops.calls).not.toContain("evict 11");
		gfx.onData(segmentedUncompressed(concat(fromCache(10), fromCache(11))));
		await gfx.idle();
		expect(ops.calls.filter((c) => c.startsWith("fromCache"))).toEqual([
			"fromCache 11 1 0,0",
		]);
		expect(gfx.stats.cacheMiss).toBe(1);
	});
});

/** Worker の代わりに、lane ごとに順に復号する非同期のプール。Worker と同じく、同じ lane の仕事は頼んだ順に終わる */
function lanePool(lanes: number): TilePool {
	const tails: Promise<unknown>[] = Array.from({ length: lanes }, () =>
		Promise.resolve(),
	);
	const runOn = (lane: number, job: DecodeJob) => {
		const i = lane % lanes;
		const p = (tails[i] as Promise<unknown>).then(() => decodeJob(job));
		tails[i] = p.catch(() => {});
		return p;
	};
	return {
		async: true,
		lanes,
		run: (job) => runOn(0, job),
		runOn,
		terminate() {},
	};
}

describe("WireToSurface2", () => {
	for (const pool of [undefined, lanePool(2)])
		test(`同じフレームで前の PDU が送ったタイルを、後の PDU の矩形にも描く。フレームが変わったら描かない(${pool ? "Worker" : "その場"})`, async () => {
			const ops = new Recorder();
			const gfx = new GfxClient(ops, undefined, pool);
			gfx.onOpen(channel());
			const blk = (t: number, b: Uint8Array) =>
				new Writer()
					.u16(t)
					.u32(b.length + 6)
					.bytes(b)
					.done();
			// 空のタイル。係数が全部 0 なので灰色になる。tiles が空なら矩形だけの Region
			const region = (
				rect: [number, number, number, number],
				tiles: number,
			) => {
				const tile = blk(
					0xccc5,
					new Writer()
						.u8(0)
						.u8(0)
						.u8(0)
						.u16(0)
						.u16(0)
						.u8(0)
						.u32(0)
						.u32(0)
						.done(),
				);
				const w = new Writer()
					.u8(64)
					.u16(1)
					.u8(1)
					.u8(0)
					.u8(1)
					.u16(tiles)
					.u32(tile.length * tiles)
					.u16(rect[0])
					.u16(rect[1])
					.u16(rect[2])
					.u16(rect[3])
					.bytes(new Uint8Array(5).fill(0x66));
				for (let i = 0; i < tiles; i++) w.bytes(tile);
				return blk(0xccc4, w.done());
			};
			const w2 = (data: Uint8Array) =>
				pdu(
					CMD.WIRETOSURFACE_2,
					new Writer()
						.u16(1)
						.u16(CODEC.CAPROGRESSIVE)
						.u32(7)
						.u8(0x20)
						.u32(data.length)
						.bytes(data)
						.done(),
				);
			const start = (id: number) =>
				pdu(CMD.STARTFRAME, new Writer().u32(0).u32(id).done());
			const end = (id: number) =>
				pdu(CMD.ENDFRAME, new Writer().u32(id).done());
			gfx.onData(
				segmentedUncompressed(
					concat(
						pdu(
							CMD.CREATESURFACE,
							new Writer().u16(1).u16(64).u16(64).u8(0x20).done(),
						),
						start(1),
						w2(region([0, 0, 8, 8], 1)),
						// タイルの無い、矩形だけの PDU。前の PDU のタイル (0, 0) をここにも描く
						w2(region([8, 0, 8, 8], 0)),
						end(1),
						start(2),
						w2(region([16, 0, 8, 8], 0)),
						end(2),
					),
				),
			);
			await gfx.idle();
			expect(ops.calls.filter((c) => c.startsWith("put"))).toEqual([
				"put 1 0,0 8x8 808080ff",
				"put 1 8,0 8x8 808080ff",
			]);
		});

	for (const pool of [undefined, lanePool(2)])
		test(`Progressive は面に描く(タイルの位置は面の座標)。ほかのコーデックは飛ばす(${pool ? "Worker" : "その場"})`, async () => {
			const ops = new Recorder();
			const gfx = new GfxClient(ops, undefined, pool);
			gfx.onOpen(channel());
			const blk = (t: number, b: Uint8Array) =>
				new Writer()
					.u16(t)
					.u32(b.length + 6)
					.bytes(b)
					.done();
			// 空のタイル(係数が全部 0 で灰色)を 1 つ、(4, 2) からの 8x8 の矩形で切る
			const tile = blk(
				0xccc5,
				new Writer().u8(0).u8(0).u8(0).u16(0).u16(0).u8(0).u32(0).u32(0).done(),
			);
			const region = blk(
				0xccc4,
				new Writer()
					.u8(64)
					.u16(1)
					.u8(1)
					.u8(0)
					.u8(1)
					.u16(1)
					.u32(tile.length)
					.u16(4)
					.u16(2)
					.u16(8)
					.u16(8)
					.bytes(new Uint8Array(5).fill(0x66))
					.bytes(tile)
					.done(),
			);
			const w2 = (codec: number, data: Uint8Array) =>
				pdu(
					CMD.WIRETOSURFACE_2,
					new Writer()
						.u16(1)
						.u16(codec)
						.u32(7)
						.u8(0x20)
						.u32(data.length)
						.bytes(data)
						.done(),
				);
			gfx.onData(
				segmentedUncompressed(
					concat(
						pdu(
							CMD.CREATESURFACE,
							new Writer().u16(1).u16(16).u16(16).u8(0x20).done(),
						),
						w2(CODEC.CAPROGRESSIVE, region),
						w2(CODEC.AVC444, new Uint8Array(4)),
					),
				),
			);
			await gfx.idle();
			expect(ops.calls).toEqual(["create 1 16x16", "put 1 4,2 8x8 808080ff"]);
			expect(gfx.stats.progressive).toBe(1);
			expect(gfx.stats.skipped).toBe(1);
		});
});

/** 偽の AVC444 の復号器。呼ばれた順に、決まった YUV420 の面を返す。null は出なかったことを表す */
class FakeYuvAvc implements AvcDecoder {
	calls: string[] = [];
	constructor(private outputs: (Yuv420 | null)[]) {}
	async decode() {
		return null;
	}
	async decodeYuv(s: Uint8Array, key: boolean, w: number, h: number) {
		this.calls.push(
			`${key ? "key" : "delta"} ${w}x${h} ${hex(s.subarray(4, 5))}`,
		);
		await new Promise((r) => setTimeout(r, 2));
		return this.outputs.shift() ?? null;
	}
	close() {}
}

/** 一色の YUV420(w x h) */
function flat(w: number, h: number, y: number, u: number, v: number): Yuv420 {
	return {
		width: w,
		height: h,
		y: new Uint8Array(w * h).fill(y),
		u: new Uint8Array((w * h) / 4).fill(u),
		v: new Uint8Array((w * h) / 4).fill(v),
		yStride: w,
		uStride: w / 2,
		vStride: w / 2,
	};
}

function avc444(lc: number, first: Uint8Array, second?: Uint8Array) {
	const w = new Writer().u32((lc << 30) | first.length).bytes(first);
	if (second) w.bytes(second);
	return w.done();
}

describe("GfxClient の AVC444", () => {
	const create = pdu(
		CMD.CREATESURFACE,
		new Writer().u16(1).u16(16).u16(16).u8(0x20).done(),
	);
	const dest = { left: 0, top: 0, right: 16, bottom: 16 };

	test("版 10 を宣言し、CapsConfirm の版を覚える。主と補助を順に復号して YUV444 で描く", async () => {
		const ops = new Recorder();
		// 主の絵は白(Y=255)。補助の絵は色差 128 のまま。次の主の絵は黒
		const avc = new FakeYuvAvc([
			flat(16, 16, 255, 128, 128),
			flat(16, 32, 128, 128, 128),
			flat(16, 16, 0, 128, 128),
		]);
		const gfx = new GfxClient(ops, avc);
		expect(gfx.avc444Enabled).toBe(true);
		const ch = channel();
		gfx.onOpen(ch);
		expect(hex(ch.sent[0] as Uint8Array)).toBe(hex(capsAdvertise(true, true)));
		const region = [{ left: 0, top: 0, right: 8, bottom: 8 }];
		gfx.onData(
			segmentedUncompressed(
				concat(
					pdu(
						CMD.CAPSCONFIRM,
						new Writer().u32(0x000a0701).u32(4).u32(0x80).done(),
					),
					create,
					wire(
						1,
						CODEC.AVC444,
						dest,
						avc444(0, avc420(region, concat(SPS, IDR)), avc420(region, P)),
					),
					// 主の絵だけ(v2)。領域が無ければ全体
					wire(1, CODEC.AVC444V2, dest, avc444(1, avc420([], P))),
				),
			),
		);
		await gfx.idle();
		expect(gfx.confirmedVersion).toBe("10.7 flags=0x80");
		expect(avc.calls).toEqual([
			"key 16x16 67",
			"delta 16x16 41",
			"delta 16x16 41",
		]);
		expect(ops.calls).toEqual([
			"create 1 16x16",
			"put 1 0,0 8x8 ffffffff",
			"put 1 0,0 16x16 000000ff",
		]);
		expect(gfx.stats.avc444).toBe(2);
		expect(gfx.stats.skipped).toBe(0);
	});

	test("補助の絵が主の絵より先に来たら描かない。出なかったら飛ばした数に入れる", async () => {
		const ops = new Recorder();
		const gfx = new GfxClient(
			ops,
			new FakeYuvAvc([flat(16, 16, 0, 128, 128), null]),
		);
		gfx.onOpen(channel());
		gfx.onData(
			segmentedUncompressed(
				concat(
					create,
					wire(1, CODEC.AVC444, dest, avc444(2, avc420([], concat(SPS, IDR)))),
					wire(1, CODEC.AVC444, dest, avc444(1, avc420([], P))),
				),
			),
		);
		await gfx.idle();
		expect(ops.calls).toEqual(["create 1 16x16"]);
		expect(gfx.stats.skipped).toBe(1);
	});

	test("AVC444 を復号できない復号器(decodeYuv なし)では版 10 を宣言せず、来たら PDU の失敗にする", async () => {
		const ops = new Recorder();
		const gfx = new GfxClient(ops, new FakeAvc());
		const errors: unknown[] = [];
		gfx.onError = (e) => errors.push(e);
		expect(gfx.avc444Enabled).toBe(false);
		const ch = channel();
		gfx.onOpen(ch);
		expect(hex(ch.sent[0] as Uint8Array)).toBe(hex(capsAdvertise(true)));
		gfx.onData(
			segmentedUncompressed(
				concat(create, wire(1, CODEC.AVC444, dest, avc444(1, avc420([], IDR)))),
			),
		);
		await gfx.idle();
		expect(String(errors[0])).toContain("AVC444");
	});
});
