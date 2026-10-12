// AVC444 の YUV444 の組み立ての試験。仕様([MS-RDPEGFX] 3.3.8.3)どおりに 4:4:4 の絵を主の絵と補助の絵へ分ける素直な符号化と、
// 1 画素ずつ書いた素直な復元とで、Yuv444(v1 / v2)を確かめる。

import { describe, expect, test } from "bun:test";
import type { Rect } from "./gfx";
import {
	clampRects,
	videoFrameYuv,
	type Yuv420,
	Yuv444,
	Yuv444Gl,
	Yuv444GlRef,
} from "./yuv444";

/** 決まった並びの乱数 */
function rng(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return s >> 16;
	};
}

type Img = { y: Uint8Array; u: Uint8Array; v: Uint8Array };

/** 4:4:4 の絵。2x2 の色差の和を 4 の倍数にして、平均から偶数の位置がちょうど戻るようにする */
function image(W: number, H: number, seed: number): Img {
	const r = rng(seed);
	const plane = () => {
		const p = new Uint8Array(W * H);
		for (let i = 0; i < p.length; i++) p[i] = r() & 0xff;
		for (let y = 0; y < H; y += 2)
			for (let x = 0; x < W; x += 2) {
				const s =
					(p[y * W + x] as number) +
					(p[y * W + x + 1] as number) +
					(p[(y + 1) * W + x] as number) +
					(p[(y + 1) * W + x + 1] as number);
				let e = (p[y * W + x] as number) + ((4 - (s % 4)) % 4);
				if (e > 255) e -= 4;
				p[y * W + x] = e;
			}
		return p;
	};
	return { y: plane(), u: plane(), v: plane() };
}

function yuv(
	w: number,
	h: number,
	y: Uint8Array,
	u: Uint8Array,
	v: Uint8Array,
): Yuv420 {
	return {
		width: w,
		height: h,
		y,
		u,
		v,
		yStride: w,
		uStride: w >> 1,
		vStride: w >> 1,
	};
}

/** 主の絵: Y はそのまま、色差は 2x2 の平均 */
function encodeMain(img: Img, W: number, H: number): Yuv420 {
	const u = new Uint8Array((W / 2) * (H / 2));
	const v = new Uint8Array((W / 2) * (H / 2));
	for (let k = 0; k < H / 2; k++)
		for (let j = 0; j < W / 2; j++) {
			const avg = (p: Uint8Array) =>
				((p[2 * k * W + 2 * j] as number) +
					(p[2 * k * W + 2 * j + 1] as number) +
					(p[(2 * k + 1) * W + 2 * j] as number) +
					(p[(2 * k + 1) * W + 2 * j + 1] as number)) /
				4;
			u[k * (W / 2) + j] = avg(img.u);
			v[k * (W / 2) + j] = avg(img.v);
		}
	return yuv(W, H, img.y.slice(), u, v);
}

/** 補助の絵 v1: 補助の Y は 16 行ごとに前 8 行が U、後 8 行が V の奇数行(高さは 16 に揃える)。補助の U / V は偶数行の奇数列 */
function encodeAuxV1(img: Img, W: number, H: number): Yuv420 {
	const PH = Math.ceil(H / 16) * 16;
	const y = new Uint8Array(W * PH);
	const u = new Uint8Array((W / 2) * (PH / 2));
	const v = new Uint8Array((W / 2) * (PH / 2));
	for (let k = 0; k < H / 2; k++) {
		const row = Math.floor(k / 8) * 16 + (k % 8);
		y.set(img.u.subarray((2 * k + 1) * W, (2 * k + 2) * W), row * W);
		y.set(img.v.subarray((2 * k + 1) * W, (2 * k + 2) * W), (row + 8) * W);
		for (let j = 0; j < W / 2; j++) {
			u[k * (W / 2) + j] = img.u[2 * k * W + 2 * j + 1] as number;
			v[k * (W / 2) + j] = img.v[2 * k * W + 2 * j + 1] as number;
		}
	}
	return yuv(W, PH, y, u, v);
}

