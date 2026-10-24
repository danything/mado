// バルク圧縮(MPPC)の伸長の試験。FreeRDP の試験のデータと、文字と一致だけを使う簡単な符号化器で作ったデータを使う。
// Fast-Path、Share Data、静的チャネル、つなぐ途中の readIo でも伸長されることを見る。

import { describe, expect, test } from "bun:test";
import { concat, fromHex, hex, Writer } from "./bytes";
import { readIo } from "./connect";
import { Reassembler } from "./fastpath";
import * as mcs from "./mcs";
import {
  Bulk,
  Mppc,
  PACKET_AT_FRONT,
  PACKET_COMPR_TYPE_64K,
  PACKET_COMPRESSED,
  PACKET_FLUSHED,
} from "./mppc";
import {
  BELLS4,
  BELLS5,
  COMPRESSED,
  ISLAND5,
  UNCOMPRESSED,
} from "./mppc.fixture";
import * as pdu from "./pdu";
import { StreamClosed, type Transport } from "./stream";
import { ChannelAssembler } from "./vchannel";
import * as x224 from "./x224";

const text = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

const BELLS = "for.whom.the.bell.tolls,.the.bell.tolls.for.thee!";
const ISLAND =
  "No man is an island entire of itself; every man " +
  "is a piece of the continent, a part of the main; " +
  "if a clod be washed away by the sea, Europe " +
  "is the less, as well as if a promontory were, as" +
  "well as any manner of thy friends or of thine " +
  "own were; any man's death diminishes me, " +
  "because I am involved in mankind. " +
  "And therefore never send to know for whom " +
  "the bell tolls; it tolls for thee.";

/** 64K の flags。COMPRESSED と、ほかに足すもの */
const F64 = (more = 0) => PACKET_COMPRESSED | PACKET_COMPR_TYPE_64K | more;

/** RDP 5.0 の簡単な符号化器。文字と、こちらで指定した一致だけを書く */
class Enc {
  private bits: number[] = [];
  private put(v: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push((v >>> i) & 1);
    return this;
  }
  lit(s: string | Uint8Array): this {
    for (const b of typeof s === "string" ? text(s) : s) {
      if (b < 0x80) this.put(b, 8);
      else this.put(2, 2).put(b & 0x7f, 7);
    }
    return this;
  }
  /** off バイト前から len バイト写す */
  match(off: number, len: number): this {
    if (off < 64) this.put(0x1f, 5).put(off, 6);
    else if (off < 320) this.put(0x1e, 5).put(off - 64, 8);
    else if (off < 2368) this.put(0xe, 4).put(off - 320, 11);
    else this.put(6, 3).put(off - 2368, 16);
    if (len === 3) return this.put(0, 1);
    let k = 1;
    while (len >= 2 ** (k + 2)) k++;
    return this.put(2 ** (k + 1) - 2, k + 1).put(len - 2 ** (k + 1), k + 1);
  }
  done(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      out[i >> 3] = (out[i >> 3] as number) | (b << (7 - (i & 7)));
    });
    return out;
  }
}

describe("MPPC(FreeRDP の試験のデータ)", () => {
  test("RDP 5.0 のバッファ", () => {
    const out = new Mppc(true).decompress(
      fromHex(COMPRESSED),
      F64(PACKET_AT_FRONT),
    );
    expect(hex(out)).toBe(UNCOMPRESSED);
  });

  test("bells(RDP 5.0 と RDP 4.0)", () => {
    expect(
      str(new Bulk().decompress(fromHex(BELLS5), F64(PACKET_AT_FRONT))),
    ).toBe(BELLS);
    // 下位 4 ビットが 0 なら RDP 4.0(履歴 8KB)
    expect(
      str(
        new Bulk().decompress(
          fromHex(BELLS4),
          PACKET_COMPRESSED | PACKET_AT_FRONT,
        ),
      ),
    ).toBe(BELLS);
  });

  test("island(RDP 5.0)", () => {
    expect(
      str(new Bulk().decompress(fromHex(ISLAND5), F64(PACKET_FLUSHED))),
    ).toBe(ISLAND);
  });
});

