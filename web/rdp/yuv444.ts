// AVC444 / AVC444v2([MS-RDPEGFX] 2.2.4.5・2.2.4.6・3.3.8.3)の YUV444 の組み立て。
// 主の絵と補助の絵を、面ごとの YUV444 に重ねる。主の絵は YUV420 そのもの。補助の絵は、4:4:4 にするのに足りない色差を YUV420 の形に詰めたもの。
// 並べ方と色差の戻し方は FreeRDP の prim_YUV.c(general_LumaToYUV444・ChromaV1ToYUV444・ChromaV2ToYUV444・ChromaFilter)と同じ。

import type { Rect } from "./gfx";

/** 復号した YUV420 の 1 枚。I420 の 3 面。width / height は面の大きさで、切り取る前の符号化の大きさのこともある */
export type Yuv420 = {
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
  yStride: number;
  uStride: number;
  vStride: number;
  /** NV12 のときの、U と V が交互に並ぶ面。GPU はこれをそのまま使う(u / v は読んだときに分ける) */
  uv?: Uint8Array;
  uvStride?: number;
};

/** RGBA を面に置く。CPU で組み立てたときに使う */
type PutRgba = (
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: Uint8ClampedArray,
) => void;

/** 面 1 枚ぶんの YUV444 の組み立て。CPU の Yuv444 と、GPU の Yuv444GlTarget がある */
export interface Yuv444Target {
  readonly width: number;
  readonly height: number;
  luma(p: Yuv420, rects: Rect[]): void;
  chroma(p: Yuv420, v2: boolean, rects: Rect[]): boolean;
  /** rects(面の中の座標)を、(x, y) をずらして描く。CPU は put に RGBA を渡す。GPU を失って描けなければ false */
  draw(rects: Rect[], x: number, y: number, put: PutRgba): boolean;
  close(): void;
}

/** 色差を戻したとき、元の主の絵との差がこれより小さければ元のままにする。圧縮の雑音で色がにじまないように。FreeRDP の CONDITIONAL_CLIP */
const FILTER_THRESHOLD = 30;

const clip = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** CPU で持つ YUV444 の 3 面。Y=0、U=V=128 から始める。Yuv444 と Yuv444GlRef が使う */
abstract class CpuYuv444 implements Yuv444Target {
  readonly y: Uint8Array;
  readonly u: Uint8Array;
  readonly v: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.y = new Uint8Array(width * height);
    this.u = new Uint8Array(width * height).fill(128);
    this.v = new Uint8Array(width * height).fill(128);
  }

  abstract luma(p: Yuv420, rects: Rect[]): void;
  abstract chroma(p: Yuv420, v2: boolean, rects: Rect[]): boolean;
  /** 矩形を RGBA にする */
  abstract rgba(r: Rect): Uint8ClampedArray;

  draw(rects: Rect[], x: number, y: number, put: PutRgba): boolean {
    for (const r of rects)
      put(
        x + r.left,
        y + r.top,
        r.right - r.left,
        r.bottom - r.top,
        this.rgba(r),
      );
    return true;
  }

  close(): void {}
}

/** 面 1 枚ぶんの YUV444。主の絵と補助の絵は別々に来る。片方だけのこともあるので、前のものを持っておく */
export class Yuv444 extends CpuYuv444 {
  /** 最後の主の絵。偶数の行・列の色差を戻すのに使う */
  private main?: Yuv420;

  /** 主の絵。Y はそのまま、色差は 2x2 に広げる。補助の絵が来るまでは 4:2:0 の色になる */
  luma(p: Yuv420, rects: Rect[]): void {
    this.main = p;
    const W = this.width;
    for (const r of evenRects(rects, W, this.height, p)) {
      for (let y = r.top; y < r.bottom; y++) {
        const s = y * p.yStride;
        this.y.set(p.y.subarray(s + r.left, s + r.right), y * W + r.left);
      }
      for (let y = r.top; y < r.bottom; y += 2) {
        const su = (y >> 1) * p.uStride;
        const sv = (y >> 1) * p.vStride;
        const d0 = y * W;
        const d1 = y + 1 < r.bottom ? d0 + W : d0;
        for (let x = r.left; x < r.right; x += 2) {
          const cu = p.u[su + (x >> 1)] as number;
          const cv = p.v[sv + (x >> 1)] as number;
          this.u[d0 + x] = cu;
          this.v[d0 + x] = cv;
          this.u[d1 + x] = cu;
          this.v[d1 + x] = cv;
          if (x + 1 < r.right) {
            this.u[d0 + x + 1] = cu;
            this.v[d0 + x + 1] = cv;
            this.u[d1 + x + 1] = cu;
            this.v[d1 + x + 1] = cv;
          }
        }
      }
    }
  }

