// 画面の復号の置き場(RemoteFX のタイルと旧ビットマップ)。ブラウザでは Web Worker のプール(メインスレッドを塞がず、複数コアで並列に復号する)、
// それ以外(試験・Worker が作れない環境)では、その場で復号する同じ形のもの。

import { type BitmapJob, decodeBitmap } from "./bitmap";
import { decodeTile } from "./rfx";
import type { WorkerReply, WorkerRequest } from "./rfx.worker";

/** ビルド(tools/build-web.ts)が差し込む、束ねた Worker の URL。ビルドしていない環境(試験など)では未定義 */
declare const __RFX_WORKER__: string | undefined;

type TileData = [Uint8Array, Uint8Array, Uint8Array];
type TileQuant = [number[], number[], number[]];

/** 復号の 1 つの仕事 */
export type DecodeJob =
	| { kind: "rfx"; mode: number; data: TileData; quant: TileQuant }
	| { kind: "bitmap"; rect: BitmapJob };

/** その場で復号する(Worker の中と同じ処理) */
export function decodeJob(j: DecodeJob): Uint8ClampedArray {
	return j.kind === "rfx"
		? decodeTile(j.mode, j.data, j.quant)
		: decodeBitmap(j.rect);
}

export interface TilePool {
	/** true なら run は本当に非同期(完了の順序は保証されない)。false ならその場で復号するので、呼び出し側は同期の経路を使ってよい */
	readonly async: boolean;
	run(job: DecodeJob): Promise<Uint8ClampedArray>;
	terminate(): void;
}

/** その場で復号する */
export class SyncPool implements TilePool {
	readonly async = false;
	run(j: DecodeJob): Promise<Uint8ClampedArray> {
		try {
			return Promise.resolve(decodeJob(j));
		} catch (e) {
			return Promise.reject(e);
		}
	}
	terminate(): void {}
}

type Slot = {
	worker: Worker;
	/** 復号を頼んで、まだ返っていない仕事の数 */
	busy: number;
};

/** Worker の数: コアの数 - 1(メインスレッドの分)、1〜4 */
function poolSize(cores: number): number {
	return Math.max(1, Math.min(4, (Number.isFinite(cores) ? cores : 2) - 1));
}

class WorkerPool implements TilePool {
	readonly async = true;
	private slots: Slot[] = [];
	private waiting = new Map<
		number,
		{
			resolve(v: Uint8ClampedArray): void;
			reject(e: Error): void;
			slot: Slot;
			job: DecodeJob;
		}
	>();
	private nextId = 1;
	/** Worker が読めない(404・MIME など)ときや落ちたときは、その場で復号に切り替える(画面を真っ黒にしない) */
	private fallback = new SyncPool();

	/** Worker が作れなければ例外 */
	constructor(size: number) {
		for (let i = 0; i < size; i++) {
			// ビルドしたものは束ねた Worker の URL、そうでなければ(試験・開発)ソースのまま
			const url =
				typeof __RFX_WORKER__ === "string"
					? __RFX_WORKER__
					: new URL("./rfx.worker.ts", import.meta.url);
			const worker = new Worker(url, { type: "module" });
			const slot: Slot = { worker, busy: 0 };
			worker.onmessage = (e: MessageEvent<WorkerReply>) =>
				this.reply(slot, e.data);
			worker.onerror = (e) =>
				this.fail(slot, new Error(e.message || "Worker のエラー"));
			this.slots.push(slot);
		}
	}

	run(job: DecodeJob): Promise<Uint8ClampedArray> {
		// いちばん空いている Worker へ。生きている Worker が無ければ、その場で復号
		let slot: Slot | undefined;
		for (const s of this.slots) if (!slot || s.busy < slot.busy) slot = s;
		if (!slot) return this.fallback.run(job);
		const id = this.nextId++;
		// 入力は PDU 全体の buffer の一部(subarray)なので、構造化複製だと全体が複製される。小さく切り出して渡す
		let req: WorkerRequest;
		let transfer: ArrayBuffer[];
		if (job.kind === "rfx") {
			const data = job.data.map((d) => d.slice()) as TileData;
			req = { ...job, id, data };
			transfer = data.map((d) => d.buffer as ArrayBuffer);
		} else {
			const { width, height, bpp, compressed } = job.rect;
			const data = job.rect.data.slice();
			req = {
				id,
				kind: "bitmap",
				rect: { width, height, bpp, compressed, data },
			};
			transfer = [data.buffer as ArrayBuffer];
		}
		const target = slot;
		return new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve, reject, slot: target, job });
			target.busy++;
			target.worker.postMessage(req, transfer);
		});
	}

	private reply(slot: Slot, r: WorkerReply): void {
		const w = this.waiting.get(r.id);
		if (!w) return;
		this.waiting.delete(r.id);
		slot.busy--;
		if ("error" in r) w.reject(new Error(r.error));
		else w.resolve(r.rgba);
	}

	/** Worker が読めなかった・落ちた: その Worker は使わず、頼んであったものはその場で復号し直す */
	private fail(slot: Slot, e: Error): void {
		const i = this.slots.indexOf(slot);
		if (i >= 0) {
			this.slots.splice(i, 1);
			slot.worker.terminate();
			console.warn(
				"画面の復号の Worker が使えない。その場で復号する:",
				e.message,
			);
		}
		for (const [id, w] of this.waiting) {
			if (w.slot !== slot) continue;
			this.waiting.delete(id);
			this.fallback.run(w.job).then(w.resolve, w.reject);
		}
	}

	terminate(): void {
		for (const s of this.slots) s.worker.terminate();
		for (const [id, w] of this.waiting) {
			this.waiting.delete(id);
			w.reject(new Error("pool terminated"));
		}
	}
}

/** ブラウザなら Worker のプール、作れなければその場で復号するもの */
export function createPool(): TilePool {
	if (typeof Worker === "undefined") return new SyncPool();
	try {
		return new WorkerPool(
			poolSize(globalThis.navigator?.hardwareConcurrency ?? 2),
		);
	} catch {
		return new SyncPool();
	}
}
