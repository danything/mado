// 自前の RDP クライアントの実機試験。xrdp(TLS のみ・NLA なし)に TCP + TLS でつなぎ、establish() を通して、
// 届いた画面の更新を PNG にする。使い方は docs/rdp-client.md の「試験」。
//   bun build tools/rdp-smoke.ts --target node --outfile out/rdp-smoke.mjs && node out/rdp-smoke.mjs
// (bun の TLS は RDP の自己署名証明書を断るので、node で動かす。環境変数: PORT / RDPUSER / RDPPASS / OUT)

import * as net from "node:net";
import * as tls from "node:tls";
import { establish } from "../web/rdp/connect";
import * as mcs from "../web/rdp/mcs";
import * as pdu from "../web/rdp/pdu";
import * as x224 from "../web/rdp/x224";
import type { Transport } from "../web/rdp/stream";

class Sock implements Transport {
	chunks: Buffer[] = [];
	have = 0;
	w?: () => void;
	err?: Error;
	constructor(public s: net.Socket | tls.TLSSocket) {
		s.on("data", (b) => { this.chunks.push(b); this.have += b.length; this.w?.(); });
		s.on("error", (e) => { this.err = e; this.w?.(); });
		s.on("close", () => { this.err ??= new Error("closed"); this.w?.(); });
	}
	async peek(n: number) {
		while (this.have < n) {
			if (this.err) throw this.err;
			await new Promise<void>((r) => (this.w = r));
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
	write(b: Uint8Array) { this.s.write(b); }
	close() { this.s.destroy(); }
}

const port = Number(process.env.PORT ?? 13389);
const raw = net.connect(port, "127.0.0.1");
await new Promise((r) => raw.once("connect", r));
const s0 = new Sock(raw);
s0.write(x224.connectionRequest(x224.PROTOCOL.SSL));
const h = await s0.peek(4);
const cc = await s0.read(((h[2] as number) << 8) | (h[3] as number));
console.log("CC", Buffer.from(cc).toString("hex"));
raw.removeAllListeners("data");
const t = tls.connect({ socket: raw, rejectUnauthorized: false });
await new Promise((r) => t.once("secureConnect", r));
const cert = new Uint8Array(t.getPeerCertificate().raw);
const s1 = new Sock(t);
const session = await establish(s1, {
	url: "", token: "", destination: "",
	username: process.env.RDPUSER ?? "ubuntu", password: process.env.RDPPASS ?? "ubuntu",
	width: 1280, height: 720, allowTls: true, dummyLicense: true,
	onLog: (l) => console.log("log:", l),
}, cc, cert);
console.log("session", session.userId, session.ioChannelId, [...session.channels], session.pending.length, session.pendingChannel.length);
import { Reassembler, UPDATE } from "../web/rdp/fastpath";
import { decodeBitmap, parseBitmapUpdate } from "../web/rdp/bitmap";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
const W = 1280, H = 720;
const fb = new Uint8Array(W * H * 4);
const re = new Reassembler();
const counts: Record<string, number> = {};
const handle = (u: { code: number; data: Uint8Array }) => {
	counts[u.code] = (counts[u.code] ?? 0) + 1;
	if (u.code !== UPDATE.BITMAP) return;
	for (const r of parseBitmapUpdate(u.data)) {
		const rgba = decodeBitmap(r);
		const w = r.right - r.left + 1, h = r.bottom - r.top + 1;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const si = (y * r.width + x) * 4, di = ((r.top + y) * W + r.left + x) * 4;
			fb[di] = rgba[si]!; fb[di+1] = rgba[si+1]!; fb[di+2] = rgba[si+2]!; fb[di+3] = 255;
		}
	}
};
for (const p of session.pending) if (p.kind === "fastpath") for (const u of re.push(p.data)) handle(u);
(async () => {
	for (;;) {
		const p = await x224.readPdu(s1);
		if (p.kind === "fastpath") { try { for (const u of re.push(p.data)) handle(u); } catch (e) { console.log("ERR", String(e)); } }
		else {
			try {
				const ind = mcs.parseSendDataIndication(p.data);
				if (ind.channelId !== session.ioChannelId) { console.log("chan", ind.channelId, ind.data.length); continue; }
				const sc = pdu.parseShareControl(ind.data);
				if (sc.type !== pdu.PDUTYPE.DATA) { console.log("sc type", sc.type); continue; }
				const sd = pdu.parseShareData(sc.body);
				counts["s" + sd.type2] = (counts["s" + sd.type2] ?? 0) + 1;
				if (sd.type2 === pdu.PDUTYPE2.UPDATE && sd.payload[0] === 1) handle({ code: UPDATE.BITMAP, data: sd.payload });
			} catch (e) { console.log("ERR slow", String(e)); }
		}
	}
})().catch((e) => console.log("reader ended:", String(e)));
await new Promise((r) => setTimeout(r, 25000));
console.log("updates", JSON.stringify(counts));
// PNG
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
const pix = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) { pix[y * (W * 4 + 1)] = 0; Buffer.from(fb.buffer, y * W * 4, W * 4).copy(pix, y * (W * 4 + 1) + 1); }
fs.writeFileSync(process.env.OUT ?? "screen.png", Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(pix)), chunk("IEND", Buffer.alloc(0))]));
process.exit(0);
