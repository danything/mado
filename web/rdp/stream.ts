// mado の /ws(WebSocket)を RDP のバイト列として読み書きする。
// WebSocket のメッセージの切れ目は RDP の PDU の切れ目と関係ない。届いたものを溜めておき、要る分だけ切り出す。

import { concat } from "./bytes";

/** CredSSP などが使う読み書きの口。試験では WebSocket の代わりに TCP をつなぐ */
export interface ByteStream {
	peek(n: number): Promise<Uint8Array>;
	read(n: number): Promise<Uint8Array>;
	write(b: Uint8Array): void;
}

/** 通信が閉じたか、切れた */
export class StreamClosed extends Error {}

/** 閉じられる ByteStream */
export interface Transport extends ByteStream {
	close(): void;
}

export class WsStream implements Transport {
	private chunks: Uint8Array[] = [];
	private have = 0;
	private waiter?: () => void;
	private closed?: Error;

	private constructor(private ws: WebSocket) {
		ws.binaryType = "arraybuffer";
		ws.addEventListener("message", (e) => {
			if (!(e.data instanceof ArrayBuffer)) return;
			const b = new Uint8Array(e.data);
			this.chunks.push(b);
			this.have += b.length;
			this.wake();
		});
		ws.addEventListener("close", (e) => {
			this.closed ??= new StreamClosed(
				`connection closed${e.reason ? `: ${e.reason}` : ""} (${e.code})`,
			);
			this.wake();
		});
		ws.addEventListener("error", () => {
			this.closed ??= new StreamClosed("WebSocket error");
			this.wake();
		});
	}

	static open(url: string): Promise<WsStream> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			ws.addEventListener("open", () => resolve(new WsStream(ws)), {
				once: true,
			});
			ws.addEventListener(
				"error",
				() => reject(new Error(`cannot open ${url}`)),
				{ once: true },
			);
		});
	}

	private wake(): void {
		const w = this.waiter;
		this.waiter = undefined;
		w?.();
	}

	/** n バイト揃うまで待って返す */
	async read(n: number): Promise<Uint8Array> {
		while (this.have < n) {
			if (this.closed) throw this.closed;
			await new Promise<void>((r) => {
				this.waiter = r;
			});
		}
		return this.take(n);
	}

	/** 先頭の n バイトを、取り出さずに見る */
	async peek(n: number): Promise<Uint8Array> {
		while (this.have < n) {
			if (this.closed) throw this.closed;
			await new Promise<void>((r) => {
				this.waiter = r;
			});
		}
		const first = this.chunks[0] as Uint8Array;
		if (first.length >= n) return first.subarray(0, n);
		const all = concat(...this.chunks);
		this.chunks = [all];
		return all.subarray(0, n);
	}

	private take(n: number): Uint8Array {
		const first = this.chunks[0] as Uint8Array;
		if (first.length === n) {
			this.chunks.shift();
			this.have -= n;
			return first;
		}
		if (first.length > n) {
			this.chunks[0] = first.subarray(n);
			this.have -= n;
			return first.subarray(0, n);
		}
		const out = new Uint8Array(n);
		let o = 0;
		while (o < n) {
			const c = this.chunks[0] as Uint8Array;
			const k = Math.min(c.length, n - o);
			out.set(c.subarray(0, k), o);
			o += k;
			if (k === c.length) this.chunks.shift();
			else this.chunks[0] = c.subarray(k);
		}
		this.have -= n;
		return out;
	}

	write(b: Uint8Array): void {
		if (this.ws.readyState === WebSocket.OPEN)
			this.ws.send(b as Uint8Array<ArrayBuffer>);
	}

	close(): void {
		this.closed ??= new StreamClosed("closed");
		this.ws.close();
		this.wake();
	}

	get isClosed(): boolean {
		return !!this.closed;
	}
}
