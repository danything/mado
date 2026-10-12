// クリップボード([MS-RDPECLIP])。扱うのは CF_UNICODETEXT の文字列だけ。
// ブラウザのクリップボードとのやりとりは、呼び出し側が onRemoteText と setLocalText で行う。

import { concat, Reader, Writer } from "./bytes";

const MSG = {
	MONITOR_READY: 0x0001,
	FORMAT_LIST: 0x0002,
	FORMAT_LIST_RESPONSE: 0x0003,
	FORMAT_DATA_REQUEST: 0x0004,
	FORMAT_DATA_RESPONSE: 0x0005,
	CLIP_CAPS: 0x0007,
} as const;

const RESPONSE_OK = 0x0001;
const RESPONSE_FAIL = 0x0002;
const USE_LONG_FORMAT_NAMES = 0x0002;

export const CF_UNICODETEXT = 13;

function pdu(
	type: number,
	flags: number,
	data: Uint8Array = new Uint8Array(),
): Uint8Array {
	return concat(
		new Writer(8).u16(type).u16(flags).u32(data.length).done(),
		data,
	);
}

/** 文字列を CF_UNICODETEXT にする。UTF-16LE で NUL で終わり、改行は CRLF */
export function encodeText(text: string): Uint8Array {
	const crlf = text.replace(/\r?\n/g, "\r\n");
	return new Writer(crlf.length * 2 + 2).utf16(crlf, true).done();
}

/** CF_UNICODETEXT を最初の NUL まで読んで文字列にする。改行は LF にする */
export function decodeText(data: Uint8Array): string {
	let s = "";
	for (let i = 0; i + 1 < data.length; i += 2) {
		const c = (data[i] as number) | ((data[i + 1] as number) << 8);
		if (c === 0) break;
		s += String.fromCharCode(c);
	}
	return s.replace(/\r\n/g, "\n");
}

export class Clipboard {
	private ready = false;
	private local?: string;
	/** サーバーがくれた書式の中に CF_UNICODETEXT があるか */
	private remoteHasText = false;

	/** 静的チャネル cliprdr へ送る。onRemoteText は、サーバー側でコピーされた文字列を受ける */
	constructor(
		private send: (data: Uint8Array) => void,
		private onRemoteText: (text: string) => void,
	) {}

	/** ブラウザでコピーされた文字列。サーバーには文字列があることだけ知らせ、要求されたら渡す */
	setLocalText(text: string): void {
		this.local = text;
		if (this.ready) this.sendFormatList();
	}

	onStatic(data: Uint8Array): void {
		const r = new Reader(data);
		const type = r.u16();
		const flags = r.u16();
		const len = r.u32();
		const body = r.bytes(Math.min(len, r.left));
		switch (type) {
			case MSG.CLIP_CAPS:
				break; // サーバーの版や長い書式名の可否は見ない。こちらは長い書式名を使うと答える
			case MSG.MONITOR_READY:
				this.ready = true;
				// 能力を送り、続けて書式の一覧を送る。能力は CLIP_CAPS に GENERAL を 1 セット、版 2、長い書式名
				this.send(
					pdu(
						MSG.CLIP_CAPS,
						0,
						new Writer(16)
							.u16(1)
							.u16(0)
							.u16(1)
							.u16(12)
							.u32(2)
							.u32(USE_LONG_FORMAT_NAMES)
							.done(),
					),
				);
				this.sendFormatList();
				break;
			case MSG.FORMAT_LIST: {
				this.remoteHasText = parseFormatIds(body).includes(CF_UNICODETEXT);
				this.send(pdu(MSG.FORMAT_LIST_RESPONSE, RESPONSE_OK));
				if (this.remoteHasText)
					this.send(
						pdu(
							MSG.FORMAT_DATA_REQUEST,
							0,
							new Writer(4).u32(CF_UNICODETEXT).done(),
						),
					);
				break;
			}
			case MSG.FORMAT_DATA_REQUEST: {
				const format = new Reader(body).u32();
				if (format === CF_UNICODETEXT && this.local !== undefined)
					this.send(
						pdu(MSG.FORMAT_DATA_RESPONSE, RESPONSE_OK, encodeText(this.local)),
					);
				else this.send(pdu(MSG.FORMAT_DATA_RESPONSE, RESPONSE_FAIL));
				break;
			}
			case MSG.FORMAT_DATA_RESPONSE:
				if (flags & RESPONSE_OK) this.onRemoteText(decodeText(body));
				break;
		}
	}

	private sendFormatList(): void {
		// 長い書式名の形。4 バイトの書式 ID のあとに、NUL で終わる UTF-16 の名前が続く。標準の書式は名前が空
		const body =
			this.local === undefined
				? new Uint8Array()
				: new Writer(6).u32(CF_UNICODETEXT).u16(0).done();
		this.send(pdu(MSG.FORMAT_LIST, 0, body));
	}
}

/** 長い書式名の FORMAT_LIST の書式 ID を並べる */
export function parseFormatIds(body: Uint8Array): number[] {
	const r = new Reader(body);
	const out: number[] = [];
	while (r.left >= 6) {
		out.push(r.u32());
		// 名前を NUL まで読み飛ばす
		while (r.left >= 2 && r.u16() !== 0) {}
	}
	return out;
}
