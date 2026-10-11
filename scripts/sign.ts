// release.yml から呼ぶ。dist/mado.exe に Ed25519 の署名(`mado <タグ> <SHA-256>`)を付けて dist/mado.exe.sig に書く。
// 秘密鍵は環境変数 MADO_SIGNING_KEY(PKCS#8 の base64。GitHub の secret)。書いたあと、exe に入っている公開鍵で確かめる。
//   bun scripts/sign.ts v0.3.0

import { sha256File, signedMessage, verifySignature } from "../src/update.ts";

const tag = process.argv[2];
const secret = process.env.MADO_SIGNING_KEY;
if (!tag) throw new Error("タグが要る");
if (!secret) throw new Error("MADO_SIGNING_KEY が要る");

const key = await crypto.subtle.importKey(
	"pkcs8",
	Buffer.from(secret, "base64"),
	{ name: "Ed25519" },
	false,
	["sign"],
);
const message = signedMessage(tag, await sha256File("dist/mado.exe"));
const sig = Buffer.from(
	await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message)),
).toString("base64");
if (!(await verifySignature(message, sig)))
	throw new Error(
		"署名が src/update.ts の PUBLIC_KEY で確かめられない(鍵が対になっていない)",
	);
await Bun.write("dist/mado.exe.sig", `${sig}\n`);
console.log(`signed: ${message}`);
