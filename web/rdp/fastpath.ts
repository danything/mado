// Fast-Path の出力([MS-RDPBCGR] 2.2.9.1.2)。1 つの PDU に複数の更新が入り、大きな更新は断片に分かれて来る。

import { concat, Reader } from "./bytes";
import type { Bulk } from "./mppc";

export const UPDATE = {
  ORDERS: 0x0,
  BITMAP: 0x1,
  PALETTE: 0x2,
  SYNCHRONIZE: 0x3,
  SURFCMDS: 0x4,
  PTR_NULL: 0x5,
  PTR_DEFAULT: 0x6,
  PTR_POSITION: 0x8,
  COLOR: 0x9,
  CACHED: 0xa,
  POINTER: 0xb,
  LARGE_POINTER: 0xc,
} as const;

/** 組み立てる更新の大きさの上限 */
const MAX_UPDATE = 1 << 24;

export type Update = { code: number; data: Uint8Array };

/** 断片を組み立てながら、更新を 1 つずつ返す。圧縮された断片は、組み立てる前に 1 つずつ伸長する */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private code = 0;
  private size = 0;
  /** 最初の断片を受けて、最後をまだ受けていない */
  private open = false;

  /** I/O チャネルの圧縮の文脈。Share Data と同じものを使う。無ければ圧縮された更新は例外にする */
  constructor(private bulk?: Bulk) {}

  /** x224.readPdu が返した fastpath の data を渡す。ヘッダーは取り除いてある */
  push(pdu: Uint8Array): Update[] {
    const out: Update[] = [];
    const r = new Reader(pdu);
    while (r.left >= 3) {
      const h = r.u8();
      const code = h & 0xf;
      const frag = (h >> 4) & 3;
      const compression = h >> 6;
      // FASTPATH_OUTPUT_COMPRESSION_USED なら compressionFlags が付く。中身が 0(圧縮なし)のこともある
      const flags = compression & 2 ? r.u8() : 0;
      const size = r.u16();
      let data = r.bytes(size);
      if (flags & 0xe0) {
        if (!this.bulk)
          throw new Error("圧縮された Fast-Path の更新は受けられない");
        data = this.bulk.decompress(data, flags);
      }
      switch (frag) {
        case 0: // 単独。組み立ての途中に来たら、組み立て中のものは捨てる
          this.parts = [];
          this.size = 0;
          this.open = false;
          out.push({ code, data });
          break;
        case 2: // 最初
          this.parts = [];
          this.size = 0;
          this.code = code;
          this.open = true;
          this.append(data);
          break;
        case 3: // 途中
          this.append(data);
          break;
        case 1: // 最後
          this.append(data);
          out.push({ code: this.code, data: concat(...this.parts) });
          this.parts = [];
          this.size = 0;
          this.open = false;
          break;
      }
    }
    return out;
  }

  /** 断片を足す。最初の断片が来ていないときや、溜まりすぎたときは例外にする */
  private append(data: Uint8Array): void {
    if (!this.open) throw new Error("Fast-Path: 最初の断片が無い");
    this.size += data.length;
    if (this.size > MAX_UPDATE) throw new Error("Fast-Path: 更新が大きすぎる");
    this.parts.push(data);
  }
}
