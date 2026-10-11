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
