// mado の WebTransport を headless の Chromium で試す。Playwright の像の中で動かす。
// run.sh の mado(名前 mado.test)と xrdp(名前 xrdp)が同じ wslc network にいること。
//   wslc network create wtnet
//   wslc run -d --rm --name xrdp --network wtnet mado-xrdp-gfx
//   wslc run --rm --name mado-e2e --network wtnet --network-alias mado.test -v "<リポジトリ>:/src" -w /src mado-wt-e2e sh tools/wt-e2e/run.sh
//   wslc run --rm --network wtnet -v "<リポジトリ>:/src" mcr.microsoft.com/playwright:v1.56.1-noble sh /src/tools/wt-e2e/e2e.sh
// トークンと Cookie は run.sh の session.key(0x01 が 32 バイト)で署名して作る。形は server/Signer.cs と同じ。
const { chromium } = require("playwright");
const crypto = require("node:crypto");

const ORIGIN = "https://mado.test";
const KEY = Buffer.alloc(32, 1);

function sign(value, ttl = 60) {
	const body = Buffer.from(JSON.stringify({ ...value, exp: Math.floor(Date.now() / 1000) + ttl })).toString("base64url");
	const mac = crypto.createHmac("sha256", KEY).update(body).digest("base64url");
	return `${body}.${mac}`;
}
const relayToken = () => sign({ sub: "u1", target: "xrdp", jti: crypto.randomBytes(8).toString("hex"), name: "e2e" });

// ページの中で動かす。CONNECT の ?token= に connectToken を付けて開き、RDCleanPath の要求を送って応答の DER を読む
async function relayOverWt(page, base, token, connectToken = token) {
	const url = `${base}?token=${encodeURIComponent(connectToken)}`;
	return page.evaluate(
		async ({ url, token }) => {
			const tlv = (tag, ...parts) => {
				const body = parts.reduce((a, p) => new Uint8Array([...a, ...p]), new Uint8Array());
				const n = body.length;
				const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
				return new Uint8Array([tag, ...len, ...body]);
			};
			const utf8 = (s) => tlv(0x0c, new TextEncoder().encode(s));
			const x224 = new Uint8Array([3, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0]);
			const req = tlv(0x30, tlv(0xa0, tlv(0x02, new Uint8Array([0x0d, 0x3e]))), tlv(0xa2, utf8("xrdp")), tlv(0xa3, utf8(token)), tlv(0xa6, tlv(0x04, x224)));
			const t0 = performance.now();
			const wt = new WebTransport(url);
			wt.closed.catch(() => {});
			try {
				await wt.ready;
			} catch (e) {
				return { ready: false, error: String(e) };
			}
			const ready = performance.now() - t0;
			const s = await wt.createBidirectionalStream();
			const w = s.writable.getWriter();
			// 細かく分けて送る(サーバーは揃うまで溜める)
			for (let i = 0; i < req.length; i += 7) await w.write(req.subarray(i, i + 7));
			const r = s.readable.getReader();
			let buf = new Uint8Array();
			const want = () => {
				if (buf.length < 2) return Infinity;
				const l = buf[1];
				if (l < 128) return 2 + l;
				const k = l & 0x7f;
				if (buf.length < 2 + k) return Infinity;
				let n = 0;
				for (let i = 0; i < k; i++) n = n * 256 + buf[2 + i];
				return 2 + k + n;
			};
			try {
				while (buf.length < want()) {
					const { value, done } = await r.read();
					if (done) break;
					buf = new Uint8Array([...buf, ...value]);
				}
			} catch (e) {
				return { ready: true, error: String(e), tags: [], hex: "" };
			}
			const total = performance.now() - t0;
			// 外側の SEQUENCE の中のタグを並べる
			const tags = [];
			const head = buf[1] < 128 ? 2 : 2 + (buf[1] & 0x7f);
			for (let i = head; i < buf.length; ) {
				tags.push(buf[i].toString(16));
				const l = buf[i + 1];
				const k = l < 128 ? 0 : l & 0x7f;
				let n = l < 128 ? l : 0;
				for (let j = 0; j < k; j++) n = n * 256 + buf[i + 2 + j];
				i += 2 + k + n;
			}
			// エラーなら http_status_code([1] の中の [1])を探す
			const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
			wt.close();
			return { ready: true, readyMs: Math.round(ready), totalMs: Math.round(total), length: buf.length, tags, hex };
		},
		{ url, token },
	);
}

let failed = 0;
function check(name, ok, detail) {
	console.log(`${ok ? "ok  " : "NG  "}${name}${detail ? `  ${detail}` : ""}`);
	if (!ok) failed++;
}

