// タッチの入力([MS-RDPEI])の試験。可変長の整数は仕様の例で、PDU は自分で組んだバイト列で確かめる

import { describe, expect, test } from "bun:test";

import { concat, fromHex, hex, Reader, Writer } from "./bytes";
import { attachChannels } from "./channels";
import type { RdpClient } from "./client";
import { DynamicChannels } from "./dvc";
import {
  chooseVersion,
  CONTACT_FLAG,
  csReady,
  dismissHoveringContact,
  EVENTID,
  INPUT,
  PROTOCOL,
  readHeader,
  readS2,
  readS4,
  readTouchEvent,
  readU2,
  readU4,
  readU8,
  TICK_MS,
  TOUCH_CANCEL,
  TOUCH_DOWN,
  TOUCH_UP,
  TOUCH_UPDATE,
  touchEvent,
  TouchInput,
  writeS2,
  writeS4,
  writeU2,
  writeU4,
  writeU8,
} from "./rdpei";

const enc = (f: (w: Writer, v: number) => void, v: number) => {
  const w = new Writer(8);
  f(w, v);
  return hex(w.done());
};

describe("可変長の整数", () => {
  test("仕様の例", () => {
    expect(enc(writeU2, 0x1a1b)).toBe("9a1b");
    expect(enc(writeS2, -0x1a1b)).toBe("da1b");
    expect(enc(writeS2, -2)).toBe("42");
    expect(enc(writeU4, 0x1a1b1c)).toBe("9a1b1c");
    expect(enc(writeS4, -0x1a1b1c)).toBe("ba1b1c");
    expect(enc(writeS4, -2)).toBe("22");
    const w = new Writer(8);
    writeU8(w, 0x001a1b1c1d1e1f2an);
    expect(hex(w.done())).toBe("da1b1c1d1e1f2a");
  });

  test("バイト数の境目", () => {
    expect(enc(writeU2, 0x7f)).toBe("7f");
    expect(enc(writeU2, 0x80)).toBe("8080");
    expect(enc(writeU2, 0x7fff)).toBe("ffff");
    expect(enc(writeS2, 0x3f)).toBe("3f");
    expect(enc(writeS2, 0x40)).toBe("8040");
    expect(enc(writeS2, -0x3fff)).toBe("ffff");
    expect(enc(writeU4, 0x3f)).toBe("3f");
    expect(enc(writeU4, 0x40)).toBe("4040");
    expect(enc(writeU4, 0x3fff)).toBe("7fff");
    expect(enc(writeU4, 0x4000)).toBe("804000");
    expect(enc(writeU4, 0x3fffffff)).toBe("ffffffff");
    expect(enc(writeS4, 0x1f)).toBe("1f");
    expect(enc(writeS4, 0x20)).toBe("4020");
    expect(enc(writeS4, 1919)).toBe("477f");
    expect(enc(writeS4, -0x1fffffff)).toBe("ffffffff");
    const u8 = (v: number | bigint) => {
      const w = new Writer(8);
      writeU8(w, v);
      return hex(w.done());
    };
    expect(u8(0)).toBe("00");
    expect(u8(0x1f)).toBe("1f");
    expect(u8(0x20)).toBe("2020");
    expect(u8(0x1fff)).toBe("3fff");
    // 16.667ms(マイクロ秒で 0x411B)は 2 バイトの 13 ビットに収まらず 3 バイト
    expect(u8(16_667)).toBe("40411b");
    expect(u8(0x1fffffffffffffffn)).toBe("ffffffffffffffff");
  });

  test("書いて読むと元に戻る", () => {
    const cases: [
      (w: Writer, v: number) => void,
      (r: Reader) => number,
      number[],
    ][] = [
      [writeU2, readU2, [0, 1, 0x7f, 0x80, 0x1234, 0x7fff]],
      [writeS2, readS2, [0, -1, 0x3f, -0x40, 0x1234, -0x3fff, 0x3fff]],
      [writeU4, readU4, [0, 0x3f, 0x40, 0x3fff, 0x4000, 0x3fffff, 0x3fffffff]],
      [
        writeS4,
        readS4,
        [0, -1, 0x1f, -0x20, 0x1fff, -0x2000, 0x1fffff, -0x1fffffff],
      ],
    ];
    for (const [write, read, values] of cases)
      for (const v of values) {
        const w = new Writer(8);
        write(w, v);
        expect(read(new Reader(w.done()))).toBe(v);
      }
    for (const v of [
      0n,
      0x1fn,
      0x20n,
      0x1fffn,
      123456789n,
      0x1fffffffffffffffn,
    ]) {
      const w = new Writer(8);
      writeU8(w, v);
      expect(readU8(new Reader(w.done()))).toBe(v);
    }
  });

  test("範囲の外は例外", () => {
    expect(() => enc(writeU2, 0x8000)).toThrow(RangeError);
    expect(() => enc(writeU2, -1)).toThrow(RangeError);
    expect(() => enc(writeS2, 0x4000)).toThrow(RangeError);
    expect(() => enc(writeU4, 0x40000000)).toThrow(RangeError);
    expect(() => enc(writeS4, -0x20000000)).toThrow(RangeError);
    expect(() => writeU8(new Writer(8), 0x2000000000000000n)).toThrow(
      RangeError,
    );
  });
});