describe("MPPC の履歴", () => {
  test("符号化器と往復する。0x80 以上の文字、長い一致、重なる一致", () => {
    const enc = new Enc()
      .lit("abc")
      .lit(Uint8Array.of(0x80, 0xff))
      .match(5, 3)
      .match(1, 100)
      .lit("Z")
      .match(106, 4000)
      .done();
    const out = new Mppc(true).decompress(enc, F64());
    const want = concat(
      text("abc"),
      Uint8Array.of(0x80, 0xff),
      text("abc"),
      new Uint8Array(100).fill(0x63),
      text("Z"),
    );
    expect(out.length).toBe(want.length + 4000);
    expect(hex(out.subarray(0, want.length))).toBe(hex(want));
    // 106 バイト前から 4000 バイトの複製は、want を周期 106 で繰り返す
    for (let i = 0; i < 4000; i++)
      expect(out[want.length + i]).toBe(out[want.length + i - 106] as number);
  });

  test("一致の位置の符号(4 種類)と長さの符号の境目", () => {
    const m = new Mppc(true);
    const seed = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 0x7f);
    m.decompress(new Enc().lit(seed).done(), F64());
    for (const [off, len] of [
      [63, 3],
      [64, 4],
      [319, 7],
      [320, 8],
      [2367, 15],
      [2368, 16],
      [4999, 31],
      [3000, 32],
      [1000, 255],
      [1000, 256],
    ] as const) {
      const out = m.decompress(new Enc().match(off, len).done(), F64());
      expect(out.length).toBe(len);
    }
  });

  test("履歴はパケットをまたいで続く。AT_FRONT は書く位置だけ戻す", () => {
    const m = new Mppc(true);
    expect(str(m.decompress(new Enc().lit("hello world").done(), F64()))).toBe(
      "hello world",
    );
    expect(str(m.decompress(new Enc().match(11, 5).done(), F64()))).toBe(
      "hello",
    );
    // AT_FRONT のあとも前の中身は残っている。先頭から書き、前の位置 0 を指す
    expect(
      str(
        m.decompress(
          new Enc().lit("x").match(1, 3).done(),
          F64(PACKET_AT_FRONT),
        ),
      ),
    ).toBe("xxxx");
  });

  test("FLUSHED は履歴を 0 で埋める。圧縮していないデータはそのまま返し、履歴に入れない", () => {
    const m = new Mppc(true);
    m.decompress(new Enc().lit("secret").done(), F64());
    const raw = text("plain");
    expect(m.decompress(raw, PACKET_FLUSHED | PACKET_COMPR_TYPE_64K)).toBe(raw);
    // 消したあとの履歴の終わりのほう(位置 1 の 10 バイト前 = 0xfff7)を指すと 0 が出る
    const out = m.decompress(
      new Enc().lit("A").match(10, 3).done(),
      F64(PACKET_AT_FRONT),
    );
    expect(hex(out)).toBe("41000000");
  });

  test("壊れたデータは例外", () => {
    // 64KB を超えて書く
    const big = new Mppc(true);
    expect(() =>
      big.decompress(
        new Enc().lit("ab").match(1, 65535).done(),
        F64(PACKET_AT_FRONT),
      ),
    ).toThrow("あふれた");
    // 一致の元が履歴の終わりをまたぐ
    const m = new Mppc(true);
    expect(() =>
      m.decompress(new Enc().lit("ab").match(4, 3).done(), F64()),
    ).toThrow("履歴の外");
    // 符号の途中で切れている
    expect(() =>
      new Mppc(true).decompress(Uint8Array.of(0xc0, 0x00), F64()),
    ).toThrow("足りない");
    // 一致の長さの符号に 0 が無い
    expect(() =>
      new Mppc(true).decompress(
        Uint8Array.of(0xf8, 0x1f, 0xff, 0xff, 0xff),
        F64(),
      ),
    ).toThrow("正しくない");
  });

  test("Bulk は RDP 6.0 / 6.1 を受けない。印が無ければそのまま", () => {
    const b = new Bulk();
    const raw = Uint8Array.of(1, 2, 3);
    expect(b.decompress(raw, 0)).toBe(raw);
    expect(() => b.decompress(raw, PACKET_COMPRESSED | 2)).toThrow("種類 2");
    expect(() => b.decompress(raw, PACKET_COMPRESSED | 3)).toThrow("種類 3");
  });
});

