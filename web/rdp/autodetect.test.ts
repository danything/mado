// 回線の自動検出の試験。要求の読み取り、応答のバイト列、帯域の測り方、つなぐ途中の readIo での答え方を見る。

import { describe, expect, test } from "bun:test";

import {
  AutoDetect,
  bandwidthResults,
  parseRequest,
  REQUEST,
  RESPONSE,
  rttResponse,
  SEC_AUTODETECT_REQ,
} from "./autodetect";
import { concat, hex, Writer } from "./bytes";
import { readIo } from "./connect";
import * as mcs from "./mcs";
import { StreamClosed, type Transport } from "./stream";
import * as x224 from "./x224";

/** SEC_AUTODETECT_REQ の Security Header を付けた要求 */
function request(
  seq: number,
  type: number,
  extra: (w: Writer) => void = () => {},
  headerLength = 6,
): Uint8Array {
  const w = new Writer()
    .u16(SEC_AUTODETECT_REQ)
    .u16(0)
    .u8(headerLength)
    .u8(0)
    .u16(seq)
    .u16(type);
  extra(w);
  return w.done();
}

describe("応答のバイト列", () => {
  test("RTT Measure Response", () => {
    expect(hex(rttResponse(0x1234))).toBe("060134120000");
  });

  test("Bandwidth Measure Results", () => {
    expect(
      hex(bandwidthResults(7, RESPONSE.BW_RESULTS_CONNECTTIME, 25, 0x10000)),
    ).toBe("0e010700" + "0300" + "19000000" + "00000100");
  });
});

describe("要求の読み取り", () => {
  test("Network Characteristics Result: 種類ごとに並ぶ値が違う", () => {
    const body = (type: number, ...v: number[]) => {
      const w = new Writer().u8(6).u8(0).u16(1).u16(type);
      for (const x of v) w.u32(x);
      return w.done();
    };
    expect(
      parseRequest(body(REQUEST.NETCHAR_ALL, 10, 50000, 20))?.network,
    ).toEqual({ baseRtt: 10, bandwidth: 50000, averageRtt: 20 });
    expect(
      parseRequest(body(REQUEST.NETCHAR_BASE_AVERAGE_RTT, 10, 20))?.network,
    ).toEqual({ baseRtt: 10, averageRtt: 20 });
    expect(
      parseRequest(body(REQUEST.NETCHAR_BANDWIDTH_AVERAGE_RTT, 9000, 20))
        ?.network,
    ).toEqual({ bandwidth: 9000, averageRtt: 20 });
    // 足りなければ読まない
    expect(parseRequest(body(REQUEST.NETCHAR_ALL, 10, 50000))).toBeUndefined();
  });

  test("短いもの・応答の種類・payload が足りないものは読まない", () => {
    expect(parseRequest(Uint8Array.of(6, 0, 1))).toBeUndefined();
    expect(parseRequest(Uint8Array.of(6, 1, 1, 0, 1, 0))).toBeUndefined();
    const short = new Writer()
      .u8(8)
      .u8(0)
      .u16(1)
      .u16(REQUEST.BW_PAYLOAD)
      .u16(10);
    expect(parseRequest(short.done())).toBeUndefined();
  });
});

