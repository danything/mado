// 中継への道の選び方。WebTransport を先に試し、だめなら WebSocket にする。

import { describe, expect, test } from "bun:test";
import { openTransport, type TransportOpeners, WT_TIMEOUT_MS } from "./connect";
import type { Transport } from "./stream";

const fake = (name: string): Transport =>
	({ name, close() {}, write() {} }) as unknown as Transport;

function openers(wt?: () => Promise<Transport>) {
	const calls: string[] = [];
	const o: TransportOpeners = {
		wt: wt
			? (url, ms) => {
					calls.push(`wt ${url} ${ms}`);
					return wt();
				}
			: undefined,
		ws: async (url) => {
			calls.push(`ws ${url}`);
			return fake("ws");
		},
	};
	return { o, calls };
}

describe("openTransport", () => {
	test("WebTransport が開けばそれを使う", async () => {
		const { o, calls } = openers(async () => fake("wt"));
		const r = await openTransport(
			{ url: "wss://h/ws", wt: "https://h/wt", token: "t.k" },
			o,
		);
		expect(r.kind).toBe("WebTransport");
		expect(calls).toEqual([`wt https://h/wt?token=t.k ${WT_TIMEOUT_MS}`]);
	});

	test("WebTransport が開けなければ黙って WebSocket にする", async () => {
		const { o, calls } = openers(() => Promise.reject(new Error("timeout")));
		const logs: string[] = [];
		const r = await openTransport(
			{
				url: "wss://h/ws",
				wt: "https://h/wt",
				token: "t.k",
				onLog: (l) => logs.push(l),
			},
			o,
		);
		expect(r.kind).toBe("WebSocket");
		expect(calls).toEqual([
			`wt https://h/wt?token=t.k ${WT_TIMEOUT_MS}`,
			"ws wss://h/ws",
		]);
		expect(logs[0]).toContain("timeout");
	});

	test("サーバーが /wt を知らせなければ WebSocket だけ", async () => {
		const { o, calls } = openers(async () => fake("wt"));
		const r = await openTransport({ url: "wss://h/ws", token: "t.k" }, o);
		expect(r.kind).toBe("WebSocket");
		expect(calls).toEqual(["ws wss://h/ws"]);
	});

	test("ブラウザに WebTransport が無ければ WebSocket だけ", async () => {
		const { o, calls } = openers();
		const r = await openTransport(
			{ url: "wss://h/ws", wt: "https://h/wt", token: "t.k" },
			o,
		);
		expect(r.kind).toBe("WebSocket");
		expect(calls).toEqual(["ws wss://h/ws"]);
	});

	test("WebSocket も開けなければ失敗する", async () => {
		const o: TransportOpeners = {
			wt: () => Promise.reject(new Error("no udp")),
			ws: () => Promise.reject(new Error("cannot open")),
		};
		await expect(
			openTransport({ url: "wss://h/ws", wt: "https://h/wt", token: "t.k" }, o),
		).rejects.toThrow("cannot open");
	});
});
