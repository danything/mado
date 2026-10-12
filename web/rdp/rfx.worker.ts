// 画面の復号を受け持つ Web Worker の入口(rfxpool.ts が束ねて使う)。RemoteFX のタイルと、旧ビットマップ(planar / Interleaved RLE)。
// 受け取るもの: { id, kind: "rfx", mode, data: [Y, Cb, Cr], quant } か { id, kind: "bitmap", rect }
// → 返すもの: { id, rgba }(buffer を渡して返す)か { id, error }

import { type BitmapJob, decodeBitmap } from "./bitmap";
import { decodeTile } from "./rfx";

export type WorkerRequest =
	| {
			id: number;
			kind: "rfx";
			mode: number;
			data: [Uint8Array, Uint8Array, Uint8Array];
			quant: [number[], number[], number[]];
	  }
	| { id: number; kind: "bitmap"; rect: BitmapJob };

export type WorkerReply =
	| { id: number; rgba: Uint8ClampedArray }
	| { id: number; error: string };

// lib に WebWorker を入れると DOM と衝突するので、必要な口だけを型にする
const ctx = self as unknown as {
	onmessage: ((e: { data: WorkerRequest }) => void) | null;
	postMessage(message: WorkerReply, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
	const req = e.data;
	try {
		const rgba =
			req.kind === "rfx"
				? decodeTile(req.mode, req.data, req.quant)
				: decodeBitmap(req.rect);
		ctx.postMessage({ id: req.id, rgba }, [rgba.buffer]);
	} catch (err) {
		ctx.postMessage({
			id: req.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
};
