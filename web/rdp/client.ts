// つながったあとのセッション。届く PDU を読んで画面とポインタに流し、入力を送り、サーバーが画面を作り直す(Deactivate-Reactivate)のに付き合う。

import { decodeBitmap, parseBitmapUpdate } from "./bitmap";
import type { Session } from "./connect";
import { Reassembler, UPDATE } from "./fastpath";
import * as input from "./input";
import * as mcs from "./mcs";
import * as pdu from "./pdu";
import * as pointer from "./pointer";
import { StreamClosed } from "./stream";
import { handleSurfaceCommands } from "./surface";
import { ChannelAssembler, SHOW_PROTOCOL, splitChannelData } from "./vchannel";
import * as x224 from "./x224";

const CHANNEL_OPTION_SHOW_PROTOCOL = 0x00200000;

/** 画面の出力先。ブラウザでは canvas(display.ts)、試験では何かを溜めるもの */
export interface Screen {
	resize(width: number, height: number): void;
	/** (x, y) から w x h の RGBA(上の行から) */
	draw(
		x: number,
		y: number,
		w: number,
		h: number,
		rgba: Uint8ClampedArray,
	): void;
	/** null は「描かない」(ポインタを隠す)、"default" は OS の既定 */
	setCursor(cursor: pointer.Cursor | "default" | null): void;
}

/** 静的チャネルに届いたメッセージ(断片は組み立て済み。drdynvc / cliprdr)を受け取る */
export type ChannelHandler = (name: string, data: Uint8Array) => void;

export class RdpClient {
	private fast = new Reassembler();
	private cursors = new Map<number, pointer.Cursor>();
	private assemblers = new Map<number, ChannelAssembler>();
	private width: number;
	private height: number;
	/** サーバーと決めた RemoteFX の codecId */
	private rfxCodecId: number;
	private closed = false;
	/** サーバーが切る理由(Set Error Info)。0 は異常なし */
	errorInfo = 0;
	/** 受けた更新の種類(Fast-Path の updateCode)ごとの数。診断用 */
	readonly stats: Record<number, number> = {};
	onChannel?: ChannelHandler;

	constructor(
		readonly session: Session,
		private screen: Screen,
	) {
		this.width = session.width;
		this.rfxCodecId = pdu.serverRfxCodecId(session.serverCapabilities);
		this.height = session.height;
	}

	/** 終わるまで読み続ける。正常な終わり(サーバーが切った・こちらが閉じた)は理由の文字列、通信の失敗は例外 */
	async run(): Promise<string> {
		const s = this.session;
		this.screen.resize(this.width, this.height);
		this.send(input.fastPathInput([input.syncEvent(0)]));
		try {
			for (const p of s.pending) this.handlePdu(p);
			s.pending.length = 0;
			for (const c of s.pendingChannel.splice(0))
				this.handleChannel(c.channelId, c.data);
			while (!this.closed) this.handlePdu(await x224.readPdu(s.stream));
		} catch (e) {
			if (this.closed) return "切断した";
			if (e instanceof mcs.Disconnected || e instanceof StreamClosed)
				return e.message;
			throw e;
		}
		return "切断した";
	}

	close(): void {
		this.closed = true;
		this.session.stream.close();
	}

	/** 入力のイベント(input.ts のもの)を送る。1 つの PDU に 15 まで */
	sendInput(events: Uint8Array[]): void {
		for (let i = 0; i < events.length; i += 15)
			this.send(input.fastPathInput(events.slice(i, i + 15)));
	}

	/** 静的チャネルへ送る(drdynvc / cliprdr の中身)。断片に分ける */
	sendChannel(name: string, data: Uint8Array): void {
		const id = this.session.channels.get(name);
		if (id === undefined) throw new Error(`チャネル ${name} は無い`);
		const show =
			(this.session.channelOptions.get(name) ?? 0) &
			CHANNEL_OPTION_SHOW_PROTOCOL;
		for (const chunk of splitChannelData(data, show ? SHOW_PROTOCOL : 0))
			this.session.stream.write(
				x224.data(mcs.sendDataRequest(this.session.userId, id, chunk)),
			);
	}

	private send(fastPathPdu: Uint8Array): void {
		this.session.stream.write(fastPathPdu);
	}

	private sendIo(data: Uint8Array): void {
		this.session.stream.write(
			x224.data(
				mcs.sendDataRequest(
					this.session.userId,
					this.session.ioChannelId,
					data,
				),
			),
		);
	}

	private handlePdu(p: x224.Pdu): void {
		if (p.kind === "fastpath") {
			for (const u of this.fast.push(p.data)) this.handleUpdate(u.code, u.data);
			return;
		}
		const ind = mcs.parseSendDataIndication(p.data);
		if (ind.channelId === this.session.ioChannelId) this.handleIo(ind.data);
		else this.handleChannel(ind.channelId, ind.data);
	}

	private handleChannel(channelId: number, chunk: Uint8Array): void {
		for (const [name, id] of this.session.channels) {
			if (id !== channelId) continue;
			const asm = this.assemblers.get(id) ?? new ChannelAssembler();
			this.assemblers.set(id, asm);
			const msg = asm.push(chunk);
			if (msg) this.onChannel?.(name, msg);
		}
	}

	private handleIo(data: Uint8Array): void {
		const sc = pdu.parseShareControl(data);
		switch (sc.type) {
			case pdu.PDUTYPE.DATA:
				this.handleShareData(pdu.parseShareData(sc.body));
				break;
			case pdu.PDUTYPE.DEACTIVATE_ALL:
				break; // 続けて Demand Active が来る
			case pdu.PDUTYPE.DEMAND_ACTIVE:
				this.reactivate(pdu.parseDemandActive(sc.body));
				break;
		}
	}

