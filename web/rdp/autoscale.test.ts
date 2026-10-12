import { describe, expect, test } from "bun:test";
import { AutoScale, FrameLatency, gfxTimestampMs } from "./autoscale";

describe("フレームの遅れ", () => {
	test("GFX の時刻(ms・秒・分・時)", () => {
		// 13:05:07.250
		const t = 250 | (7 << 10) | (5 << 16) | (13 << 22);
		expect(gfxTimestampMs(t)).toBe(((13 * 60 + 5) * 60 + 7) * 1000 + 250);
	});

	test("いちばん小さい遅れとの差を、溜まった遅れとする。時計のずれは消える", () => {
		const l = new FrameLatency();
		const offset = 3_600_000; // こちらの時計が 1 時間進んでいる
		const day = Date.UTC(2026, 9, 12);
		// フレームが 5 枚たまるまでは出さない
		for (let i = 0; i < 4; i++)
			l.add(i * 100, day + i * 100 + offset + 20, i * 100);
		expect(l.queued).toBeUndefined();
		l.add(1000, day + 1000 + offset + 20, 1000);
		expect(l.queued).toBe(0);
		l.add(2000, day + 2000 + offset + 320, 2000);
		expect(l.queued).toBe(300);
		l.add(3000, day + 3000 + offset + 30, 3000);
		expect(l.queued).toBe(10);
		// 30 秒より古いものは、いちばん小さい遅れに使わない
		for (let t = 40_000; t < 45_000; t += 1000)
			l.add(t, day + t + offset + 100, t);
		expect(l.queued).toBe(0);
	});

	test("時計が飛んだら測り直す。日付をまたいでも差は小さいまま", () => {
		const l = new FrameLatency();
		const day = Date.UTC(2026, 9, 12);
		for (let i = 0; i < 5; i++) l.add(i * 100, day + i * 100 + 20, i * 100);
		// サーバーの時計が 9 秒戻った: 遅れが 9 秒溜まったのではない
		l.add(1000 - 9000 + 86_400_000, day + 1000 + 20, 1000);
		expect(l.queued).toBeUndefined();
		const m = new FrameLatency();
		// サーバーは 23:59:59.9xx、こちらは翌日 00:00:00.0xx
		for (let i = 0; i < 5; i++)
			m.add((86_399_950 + i * 10) % 86_400_000, day + 86_400_000 + i * 10, i);
		m.add(10, day + 86_400_000 + 60, 6);
		expect(m.queued).toBe(0);
	});
});

describe("画素数の自動調整", () => {
	const busy = { queued: 500, backlog: 0 };
	const calm = { queued: 10, backlog: 0 };

	test("続けて混んだら一段下げる。下限より下げない", () => {
		const a = new AutoScale(1);
		expect(a.sample(busy, 0)).toBeUndefined();
		expect(a.sample(busy, 2000)).toBe(0.75);
		expect(a.sample(busy, 4000)).toBeUndefined();
		expect(a.sample(busy, 6000)).toBe(0.5);
		a.sample(busy, 8000);
		expect(a.sample(busy, 10_000)).toBeUndefined();
		expect(a.scale).toBe(0.5);
	});

	test("未描画のフレームが溜まっても混んでいるとみなす", () => {
		const a = new AutoScale(1);
		a.sample({ backlog: 3 }, 0);
		expect(a.sample({ backlog: 4 }, 2000)).toBe(0.75);
	});

	test("下げたあとは待ってから、続けて空いていれば一段上げる。選んだ割合より上げない", () => {
		const a = new AutoScale(0.75);
		a.sample(busy, 0);
		expect(a.sample(busy, 2000)).toBe(0.5);
		// 下げてから 10 秒は上げない
		for (let t = 4000; t < 12_000; t += 2000)
			expect(a.sample(calm, t)).toBeUndefined();
		expect(a.sample(calm, 12_000)).toBe(0.75);
		for (let t = 14_000; t < 40_000; t += 2000)
			expect(a.sample(calm, t)).toBeUndefined();
		expect(a.scale).toBe(0.75);
	});

	test("上げてすぐまた混んだら、次に上げるまでを倍に延ばす", () => {
		const a = new AutoScale(1);
		a.sample(busy, 0);
		a.sample(busy, 2000); // 0.75、10 秒待つ
		let t = 4000;
		while (a.scale !== 1) {
			a.sample(calm, t);
			t += 2000;
		}
		const up = t;
		a.sample(busy, t);
		expect(a.sample(busy, t + 2000)).toBe(0.75); // 上げてすぐ混んだ: 20 秒待つ
		t += 4000;
		let back = -1;
		for (; t < up + 60_000; t += 2000)
			if (a.sample(calm, t) === 1) {
				back = t;
				break;
			}
		expect(back - (up + 2000)).toBeGreaterThanOrEqual(20_000);
	});

	test("静か(最近のフレームが無い)なら空いているとみなす", () => {
		const a = new AutoScale(1);
		a.sample(busy, 0);
		a.sample(busy, 2000);
		let t = 4000;
		for (; t < 30_000 && a.scale !== 1; t += 2000) a.sample({ backlog: 0 }, t);
		expect(a.scale).toBe(1);
	});
});