describe("AutoDetect", () => {
  test("RTT(つなぐ途中・つないだあと)に同じ sequenceNumber で答える", () => {
    const ad = new AutoDetect();
    expect(
      hex(ad.handle(request(5, REQUEST.RTT_CONNECTTIME)) as Uint8Array),
    ).toBe("00200000" + "060105000000");
    expect(
      hex(ad.handle(request(6, REQUEST.RTT_CONTINUOUS)) as Uint8Array),
    ).toBe("00200000" + "060106000000");
    expect(ad.stats.rtt).toBe(2);
  });

  test("つなぐ途中の帯域: payload の長さを数え、Stop の payload も足す", () => {
    let now = 1000;
    const ad = new AutoDetect(() => now);
    const payload = (n: number) => (w: Writer) => w.u16(n).zeros(n);
    expect(ad.handle(request(1, REQUEST.BW_START_CONNECTTIME))).toBeUndefined();
    ad.received(9999); // つなぐ途中は、届いたものの大きさは数えない
    expect(
      ad.handle(request(2, REQUEST.BW_PAYLOAD, payload(100), 8)),
    ).toBeUndefined();
    now = 1040;
    const r = ad.handle(
      request(3, REQUEST.BW_STOP_CONNECTTIME, payload(20), 8),
    ) as Uint8Array;
    expect(hex(r)).toBe(
      "00200000" + "0e010300" + "0300" + "28000000" + "78000000",
    );
    expect(ad.stats.bandwidth).toBe(1);
  });

  test("つないだあとの帯域: 届いた PDU の大きさを数えて 0x000B で答える", () => {
    let now = 0;
    const ad = new AutoDetect(() => now);
    ad.received(500); // 始まる前は数えない
    ad.handle(request(1, REQUEST.BW_START_CONTINUOUS));
    ad.received(3000);
    ad.received(2000);
    now = 12.6;
    const r = ad.handle(request(2, REQUEST.BW_STOP_CONTINUOUS)) as Uint8Array;
    expect(hex(r.subarray(4))).toBe(
      "0e010200" + "0b00" + "0d000000" + "88130000", // 13ms、5000 バイト
    );
    // 止めたあとは数えない
    ad.received(100);
    // Payload と Stop の payload は received() で数え済みなので、二重に足さない
    ad.handle(request(4, REQUEST.BW_START_CONTINUOUS));
    ad.received(1000);
    ad.handle(request(5, REQUEST.BW_PAYLOAD, (w) => w.u16(900).zeros(900)));
    const once = ad.handle(
      request(6, REQUEST.BW_STOP_CONTINUOUS),
    ) as Uint8Array;
    expect(hex(once.subarray(14))).toBe("e8030000"); // 1000 バイト
    const again = ad.handle(request(3, REQUEST.BW_STOP_TUNNEL)) as Uint8Array;
    expect(hex(again.subarray(10))).toBe("0000000000000000");
  });

  test("Network Characteristics Result は覚えるだけ。知らない値は前のものを残す", () => {
    const ad = new AutoDetect();
    expect(
      ad.handle(
        request(1, REQUEST.NETCHAR_ALL, (w) => w.u32(5).u32(100000).u32(8)),
      ),
    ).toBeUndefined();
    ad.handle(
      request(2, REQUEST.NETCHAR_BASE_AVERAGE_RTT, (w) => w.u32(4).u32(9)),
    );
    expect(ad.network).toEqual({
      baseRtt: 4,
      bandwidth: 100000,
      averageRtt: 9,
    });
  });

  test("知らない種類・自動検出でないもの・壊れたものには答えない", () => {
    const ad = new AutoDetect();
    expect(ad.handle(request(1, 0x0018))).toBeUndefined(); // Network Characteristics Sync
    expect(ad.handle(Uint8Array.of(0x00, 0x40, 0, 0))).toBeUndefined(); // Heartbeat
    expect(ad.handle(Uint8Array.of(0x00, 0x10))).toBeUndefined();
    expect(
      ad.handle(request(1, REQUEST.RTT_CONTINUOUS).subarray(0, 8)),
    ).toBeUndefined();
  });
});

describe("接続の途中(readIo)", () => {
  const ind = (channelId: number, data: Uint8Array) =>
    x224.data(
      mcs
        .sendDataRequest(1007, channelId, data)
        .map((b, i) => (i === 0 ? 0x68 : b)),
    );

  test("メッセージ チャネルのものはその場で答え、I/O チャネルのものを返す", async () => {
    let buf = concat(
      ind(1008, request(9, REQUEST.RTT_CONNECTTIME)),
      ind(1004, Uint8Array.of(1)),
      ind(1003, Uint8Array.of(2, 3)),
    );
    const written: Uint8Array[] = [];
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
      write(b) {
        written.push(b);
      },
      close() {},
    };
    const ad = new AutoDetect();
    const inbox = {
      ioChannelId: 1003,
      pending: [],
      pendingChannel: [] as { channelId: number; data: Uint8Array }[],
      message: {
        id: 1008,
        handle: (d: Uint8Array) => {
          const r = ad.handle(d);
          if (r) stream.write(x224.data(mcs.sendDataRequest(1007, 1008, r)));
        },
      },
    };
    expect(hex(await readIo(stream, inbox))).toBe("0203");
    expect(inbox.pendingChannel.map((c) => c.channelId)).toEqual([1004]);
    expect(written.map(hex)).toEqual([
      hex(
        x224.data(
          mcs.sendDataRequest(
            1007,
            1008,
            Uint8Array.of(0, 0x20, 0, 0, 6, 1, 9, 0, 0, 0),
          ),
        ),
      ),
    ]);
  });
});
