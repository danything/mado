// mado の /api/amt/<name>/wsman を通して、AMT の WS-Man を Digest 認証で呼ぶ。
// Digest の応答はここで計算する。mado は Authorization をそのまま AMT に渡し、AMT の WWW-Authenticate を x-amt-authenticate で返す
// (WWW-Authenticate のまま 401 を返すと、ブラウザが自分のログインの窓を出すため)。

import { authorization, type Challenge, parseChallenge } from "./digest";
import {
  clearBootOrder,
  element,
  enumerate,
  fault,
  getBootSettings,
  getRedirection,
  isOn,
  parsePower,
  parseRedirection,
  type PowerInfo,
  pull,
  putBootSettingsForIder,
  putRedirectionListener,
  REDIRECTION_BOTH,
  type RedirectionInfo,
  requestPowerStateChange,
  requestRedirectionState,
  RESOURCE,
  setBootConfigRole,
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

  /**
   * 次の起動を IDE-R の CD からにして、電源を入れる(入っていればリセットする)。
   * 手順は MeshCentral と同じ: AMT_BootSettingData を読んで UseIDER を立てて書き戻す → SetBootConfigRole → 起動の順を空に → 電源。
   * どれも AMT 9 にある操作。IDE-R のセッションは先に開いておく(view.ts)
   */
  async bootFromIder(): Promise<{ state: number; result?: number }> {
    const settings = await this.call(getBootSettings());
    await this.expectZero(
      await this.call(putBootSettingsForIder(settings)),
      "起動の設定(AMT_BootSettingData)",
      false,
    );
    await this.expectZero(
      await this.call(setBootConfigRole()),
      "SetBootConfigRole",
    );
    await this.expectZero(await this.call(clearBootOrder()), "ChangeBootOrder");
    const state = isOn((await this.power()).state) ? 10 : 2;
    return { state, result: await this.changePower(state) };
  }

  /** ReturnValue が 0 でなければ例外。Put の返事は ReturnValue を持たないので、needValue が false なら無くてよい */
  private async expectZero(
    xml: string,
    what: string,
    needValue = true,
  ): Promise<void> {
    const v = element(xml, "ReturnValue");
    if (v === undefined ? needValue : Number(v) !== 0)
      throw new Error(
        `AMT: ${what} に失敗しました(ReturnValue ${v ?? "なし"})`,
      );
  }

  /** リダイレクト(SOL・IDE-R)の受け口と、SOL・IDE-R が有効か */
  async redirection(): Promise<RedirectionInfo> {
    return parseRedirection(await this.call(getRedirection()));
  }

  /**
   * SOL と IDE-R を有効にし、受け口(16994 / 16995)を開く。
   * EnabledState が両方有効(32771)でなければ RequestStateChange、ListenerEnabled が false なら読み直して Put
   */
  async enableRedirection(): Promise<RedirectionInfo> {
    let info = await this.redirection();
    if (info.state !== REDIRECTION_BOTH)
      await this.expectZero(
        await this.call(requestRedirectionState(REDIRECTION_BOTH)),
        "SOL・IDE-R の有効化(RequestStateChange)",
      );
    if (!info.listener) {
      const current = await this.call(getRedirection());
      await this.call(putRedirectionListener(current));
    }
    info = await this.redirection();
    if (!info.listener || !info.sol || !info.ider)
      throw new Error(
        "AMT が SOL・IDE-R を有効にしませんでした。MEBx で有効にしてください",
      );
    return info;
  }
}
