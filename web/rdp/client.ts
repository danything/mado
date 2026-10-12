// つながったあとのセッション。届いた PDU を読んで画面とポインタに流し、入力を送る。
// サーバーが画面を作り直す Deactivate-Reactivate にも応じる。

import { AutoDetect, type NetworkInfo } from "./autodetect";
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

/** 画面の出力先。ブラウザでは display.ts の canvas、試験では描いたものを溜めておくもの */
export interface Screen {
	resize(width: number, height: number): void;
	/** (x, y) から w x h の RGBA を描く。行は上から並ぶ */
	draw(
		x: number,
		y: number,
		w: number,
		h: number,
		rgba: Uint8ClampedArray,
	): void;
	/** null ならポインタを隠す。"default" は OS の既定のカーソル */
	setCursor(cursor: pointer.Cursor | "default" | null): void;
}

/** drdynvc や cliprdr など、静的チャネルに届いたメッセージを受け取る。断片は組み立ててから渡す */
type ChannelHandler = (name: string, data: Uint8Array) => void;

export class RdpClient {
	/** Fast-Path の組み立て。つなぐ途中で使ったものを引き継ぐ(断片と圧縮の履歴が続いている) */
	private fast: Reassembler;
	private cursors = new Map<number, pointer.Cursor>();
	private assemblers = new Map<number, ChannelAssembler>();
	private width: number;
	private height: number;
	/** サーバーと決めた RemoteFX の codecId */
	private rfxCodecId: number;
	private closed = false;
	/** Share Data に付ける shareId。再アクティベーションで変わる */
	private shareId: number;
	/** RemoteFX のタイルと旧ビットマップを溜めて、受けた順に描く。あとのものに覆われたものは復号しない */
	private surface: SurfaceRenderer;
	/** メッセージ チャネルでの回線の自動検出。つなぐ途中で使ったものを引き継ぐ */
	private autodetect: AutoDetect;
	/** Fast-Path の updateCode ごとの、受けた更新の数。診断に出す */
	readonly stats: Record<number, number> = {};
	onChannel?: ChannelHandler;

	constructor(
		readonly session: Session,
		private screen: Screen,
		/**
		 * RemoteFX と旧ビットマップを復号する場所。省略するとその場で復号する。
		 * ブラウザでは createPool() で作った Worker のプールを渡す
		 */
		options: { pool?: TilePool } = {},
	) {
		this.width = session.width;
		this.rfxCodecId = pdu.serverRfxCodecId(session.serverCapabilities);
		this.height = session.height;
		this.shareId = session.shareId;
		this.autodetect = session.autodetect ?? new AutoDetect();
		this.fast = session.fast ?? new Reassembler(session.bulk);
		this.surface = new SurfaceRenderer({
			draw: (x, y, w, h, rgba) => this.screen.draw(x, y, w, h, rgba),
			ack: (frameId) => this.sendFrameAck(frameId),
			pool: options.pool,
		});
	}

	/** 描き終えたフレームをサーバーに知らせる。知らせないと、サーバーは送るのを止める */
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

	/** RemoteFX のタイルと旧ビットマップの統計。あとのものに覆われて復号しなかった数と、壊れていて捨てた数。診断に出す */
	get decodeStats(): { coalesced: number; skipped: number } {
		return { coalesced: this.surface.coalesced, skipped: this.surface.skipped };
	}

	/** サーバーが測った回線の様子と、こちらが答えた測定の数。診断に出す。測っていなければ network は無い */
	get network(): {
		info?: NetworkInfo;
		answered: { rtt: number; bandwidth: number };
	} {
		return { info: this.autodetect.network, answered: this.autodetect.stats };
	}

