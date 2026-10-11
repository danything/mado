// NTLM に要る暗号のうち、WebCrypto に無いもの(MD4・MD5・RC4・HMAC-MD5)。どれも NTLM が決めた古い形で、ここ以外には使わない。

function rotl(x: number, n: number): number {
	return (x << n) | (x >>> (32 - n));
}

/** MD4 と MD5 で共通の、パディングと 32 ビット語への切り出し */
function blocks(msg: Uint8Array): Uint32Array {
	const n = (((msg.length + 8) >> 6) + 1) * 16;
	const w = new Uint32Array(n);
	for (let i = 0; i < msg.length; i++)
		w[i >> 2] = (w[i >> 2] as number) | ((msg[i] as number) << ((i % 4) * 8));
	w[msg.length >> 2] =
		(w[msg.length >> 2] as number) | (0x80 << ((msg.length % 4) * 8));
	const bits = msg.length * 8;
	w[n - 2] = bits >>> 0;
	w[n - 1] = Math.floor(bits / 0x100000000);
	return w;
}

function out(...h: number[]): Uint8Array {
	const o = new Uint8Array(h.length * 4);
	const v = new DataView(o.buffer);
	h.forEach((x, i) => {
		v.setUint32(i * 4, x >>> 0, true);
	});
	return o;
}

export function md4(msg: Uint8Array): Uint8Array {
	const w = blocks(msg);
	let a = 0x67452301;
	let b = 0xefcdab89;
	let c = 0x98badcfe;
	let d = 0x10325476;
	const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
	const G = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
	const H = (x: number, y: number, z: number) => x ^ y ^ z;
	for (let i = 0; i < w.length; i += 16) {
		const X = (k: number) => w[i + k] as number;
		const [aa, bb, cc, dd] = [a, b, c, d];
		for (const k of [0, 4, 8, 12]) {
			a = rotl((a + F(b, c, d) + X(k)) | 0, 3);
			d = rotl((d + F(a, b, c) + X(k + 1)) | 0, 7);
			c = rotl((c + F(d, a, b) + X(k + 2)) | 0, 11);
			b = rotl((b + F(c, d, a) + X(k + 3)) | 0, 19);
		}
		for (const k of [0, 1, 2, 3]) {
			a = rotl((a + G(b, c, d) + X(k) + 0x5a827999) | 0, 3);
			d = rotl((d + G(a, b, c) + X(k + 4) + 0x5a827999) | 0, 5);
			c = rotl((c + G(d, a, b) + X(k + 8) + 0x5a827999) | 0, 9);
			b = rotl((b + G(c, d, a) + X(k + 12) + 0x5a827999) | 0, 13);
		}
		for (const k of [0, 2, 1, 3]) {
			a = rotl((a + H(b, c, d) + X(k) + 0x6ed9eba1) | 0, 3);
			d = rotl((d + H(a, b, c) + X(k + 8) + 0x6ed9eba1) | 0, 9);
			c = rotl((c + H(d, a, b) + X(k + 4) + 0x6ed9eba1) | 0, 11);
			b = rotl((b + H(c, d, a) + X(k + 12) + 0x6ed9eba1) | 0, 15);
		}
		a = (a + aa) | 0;
		b = (b + bb) | 0;
		c = (c + cc) | 0;
		d = (d + dd) | 0;
	}
	return out(a, b, c, d);
}

const S5 = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
	9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
	16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
	21,
];
const K5 = Array.from(
	{ length: 64 },
	(_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0,
);

export function md5(msg: Uint8Array): Uint8Array {
	const w = blocks(msg);
	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	for (let i = 0; i < w.length; i += 16) {
		let [a, b, c, d] = [a0, b0, c0, d0];
		for (let j = 0; j < 64; j++) {
			let f: number;
			let g: number;
			if (j < 16) {
				f = (b & c) | (~b & d);
				g = j;
			} else if (j < 32) {
				f = (d & b) | (~d & c);
				g = (5 * j + 1) % 16;
			} else if (j < 48) {
				f = b ^ c ^ d;
				g = (3 * j + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * j) % 16;
			}
			const t = d;
			d = c;
			c = b;
			b =
				(b +
					rotl(
						(a + f + (K5[j] as number) + (w[i + g] as number)) | 0,
						S5[j] as number,
					)) |
				0;
			a = t;
		}
		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}
	return out(a0, b0, c0, d0);
}

export function hmacMd5(key: Uint8Array, ...msg: Uint8Array[]): Uint8Array {
	let k = key.length > 64 ? md5(key) : key;
	const pad = new Uint8Array(64);
	pad.set(k);
	k = pad;
	let n = 0;
	for (const m of msg) n += m.length;
	const inner = new Uint8Array(64 + n);
	const outer = new Uint8Array(64 + 16);
	for (let i = 0; i < 64; i++) {
		inner[i] = (k[i] as number) ^ 0x36;
		outer[i] = (k[i] as number) ^ 0x5c;
	}
	let o = 64;
	for (const m of msg) {
		inner.set(m, o);
		o += m.length;
	}
	outer.set(md5(inner), 64);
	return md5(outer);
}

/** RC4。NTLM の封印は 1 本の鍵の流れを続けて使うので、状態を持つ */
export class Rc4 {
	private s = new Uint8Array(256);
	private i = 0;
	private j = 0;
	constructor(key: Uint8Array) {
		const s = this.s;
		for (let i = 0; i < 256; i++) s[i] = i;
		let j = 0;
		for (let i = 0; i < 256; i++) {
			j = (j + (s[i] as number) + (key[i % key.length] as number)) & 0xff;
			[s[i], s[j]] = [s[j] as number, s[i] as number];
		}
	}
	apply(data: Uint8Array): Uint8Array {
		const s = this.s;
		const o = new Uint8Array(data.length);
		let { i, j } = this;
		for (let k = 0; k < data.length; k++) {
			i = (i + 1) & 0xff;
			j = (j + (s[i] as number)) & 0xff;
			[s[i], s[j]] = [s[j] as number, s[i] as number];
			o[k] =
				(data[k] as number) ^
				(s[((s[i] as number) + (s[j] as number)) & 0xff] as number);
		}
		this.i = i;
		this.j = j;
		return o;
	}
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
	let n = 0;
	for (const p of parts) n += p.length;
	const all = new Uint8Array(n);
	let o = 0;
	for (const p of parts) {
		all.set(p, o);
		o += p.length;
	}
	return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

export function random(n: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(n));
}