describe("PDU", () => {
  test("CS_READY の並び", () => {
    expect(hex(csReady(1, PROTOCOL.V200, 10))).toBe(
      "0200" + "10000000" + "01000000" + "00000200" + "0a00",
    );
  });

  test("DISMISS_HOVERING_TOUCH_CONTACT の並び", () => {
    expect(hex(dismissHoveringContact(3))).toBe("0600" + "07000000" + "03");
  });

  test("pduLength が受けた長さと違うヘッダーは読まない", () => {
    expect(readHeader(fromHex("0100" + "0a000000" + "00000100"))).toEqual(
      expect.objectContaining({ eventId: EVENTID.SC_READY }),
    );
    expect(
      readHeader(fromHex("0100" + "0b000000" + "00000100")),
    ).toBeUndefined();
    expect(readHeader(fromHex("0100"))).toBeUndefined();
  });

  test("TOUCH_EVENT を組んで読み直す", () => {
    const pdu = touchEvent(5, [
      {
        frameOffset: 0,
        contacts: [{ contactId: 0, x: 100, y: 200, contactFlags: TOUCH_DOWN }],
      },
      {
        frameOffset: 16_000,
        contacts: [
          {
            contactId: 1,
            x: -3,
            y: 1919,
            contactFlags: TOUCH_UPDATE,
            rect: { left: -4, top: -4, right: 4, bottom: 4 },
            orientation: 90,
            pressure: 1024,
          },
        ],
      },
    ]);
    // 1 つ目のフレームは手で組んだバイト列と比べる
    expect(hex(pdu.subarray(0, 17))).toBe(
      "0300" +
        hex(new Writer(4).u32(pdu.length).done()) +
        "05" + // encodeTime 5
        "02" + // frameCount 2
        "01" + // contactCount 1
        "00" + // frameOffset 0
        "00" + // contactId 0
        "00" + // fieldsPresent
        "4064" + // x 100
        "40c8" + // y 200
        "19", // DOWN | INRANGE | INCONTACT
    );
    const h = readHeader(pdu);
    expect(h?.eventId).toBe(EVENTID.TOUCH);
    const back = readTouchEvent((h as { body: Reader }).body);
    expect(back.encodeTime).toBe(5);
    expect(back.frames.length).toBe(2);
    expect(back.frames[1]?.frameOffset).toBe(16_000n);
    expect(back.frames[1]?.contacts[0]).toEqual({
      contactId: 1,
      x: -3,
      y: 1919,
      contactFlags: TOUCH_UPDATE,
      rect: { left: -4, top: -4, right: 4, bottom: 4 },
      orientation: 90,
      pressure: 1024,
    });
  });

  test("相手のバージョンに合わせる", () => {
    expect(chooseVersion(PROTOCOL.V100)).toBe(PROTOCOL.V100);
    expect(chooseVersion(PROTOCOL.V101)).toBe(PROTOCOL.V101);
    expect(chooseVersion(PROTOCOL.V200)).toBe(PROTOCOL.V200);
    expect(chooseVersion(PROTOCOL.V300)).toBe(PROTOCOL.V300);
    // 知らない新しいバージョンには、知っている最新のバージョンで答える
    expect(chooseVersion(0x00040000)).toBe(PROTOCOL.V300);
    expect(chooseVersion(0x00020001)).toBe(PROTOCOL.V200);
    expect(chooseVersion(0)).toBe(PROTOCOL.V100);
  });
});