/** 補助の絵 v2: 補助の Y は左半分が U、右半分が V の奇数列。補助の U / V は奇数行の 4j(U)と 4j+2(V)の列を、左 4 分の 1 に U、次に V */
function encodeAuxV2(img: Img, W: number, H: number): Yuv420 {
	const y = new Uint8Array(W * H);
	const u = new Uint8Array((W / 2) * (H / 2));
	const v = new Uint8Array((W / 2) * (H / 2));
	for (let r = 0; r < H; r++)
		for (let j = 0; j < W / 2; j++) {
			y[r * W + j] = img.u[r * W + 2 * j + 1] as number;
			y[r * W + W / 2 + j] = img.v[r * W + 2 * j + 1] as number;
		}
	for (let k = 0; k < H / 2; k++)
		for (let j = 0; j < W / 4; j++) {
			const o = (2 * k + 1) * W;
			u[k * (W / 2) + j] = img.u[o + 4 * j] as number;
			u[k * (W / 2) + W / 4 + j] = img.v[o + 4 * j] as number;
			v[k * (W / 2) + j] = img.u[o + 4 * j + 2] as number;
			v[k * (W / 2) + W / 4 + j] = img.v[o + 4 * j + 2] as number;
		}
	return yuv(W, H, y, u, v);
}

/** 素直な復元: 画素ごとに、どこから来るかを仕様どおりに引く。偶数の行・列は 4 倍の平均から残りを引き、元と 30 未満の差なら元のまま */
function reference(
	main: Yuv420,
	aux: Yuv420,
	v2: boolean,
	W: number,
	H: number,
): { u: Uint8Array; v: Uint8Array } {
	const at = (p: Uint8Array, stride: number, x: number, y: number) =>
		p[y * stride + x] as number;
	const U = new Uint8Array(W * H);
	const V = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			if (y % 2 === 0 && x % 2 === 0) continue;
			let u: number;
			let v: number;
			if (!v2) {
				if (y % 2 === 1) {
					const k = (y - 1) / 2;
					const row = Math.floor(k / 8) * 16 + (k % 8);
					u = at(aux.y, aux.yStride, x, row);
					v = at(aux.y, aux.yStride, x, row + 8);
				} else {
					u = at(aux.u, aux.uStride, (x - 1) / 2, y / 2);
					v = at(aux.v, aux.vStride, (x - 1) / 2, y / 2);
				}
			} else if (x % 2 === 1) {
				u = at(aux.y, aux.yStride, (x - 1) / 2, y);
				v = at(aux.y, aux.yStride, W / 2 + (x - 1) / 2, y);
			} else if (x % 4 === 0) {
				u = at(aux.u, aux.uStride, x / 4, (y - 1) / 2);
				v = at(aux.u, aux.uStride, W / 4 + x / 4, (y - 1) / 2);
			} else {
				u = at(aux.v, aux.vStride, (x - 2) / 4, (y - 1) / 2);
				v = at(aux.v, aux.vStride, W / 4 + (x - 2) / 4, (y - 1) / 2);
			}
			U[y * W + x] = u;
			V[y * W + x] = v;
		}
	for (let y = 0; y < H; y += 2)
		for (let x = 0; x < W; x += 2) {
			for (const [P, m] of [
				[U, main.u],
				[V, main.v],
			] as const) {
				const avg = at(m, W / 2, x / 2, y / 2);
				const s =
					4 * avg -
					(P[y * W + x + 1] as number) -
					(P[(y + 1) * W + x] as number) -
					(P[(y + 1) * W + x + 1] as number);
				const c = Math.max(0, Math.min(255, s));
				P[y * W + x] = Math.abs(c - avg) < 30 ? avg : c;
			}
		}
	return { u: U, v: V };
}

const W = 32;
const H = 20;
const all: Rect[] = [{ left: 0, top: 0, right: W, bottom: H }];