  /**
   * 補助の絵。偶数の行・列のところ以外は、足りない色差をここから埋める。偶数の行・列は主の絵の平均から戻す。
   * v1: 補助の Y は 16 行ごとに前の 8 行が U、後の 8 行が V の奇数行。補助の U / V は U / V の偶数行・奇数列。
   * v2: 補助の Y は左半分が U、右半分が V の奇数列。補助の U / V は左右の 4 分の 1 ずつが U / V の奇数行の 4 の倍数の列(U)と +2 の列(V)
   */
  chroma(p: Yuv420, v2: boolean, rects: Rect[]): boolean {
    const main = this.main;
    if (!main) return false; // 主の絵がまだ無い。戻せないので待つ
    const W = this.width;
    const U = this.u;
    const V = this.v;
    for (const r of evenRects(rects, W, this.height)) {
      if (!v2) {
        // B4 / B5: 奇数行の全部の列
        for (let y = r.top + 1; y < r.bottom; y += 2) {
          const k = y >> 1;
          const base = (k >> 3) * 16 + (k & 7);
          const ru = base;
          const rv = base + 8;
          const d = y * W;
          if (ru < p.height)
            U.set(
              p.y.subarray(ru * p.yStride + r.left, ru * p.yStride + r.right),
              d + r.left,
            );
          if (rv < p.height)
            V.set(
              p.y.subarray(rv * p.yStride + r.left, rv * p.yStride + r.right),
              d + r.left,
            );
        }
        // B6 / B7: 偶数行の奇数列
        for (let y = r.top; y < r.bottom && y < p.height; y += 2) {
          const su = (y >> 1) * p.uStride;
          const sv = (y >> 1) * p.vStride;
          const d = y * W;
          for (let x = r.left + 1; x < r.right; x += 2) {
            U[d + x] = p.u[su + (x >> 1)] as number;
            V[d + x] = p.v[sv + (x >> 1)] as number;
          }
        }
      } else {
        const halfW = W >> 1;
        const quarterW = W >> 2;
        // B4 / B5: 全部の行の奇数列(補助の Y の左半分が U、右半分が V)
        for (let y = r.top; y < r.bottom && y < p.height; y++) {
          const s = y * p.yStride;
          const d = y * W;
          for (let x = r.left + 1; x < r.right; x += 2) {
            U[d + x] = p.y[s + (x >> 1)] as number;
            V[d + x] = p.y[s + halfW + (x >> 1)] as number;
          }
        }
        // B6 - B9: 奇数行の偶数列。4 の倍数の列は補助の U、+2 の列は補助の V(どちらも左 4 分の 1 が U、次の 4 分の 1 が V)
        for (let y = r.top + 1; y < r.bottom; y += 2) {
          const k = y >> 1;
          if (k >= p.height >> 1) continue;
          const su = k * p.uStride;
          const sv = k * p.vStride;
          const d = y * W;
          for (let x = r.left; x < r.right; x += 2) {
            const j = x >> 2;
            if ((x & 3) === 0) {
              U[d + x] = p.u[su + j] as number;
              V[d + x] = p.u[su + quarterW + j] as number;
            } else {
              U[d + x] = p.v[sv + j] as number;
              V[d + x] = p.v[sv + quarterW + j] as number;
            }
          }
        }
      }
      this.filter(main, r);
    }
    return true;
  }

  /** 偶数の行・列。主の絵の色差は 2x2 の平均なので、4 倍から残りの 3 つを引いて戻す */
  private filter(main: Yuv420, r: Rect): void {
    const W = this.width;
    const U = this.u;
    const V = this.v;
    for (let y = r.top; y + 1 < r.bottom; y += 2) {
      const su = (y >> 1) * main.uStride;
      const sv = (y >> 1) * main.vStride;
      const d0 = y * W;
      const d1 = d0 + W;
      for (let x = r.left; x + 1 < r.right; x += 2) {
        const mu = main.u[su + (x >> 1)] as number;
        const mv = main.v[sv + (x >> 1)] as number;
        const cu = clip(
          4 * mu -
            (U[d0 + x + 1] as number) -
            (U[d1 + x] as number) -
            (U[d1 + x + 1] as number),
        );
        const cv = clip(
          4 * mv -
            (V[d0 + x + 1] as number) -
            (V[d1 + x] as number) -
            (V[d1 + x + 1] as number),
        );
        U[d0 + x] = Math.abs(cu - mu) < FILTER_THRESHOLD ? mu : cu;
        V[d0 + x] = Math.abs(cv - mv) < FILTER_THRESHOLD ? mv : cv;
      }
    }
  }

