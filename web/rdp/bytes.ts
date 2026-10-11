// バイト列の読み書き。RDP は基本リトル エンディアン、TPKT・X.224・MCS(BER / PER)はビッグ エンディアン。

export class Reader {
	pos = 0;
	readonly view: DataView;
	constructor(
		readonly buf: Uint8Array,
		start = 0,
		readonly end = buf.length,
	) {
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		this.pos = start;
	}
	get left(): number {
		return this.end - this.pos;
	}
	need(n: number): void {
		if (this.pos + n > this.end)
			throw new RangeError(`short read: need ${n}, have ${this.left}`);
	}
	u8(): number {
		this.need(1);
		return this.buf[this.pos++] as number;
	}
	u16(): number {
		this.need(2);
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return v;
	}
	u16be(): number {
		this.need(2);
		const v = this.view.getUint16(this.pos, false);
		this.pos += 2;
		return v;
	}
	i16(): number {
		this.need(2);
		const v = this.view.getInt16(this.pos, true);
		this.pos += 2;
		return v;
	}
	u32(): number {
		this.need(4);
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}
	u32be(): number {
		this.need(4);
		const v = this.view.getUint32(this.pos, false);
		this.pos += 4;
		return v;
	}
	i32(): number {
		this.need(4);
		const v = this.view.getInt32(this.pos, true);
		this.pos += 4;
		return v;
	}
	u64(): bigint {
		this.need(8);
		const v = this.view.getBigUint64(this.pos, true);
		this.pos += 8;
		return v;
	}
	bytes(n: number): Uint8Array {
		this.need(n);
		const v = this.buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return v;
	}
	skip(n: number): void {
		this.need(n);
		this.pos += n;
	}
	/** ここから n バイトだけを読む Reader。自分はその先へ進む */
	sub(n: number): Reader {
		this.need(n);
		const r = new Reader(this.buf, this.pos, this.pos + n);
		this.pos += n;
		return r;
	}
	rest(): Uint8Array {
		return this.bytes(this.left);
	}
	/** UTF-16LE を n バイト。末尾の NUL は落とす */
	utf16(n: number): string {
		const b = this.bytes(n);
		let s = "";
		for (let i = 0; i + 1 < b.length; i += 2) {
			const c = (b[i] as number) | ((b[i + 1] as number) << 8);
			s += String.fromCharCode(c);
		}
		return s.replace(/\0+$/, "");
	}
}

export class Writer {
	buf: Uint8Array;
	view: DataView;
	pos = 0;
	constructor(size = 256) {
		this.buf = new Uint8Array(size);
		this.view = new DataView(this.buf.buffer);
	}
	private grow(n: number): void {
		if (this.pos + n <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.pos + n) size *= 2;
		const b = new Uint8Array(size);
		b.set(this.buf);
		this.buf = b;
		this.view = new DataView(b.buffer);
	}
	u8(v: number): this {
		this.grow(1);
		this.buf[this.pos++] = v;
		return this;
	}
	u16(v: number): this {
		this.grow(2);
		this.view.setUint16(this.pos, v, true);
		this.pos += 2;
		return this;
	}
	u16be(v: number): this {
		this.grow(2);
		this.view.setUint16(this.pos, v, false);
		this.pos += 2;
		return this;
	}
	i16(v: number): this {
		this.grow(2);
		this.view.setInt16(this.pos, v, true);
		this.pos += 2;
		return this;
	}
	u32(v: number): this {
		this.grow(4);
		this.view.setUint32(this.pos, v >>> 0, true);
		this.pos += 4;
		return this;
	}
	u32be(v: number): this {
		this.grow(4);
		this.view.setUint32(this.pos, v >>> 0, false);
		this.pos += 4;
		return this;
	}
	i32(v: number): this {
		this.grow(4);
		this.view.setInt32(this.pos, v, true);
		this.pos += 4;
		return this;
	}
	u64(v: bigint): this {
		this.grow(8);
		this.view.setBigUint64(this.pos, v, true);
		this.pos += 8;
		return this;
	}
	bytes(b: Uint8Array): this {
		this.grow(b.length);
		this.buf.set(b, this.pos);
		this.pos += b.length;
		return this;
	}
	zeros(n: number): this {
		this.grow(n);
		this.buf.fill(0, this.pos, this.pos + n);
		this.pos += n;
		return this;
	}
	/** UTF-16LE。nul なら末尾に NUL を足す */
	utf16(s: string, nul = false): this {
		for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
		if (nul) this.u16(0);
		return this;
	}
	/** 固定長の UTF-16LE 欄(残りは 0 で埋める。長すぎれば切る。最後の 1 文字ぶんは NUL に残す) */
	utf16Fixed(s: string, bytes: number): this {
		const max = bytes / 2 - 1;
		const t = s.slice(0, max);
		this.utf16(t);
		this.zeros(bytes - t.length * 2);
		return this;
	}
	/** あとで長さを書き込む場所を取っておく */
	mark(n: number): number {
		const at = this.pos;
		this.zeros(n);
		return at;
	}
	setU16(at: number, v: number): void {
		this.view.setUint16(at, v, true);
	}
	setU16be(at: number, v: number): void {
		this.view.setUint16(at, v, false);
	}
	setU32(at: number, v: number): void {
		this.view.setUint32(at, v >>> 0, true);
	}
	done(): Uint8Array {
		return this.buf.slice(0, this.pos);
	}
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export function utf16le(s: string): Uint8Array {
	return new Writer(s.length * 2).utf16(s).done();
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function hex(b: Uint8Array): string {
	return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
	const t = s.replace(/\s+/g, "");
	const out = new Uint8Array(t.length / 2);
	for (let i = 0; i < out.length; i++)
		out[i] = Number.parseInt(t.slice(i * 2, i * 2 + 2), 16);
	return out;
}
