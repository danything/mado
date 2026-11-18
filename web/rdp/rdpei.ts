// 指の入力を相手の Windows にタッチとして送る([MS-RDPEI] Input Virtual Channel Extension)。
// 動的チャネル Microsoft::Windows::RDS::Input の上で話す。サーバーが SC_READY を送ってきたら CS_READY を返し、
// そのあとは触れている接触を 1 つのフレームにまとめて、TICK_MS ごとに TOUCH_EVENT で送る。
// DOM は使わない。display.ts が CSS の位置を RDP の座標にしてから渡す。

import { concat, Reader, Writer } from "./bytes";
import type { DynamicChannel, DynamicHandler } from "./dvc";

export const INPUT = "Microsoft::Windows::RDS::Input";

export const EVENTID = {
  SC_READY: 0x0001,
  CS_READY: 0x0002,
  TOUCH: 0x0003,
  SUSPEND_INPUT: 0x0004,
  RESUME_INPUT: 0x0005,
  DISMISS_HOVERING_TOUCH_CONTACT: 0x0006,
  PEN: 0x0008,
} as const;

export const PROTOCOL = {
  V100: 0x00010000,
  V101: 0x00010001,
  V200: 0x00020000,
  V300: 0x00030000,
} as const;

const VERSIONS = [PROTOCOL.V100, PROTOCOL.V101, PROTOCOL.V200, PROTOCOL.V300];

export const CS_READY_FLAGS = {
  SHOW_TOUCH_VISUALS: 0x1,
  DISABLE_TIMESTAMP_INJECTION: 0x2,
  ENABLE_MULTIPEN_INJECTION: 0x4,
} as const;

export const CONTACT_FLAG = {
  DOWN: 0x01,
  UPDATE: 0x02,
  UP: 0x04,
  INRANGE: 0x08,
  INCONTACT: 0x10,
  CANCELED: 0x20,
} as const;

/** 指を置いた・動かしている・離した・取り消された。仕様 2.2.3.3.1.1 が認める組み合わせから、指で使うものだけ */
export const TOUCH_DOWN =
  CONTACT_FLAG.DOWN | CONTACT_FLAG.INRANGE | CONTACT_FLAG.INCONTACT;
export const TOUCH_UPDATE =
  CONTACT_FLAG.UPDATE | CONTACT_FLAG.INRANGE | CONTACT_FLAG.INCONTACT;
export const TOUCH_UP = CONTACT_FLAG.UP;
export const TOUCH_CANCEL = CONTACT_FLAG.UP | CONTACT_FLAG.CANCELED;

/** フレームを送る間隔。60Hz を超えないよう、16.7ms より少し長くする */
export const TICK_MS = 17;

// ---- 可変長の整数(仕様 2.2.2.1〜2.2.2.5) ----
// どれも最初のバイトの上位ビットにバイト数(と符号)を入れ、値は上位のバイトから順に並べる

/** TWO_BYTE_UNSIGNED_INTEGER。0〜0x7FFF */
export function writeU2(w: Writer, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0x7fff)
    throw new RangeError(`TWO_BYTE_UNSIGNED の範囲外: ${v}`);
  if (v <= 0x7f) w.u8(v);
  else w.u8(0x80 | (v >> 8)).u8(v & 0xff);
}

export function readU2(r: Reader): number {
  const b = r.u8();
  const v = b & 0x7f;
  return b & 0x80 ? (v << 8) | r.u8() : v;
}

/** TWO_BYTE_SIGNED_INTEGER。-0x3FFF〜0x3FFF */
export function writeS2(w: Writer, v: number): void {
  const a = Math.abs(v);
  if (!Number.isInteger(v) || a > 0x3fff)
    throw new RangeError(`TWO_BYTE_SIGNED の範囲外: ${v}`);
  const s = v < 0 ? 0x40 : 0;
  if (a <= 0x3f) w.u8(s | a);
  else w.u8(0x80 | s | (a >> 8)).u8(a & 0xff);
}

export function readS2(r: Reader): number {
  const b = r.u8();
  let a = b & 0x3f;
  if (b & 0x80) a = (a << 8) | r.u8();
  return b & 0x40 ? -a : a;
}

