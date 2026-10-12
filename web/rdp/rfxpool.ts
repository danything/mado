// 画面の復号の置き場(RemoteFX のタイル、旧ビットマップ、GFX の Progressive のタイル)。ブラウザでは Web Worker のプールで、メインスレッドを塞がずに複数コアで並列に復号する。
// それ以外(試験や、Worker が作れない環境)では、同じ形でその場で復号する。

import { type BitmapJob, decodeBitmap } from "./bitmap";
import { type ProgressiveTileJob, ProgressiveTiles } from "./progressive";
import { decodeTile } from "./rfx";
import type { WorkerReply, WorkerRequest } from "./rfx.worker";

/** ビルド(tools/build-web.ts)が差し込む、束ねた Worker の URL。ビルドしていない環境(試験など)では未定義 */
declare const __RFX_WORKER__: string | undefined;

type TileData = [Uint8Array, Uint8Array, Uint8Array];
type TileQuant = [number[], number[], number[]];

/** 復号の 1 つの仕事 */
export type DecodeJob =
	| { kind: "rfx"; mode: number; data: TileData; quant: TileQuant }
	| { kind: "bitmap"; rect: BitmapJob }
	/** Progressive のタイル。タイルの状態を持つので、同じタイルは同じ Worker(runOn の lane)へ */
	| { kind: "progressive"; tile: ProgressiveTileJob }
	/** Progressive のタイルの状態を面ごとに捨てる(面を作り直した・消した)。全部の lane へ */
	| { kind: "progressiveReset"; surface: number };

/** Progressive のタイルの状態。Worker の中では Worker ごと、その場で復号するときはメインスレッドに 1 つ */
const progressiveTiles = new ProgressiveTiles();

/** その場で復号する(Worker の中と同じ処理) */
export function decodeJob(j: DecodeJob): Uint8ClampedArray {
	switch (j.kind) {
		case "rfx":
			return decodeTile(j.mode, j.data, j.quant);
		case "bitmap":
			return decodeBitmap(j.rect);
		case "progressive":
			return progressiveTiles.decode(j.tile);
		case "progressiveReset":
			progressiveTiles.deleteSurface(j.surface);
			return new Uint8ClampedArray(0);
	}
}

export interface TilePool {
	/** true なら run は本当に非同期(完了の順序は保証されない)。false ならその場で復号するので、呼び出し側は同期の経路を使ってよい */
	readonly async: boolean;
	run(job: DecodeJob): Promise<Uint8ClampedArray>;
	/** 決まった Worker で復号する(状態を持つ仕事用)。lane は 0 以上の整数で、lanes で割った余りの Worker へ */
	runOn(lane: number, job: DecodeJob): Promise<Uint8ClampedArray>;
	/** Worker の数(その場で復号するときは 1) */
	readonly lanes: number;
	terminate(): void;
}

/** その場で復号する */
export class SyncPool implements TilePool {
	readonly async = false;
	readonly lanes = 1;
	runOn(_lane: number, j: DecodeJob): Promise<Uint8ClampedArray> {
		return this.run(j);
	}
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
	/** 読めなかった・落ちた。lane の割り当てを変えないよう、配列からは外さずに印を付ける */
	dead?: boolean;
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

	get lanes(): number {
		return Math.max(1, this.slots.length);
	}

	run(job: DecodeJob): Promise<Uint8ClampedArray> {
		// いちばん空いている Worker へ
		let slot: Slot | undefined;
		for (const s of this.slots)
			if (!s.dead && (!slot || s.busy < slot.busy)) slot = s;
		return this.send(slot, job);
	}

	runOn(lane: number, job: DecodeJob): Promise<Uint8ClampedArray> {
		// 落ちた Worker の lane は、その場で復号する(ほかの lane の割り当ては変えない)
		const slot = this.slots[lane % this.slots.length];
		return this.send(slot?.dead ? undefined : slot, job);
	}

	/** slot の Worker へ頼む。生きている Worker が無ければ、その場で復号 */
	private send(
		slot: Slot | undefined,
		job: DecodeJob,
	): Promise<Uint8ClampedArray> {
		if (!slot) return this.fallback.run(job);
		const id = this.nextId++;
		// 入力は PDU 全体の buffer の一部(subarray)なので、構造化複製だと全体が複製される。小さく切り出して渡す
		let req: WorkerRequest;
		let transfer: ArrayBuffer[];
		if (job.kind === "rfx") {
			const data = job.data.map((d) => d.slice()) as TileData;
			req = { ...job, id, data };
			transfer = data.map((d) => d.buffer as ArrayBuffer);
		} else if (job.kind === "progressive") {
			const data = job.tile.data.map((d) => d.slice());
			req = { id, kind: "progressive", tile: { ...job.tile, data } };
			transfer = data.map((d) => d.buffer as ArrayBuffer);
		} else if (job.kind === "progressiveReset") {
			req = { ...job, id };
			transfer = [];
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
		if (!slot.dead) {
			slot.dead = true;
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