  /** BT.709 のフル レンジ。係数は FreeRDP の YUV2R / YUV2G / YUV2B と同じ */
  rgba(r: Rect): Uint8ClampedArray {
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    const out = new Uint8ClampedArray(w * h * 4);
    const W = this.width;
    let o = 0;
    for (let y = r.top; y < r.bottom; y++) {
      let i = y * W + r.left;
      for (let x = 0; x < w; x++, i++) {
        const Y = (this.y[i] as number) * 256;
        const d = (this.u[i] as number) - 128;
        const e = (this.v[i] as number) - 128;
        // Uint8ClampedArray が 0..255 に切る
        out[o++] = (Y + 403 * e) >> 8;
        out[o++] = (Y - 48 * d - 120 * e) >> 8;
        out[o++] = (Y + 475 * d) >> 8;
        out[o++] = 255;
      }
    }
    return out;
  }
}

/** 矩形を面(W x H)に収め、色差の 2x2 に合わせて偶数に広げる。p を渡すと、その絵にある範囲にも収める */
function evenRect(r: Rect, W: number, H: number, p?: Yuv420): Rect | undefined {
  const right = Math.min(W, p ? p.width : W, r.right + (r.right & 1));
  const bottom = Math.min(H, p ? p.height : H, r.bottom + (r.bottom & 1));
  const left = Math.max(0, r.left & ~1);
  const top = Math.max(0, r.top & ~1);
  return right > left && bottom > top
    ? { left, top, right, bottom }
    : undefined;
}

/** evenRect をそれぞれにかけ、空になったものを除く */
function evenRects(rects: Rect[], W: number, H: number, p?: Yuv420): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const e = evenRect(r, W, H, p);
    if (e) out.push(e);
  }
  return out;
}

/** WebCodecs の VideoFrame のうち、ここで使うところ */
export type VideoFrameYuv = {
  format: string | null;
  codedWidth: number;
  codedHeight: number;
  visibleRect: { x: number; y: number; width: number; height: number } | null;
  allocationSize(options?: { rect?: DOMRectInit }): number;
  copyTo(
    dest: Uint8Array,
    options?: { rect?: DOMRectInit },
  ): Promise<{ offset: number; stride: number }[]>;
};

/**
 * VideoFrame から I420 の 3 面を取り出す(NV12 は U / V に分ける)。それ以外の形式は undefined。
 * 補助の絵(v1)は 16 行に揃えた下の端も使うので、できれば切り取る前の全体(codedRect)を読む
 */
export async function videoFrameYuv(
  frame: VideoFrameYuv,
): Promise<Yuv420 | undefined> {
  const format = frame.format;
  if (format !== "I420" && format !== "I420A" && format !== "NV12")
    return undefined;
  const coded = {
    x: 0,
    y: 0,
    width: frame.codedWidth,
    height: frame.codedHeight,
  };
  let rect: DOMRectInit | undefined = coded;
  let size: number;
  try {
    size = frame.allocationSize({ rect });
  } catch {
    rect = undefined;
    size = frame.allocationSize();
  }
  const width = rect ? coded.width : (frame.visibleRect?.width ?? 0);
  const height = rect ? coded.height : (frame.visibleRect?.height ?? 0);
  const buf = new Uint8Array(size);
  const layout = await frame.copyTo(buf, rect ? { rect } : undefined);
  const [py, p1, p2] = layout;
  if (!py || !p1) return undefined;
  const y = buf.subarray(py.offset, py.offset + py.stride * height);
  const ch = (height + 1) >> 1;
  if (format !== "NV12") {
    if (!p2) return undefined;
    return {
      width,
      height,
      y,
      u: buf.subarray(p1.offset, p1.offset + p1.stride * ch),
      v: buf.subarray(p2.offset, p2.offset + p2.stride * ch),
      yStride: py.stride,
      uStride: p1.stride,
      vStride: p2.stride,
    };
  }
  // NV12: UV が交互に並ぶ 1 面。GPU は uv をそのまま使うので、U / V に分けるのは u / v を読んだとき
  const cw = (width + 1) >> 1;
  const uv = buf.subarray(p1.offset, p1.offset + p1.stride * ch);
  const uvStride = p1.stride;
  let split: { u: Uint8Array; v: Uint8Array } | undefined;
  const planes = () => {
    if (split) return split;
    const u = new Uint8Array(cw * ch);
    const v = new Uint8Array(cw * ch);
    for (let j = 0; j < ch; j++) {
      const s = j * uvStride;
      const d = j * cw;
      for (let i = 0; i < cw; i++) {
        u[d + i] = uv[s + 2 * i] as number;
        v[d + i] = uv[s + 2 * i + 1] as number;
      }
    }
    split = { u, v };
    return split;
  };
  return {
    width,
    height,
    y,
    get u() {
      return planes().u;
    },
    get v() {
      return planes().v;
    },
    yStride: py.stride,
    uStride: cw,
    vStride: cw,
    uv,
    uvStride,
  };
}

