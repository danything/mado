// つながったあとのセッション。届く PDU を読んで画面とポインタに流し、入力を送り、サーバーが画面を作り直す(Deactivate-Reactivate)のに付き合う。

import { parseBitmapUpdate } from "./bitmap";
import type { Session } from "./connect";
import { Reassembler, UPDATE } from "./fastpath";
import * as input from "./input";
import * as mcs from "./mcs";
import * as pdu from "./pdu";
import * as pointer from "./pointer";
import type { TilePool } from "./rfxpool";
import { StreamClosed } from "./stream";
import { SurfaceRenderer } from "./surface";
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
type ChannelHandler = (name: string, data: Uint8Array) => void;

export class RdpClient {
	private fast = new Reassembler();
	private cursors = new Map<number, pointer.Cursor>();
	private assemblers = new Map<number, ChannelAssembler>();
	private width: number;
	private height: number;
	/** サーバーと決めた RemoteFX の codecId */
	private rfxCodecId: number;
	private closed = false;
	/** Share Data に付ける shareId(再アクティベーションで変わる) */
	private shareId: number;
	/** RemoteFX のタイルを溜めて、同じ位置は最新だけを復号する */
	private surface: SurfaceRenderer;
	/** サーバーが切る理由(Set Error Info)。0 は異常なし */
	errorInfo = 0;
	/** 受けた更新の種類(Fast-Path の updateCode)ごとの数。診断用 */
	readonly stats: Record<number, number> = {};
	onChannel?: ChannelHandler;

	constructor(
		readonly session: Session,
		private screen: Screen,
		/** RemoteFX のタイルの復号の置き場。省略するとその場で復号する(ブラウザでは createPool() の Worker のプールを渡す) */
		options: { pool?: TilePool } = {},
	) {
		this.width = session.width;
		this.rfxCodecId = pdu.serverRfxCodecId(session.serverCapabilities);
		this.height = session.height;
		this.shareId = session.shareId;
		this.surface = new SurfaceRenderer({
			draw: (x, y, w, h, rgba) => this.screen.draw(x, y, w, h, rgba),
			ack: (frameId) => this.sendFrameAck(frameId),
			pool: options.pool,
		});
	}

	/** 描き終えたフレームをサーバーに知らせる(応答しないと、サーバーは送るのを止める) */
	private sendFrameAck(frameId: number): void {
		this.sendIo(
			pdu.shareData(
				this.session.userId,
				this.shareId,
				pdu.PDUTYPE2.FRAME_ACKNOWLEDGE,
				pdu.frameAcknowledge(frameId),
			),
		);
	}

	/** 受けた RemoteFX の更新の統計(診断用): 後のタイルに置き換えられて復号しなかった数、捨てた数 */
	get surfaceStats(): { coalesced: number; skipped: number } {
		return { coalesced: this.surface.coalesced, skipped: this.surface.skipped };
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
		} finally {
			// 溜めたタイルは、切れる前の最後の画面なので描いておく(失敗しても、切れた本当の理由を隠さない)
			// (復号中のものも描き終えてから、Worker を止める)
			try {
				this.surface.ordered(() => this.surface.dispose());
			} catch {}
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
		this.surface.flush(); // 大きさが変わる前の画面を先に描く
		// 復号中の前のフレームの Frame Acknowledge は前の shareId で返す。描画の順序に乗せて切り替える
		this.surface.ordered(() => {
			this.shareId = d.shareId;
		});
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
					keyboardLayout: s.keyboardLayout,
				}),
			),
		);
		const data2 = (type2: number, payload: Uint8Array) =>
			this.sendIo(pdu.shareData(s.userId, d.shareId, type2, payload));
		data2(pdu.PDUTYPE2.SYNCHRONIZE, pdu.synchronize(pdu.SERVER_ID));
		data2(pdu.PDUTYPE2.CONTROL, pdu.control(pdu.CONTROL.COOPERATE));
		data2(pdu.PDUTYPE2.CONTROL, pdu.control(pdu.CONTROL.REQUEST));
		data2(pdu.PDUTYPE2.FONTLIST, pdu.fontList());
		// 大きさが変わる前の画面(復号中のタイル)を、先に描き終えてから
		const { width, height } = this;
		this.surface.ordered(() => this.screen.resize(width, height));
	}

	private handleUpdate(code: number, data: Uint8Array): void {
		this.stats[code] = (this.stats[code] ?? 0) + 1;
		switch (code) {
			case UPDATE.BITMAP:
				// 復号は後回し(Worker のプール。RemoteFX のタイルと同じ列で、受けた順に描く)。壊れた矩形は捨てて続ける
				this.surface.bitmaps(parseBitmapUpdate(data), {
					width: this.width,
					height: this.height,
				});
				break;
			case UPDATE.SURFCMDS:
				this.surface.handle(data, this.rfxCodecId, {
					width: this.width,
					height: this.height,
				});
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
