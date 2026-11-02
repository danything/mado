// mado の /api/amt/<name>/wsman を通して、AMT の WS-Man を Digest 認証で呼ぶ。
// Digest の応答はここで計算する。mado は Authorization をそのまま AMT に渡し、AMT の WWW-Authenticate を x-amt-authenticate で返す
// (WWW-Authenticate のまま 401 を返すと、ブラウザが自分のログインの窓を出すため)。

import { authorization, type Challenge, parseChallenge } from "./digest";
import {
  element,
  enumerate,
  fault,
  parsePower,
  type PowerInfo,
  pull,
  requestPowerStateChange,
  RESOURCE,
} from "./wsman";

/** AMT がユーザー名かパスワードを受け付けなかった */
export class AmtAuthError extends Error {}

/** mado のログインが切れた */
export class LoginRequired extends Error {}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** AMT の Digest で使う uri。mado はこの道にしか送らない */
export const WSMAN_URI = "/wsman";

export class WsmanClient {
  private challenge?: Challenge;
  private nc = 0;

  constructor(
    private readonly target: string,
    private readonly username: string,
    private readonly password: string,
    private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
  ) {}

  get url(): string {
    return `/api/amt/${encodeURIComponent(this.target)}/wsman`;
  }

  /** SOAP を送って返事の XML を返す。Digest の challenge が無いか古ければ、受け取ってもう一度送る */
  async call(body: string): Promise<string> {
    let retried = false;
    for (;;) {
      const headers: Record<string, string> = {
        "content-type": "application/soap+xml; charset=utf-8",
      };
      if (this.challenge) {
        this.nc++;
        headers.authorization = authorization(
          this.challenge,
          this.username,
          this.password,
          "POST",
          WSMAN_URI,
          this.nc,
        );
      }
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body,
        credentials: "same-origin",
        cache: "no-store",
      });
      const amtAuth = res.headers.get("x-amt-authenticate");
      if (res.status === 401 && !amtAuth)
        throw new LoginRequired("mado のログインが切れました");
      if (res.status === 401) {
        const next = parseChallenge(amtAuth as string);
        if (!next) throw new Error("AMT の Digest の challenge を読めません");
        // 認証を付けずに受けた 401 と、前の nonce を使い回して断られた 401 は、新しい challenge で 1 度だけ送り直す。
        // 送り直しても断られたら、ユーザー名かパスワードが違う(AMT は続けて間違えると締め出すので、それ以上は試さない)
        this.challenge = next;
        this.nc = 0;
        if (retried) {
          this.challenge = undefined;
          throw new AmtAuthError("AMT のユーザー名かパスワードが違います");
        }
        retried = true;
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        const f = fault(text);
        throw new Error(
          f
            ? `AMT: ${f}`
            : `AMT の WS-Man がエラーを返しました(${res.status}): ${text.slice(0, 200)}`,
        );
      }
      const f = fault(text);
      if (f) throw new Error(`AMT: ${f}`);
      return text;
    }
  }

  /** 今の電源の状態と、頼める操作 */
  async power(): Promise<PowerInfo> {
    const first = await this.call(enumerate(RESOURCE.associatedPower));
    const ctx = element(first, "EnumerationContext");
    if (!ctx)
      throw new Error("AMT の列挙の返事に EnumerationContext がありません");
    return parsePower(await this.call(pull(RESOURCE.associatedPower, ctx)));
  }

  /** 電源を操作する。返事の ReturnValue(0 が受け付けた) */
  async changePower(state: number): Promise<number | undefined> {
    const xml = await this.call(requestPowerStateChange(state));
    const v = element(xml, "ReturnValue");
    return v === undefined ? undefined : Number(v);
  }
}
