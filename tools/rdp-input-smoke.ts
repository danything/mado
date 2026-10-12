// xrdp を相手にする実機試験(docs/rdp-client.md の「試験」)。つないで画面を PNG にし、「Use default config」のボタンのクリック、
// ドックの端末を開いて echo mado と打つ、こちらでコピーした文字列の貼り付けを順に試す。wslc の node:lts コンテナで動かす
// 環境変数: HOST / PORT / RDPUSER / RDPPASS / OUT(クリック前は OUT の .before.png)

import * as fs from "node:fs";
import * as net from "node:net";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import { attachChannels } from "../web/rdp/channels";
import { RdpClient, type Screen } from "../web/rdp/client";
import { establish } from "../web/rdp/connect";
import * as input from "../web/rdp/input";
import type { Transport } from "../web/rdp/stream";
import * as x224 from "../web/rdp/x224";

class Sock implements Transport {
	chunks: Buffer[] = [];
	have = 0;
	w?: () => void;
	err?: Error;
	constructor(public s: net.Socket | tls.TLSSocket) {
		s.on("data", (b) => {
			this.chunks.push(b);
			this.have += b.length;
			this.w?.();
		});
		s.on("error", (e) => {
			this.err = e;
			this.w?.();
		});
		s.on("close", () => {
			this.err ??= new Error("closed");
			this.w?.();
		});
	}
	async peek(n: number) {
		while (this.have < n) {
			if (this.err) throw this.err;
			await new Promise<void>((r) => {
				this.w = r;
			});
		}
		const all = Buffer.concat(this.chunks);
		this.chunks = [all];
		return new Uint8Array(all.subarray(0, n));
	}
	async read(n: number) {
		const p = await this.peek(n);
		const all = this.chunks[0] as Buffer;
		this.chunks = all.length > n ? [all.subarray(n)] : [];
		this.have -= n;
		return p;
	}
	write(b: Uint8Array) {
		this.s.write(b);
	}
	close() {
		this.s.destroy();
	}
}

const W = 1280;
const H = 720;
const fb = new Uint8Array(W * H * 4);
let cursors = 0;
const screen: Screen = {
	resize() {},
	draw(x, y, w, h, rgba) {
		for (let j = 0; j < h; j++)
			fb.set(rgba.subarray(j * w * 4, (j + 1) * w * 4), ((y + j) * W + x) * 4);
	},
	setCursor() {
		cursors++;
	},
};

function png(file: string) {
	const crcT = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b: Buffer) => {
		let c = 0xffffffff;
		for (const x of b) c = (crcT[(c ^ x) & 255] as number) ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (t: string, d: Buffer) => {
		const l = Buffer.alloc(4);
		l.writeUInt32BE(d.length);
		const td = Buffer.concat([Buffer.from(t), d]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([l, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const pix = Buffer.alloc((W * 4 + 1) * H);
	for (let y = 0; y < H; y++)
		Buffer.from(fb.buffer, y * W * 4, W * 4).copy(pix, y * (W * 4 + 1) + 1);
	fs.writeFileSync(
		file,
		Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk("IHDR", ihdr),
			chunk("IDAT", zlib.deflateSync(pix)),
			chunk("IEND", Buffer.alloc(0)),
		]),
	);
}

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 13389);
const raw = net.connect(port, host);
await new Promise((r) => raw.once("connect", r));
const s0 = new Sock(raw);
s0.write(x224.connectionRequest(x224.PROTOCOL.SSL));
const h = await s0.peek(4);
const cc = await s0.read(((h[2] as number) << 8) | (h[3] as number));
raw.removeAllListeners("data");
const t = tls.connect({ socket: raw, rejectUnauthorized: false });
await new Promise((r) => t.once("secureConnect", r));
const session = await establish(
	new Sock(t),
	{
		url: "",
		token: "",
		destination: "",
		username: process.env.RDPUSER ?? "ubuntu",
		password: process.env.RDPPASS ?? "ubuntu",
		width: W,
		height: H,
		allowTls: true,
		dummyLicense: true,
	},
	cc,
	new Uint8Array(t.getPeerCertificate().raw),
);
const client = new RdpClient(session, screen);
const channels = attachChannels(client, (t) => console.log("remote text:", JSON.stringify(t)));
const ended = client.run().then((r) => console.log("run ended:", r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = process.env.OUT ?? "screen.png";
await sleep(8000);
png(out.replace(/\.png$/, ".before.png"));
// 「Use default config」(515, 419)をクリック
client.sendInput([input.mouseMove(515, 419)]);
await sleep(300);
client.sendInput([
	input.mouseButton(0, true, 515, 419) as Uint8Array,
	input.mouseButton(0, false, 515, 419) as Uint8Array,
]);
await sleep(8000);
png(out);
console.log("cursor updates:", cursors);
console.log("updates by code:", JSON.stringify(client.stats));
// キーボード: ドックの端末アイコン(567, 696)をクリックして開き、"echo mado" と打つ
const key = (code: string, down: boolean) => input.keyEvent(code, down) as Uint8Array;
client.sendInput([input.mouseMove(567, 696)]);
await sleep(300);
client.sendInput([
	input.mouseButton(0, true, 567, 696) as Uint8Array,
	input.mouseButton(0, false, 567, 696) as Uint8Array,
]);
await sleep(6000);
for (const c of ["KeyE", "KeyC", "KeyH", "KeyO", "Space", "KeyM", "KeyA", "KeyD", "KeyO", "Enter"])
	client.sendInput([key(c, true), key(c, false)]);
await sleep(3000);
png(out.replace(/\.png$/, ".keys.png"));
// クリップボード: こちらでコピーした文字列を、リモートのターミナルへ Ctrl+Shift+V で貼る
channels.clipboard.setLocalText("pasted-from-mado");
await sleep(1500);
client.sendInput([key("ControlLeft", true), key("ShiftLeft", true), key("KeyV", true), key("KeyV", false), key("ShiftLeft", false), key("ControlLeft", false)]);
await sleep(2500);
png(out.replace(/\.png$/, ".paste.png"));
client.close();
await ended;
process.exit(0);
