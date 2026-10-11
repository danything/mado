import { afterAll, expect, test } from "bun:test";
import { serveStatus } from "../src/status.ts";

const state = { latest: null, available: false, checkedAt: null, error: null };
let updates = 0;
const server = serveStatus(
	0,
	() => ({
		version: "v0.0.0",
		origin: "https://md.example.com",
		startedAt: "",
		sessions: 0,
		certDaysLeft: null,
		update: state,
	}),
	async () => {
		updates++;
		return { updated: false, state };
	},
);
afterAll(() => server.stop());
const base = `http://127.0.0.1:${server.port}`;

test("GET /status", async () => {
	const res = await fetch(`${base}/status`);
	expect(res.status).toBe(200);
	expect((await res.json()).version).toBe("v0.0.0");
});

test("Host がよその名前なら弾く(DNS リバインディング)", async () => {
	const res = await fetch(`${base}/status`, {
		headers: { host: "evil.example" },
	});
	expect(res.status).toBe(403);
});

test("POST /update は x-mado: 1 が要る", async () => {
	expect((await fetch(`${base}/update`, { method: "POST" })).status).toBe(403);
	const res = await fetch(`${base}/update`, {
		method: "POST",
		headers: { "x-mado": "1" },
	});
	expect(res.status).toBe(200);
	expect(updates).toBe(1);
});
