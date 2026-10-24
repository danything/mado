// 旧ビットマップの planar を復号する速さを計る。planar は 32bpp の圧縮形式。
//   bun tools/planar-bench.ts [記録した受信データ]
// 試験用の mini-mado で記録した WebSocket の受信データを渡すと、その中の旧ビットマップの矩形を全部復号する。
// 渡さなければ、合成した 64x64 の planar で計る。YCoCg、色の削減 3、アルファなし、RLE なし。

import * as fs from "node:fs";

import {
  type BitmapRect,
  decodeBitmap,
  parseBitmapUpdate,
} from "../web/rdp/bitmap";
import * as der from "../web/rdp/der";
import { Reassembler, UPDATE } from "../web/rdp/fastpath";

function fromCapture(file: string): BitmapRect[] {
  const buf = new Uint8Array(fs.readFileSync(file));
  let at = 0;
  while (buf[at] === 0x30) at = der.mustRead(buf, at).end; // RDCleanPath の応答と CredSSP
  const re = new Reassembler();
  const rects: BitmapRect[] = [];
  while (at < buf.length) {
    const first = buf[at] as number;
    let len: number;
    let head: number;
    if (first === 3) {
      len = ((buf[at + 2] as number) << 8) | (buf[at + 3] as number);
      head = 4;
    } else {
      len = buf[at + 1] as number;
      head = 2;
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | (buf[at + 2] as number);
        head = 3;
      }
    }
    if (len < head || at + len > buf.length) break;
    const all = buf.subarray(at, at + len);
    at += len;
    if (first !== 3)
      for (const u of re.push(all.subarray(head)))
        if (u.code === UPDATE.BITMAP) rects.push(...parseBitmapUpdate(u.data));
  }
  return rects;
}

function synthetic(n: number): BitmapRect[] {
  const rects: BitmapRect[] = [];
  for (let k = 0; k < n; k++) {
    const data = new Uint8Array(1 + 64 * 64 * 3);
    data[0] = 0x20 | 0x03; // アルファなし、色の削減 3
    for (let i = 1; i < data.length; i++) data[i] = (i * 31 + k * 7) & 0xff;
    rects.push({
      left: 0,
      top: 0,
      right: 63,
      bottom: 63,
      width: 64,
      height: 64,
      bpp: 32,
      compressed: true,
      data,
    });
  }
  return rects;
}

const file = process.argv[2];
const rects = file ? fromCapture(file) : synthetic(5000);
const pixels = rects.reduce((n, r) => n + r.width * r.height, 0);
for (const r of rects) decodeBitmap(r); // 温める
const rounds = 3;
const t0 = performance.now();
for (let k = 0; k < rounds; k++) for (const r of rects) decodeBitmap(r);
const ms = (performance.now() - t0) / rounds;
console.log(
  `${rects.length} 矩形、${(pixels / 1e6).toFixed(1)}M 画素: ${ms.toFixed(0)}ms(${(pixels / 1e6 / (ms / 1000)).toFixed(1)} Mpx/s)`,
);
