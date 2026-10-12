// 動的仮想チャネル drdynvc([MS-RDPEDYC])と、その上の DisplayControl([MS-RDPEDISP])。
// drdynvc は静的チャネルの 1 つで、サーバーの求めで名前つきの動的チャネルを開く。

import { concat, Reader, Writer } from "./bytes";

const CMD = {
	CREATE: 0x01,
	DATA_FIRST: 0x02,
	DATA: 0x03,
	CLOSE: 0x04,
	CAPABILITIES: 0x05,
} as const;

/** 1 つの DVC PDU の大きさの上限。静的チャネルの断片 1 つに収める */
const MAX_PDU = 1590;

export interface DynamicChannel {
	readonly id: number;
	send(data: Uint8Array): void;
}

export interface DynamicHandler {
	/** サーバーがチャネルを開いた */
	onOpen?(channel: DynamicChannel): void;
	onData(data: Uint8Array, channel: DynamicChannel): void;
	onClose?(): void;
}

/** ID を 1 / 2 / 4 バイトのうち最短で書く。ヘッダーの下位 2 ビットに入れる cbId も返す */
function writeId(id: number): { cb: number; bytes: Uint8Array } {
	if (id < 0x100) return { cb: 0, bytes: Uint8Array.of(id) };
	if (id < 0x10000) return { cb: 1, bytes: new Writer(2).u16(id).done() };
	return { cb: 2, bytes: new Writer(4).u32(id).done() };
}

function readSized(r: Reader, code: number): number {
	return code === 0 ? r.u8() : code === 1 ? r.u16() : r.u32();
}

export class DynamicChannels {
	private handlers = new Map<string, DynamicHandler>();
	private open = new Map<
		number,
		{ name: string; handler: DynamicHandler; channel: DynamicChannel }
	>();
	/** DATA_FIRST で始まって、まだ揃っていないメッセージ */
	private partial = new Map<
		number,
		{ total: number; parts: Uint8Array[]; have: number }
	>();

	/** send は drdynvc の静的チャネルへ送る関数 */
	constructor(private send: (data: Uint8Array) => void) {}

	register(name: string, handler: DynamicHandler): void {
		this.handlers.set(name, handler);
	}

	/** drdynvc の静的チャネルに届いた 1 メッセージ */
	onStatic(data: Uint8Array): void {
		const r = new Reader(data);
		const h = r.u8();
		const cmd = h >> 4;
		const sp = (h >> 2) & 3;
		const cb = h & 3;
		switch (cmd) {
			case CMD.CAPABILITIES: {
				r.u8(); // pad
				const version = r.u16();
				// 版 3 の DATA_FIRST_COMPRESSED は受けられないので、版は 2 までと答える
				this.send(
					new Writer(4)
						.u8(CMD.CAPABILITIES << 4)
						.u8(0)
						.u16(Math.min(version, 2))
						.done(),
				);
				break;
			}
			case CMD.CREATE: {
				const id = readSized(r, cb);
				const nameBytes = r.rest();
				const end = nameBytes.indexOf(0);
				const name = new TextDecoder().decode(
					nameBytes.subarray(0, end < 0 ? nameBytes.length : end),
				);
				const handler = this.handlers.get(name);
				const w = writeId(id);
				// creationStatus: 0 は成功、負は拒否
				this.send(
					concat(
						Uint8Array.of((CMD.CREATE << 4) | w.cb),
						w.bytes,
						new Writer(4).i32(handler ? 0 : -1073741823).done(),
					),
				);
				if (!handler) break;
				const channel: DynamicChannel = {
					id,
					send: (d) => this.sendData(id, d),
				};
				this.open.set(id, { name, handler, channel });
				handler.onOpen?.(channel);
				break;
			}
			case CMD.DATA_FIRST: {
				const id = readSized(r, cb);
				const total = readSized(r, sp);
				const first = r.rest();
				if (total > 1 << 24)
					throw new Error("動的チャネルのメッセージが大きすぎる");
				if (first.length >= total) this.deliver(id, first);
				else
					this.partial.set(id, { total, parts: [first], have: first.length });
				break;
			}
			case CMD.DATA: {
				const id = readSized(r, cb);
				const body = r.rest();
				const p = this.partial.get(id);
				if (!p) {
					this.deliver(id, body);
					break;
				}
				p.parts.push(body);
				p.have += body.length;
				if (p.have >= p.total) {
					this.partial.delete(id);
					this.deliver(id, concat(...p.parts));
				}
				break;
			}
			case CMD.CLOSE: {
				const id = readSized(r, cb);
				this.partial.delete(id);
				const c = this.open.get(id);
				this.open.delete(id);
				c?.handler.onClose?.();
				// 同じ ID で Close を返す
				const w = writeId(id);
				this.send(concat(Uint8Array.of((CMD.CLOSE << 4) | w.cb), w.bytes));
				break;
			}
		}
	}

