import { describe, expect, test } from "bun:test";

import { FAKE, FakeWsman, pipe, serveRedirect } from "./amt.fixture";
import { AmtAuthError, LoginRequired, WsmanClient } from "./client";
import {
  authorization,
  digestResponse,
  md5hex,
  parseChallenge,
  parseDigestParams,
} from "./digest";
import {
  AUTH,
  digestAnswer,
  digestHello,
  MSG,
  RedirectAuthError,
  SolSession,
} from "./redirect";
import { powerButtons } from "./view";
import {
  element,
  enumerate,
  fault,
  parsePower,
  powerStateName,
  pull,
  requestPowerStateChange,
  RESOURCE,
} from "./wsman";

describe("Digest", () => {
  test("MD5 の既知の値", () => {
    expect(md5hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5hex("The quick brown fox jumps over the lazy dog")).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });

  test("RFC 2617 の例と同じ応答になる", () => {
    expect(
      digestResponse({
        username: "Mufasa",
        password: "Circle Of Life",
        realm: "testrealm@host.com",
        nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
        method: "GET",
        uri: "/dir/index.html",
        qop: "auth",
        nc: "00000001",
        cnonce: "0a4f113b",
      }),
    ).toBe("6629fae49393a05397450978507c4ef1");
  });

  test("WWW-Authenticate を読む", () => {
    const c = parseChallenge(
      'Digest realm="Digest:ABC", nonce="n\\"1", stale="false", qop="auth,auth-int", opaque=xyz',
    );
    expect(c).toEqual({
      realm: "Digest:ABC",
      nonce: 'n"1',
      qop: "auth,auth-int",
      opaque: "xyz",
      algorithm: undefined,
      stale: false,
    });
    expect(parseChallenge('Basic realm="x"')).toBeUndefined();
  });

  test("Authorization に要るものが揃い、送り先の検証と同じ応答になる", () => {
    const ch = { realm: "Digest:ABC", nonce: "abc", qop: "auth", opaque: "o" };
    const h = authorization(ch, "admin", "pw", "POST", "/wsman", 2, "cn");
    const p = parseDigestParams(h);
    expect(p).toMatchObject({
      username: "admin",
      realm: "Digest:ABC",
      nonce: "abc",
      uri: "/wsman",
      qop: "auth",
      nc: "00000002",
      cnonce: "cn",
      opaque: "o",
    });
    expect(p?.response).toBe(
      digestResponse({
        username: "admin",
        password: "pw",
        realm: "Digest:ABC",
        nonce: "abc",
        method: "POST",
        uri: "/wsman",
        qop: "auth",
        nc: "00000002",
        cnonce: "cn",
      }),
    );
    // パスワードそのものは入らない
    expect(h).not.toContain('pw"');
  });
});

describe("WS-Man の封筒", () => {
  test("列挙と Pull", () => {
    const e = enumerate(RESOURCE.associatedPower, "uuid:1");
    expect(e).toContain(
      '<a:Action s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/09/enumeration/Enumerate</a:Action>',
    );
    expect(e).toContain('<a:To s:mustUnderstand="true">/wsman</a:To>');
    expect(e).toContain(
      `<w:ResourceURI s:mustUnderstand="true">${RESOURCE.associatedPower}</w:ResourceURI>`,
    );
    expect(e).toContain(
      '<a:MessageID s:mustUnderstand="true">uuid:1</a:MessageID>',
    );
    const p = pull(RESOURCE.associatedPower, "a<b");
    expect(p).toContain("<EnumerationContext>a&lt;b</EnumerationContext>");
  });

  test("電源の操作は PowerManagementService の決まった selector と PowerState", () => {
    const x = requestPowerStateChange(10);
    expect(x).toContain(
      "http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_PowerManagementService/RequestPowerStateChange",
    );
    expect(x).toContain(
      '<w:Selector Name="Name">Intel(r) AMT Power Management Service</w:Selector>',
    );
    expect(x).toContain("<r:PowerState>10</r:PowerState>");
    expect(x).toContain('<Selector Name="Name">ManagedSystem</Selector>');
  });

  test("返事から電源の状態を拾う(RequestedPowerState とは区別する)", () => {
    const wsman = new FakeWsman();
    wsman.powerState = 8;
    const xml = wsman["soap"](pull(RESOURCE.associatedPower, "ctx-1"));
    expect(parsePower(xml)).toEqual({ state: 8, available: [2] });
    expect(powerStateName(8)).toBe("オフ(S5)");
    expect(element(xml, "EnumerationContext")).toBeUndefined();
  });

  test("Fault の理由を拾う", () => {
    const xml =
      '<a:Envelope><a:Body><a:Fault><a:Code><a:Value>a:Sender</a:Value></a:Code><a:Reason><a:Text xml:lang="en-US">Bad &amp; wrong</a:Text></a:Reason></a:Fault></a:Body></a:Envelope>';
    expect(fault(xml)).toBe("Bad & wrong");
    expect(fault("<a:Body><x/></a:Body>")).toBeUndefined();
  });

  test("出す電源の操作は AMT が頼めるものに従う", () => {
    const on = powerButtons({ state: 2, available: [5, 8, 10, 12] });
    expect(on.filter((b) => b.enabled).map((b) => b.action.value)).toEqual([
      12, 10, 5, 8,
    ]);
    // 14 は AMT が挙げていないので出さない
    expect(on.some((b) => b.action.value === 14)).toBe(false);
    // 挙げていなければ、今の状態で決める
    const off = powerButtons({ state: 8, available: [] });
    expect(off.filter((b) => b.enabled).map((b) => b.action.value)).toEqual([
      2,
    ]);
  });
});

