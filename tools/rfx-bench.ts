// RemoteFX のタイル復号の計測。実タイル(xrdp から取ったもの)を何度も復号して、1 タイルあたりの時間と内訳を出す。
//   wslc run --rm -v "D:\danything\mado:/app" -w /app oven/bun:1 bun tools/rfx-bench.ts

import { decodeTile, parseQuant, reconstruct, rlgrDecode, yccToRgba } from "../web/rdp/rfx";
import { REAL_TILE, rlgrEncode } from "../web/rdp/rfx.fixture";

const N = Number(process.env.N ?? 10000);
const quant = parseQuant(REAL_TILE.quant);
const data: [Uint8Array, Uint8Array, Uint8Array] = [REAL_TILE.y, REAL_TILE.cb, REAL_TILE.cr];
const quants: [number[], number[], number[]] = [quant, quant, quant];

function time(label: string, f: () => void): number {
	for (let i = 0; i < 500; i++) f(); // 暖機
	const t0 = performance.now();
	for (let i = 0; i < N; i++) f();
	const ms = (performance.now() - t0) / N;
	console.log(`${label.padEnd(22)} ${ms.toFixed(4)} ms/タイル`);
	return ms;
}

const planes = [0, 1, 2].map(() => new Int32Array(4096));
time("RLGR(3 成分)", () => {
	for (let i = 0; i < 3; i++) rlgrDecode(data[i] as Uint8Array, 4, planes[i] as Int32Array);
});
const decoded = planes.map((p) => Int32Array.from(p));
time("逆量子化 + 逆 DWT(3)", () => {
	for (let i = 0; i < 3; i++) {
		const b = Int32Array.from(decoded[i] as Int32Array);
		reconstruct(b, quant);
	}
});
const rec = decoded.map((p) => {
	const b = Int32Array.from(p);
	reconstruct(b, quant);
	return b;
});
time("色変換", () => {
	yccToRgba(rec[0] as Int32Array, rec[1] as Int32Array, rec[2] as Int32Array);
});
const total = time("decodeTile(全部)", () => {
	decodeTile(4, data, quants);
});
console.log(`1080p(510 タイル)の全面更新: ${(total * 510).toFixed(1)} ms`);

// 密なデータ(スクロールで来る文字やウィンドウの縁のような、係数が多いタイル)。ラプラス分布の乱数を RLGR3 / RLGR1 で符号化して復号する
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const dense = (scale: number) => {
	const v = new Int32Array(4096);
	for (let i = 0; i < 4096; i++) v[i] = Math.round((rnd() < 0.5 ? -1 : 1) * -Math.log(1 - rnd()) * scale);
	return v;
};
for (const [mode, name] of [[4, "RLGR3"], [1, "RLGR1"]] as const) {
	const enc = [0, 1, 2].map(() => rlgrEncode(dense(6), mode)) as [Uint8Array, Uint8Array, Uint8Array];
	const out = [0, 1, 2].map(() => new Int32Array(4096));
	time(`密 ${name} 復号のみ`, () => {
		for (let i = 0; i < 3; i++) rlgrDecode(enc[i] as Uint8Array, mode, out[i] as Int32Array);
	});
	const ms = time(`密 ${name} decodeTile`, () => {
		decodeTile(mode, enc, quants);
	});
	console.log(`  1080p 全面: ${(ms * 510).toFixed(1)} ms`);
}
