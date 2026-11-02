import { describe, expect, test } from "bun:test";

import {
  DashboardSession,
  type DashSocket,
  EXPIRY_WARN_DAYS,
  expiryNote,
  explainDashboardError,
  helloMessage,
  resizeMessage,
} from "./dashboard";

/** 偽の WebSocket。送ったものを sent に溜め、fire で出来事を起こす */
class FakeSocket implements DashSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  private handlers: Record<string, ((e: never) => void)[]> = {};

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, f: (e: never) => void): void {
    (this.handlers[type] ??= []).push(f);
  }
  fire(type: string, e: unknown = {}): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const f of this.handlers[type] ?? []) f(e as never);
  }
}

describe("Talos のダッシュボード", () => {
  test("最初にトークンと大きさを送り、あとは入力と大きさの変更", async () => {
    const ws = new FakeSocket();
    let url = "";
    const opening = DashboardSession.open(
      "wss://md.example.com/ws/talos",
      "tok",
      120,
      40,
      (u) => {
        url = u;
        return ws;
      },
    );
    ws.fire("open");
    const dash = await opening;
    expect(url).toBe("wss://md.example.com/ws/talos");
    expect(ws.binaryType).toBe("arraybuffer");
    expect(ws.sent[0]).toBe('{"token":"tok","cols":120,"rows":40}');

    dash.send(new Uint8Array([0x71]));
    dash.resize(100, 30);
    expect(ws.sent[1]).toEqual(new Uint8Array([0x71]));
    expect(ws.sent[2]).toBe('{"cols":100,"rows":30}');

    const got: number[] = [];
    dash.onData = (b) => got.push(...b);
    ws.fire("message", { data: new Uint8Array([1, 2]).buffer });
    // テキストのメッセージは画面に出さない
    ws.fire("message", { data: "x" });
    expect(got).toEqual([1, 2]);

    ws.fire("close", { reason: "exited 0" });
    expect(await dash.done).toBe("exited 0");
    // 閉じたあとは送らない
    dash.send(new Uint8Array([0x71]));
    expect(ws.sent.length).toBe(3);
  });

  test("つながらなければ失敗する", async () => {
    const ws = new FakeSocket();
    const opening = DashboardSession.open(
      "wss://x/ws/talos",
      "t",
      80,
      24,
      () => ws,
    );
    ws.fire("error");
    await expect(opening).rejects.toThrow("cannot open");
  });

  test("メッセージの形はコマンドを含まない", () => {
    // ブラウザが送れるのはトークンと大きさだけ(コマンドや引数は mado.json で決まる)
    expect(Object.keys(JSON.parse(helloMessage("t", 1, 2)))).toEqual([
      "token",
      "cols",
      "rows",
    ]);
    expect(Object.keys(JSON.parse(resizeMessage(1, 2)))).toEqual([
      "cols",
      "rows",
    ]);
  });

  test("閉じた理由を次にすることが分かる文にする", () => {
    expect(explainDashboardError("exited 0")).toBe(
      "ダッシュボードを終了しました",
    );
    expect(explainDashboardError("exited 1")).toContain("終了コード 1");
    expect(explainDashboardError("talosctl not found")).toContain(
      "talos の先の talosctl",
    );
    expect(explainDashboardError("talosconfig unreadable")).toContain(
      "setup.ps1",
    );
    expect(explainDashboardError("token rejected")).toContain("mado.json");
    expect(explainDashboardError("")).toBe("ダッシュボードを終了しました");
    expect(explainDashboardError("something else")).toBe("something else");
  });

  test("期限が近いか切れていれば知らせる", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    const days = (n: number) =>
      new Date(now.getTime() + n * 86_400_000).toISOString();
    expect(expiryNote(undefined, now)).toBeUndefined();
    expect(expiryNote("not a date", now)).toBeUndefined();
    expect(expiryNote(days(90), now)).toBeUndefined();
    expect(expiryNote(days(EXPIRY_WARN_DAYS), now)).toBeUndefined();
    expect(expiryNote(days(5.5), now)).toEqual({
      text: "Talos の証明書はあと 5 日で切れます。gitops の mado/setup.ps1 を流し直してください",
      kind: "warn",
    });
    expect(expiryNote(days(-1), now)?.kind).toBe("error");
  });
});