/** 上位のバイトから n バイトを書く。最初のバイトには head を重ねる */
function writeBig(w: Writer, v: number, n: number, head: number): void {
  for (let i = n - 1; i >= 0; i--) {
    // 32 ビットを超えないので、シフトの代わりに割り算で切り出す
    const byte = Math.floor(v / 2 ** (8 * i)) & 0xff;
    w.u8(i === n - 1 ? head | byte : byte);
  }
}

function readBig(r: Reader, first: number, n: number): number {
  let v = first;
  for (let i = 1; i < n; i++) v = v * 256 + r.u8();
  return v;
}

/** FOUR_BYTE_UNSIGNED_INTEGER。0〜0x3FFFFFFF */
export function writeU4(w: Writer, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0x3fffffff)
    throw new RangeError(`FOUR_BYTE_UNSIGNED の範囲外: ${v}`);
  const n = v <= 0x3f ? 1 : v <= 0x3fff ? 2 : v <= 0x3fffff ? 3 : 4;
  writeBig(w, v, n, (n - 1) << 6);
}

export function readU4(r: Reader): number {
  const b = r.u8();
  return readBig(r, b & 0x3f, (b >> 6) + 1);
}

/** FOUR_BYTE_SIGNED_INTEGER。-0x1FFFFFFF〜0x1FFFFFFF */
export function writeS4(w: Writer, v: number): void {
  const a = Math.abs(v);
  if (!Number.isInteger(v) || a > 0x1fffffff)
    throw new RangeError(`FOUR_BYTE_SIGNED の範囲外: ${v}`);
  const n = a <= 0x1f ? 1 : a <= 0x1fff ? 2 : a <= 0x1fffff ? 3 : 4;
  writeBig(w, a, n, ((n - 1) << 6) | (v < 0 ? 0x20 : 0));
}

export function readS4(r: Reader): number {
  const b = r.u8();
  const a = readBig(r, b & 0x1f, (b >> 6) + 1);
  return b & 0x20 ? -a : a;
}

/** EIGHT_BYTE_UNSIGNED_INTEGER。0〜0x1FFFFFFFFFFFFFFF。number の整数で表せない値は bigint で渡す */
export function writeU8(w: Writer, value: number | bigint): void {
  const v = BigInt(value);
  if (v < 0n || v > 0x1fffffffffffffffn)
    throw new RangeError(`EIGHT_BYTE_UNSIGNED の範囲外: ${v}`);
  let n = 1;
  while (n < 8 && v >> BigInt(5 + 8 * (n - 1)) !== 0n) n++;
  for (let i = n - 1; i >= 0; i--) {
    const byte = Number((v >> BigInt(8 * i)) & 0xffn);
    w.u8(i === n - 1 ? ((n - 1) << 5) | byte : byte);
  }
}

export function readU8(r: Reader): bigint {
  const b = r.u8();
  const n = (b >> 5) + 1;
  let v = BigInt(b & 0x1f);
  for (let i = 1; i < n; i++) v = (v << 8n) | BigInt(r.u8());
  return v;
}

// ---- PDU ----

/** RDPINPUT_HEADER(eventId 2 バイト、pduLength 4 バイト)を前に付ける。pduLength はヘッダーを含む */
function withHeader(eventId: number, body: Uint8Array): Uint8Array {
  return concat(
    new Writer(6)
      .u16(eventId)
      .u32(6 + body.length)
      .done(),
    body,
  );
}

export type ScReady = { protocolVersion: number; supportedFeatures?: number };

/** 届いた PDU のヘッダーを読む。pduLength が受けた長さと合わなければ undefined(仕様 3.1.5.1 では無視する) */
export function readHeader(
  data: Uint8Array,
): { eventId: number; body: Reader } | undefined {
  if (data.length < 6) return undefined;
  const r = new Reader(data);
  const eventId = r.u16();
  if (r.u32() !== data.length) return undefined;
  return { eventId, body: r };
}

export function readScReady(body: Reader): ScReady {
  const protocolVersion = body.u32();
  // supportedFeatures は V300 で付く。V300 でも無いことがあるので、残りの長さで見る
  return body.left >= 4
    ? { protocolVersion, supportedFeatures: body.u32() }
    : { protocolVersion };
}