/** mado の /api/amt/<name>/wsman と同じに、WWW-Authenticate を x-amt-authenticate に移す */
function viaMado(amt: FakeWsman, seen: string[] = []) {
  return async (url: string, init: RequestInit) => {
    seen.push(url);
    const headers = init.headers as Record<string, string>;
    const r = amt.handle({
      authorization: headers.authorization,
      body: String(init.body),
    });
    return new Response(r.body, {
      status: r.status,
      headers: r.authenticate ? { "x-amt-authenticate": r.authenticate } : {},
    });
  };
}

describe("WS-Man のクライアント", () => {
  test("Digest で状態を読み、電源を操作する", async () => {
    const amt = new FakeWsman();
    const urls: string[] = [];
    const c = new WsmanClient(
      "Z440 の AMT",
      FAKE.username,
      FAKE.password,
      viaMado(amt, urls),
    );
    expect(await c.power()).toEqual({ state: 2, available: [5, 8, 10] });
    expect(await c.changePower(8)).toBe(0);
    expect(amt.requests).toEqual([8]);
    expect((await c.power()).state).toBe(8);
    expect(urls[0]).toBe("/api/amt/Z440%20%E3%81%AE%20AMT/wsman");
    // 1 回目だけ 401 を受け、あとは同じ nonce で nc を増やして送る
    expect(amt.authorizations.length).toBe(5);
    expect(amt.authorizations.every((a) => !a.includes(FAKE.password))).toBe(
      true,
    );
  });

  test("nonce が切れたら 1 度だけ取り直す", async () => {
    const amt = new FakeWsman();
    const c = new WsmanClient("z", FAKE.username, FAKE.password, viaMado(amt));
    await c.power();
    amt.expireNonce();
    expect((await c.power()).state).toBe(2);
  });

  test("パスワードが違えば 2 度目で諦める", async () => {
    const amt = new FakeWsman();
    let calls = 0;
    const f = viaMado(amt);
    const c = new WsmanClient("z", FAKE.username, "wrong", (u, i) => {
      calls++;
      return f(u, i);
    });
    await expect(c.power()).rejects.toBeInstanceOf(AmtAuthError);
    expect(calls).toBe(2);
  });

  test("mado のログインが切れていれば LoginRequired", async () => {
    const c = new WsmanClient("z", "a", "b", async () =>
      Response.json({ login: "/login?to=/" }, { status: 401 }),
    );
    await expect(c.power()).rejects.toBeInstanceOf(LoginRequired);
  });
});

describe("リダイレクト(SOL)", () => {
  test("Digest の 1 回目と応答の形", () => {
    const h = digestHello("admin", AUTH.digest);
    // 0x13、種類 4、長さ = ユーザー名 + uri + 8
    expect([...h.subarray(0, 5)]).toEqual([MSG.authenticate, 0, 0, 0, 4]);
    expect(new DataView(h.buffer).getUint32(5, true)).toBe(
      5 + "/RedirectionService".length + 8,
    );
    const a = digestAnswer(
      "admin",
      "pw",
      { realm: "R", nonce: "N", qop: "auth" },
      AUTH.digest,
      "C",
    );
    const len = new DataView(a.buffer).getUint32(5, true);
    expect(a.length).toBe(9 + len);
    const response = digestResponse({
      username: "admin",
      password: "pw",
      realm: "R",
      nonce: "N",
      method: "POST",
      uri: "/RedirectionService",
      qop: "auth",
      nc: "00000002",
      cnonce: "C",
    });
    expect(new TextDecoder().decode(a)).toContain(response);
    expect(new TextDecoder().decode(a)).not.toContain("pw");
  });

  test("認証して SOL を開き、出力と入力が通り、閉じると終わりを伝える", async () => {
    const [client, server] = pipe();
    const amt = serveRedirect(server, { banner: "Talos\r\n" });
    const sol = await SolSession.start(client, {
      username: FAKE.username,
      password: FAKE.password,
      heartbeatMs: 10,
    });
    const got: string[] = [];
    let wake = () => {};
    sol.onData = (b) => {
      got.push(new TextDecoder().decode(b));
      wake();
    };
    const until = async (s: string) => {
      while (!got.join("").includes(s))
        await new Promise<void>((r) => {
          wake = r;
        });
    };
    await until("Talos\r\n");
    sol.send(new TextEncoder().encode("help\r"));
    await until("HELP\r");
    // 生存確認が何度か流れても壊れない
    await new Promise((r) => setTimeout(r, 50));
    sol.close();
    expect(await amt).toBe("ended");
    expect(await sol.done).toBeString();
  });

  test("パスワードが違えば RedirectAuthError", async () => {
    const [client, server] = pipe();
    const amt = serveRedirect(server);
    await expect(
      SolSession.start(client, { username: FAKE.username, password: "x" }),
    ).rejects.toBeInstanceOf(RedirectAuthError);
    expect(await amt).toBe("auth-failed");
  });
});