/** 時計とタイマーの偽物。advance で時刻を進め、その間に来るタイマーを順に呼ぶ */
function fakeClock() {
  let now = 1000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => timers.push({ at: now + ms, fn }),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = Math.max(now, t.at);
        t.fn();
      }
      now = end;
    },
    get pending() {
      return timers.length;
    },
  };
}

const scReady = (version: number, features?: number) => {
  const body = new Writer(8).u32(version);
  if (features !== undefined) body.u32(features);
  const b = body.done();
  return concat(
    new Writer(6)
      .u16(EVENTID.SC_READY)
      .u32(6 + b.length)
      .done(),
    b,
  );
};
const header = (eventId: number) => new Writer(6).u16(eventId).u32(6).done();

function setup(version: number = PROTOCOL.V200) {
  const clock = fakeClock();
  const sent: Uint8Array[] = [];
  const t = new TouchInput({
    maxContacts: 10,
    now: clock.now,
    schedule: clock.schedule,
  });
  const channel = { id: 7, send: (d: Uint8Array) => sent.push(d) };
  t.onOpen(channel);
  if (version) t.onData(scReady(version), channel);
  const frames = () =>
    sent
      .filter((d) => readHeader(d)?.eventId === EVENTID.TOUCH)
      .map((d) => readTouchEvent((readHeader(d) as { body: Reader }).body));
  /** 送ったフレームの接触を [id, flags, x, y] で並べる */
  const contacts = () =>
    frames().map((e) =>
      e.frames.flatMap((f) =>
        f.contacts.map((c) => [c.contactId, c.contactFlags, c.x, c.y]),
      ),
    );
  return { t, clock, sent, channel, frames, contacts };
}

