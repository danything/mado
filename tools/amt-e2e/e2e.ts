// mado を通して偽の AMT の電源と SOL を試す。本物の web/amt のクライアントを使う。
// Cookie と中継のトークンは run.sh の session.key(0x01 が 32 バイト)で署名して作る(形は server/Signer.cs と同じ)。
//   wslc run --rm --network amtnet -v "<リポジトリ>:/app" -w /app oven/bun:1 bun tools/amt-e2e/e2e.ts

import { createHmac } from "node:crypto";

import { BufferedTransport, FAKE, fakeIso } from "../../web/amt/amt.fixture";
import { AmtAuthError, WsmanClient } from "../../web/amt/client";
import { IderSession } from "../../web/amt/ider";
import { SolSession } from "../../web/amt/redirect";
import { DashboardSession, type DashSocket } from "../../web/talos/dashboard";

const ORIGIN = process.env.ORIGIN ?? "http://mado.test:8080";
const KEY = Buffer.alloc(32, 1);

function sign(value: object, ttl = 600): string {
  const body = Buffer.from(
    JSON.stringify({ ...value, exp: Math.floor(Date.now() / 1000) + ttl }),
  ).toString("base64url");
  const mac = createHmac("sha256", KEY).update(body).digest("base64url");
  return `${body}.${mac}`;
}

const cookie = `mado=${sign({ sub: "u1", name: "e2e" })}`;
const headers = { cookie, origin: ORIGIN };
const fetchVia =
  (extra: Record<string, string> = headers) =>
  (url: string, init: RequestInit) =>
    fetch(ORIGIN + url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...extra },
    });

function check(ok: boolean, what: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
}

// 1. 一覧に AMT の先と Talos の先が種類つきで出る
const session = (await (
  await fetch(`${ORIGIN}/api/session`, { headers })
).json()) as { targets: { name: string; type: string }[]; ws: string };
check(
  session.targets.some((t) => t.name === "z440-amt" && t.type === "amt") &&
    session.targets.some((t) => t.name === "pc" && t.type === "rdp") &&
    session.targets.some((t) => t.name === "z440-talos" && t.type === "talos"),
  `/api/session の targets: ${JSON.stringify(session.targets)}`,
);

// 2. WS-Man: 電源の状態を読み、切って、入れる
const amt = new WsmanClient(
  "z440-amt",
  FAKE.username,
  FAKE.password,
  fetchVia(),
);
const p1 = await amt.power();
check(p1.state === 2, `電源の状態 ${JSON.stringify(p1)}`);
check((await amt.changePower(8)) === 0, "電源を切る(8)");
check((await amt.power()).state === 8, "切れた");
check((await amt.changePower(2)) === 0, "電源を入れる(2)");
check((await amt.power()).state === 2, "入った");

// 3. パスワードが違えば AmtAuthError
try {
  await new WsmanClient("z440-amt", FAKE.username, "wrong", fetchVia()).power();
  check(false, "違うパスワードで通ってしまった");
} catch (e) {
  check(e instanceof AmtAuthError, `違うパスワードは断られる (${e})`);
}

// 4. 宛先の制限: RDP の先、無い先、Origin の違い、ログインなし
const post = (name: string, h: Record<string, string>) =>
  fetch(`${ORIGIN}/api/amt/${encodeURIComponent(name)}/wsman`, {
    method: "POST",
    headers: { "content-type": "application/soap+xml", ...h },
    body: "<x/>",
  });
check(
  (await post("pc", headers)).status === 404,
  "RDP の先には WS-Man を送らない (404)",
);
check(
  (await post("10.10.0.3", headers)).status === 404,
  "アドレスでは送れない (404)",
);
check(
  (await post("z440-amt", { cookie, origin: "https://evil.example" }))
    .status === 403,
  "Origin が違えば 403",
);
check(
  (await post("z440-amt", { origin: ORIGIN })).status === 401,
  "ログインなしは 401",
);
const big = await fetch(`${ORIGIN}/api/amt/z440-amt/wsman`, {
  method: "POST",
  headers: { "content-type": "application/soap+xml", ...headers },
  body: "x".repeat(70 * 1024),
});
check(big.status === 413, `大きすぎる本文は 413 (${big.status})`);

// 5. SOL: /ws/amt にトークンの行を送り、リダイレクトを話す
const token = async (target: string) =>
  (
    (await (
      await fetch(`${ORIGIN}/api/token?target=${encodeURIComponent(target)}`, {
        headers,
      })
    ).json()) as { token: string }
  ).token;