	private deliver(id: number, data: Uint8Array): void {
		const c = this.open.get(id);
		c?.handler.onData(data, c.channel);
	}

	/** 動的チャネルへ送る。大きなものは DATA_FIRST + DATA に分ける */
	sendData(id: number, data: Uint8Array): void {
		const w = writeId(id);
		const headOf = (cmd: number, sp = 0) =>
			Uint8Array.of((cmd << 4) | (sp << 2) | w.cb);
		const room = MAX_PDU - 1 - w.bytes.length;
		if (data.length <= room) {
			this.send(concat(headOf(CMD.DATA), w.bytes, data));
			return;
		}
		const len = new Writer(4).u32(data.length).done();
		const first = room - 4;
		this.send(
			concat(headOf(CMD.DATA_FIRST, 2), w.bytes, len, data.subarray(0, first)),
		);
		for (let at = first; at < data.length; at += room)
			this.send(
				concat(headOf(CMD.DATA), w.bytes, data.subarray(at, at + room)),
			);
	}
}

// ---- DisplayControl ----

export const DISPLAYCONTROL = "Microsoft::Windows::RDS::DisplayControl";

const DISPCTL = { CAPS: 0x5, MONITOR_LAYOUT: 0x2 } as const;

/** サーバーが受け付ける大きさ。幅も高さも 200〜8192 で、幅は偶数 */
export function clampMonitorSize(
	width: number,
	height: number,
): { width: number; height: number } {
	const w = Math.max(200, Math.min(8192, Math.round(width)));
	return {
		width: w - (w % 2),
		height: Math.max(200, Math.min(8192, Math.round(height))),
	};
}

/** 主モニター 1 つだけの MONITOR_LAYOUT_PDU */
export function monitorLayout(
	width: number,
	height: number,
	scale = 100,
): Uint8Array {
	const size = clampMonitorSize(width, height);
	const body = new Writer(60)
		.u32(40) // MonitorLayoutSize
		.u32(1) // NumMonitors
		.u32(1) // Flags: PRIMARY
		.i32(0)
		.i32(0)
		.u32(size.width)
		.u32(size.height)
		// 物理的な大きさ(mm)。96 dpi として計算する
		.u32(Math.round((size.width * 25.4) / 96))
		.u32(Math.round((size.height * 25.4) / 96))
		.u32(0) // Orientation: 0 度
		.u32(scale) // DesktopScaleFactor
		.u32(100) // DeviceScaleFactor
		.done();
	return concat(
		new Writer(8)
			.u32(DISPCTL.MONITOR_LAYOUT)
			.u32(8 + body.length)
			.done(),
		body,
	);
}

/** 窓の大きさに解像度を合わせる。サーバーが DisplayControl を開いたあとは、resize() で大きさを伝えられる */
export class DisplayControl implements DynamicHandler {
	private channel?: DynamicChannel;
	private pending?: { width: number; height: number };
	/** Caps で知らされた、サーバーが受け付ける最大のモニター数 */
	maxMonitors = 0;
	/** サーバーが受け付ける全モニターの面積の上限で、A * B 画素。0 は不明 */
	maxArea = 0;

	onOpen(channel: DynamicChannel): void {
		this.channel = channel;
	}

	onData(data: Uint8Array): void {
		const r = new Reader(data);
		const type = r.u32();
		r.u32(); // length
		if (type !== DISPCTL.CAPS) return;
		this.maxMonitors = r.u32();
		this.maxArea = r.u32() * r.u32();
		// Caps を受けてから送ってよい。待たせていた大きさがあれば、いま送る
		const p = this.pending;
		this.pending = undefined;
		if (p) this.resize(p.width, p.height);
	}

	onClose(): void {
		// 開き直されたら、新しい Caps を受けるまで送らない
		this.channel = undefined;
		this.maxMonitors = 0;
		this.maxArea = 0;
	}

	/** 大きさを伝える。まだ開いていなければ、開いたときに最後の 1 つを送る */
	resize(width: number, height: number): void {
		if (!this.channel || this.maxMonitors === 0) {
			this.pending = { width, height };
			return;
		}
		// 面積の上限を超えるなら、縦横比を保って縮める
		let w = width;
		let h = height;
		if (this.maxArea > 0 && w * h > this.maxArea) {
			const k = Math.sqrt(this.maxArea / (w * h));
			w = Math.floor(w * k);
			h = Math.floor(h * k);
		}
		this.channel.send(monitorLayout(w, h));
	}

	get available(): boolean {
		return this.channel !== undefined && this.maxMonitors > 0;
	}
}
