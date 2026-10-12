// 画面の復号を受け持つ Web Worker の入口(rfxpool.ts が束ねて使う)。RemoteFX のタイルと、旧ビットマップ(planar / Interleaved RLE)。
// 受け取るもの: { id, kind: "rfx", mode, data: [Y, Cb, Cr], quant } か { id, kind: "bitmap", rect }
// → 返すもの: { id, rgba }(buffer を渡して返す)か { id, error }

import { type DecodeJob, decodeJob } from "./rfxpool";

/** 仕事(rfxpool.ts の DecodeJob)に、返事と対応づける id を付けたもの */
export type WorkerRequest = DecodeJob & { id: number };

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
		const rgba = decodeJob(req);
		ctx.postMessage({ id: req.id, rgba }, [rgba.buffer]);
	} catch (err) {
		ctx.postMessage({
			id: req.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
};