describe("圧縮されたデータの受け口", () => {
  test("Client Info は圧縮を頼むときだけ INFO_COMPRESSION と 64K を立てる", () => {
    const flags = (compression: boolean) =>
      new DataView(
        pdu.clientInfo({ domain: "", user: "u", password: "p", compression })
          .buffer,
      ).getUint32(4, true);
    expect(flags(true) & 0x1e80).toBe(0x80 | (1 << 9));
    expect(flags(false) & 0x1e80).toBe(0);
  });

  /** Fast-Path の更新 1 つ。compressionFlags を付ける */
  const fpUpdate = (
    code: number,
    frag: number,
    flags: number,
    data: Uint8Array,
  ) =>
    new Writer()
      .u8(code | (frag << 4) | (2 << 6))
      .u8(flags)
      .u16(data.length)
      .bytes(data)
      .done();

  test("Fast-Path: 断片ごとに伸長してから組み立てる。compressionFlags が 0 のものもある", () => {
    const f = new Reassembler(new Bulk());
    const a = new Enc().lit("abcd").match(4, 8).done();
    const b = new Enc().match(12, 6).lit("!").done();
    const out = f.push(
      concat(
        fpUpdate(0x1, 2, F64(PACKET_FLUSHED), a),
        fpUpdate(0x1, 3, 0, text("--")),
        fpUpdate(0x1, 1, F64(), b),
      ),
    );
    expect(out.map((u) => [u.code, str(u.data)])).toEqual([
      [0x1, "abcdabcdabcd--abcdab!"],
    ]);
  });

  test("Fast-Path: 圧縮の文脈が無ければ例外", () => {
    const raw = fpUpdate(0x1, 0, F64(), new Enc().lit("x").done());
    expect(() => new Reassembler().push(raw)).toThrow("受けられない");
    expect(
      new Reassembler().push(fpUpdate(0x1, 0, 0, text("ok")))[0]?.data,
    ).toEqual(text("ok"));
  });

  /** Share Control の本体(Share Data のヘッダーから) */
  const shareBody = (
    type2: number,
    ctype: number,
    data: Uint8Array,
    clen = data.length + 18,
  ) =>
    new Writer()
      .u32(0x103ea)
      .u8(0)
      .u8(1)
      .u16(0)
      .u8(type2)
      .u8(ctype)
      .u16(clen)
      .bytes(data)
      .done();

  test("Share Data: compressedLength の分を伸長する", () => {
    const bulk = new Bulk();
    const data = new Enc().lit("pointer").match(7, 7).done();
    const sd = pdu.parseShareData(
      shareBody(pdu.PDUTYPE2.POINTER, F64(PACKET_FLUSHED), data),
      bulk,
    );
    expect(sd.type2).toBe(pdu.PDUTYPE2.POINTER);
    expect(str(sd.payload)).toBe("pointerpointer");
    expect(() =>
      pdu.parseShareData(shareBody(2, F64(), data, data.length + 19), bulk),
    ).toThrow("compressedLength");
    expect(() => pdu.parseShareData(shareBody(2, F64(), data))).toThrow(
      "受けられない",
    );
  });

  test("静的チャネル: 断片ごとに伸長し、length は伸長したあとの長さ", () => {
    const asm = new ChannelAssembler(new Bulk());
    const chunk = (flags: number, body: Uint8Array) =>
      concat(new Writer(8).u32(14).u32(flags).done(), body);
    expect(
      asm.push(
        chunk(
          0x01 | (F64(PACKET_FLUSHED) << 16),
          new Enc().lit("abc").match(3, 6).done(),
        ),
      ),
    ).toBeNull();
    const msg = asm.push(
      chunk(0x02 | (F64() << 16), new Enc().match(9, 5).done()),
    );
    expect(str(msg as Uint8Array)).toBe("abcabcabcabcab");
    expect(() =>
      new ChannelAssembler().push(
        chunk(0x03 | (F64() << 16), Uint8Array.of(0)),
      ),
    ).toThrow("受けられない");
  });

  test("つなぐ途中: Fast-Path は届いた順に伸長する(Share Data と履歴を共有する)", async () => {
    const bulk = new Bulk();
    const fast = new Reassembler(bulk);
    const update = fpUpdate(
      0x5,
      0,
      F64(PACKET_FLUSHED),
      new Enc().lit("fastpath").done(),
    );
    const fpPdu = concat(Uint8Array.of(0, update.length + 2), update);
    // Share Data は Fast-Path の 8 バイトを指す
    const sc = (body: Uint8Array) =>
      new Writer()
        .u16(body.length + 6)
        .u16(0x17)
        .u16(1002)
        .bytes(body)
        .done();
    const slow = sc(
      shareBody(pdu.PDUTYPE2.UPDATE, F64(), new Enc().match(8, 8).done()),
    );
    const ind = x224.data(
      mcs.sendDataRequest(1002, 1003, slow).map((b, i) => (i === 0 ? 0x68 : b)),
    );
    let buf = concat(fpPdu, ind);
    const stream: Transport = {
      async peek(n) {
        if (buf.length < n) throw new StreamClosed("closed");
        return buf.subarray(0, n);
      },
      async read(n) {
        const o = buf.subarray(0, n);
        buf = buf.subarray(n);
        return o;
      },
      write() {},
      close() {},
    };
    const inbox = {
      ioChannelId: 1003,
      pending: [] as { code: number; data: Uint8Array }[],
      pendingChannel: [],
      fast,
    };
    const data = await readIo(stream, inbox);
    expect(inbox.pending.map((u) => [u.code, str(u.data)])).toEqual([
      [0x5, "fastpath"],
    ]);
    const sd = pdu.parseShareData(pdu.parseShareControl(data).body, bulk);
    expect(str(sd.payload)).toBe("fastpath");
  });
});
