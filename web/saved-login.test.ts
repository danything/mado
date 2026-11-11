import { describe, expect, test } from "bun:test";

import { IDBFactory } from "fake-indexeddb";

import { LoginVault } from "./saved-login";

// WebCrypto は bun のもの、IndexedDB は fake-indexeddb(試験ごとに空の場所を作る)
const subtle = crypto.subtle;

async function open(indexedDB = new IDBFactory()): Promise<LoginVault> {
  const v = await LoginVault.open({ indexedDB, subtle });
  if (!v) throw new Error("開けない");
  return v;
}

/** 置いてあるものをそのまま読む(ファイルを読んだ人に見えるもの) */
async function raw(idb: IDBFactory, store: string): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open("mado-logins");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

describe("保存するユーザー名とパスワード", () => {
  test("保存したものを読み出せる。開き直しても読める", async () => {
    const idb = new IDBFactory();
    const v = await open(idb);
    expect(await v.load("amt", "z440")).toBeUndefined();
    await v.save("amt", "z440", { username: "admin", password: "P@ss 語" });
    expect(await v.load("amt", "z440")).toEqual({
      username: "admin",
      password: "P@ss 語",
    });
    expect(await (await open(idb)).load("amt", "z440")).toEqual({
      username: "admin",
      password: "P@ss 語",
    });
  });

  test("つなぐ先と種類ごとに別に持つ", async () => {
    const v = await open();
    await v.save("amt", "z440", { username: "admin", password: "a" });
    await v.save("rdp", "z440", { username: "DOM\\alice", password: "b" });
    await v.save("rdp", "書斎", { username: "bob", password: "c" });
    expect((await v.load("amt", "z440"))?.password).toBe("a");
    expect(await v.load("rdp", "z440")).toEqual({
      username: "DOM\\alice",
      password: "b",
    });
    expect((await v.load("rdp", "書斎"))?.password).toBe("c");
    expect(await v.load("amt", "書斎")).toBeUndefined();
  });

  test("上書きすると新しいものになる", async () => {
    const v = await open();
    await v.save("rdp", "pc", { username: "alice", password: "old" });
    await v.save("rdp", "pc", { username: "alice2", password: "new" });
    expect(await v.load("rdp", "pc")).toEqual({
      username: "alice2",
      password: "new",
    });
  });

  test("消すとその先だけ無くなる", async () => {
    const v = await open();
    await v.save("amt", "pc", { username: "admin", password: "a" });
    await v.save("rdp", "pc", { username: "alice", password: "b" });
    await v.remove("amt", "pc");
    expect(await v.load("amt", "pc")).toBeUndefined();
    expect((await v.load("rdp", "pc"))?.password).toBe("b");
    // 無いものを消しても何も起きない
    await v.remove("amt", "pc");
  });

  test("一覧に無くなった先の保存を消す", async () => {
    const v = await open();
    await v.save("amt", "pc", { username: "admin", password: "a" });
    await v.save("rdp", "pc", { username: "alice", password: "b" });
    await v.save("rdp", "古い PC", { username: "bob", password: "c" });
    await v.prune([
      ["rdp", "pc"],
      ["amt", "ほかの先"],
    ]);
    expect(await v.load("amt", "pc")).toBeUndefined();
    expect(await v.load("rdp", "古い PC")).toBeUndefined();
    expect((await v.load("rdp", "pc"))?.password).toBe("b");
  });

  test("すべて消すと鍵も無くなり、そのあとも保存できる", async () => {
    const idb = new IDBFactory();
    const v = await open(idb);
    await v.save("amt", "pc", { username: "admin", password: "a" });
    await v.clear();
    expect(await v.load("amt", "pc")).toBeUndefined();
    expect(await raw(idb, "keys")).toEqual([]);
    expect(await raw(idb, "logins")).toEqual([]);
    await v.save("amt", "pc", { username: "admin", password: "b" });
    expect((await v.load("amt", "pc"))?.password).toBe("b");
  });

  test("置いてあるものに平文は無く、鍵は取り出せない", async () => {
    const idb = new IDBFactory();
    const v = await open(idb);
    await v.save("amt", "pc", {
      username: "admin",
      password: "hunter2-secret",
    });
    const [sealed] = (await raw(idb, "logins")) as {
      iv: Uint8Array;
      data: ArrayBuffer;
    }[];
    expect(sealed).toBeDefined();
    expect(Object.keys(sealed as object).sort()).toEqual(["data", "iv"]);
    const bytes = new TextDecoder("latin1").decode(
      new Uint8Array((sealed as { data: ArrayBuffer }).data),
    );
    expect(bytes).not.toContain("hunter2-secret");
    expect(bytes).not.toContain("admin");
    const [key] = (await raw(idb, "keys")) as CryptoKey[];
    expect(key?.extractable).toBe(false);
    expect(key?.algorithm.name).toBe("AES-GCM");
    expect(subtle.exportKey("raw", key as CryptoKey)).rejects.toThrow();
  });

  test("同じものを保存しても、暗号化したものは毎回違う(IV を使い回さない)", async () => {
    const idb = new IDBFactory();
    const v = await open(idb);
    const login = { username: "admin", password: "a" };
    await v.save("amt", "pc", login);
    const [first] = (await raw(idb, "logins")) as { iv: Uint8Array }[];
    await v.save("amt", "pc", login);
    const [second] = (await raw(idb, "logins")) as { iv: Uint8Array }[];
    expect([...(second as { iv: Uint8Array }).iv]).not.toEqual([
      ...(first as { iv: Uint8Array }).iv,
    ]);
  });

  test("ほかの先の中身を持ってきても開かない", async () => {
    const idb = new IDBFactory();
    const v = await open(idb);
    await v.save("amt", "pc", { username: "admin", password: "a" });
    const [sealed] = await raw(idb, "logins");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open("mado-logins");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("logins", "readwrite");
      t.objectStore("logins").put(sealed, "rdp:pc");
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    db.close();
    expect(await v.load("rdp", "pc")).toBeUndefined();
    expect((await v.load("amt", "pc"))?.password).toBe("a");
  });

  test("鍵が無くなったら読めない(例外にしない)。保存し直せる", async () => {
    const idb = new IDBFactory();
    const v = await open(idb);
    await v.save("amt", "pc", { username: "admin", password: "a" });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open("mado-logins");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("keys", "readwrite");
      t.objectStore("keys").clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    db.close();
    expect(await v.load("amt", "pc")).toBeUndefined();
    await v.save("amt", "pc", { username: "admin", password: "b" });
    expect((await v.load("amt", "pc"))?.password).toBe("b");
  });

  test("2 つのタブが同時に初めて保存しても、同じ鍵を使う", async () => {
    const idb = new IDBFactory();
    const a = await open(idb);
    const b = await open(idb);
    await Promise.all([
      a.save("amt", "pc", { username: "admin", password: "a" }),
      b.save("rdp", "pc", { username: "alice", password: "b" }),
    ]);
    expect((await b.load("amt", "pc"))?.password).toBe("a");
    expect((await a.load("rdp", "pc"))?.password).toBe("b");
  });
});

describe("保存が使えない環境", () => {
  test("IndexedDB か WebCrypto が無ければ開かない", async () => {
    expect(await LoginVault.open({ subtle })).toBeUndefined();
    expect(
      await LoginVault.open({ indexedDB: new IDBFactory() }),
    ).toBeUndefined();
    expect(await LoginVault.open({})).toBeUndefined();
  });

  test("IndexedDB を開けなければ開かない(例外にしない)", async () => {
    const failing = {
      open() {
        const r = {} as { onerror?: () => void; error: Error };
        r.error = new Error("SecurityError");
        queueMicrotask(() => r.onerror?.());
        return r;
      },
    } as unknown as IDBFactory;
    expect(
      await LoginVault.open({ indexedDB: failing, subtle }),
    ).toBeUndefined();
    const throwing = {
      open() {
        throw new Error("SecurityError");
      },
    } as unknown as IDBFactory;
    expect(
      await LoginVault.open({ indexedDB: throwing, subtle }),
    ).toBeUndefined();
  });

  test("bun には IndexedDB が無いので、既定では開かない", async () => {
    expect(await LoginVault.open()).toBeUndefined();
  });
});
