// WebCodecsAvc の試験。VideoDecoder と EncodedVideoChunk は偽物で、復号器は返事をしない。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { concat, fromHex } from "./bytes";
import type { Display } from "./display";
import { CanvasGfxOps, WebCodecsAvc } from "./gfx-canvas";

const SPS = fromHex("000000016764001facd9");
const IDR = fromHex("0000000165888400");
const P = fromHex("00000001419a2000");

const made: FakeDecoder[] = [];
class FakeDecoder {
	state = "unconfigured";
	chunks: string[] = [];
	constructor(_init: unknown) {
		made.push(this);
	}
	configure() {
		this.state = "configured";
	}
	decode(chunk: { type: string }) {
		// 返事をせず、タイムアウトさせる
		this.chunks.push(chunk.type);
	}
	close() {
		this.state = "closed";
	}
}

const g = globalThis as Record<string, unknown>;
const saved = {
	VideoDecoder: g.VideoDecoder,
	EncodedVideoChunk: g.EncodedVideoChunk,
};
beforeAll(() => {
	g.VideoDecoder = FakeDecoder;
	g.EncodedVideoChunk = class {
		type: string;
		constructor(init: { type: string }) {
			this.type = init.type;
		}
	};
});
afterAll(() => {
	g.VideoDecoder = saved.VideoDecoder;
	g.EncodedVideoChunk = saved.EncodedVideoChunk;
});

describe("WebCodecsAvc", () => {
	test("復号を待ちきれずに捨てたら、次の鍵フレームまで差分を渡さない", async () => {
		made.length = 0;
		const avc = new WebCodecsAvc();
		expect(await avc.decode(concat(SPS, IDR), true)).toBeNull(); // 1 秒待って捨てる
		const dec = made[0] as FakeDecoder;
		expect(dec.chunks).toEqual(["key"]);
		// 差分は渡さない
		expect(await avc.decode(P, false)).toBeNull();
		expect(dec.chunks).toEqual(["key"]);
		avc.close();
	}, 5000);

	test("close() のあとは復号器を作り直さない", async () => {
		made.length = 0;
		const avc = new WebCodecsAvc();
		avc.close();
		expect(await avc.decode(concat(SPS, IDR), true)).toBeNull();
		expect(made.length).toBe(0);
	});
});

describe("CanvasGfxOps の AVC444", () => {
	test("WebGL2 が無ければ GPU のものを出さない(CPU で組み立てる)。作るのは 1 回だけ試す", () => {
		let tried = 0;
		const ops = new CanvasGfxOps({} as Display, () => {
			tried++;
			return undefined;
		});
		expect(ops.yuv444(1, 16, 16)).toBeUndefined();
		expect(ops.yuv444(2, 16, 16)).toBeUndefined();
		expect(tried).toBe(1);
	});

	test("試験の環境(canvas が無い)では、そのまま CPU になる", () => {
		const ops = new CanvasGfxOps({} as Display);
		const warn = console.warn;
		console.warn = () => {};
		try {
			expect(ops.yuv444(1, 16, 16)).toBeUndefined();
		} finally {
			console.warn = warn;
		}
	});
});
