import { describe, expect, test } from "bun:test";

import {
  decide,
  fingerprint,
  formatFingerprint,
  parsePins,
  pin,
  serializePins,
} from "./certpin";
import { fromHex } from "./rdp/bytes";
import * as der from "./rdp/der";

describe("RDP サーバーの証明書を覚える", () => {
  test("指紋は大文字の 16 進を : でつなぐ", () => {
    expect(formatFingerprint(Uint8Array.of(0x0a, 0xff, 0x00))).toBe("0A:FF:00");
  });

  test("指紋は DER 全体の SHA-256", async () => {
    // SHA-256("abc")
    expect(await fingerprint(new TextEncoder().encode("abc"))).toBe(
      "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD",
    );
  });

  test("覚えていなければ new、同じなら same、違えば changed", () => {
    expect(decide(undefined, "AA:BB")).toBe("new");
    expect(decide("AA:BB", "AA:BB")).toBe("same");
    // : と大文字小文字の違いは同じとみなす
    expect(decide("aabb", "AA:BB")).toBe("same");
    expect(decide("AA:BB", "AA:BC")).toBe("changed");
    expect(decide("", "AA:BB")).toBe("changed");
  });

  test("つなぐ先ごとに覚え、置き換えられる", () => {
    let p = parsePins(null);
    p = pin(p, "この PC", "AA");
    p = pin(p, "書斎の PC", "BB");
    p = pin(p, "この PC", "CC");
    const back = parsePins(serializePins(p));
    expect(back).toEqual({ "この PC": "CC", "書斎の PC": "BB" });
  });

  test("壊れた中身は空として読み、文字列でない値は捨てる", () => {
    expect(parsePins("{")).toEqual({});
    expect(parsePins("[1]")).toEqual({});
    expect(parsePins("null")).toEqual({});
    expect(parsePins(JSON.stringify({ a: 1, b: "BB" }))).toEqual({ b: "BB" });
  });
});

/** 中身を見るだけの証明書。署名は正しくない */
function cert(o: {
  version?: boolean;
  validity: Uint8Array[];
  cn: Uint8Array;
}): Uint8Array {
  const oid = (hex: string) => der.tlv(0x06, fromHex(hex));
  const name = (value: Uint8Array) =>
    der.tlv(
      der.SEQUENCE,
      der.tlv(
        0x31,
        der.tlv(der.SEQUENCE, oid("550406"), der.tlv(0x13, fromHex("4a50"))),
      ),
      der.tlv(0x31, der.tlv(der.SEQUENCE, oid("550403"), value)),
    );
  const alg = der.tlv(der.SEQUENCE, oid("2a8648ce3d040302"));
  const tbs = der.tlv(
    der.SEQUENCE,
    ...(o.version ? [der.field(0, der.integer(2))] : []),
    der.integer(1),
    alg,
    name(der.utf8("issuer")),
    der.tlv(der.SEQUENCE, ...o.validity),
    name(o.cn),
    der.tlv(der.SEQUENCE, alg, der.tlv(der.BIT_STRING, fromHex("0004"))),
  );
  return der.tlv(
    der.SEQUENCE,
    tbs,
    alg,
    der.tlv(der.BIT_STRING, fromHex("00")),
  );
}

const time = (tag: number, s: string) =>
  der.tlv(tag, new TextEncoder().encode(s));

describe("証明書の名前と有効期間", () => {
  test("Windows の自己署名証明書の形(BMPString の CN、UTCTime)", () => {
    const bmp = (s: string) =>
      der.tlv(
        0x1e,
        Uint8Array.from([...s].flatMap((c) => [0, c.charCodeAt(0)])),
      );
    const info = der.certInfo(
      cert({
        version: true,
        validity: [time(0x17, "260101000000Z"), time(0x17, "260701123000Z")],
        cn: bmp("DESKTOP-1"),
      }),
    );
    expect(info.commonName).toBe("DESKTOP-1");
    expect(info.notBefore?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(info.notAfter?.toISOString()).toBe("2026-07-01T12:30:00.000Z");
  });

  test("UTF8String の CN と GeneralizedTime、版の欄なし。UTCTime の 50 以上は 19xx", () => {
    const info = der.certInfo(
      cert({
        validity: [time(0x17, "991231235959Z"), time(0x18, "20500101000000Z")],
        cn: der.utf8("書斎の PC"),
      }),
    );
    expect(info.commonName).toBe("書斎の PC");
    expect(info.notBefore?.toISOString()).toBe("1999-12-31T23:59:59.000Z");
    expect(info.notAfter?.toISOString()).toBe("2050-01-01T00:00:00.000Z");
  });

  test("読めない証明書は空", () => {
    expect(der.certInfo(fromHex("3003020101"))).toEqual({});
    expect(der.certInfo(fromHex("30"))).toEqual({});
  });
});