	/**
	 * 終わるまで読み続ける。サーバーが切ったときやこちらが閉じたときは、理由の文字列を返す。
	 * 通信に失敗したら例外にする
	 */
	async run(): Promise<string> {
		const s = this.session;
		this.screen.resize(this.width, this.height);
		this.send(input.fastPathInput([input.syncEvent(0)]));
		try {
			for (const u of s.pending) this.handleUpdate(u.code, u.data);
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
			// 溜めたタイルは切れる前の最後の画面なので描いておく。ここで失敗しても、切れた本当の理由は隠さない。
			// 復号中のものも描き終えてから Worker を止める
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

	/** input.ts で作った入力のイベントを送る。1 つの PDU に入るのは 15 まで */
	sendInput(events: Uint8Array[]): void {
		for (let i = 0; i < events.length; i += 15)
			this.send(input.fastPathInput(events.slice(i, i + 15)));
	}

	/** drdynvc や cliprdr の中身を静的チャネルへ送る。大きければ断片に分ける */
	sendChannel(name: string, data: Uint8Array): void {
		const id = this.session.channels.get(name);
		if (id === undefined) throw new Error(`チャネル ${name} は無い`);
		const show =
			(this.session.channelOptions.get(name) ?? 0) &
			CHANNEL_OPTION_SHOW_PROTOCOL;
		for (const chunk of splitChannelData(data, show ? SHOW_PROTOCOL : 0))
			this.sendTo(id, chunk);
	}

	private send(fastPathPdu: Uint8Array): void {
		this.session.stream.write(fastPathPdu);
	}

	/** MCS の Send Data Request で、チャネルへ送る */
	private sendTo(channelId: number, data: Uint8Array): void {
		this.session.stream.write(
			x224.data(mcs.sendDataRequest(this.session.userId, channelId, data)),
		);
	}

	private sendIo(data: Uint8Array): void {
		this.sendTo(this.session.ioChannelId, data);
	}

	private handlePdu(p: x224.Pdu): void {
		// つないだあとの帯域の測定では、届いたものを全部数える。ヘッダーの数バイトは数えない
		this.autodetect.received(p.data.length);
		if (p.kind === "fastpath") {
			for (const u of this.fast.push(p.data)) this.handleUpdate(u.code, u.data);
			return;
		}
		const ind = mcs.parseSendDataIndication(p.data);
		if (ind.channelId === this.session.ioChannelId) this.handleIo(ind.data);
		else if (ind.channelId === this.session.messageChannelId)
			this.handleMessage(ind.data);
		else this.handleChannel(ind.channelId, ind.data);
	}

	/** メッセージ チャネルに届いた回線の自動検出に、その場で答える。サーバーは答えるまでの時間で RTT を測る */
	private handleMessage(data: Uint8Array): void {
		const id = this.session.messageChannelId;
		const reply = this.autodetect.handle(data);
		if (reply && id !== undefined) this.sendTo(id, reply);
	}

	private handleChannel(channelId: number, chunk: Uint8Array): void {
		for (const [name, id] of this.session.channels) {
			if (id !== channelId) continue;
			const asm =
				this.assemblers.get(id) ??
				new ChannelAssembler(this.session.channelBulk);
			this.assemblers.set(id, asm);
			const msg = asm.push(chunk);
			if (msg) this.onChannel?.(name, msg);
		}
	}

	private handleIo(data: Uint8Array): void {
		const sc = pdu.parseShareControl(data);
		switch (sc.type) {
			case pdu.PDUTYPE.DATA:
				this.handleShareData(pdu.parseShareData(sc.body, this.session.bulk));
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
				// Slow-Path の更新は先頭が updateType。0 が orders、1 が bitmap、2 が palette、3 が sync
				if (sd.payload[0] === 1) this.handleUpdate(UPDATE.BITMAP, sd.payload);
				break;
			case pdu.PDUTYPE2.POINTER:
				this.handleSlowPointer(sd.payload);
				break;
			case pdu.PDUTYPE2.SET_ERROR_INFO: {
				const code = pdu.parseErrorInfo(sd.payload);
				if (code !== 0)
					throw new mcs.Disconnected(
						`サーバーが切った (ErrorInfo 0x${code.toString(16)})`,
					);
				break;
			}
			case pdu.PDUTYPE2.SHUTDOWN_DENIED:
				throw new mcs.Disconnected("サーバーが終了した");
		}
	}

	/** 画面の大きさが変わると Demand Active がもう一度来る。Confirm Active と同期をやり直す */
	private reactivate(d: pdu.DemandActive): void {
		this.surface.flush(); // 大きさが変わる前の画面を先に描く
		// 復号中のフレームの Frame Acknowledge は前の shareId で返す。そのため shareId は描画と同じ順番で切り替える
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
		// Confirm Active と同期の 4 つを送る。つないだときと同じ関数を使う
		for (const p of pdu.activationPdus(s.userId, d.shareId, {
			width: this.width,
			height: this.height,
			keyboardLayout: s.keyboardLayout,
		}))
			this.sendIo(p);
		// 復号中のタイルを描き終えてから、大きさを変える
		const { width, height } = this;
		this.surface.ordered(() => this.screen.resize(width, height));
	}

	private handleUpdate(code: number, data: Uint8Array): void {
		this.stats[code] = (this.stats[code] ?? 0) + 1;
		switch (code) {
			case UPDATE.BITMAP:
				// 復号は Worker のプールに回す。RemoteFX のタイルと同じ列に並べ、受けた順に描く。壊れた矩形は捨てて続ける
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
			case UPDATE.LARGE_POINTER:
				this.setPointer(() =>
					pointer.parseNewPointer(data, code === UPDATE.LARGE_POINTER),
				);
				break;
			case UPDATE.COLOR:
				this.setPointer(() => pointer.parseColorPointer(data));
				break;
			case UPDATE.CACHED: {
				const c = this.cursors.get(pointer.parseCachedPointer(data));
				if (c) this.screen.setCursor(c);
				break;
			}
			// SYNCHRONIZE と Orders は何もしない。Orders は断っているので来ない。
			// PTR_POSITION はサーバーがマウスを動かす指示だが、ブラウザではマウスを動かせない
		}
	}

	/** ポインタの形が壊れていたら既定のカーソルにして、セッションは続ける */
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

	/** Slow-Path のポインタ。messageType(2 バイト)、pad(2 バイト)、本体の順 */
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