describe("TouchInput", () => {
  test("SC_READY を受けるまでは使えず、受けたら相手のバージョンで CS_READY を返す", () => {
    const { t, sent, channel } = setup(0);
    expect(t.available).toBe(false);
    expect(t.down(1, 0, 0)).toBe(false);
    t.onData(scReady(PROTOCOL.V101), channel);
    expect(t.available).toBe(true);
    expect(t.version).toBe(PROTOCOL.V101);
    expect(hex(sent[0] as Uint8Array)).toBe(hex(csReady(1, PROTOCOL.V101, 10)));
  });

  test("V300 では supportedFeatures を読む", () => {
    const { t, channel } = setup(0);
    t.onData(scReady(PROTOCOL.V300, 1), channel);
    expect(t.version).toBe(PROTOCOL.V300);
    expect(t.supportedFeatures).toBe(1);
  });

  test("長さの合わない SC_READY は無視する", () => {
    const { t, sent, channel } = setup(0);
    const bad = scReady(PROTOCOL.V200);
    bad[2] = 0x20;
    t.onData(bad, channel);
    // protocolVersion の無い SC_READY も無視する
    t.onData(header(EVENTID.SC_READY), channel);
    expect(t.available).toBe(false);
    expect(sent.length).toBe(0);
  });

  test("置く・動かす・離すを、前から TICK_MS 空けて 1 フレームずつ送る", () => {
    const { t, clock, contacts, frames } = setup();
    expect(t.down(5, 10, 20)).toBe(true);
    clock.advance(0);
    // 最初のフレームはすぐ送る
    expect(contacts()).toEqual([[[0, TOUCH_DOWN, 10, 20]]]);
    clock.advance(5);
    t.move(5, 11, 21);
    clock.advance(2);
    t.move(5, 12, 22);
    clock.advance(TICK_MS - 8);
    expect(contacts().length).toBe(1);
    clock.advance(1);
    // まだ送っていない移動は、最後の位置にまとめる
    expect(contacts()[1]).toEqual([[0, TOUCH_UPDATE, 12, 22]]);
    // 離した位置が違えば、UPDATE で動かしてから UP
    t.up(5, 30, 40);
    clock.advance(TICK_MS * 3);
    expect(contacts().slice(2)).toEqual([
      [[0, TOUCH_UPDATE, 30, 40]],
      [[0, TOUCH_UP, 30, 40]],
    ]);
    // 全部離したら送るのを止める
    expect(clock.pending).toBe(0);
    expect(frames()[0]?.frames[0]?.frameOffset).toBe(0n);
    // 2 つ目は、まとめた移動の最後(置いてから 7ms)の時刻。encodeTime はそこから送るまでの 10ms
    expect(frames()[1]?.frames[0]?.frameOffset).toBe(7000n);
    expect(frames()[1]?.encodeTime).toBe(10);
  });

  test("動かない指も、離すまで毎フレーム UPDATE で送る", () => {
    const { t, clock, contacts } = setup();
    t.down(1, 50, 50);
    clock.advance(TICK_MS * 3);
    expect(contacts()).toEqual([
      [[0, TOUCH_DOWN, 50, 50]],
      [[0, TOUCH_UPDATE, 50, 50]],
      [[0, TOUCH_UPDATE, 50, 50]],
      [[0, TOUCH_UPDATE, 50, 50]],
    ]);
  });

  test("2 本の指は同じフレームに入り、ID は小さい順に割り当てて離したら使い回す", () => {
    const { t, clock, contacts } = setup();
    t.down(11, 0, 0);
    t.down(12, 100, 0);
    clock.advance(0);
    expect(contacts()[0]).toEqual([
      [0, TOUCH_DOWN, 0, 0],
      [1, TOUCH_DOWN, 100, 0],
    ]);
    t.up(11, 0, 0);
    clock.advance(TICK_MS);
    expect(contacts()[1]).toEqual([
      [0, TOUCH_UP, 0, 0],
      [1, TOUCH_UPDATE, 100, 0],
    ]);
    t.down(13, 5, 5);
    clock.advance(TICK_MS);
    expect(contacts()[2]).toEqual([
      [1, TOUCH_UPDATE, 100, 0],
      [0, TOUCH_DOWN, 5, 5],
    ]);
  });

  test("すぐ離したタップも、DOWN と UP を別のフレームで送る", () => {
    const { t, clock, contacts } = setup();
    t.down(1, 7, 7);
    t.up(1, 7, 7);
    clock.advance(TICK_MS * 2);
    expect(contacts()).toEqual([
      [[0, TOUCH_DOWN, 7, 7]],
      [[0, TOUCH_UP, 7, 7]],
    ]);
  });

  test("取り消された指は UP | CANCELED", () => {
    const { t, clock, contacts } = setup();
    t.down(1, 7, 7);
    clock.advance(0);
    t.cancel(1);
    clock.advance(TICK_MS);
    expect(contacts()[1]).toEqual([
      [0, CONTACT_FLAG.UP | CONTACT_FLAG.CANCELED, 7, 7],
    ]);
    expect(TOUCH_CANCEL).toBe(CONTACT_FLAG.UP | CONTACT_FLAG.CANCELED);
  });

  test("接触の数が maxContacts を超えたら、その指は受けない", () => {
    const clock = fakeClock();
    const t = new TouchInput({
      maxContacts: 1,
      now: clock.now,
      schedule: clock.schedule,
    });
    const channel = { id: 1, send: () => {} };
    t.onOpen(channel);
    t.onData(scReady(PROTOCOL.V100), channel);
    expect(t.down(1, 0, 0)).toBe(true);
    expect(t.down(2, 0, 0)).toBe(false);
  });

  test("SUSPEND_INPUT で止め、触れている指の続きも送らない。RESUME_INPUT で戻る", () => {
    const { t, clock, contacts, frames, channel } = setup();
    t.down(1, 0, 0);
    clock.advance(0);
    t.onData(header(EVENTID.SUSPEND_INPUT), channel);
    expect(t.available).toBe(false);
    t.move(1, 50, 50);
    t.up(1, 50, 50);
    expect(t.down(2, 0, 0)).toBe(false);
    clock.advance(TICK_MS * 5);
    expect(contacts().length).toBe(1);
    t.onData(header(EVENTID.RESUME_INPUT), channel);
    expect(t.available).toBe(true);
    expect(t.down(3, 1, 1)).toBe(true);
    clock.advance(0);
    // 中断の前の接触は捨てたので、ID 0 から使う。最初のフレームの frameOffset は 0
    expect(contacts()[1]).toEqual([[0, TOUCH_DOWN, 1, 1]]);
    expect(frames()[1]?.frames[0]?.frameOffset).toBe(0n);
  });

  test("チャネルが閉じたら、次の SC_READY まで使えない", () => {
    const { t, channel } = setup();
    t.onClose();
    expect(t.available).toBe(false);
    t.onOpen(channel);
    expect(t.available).toBe(false);
    t.onData(scReady(PROTOCOL.V200), channel);
    expect(t.available).toBe(true);
  });

  test("drdynvc の上で Microsoft::Windows::RDS::Input を開き、SC_READY に答える", () => {
    const sent: Uint8Array[] = [];
    const dvc = new DynamicChannels((d) => sent.push(d));
    const t = new TouchInput({ maxContacts: 5 });
    dvc.register(INPUT, t);
    dvc.onStatic(
      concat(fromHex("1004"), new TextEncoder().encode(`${INPUT}\0`)),
    );
    expect(hex(sent[0] as Uint8Array)).toBe("100400000000");
    dvc.onStatic(concat(fromHex("3004"), scReady(PROTOCOL.V200)));
    expect(t.available).toBe(true);
    // DATA(0x30)、ID 4、CS_READY
    expect(hex(sent[1] as Uint8Array)).toBe(
      "3004" + hex(csReady(1, PROTOCOL.V200, 5)),
    );
  });
});

describe("attachChannels のタッチ", () => {
  const open = (touch: number) => {
    const sent: Uint8Array[] = [];
    const client = {
      sendChannel: (_name: string, d: Uint8Array) => sent.push(d),
      onChannel: undefined as
        ((name: string, data: Uint8Array) => void) | undefined,
    };
    const ch = attachChannels(client as unknown as RdpClient, () => {}, {
      touch,
    });
    client.onChannel?.(
      "drdynvc",
      concat(fromHex("1004"), new TextEncoder().encode(`${INPUT}\0`)),
    );
    return { ch, sent };
  };
  test("maxTouchPoints が 1 以上なら、Input のチャネルを受ける", () => {
    const { ch, sent } = open(5);
    expect(ch.touch).toBeDefined();
    expect(hex(sent[0] as Uint8Array)).toBe("100400000000");
  });
  test("maxTouchPoints が 0 なら登録せず、開く求めを断る", () => {
    const { ch, sent } = open(0);
    expect(ch.touch).toBeUndefined();
    expect(hex(sent[0] as Uint8Array)).toBe("1004010000c0");
  });
});
