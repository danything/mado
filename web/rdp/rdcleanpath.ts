// RDCleanPath。形は server/RdCleanPath.cs と同じ。最初に X.224 の接続要求を包んで送る。
// mado が RDP サーバーと TLS まで張ると、X.224 の接続確認とサーバーの証明書チェーンが返ってくる。

import * as der from "./der";
import type { ByteStream } from "./stream";
import { failureMessage, parseConnectionConfirm } from "./x224";

const VERSION = 3390;

export function request(
  x224: Uint8Array,
  token: string,
  destination: string,
): Uint8Array {
  return der.tlv(
    der.SEQUENCE,
    der.field(0, der.integer(VERSION)),
    der.field(2, der.utf8(destination)),
    der.field(3, der.utf8(token)),
    der.field(6, der.octets(x224)),
  );
}

export type Response = { x224: Uint8Array; certChain: Uint8Array[] };

/** X.224 の接続確認に RDP_NEG_FAILURE があれば、その理由を返す */
function negotiationFailure(raw: Uint8Array | undefined): string {
  try {
    const cc = raw && parseConnectionConfirm(raw);
    if (cc && !cc.ok) return failureMessage(cc.failureCode);
  } catch {}
  return "RDP サーバーが接続を断った(ネゴシエーション)";
}

/** 応答を 1 つ、DER の長さで切り出して読む */
export async function readResponse(s: ByteStream): Promise<Response> {
  const raw = await der.readFrom(s, 1 << 20, "RDCleanPath: 応答が大きすぎる");
  const f = der.fields(der.mustRead(raw).value);
  const x224 = f.get(6)?.value;
  const err = f.get(1);
  if (err) {
    const e = der.fields(err.value);
    const code = e.get(0) ? der.readInteger(e.get(0) as der.Tlv) : 0;
    const http = e.get(1) ? der.readInteger(e.get(1) as der.Tlv) : undefined;
    const what =
      code === 2
        ? negotiationFailure(x224)
        : http === 401
          ? "中継の許可が切れた(ページを読み込み直す)"
          : http === 502
            ? "RDP サーバーにつなげなかった"
            : `中継の失敗 (${code}${http ? `/${http}` : ""})`;
    throw new Error(what);
  }
  const chain = f.get(7);
  if (!x224 || !chain) throw new Error("RDCleanPath: 応答が足りない");
  return {
    x224,
    certChain: der.readAll(chain.value).map((t) => t.value),
  };
}