// ---- GPU(WebGL2)での組み立て ----
// 復号した絵は copyTo で読み出すしかない。VideoFrame を GPU のまま使うと、ブラウザが RGB に変えてしまい、補助の絵の生の値が取れない。
// 読み出した面をそのままテクスチャに送り、重ねる計算と RGB への変換はシェーダーで行う。JS で 1 画素ずつ回す処理が無くなる。
// 面ごとの YUV444 は RGBA8UI のテクスチャ(r=Y、g=U、b=V)に持つ。計算は Yuv444 と同じ整数で行うので、結果も同じになる。
// シェーダーと同じ計算を TS で書いたもの(Yuv444GlRef)を、試験で Yuv444 と比べる。片方を直したら、もう片方も直す。

type GlPlane = { d: Uint8Array; s: number; w: number; h: number };
type GlPlanes = { y: GlPlane; u: GlPlane; v: GlPlane };

/** 面の外を読んだら 0(GLSL の at と同じ) */
function texel(t: GlPlane, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= t.w || y >= t.h) return 0;
  return t.d[y * t.s + x] as number;
}

/** テクスチャに送る大きさ。Y は絵の大きさ、U / V はその半分(切り上げ) */
function glPlanes(p: Yuv420): GlPlanes {
  const cw = (p.width + 1) >> 1;
  const ch = (p.height + 1) >> 1;
  return {
    y: { d: p.y, s: p.yStride, w: p.width, h: p.height },
    u: { d: p.u, s: p.uStride, w: cw, h: ch },
    v: { d: p.v, s: p.vStride, w: cw, h: ch },
  };
}

/** 補助の絵の 1 画素ぶんの U / V(偶数の行・列のところ以外)。補助の絵に無い位置は old のまま。GLSL の aux と同じ */
function auxAt(
  a: GlPlanes,
  v2: boolean,
  W: number,
  x: number,
  y: number,
  old: [number, number],
): [number, number] {
  const ah = a.y.h;
  if (!v2) {
    if (y & 1) {
      const k = y >> 1;
      const base = (k >> 3) * 16 + (k & 7);
      return [
        base < ah ? texel(a.y, x, base) : old[0],
        base + 8 < ah ? texel(a.y, x, base + 8) : old[1],
      ];
    }
    if (y < ah) return [texel(a.u, x >> 1, y >> 1), texel(a.v, x >> 1, y >> 1)];
    return old;
  }
  if (x & 1) {
    if (y < ah)
      return [texel(a.y, x >> 1, y), texel(a.y, (W >> 1) + (x >> 1), y)];
    return old;
  }
  const k = y >> 1;
  if (k >= ah >> 1) return old;
  const j = x >> 2;
  const q = W >> 2;
  if ((x & 3) === 0) return [texel(a.u, j, k), texel(a.u, q + j, k)];
  return [texel(a.v, j, k), texel(a.v, q + j, k)];
}

/** 偶数の行・列: 4 倍の平均から残りの 3 つを引く。元と 30 未満の差なら元のまま。GLSL の filtered と同じ */
function filteredAt(
  m: [number, number],
  n: [number, number][],
): [number, number] {
  const out: [number, number] = [0, 0];
  for (const i of [0, 1] as const) {
    let s = 4 * m[i];
    for (const c of n) s -= c[i];
    const c = clip(s);
    out[i] = Math.abs(c - m[i]) < FILTER_THRESHOLD ? m[i] : c;
  }
  return out;
}

/** RGB。GLSL の出力と同じで、Yuv444.rgba とも同じ */
function rgbAt(Y: number, U: number, V: number): [number, number, number] {
  const y = Y * 256;
  const d = U - 128;
  const e = V - 128;
  return [
    clip((y + 403 * e) >> 8),
    clip((y - 48 * d - 120 * e) >> 8),
    clip((y + 475 * d) >> 8),
  ];
}

/** シェーダーの計算を TS で書いたもの(試験用)。GPU と同じく、状態から読んで別の面に描き、矩形を写し戻す */
export class Yuv444GlRef extends CpuYuv444 {
  private main?: GlPlanes;

  luma(p: Yuv420, rects: Rect[]): void {
    const m = glPlanes(p);
    this.main = m;
    const W = this.width;
    for (const r of evenRects(rects, W, this.height, p)) {
      for (let y = r.top; y < r.bottom; y++)
        for (let x = r.left; x < r.right; x++) {
          const i = y * W + x;
          this.y[i] = texel(m.y, x, y);
          this.u[i] = texel(m.u, x >> 1, y >> 1);
          this.v[i] = texel(m.v, x >> 1, y >> 1);
        }
    }
  }

