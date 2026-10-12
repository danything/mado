// ZGFX を伸長する速さを計る。試験用の符号化器で作ったデータを何度も伸長して、MB/s を出す。
//   wslc run --rm -v "<repo>:/app" -w /app oven/bun:1 bun tools/zgfx-bench.ts

import { Zgfx } from "../web/rdp/zgfx";
import { encode } from "../web/rdp/zgfx.fixture";

// 画面の更新に近い、繰り返しの多い 64KB のデータ
const n = 64 * 1024;
const data = new Uint8Array(n);
let seed = 1;
for (let i = 0; i < n; i++) {
	seed = (seed * 1103515245 + 12345) >>> 0;
	data[i] = i % 97 < 60 ? (data[i - 7] ?? 0) : seed >>> 24;
}
const packed = encode(data);
const z = new Zgfx();
for (let i = 0; i < 20; i++) z.decompress(packed);
const rounds = 200;
const t0 = performance.now();
for (let i = 0; i < rounds; i++) z.decompress(packed);
const ms = performance.now() - t0;
console.log(
	`${(packed.length / 1024).toFixed(1)} KB → ${(n / 1024).toFixed(0)} KB: ${(ms / rounds).toFixed(3)} ms / 回、${((n * rounds) / 1e6 / (ms / 1000)).toFixed(1)} MB/s`,
);
