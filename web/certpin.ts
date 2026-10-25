// RDP サーバーの証明書を、つなぐ先ごとに覚えておく(trust on first use)。
// mado は RDP サーバーの証明書を検証せずに中継する(自己署名なので)。そのため mado と RDP サーバーの間に
// 割り込んだ相手がいても、CredSSP はその相手の証明書に結びついて進み、NTLM のやりとりを渡してしまう。
// それを防ぐため、はじめてつなぐ先では証明書の指紋を見せて利用者に決めてもらい、次からは覚えた指紋と比べる。

import { sha256 } from "./rdp/crypto";

/** localStorage の名前。中身は つなぐ先 → SHA-256 の指紋 */
export const CERT_PINS = "mado:certs";

export type Pins = Record<string, string>;

/** 覚えた指紋と今の指紋を比べた結果。new はまだ覚えていない、changed は前と違う */
export type Verdict = "new" | "same" | "changed";

/** 指紋の形。大文字の 16 進を 2 桁ずつ : でつなぐ(AB:CD:…) */
export function formatFingerprint(digest: Uint8Array): string {
  return Array.from(digest, (b) =>
    b.toString(16).toUpperCase().padStart(2, "0"),
  ).join(":");
}

/** 証明書(DER)の SHA-256 の指紋 */
export async function fingerprint(cert: Uint8Array): Promise<string> {
  return formatFingerprint(await sha256(cert));
}

/** 比べるときは : と大文字小文字の違いを無視する */
const normalize = (fp: string) => fp.replaceAll(":", "").toUpperCase();

export function decide(stored: string | undefined, current: string): Verdict {
  if (stored === undefined) return "new";
  return normalize(stored) === normalize(current) ? "same" : "changed";
}

/** 保存した文字列を読む。壊れていたら空、文字列でない値は捨てる */
export function parsePins(text: string | null): Pins {
  try {
    const v = JSON.parse(text ?? "{}") as unknown;
    const pins: Pins = {};
    if (v && typeof v === "object" && !Array.isArray(v))
      for (const [k, fp] of Object.entries(v))
        if (typeof fp === "string") pins[k] = fp;
    return pins;
  } catch {
    return {};
  }
}

export const serializePins = (p: Pins): string => JSON.stringify(p);

/** 信頼した指紋を覚える。前のものがあれば置き換える */
export function pin(p: Pins, target: string, fp: string): Pins {
  return { ...p, [target]: fp };
}
