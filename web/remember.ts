// つなぐ前の画面で覚えておくもの。前回のつなぐ先と、つなぐ先ごとのユーザー名。パスワードは覚えない。

export type Remembered = {
  target?: string;
  /** つなぐ先 → ユーザー名 */
  usernames: Record<string, string>;
  /** 最後に使ったユーザー名。まだ使っていないつなぐ先では、これを入れておく */
  username?: string;
};

/** 保存した文字列を読む。壊れていたら空 */
export function parseRemembered(text: string | null): Remembered {
  try {
    const v = JSON.parse(text ?? "{}") as Partial<Remembered>;
    const usernames: Record<string, string> = {};
    if (v.usernames && typeof v.usernames === "object")
      for (const [k, u] of Object.entries(v.usernames))
        if (typeof u === "string") usernames[k] = u;
    return {
      target: typeof v.target === "string" ? v.target : undefined,
      usernames,
      username: typeof v.username === "string" ? v.username : undefined,
    };
  } catch {
    return { usernames: {} };
  }
}

/** そのつなぐ先で前に使ったユーザー名。無ければ最後に使ったもの */
export function usernameFor(r: Remembered, target: string): string | undefined {
  return r.usernames[target] ?? r.username;
}

/** つないだときに覚え直す */
export function remember(
  r: Remembered,
  target: string,
  username: string,
): Remembered {
  return {
    target,
    usernames: { ...r.usernames, [target]: username },
    username,
  };
}