  chroma(p: Yuv420, v2: boolean, rects: Rect[]): boolean {
    const m = this.main;
    if (!m) return false;
    const a = glPlanes(p);
    const W = this.width;
    const prev = (x: number, y: number): [number, number] => [
      this.u[y * W + x] as number,
      this.v[y * W + x] as number,
    ];
    const aux = (x: number, y: number) => auxAt(a, v2, W, x, y, prev(x, y));
    const outU = this.u.slice();
    const outV = this.v.slice();
    const list = evenRects(rects, W, this.height);
    for (const r of list) {
      for (let y = r.top; y < r.bottom; y++)
        for (let x = r.left; x < r.right; x++) {
          let c: [number, number];
          if (x & 1 || y & 1) c = aux(x, y);
          else if (x + 1 >= r.right || y + 1 >= r.bottom) c = prev(x, y);
          else
            c = filteredAt(
              [texel(m.u, x >> 1, y >> 1), texel(m.v, x >> 1, y >> 1)],
              [aux(x + 1, y), aux(x, y + 1), aux(x + 1, y + 1)],
            );
          outU[y * W + x] = c[0];
          outV[y * W + x] = c[1];
        }
    }
    for (const r of list)
      for (let y = r.top; y < r.bottom; y++) {
        const s = y * W + r.left;
        const e = y * W + r.right;
        this.u.set(outU.subarray(s, e), s);
        this.v.set(outV.subarray(s, e), s);
      }
    return true;
  }

  rgba(r: Rect): Uint8ClampedArray {
    const w = r.right - r.left;
    const out = new Uint8ClampedArray(w * (r.bottom - r.top) * 4);
    let o = 0;
    for (let y = r.top; y < r.bottom; y++)
      for (let x = r.left; x < r.right; x++) {
        const i = y * this.width + x;
        out.set(
          rgbAt(this.y[i] as number, this.u[i] as number, this.v[i] as number),
          o,
        );
        out[o + 3] = 255;
        o += 4;
      }
    return out;
  }
}

const GLSL_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
int at(usampler2D t, ivec2 p) {
	ivec2 s = textureSize(t, 0);
	if (p.x < 0 || p.y < 0 || p.x >= s.x || p.y >= s.y) return 0;
	return int(texelFetch(t, p, 0).r);
}
ivec2 at2(usampler2D t, ivec2 p) {
	ivec2 s = textureSize(t, 0);
	if (p.x < 0 || p.y < 0 || p.x >= s.x || p.y >= s.y) return ivec2(0);
	return ivec2(texelFetch(t, p, 0).rg);
}
uniform usampler2D uMY, uMU, uMV, uMUV;
uniform bool uMNv12;
ivec2 mainUV(ivec2 c) {
	return uMNv12 ? at2(uMUV, c) : ivec2(at(uMU, c), at(uMV, c));
}
`;

/** 画面全体を覆う三角形 1 つ。描く範囲ははさみ(scissor)で切る */
const VERTEX = `#version 300 es
void main() {
	gl_Position = vec4(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID & 2) * 2 - 1), 0.0, 1.0);
}
`;

/** 主の絵。Y はそのまま、色差は 2x2 に広げる(Yuv444.luma) */
const LUMA = `${GLSL_HEAD}
out uvec4 o;
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	o = uvec4(uint(at(uMY, p)), uvec2(mainUV(p >> 1)), 255u);
}
`;

/** 補助の絵(Yuv444.chroma)。auxAt・filteredAt と同じ計算 */
const CHROMA = `${GLSL_HEAD}
uniform usampler2D uState;
uniform usampler2D uAY, uAU, uAV, uAUV;
uniform bool uANv12;
uniform bool uV2;
uniform int uW;
uniform ivec4 uRect;
out uvec4 o;
int auxU(ivec2 c) { return uANv12 ? at2(uAUV, c).x : at(uAU, c); }
int auxV(ivec2 c) { return uANv12 ? at2(uAUV, c).y : at(uAV, c); }
ivec2 aux(ivec2 p) {
	ivec2 old = ivec2(texelFetch(uState, p, 0).gb);
	int ah = textureSize(uAY, 0).y;
	if (!uV2) {
		if ((p.y & 1) == 1) {
			int k = p.y >> 1;
			int base = (k >> 3) * 16 + (k & 7);
			return ivec2(base < ah ? at(uAY, ivec2(p.x, base)) : old.x,
				base + 8 < ah ? at(uAY, ivec2(p.x, base + 8)) : old.y);
		}
		if (p.y < ah) return ivec2(auxU(p >> 1), auxV(p >> 1));
		return old;
	}
	if ((p.x & 1) == 1) {
		if (p.y < ah) return ivec2(at(uAY, ivec2(p.x >> 1, p.y)), at(uAY, ivec2((uW >> 1) + (p.x >> 1), p.y)));
		return old;
	}
	int k = p.y >> 1;
	if (k >= (ah >> 1)) return old;
	int j = p.x >> 2;
	int q = uW >> 2;
	if ((p.x & 3) == 0) return ivec2(auxU(ivec2(j, k)), auxU(ivec2(q + j, k)));
	return ivec2(auxV(ivec2(j, k)), auxV(ivec2(q + j, k)));
}
ivec2 filtered(ivec2 p) {
	ivec2 m = mainUV(p >> 1);
	ivec2 c = clamp(4 * m - aux(p + ivec2(1, 0)) - aux(p + ivec2(0, 1)) - aux(p + ivec2(1, 1)), 0, 255);
	return ivec2(abs(c.x - m.x) < ${FILTER_THRESHOLD} ? m.x : c.x, abs(c.y - m.y) < ${FILTER_THRESHOLD} ? m.y : c.y);
}
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	uvec4 s = texelFetch(uState, p, 0);
	ivec2 c;
	if ((p.x & 1) == 1 || (p.y & 1) == 1) c = aux(p);
	else if (p.x + 1 >= uRect.z || p.y + 1 >= uRect.w) c = ivec2(s.gb);
	else c = filtered(p);
	o = uvec4(s.r, uvec2(c), 255u);
}
`;

/** RGB へ(rgbAt と同じ)。canvas の行は下から数えるので、上から数え直す */
const OUTPUT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uState;
uniform int uOutH;
out vec4 o;
void main() {
	ivec2 f = ivec2(gl_FragCoord.xy);
	ivec3 s = ivec3(texelFetch(uState, ivec2(f.x, uOutH - 1 - f.y), 0).rgb);
	int y = s.x * 256;
	int d = s.y - 128;
	int e = s.z - 128;
	ivec3 c = clamp(ivec3(y + 403 * e, y - 48 * d - 120 * e, y + 475 * d) >> 8, 0, 255);
	o = vec4(vec3(c) / 255.0, 1.0);
}
`;