(async () => {
	const browser = await chromium.launch({
		channel: "chromium", // headless shell には WebTransport が無いことがある
		// Chrome の QUIC は、手元で信頼させた CA の証明書を既定では断る。試験のときだけ許す
		args: ["--webtransport-developer-mode"],
	});
	console.log(`browser ${browser.version()}`);
	const context = await browser.newContext();
	await context.addCookies([{ name: "mado", value: sign({ sub: "u1", name: "e2e" }, 3600), domain: "mado.test", path: "/", secure: true, httpOnly: true }]);
	const page = await context.newPage();
	page.on("console", (m) => console.log(`[console] ${m.text()}`));
	await page.route(`${ORIGIN}/e2e`, (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>e2e</title>" }));
	await page.route("https://evil.test/e2e", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>evil</title>" }));

	await page.goto(`${ORIGIN}/e2e`);
	const info = await page.evaluate(async () => (await fetch("/api/session")).json());
	check("/api/session に wt がある", info.wt === `${ORIGIN}/wt`, JSON.stringify(info));

	const token = relayToken();
	const good = await relayOverWt(page, `${ORIGIN}/wt`, token);
	check("WebTransport で RDCleanPath の応答(x224 [6] と証明書 [7])", good.ready && good.tags.includes("a6") && good.tags.includes("a7"), JSON.stringify({ ...good, hex: undefined }));

	// 本物のクライアント(web/rdp の openTransport と RDCleanPath)で、WebTransport を選んで応答まで進む。
	// xrdp は NLA が無いので、TLS も選べる要求にする
	await page.addScriptTag({ path: "/tmp/client.js" });
	const real = await page.evaluate(async (token) => {
		const { openTransport, cleanpath, x224 } = globalThis.e2e;
		const logs = [];
		const { stream, kind } = await openTransport({ url: "wss://mado.test/ws", wt: "https://mado.test/wt", token, onLog: (l) => logs.push(l) });
		stream.write(cleanpath.request(x224.connectionRequest(x224.PROTOCOL.SSL | x224.PROTOCOL.HYBRID), token, "xrdp"));
		const resp = await cleanpath.readResponse(stream);
		stream.close();
		return { kind, certs: resp.certChain.length, cc: resp.x224.length, logs };
	}, relayToken());
	check("web/rdp のクライアントが WebTransport で RDCleanPath を通す", real.kind === "WebTransport" && real.certs > 0, JSON.stringify(real));
	const fallback = await page.evaluate(async (token) => {
		const { openTransport, cleanpath, x224 } = globalThis.e2e;
		const logs = [];
		// UDP の来ない port を指す。WebTransport は時間切れになり、WebSocket に移る
		const { stream, kind } = await openTransport({ url: "wss://mado.test/ws", wt: "https://mado.test:4443/wt", token, onLog: (l) => logs.push(l) });
		stream.write(cleanpath.request(x224.connectionRequest(x224.PROTOCOL.SSL | x224.PROTOCOL.HYBRID), token, "xrdp"));
		const resp = await cleanpath.readResponse(stream);
		stream.close();
		return { kind, certs: resp.certChain.length, logs };
	}, relayToken());
	check("WebTransport が開かなければ WebSocket に移る", fallback.kind === "WebSocket" && fallback.certs > 0, JSON.stringify(fallback));

	const replay = await relayOverWt(page, `${ORIGIN}/wt`, token);
	check("使ったトークンでは CONNECT から断る", !replay.ready, replay.error);

	const bad = await relayOverWt(page, `${ORIGIN}/wt`, "bad");
	check("でたらめなトークンは CONNECT から断る", !bad.ready, bad.error);

	const other = await relayOverWt(page, `${ORIGIN}/wt`, relayToken(), relayToken());
	// http_status_code は [1] INTEGER 401 → a1 04 02 02 01 91
	check("CONNECT と違うトークンを RDCleanPath に入れたら 401", other.ready && other.tags.includes("a1") && other.hex.includes("a10402020191"), JSON.stringify({ ...other, hex: undefined }));

	const path = await relayOverWt(page, `${ORIGIN}/other`, relayToken());
	check("/wt 以外のパスは開かない", !path.ready, path.error);

	// 放っておいた口は閉じられる。CONNECT の後に stream を開かないとき、開いても要求を送らないとき(どちらも 10 秒)
	const idle = await page.evaluate(async (url) => {
		const t0 = performance.now();
		const wt = new WebTransport(url);
		await wt.ready;
		const info = await Promise.race([wt.closed.then((i) => JSON.stringify(i), (e) => String(e)), new Promise((r) => setTimeout(() => r("まだ開いている"), 15000))]);
		return { info, ms: Math.round(performance.now() - t0) };
	}, `${ORIGIN}/wt?token=${encodeURIComponent(relayToken())}`);
	check("stream を開かないセッションは 10 秒で閉じる", idle.info !== "まだ開いている" && idle.ms < 13000, JSON.stringify(idle));
	const silent = await page.evaluate(async (url) => {
		const t0 = performance.now();
		const wt = new WebTransport(url);
		wt.closed.catch(() => {});
		await wt.ready;
		const s = await wt.createBidirectionalStream();
		// 何か書かないと stream がサーバーに届かない。RDCleanPath の頭の 1 バイトだけ送る
		const w = s.writable.getWriter();
		await w.write(new Uint8Array([0x30]));
		const r = s.readable.getReader();
		let n = 0;
		let hex = "";
		try {
			for (;;) {
				const { value, done } = await r.read();
				if (done) break;
				n += value.length;
				hex += Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
			}
		} catch (e) {
			hex += ` ${e}`;
		}
		return { n, hex, ms: Math.round(performance.now() - t0) };
	}, `${ORIGIN}/wt?token=${encodeURIComponent(relayToken())}`);
	// http_status_code 408 → a1 04 02 02 01 98
	check("要求を送り切らない stream は 10 秒で 408 を返して閉じる", silent.hex.includes("a10402020198") && silent.ms < 13000, JSON.stringify(silent));

	await page.goto("https://evil.test/e2e");
	const evil = await relayOverWt(page, `${ORIGIN}/wt`, relayToken());
	check("ほかの origin からは開かない", !evil.ready, evil.error);

	await browser.close();
	console.log(failed ? `${failed} 件が失敗` : "すべて通った");
	process.exit(failed ? 1 : 0);
})();
