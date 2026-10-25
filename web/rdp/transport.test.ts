// 中継への道の選び方(WebTransport を先に試し、だめなら WebSocket にする)と、証明書を確かめてから CredSSP に進むこと。

import { describe, expect, test } from "bun:test";

import { fromHex } from "./bytes";
import {
  connect,
  openTransport,
  type TransportOpeners,
  WT_TIMEOUT_MS,
} from "./connect";
import * as der from "./der";
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

  test("WebSocket に移るときはトークンを取り直す", async () => {
    const { o } = openers(() => Promise.reject(new Error("timeout")));
    const r = await openTransport(
      {
        url: "wss://h/ws",
        wt: "https://h/wt",
        token: "old",
        newToken: async () => "new",
      },
      o,
    );
    expect(r.kind).toBe("WebSocket");
    expect(r.token).toBe("new");
    // WebTransport で開けたら、CONNECT と同じトークンを使う
    const ok = openers(async () => fake("wt"));
    const w = await openTransport(
      {
        url: "wss://h/ws",
        wt: "https://h/wt",
        token: "old",
        newToken: async () => "new",
      },
      ok.o,
    );
    expect(w.token).toBe("old");
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

/** RDCleanPath の成功の応答を 1 つ返し、書かれたものを覚える道 */
function relay(cert: Uint8Array) {
  let rest = der.tlv(
    der.SEQUENCE,
    der.field(0, der.integer(3390)),
    // X.224 の接続確認(HYBRID を選んだ)
    der.field(
      6,
      der.octets(fromHex("03000013 0e d0 0000 1234 00 02 00 0800 02000000")),
    ),
    der.field(7, der.tlv(der.SEQUENCE, der.octets(cert))),
  );
  const written: Uint8Array[] = [];
  let closed = false;
  const stream = {
    async peek(n: number) {
      if (n > rest.length) throw new Error("もう無い");
      return rest.subarray(0, n);
    },
    async read(n: number) {
      if (n > rest.length) throw new Error("もう無い");
      const o = rest.subarray(0, n);
      rest = rest.subarray(n);
      return o;
    },
    write(b: Uint8Array) {
      written.push(b);
    },
    close() {
      closed = true;
    },
  } as unknown as Transport;
  return { stream, written, closed: () => closed };
}

describe("connect と RDP サーバーの証明書", () => {
  const cert = fromHex("3003020101");
  const options = (checkCert: (c: Uint8Array) => Promise<void>) => ({
    url: "wss://h/ws",
    token: "t.k",
    destination: "この PC",
    username: "alice",
    password: "secret",
    width: 800,
    height: 600,
    checkCert,
  });

  test("証明書を断ったら、RDCleanPath の要求のほかは何も送らずに閉じる", async () => {
    const r = relay(cert);
    let seen: Uint8Array | undefined;
    await expect(
      connect(
        options(async (c) => {
          seen = c;
          throw new Error("証明書を信頼しなかった");
        }),
        { ws: async () => r.stream },
      ),
    ).rejects.toThrow("証明書を信頼しなかった");
    expect(seen).toEqual(cert);
    expect(r.written.length).toBe(1);
    expect(r.closed()).toBe(true);
  });

  test("証明書を確かめてから CredSSP に進む", async () => {
    const r = relay(cert);
    const order: string[] = [];
    await expect(
      connect(
        options(async () => {
          order.push(`check ${r.written.length}`);
        }),
        { ws: async () => r.stream },
      ),
      // 試験の証明書には公開鍵が無いので、CredSSP が鍵を取り出すところで止まる
    ).rejects.toThrow("DER");
    // 確かめた時点では要求しか送っていない
    expect(order).toEqual(["check 1"]);
  });
});
