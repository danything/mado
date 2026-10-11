// 手元の RDP(127.0.0.1:3389)に対して中継の最初の往復を確かめる。RDP が無ければ飛ばす
import { expect, test } from "bun:test";
import net from "node:net";
import {
	integer,
	octets,
	readAll,
	readTlv,
	Tag,
	tlv,
	utf8,
} from "../src/der.ts";
import { Relay } from "../src/gateway.ts";
import { VERSION } from "../src/rdcleanpath.ts";

const rdpUp = await new Promise<boolean>((ok) => {
	const s = net.connect(3389, "127.0.0.1");
	s.once("connect", () => (s.destroy(), ok(true)));
	s.once("error", () => ok(false));
});

test.skipIf(!rdpUp)(
	"RDP の X.224 → TLS まで進み、証明書つきの応答を返す",
	async () => {
		// X.224 接続要求 + RDP_NEG_REQ(PROTOCOL_SSL | PROTOCOL_HYBRID)
		const x224 = Uint8Array.from([
			3, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0,
		]);
		const req = tlv(
			Tag.Sequence,
			tlv(Tag.context(0), integer(VERSION)),
			tlv(Tag.context(2), utf8("mado")),
			tlv(Tag.context(3), utf8("ok")),
			tlv(Tag.context(6), octets(x224)),
		);
		const sent: Uint8Array[] = [];
		let closed = false;
		const ws = {
			sendBinary: (d: Uint8Array) => sent.push(new Uint8Array(d)),
			getBufferedAmount: () => 0,
			close: () => (closed = true),
		};
		const relay = new Relay(
			ws as never,
			{ host: "127.0.0.1", port: 3389 },
			(a) => a === "ok",
			() => {},
		);
		relay.onMessage(req.subarray(0, 10));
		relay.onMessage(req.subarray(10));
		for (let i = 0; i < 50 && !sent.length; i++) await Bun.sleep(100);
		relay.close();
		expect(closed).toBe(true);
		const outer = readTlv(sent[0] as Uint8Array);
		const tags = readAll(outer?.value as Uint8Array).map((f) => f.tag);
		expect(tags).toEqual([
			Tag.context(0),
			Tag.context(6),
			Tag.context(7),
			Tag.context(9),
		]);
	},
);

test.skipIf(!rdpUp)(
	"proxy_auth が違えば RDP につながずエラーを返す",
	async () => {
		const req = tlv(
			Tag.Sequence,
			tlv(Tag.context(0), integer(VERSION)),
			tlv(Tag.context(3), utf8("ng")),
			tlv(Tag.context(6), octets(new Uint8Array(19))),
		);
		const sent: Uint8Array[] = [];
		const ws = {
			sendBinary: (d: Uint8Array) => sent.push(d),
			getBufferedAmount: () => 0,
			close: () => {},
		};
		new Relay(
			ws as never,
			{ host: "127.0.0.1", port: 3389 },
			(a) => a === "ok",
			() => {},
		).onMessage(req);
		const tags = readAll(
			readTlv(sent[0] as Uint8Array)?.value as Uint8Array,
		).map((f) => f.tag);
		expect(tags).toEqual([Tag.context(0), Tag.context(1)]);
	},
);
