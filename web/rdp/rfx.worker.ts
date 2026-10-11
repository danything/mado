// RemoteFX のタイルを復号する Web Worker の入口(rfxpool.ts が束ねて使う)。
// 受け取るもの: { id, mode, data: [Y, Cb, Cr], quant } → 返すもの: { id, rgba }(buffer を渡して返す)か { id, error }

import { decodeTile } from "./rfx";

export type WorkerRequest = {
	id: number;
	mode: number;
	data: [Uint8Array, Uint8Array, Uint8Array];
	quant: [number[], number[], number[]];
};

export type WorkerReply =
	| { id: number; rgba: Uint8ClampedArray }
	| { id: number; error: string };

// lib に WebWorker を入れると DOM と衝突するので、必要な口だけを型にする
const ctx = self as unknown as {
	onmessage: ((e: { data: WorkerRequest }) => void) | null;
	postMessage(message: WorkerReply, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
	const { id, mode, data, quant } = e.data;
	try {
		const rgba = decodeTile(mode, data, quant);
		ctx.postMessage({ id, rgba }, [rgba.buffer]);
	} catch (err) {
		ctx.postMessage({
			id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
};