/** テクスチャの番号。どのシェーダーでも同じ番号を使う */
const UNIT = {
  uState: 0,
  uMY: 1,
  uMU: 2,
  uMV: 3,
  uMUV: 4,
  uAY: 5,
  uAU: 6,
  uAV: 7,
  uAUV: 8,
} as const;

type Program = {
  p: WebGLProgram;
  u: (name: string) => WebGLUniformLocation | null;
};

function program(gl: WebGL2RenderingContext, fs: string): Program {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error("createShader");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(`シェーダー: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram();
  if (!p) throw new Error("createProgram");
  gl.attachShader(p, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`リンク: ${gl.getProgramInfoLog(p)}`);
  const locs = new Map<string, WebGLUniformLocation | null>();
  const u = (name: string) => {
    if (!locs.has(name)) locs.set(name, gl.getUniformLocation(p, name));
    return locs.get(name) ?? null;
  };
  gl.useProgram(p);
  for (const [name, unit] of Object.entries(UNIT)) gl.uniform1i(u(name), unit);
  return { p, u };
}

/** 整数のテクスチャ。整数は補間できないので NEAREST にする */
function texture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error("createTexture");
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // 使う前から 1x1 を置いておく。中身の無いテクスチャがあると描けないことがある
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8UI,
    1,
    1,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_BYTE,
    new Uint8Array(1),
  );
  return t;
}

/** YUV420 の 1 枚を置くテクスチャ。Y / U / V は R8UI、NV12 の UV は RG8UI */
class TexPlanes {
  readonly y: WebGLTexture;
  readonly u: WebGLTexture;
  readonly v: WebGLTexture;
  readonly uv: WebGLTexture;
  nv12 = false;
  private sizes = new Map<WebGLTexture, string>();

  constructor(private gl: WebGL2RenderingContext) {
    this.y = texture(gl);
    this.u = texture(gl);
    this.v = texture(gl);
    this.uv = texture(gl);
  }

  upload(p: Yuv420): void {
    const gl = this.gl;
    const cw = (p.width + 1) >> 1;
    const ch = (p.height + 1) >> 1;
    this.put(
      this.y,
      gl.R8UI,
      gl.RED_INTEGER,
      p.width,
      p.height,
      p.y,
      p.yStride,
    );
    // NV12 は U と V を分けずに送る。1 行のバイト数が奇数なら画素の数にできないので、分けて送る
    const uvStride = p.uvStride ?? 0;
    this.nv12 = p.uv !== undefined && uvStride > 0 && (uvStride & 1) === 0;
    if (p.uv && this.nv12) {
      this.put(this.uv, gl.RG8UI, gl.RG_INTEGER, cw, ch, p.uv, uvStride >> 1);
      return;
    }
    this.put(this.u, gl.R8UI, gl.RED_INTEGER, cw, ch, p.u, p.uStride);
    this.put(this.v, gl.R8UI, gl.RED_INTEGER, cw, ch, p.v, p.vStride);
  }

  /** rowLength は 1 行の画素の数(バイトの数ではない) */
  private put(
    t: WebGLTexture,
    internal: number,
    format: number,
    w: number,
    h: number,
    data: Uint8Array,
    rowLength: number,
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
    const size = `${w}x${h}`;
    if (this.sizes.get(t) !== size) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        internal,
        w,
        h,
        0,
        format,
        gl.UNSIGNED_BYTE,
        data,
      );
      this.sizes.set(t, size);
    } else
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        w,
        h,
        format,
        gl.UNSIGNED_BYTE,
        data,
      );
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  /** 主の絵(M)は 1 から、補助の絵(A)は 5 からの番号に */
  bind(which: "M" | "A"): void {
    const gl = this.gl;
    const first = which === "M" ? UNIT.uMY : UNIT.uAY;
    [this.y, this.u, this.v, this.uv].forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + first + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
  }

  delete(): void {
    for (const t of [this.y, this.u, this.v, this.uv]) this.gl.deleteTexture(t);
  }
}

/** GPU で組み立てた矩形を面へ写す。src の (sx, sy) から w x h を、面の (dx, dy) へ */
export type GlBlit = (
  src: CanvasImageSource,
  sx: number,
  sy: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
) => void;

type GlCanvas = OffscreenCanvas | HTMLCanvasElement;

/** WebGL2 の文脈 1 つを、全部の面で共用する。一度失敗したら(シェーダー・文脈の喪失・GL のエラー)二度と使わない */
export class Yuv444Gl {
  private broken = false;
  private checked = false;
  /** 補助の絵は描き終えたら要らないので、全部の面で共用する */
  readonly aux: TexPlanes;
  readonly luma: Program;
  readonly chroma: Program;
  readonly output: Program;

  private constructor(
    readonly canvas: GlCanvas,
    readonly gl: WebGL2RenderingContext,
    private log: (m: string) => void,
  ) {
    this.luma = program(gl, LUMA);
    this.chroma = program(gl, CHROMA);
    this.output = program(gl, OUTPUT);
    this.aux = new TexPlanes(gl);
    gl.bindVertexArray(gl.createVertexArray());
    canvas.addEventListener("webglcontextlost", () =>
      this.fail("WebGL の文脈を失った"),
    );
  }

  /** WebGL2 が無いときや、シェーダーが通らないときは undefined。理由は log に出す */
  static create(
    log: (m: string) => void = (m) => console.warn(m),
  ): Yuv444Gl | undefined {
    let canvas: GlCanvas | undefined;
    try {
      if (typeof OffscreenCanvas !== "undefined")
        canvas = new OffscreenCanvas(1, 1);
      else if (typeof document !== "undefined")
        canvas = document.createElement("canvas");
      if (!canvas) {
        log("AVC444: canvas が無いので CPU で組み立てる");
        return undefined;
      }
      const gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        // 描いたすぐあとに drawImage で読むので、描いたものを残しておく
        preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null;
      if (!gl) {
        log("AVC444: WebGL2 が使えないので CPU で組み立てる");
        return undefined;
      }
      return new Yuv444Gl(canvas, gl, log);
    } catch (e) {
      log(`AVC444: GPU で組み立てられないので CPU で組み立てる(${e})`);
      return undefined;
    }
  }

  get ok(): boolean {
    return !this.broken && !this.gl.isContextLost();
  }

  fail(why: string): void {
    if (this.broken) return;
    this.broken = true;
    this.log(`AVC444: GPU での組み立てをやめて CPU で組み立てる(${why})`);
  }

  /** GL のエラーは最初の 1 回だけ調べる。getError は GPU を待つので毎回は呼ばない */
  check(): boolean {
    if (!this.checked) {
      this.checked = true;
      const e = this.gl.getError();
      if (e !== this.gl.NO_ERROR) this.fail(`GL のエラー ${e}`);
    }
    return this.ok;
  }

  /** 面 1 枚ぶん。作れなければ undefined */
  target(
    width: number,
    height: number,
    blit: GlBlit,
  ): Yuv444GlTarget | undefined {
    if (!this.ok) return undefined;
    try {
      return new Yuv444GlTarget(this, width, height, blit);
    } catch (e) {
      this.fail(String(e));
      return undefined;
    }
  }
}

/** GPU での面 1 枚ぶんの YUV444。状態は a に持つ。補助の絵は b に描いてから a へ写し戻す */
export class Yuv444GlTarget implements Yuv444Target {
  private main: TexPlanes;
  private a: WebGLTexture;
  private b: WebGLTexture;
  private fa: WebGLFramebuffer;
  private fb: WebGLFramebuffer;
  private hasMain = false;

  constructor(
    private owner: Yuv444Gl,
    readonly width: number,
    readonly height: number,
    private blit: GlBlit,
  ) {
    const gl = owner.gl;
    this.main = new TexPlanes(gl);
    const state = (): [WebGLTexture, WebGLFramebuffer] => {
      const t = gl.createTexture();
      const f = gl.createFramebuffer();
      if (!t || !f) throw new Error("createTexture");
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8UI, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        t,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error("RGBA8UI のテクスチャに描けない");
      // Yuv444 と同じく Y=0、U=V=128 から始める
      gl.clearBufferuiv(gl.COLOR, 0, [0, 128, 128, 255]);
      return [t, f];
    };
    [this.a, this.fa] = state();
    [this.b, this.fb] = state();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** GL を呼ぶところ。例外が出たら GPU をやめる */
  private run(f: () => void): void {
    if (!this.owner.ok) return;
    try {
      f();
    } catch (e) {
      this.owner.fail(String(e));
    }
  }

  /** 矩形ごとに、はさみで切って描く。each で矩形ごとの uniform を置く。flipH は canvas に描くとき(行を下から数える) */
  private pass(rects: Rect[], flipH?: number, each?: (r: Rect) => void): void {
    const gl = this.owner.gl;
    gl.enable(gl.SCISSOR_TEST);
    for (const r of rects) {
      each?.(r);
      const y = flipH === undefined ? r.top : flipH - r.bottom;
      gl.scissor(r.left, y, r.right - r.left, r.bottom - r.top);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  private bindState(t: WebGLTexture | null): void {
    const gl = this.owner.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT.uState);
    gl.bindTexture(gl.TEXTURE_2D, t);
  }

  luma(p: Yuv420, rects: Rect[]): void {
    this.run(() => {
      const gl = this.owner.gl;
      const prog = this.owner.luma;
      this.main.upload(p);
      this.hasMain = true;
      const list = evenRects(rects, this.width, this.height, p);
      if (!list.length) return;
      // 状態を読まずに全部の値を書くので、a に直に描く。描く先を読むことにならないよう、a は外しておく
      this.bindState(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fa);
      gl.viewport(0, 0, this.width, this.height);
      gl.useProgram(prog.p);
      this.main.bind("M");
      gl.uniform1i(prog.u("uMNv12"), this.main.nv12 ? 1 : 0);
      this.pass(list);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    });
  }

  chroma(p: Yuv420, v2: boolean, rects: Rect[]): boolean {
    if (!this.hasMain) return false; // 主の絵がまだ無い。戻せないので待つ
    this.run(() => {
      const gl = this.owner.gl;
      const prog = this.owner.chroma;
      const aux = this.owner.aux;
      aux.upload(p);
      const list = evenRects(rects, this.width, this.height);
      if (!list.length) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.viewport(0, 0, this.width, this.height);
      gl.useProgram(prog.p);
      this.bindState(this.a);
      this.main.bind("M");
      aux.bind("A");
      gl.uniform1i(prog.u("uMNv12"), this.main.nv12 ? 1 : 0);
      gl.uniform1i(prog.u("uANv12"), aux.nv12 ? 1 : 0);
      gl.uniform1i(prog.u("uV2"), v2 ? 1 : 0);
      gl.uniform1i(prog.u("uW"), this.width);
      const rect = prog.u("uRect");
      this.pass(list, undefined, (r) =>
        gl.uniform4i(rect, r.left, r.top, r.right, r.bottom),
      );
      // b に描いた矩形を a へ写し戻す。blit もはさみで切られるが、pass の最後ではさみは外してある
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fa);
      for (const r of list)
        gl.blitFramebuffer(
          r.left,
          r.top,
          r.right,
          r.bottom,
          r.left,
          r.top,
          r.right,
          r.bottom,
          gl.COLOR_BUFFER_BIT,
          gl.NEAREST,
        );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    });
    return true;
  }

  draw(rects: Rect[], x: number, y: number, _put: PutRgba): boolean {
    this.run(() => {
      const gl = this.owner.gl;
      const canvas = this.owner.canvas;
      // canvas は全部の面で共用する。足りなければ大きくする(大きくすると中身は消えるが、描くのはこのあと)
      if (canvas.width < this.width || canvas.height < this.height) {
        canvas.width = Math.max(canvas.width, this.width);
        canvas.height = Math.max(canvas.height, this.height);
      }
      const H = gl.drawingBufferHeight;
      if (gl.drawingBufferWidth < this.width || H < this.height) {
        this.owner.fail("canvas を面の大きさにできない");
        return;
      }
      const prog = this.owner.output;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, H);
      gl.useProgram(prog.p);
      this.bindState(this.a);
      gl.uniform1i(prog.u("uOutH"), H);
      this.pass(rects, H);
      if (!this.owner.check()) return;
      // OffscreenCanvas は描いたものを 1 枚の ImageBitmap にして写す。canvas を矩形ごとに drawImage すると、そのたびに全体を写し取ることがある
      const src =
        "transferToImageBitmap" in canvas
          ? canvas.transferToImageBitmap()
          : canvas;
      try {
        for (const r of rects)
          this.blit(
            src,
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            x + r.left,
            y + r.top,
          );
      } finally {
        if (src !== canvas) (src as ImageBitmap).close();
      }
    });
    return this.owner.ok;
  }

  close(): void {
    const gl = this.owner.gl;
    if (gl.isContextLost()) return;
    this.main.delete();
    gl.deleteTexture(this.a);
    gl.deleteTexture(this.b);
    gl.deleteFramebuffer(this.fa);
    gl.deleteFramebuffer(this.fb);
  }
}