/** 相手のバージョンに合わせて返すバージョン。知っているバージョンのうち、相手のバージョンを超えない最大のもの。V100 より古い値なら V100 */
export function chooseVersion(server: number): number {
  let v: number = PROTOCOL.V100;
  for (const known of VERSIONS) if (known <= server) v = known;
  return v;
}

export function csReady(
  flags: number,
  protocolVersion: number,
  maxTouchContacts: number,
): Uint8Array {
  return withHeader(
    EVENTID.CS_READY,
    new Writer(10).u32(flags).u32(protocolVersion).u16(maxTouchContacts).done(),
  );
}

export type TouchContact = {
  contactId: number;
  x: number;
  y: number;
  contactFlags: number;
  /** 接触の矩形。x・y からの相対 */
  rect?: { left: number; top: number; right: number; bottom: number };
  /** 0〜359 度 */
  orientation?: number;
  /** 0〜1024 */
  pressure?: number;
};

export type TouchFrame = {
  /** 前のフレームからの時間(マイクロ秒)。最初に送るフレームは 0 */
  frameOffset: number | bigint;
  contacts: TouchContact[];
};

const FIELDS = { RECT: 0x1, ORIENTATION: 0x2, PRESSURE: 0x4 } as const;

/** encodeTime は、いちばん古いフレームができてから符号化するまでの時間(ミリ秒) */
export function touchEvent(
  encodeTime: number,
  frames: TouchFrame[],
): Uint8Array {
  const w = new Writer(64);
  writeU4(w, encodeTime);
  writeU2(w, frames.length);
  for (const f of frames) {
    writeU2(w, f.contacts.length);
    writeU8(w, f.frameOffset);
    for (const c of f.contacts) {
      w.u8(c.contactId);
      const present =
        (c.rect ? FIELDS.RECT : 0) |
        (c.orientation !== undefined ? FIELDS.ORIENTATION : 0) |
        (c.pressure !== undefined ? FIELDS.PRESSURE : 0);
      writeU2(w, present);
      writeS4(w, c.x);
      writeS4(w, c.y);
      writeU4(w, c.contactFlags);
      if (c.rect) {
        writeS2(w, c.rect.left);
        writeS2(w, c.rect.top);
        writeS2(w, c.rect.right);
        writeS2(w, c.rect.bottom);
      }
      if (c.orientation !== undefined) writeU4(w, c.orientation);
      if (c.pressure !== undefined) writeU4(w, c.pressure);
    }
  }
  return withHeader(EVENTID.TOUCH, w.done());
}

/** TOUCH_EVENT の本体を読む。サーバーは受けないが、試験で送ったものを確かめるのに使う */
export function readTouchEvent(body: Reader): {
  encodeTime: number;
  frames: TouchFrame[];
} {
  const encodeTime = readU4(body);
  const frames: TouchFrame[] = [];
  for (let n = readU2(body); n > 0; n--) {
    const count = readU2(body);
    const frameOffset = readU8(body);
    const contacts: TouchContact[] = [];
    for (let i = 0; i < count; i++) {
      const c: TouchContact = {
        contactId: body.u8(),
        x: 0,
        y: 0,
        contactFlags: 0,
      };
      const present = readU2(body);
      c.x = readS4(body);
      c.y = readS4(body);
      c.contactFlags = readU4(body);
      if (present & FIELDS.RECT)
        c.rect = {
          left: readS2(body),
          top: readS2(body),
          right: readS2(body),
          bottom: readS2(body),
        };
      if (present & FIELDS.ORIENTATION) c.orientation = readU4(body);
      if (present & FIELDS.PRESSURE) c.pressure = readU4(body);
      contacts.push(c);
    }
    frames.push({ frameOffset, contacts });
  }
  return { encodeTime, frames };
}

/** 浮いている(hovering)接触を範囲の外にする。指の接触は浮かないので TouchInput は送らない */
export function dismissHoveringContact(contactId: number): Uint8Array {
  return withHeader(
    EVENTID.DISMISS_HOVERING_TOUCH_CONTACT,
    Uint8Array.of(contactId & 0xff),
  );
}

