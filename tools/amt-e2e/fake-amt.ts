// 偽の Intel AMT。WS-Man を 16992(HTTP、Digest)で、リダイレクト(SOL)を 16994(TCP)で待つ。
// 中身は web/amt/amt.fixture.ts。本物の AMT と同じく、WWW-Authenticate の付いた 401 を返す。
//   wslc run -d --rm --name amt --network amtnet --network-alias amt.test -v "<リポジトリ>:/app" -w /app oven/bun:1 bun tools/amt-e2e/fake-amt.ts

import {
  BufferedTransport,
  FakeWsman,
  serveAny,
} from "../../web/amt/amt.fixture";

const wsman = new FakeWsman();

Bun.serve({
  port: 16992,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/wsman")
      return new Response("not found", { status: 404 });
    const r = wsman.handle({
      authorization: req.headers.get("authorization") ?? undefined,
      body: await req.text(),
    });
    if (r.status === 200 && r.body.includes("RequestPowerStateChange_OUTPUT"))
      console.log(`power: ${wsman.requests.at(-1)}`);
    return new Response(r.body, {
      status: r.status,
      headers: {
        "content-type": "application/soap+xml; charset=UTF-8",
        ...(r.authenticate ? { "www-authenticate": r.authenticate } : {}),
      },
    });
  },
});

type Data = { io: BufferedTransport };
Bun.listen<Data>({
  hostname: "0.0.0.0",
  port: 16994,
  socket: {
    open(s) {
      const io = new BufferedTransport(
        (b) => void s.write(b),
        () => s.end(),
      );
      s.data = { io };
      void serveAny(io, { banner: "Talos (fake AMT SOL)\r\n" }).then(
        (end) => console.log(`redirect: ${end}`),
        (e) => {
          console.log(`redirect error: ${e}`);
          s.end();
        },
      );
    },
    data(s, b) {
      s.data.io.push(new Uint8Array(b));
    },
    close(s) {
      s.data.io.end();
    },
  },
});

console.log("fake AMT: wsman 16992, redirect 16994");
