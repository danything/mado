// 暗号と NTLM の試験。値は RFC 1320 / 1321 / 2202 / 6229 と [MS-NLMP] 4.2 の試験値。
// 実行: bun test

import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";

import { fromHex, hex, Writer } from "./bytes";
import { hmacMd5, md4, md5, Rc4 } from "./crypto";
import { identity, Ntlm, ntowfv2, parseChallenge } from "./ntlm";

const text = (s: string) => new TextEncoder().encode(s);

describe("crypto", () => {
  test("MD4 (RFC 1320)", () => {
    expect(hex(md4(text("")))).toBe("31d6cfe0d16ae931b73c59d7e0c089c0");
    expect(hex(md4(text("abc")))).toBe("a448017aaf21d8525fc10ae87aa6729d");
    expect(
      hex(
        md4(
          text(
            "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
          ),
        ),
      ),
    ).toBe("e33b4ddc9c38f2199c3e7b164fcc0536");
  });

  test("MD5 (RFC 1321)", () => {
    expect(hex(md5(text("")))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(hex(md5(text("abc")))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(
      hex(
        md5(
          text(
            "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
          ),
        ),
      ),
    ).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  test("HMAC-MD5 (RFC 2202)", () => {
    expect(hex(hmacMd5(new Uint8Array(16).fill(0x0b), text("Hi There")))).toBe(
      "9294727a3638bb1c13f48ef8158bfc9d",
    );
    expect(
      hex(hmacMd5(text("Jefe"), text("what do ya want for nothing?"))),
    ).toBe("750c783e6ab0b503eaa86e310a5db738");
    // 鍵が 64 バイトより長い
    expect(
      hex(
        hmacMd5(
          new Uint8Array(80).fill(0xaa),
          text("Test Using Larger Than Block-Size Key - Hash Key First"),
        ),
      ),
    ).toBe("6b1ab7fe4bd7bf8f0b62e6ce61b9d0cd");
  });

  test("RC4 (RFC 6229 風の定番値)", () => {
    expect(hex(new Rc4(text("Key")).apply(text("Plaintext")))).toBe(
      "bbf316e8d940af0ad3",
    );
    // 状態を持ち越す: 2 回に分けても 1 回と同じ
    const a = new Rc4(text("Secret"));
    const whole = new Rc4(text("Secret")).apply(text("Attack at dawn"));
    const parts = [...a.apply(text("Attack ")), ...a.apply(text("at dawn"))];
    expect(hex(Uint8Array.from(parts))).toBe(hex(whole));
  });

  test("node:crypto と突き合わせる(長さを振る)", () => {
    for (let n = 0; n < 200; n += 7) {
      const data = crypto.getRandomValues(new Uint8Array(n));
      const key = crypto.getRandomValues(new Uint8Array(1 + (n % 100)));
      expect(hex(md5(data))).toBe(createHash("md5").update(data).digest("hex"));
      expect(hex(hmacMd5(key, data))).toBe(
        createHmac("md5", key).update(data).digest("hex"),
      );
    }
  });
});

/** [MS-NLMP] 4.2.4 の CHALLENGE の代わり。TargetInfo は NbDomainName "Domain" と NbComputerName "Server" */
function spec424Challenge(): Uint8Array {
  const av = (id: number, s: string) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) b[i * 2] = s.charCodeAt(i);
    return new Writer().u16(id).u16(b.length).bytes(b).done();
  };
  const info = new Writer()
    .bytes(av(2, "Domain"))
    .bytes(av(1, "Server"))
    .u16(0)
    .u16(0)
    .done();
  const flags = 0xe2898235 >>> 0; // 4.2.4.2.1 と同じ系(KEY_EXCH・128・56・拡張セッション セキュリティ)
  return new Writer()
    .bytes(text("NTLMSSP\0"))
    .u32(2)
    .zeros(8)
    .u32(flags)
    .bytes(fromHex("0123456789abcdef"))
    .zeros(8)
    .u16(info.length)
    .u16(info.length)
    .u32(56)
    .zeros(8)
    .bytes(info)
    .done();
}

describe("NTLMv2", () => {
  const id = identity("Domain\\User", "Password");

  test("identity", () => {
    expect(id).toEqual({
      domain: "Domain",
      user: "User",
      password: "Password",
    });
    expect(identity("a@b.c", "x")).toEqual({
      domain: "",
      user: "a@b.c",
      password: "x",
    });
  });

  test("NTOWFv2 ([MS-NLMP] 4.2.4.1.1)", () => {
    expect(hex(ntowfv2(id))).toBe("0c868a403bfd7a93a3001ef22ef02e3f");
  });

  test("CHALLENGE を読む", () => {
    const c = parseChallenge(spec424Challenge());
    expect(hex(c.serverChallenge)).toBe("0123456789abcdef");
    expect(c.targetInfo.length).toBe(36);
  });

  test("AUTHENTICATE の NTProofStr と暗号化したセッション鍵 ([MS-NLMP] 4.2.4.2)", () => {
    const ntlm = new Ntlm(id, {
      clientChallenge: new Uint8Array(8).fill(0xaa),
      sessionKey: new Uint8Array(16).fill(0x55),
      now: 0n,
    });
    const msg = ntlm.authenticate(spec424Challenge());
    const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    const field = (at: number) => {
      const len = dv.getUint16(at, true);
      const off = dv.getUint32(at + 4, true);
      return msg.subarray(off, off + len);
    };
    const nt = field(20);
    expect(hex(nt.subarray(0, 16))).toBe("68cd0ab851e51c96aabc927bebef6a1c");
    // KeyExchangeKey = SessionBaseKey(NTLMv2)。RC4(KXKEY, 55*16)
    expect(hex(field(52))).toBe("c5dad2544fc9799094ce1ce90bc9d03e");
  });

  test("seal は 16 バイトの署名を付け、続き番号が進む", () => {
    const a = new Ntlm(id, { sessionKey: new Uint8Array(16).fill(1), now: 0n });
    a.authenticate(spec424Challenge());
    const sealed = a.seal(text("hello"));
    expect(sealed.length).toBe(16 + 5);
    // 2 つ目は続き番号が進む
    expect(new DataView(a.seal(text("x")).buffer).getUint32(12, true)).toBe(1);
  });
});