// ---- 状態機械 ----

type Pending = { flags: number; x: number; y: number; t: number };

type Contact = {
  id: number;
  /** まだ送っていない状態の変化。古い順 */
  queue: Pending[];
  /** DOWN を送り、まだ UP を送っていない */
  engaged: boolean;
  /** 最後に送った位置 */
  x: number;
  y: number;
};

export type TouchInputOptions = {
  /** CS_READY の maxTouchContacts。ブラウザの navigator.maxTouchPoints を渡す */
  maxContacts: number;
  now?: () => number;
  /** fn を ms 後に呼ぶ。試験では偽物を渡す */
  schedule?: (fn: () => void, ms: number) => void;
};

/**
 * Microsoft::Windows::RDS::Input の受け手。SC_READY を受けたら available になり、down / move / up / cancel を送れる。
 * 送るのは TICK_MS ごとに 1 フレーム。触れている接触はすべて毎回のフレームに入れる(動いていなくても UPDATE で送る)
 */
export class TouchInput implements DynamicHandler {
  private channel?: DynamicChannel;
  /** CS_READY で返したバージョン。0 は SC_READY をまだ受けていない */
  version = 0;
  /** SC_READY の supportedFeatures。V300 のときだけ入る */
  supportedFeatures?: number;
  /** サーバーが SUSPEND_INPUT を送ってきて、RESUME_INPUT をまだ送ってこない */
  suspended = false;

  private readonly maxContacts: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  /** 接触の ID → 接触。UP を送るまで残す */
  private contacts = new Map<number, Contact>();
  /** ポインタの ID → 接触。離したら消す */
  private pointers = new Map<number, Contact>();
  private timer = false;
  /** 最後に送ったフレームの時刻(中の変化が起きた時刻)。frameOffset に使う。まだ送っていなければ undefined */
  private lastFrame?: number;
  /** 最後にフレームを送った時刻。送る間隔に使う */
  private lastSent = -Infinity;

