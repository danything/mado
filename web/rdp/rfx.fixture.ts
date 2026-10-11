// RemoteFX の試験用の部品: 実機(xrdp)から取ったタイルの成分と、RemoteFX のストリームを組み立てる関数、RLGR3 の符号化(往復の試験用)。

import { concat, fromHex, Writer } from "./bytes";

/** xrdp が送ってきたタイル(位置 (8, 7)、壁紙の青いグラデーション)の Y / Cb / Cr(RLGR3)と、量子化(5 バイト) */
export const REAL_TILE = {
	quant: fromHex("6666778898"),
	y: fromHex(
		"0000156c7d943481a48805b4aa418bfffffffffffffd000c00480781400c0088d9081420f405246ac948dcc24232e8543bd58a10",
	),
	cb: fromHex("000017d06a3466932068c333ffff431004a48d10512d5ad666b914a2a0"),
	cr: fromHex(
		"0000155a4202efa4040d028d107fffffffffe800420800b06218040400a54a452123b882148477ad74",
	),
} as const;

export type TileInput = {
	x: number;
	y: number;
	y_: Uint8Array;
	cb: Uint8Array;
	cr: Uint8Array;
};

const block = (type: number, body: Uint8Array) =>
	concat(
		new Writer(6)
			.u16(type)
			.u32(body.length + 6)
			.done(),
		body,
	);
const channelBlock = (type: number, body: Uint8Array) =>
	block(type, concat(Uint8Array.of(0x01, 0x00), body));

/** 1 つの領域(矩形)と、1 つの Tileset を持つ RemoteFX のストリーム(Sync と Context から Frame End まで) */
export function rfxStream(
	rects: { x: number; y: number; w: number; h: number }[],
	tiles: TileInput[],
	opts: { quant?: Uint8Array; entropy?: number } = {},
): Uint8Array {
	const entropy = opts.entropy ?? 0x04;
	const quant = opts.quant ?? REAL_TILE.quant;
	const regionBody = new Writer(32).u8(1).u16(rects.length);
	for (const r of rects) regionBody.u16(r.x).u16(r.y).u16(r.w).u16(r.h);
	regionBody.u16(0xcac1).u16(1);
	const tileBlocks = tiles.map((t) =>
		block(
			0xcac3,
			concat(
				new Writer(15)
					.u8(0)
					.u8(0)
					.u8(0)
					.u16(t.x / 64)
					.u16(t.y / 64)
					.u16(t.y_.length)
					.u16(t.cb.length)
					.u16(t.cr.length)
					.done(),
				t.y_,
				t.cb,
				t.cr,
			),
		),
	);
	const tilesData = concat(...tileBlocks);
	const tileset = new Writer(32)
		.u16(0xcac2)
		.u16(0)
		.u16(0x0001 | (1 << 4) | (1 << 6) | (entropy << 10) | (1 << 14))
		.u8(1)
		.u8(0x40)
		.u16(tiles.length)
		.u32(tilesData.length)
		.bytes(quant)
		.done();
	return concat(
		block(0xccc0, new Writer(6).u32(0xcacccaca).u16(0x0100).done()),
		channelBlock(0xccc3, new Writer(7).u8(0).u16(0x40).u16(0x2828).done()),
		channelBlock(0xccc4, new Writer(6).u32(0).u16(1).done()),
		channelBlock(0xccc6, regionBody.done()),
		channelBlock(0xccc7, concat(tileset, tilesData)),
		channelBlock(0xccc5, new Uint8Array()),
	);
}

// ---- RLGR3 の符号化(試験用。復号と同じ規則を逆にしたもの) ----

class BitWriter {
	private bytes: number[] = [];
	private nbits = 0;
	bit(b: number): void {
		if (this.nbits % 8 === 0) this.bytes.push(0);
		if (b) this.bytes[this.bytes.length - 1] |= 0x80 >> (this.nbits % 8);
		this.nbits++;
	}
	bits(v: number, n: number): void {
		for (let i = n - 1; i >= 0; i--) this.bit((v >> i) & 1);
	}
	done(): Uint8Array {
		return Uint8Array.from(this.bytes);
	}
}

const KPMAX = 80;
const fold = (v: number) => (v === 0 ? 0 : v > 0 ? 2 * v : -2 * v - 1);

/** values を RLGR1 / RLGR3 で符号化する */
export function rlgrEncode(values: Int32Array, mode: 1 | 4): Uint8Array {
	const w = new BitWriter();
	let k = 1;
	let kp = 8;
	let kr = 1;
	let krp = 8;
	const gr = (code: number) => {
		const vk = Math.floor(code / (1 << kr));
		for (let i = 0; i < vk; i++) w.bit(1);
		w.bit(0);
		w.bits(code & ((1 << kr) - 1), kr);
		if (vk === 0) krp = Math.max(0, krp - 2);
		else if (vk > 1) krp = Math.min(KPMAX, krp + vk);
		kr = krp >> 3;
	};
	let i = 0;
	const n = values.length;
	while (i < n) {
		if (k) {
			let run = 0;
			while (i + run < n && values[i + run] === 0) run++;
			let left = run;
			while (left >= 1 << k) {
				w.bit(0);
				left -= 1 << k;
				kp = Math.min(kp + 4, KPMAX);
				k = kp >> 3;
			}
			w.bit(1);
			w.bits(left, k);
			i += run;
			if (i >= n) break;
			const v = values[i] as number;
			w.bit(v < 0 ? 1 : 0);
			gr(Math.abs(v) - 1);
			kp = Math.max(0, kp - 6);
			k = kp >> 3;
			i++;
		} else if (mode === 1) {
			const u = fold(values[i] as number);
			gr(u);
			kp = u === 0 ? Math.min(kp + 3, KPMAX) : Math.max(0, kp - 3);
			k = kp >> 3;
			i++;
		} else {
			const u1 = fold(values[i] as number);
			const u2 = fold((values[i + 1] ?? 0) as number);
			const code = u1 + u2;
			gr(code);
			const idx = code === 0 ? 0 : 32 - Math.clz32(code);
			w.bits(u1, idx);
			if (u1 && u2) kp = Math.max(0, kp - 6);
			else if (!u1 && !u2) kp = Math.min(kp + 6, KPMAX);
			k = kp >> 3;
			i += 2;
		}
	}
	return w.done();
}
