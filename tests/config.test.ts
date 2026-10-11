import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";

const dir = await mkdtemp(path.join(tmpdir(), "mado-config-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const base = {
	host: "md.example.com",
	acme: { email: "a@example.com" },
	oidc: {
		issuer: "https://idp.example.com",
		client_id: "id",
		client_secret: "s",
	},
};

async function load(value: unknown, name = "mado.json") {
	const file = path.join(dir, name);
	await Bun.write(
		file,
		typeof value === "string" ? value : JSON.stringify(value),
	);
	return (await loadConfig(["--config", file])).config;
}

test("targets を省くとこのマシンだけ", async () => {
	expect((await load(base)).targets).toEqual([
		{ name: "localhost", host: "127.0.0.1", port: 3389 },
	]);
});

test("targets: name の既定は host、port の既定は 3389", async () => {
	const c = await load({
		...base,
		targets: [
			{ host: "10.0.0.20" },
			{ name: "b", host: "10.0.0.21", port: 3390 },
		],
	});
	expect(c.targets).toEqual([
		{ name: "10.0.0.20", host: "10.0.0.20", port: 3389 },
		{ name: "b", host: "10.0.0.21", port: 3390 },
	]);
});

test.each([
	[{ targets: [] }, "1 つ以上"],
	[{ targets: { host: "x" } }, "1 つ以上"],
	[{ targets: [{ name: "a" }] }, "host が要る"],
	[{ targets: [{ host: "x", port: "3389" }] }, "1〜65535"],
	[{ targets: [{ host: "x", port: 70000 }] }, "1〜65535"],
	[{ targets: [{ host: "x" }, { host: "x" }] }, "重なっている"],
])("targets の間違いは起動時に止める %#", async (bad, message) => {
	await expect(load({ ...base, ...bad })).rejects.toThrow(message);
});

test("v0.1 の TOML を渡されたら JSON に変わったと言う", async () => {
	await expect(load('host = "x"', "mado.toml")).rejects.toThrow("JSON");
});

test("JSON として読めなければファイル名つきで止める", async () => {
	await expect(load("{ host: ", "broken.json")).rejects.toThrow("broken.json");
});
