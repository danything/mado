// mado の中継(/ws の WebSocket か /wt の WebTransport)を RDP のバイト列として読み書きする。
// どちらもメッセージやかたまりの切れ目は RDP の PDU の切れ目と関係ない。届いたものを溜めておき、要る分だけ切り出す。

import { concat } from "./bytes";

/** CredSSP などが使う読み書きの口。試験では中継の代わりに TCP をつなぐ */
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

/** 届いたかたまりを溜めて、要る分だけ切り出す。WebSocket と WebTransport で共通 */
abstract class ChunkStream implements Transport {
	private chunks: Uint8Array[] = [];
	private have = 0;
	private waiter?: () => void;
	protected closed?: Error;

	protected push(b: Uint8Array): void {
		if (b.length === 0) return;
		this.chunks.push(b);
		this.have += b.length;
		this.wake();
	}

	protected end(e: Error): void {
		this.closed ??= e;
		this.wake();
	}

	private wake(): void {
		const w = this.waiter;
		this.waiter = undefined;
		w?.();
	}

	/** n バイト溜まるまで待つ。その前に閉じたら例外にする */
	private async fill(n: number): Promise<void> {
		while (this.have < n) {
			if (this.closed) throw this.closed;
			await new Promise<void>((r) => {
				this.waiter = r;
			});
		}
	}

	/** n バイト揃うまで待って返す */
	async read(n: number): Promise<Uint8Array> {
		await this.fill(n);
		return this.take(n);
	}

	/** 先頭の n バイトを、取り出さずに見る */
	async peek(n: number): Promise<Uint8Array> {
		await this.fill(n);
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

	abstract write(b: Uint8Array): void;
	abstract close(): void;
}

export class WsStream extends ChunkStream {
	private constructor(private ws: WebSocket) {
		super();
		ws.binaryType = "arraybuffer";
		ws.addEventListener("message", (e) => {
			if (e.data instanceof ArrayBuffer) this.push(new Uint8Array(e.data));
		});
		ws.addEventListener("close", (e) => {
			this.end(
				new StreamClosed(
					`connection closed${e.reason ? `: ${e.reason}` : ""} (${e.code})`,
				),
			);
		});
		ws.addEventListener("error", () => {
			this.end(new StreamClosed("WebSocket error"));
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

	write(b: Uint8Array): void {
		if (this.ws.readyState === WebSocket.OPEN)
			this.ws.send(b as Uint8Array<ArrayBuffer>);
	}

	close(): void {
		this.end(new StreamClosed("closed"));
		this.ws.close();
	}
}

/**
 * WebTransport の双方向 stream 1 本。mado の /wt はその上で /ws と同じ RDCleanPath の中継をする。
 * UDP(QUIC)なので、TCP の WebSocket より損失に強い。輻輳制御はサーバーが BBR を使う
 */
export class WtStream extends ChunkStream {
	private writer: WritableStreamDefaultWriter<Uint8Array>;

	private constructor(
		private wt: WebTransport,
		s: WebTransportBidirectionalStream,
	) {
		super();
		this.writer = s.writable.getWriter();
		this.pump(s.readable.getReader());
		wt.closed.then(
			(i) =>
				this.end(
					new StreamClosed(
						`connection closed${i.reason ? `: ${i.reason}` : ""} (${i.closeCode ?? 0})`,
					),
				),
			() => this.end(new StreamClosed("WebTransport error")),
		);
	}

	private async pump(r: ReadableStreamDefaultReader<Uint8Array>) {
		try {
			for (;;) {
				const { value, done } = await r.read();
				if (done) break;
				this.push(value);
			}
			this.end(new StreamClosed("connection closed"));
		} catch {
			this.end(new StreamClosed("WebTransport stream error"));
		}
	}

	/** ready まで timeoutMs だけ待つ。間に合わなければ閉じて失敗にする */
	static async open(url: string, timeoutMs: number): Promise<WtStream> {
		const wt = new WebTransport(url);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				wt.ready,
				new Promise((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`WebTransport: ${timeoutMs} ms で開かない`)),
						timeoutMs,
					);
				}),
			]);
			const s = await wt.createBidirectionalStream();
			return new WtStream(wt, s);
		} catch (e) {
			// 後から開いても使わない。閉じたときの拒否は握りつぶす
			wt.ready.then(
				() => wt.close(),
				() => {},
			);
			wt.closed.catch(() => {});
			throw e;
		} finally {
			clearTimeout(timer);
		}
	}

	write(b: Uint8Array): void {
		if (this.closed) return;
		// 書く順は writer が保つ。待たずに積む
		this.writer
			.write(b)
			.catch(() => this.end(new StreamClosed("write failed")));
	}

	close(): void {
		this.end(new StreamClosed("closed"));
		try {
			this.wt.close();
		} catch {
			// もう閉じている
		}
	}
}
