// RemoteFX のタイルの復号の置き場。ブラウザでは Web Worker のプール(メインスレッドを塞がず、複数コアで並列に復号する)、
// それ以外(試験・Worker が作れない環境)では、その場で復号する同じ形のもの。

import { decodeTile } from "./rfx";
import type { WorkerReply, WorkerRequest } from "./rfx.worker";

/** ビルド(tools/build-web.ts)が差し込む、束ねた Worker の URL。ビルドしていない環境(試験など)では未定義 */
declare const __RFX_WORKER__: string | undefined;

export type TileData = [Uint8Array, Uint8Array, Uint8Array];
export type TileQuant = [number[], number[], number[]];

export interface TilePool {
	/** true なら decode は本当に非同期(完了の順序は保証されない)。false ならその場で復号するので、呼び出し側は同期の経路を使ってよい */
	readonly async: boolean;
	decode(
		mode: number,
		data: TileData,
		quant: TileQuant,
	): Promise<Uint8ClampedArray>;
	terminate(): void;
}

/** その場で復号する */
export class SyncPool implements TilePool {
	readonly async = false;
	decode(
		mode: number,
		data: TileData,
		quant: TileQuant,
	): Promise<Uint8ClampedArray> {
		try {
			return Promise.resolve(decodeTile(mode, data, quant));
		} catch (e) {
			return Promise.reject(e);
		}
	}
	terminate(): void {}
}

type Slot = {
	worker: Worker;
	/** 復号を頼んで、まだ返っていないタイルの数 */
	busy: number;
};

/** Worker の数: コアの数 - 1(メインスレッドの分)、1〜4 */
export function poolSize(cores: number): number {
	return Math.max(1, Math.min(4, (Number.isFinite(cores) ? cores : 2) - 1));
}

export class WorkerPool implements TilePool {
	readonly async = true;
	private slots: Slot[] = [];
	private waiting = new Map<
		number,
		{ resolve(v: Uint8ClampedArray): void; reject(e: Error): void; slot: Slot }
	>();
	private nextId = 1;

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

	decode(
		mode: number,
		data: TileData,
		quant: TileQuant,
	): Promise<Uint8ClampedArray> {
		// いちばん空いている Worker へ
		let slot = this.slots[0] as Slot;
		for (const s of this.slots) if (s.busy < slot.busy) slot = s;
		const id = this.nextId++;
		// data は PDU 全体の buffer の一部(subarray)なので、構造化複製だと全体が複製される。小さく切り出して渡す
		const copy = data.map((d) => d.slice()) as TileData;
		return new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve, reject, slot });
			slot.busy++;
			const req: WorkerRequest = { id, mode, data: copy, quant };
			slot.worker.postMessage(
				req,
				copy.map((d) => d.buffer),
			);
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

	/** Worker が落ちた: その Worker に頼んであったものを失敗にする */
	private fail(slot: Slot, e: Error): void {
		for (const [id, w] of this.waiting) {
			if (w.slot !== slot) continue;
			this.waiting.delete(id);
			slot.busy--;
			w.reject(e);
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
