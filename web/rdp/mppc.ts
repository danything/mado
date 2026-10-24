// RDP のバルク圧縮の伸長([MS-RDPBCGR] 3.1.8)。サーバーから届く Fast-Path、Share Data、静的チャネルのデータに使う。
// 扱うのは MPPC の RDP 4.0(履歴 8KB)と RDP 5.0(履歴 64KB)だけ。宣言するのは RDP 5.0 で、サーバーはそれ以下を選べる。
// RDP 6.0 / 6.1 は宣言しないので来ない。符号の読み方は FreeRDP の mppc.c に合わせた。

/** Client Info の CompressionTypeMask と、圧縮のフラグの下位 4 ビット */
export const PACKET_COMPR_TYPE_8K = 0x0;
export const PACKET_COMPR_TYPE_64K = 0x1;

export const PACKET_COMPRESSED = 0x20;
export const PACKET_AT_FRONT = 0x40;
export const PACKET_FLUSHED = 0x80;
const TYPE_MASK = 0x0f;

/** MPPC の履歴 1 つ。サーバーの圧縮器 1 つに対応する */
export class Mppc {
  private history: Uint8Array;
  private offset = 0;

  /** big が true なら RDP 5.0(64KB)、false なら RDP 4.0(8KB) */
  constructor(private big: boolean) {
    this.history = new Uint8Array(big ? 0x10000 : 0x2000);
  }

  /** flags は圧縮のフラグのバイト(compressedType / compressionFlags)。伸長したものの写しを返す */
  decompress(src: Uint8Array, flags: number): Uint8Array {
    const h = this.history;
    // FLUSHED を先に扱う。AT_FRONT は履歴を消さずに書く位置だけ戻す
    if (flags & PACKET_FLUSHED) {
      h.fill(0);
      this.offset = 0;
    }
    if (flags & PACKET_AT_FRONT) this.offset = 0;
    // 圧縮していないデータは履歴に入れない(FreeRDP と同じ)
    if (!(flags & PACKET_COMPRESSED)) return src;

    const size = h.length;
    const mask = size - 1;
    const big = this.big;
    const total = src.length * 8;
    const start = this.offset;
    let at = start;
    let pos = 0;
    /** pos から 32 ビットを読む。終わりより先は 0 */
    const peek = (): number => {
      const i = pos >> 3;
      const s = pos & 7;
      const b = (k: number) => src[i + k] ?? 0;
      const hi = ((b(0) << 24) | (b(1) << 16) | (b(2) << 8) | b(3)) >>> 0;
      return s === 0 ? hi : ((hi << s) | (b(4) >>> (8 - s))) >>> 0;
    };
    const shift = (n: number) => {
      pos += n;
      if (pos > total) throw new Error("MPPC: データが足りない");
    };

    // 最後の 8 ビット未満は詰め物
    while (total - pos >= 8) {
      let a = peek();
      if (at >= size) throw new Error("MPPC: 履歴があふれた");
      if (!(a & 0x80000000)) {
        // 0 + 7 ビット: 0x00〜0x7f の文字
        h[at++] = (a >>> 24) & 0x7f;
        shift(8);
        continue;
      }
      if (a >>> 30 === 2) {
        // 10 + 7 ビット: 0x80〜0xff の文字
        h[at++] = ((a >>> 23) & 0x7f) | 0x80;
        shift(9);
        continue;
      }

      // 一致の位置(何バイト前か)
      let off: number;
      if (big) {
        if (a >>> 27 === 0x1f) {
          off = (a >>> 21) & 0x3f;
          shift(11);
        } else if (a >>> 27 === 0x1e) {
          off = ((a >>> 19) & 0xff) + 64;
          shift(13);
        } else if (a >>> 28 === 0xe) {
          off = ((a >>> 17) & 0x7ff) + 320;
          shift(15);
        } else {
          // 110 + 16 ビット
          off = ((a >>> 13) & 0xffff) + 2368;
          shift(19);
        }
      } else if (a >>> 28 === 0xf) {
        off = (a >>> 22) & 0x3f;
        shift(10);
      } else if (a >>> 28 === 0xe) {
        off = ((a >>> 20) & 0xff) + 64;
        shift(12);
      } else {
        // 110 + 13 ビット
        off = ((a >>> 16) & 0x1fff) + 320;
        shift(16);
      }

      // 一致の長さ。k 個の 1 と 0 のあとに k+1 ビットが続き、長さは 2^(k+1) + その値。k = 0 なら 3
      a = peek();
      const k = Math.clz32(~a);
      let len: number;
      if (k === 0) {
        len = 3;
        shift(1);
      } else {
        if (k > (big ? 14 : 11))
          throw new Error("MPPC: 一致の長さの符号が正しくない");
        const n = 2 * k + 2;
        len = 2 ** (k + 1) + ((a >>> (32 - n)) & ((1 << (k + 1)) - 1));
        shift(n);
      }

      if (at + len > size) throw new Error("MPPC: 履歴があふれた");
      let from = (at - off) & mask;
      if (from + len > size) throw new Error("MPPC: 一致の位置が履歴の外");
      // 重なっていてもよい(1 バイトずつ写す)
      for (let i = 0; i < len; i++) h[at++] = h[from++] as number;
    }
    this.offset = at;
    return h.slice(start, at);
  }
}

/** 受け手の圧縮の文脈。I/O チャネル(Fast-Path と Share Data)で 1 つ、静的チャネルで 1 つ持つ */
export class Bulk {
  private mppc8?: Mppc;
  private mppc64?: Mppc;
  /** 伸長したパケットの数と、伸長する前と後のバイト数。診断に出す */
  readonly stats = { packets: 0, compressed: 0, decompressed: 0 };

  /** flags は圧縮のフラグのバイト。圧縮の印が無ければそのまま返す */
  decompress(data: Uint8Array, flags: number): Uint8Array {
    if (!(flags & (PACKET_COMPRESSED | PACKET_AT_FRONT | PACKET_FLUSHED)))
      return data;
    const type = flags & TYPE_MASK;
    let out: Uint8Array;
    switch (type) {
      case PACKET_COMPR_TYPE_8K:
        this.mppc8 ??= new Mppc(false);
        out = this.mppc8.decompress(data, flags);
        break;
      case PACKET_COMPR_TYPE_64K:
        this.mppc64 ??= new Mppc(true);
        out = this.mppc64.decompress(data, flags);
        break;
      default:
        throw new Error(`圧縮の種類 ${type} は受けられない`);
    }
    if (flags & PACKET_COMPRESSED) {
      this.stats.packets++;
      this.stats.compressed += data.length;
      this.stats.decompressed += out.length;
    }
    return out;
  }
}