	private handleShareData(sd: pdu.ShareData): void {
		switch (sd.type2) {
			case pdu.PDUTYPE2.UPDATE:
				// Slow-Path の更新は、先頭が updateType(0 orders、1 bitmap、2 palette、3 sync)
				if (sd.payload[0] === 1) this.handleUpdate(UPDATE.BITMAP, sd.payload);
				break;
			case pdu.PDUTYPE2.POINTER:
				this.handleSlowPointer(sd.payload);
				break;
			case pdu.PDUTYPE2.SET_ERROR_INFO: {
				const code = pdu.parseErrorInfo(sd.payload);
				if (code !== 0) {
					this.errorInfo = code;
					throw new mcs.Disconnected(
						`サーバーが切った (ErrorInfo 0x${code.toString(16)})`,
					);
				}
				break;
			}
			case pdu.PDUTYPE2.SHUTDOWN_DENIED:
				throw new mcs.Disconnected("サーバーが終了した");
		}
	}

	/** Demand Active をもう一度受けた(画面の大きさが変わった): Confirm Active と同期をやり直す */
	private reactivate(d: pdu.DemandActive): void {
		const bmp = d.capabilities.get(pdu.CAP.BITMAP);
		if (bmp && bmp.length >= 12) {
			const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);
			this.width = dv.getUint16(8, true);
			this.height = dv.getUint16(10, true);
		}
		this.rfxCodecId = pdu.serverRfxCodecId(d.capabilities);
		const s = this.session;
		this.sendIo(
			pdu.confirmActive(
				s.userId,
				d.shareId,
				pdu.clientCapabilities({
					width: this.width,
					height: this.height,
					keyboardLayout: 0x0411,
				}),
			),
		);
		const data2 = (type2: number, payload: Uint8Array) =>
			this.sendIo(pdu.shareData(s.userId, d.shareId, type2, payload));
		data2(pdu.PDUTYPE2.SYNCHRONIZE, pdu.synchronize(pdu.SERVER_ID));
		data2(pdu.PDUTYPE2.CONTROL, pdu.control(pdu.CONTROL.COOPERATE));
		data2(pdu.PDUTYPE2.CONTROL, pdu.control(pdu.CONTROL.REQUEST));
		data2(pdu.PDUTYPE2.FONTLIST, pdu.fontList());
		this.screen.resize(this.width, this.height);
	}

	private handleUpdate(code: number, data: Uint8Array): void {
		this.stats[code] = (this.stats[code] ?? 0) + 1;
		switch (code) {
			case UPDATE.BITMAP:
				for (const r of parseBitmapUpdate(data)) {
					const w = Math.min(r.right - r.left + 1, r.width);
					const h = Math.min(r.bottom - r.top + 1, r.height);
					const rgba = decodeBitmap(r);
					// 矩形の幅が 4 の倍数に揃えられているときは、右の余りを切る
					this.screen.draw(
						r.left,
						r.top,
						w,
						h,
						w === r.width ? rgba : crop(rgba, r.width, w, h),
					);
				}
				break;
			case UPDATE.SURFCMDS:
				handleSurfaceCommands(
					data,
					this.rfxCodecId,
					{ width: this.width, height: this.height },
					{ draw: (x, y, w, h, rgba) => this.screen.draw(x, y, w, h, rgba) },
				);
				break;
			case UPDATE.PTR_NULL:
				this.screen.setCursor(null);
				break;
			case UPDATE.PTR_DEFAULT:
				this.screen.setCursor("default");
				break;
			case UPDATE.POINTER:
			case UPDATE.LARGE_POINTER: {
				this.setPointer(() =>
					pointer.parseNewPointer(data, code === UPDATE.LARGE_POINTER),
				);
				break;
			}
			case UPDATE.COLOR: {
				this.setPointer(() => pointer.parseColorPointer(data));
				break;
			}
			case UPDATE.CACHED: {
				const c = this.cursors.get(pointer.parseCachedPointer(data));
				if (c) this.screen.setCursor(c);
				break;
			}
			// SYNCHRONIZE、PTR_POSITION(サーバーがマウスを動かす指示。ブラウザでは動かせない)、Orders(断っている)は何もしない
		}
	}

	/** ポインタの形が壊れていても、セッションは続ける(既定のカーソルにする) */
	private setPointer(
		parse: () => { index: number; cursor: pointer.Cursor },
	): void {
		try {
			const { index, cursor } = parse();
			this.cursors.set(index, cursor);
			this.screen.setCursor(cursor);
		} catch {
			this.screen.setCursor("default");
		}
	}

	/** Slow-Path のポインタ: messageType(2)、pad(2)、本体 */
	private handleSlowPointer(payload: Uint8Array): void {
		const type = payload[0] as number;
		const body = payload.subarray(4);
		switch (type) {
			case 1: // SYSTEM: 0 = NULL、0x7F00 = DEFAULT
				this.handleUpdate(
					new DataView(body.buffer, body.byteOffset).getUint32(0, true) === 0
						? UPDATE.PTR_NULL
						: UPDATE.PTR_DEFAULT,
					body,
				);
				break;
			case 6:
				this.handleUpdate(UPDATE.COLOR, body);
				break;
			case 7:
				this.handleUpdate(UPDATE.CACHED, body);
				break;
			case 8:
				this.handleUpdate(UPDATE.POINTER, body);
				break;
			case 0x14:
				this.handleUpdate(UPDATE.LARGE_POINTER, body);
				break;
		}
	}
}

/** 幅 fullW の RGBA から、左の w 列だけを残す */
function crop(
	rgba: Uint8ClampedArray,
	fullW: number,
	w: number,
	h: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		out.set(rgba.subarray(y * fullW * 4, y * fullW * 4 + w * 4), y * w * 4);
	return out;
}
