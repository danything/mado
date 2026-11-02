// Intel AMT の IDE-R(IDE Redirection)。ブラウザで選んだ ISO を、AMT 越しに CD-ROM として相手の PC に見せる。
// ISO はブラウザの File から読むだけで、mado には AMT への生のバイト列しか流れない(mado の /ws/amt は中身を見ない)。
//
// IDE-R のメッセージと SCSI(ATAPI)の応答は、Intel の Device Management Toolkit の UI Toolkit
// (https://github.com/device-management-toolkit/ui-toolkit の src/core/AMTIDER.ts、IDERDataProcessor.ts、Constants.ts)を元に、
// Uint8Array と async で書き直したもの。MODE SENSE と GET CONFIGURATION の表はそのまま使っている。
//   Copyright (c) Intel Corporation 2023
//   SPDX-License-Identifier: Apache-2.0(http://www.apache.org/licenses/LICENSE-2.0)
// 変えたところ: CD-ROM だけにした(フロッピーは無い)、書き込みはすべて断る、読み出しは 1 つずつ順に返す、
// 終わりの応答は「正常」と「SCSI のエラー(sense)」の 2 つに分けた。

import { concat, Writer } from "../rdp/bytes";
import type { Transport } from "../rdp/stream";
import { type AuthOptions, openRedirection } from "./redirect";

/** IDE-R のメッセージ(先頭の 1 バイト) */
export const IDER = {
  openSession: 0x40,
  openSessionReply: 0x41,
  close: 0x43,
  ping: 0x44,
  pong: 0x45,
  resetOccurred: 0x46,
  resetOccurredReply: 0x47,
  disableEnableFeatures: 0x48,
  disableEnableFeaturesReply: 0x49,
  errorOccurred: 0x4a,
  heartbeat: 0x4b,
  commandWritten: 0x50,
  commandEnd: 0x51,
  getDataFromHost: 0x52,
  dataFromHost: 0x53,
  dataToHost: 0x54,
} as const;

/** CD-ROM の装置(ATA のドライブ選択)。フロッピーは 0xA0 */
export const DEV_CD = 0xb0;
const SECTOR = 2048;

/** DisableEnableFeatures の種類と値。REGS_TOGGLE で「次に起動したとき IDE-R を有効にする」 */
const REGS_AVAIL = 1;
const REGS_STATUS = 2;
const REGS_TOGGLE = 3;
const ENABLE_ON_REBOOT = 0x01 + 0x08;

// ---- UI Toolkit の Constants.ts から(CD-ROM に使うものだけ) ----
const b = (...x: number[]) => new Uint8Array(x);
const MODE_SENSE_CD_01 = b(
  0x00,
  0x0e,
  0x01,
  0x80,
  0,
  0,
  0,
  0,
  0x01,
  0x06,
  0x00,
  0xff,
  0,
  0,
  0,
  0,
);
const MODE_SENSE_CD_1A = b(
  0x00,
  0x12,
  0x01,
  0x80,
  0,
  0,
  0,
  0,
  0x1a,
  0x0a,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
);
const MODE_SENSE_CD_1D = b(
  0x00,
  0x12,
  0x01,
  0x80,
  0,
  0,
  0,
  0,
  0x1d,
  0x0a,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
);
const MODE_SENSE_CD_2A = b(
  0x00,
  0x20,
  0x01,
  0x80,
  0,
  0,
  0,
  0,
  0x2a,
  0x18,
  0,
  0,
  0,
  0,
  0x20,
  0,
  0,
  0,
  0,
  0,
  0,
  0x80,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
);
const MODE_SENSE_CD_3F = b(
  0x00,
  0x28,
  0x01,
  0x80,
  0,
  0,
  0,
  0,
  0x01,
  0x06,
  0x00,
  0xff,
  0,
  0,
  0,
  0,
  0x2a,
  0x18,
  0,
  0,
  0,
  0,
  0x02,
  0,
  0,
  0,
  0,
  0,
  0,
  0x80,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
);
const CONFIG = {
  profileList: b(0x00, 0x00, 0x03, 0x04, 0x00, 0x08, 0x01, 0x00),
  core: b(0x00, 0x01, 0x03, 0x04, 0x00, 0x00, 0x00, 0x02),
  morphing: b(0x00, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00),
  removable: b(0x00, 0x03, 0x03, 0x04, 0x29, 0x00, 0x00, 0x02),
  random: b(
    0x00,
    0x10,
    0x01,
    0x08,
    0x00,
    0x00,
    0x08,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
  ),
  read: b(0x00, 0x1e, 0x03, 0x00),
  powerManagement: b(0x01, 0x00, 0x03, 0x00),
  timeout: b(0x01, 0x05, 0x03, 0x00),
};
const PERFORMANCE = b(0x00, 0x00, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00);
const TOC_SESSION = b(
  0x00,
  0x0a,
  0x01,
  0x01,
  0x00,
  0x14,
  0x01,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
);
const TOC_MSF = b(
  0x00,
  0x12,
  0x01,
  0x01,
  0x00,
  0x14,
  0x01,
  0x00,
  0x00,
  0x00,
  0x02,
  0x00,
  0x00,
  0x14,
  0xaa,
  0x00,
  0x00,
  0x00,
  0x34,
  0x13,
);
const TOC_LBA = b(
  0x00,
  0x12,
  0x01,
  0x01,
  0x00,
  0x14,
  0x01,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x14,
  0xaa,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
);

