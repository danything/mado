import { expect, test } from "bun:test";
import {
	compareVersions,
	PUBLIC_KEY,
	signedMessage,
	verifySignature,
} from "../src/update.ts";

const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
	"sign",
	"verify",
])) as CryptoKeyPair;
const pub = Buffer.from(
	await crypto.subtle.exportKey("raw", pair.publicKey),
).toString("base64");
const sign = async (message: string) =>
	Buffer.from(
		await crypto.subtle.sign(
			"Ed25519",
			pair.privateKey,
			new TextEncoder().encode(message),
		),
	).toString("base64");

test("署名を確かめる", async () => {
	const m = signedMessage("v1.2.3", "ab".repeat(32));
	expect(await verifySignature(m, await sign(m), pub)).toBe(true);
});

test("中身・タグが違えば通さない(古い版を新しいと偽れない)", async () => {
	const sig = await sign(signedMessage("v0.1.0", "ab".repeat(32)));
	expect(
		await verifySignature(signedMessage("v9.9.9", "ab".repeat(32)), sig, pub),
	).toBe(false);
	expect(
		await verifySignature(signedMessage("v0.1.0", "cd".repeat(32)), sig, pub),
	).toBe(false);
});

test("別の鍵の署名・壊れた署名は通さない", async () => {
	const m = signedMessage("v1.0.0", "00".repeat(32));
	expect(await verifySignature(m, await sign(m), PUBLIC_KEY)).toBe(false);
	expect(await verifySignature(m, "not-base64!", pub)).toBe(false);
});

test("PUBLIC_KEY は 32 バイトの Ed25519 の鍵", () => {
	expect(Buffer.from(PUBLIC_KEY, "base64").length).toBe(32);
});

test("版の比較", () => {
	expect(compareVersions("v0.3.0", "v0.2.9")).toBeGreaterThan(0);
	expect(compareVersions("v0.10.0", "v0.9.0")).toBeGreaterThan(0);
	expect(compareVersions("0.2.1", "v0.2.1")).toBe(0);
	expect(compareVersions("v0.2.1", "v1.0.0")).toBeLessThan(0);
});

// --- 入れ替え(apply)。fetch を差し替え、一時フォルダの exe で試す -----------------------------
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256File, Updater } from "../src/update.ts";

async function setup(opts: { badSig?: boolean }) {
	const dir = await mkdtemp(path.join(tmpdir(), "mado-update-"));
	const exe = path.join(dir, "mado.exe");
	await writeFile(exe, "old");
	const fresh = path.join(dir, "payload");
	await writeFile(fresh, "new");
	const tag = "v99.0.0";
	const sig = await sign(
		signedMessage(opts.badSig ? "v98.0.0" : tag, await sha256File(fresh)),
	);
	const release = {
		tag_name: tag,
		assets: [
			{ name: "mado.exe", browser_download_url: "https://example.test/exe" },
			{
				name: "mado.exe.sig",
				browser_download_url: "https://example.test/sig",
			},
		],
	};
	const real = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const u = String(input);
		if (u.includes("/releases/latest")) return Response.json(release);
		if (u.endsWith("/sig")) return new Response(sig);
		if (u.endsWith("/exe")) return new Response("new");
		return new Response("nf", { status: 404 });
	}) as typeof fetch;
	const updater = new Updater(
		{ repo: "x/y", exePath: exe, publicKey: pub },
		() => {},
	);
	return {
		dir,
		exe,
		updater,
		done: async () => {
			globalThis.fetch = real;
			await rm(dir, { recursive: true, force: true });
		},
	};
}

test("新しい版を確かめて入れ替える(今のものは .old に)", async () => {
	const s = await setup({});
	try {
		expect((await s.updater.check()).available).toBe(true);
		expect(await s.updater.apply()).toBe(true);
		expect(await readFile(s.exe, "utf8")).toBe("new");
		expect(await readFile(`${s.exe}.old`, "utf8")).toBe("old");
	} finally {
		await s.done();
	}
});

test("署名が合わなければ入れ替えず、その版は取り直さない", async () => {
	const s = await setup({ badSig: true });
	try {
		await s.updater.check();
		expect(await s.updater.apply()).toBe(false);
		expect(await readFile(s.exe, "utf8")).toBe("old");
		expect((await s.updater.check()).available).toBe(false);
	} finally {
		await s.done();
	}
});

test("落としているあいだに誰かつないだら入れ替えない", async () => {
	const s = await setup({});
	try {
		await s.updater.check();
		expect(await s.updater.apply(() => false)).toBe(false);
		expect(await readFile(s.exe, "utf8")).toBe("old");
	} finally {
		await s.done();
	}
});
