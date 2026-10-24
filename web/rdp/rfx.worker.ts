// 画面の復号を受け持つ Web Worker の入口。rfxpool.ts がまとめて使う。RemoteFX のタイル、旧ビットマップ(planar / Interleaved RLE)、Progressive のタイルを復号する。
// rfxpool.ts の DecodeJob に id を付けたものを受け取り、{ id, rgba } か { id, error } を返す。rgba は buffer ごと渡す。
// Progressive はタイルの状態を Worker の中に持つ。そのため rfxpool.ts の runOn で、同じタイルはいつも同じ Worker に送られる。

import { type DecodeJob, decodeJob } from "./rfxpool";

/** rfxpool.ts の DecodeJob に、返事と対応づけるための id を付けたもの */
export type WorkerRequest = DecodeJob & { id: number };

export type WorkerReply =
  { id: number; rgba: Uint8ClampedArray } | { id: number; error: string };

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
