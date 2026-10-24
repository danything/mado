import { describe, expect, test } from "bun:test";

import { parseRemembered, remember, usernameFor } from "./remember";

describe("つなぐ前の画面で覚えるもの", () => {
  test("つなぐ先ごとにユーザー名を覚える", () => {
    let r = parseRemembered(null);
    r = remember(r, "この PC", "alice");
    r = remember(r, "書斎の PC", "bob");
    const back = parseRemembered(JSON.stringify(r));
    expect(back.target).toBe("書斎の PC");
    expect(usernameFor(back, "この PC")).toBe("alice");
    expect(usernameFor(back, "書斎の PC")).toBe("bob");
    // まだ使っていないつなぐ先には、最後に使ったものを入れる
    expect(usernameFor(back, "会議室の PC")).toBe("bob");
  });

  test("前の形(ユーザー名が 1 つ)も読める。つなぐ先ごとのものが優先", () => {
    const old = parseRemembered(
      JSON.stringify({ target: "この PC", username: "alice" }),
    );
    expect(usernameFor(old, "書斎の PC")).toBe("alice");
    const r = remember(old, "書斎の PC", "bob");
    expect(usernameFor(r, "書斎の PC")).toBe("bob");
    expect(usernameFor(r, "この PC")).toBe("bob");
  });

  test("壊れた中身は空として読む", () => {
    expect(parseRemembered("{")).toEqual({ usernames: {} });
    expect(
      parseRemembered(JSON.stringify({ usernames: { a: 1 } })).usernames,
    ).toEqual({});
  });
});
