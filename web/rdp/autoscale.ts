// 回線と端末の混み具合に合わせて、RDP の画素数(窓の大きさに対する割合)を自動で上げ下げする。
// 混み具合は、GFX のフレームに付く時刻(サーバーが作った時刻)から、こちらで描き終えるまでの遅れで測る。
// 時計はずれているので遅れそのものは分からないが、いちばん小さかった遅れとの差(溜まった遅れ)は分かる(WebRTC の遅延ベースの輻輳制御と同じ考え方)。

/** 1 日の ms(GFX の時刻は時・分・秒・ms だけ) */
const DAY = 86_400_000;
/** いちばん小さい遅れを探す範囲 */
const BASE_WINDOW_MS = 30_000;
/** 遅れがこれより大きく跳んだら、時計が飛んだとみなす(本当に混んでも、一度にここまでは溜まらない) */
const CLOCK_JUMP_MS = 5000;
/** 溜まった遅れを出すのに要るフレームの数 */
const MIN_SAMPLES = 5;

/** RDPGFX_START_FRAME_PDU の timestamp(ms 10 ビット・秒 6・分 6・時 10)→ その日の 0 時からの ms */
export function gfxTimestampMs(t: number): number {
	const ms = t & 0x3ff;
	const s = (t >>> 10) & 0x3f;
	const m = (t >>> 16) & 0x3f;
	const h = (t >>> 22) & 0x3ff;
	return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

/** フレームの遅れ(作られてから描き終えるまで)のうち、溜まった分 */
export class FrameLatency {
	private samples: { at: number; delay: number }[] = [];
	/** 最後に測った、溜まった遅れ(ms) */
	queued?: number;
	/** 最後に測った時刻(古ければ使わない) */
	at = 0;

	/** serverMs: フレームの時刻(その日の 0 時からの ms)。nowUtc: こちらの時計(Date.now())。mono: 経過の時計(performance.now()) */
	add(serverMs: number, nowUtc: number, mono: number): void {
		// 日付をまたいでも、差を ±12 時間に収める
		let delay = ((((nowUtc % DAY) - serverMs) % DAY) + DAY) % DAY;
		if (delay > DAY / 2) delay -= DAY;
		// どちらかの時計が飛んだ(起動直後の時刻合わせなど)。前の遅れとは比べられないので測り直す
		const last = this.samples.at(-1);
		if (last && Math.abs(delay - last.delay) > CLOCK_JUMP_MS) this.samples = [];
		while (
			this.samples.length &&
			this.samples[0] &&
			mono - this.samples[0].at > BASE_WINDOW_MS
		)
			this.samples.shift();
		this.samples.push({ at: mono, delay });
		let base = delay;
		for (const s of this.samples) base = Math.min(base, s.delay);
		// フレームが少ないうちは、いちばん小さい遅れが当てにならない
		this.queued = this.samples.length >= MIN_SAMPLES ? delay - base : undefined;
		this.at = mono;
	}
}

/** 混み具合の 1 回分 */
export type Sample = {
	/** 溜まった遅れ(ms)。最近のフレームが無ければ undefined(静かなときは混んでいない) */
	queued?: number;
	/** 受け取って、まだ描き終えていないフレームの数 */
	backlog: number;
};

/** 溜まった遅れがこれを超えたら混んでいる */
const CONGESTED_MS = 200;
/** これより小さければ空いている */
const CALM_MS = 50;
/** 下げるのは、続けて混んでいたとき(サンプル 2 回) */
const DOWN_AFTER = 2;
/** 上げるのは、続けて空いていたとき(サンプル 5 回) */
const UP_AFTER = 5;
/** 上げたのにすぐまた混んだら、次に上げるまで待つ長さを倍にする(行ったり来たりしない) */
const FIRST_HOLD_MS = 10_000;
const MAX_HOLD_MS = 120_000;
/** 解像度を変えたあと、様子を見ない長さ */
const SETTLE_MS = 6000;
/** 上げてからこれより早く混んだら、上げたのが早すぎた */
const FAILED_UP_MS = 30_000;

/**
 * 画素数の割合を決める。max(上限。今は 1)から、steps の小さいほうへ下げる。
 * 解像度を変えると全面を送り直すので、下げるのも上げるのも続けて同じ様子だったときだけ
 */
export class AutoScale {
	scale: number;
	private bad = 0;
	private good = 0;
	private holdUntil = 0;
	private hold = FIRST_HOLD_MS;
	private lastUp = Number.NEGATIVE_INFINITY;
	private quietUntil = Number.NEGATIVE_INFINITY;
	private readonly steps: number[];

	constructor(max: number, steps: number[] = [1, 0.75, 0.5]) {
		this.steps = steps.filter((s) => s <= max);
		if (!this.steps.includes(max)) this.steps.unshift(max);
		this.scale = max;
	}

	/** until まで様子を見ない(つないだ直後の全面の送り直しを、混んでいるとみなさない) */
	pause(until: number): void {
		this.quietUntil = Math.max(this.quietUntil, until);
		this.bad = 0;
		this.good = 0;
	}

	/** 定期的に呼ぶ。割合を変えるべきなら新しい割合、変えないなら undefined */
	sample(s: Sample, now: number): number | undefined {
		if (now < this.quietUntil) return undefined;
		const q = s.queued ?? 0;
		const congested = q > CONGESTED_MS || s.backlog >= 3;
		const calm = q < CALM_MS && s.backlog === 0;
		this.bad = congested ? this.bad + 1 : 0;
		this.good = calm ? this.good + 1 : 0;
		const i = this.steps.indexOf(this.scale);
		if (this.bad >= DOWN_AFTER && i < this.steps.length - 1) {
			// 上げてすぐ混んだなら、次に上げるまでを長くする
			this.hold =
				now - this.lastUp < FAILED_UP_MS
					? Math.min(this.hold * 2, MAX_HOLD_MS)
					: FIRST_HOLD_MS;
			this.holdUntil = now + this.hold;
			this.bad = 0;
			return this.set(this.steps[i + 1] as number, now);
		}
		if (this.good >= UP_AFTER && i > 0 && now >= this.holdUntil) {
			this.good = 0;
			this.lastUp = now;
			return this.set(this.steps[i - 1] as number, now);
		}
		return undefined;
	}

	private set(scale: number, now: number): number {
		this.scale = scale;
		// 解像度を変えると全面を送り直してくるので、その間は見ない
		this.pause(now + SETTLE_MS);
		return scale;
	}
}