async function openWs(): Promise<{
  io: BufferedTransport;
  closed: Promise<string>;
}> {
  const ws = new WebSocket(`${session.ws}/amt`, {
    headers,
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  let onClose: (r: string) => void = () => {};
  const closed = new Promise<string>((r) => {
    onClose = r;
  });
  const io = new BufferedTransport(
    (b) => ws.send(b),
    () => ws.close(),
  );
  ws.addEventListener("message", (e) =>
    io.push(new Uint8Array(e.data as ArrayBuffer)),
  );
  ws.addEventListener("close", (e) => {
    io.end();
    onClose(e.reason);
  });
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  return { io, closed };
}

{
  const { io } = await openWs();
  io.write(new TextEncoder().encode(`${await token("z440-amt")}\n`));
  const sol = await SolSession.start(io, {
    username: FAKE.username,
    password: FAKE.password,
  });
  let out = "";
  const got = new Promise<void>((resolve) => {
    sol.onData = (b) => {
      out += new TextDecoder().decode(b);
      if (out.includes("HELLO TALOS")) resolve();
    };
  });
  sol.send(new TextEncoder().encode("hello talos"));
  await Promise.race([got, Bun.sleep(5000)]);
  check(out.includes("Talos (fake AMT SOL)"), "SOL の出力が届く");
  check(out.includes("HELLO TALOS"), "SOL のキー入力が届いて返る");
  sol.close();
}

// 6. RDP の先のトークンでは SOL の中継は閉じる
{
  const { io, closed } = await openWs();
  io.write(new TextEncoder().encode(`${await token("pc")}\n`));
  const reason = await Promise.race([
    closed,
    Bun.sleep(5000).then(() => "timeout"),
  ]);
  check(reason === "token rejected", `RDP の先のトークンは断る (${reason})`);
}

// 7. IDE-R: ISO を CD として見せ、偽の AMT(BIOS の代わり)の読み出しに答える。起動の設定と電源の操作も通す
{
  const { io } = await openWs();
  io.write(new TextEncoder().encode(`${await token("z440-amt")}\n`));
  const ider = await IderSession.start(io, {
    username: FAKE.username,
    password: FAKE.password,
    cd: new Blob([fakeIso(64) as Uint8Array<ArrayBuffer>]),
  });
  const reason = await Promise.race([
    ider.done,
    Bun.sleep(10000).then(() => "timeout"),
  ]);
  check(
    ider.stats.bytesRead === 5 * 2048 && ider.stats.lastLba === 20,
    `IDE-R の読み出しに答えた (${JSON.stringify(ider.stats)}、${reason})`,
  );
  const boot = await amt.bootFromIder();
  check(
    boot.result === 0,
    `IDE-R から起動の設定と電源の操作 (${JSON.stringify(boot)})`,
  );
}

// 8. Talos のダッシュボード: /ws/talos は talos の先のトークンだけを受ける。
// Linux の mado は ConPTY が無いので、talosctl を動かすところで「not supported」で閉じる(そこまで通れば中継の入口は通った)
async function dash(target: string): Promise<string> {
  const d = await DashboardSession.open(
    `${session.ws}/talos`,
    await token(target),
    80,
    24,
    (u) => new WebSocket(u, { headers } as unknown as string[]) as DashSocket,
  );
  return Promise.race([d.done, Bun.sleep(5000).then(() => "timeout")]);
}
{
  const reason = await dash("z440-talos");
  check(
    reason === "not supported",
    `Talos の先のトークンで talosctl を動かしにいく (${reason})`,
  );
  const amtReason = await dash("z440-amt");
  check(
    amtReason === "token rejected",
    `AMT の先のトークンではダッシュボードを動かさない (${amtReason})`,
  );
}

// 9. Talos の電源の操作: Origin・ログイン・先の種類・操作の名前を確かめる。Linux の mado は talosctl を動かせず「not supported」
{
  const power = (name: string, action: string, h: Record<string, string>) =>
    fetch(`${ORIGIN}/api/talos/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      headers: h,
    });
  check(
    (
      await power("z440-talos", "reboot", {
        cookie,
        origin: "https://evil.example",
      })
    ).status === 403,
    "Talos の電源: Origin が違えば 403",
  );
  check(
    (await power("z440-talos", "reboot", { origin: ORIGIN })).status === 401,
    "Talos の電源: ログインなしは 401",
  );
  check(
    (await power("z440-amt", "reboot", headers)).status === 404,
    "Talos の電源: AMT の先には動かさない (404)",
  );
  check(
    (await power("z440-talos", "upgrade", headers)).status === 404,
    "Talos の電源: 決まった操作のほかは 404",
  );
  const r = await power("z440-talos", "shutdown", headers);
  const body = (await r.json()) as { ok: boolean; reason?: string };
  check(
    r.status === 200 && !body.ok && body.reason === "not supported",
    `Talos の電源: talos の先なら talosctl を動かしにいく (${r.status} ${JSON.stringify(body)})`,
  );
}

console.log(process.exitCode ? "e2e: 失敗あり" : "e2e: すべて通った");
