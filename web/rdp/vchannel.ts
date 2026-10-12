// 静的仮想チャネル([MS-RDPBCGR] 2.2.6)。1 つのメッセージを、8 バイトのヘッダー(全体の長さ + フラグ)付きの断片に分けて運ぶ。

import { concat, Reader, Writer } from "./bytes";

/** 1 つの断片の本体の最大(VCChunkSize の既定) */
export const CHUNK_SIZE = 1600;

const FIRST = 0x01;
const LAST = 0x02;
/** 断片のヘッダーに、チャネルのオプションの SHOW_PROTOCOL を写す印 */
export const SHOW_PROTOCOL = 0x10;
const COMPRESSED = 0x00200000;

/** メッセージを断片に分ける(それぞれ Send Data Request の中身になる) */
export function splitChannelData(data: Uint8Array, flags = 0): Uint8Array[] {
	const out: Uint8Array[] = [];
	let at = 0;
	do {
		const n = Math.min(CHUNK_SIZE, data.length - at);
		const f =
			(at === 0 ? FIRST : 0) | (at + n >= data.length ? LAST : 0) | flags;
		out.push(
			concat(
				new Writer(8).u32(data.length).u32(f).done(),
				data.subarray(at, at + n),
			),
		);
		at += n;
	} while (at < data.length);
	return out;
}

/** 受けた断片を 1 つのメッセージに組み立てる。メッセージは大きくてもこの上限まで */
export class ChannelAssembler {
	private parts: Uint8Array[] = [];
	private have = 0;
	private total = 0;

	constructor(private max = 1 << 24) {}

	/** 断片を 1 つ渡す。メッセージが揃ったらそれを、まだなら null */
	push(chunk: Uint8Array): Uint8Array | null {
		const r = new Reader(chunk);
		const total = r.u32();
		const flags = r.u32();
		if (flags & COMPRESSED)
			throw new Error("圧縮された仮想チャネルは受けられない");
		const body = r.rest();
		if (flags & FIRST) {
			if (total > this.max)
				throw new Error(`仮想チャネルのメッセージが大きすぎる (${total})`);
			this.parts = [];
			this.have = 0;
			this.total = total;
		} else if (this.parts.length === 0) {
			throw new Error("仮想チャネル: 最初の断片が無い");
		}
		this.parts.push(body);
		this.have += body.length;
		if (this.have > this.total)
			throw new Error("仮想チャネル: 断片が長さを超えた");
		if (!(flags & LAST)) return null;
		if (this.have !== this.total)
			throw new Error("仮想チャネル: 最後の断片で長さが足りない");
		const msg =
			this.parts.length === 1
				? (this.parts[0] as Uint8Array)
				: concat(...this.parts);
		this.parts = [];
		this.have = 0;
		return msg;
	}
}
