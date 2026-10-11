import { expect, test } from "bun:test";
import {
	integer,
	octets,
	oid,
	readAll,
	readTlv,
	Tag,
	tlv,
	utf8,
} from "../src/der.ts";
import {
	encodeError,
	encodeResponse,
	parseRequest,
	VERSION,
} from "../src/rdcleanpath.ts";

const field = (n: number, v: Uint8Array) => tlv(Tag.context(n), v);

/** IronRDP が送ってくる形の要求(version / destination / proxy_auth / x224) */
function request(x224: Uint8Array) {
	return tlv(
		Tag.Sequence,
		field(0, integer(VERSION)),
		field(2, utf8("mado")),
		field(3, utf8("token")),
		field(6, octets(x224)),
	);
}

test("要求を読む", () => {
	const x224 = Uint8Array.from({ length: 19 }, (_, i) => i);
	const parsed = parseRequest(request(x224));
	expect(parsed?.request).toEqual({
		version: VERSION,
		destination: "mado",
		proxyAuth: "token",
		x224,
	});
	expect(parsed?.rest.length).toBe(0);
});

test("分かれて届いたら、揃うまで null", () => {
	const whole = request(new Uint8Array(19));
	for (let i = 0; i < whole.length; i++)
		expect(parseRequest(whole.subarray(0, i))).toBeNull();
	expect(parseRequest(whole)).not.toBeNull();
});

test("後ろに続きがあれば rest に残す", () => {
	const whole = request(new Uint8Array(3));
	const parsed = parseRequest(Uint8Array.from([...whole, 9, 9]));
	expect([...(parsed?.rest ?? [])]).toEqual([9, 9]);
});

test("応答: 長い証明書でも長さを長形式で書く", () => {
	const cert = new Uint8Array(1500).fill(7);
	const out = encodeResponse(new Uint8Array(19), [cert], "127.0.0.1:3389");
	const outer = readTlv(out);
	expect(outer?.tag).toBe(Tag.Sequence);
	expect(outer?.end).toBe(out.length);
	const tags = readAll(outer?.value as Uint8Array).map((t) => t.tag);
	expect(tags).toEqual([
		Tag.context(0),
		Tag.context(6),
		Tag.context(7),
		Tag.context(9),
	]);
});

test("エラー: [1] に RDCleanPathErr", () => {
	const out = encodeError({ code: 1, httpStatus: 401 });
	const fields = readAll(readTlv(out)?.value as Uint8Array);
	expect(fields.map((f) => f.tag)).toEqual([Tag.context(0), Tag.context(1)]);
});

test("INTEGER は最小の長さで、先頭が 0x80 以上なら 0x00 を足す", () => {
	expect([...integer(VERSION)]).toEqual([0x02, 0x02, 0x0d, 0x3e]);
	expect([...integer(0x80)]).toEqual([0x02, 0x02, 0x00, 0x80]);
	expect([...integer(0)]).toEqual([0x02, 0x01, 0x00]);
});

test("OID", () => {
	// ecdsa-with-SHA256
	expect(Buffer.from(oid("1.2.840.10045.4.3.2")).toString("hex")).toBe(
		"06082a8648ce3d040302",
	);
});