const be16 = (d: Uint8Array, o: number) =>
  ((d[o] as number) << 8) | (d[o + 1] as number);
const be32 = (d: Uint8Array, o: number) =>
  (d[o] as number) * 0x1000000 +
  (((d[o + 1] as number) << 16) |
    ((d[o + 2] as number) << 8) |
    (d[o + 3] as number));
const le16 = (d: Uint8Array, o: number) =>
  (d[o] as number) | ((d[o + 1] as number) << 8);
const le32 = (d: Uint8Array, o: number) =>
  new DataView(d.buffer, d.byteOffset).getUint32(o, true);
const u32be = (v: number) =>
  b((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);

/** AMT から来る IDE-R のメッセージの長さ。足りなければ peek で待つ */
async function messageLength(io: Transport, type: number): Promise<number> {
  switch (type) {
    case IDER.openSessionReply: {
      const h = await io.peek(30);
      return 30 + (h[29] as number);
    }
    case IDER.close:
    case IDER.ping:
    case IDER.pong:
    case IDER.heartbeat:
      return 8;
    case IDER.resetOccurred:
      return 9;
    case IDER.disableEnableFeaturesReply:
      return 13;
    case IDER.errorOccurred:
      return 11;
    case IDER.commandWritten:
      return 28;
    case IDER.dataFromHost: {
      const h = await io.peek(14);
      return 14 + le16(h, 9);
    }
    default:
      throw new Error(`IDE-R: 知らないメッセージです(0x${type.toString(16)})`);
  }
}

export type IderStats = {
  /** 読まれたバイト数(ISO から送った分) */
  bytesRead: number;
  /** 最後に読まれたセクタ */
  lastLba: number;
  /** SCSI の要求の数 */
  commands: number;
};

export type IderOptions = AuthOptions & {
  /** CD-ROM として見せる ISO */
  cd: Blob;
};

/** IDE-R の 1 本。start で認証して OPEN_SESSION を済ませ、AMT が次の起動で IDE-R を有効にすると答えたら返る */
export class IderSession {
  readonly stats: IderStats = { bytesRead: 0, lastLba: 0, commands: 0 };
  /** 読まれるたびに呼ぶ(画面の進み具合) */
  onProgress: (s: IderStats) => void = () => {};
  /** 受信が終わったら(切れたら)解決する。理由の文 */
  readonly done: Promise<string>;
  /** AMT が IDE-R の状態を知らせてきたら true(REGS_STATUS) */
  enabled = false;
  private resolveDone!: (reason: string) => void;
  private outSeq = 0;
  private inSeq = 0;
  private readBuffer = 8192;
  private closed = false;
  private readonly blocks: number;
  private toggled?: (ok: boolean) => void;

  private constructor(
    private readonly io: Transport,
    private readonly cd: Blob,
  ) {
    this.blocks = Math.floor(cd.size / SECTOR);
    this.done = new Promise((r) => {
      this.resolveDone = r;
    });
  }

  static async start(io: Transport, o: IderOptions): Promise<IderSession> {
    const s = new IderSession(io, o.cd);
    await openRedirection(io, "IDER", o);
    const ready = new Promise<boolean>((r) => {
      s.toggled = r;
    });
    // OPEN_SESSION: 受信の待ち 30000ms、送信の待ち 0、生存確認 20000ms、版 1(UI Toolkit と同じ)
    s.send(
      IDER.openSession,
      new Writer(10).u16(30000).u16(0).u16(20000).u32(1).done(),
    );
    void s.loop();
    const ok = await Promise.race([
      ready,
      s.done.then((reason) => {
        throw new Error(`IDE-R が始まる前に切断されました: ${reason}`);
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("IDE-R: AMT が 15 秒応答しません")),
          15_000,
        ),
      ),
    ]);
    if (!ok) {
      s.close();
      throw new Error(
        "AMT が IDE-R を有効にできませんでした。ほかで IDE-R を使っていないか確かめてください",
      );
    }
    return s;
  }

  /** メッセージを送る。頭は 種類、0、0、属性、送った順の番号(LE32) */
  send(
    cmd: number,
    data: Uint8Array = new Uint8Array(),
    completed = false,
    dma?: number,
  ): void {
    if (this.closed) return;
    let attributes = cmd > 50 && completed ? 2 : 0;
    if (dma !== undefined) attributes += 1;
    this.io.write(
      concat(
        new Writer(8).u8(cmd).zeros(2).u8(attributes).u32(this.outSeq++).done(),
        data,
      ),
    );
  }

  private async loop(): Promise<void> {
    let reason = "切断されました";
    try {
      for (;;) {
        const type = (await this.io.peek(1))[0] as number;
        const m = await this.io.read(await messageLength(this.io, type));
        if (le32(m, 4) !== this.inSeq)
          throw new Error(
            `IDE-R: 番号が飛びました(${this.inSeq} のはずが ${le32(m, 4)})`,
          );
        this.inSeq++;
        await this.handle(type, m);
        if (type === IDER.close) {
          reason = "AMT が IDE-R を閉じました";
          break;
        }
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    } finally {
      this.closed = true;
      this.io.close();
      this.toggled?.(false);
      this.resolveDone(reason);
    }
  }

  private async handle(type: number, m: Uint8Array): Promise<void> {
    switch (type) {
      case IDER.openSessionReply: {
        // 16: 読みの緩衝(LE16)、21: プロトコル。UI Toolkit と同じく 8192 を超えるものと 0 以外のプロトコルは断る
        this.readBuffer = le16(m, 16);
        if (m[21] !== 0 || this.readBuffer > 8192 || this.readBuffer === 0)
          throw new Error(
            `IDE-R: 知らない形式です(プロトコル ${m[21]}、緩衝 ${this.readBuffer})`,
          );
        this.toggle();
        return;
      }
      case IDER.ping:
        this.send(IDER.pong);
        return;
      case IDER.resetOccurred:
        // 読み出しは 1 つずつ終えてから次を読むので、ここで返してよい
        this.send(IDER.resetOccurredReply);
        return;
      case IDER.disableEnableFeaturesReply: {
        const kind = m[8] as number;
        const value = le32(m, 9);
        if (kind === REGS_AVAIL && (value & 1) !== 0) this.toggle();
        else if (kind === REGS_STATUS) this.enabled = (value & 2) !== 0;
        else if (kind === REGS_TOGGLE) {
          this.toggled?.(value === 1);
          this.toggled = undefined;
        }
        return;
      }
      case IDER.commandWritten:
        this.stats.commands++;
        await this.scsi(m);
        return;
      case IDER.dataFromHost:
        // 書き込みは受けない(書き込み禁止)
        this.endWithSense(0xa0, 0x07, 0x27, 0x00);
        return;
      default:
        // pong、heartbeat、errorOccurred、close は何もしない
        return;
    }
  }

  /** 次に起動したとき IDE-R を有効にするよう頼む */
  private toggle(): void {
    this.send(
      IDER.disableEnableFeatures,
      concat(b(REGS_TOGGLE), new Writer(4).u32(ENABLE_ON_REBOOT).done()),
    );
  }

  // ---- SCSI ----

  /** 正常に終わった */
  private endOk(dev: number): void {
    this.send(
      IDER.commandEnd,
      b(
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0xc5,
        0,
        3,
        0,
        0,
        0,
        dev,
        0x50,
        0,
        0,
        0,
      ),
      true,
    );
  }

  /** SCSI のエラー。sense key と ASC / ASCQ を返す */
  private endWithSense(
    dev: number,
    sense: number,
    asc: number,
    ascq: number,
  ): void {
    this.send(
      IDER.commandEnd,
      b(
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0x87,
        sense << 4,
        3,
        0,
        0,
        0,
        dev,
        0x51,
        sense,
        asc,
        ascq,
      ),
      true,
    );
  }

  /** データを返す。completed なら最後のかたまりで、終わりの状態も付ける */
  private dataToHost(
    dev: number,
    completed: boolean,
    data: Uint8Array,
    dma: number,
  ): void {
    const n = data.length;
    const dmaLen = dma !== 0 ? 0 : n;
    const head = b(
      0,
      n & 0xff,
      n >> 8,
      0,
      dma !== 0 ? 0xb4 : 0xb5,
      0,
      2,
      0,
      dmaLen & 0xff,
      dmaLen >> 8,
      dev,
      0x58,
    );
    const tail = completed
      ? b(0x85, 0, 3, 0, 0, 0, dev, 0x50, 0, 0, 0, 0, 0, 0)
      : new Uint8Array(14);
    this.send(IDER.dataToHost, concat(head, tail, data), completed, dma);
  }

  /** 小さな応答。要求された長さで切る */
  private reply(
    dev: number,
    data: Uint8Array,
    dma: number,
    max?: number,
  ): void {
    this.dataToHost(
      dev,
      true,
      max !== undefined && data.length > max ? data.subarray(0, max) : data,
      dma,
    );
  }

  private async scsi(m: Uint8Array): Promise<void> {
    const dev = ((m[14] as number) & 0x10) !== 0 ? DEV_CD : 0xa0;
    const flags = m[14] as number;
    const cdb = m.subarray(16, 28);
    const dma = (m[9] as number) & 1;
    // フロッピーは無い
    if (dev !== DEV_CD) {
      this.endWithSense(dev, 0x02, 0x3a, 0x00);
      return;
    }
    switch (cdb[0]) {
      case 0x00: // TEST_UNIT_READY
      case 0x1b: // START_STOP
      case 0x1e: // ALLOW_MEDIUM_REMOVAL
        this.endOk(dev);
        return;
      case 0x08: {
        // READ_6
        const lba = (((cdb[1] as number) & 0x1f) << 16) | be16(cdb, 2);
        await this.read(dev, lba, cdb[4] || 256, dma);
        return;
      }
      case 0x28: // READ_10
        await this.read(dev, be32(cdb, 2), be16(cdb, 7), dma);
        return;
      case 0x25: // READ_CAPACITY。最後のセクタと、セクタの大きさ(2048)。UI Toolkit と同じく装置の欄は要求のものをそのまま返す
        this.dataToHost(
          flags,
          true,
          concat(u32be(this.blocks - 1), b(0, 0, 0x08, 0)),
          dma,
        );
        return;
      case 0x23: // READ_FORMAT_CAPACITIES
        this.reply(
          dev,
          concat(u32be(8), b(0x00, 0x00, 0x0b, 0x40, 0x02, 0x00, 0x02, 0x00)),
          dma,
        );
        return;
      case 0x1a: // MODE_SENSE_6
        if (cdb[2] === 0x3f && cdb[3] === 0x00)
          this.reply(dev, b(0, 0x05, 0x80, 0), dma);
        else this.endWithSense(dev, 0x05, 0x24, 0x00);
        return;
      case 0x5a: {
        // MODE_SENSE_10
        const len = be16(cdb, 7);
        const page = {
          0x01: MODE_SENSE_CD_01,
          0x1a: MODE_SENSE_CD_1A,
          0x1d: MODE_SENSE_CD_1D,
          0x2a: MODE_SENSE_CD_2A,
          0x3f: MODE_SENSE_CD_3F,
        }[(cdb[2] as number) & 0x3f];
        if (len === 0) this.reply(dev, concat(u32be(0x3c), u32be(8)), dma);
        else if (page) this.reply(dev, page, dma);
        else this.endWithSense(dev, 0x05, 0x20, 0x00);
        return;
      }
      case 0x43: {
        // READ_TOC
        const msf = ((cdb[1] as number) & 0x02) !== 0;
        let format = (cdb[2] as number) & 0x07;
        if (format === 0) format = (cdb[9] as number) >> 6;
        if (format === 1) this.reply(dev, TOC_SESSION, dma);
        else if (format === 0) this.reply(dev, msf ? TOC_MSF : TOC_LBA, dma);
        else this.endWithSense(dev, 0x05, 0x24, 0x00);
        return;
      }
      case 0x46: {
        // GET_CONFIGURATION
        const sendAll = cdb[1] !== 2;
        const first = be16(cdb, 2);
        const len = be16(cdb, 7);
        if (len === 0) {
          this.reply(dev, concat(u32be(0x3c), u32be(8)), dma);
          return;
        }
        const parts: Uint8Array[] = [u32be(0x0008)];
        const add = (code: number, part: Uint8Array) => {
          if (first === code || (sendAll && first < code)) parts.push(part);
        };
        if (first === 0) parts.push(CONFIG.profileList);
        add(0x01, CONFIG.core);
        add(0x02, CONFIG.morphing);
        add(0x03, CONFIG.removable);
        add(0x10, CONFIG.random);
        add(0x1e, CONFIG.read);
        add(0x100, CONFIG.powerManagement);
        add(0x105, CONFIG.timeout);
        const body = concat(...parts);
        this.reply(dev, concat(u32be(body.length), body), dma, len);
        return;
      }
      case 0x4a: // GET_EVENT_STATUS_NOTIFICATION。媒体はいつもある
        if (cdb[1] !== 0x01 && cdb[4] !== 0x10)
          this.endWithSense(dev, 0x05, 0x26, 0x01);
        else this.reply(dev, b(0x00, 0x02, 0x80, 0x00), dma);
        return;
      case 0xac: // GET_PERFORMANCE
        this.reply(dev, PERFORMANCE, dma);
        return;
      case 0x0a: // WRITE_6
      case 0x2a: // WRITE_10
      case 0x2e: // WRITE_AND_VERIFY
        this.endWithSense(dev, 0x07, 0x27, 0x00);
        return;
      default:
        // READ_DISC_INFO、MODE_SELECT_10 なども含め、知らないものは「その命令は無い」
        this.endWithSense(dev, 0x05, 0x20, 0x00);
        return;
    }
  }

  /** ISO から読んで返す。緩衝(readBuffer)ごとに分け、最後のかたまりに終わりの状態を付ける */
  private async read(
    dev: number,
    lba: number,
    count: number,
    dma: number,
  ): Promise<void> {
    if (count === 0) {
      this.endOk(dev);
      return;
    }
    if (lba + count > this.blocks) {
      // LOGICAL BLOCK ADDRESS OUT OF RANGE
      this.endWithSense(dev, 0x05, 0x21, 0x00);
      return;
    }
    let at = lba * SECTOR;
    const end = (lba + count) * SECTOR;
    while (at < end && !this.closed) {
      const n = Math.min(this.readBuffer, end - at);
      const data = new Uint8Array(
        await this.cd.slice(at, at + n).arrayBuffer(),
      );
      at += n;
      this.dataToHost(dev, at >= end, data, dma);
      this.stats.bytesRead += n;
    }
    this.stats.lastLba = lba + count - 1;
    this.onProgress(this.stats);
  }

  /** IDE-R を終えて閉じる。AMT は CD が抜かれたと見る */
  close(): void {
    this.closed = true;
    this.io.close();
  }
}
