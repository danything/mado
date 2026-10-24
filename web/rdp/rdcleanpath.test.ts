// RDCleanPath の応答の読み取りと、エラーの伝え方の試験。

import { describe, expect, test } from "bun:test";
import { concat, fromHex } from "./bytes";
import * as der from "./der";
import { readResponse } from "./rdcleanpath";
import type { WsStream } from "./stream";

function streamOf(b: Uint8Array): WsStream {
  let rest = b;
  return {
    async peek(n: number) {
      return rest.subarray(0, n);
    },
    async read(n: number) {
      const o = rest.subarray(0, n);
      rest = rest.subarray(n);
      return o;
    },
  } as unknown as WsStream;
}

const error = (code: number, http?: number, x224?: Uint8Array) =>
  der.tlv(
    der.SEQUENCE,
    der.field(0, der.integer(3390)),
    der.field(
      1,
      der.tlv(
        der.SEQUENCE,
        der.field(0, der.integer(code)),
        ...(http ? [der.field(1, der.integer(http))] : []),
      ),
    ),
    ...(x224 ? [der.field(6, der.octets(x224))] : []),
  );

describe("RDCleanPath の応答", () => {
  test("ネゴシエーションの失敗は、X.224 の理由を言う", async () => {
    // RDP_NEG_FAILURE: SSL_REQUIRED_BY_SERVER(1)
    const x224 = fromHex("030000130ed000001234000301080001000000");
    await expect(
      readResponse(streamOf(error(2, undefined, x224))),
    ).rejects.toThrow("TLS を要求");
  });

  test("理由が読めなければ、ネゴシエーションの失敗と言う", async () => {
    await expect(readResponse(streamOf(error(2)))).rejects.toThrow(
      "ネゴシエーション",
    );
  });

  test("401 と 502", async () => {
    await expect(readResponse(streamOf(error(1, 401)))).rejects.toThrow(
      "許可が切れた",
    );
    await expect(readResponse(streamOf(error(1, 502)))).rejects.toThrow(
      "つなげなかった",
    );
  });

  test("成功: X.224 と証明書の鎖", async () => {
    const ok = der.tlv(
      der.SEQUENCE,
      der.field(0, der.integer(3390)),
      der.field(6, der.octets(Uint8Array.of(1, 2))),
      der.field(
        7,
        der.tlv(
          der.SEQUENCE,
          der.octets(Uint8Array.of(9)),
          der.octets(Uint8Array.of(8)),
        ),
      ),
    );
    const r = await readResponse(streamOf(concat(ok)));
    expect([...r.x224]).toEqual([1, 2]);
    expect(r.certChain.map((c) => [...c])).toEqual([[9], [8]]);
  });
});