  constructor(options: TouchInputOptions) {
    this.maxContacts = Math.max(1, Math.min(256, options.maxContacts));
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  get available(): boolean {
    return this.channel !== undefined && this.version !== 0 && !this.suspended;
  }

  onOpen(channel: DynamicChannel): void {
    this.channel = channel;
  }

  onData(data: Uint8Array, channel: DynamicChannel): void {
    const h = readHeader(data);
    if (!h) return;
    switch (h.eventId) {
      case EVENTID.SC_READY: {
        // protocolVersion の無い SC_READY は、例外にせず無視する
        if (h.body.left < 4) break;
        const ready = readScReady(h.body);
        this.channel = channel;
        this.version = chooseVersion(ready.protocolVersion);
        this.supportedFeatures =
          this.version >= PROTOCOL.V300 ? ready.supportedFeatures : undefined;
        this.suspended = false;
        this.reset();
        // 時刻は送るので DISABLE_TIMESTAMP_INJECTION は付けない。触れた位置は Windows に描かせる
        channel.send(
          csReady(
            CS_READY_FLAGS.SHOW_TOUCH_VISUALS,
            this.version,
            this.maxContacts,
          ),
        );
        break;
      }
      case EVENTID.SUSPEND_INPUT:
        if (this.suspended) break;
        this.suspended = true;
        // 送るのを止める。触れている指の続きも送らない
        this.reset();
        break;
      case EVENTID.RESUME_INPUT:
        this.suspended = false;
        break;
    }
  }

  onClose(): void {
    this.channel = undefined;
    this.version = 0;
    this.supportedFeatures = undefined;
    this.suspended = false;
    this.reset();
  }

  /** 指を置いた。送れないとき(準備前・中断中・接触が多すぎる)は false を返し、この指の続きは無視する */
  down(pointerId: number, x: number, y: number): boolean {
    if (!this.available || this.pointers.has(pointerId)) return false;
    const id = this.freeId();
    if (id === undefined) return false;
    const c: Contact = { id, queue: [], engaged: false, x, y };
    c.queue.push({ flags: TOUCH_DOWN, x, y, t: this.now() });
    this.contacts.set(id, c);
    this.pointers.set(pointerId, c);
    this.pump();
    return true;
  }

  move(pointerId: number, x: number, y: number): void {
    const c = this.pointers.get(pointerId);
    if (!c) return;
    this.moveTo(c, x, y);
    this.pump();
  }

  /** 指を離した。離した位置が最後の位置と違えば、先に UPDATE で動かしてから UP を送る(UP で位置は変えられない) */
  up(pointerId: number, x: number, y: number): void {
    const c = this.pointers.get(pointerId);
    if (!c) return;
    this.pointers.delete(pointerId);
    this.moveTo(c, x, y);
    c.queue.push({ flags: TOUCH_UP, x, y, t: this.now() });
    this.pump();
  }

  /** ブラウザが指を取り消した(pointercancel) */
  cancel(pointerId: number): void {
    const c = this.pointers.get(pointerId);
    if (!c) return;
    this.pointers.delete(pointerId);
    const at = this.lastPos(c);
    c.queue.push({ flags: TOUCH_CANCEL, x: at.x, y: at.y, t: this.now() });
    this.pump();
  }

  /** 1 フレームを作って送る。送るものが無ければ何もしない。ふだんはタイマーが呼ぶ */
  tick(): void {
    if (!this.channel || !this.available) return;
    const contacts: TouchContact[] = [];
    const now = this.now();
    let oldest = now;
    for (const c of this.contacts.values()) {
      const p = c.queue.shift();
      if (p) {
        oldest = Math.min(oldest, p.t);
        c.x = p.x;
        c.y = p.y;
        if (p.flags & CONTACT_FLAG.DOWN) c.engaged = true;
        if (p.flags & CONTACT_FLAG.UP) {
          c.engaged = false;
          this.contacts.delete(c.id);
        }
        contacts.push({
          contactId: c.id,
          x: p.x,
          y: p.y,
          contactFlags: p.flags,
        });
      } else if (c.engaged) {
        // 動いていない指も毎フレーム入れる。抜けると Windows はその接触を終わったものとみなす
        contacts.push({
          contactId: c.id,
          x: c.x,
          y: c.y,
          contactFlags: TOUCH_UPDATE,
        });
      }
    }
    if (contacts.length === 0) return;
    const frameOffset =
      this.lastFrame === undefined
        ? 0
        : Math.max(0, Math.round((oldest - this.lastFrame) * 1000));
    this.lastFrame = Math.max(this.lastFrame ?? oldest, oldest);
    this.lastSent = now;
    this.channel.send(
      touchEvent(Math.max(0, Math.round(now - oldest)), [
        { frameOffset, contacts },
      ]),
    );
  }

  private moveTo(c: Contact, x: number, y: number): void {
    const last = c.queue.at(-1);
    if (last && last.flags === TOUCH_UPDATE) {
      // まだ送っていない UPDATE は、新しい位置で上書きする
      last.x = x;
      last.y = y;
      last.t = this.now();
      return;
    }
    const at = this.lastPos(c);
    if (at.x === x && at.y === y) return;
    c.queue.push({ flags: TOUCH_UPDATE, x, y, t: this.now() });
  }

  private lastPos(c: Contact): { x: number; y: number } {
    return c.queue.at(-1) ?? c;
  }

  /** 使っていない最小の接触の ID */
  private freeId(): number | undefined {
    for (let id = 0; id < this.maxContacts; id++)
      if (!this.contacts.has(id)) return id;
    return undefined;
  }

  /** 接触が残っている間、TICK_MS ごとに tick を呼ぶ。前のフレームから TICK_MS 経っていれば、すぐ送る */
  private pump(): void {
    if (this.timer) return;
    this.timer = true;
    const wait = Math.max(0, this.lastSent + TICK_MS - this.now());
    this.schedule(() => {
      this.timer = false;
      if (!this.available) return;
      this.tick();
      if (this.contacts.size > 0) this.pump();
    }, wait);
  }

  private reset(): void {
    this.contacts.clear();
    this.pointers.clear();
    this.lastFrame = undefined;
    this.lastSent = -Infinity;
  }
}