describe("Yuv444", () => {
	for (const v2 of [false, true]) {
		const name = v2 ? "v2" : "v1";
		test(`${name}: 4:4:4 の絵が戻る(偶数の行・列は元と 30 以上違うときだけ戻す)`, () => {
			const img = image(W, H, v2 ? 7 : 3);
			const main = encodeMain(img, W, H);
			const aux = v2 ? encodeAuxV2(img, W, H) : encodeAuxV1(img, W, H);
			const s = new Yuv444(W, H);
			s.luma(main, all);
			expect(s.chroma(aux, v2, all)).toBe(true);
			expect([...s.y]).toEqual([...img.y]);
			for (const [got, orig, m] of [
				[s.u, img.u, main.u],
				[s.v, img.v, main.v],
			] as const)
				for (let y = 0; y < H; y++)
					for (let x = 0; x < W; x++) {
						const i = y * W + x;
						const avg = m[(y >> 1) * (W / 2) + (x >> 1)] as number;
						const want =
							y % 2 === 0 &&
							x % 2 === 0 &&
							Math.abs((orig[i] as number) - avg) < 30
								? avg
								: orig[i];
						expect([x, y, got[i]]).toEqual([x, y, want]);
					}
		});

		test(`${name}: でたらめな補助の絵でも、素直な復元と一致する`, () => {
			const r = rng(v2 ? 11 : 5);
			const rand = (n: number) => Uint8Array.from({ length: n }, () => r());
			const main = yuv(W, H, rand(W * H), rand((W * H) / 4), rand((W * H) / 4));
			const AH = v2 ? H : 32;
			const aux = yuv(
				W,
				AH,
				rand(W * AH),
				rand((W * AH) / 4),
				rand((W * AH) / 4),
			);
			const s = new Yuv444(W, H);
			s.luma(main, all);
			s.chroma(aux, v2, all);
			const ref = reference(main, aux, v2, W, H);
			expect([...s.u]).toEqual([...ref.u]);
			expect([...s.v]).toEqual([...ref.v]);
		});
	}

	test("主の絵だけ: 色差は 2x2 に広げる。主の絵が無いうちの補助の絵は使わない", () => {
		const s = new Yuv444(4, 2);
		const aux = yuv(
			4,
			16,
			new Uint8Array(64),
			new Uint8Array(16),
			new Uint8Array(16),
		);
		expect(
			s.chroma(aux, false, [{ left: 0, top: 0, right: 4, bottom: 2 }]),
		).toBe(false);
		s.luma(
			yuv(
				4,
				2,
				Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
				Uint8Array.of(10, 20),
				Uint8Array.of(30, 40),
			),
			[{ left: 0, top: 0, right: 4, bottom: 2 }],
		);
		expect([...s.y]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect([...s.u]).toEqual([10, 10, 20, 20, 10, 10, 20, 20]);
		expect([...s.v]).toEqual([30, 30, 40, 40, 30, 30, 40, 40]);
	});

	test("領域の外は変えない(矩形は 2x2 に広げる)", () => {
		const s = new Yuv444(4, 4);
		const main = yuv(
			4,
			4,
			new Uint8Array(16).fill(9),
			new Uint8Array(4).fill(50),
			new Uint8Array(4).fill(60),
		);
		s.luma(main, [{ left: 1, top: 1, right: 2, bottom: 2 }]);
		expect([...s.y]).toEqual([9, 9, 0, 0, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(s.u[2]).toBe(128);
	});

	test("RGBA(BT.709 フル レンジ)", () => {
		const s = new Yuv444(2, 1);
		s.y.set([255, 76]);
		s.u.set([128, 85]);
		s.v.set([128, 255]);
		const px = [...s.rgba({ left: 0, top: 0, right: 2, bottom: 1 })];
		expect(px.slice(0, 4)).toEqual([255, 255, 255, 255]);
		// 赤っぽい色: R = 76 + 1.574 * 127、G = 76 - 0.1875 * -43 - 0.469 * 127、B = 76 + 1.855 * -43
		expect(px.slice(4)).toEqual([255, 24, 0, 255]);
	});

	test("clampRects: 空なら全体、面の外は切る", () => {
		expect(clampRects([], 8, 4)).toEqual([
			{ left: 0, top: 0, right: 8, bottom: 4 },
		]);
		expect(
			clampRects(
				[
					{ left: 4, top: 2, right: 20, bottom: 20 },
					{ left: 9, top: 0, right: 12, bottom: 4 },
				],
				8,
				4,
			),
		).toEqual([{ left: 4, top: 2, right: 8, bottom: 4 }]);
	});
});

describe("videoFrameYuv", () => {
	/** I420 / NV12 の偽の VideoFrame(4x2、codedRect を読めるかを選べる) */
	function frame(format: string | null, codedOk = true) {
		const data =
			format === "NV12"
				? Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 10, 30, 20, 40)
				: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 30, 40);
		const layout =
			format === "NV12"
				? [
						{ offset: 0, stride: 4 },
						{ offset: 8, stride: 4 },
					]
				: [
						{ offset: 0, stride: 4 },
						{ offset: 8, stride: 2 },
						{ offset: 10, stride: 2 },
					];
		const rects: unknown[] = [];
		return {
			rects,
			format,
			codedWidth: 4,
			codedHeight: 2,
			visibleRect: { x: 0, y: 0, width: 4, height: 2 },
			allocationSize(o?: { rect?: unknown }) {
				if (o?.rect && !codedOk) throw new TypeError("rect");
				return data.length;
			},
			async copyTo(dest: Uint8Array, o?: { rect?: unknown }) {
				rects.push(o?.rect);
				dest.set(data);
				return layout;
			},
		};
	}

	test("I420 と NV12(U / V に分ける)。それ以外は使えない", async () => {
		for (const f of ["I420", "NV12"]) {
			const p = await videoFrameYuv(frame(f));
			expect(p?.width).toBe(4);
			expect([...(p?.y ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
			expect([...(p?.u ?? [])]).toEqual([10, 20]);
			expect([...(p?.v ?? [])]).toEqual([30, 40]);
		}
		expect(await videoFrameYuv(frame(null))).toBeUndefined();
		expect(await videoFrameYuv(frame("RGBA"))).toBeUndefined();
	});

	test("codedRect を読めなければ見える範囲を読む", async () => {
		const ok = frame("I420");
		await videoFrameYuv(ok);
		expect(ok.rects).toEqual([{ x: 0, y: 0, width: 4, height: 2 }]);
		const ng = frame("I420", false);
		expect((await videoFrameYuv(ng))?.height).toBe(2);
		expect(ng.rects).toEqual([undefined]);
	});

	test("NV12 は UV の面もそのまま渡す(GPU 用)", async () => {
		const p = await videoFrameYuv(frame("NV12"));
		expect([...(p?.uv ?? [])]).toEqual([10, 30, 20, 40]);
		expect(p?.uvStride).toBe(4);
	});
});

describe("Yuv444GlRef(シェーダーと同じ計算)", () => {
	/** 大きさ w x h の YUV420。U / V の幅と高さは半分の切り上げ */
	function randomYuv(r: () => number, w: number, h: number): Yuv420 {
		const cw = (w + 1) >> 1;
		const ch = (h + 1) >> 1;
		const rand = (n: number) => Uint8Array.from({ length: n }, () => r());
		return {
			width: w,
			height: h,
			y: rand(w * h),
			u: rand(cw * ch),
			v: rand(cw * ch),
			yStride: w,
			uStride: cw,
			vStride: cw,
		};
	}

	function randomRects(r: () => number, w: number, h: number): Rect[] {
		const n = 1 + (r() % 3);
		const out: Rect[] = [];
		for (let i = 0; i < n; i++) {
			const left = r() % w;
			const top = r() % h;
			out.push({
				left,
				top,
				right: left + 1 + (r() % (w - left)),
				bottom: top + 1 + (r() % (h - top)),
			});
		}
		return out;
	}

	for (const v2 of [false, true])
		for (const [w, h] of [
			[32, 20],
			[34, 22],
			[33, 21],
		] as const)
			test(`${v2 ? "v2" : "v1"} ${w}x${h}: 主・補助・両方をでたらめな矩形で重ねても Yuv444 と同じ`, () => {
				const r = rng(w * 100 + h + (v2 ? 1 : 0));
				const cpu = new Yuv444(w, h);
				const gl = new Yuv444GlRef(w, h);
				// 補助の絵の高さ: 足りる高さと、足りない高さ(無いところは前の値のまま)
				const auxH = v2 ? [h, h - 4] : [Math.ceil(h / 16) * 16, h];
				for (let step = 0; step < 12; step++) {
					const kind = step === 0 ? 1 : r() % 3; // 0: 主だけ、1: 補助だけ、2: 両方
					if (kind !== 1) {
						const p = randomYuv(r, w, h);
						const rects = randomRects(r, w, h);
						cpu.luma(p, rects);
						gl.luma(p, rects);
					}
					if (kind !== 0) {
						const p = randomYuv(r, w, auxH[r() % 2] as number);
						const rects = randomRects(r, w, h);
						expect(gl.chroma(p, v2, rects)).toBe(cpu.chroma(p, v2, rects));
					}
					expect([...gl.y]).toEqual([...cpu.y]);
					expect([...gl.u]).toEqual([...cpu.u]);
					expect([...gl.v]).toEqual([...cpu.v]);
				}
				const full = { left: 0, top: 0, right: w, bottom: h };
				expect([...gl.rgba(full)]).toEqual([...cpu.rgba(full)]);
			});

	test("主の絵が無いうちは補助の絵を使わない", () => {
		const gl = new Yuv444GlRef(4, 2);
		const aux = yuv(
			4,
			16,
			new Uint8Array(64),
			new Uint8Array(16),
			new Uint8Array(16),
		);
		expect(gl.chroma(aux, false, all)).toBe(false);
	});

	test("RGB への変換が Yuv444 と同じ(全部の Y / U / V の組の一部)", () => {
		const n = 256 * 64;
		const cpu = new Yuv444(n, 1);
		const gl = new Yuv444GlRef(n, 1);
		for (let i = 0; i < n; i++) {
			const y = i & 255;
			const u = (i >> 8) * 4;
			const v = (y * 7 + u * 3) & 255;
			for (const s of [cpu, gl]) {
				s.y[i] = y;
				s.u[i] = u;
				s.v[i] = v;
			}
		}
		const r = { left: 0, top: 0, right: n, bottom: 1 };
		expect([...gl.rgba(r)]).toEqual([...cpu.rgba(r)]);
	});
});

describe("Yuv444Gl", () => {
	const g = globalThis as Record<string, unknown>;

	test("canvas も WebGL2 も無ければ undefined。理由を 1 回だけ出す", () => {
		const saved = g.OffscreenCanvas;
		try {
			g.OffscreenCanvas = undefined;
			const logs: string[] = [];
			expect(Yuv444Gl.create((m) => logs.push(m))).toBeUndefined();
			expect(logs.length).toBe(1);
		} finally {
			g.OffscreenCanvas = saved;
		}
	});

	test("getContext が null・シェーダーが通らないときも undefined", () => {
		const saved = g.OffscreenCanvas;
		let ctx: unknown = null;
		g.OffscreenCanvas = class {
			getContext() {
				return ctx;
			}
			addEventListener() {}
		};
		try {
			const logs: string[] = [];
			expect(Yuv444Gl.create((m) => logs.push(m))).toBeUndefined();
			// シェーダーの翻訳に失敗する GL
			ctx = {
				VERTEX_SHADER: 1,
				FRAGMENT_SHADER: 2,
				COMPILE_STATUS: 3,
				createShader: () => ({}),
				shaderSource() {},
				compileShader() {},
				getShaderParameter: () => false,
				getShaderInfoLog: () => "ERROR: 0:1",
				createProgram: () => ({}),
				attachShader() {},
			};
			expect(Yuv444Gl.create((m) => logs.push(m))).toBeUndefined();
			expect(logs.length).toBe(2);
			expect(logs[1]).toContain("ERROR: 0:1");
		} finally {
			g.OffscreenCanvas = saved;
		}
	});
});
