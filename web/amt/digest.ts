// HTTP Digest 認証(RFC 7616 の MD5、qop=auth)。Intel AMT の WS-Man とリダイレクト(SOL)が使う。
// AMT のパスワードはブラウザの中だけで使い、mado には計算した応答しか送らない。MD5 は WebCrypto に無いので rdp/crypto.ts のものを使う。

import { hex } from "../rdp/bytes";
import { md5, random } from "../rdp/crypto";

const utf8 = new TextEncoder();

export const md5hex = (s: string): string => hex(md5(utf8.encode(s)));

/** WWW-Authenticate の Digest の値 */
export type Challenge = {
  realm: string;
  nonce: string;
  /** サーバーが出した qop の並び。auth があれば使う */
  qop?: string;
  opaque?: string;
  algorithm?: string;
  stale?: boolean;
};

/** `Digest k=v, k="v"` の k と v を読む(WWW-Authenticate と Authorization で同じ形)。Digest でなければ undefined */
export function parseDigestParams(
  header: string,
): Record<string, string> | undefined {
  const m = /(?:^|,\s*)Digest\s+(.*)$/i.exec(header.trim());
  if (!m) return undefined;
  const params: Record<string, string> = {};
  // key=token か key="quoted"(\ で次の文字をそのまま)
  const re = /([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))\s*(?:,|$)/g;
  const text = m[1] as string;
  for (let p = re.exec(text); p; p = re.exec(text)) {
    const key = (p[1] as string).toLowerCase();
    params[key] =
      p[2] !== undefined ? p[2].replace(/\\(.)/g, "$1") : (p[3] ?? "");
  }
  return params;
}

/** `Digest realm="...", nonce="...", qop="auth"` を読む。Digest でなければ undefined */
export function parseChallenge(header: string): Challenge | undefined {
  const params = parseDigestParams(header);
  if (params?.realm === undefined || params.nonce === undefined)
    return undefined;
  return {
    realm: params.realm,
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: params.algorithm,
    stale: params.stale?.toLowerCase() === "true",
  };
}

/** qop の並びに auth があるか */
export const hasAuthQop = (qop?: string): boolean =>
  qop?.split(",").some((q) => q.trim() === "auth") ?? false;

/** Digest の response。qop が無ければ RFC 2069 の形 */
export function digestResponse(p: {
  username: string;
  password: string;
  realm: string;
  nonce: string;
  method: string;
  uri: string;
  qop?: string;
  nc?: string;
  cnonce?: string;
}): string {
  const ha1 = md5hex(`${p.username}:${p.realm}:${p.password}`);
  const ha2 = md5hex(`${p.method}:${p.uri}`);
  return p.qop
    ? md5hex(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`)
    : md5hex(`${ha1}:${p.nonce}:${ha2}`);
}

/** 16 進の cnonce */
export const newCnonce = (): string => hex(random(16));

const quote = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;

/** Authorization の値を作る。nc は同じ nonce で使った回数(1 から) */
export function authorization(
  ch: Challenge,
  username: string,
  password: string,
  method: string,
  uri: string,
  nc: number,
  cnonce: string = newCnonce(),
): string {
  if (ch.algorithm && ch.algorithm.toUpperCase() !== "MD5")
    throw new Error(`Digest の algorithm ${ch.algorithm} には対応していない`);
  const qop = hasAuthQop(ch.qop) ? "auth" : undefined;
  const ncs = nc.toString(16).padStart(8, "0");
  const response = digestResponse({
    username,
    password,
    realm: ch.realm,
    nonce: ch.nonce,
    method,
    uri,
    qop,
    nc: ncs,
    cnonce,
  });
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(ch.realm)}`,
    `nonce=${quote(ch.nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
  ];
  if (ch.algorithm) parts.push(`algorithm=${ch.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncs}`, `cnonce=${quote(cnonce)}`);
  if (ch.opaque !== undefined) parts.push(`opaque=${quote(ch.opaque)}`);
  return `Digest ${parts.join(", ")}`;
}
