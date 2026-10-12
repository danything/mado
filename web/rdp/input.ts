// 入力([MS-RDPBCGR] 2.2.8.1.2 Fast-Path Input)。KeyboardEvent.code からのスキャンコード、マウス、同期を作る。

import { concat, Writer } from "./bytes";

/** eventHeader は 上位 3 ビットが種類、下位 5 ビットがフラグ */
const EVENT = {
	SCANCODE: 0,
	MOUSE: 1,
	MOUSEX: 2,
	SYNC: 3,
	UNICODE: 4,
} as const;

const KBD_RELEASE = 0x01;
const KBD_EXTENDED = 0x02;

/** KeyboardEvent.code → [スキャンコード, E0 の拡張か]。物理キーの位置で決まる。JIS と US の違いはサーバー側の配列で吸収する */
const SCANCODES: Record<string, [number, boolean]> = {
	Escape: [0x01, false],
	Digit1: [0x02, false],
	Digit2: [0x03, false],
	Digit3: [0x04, false],
	Digit4: [0x05, false],
	Digit5: [0x06, false],
	Digit6: [0x07, false],
	Digit7: [0x08, false],
	Digit8: [0x09, false],
	Digit9: [0x0a, false],
	Digit0: [0x0b, false],
	Minus: [0x0c, false],
	Equal: [0x0d, false],
	Backspace: [0x0e, false],
	Tab: [0x0f, false],
	KeyQ: [0x10, false],
	KeyW: [0x11, false],
	KeyE: [0x12, false],
	KeyR: [0x13, false],
	KeyT: [0x14, false],
	KeyY: [0x15, false],
	KeyU: [0x16, false],
	KeyI: [0x17, false],
	KeyO: [0x18, false],
	KeyP: [0x19, false],
	BracketLeft: [0x1a, false],
	BracketRight: [0x1b, false],
	Enter: [0x1c, false],
	ControlLeft: [0x1d, false],
	KeyA: [0x1e, false],
	KeyS: [0x1f, false],
	KeyD: [0x20, false],
	KeyF: [0x21, false],
	KeyG: [0x22, false],
	KeyH: [0x23, false],
	KeyJ: [0x24, false],
	KeyK: [0x25, false],
	KeyL: [0x26, false],
	Semicolon: [0x27, false],
	Quote: [0x28, false],
	Backquote: [0x29, false],
	ShiftLeft: [0x2a, false],
	Backslash: [0x2b, false],
	KeyZ: [0x2c, false],
	KeyX: [0x2d, false],
	KeyC: [0x2e, false],
	KeyV: [0x2f, false],
	KeyB: [0x30, false],
	KeyN: [0x31, false],
	KeyM: [0x32, false],
	Comma: [0x33, false],
	Period: [0x34, false],
	Slash: [0x35, false],
	ShiftRight: [0x36, false],
	NumpadMultiply: [0x37, false],
	AltLeft: [0x38, false],
	Space: [0x39, false],
	CapsLock: [0x3a, false],
	F1: [0x3b, false],
	F2: [0x3c, false],
	F3: [0x3d, false],
	F4: [0x3e, false],
	F5: [0x3f, false],
	F6: [0x40, false],
	F7: [0x41, false],
	F8: [0x42, false],
	F9: [0x43, false],
	F10: [0x44, false],
	NumLock: [0x45, false],
	ScrollLock: [0x46, false],
	Numpad7: [0x47, false],
	Numpad8: [0x48, false],
	Numpad9: [0x49, false],
	NumpadSubtract: [0x4a, false],
	Numpad4: [0x4b, false],
	Numpad5: [0x4c, false],
	Numpad6: [0x4d, false],
	NumpadAdd: [0x4e, false],
	Numpad1: [0x4f, false],
	Numpad2: [0x50, false],
	Numpad3: [0x51, false],
	Numpad0: [0x52, false],
	NumpadDecimal: [0x53, false],
	IntlBackslash: [0x56, false],
	F11: [0x57, false],
	F12: [0x58, false],
	// 日本語キーボード
	KanaMode: [0x70, false],
	IntlRo: [0x73, false],
	Convert: [0x79, false],
	NonConvert: [0x7b, false],
	IntlYen: [0x7d, false],
	// 拡張(E0)
	NumpadEnter: [0x1c, true],
	ControlRight: [0x1d, true],
	NumpadDivide: [0x35, true],
	PrintScreen: [0x37, true],
	AltRight: [0x38, true],
	Home: [0x47, true],
	ArrowUp: [0x48, true],
	PageUp: [0x49, true],
	ArrowLeft: [0x4b, true],
	ArrowRight: [0x4d, true],
	End: [0x4f, true],
	ArrowDown: [0x50, true],
	PageDown: [0x51, true],
	Insert: [0x52, true],
	Delete: [0x53, true],
	MetaLeft: [0x5b, true],
	MetaRight: [0x5c, true],
	ContextMenu: [0x5d, true],
};

export function scancode(code: string): [number, boolean] | undefined {
	return SCANCODES[code];
}

/** Fast-Path のキーボード イベントを 1 つ作る。知らないキーは undefined */
export function keyEvent(code: string, down: boolean): Uint8Array | undefined {
	const sc = SCANCODES[code];
	if (!sc) return undefined;
	const flags = (down ? 0 : KBD_RELEASE) | (sc[1] ? KBD_EXTENDED : 0);
	return Uint8Array.of(flags | (EVENT.SCANCODE << 5), sc[0]);
}

/** Unicode の 1 文字。IME で確定した文字など、スキャンコードで表せないものに使う */
export function unicodeEvent(char: number, down: boolean): Uint8Array {
	return new Writer(3)
		.u8((down ? 0 : KBD_RELEASE) | (EVENT.UNICODE << 5))
		.u16(char)
		.done();
}

const PTR = {
	WHEEL_NEGATIVE: 0x0100,
	WHEEL: 0x0200,
	HWHEEL: 0x0400,
	MOVE: 0x0800,
	DOWN: 0x8000,
	BUTTON1: 0x1000,
	BUTTON2: 0x2000,
	BUTTON3: 0x4000,
} as const;

/** MouseEvent.button をポインタ フラグにする。0 が左、1 が中、2 が右。戻る / 進む(3 と 4)は拡張のイベントで送る */
const BUTTON_FLAG = [PTR.BUTTON1, PTR.BUTTON3, PTR.BUTTON2];

export function mouseMove(x: number, y: number): Uint8Array {
	return mouse(PTR.MOVE, x, y);
}

export function mouseButton(
	button: number,
	down: boolean,
	x: number,
	y: number,
): Uint8Array | undefined {
	if (button === 3 || button === 4) {
		// 戻る / 進む(PTRXFLAGS_BUTTON1 / 2)
		return new Writer(7)
			.u8(EVENT.MOUSEX << 5)
			.u16((down ? 0x8000 : 0) | (button === 3 ? 1 : 2))
			.u16(clamp(x))
			.u16(clamp(y))
			.done();
	}
	const flag = BUTTON_FLAG[button];
	if (flag === undefined) return undefined;
	return mouse((down ? PTR.DOWN : 0) | flag, x, y);
}

/** ホイール。delta は WheelEvent.deltaY で、下へ回すと正。RDP は 1 ノッチが 120 で、上へ回すと正 */
export function mouseWheel(delta: number, horizontal = false): Uint8Array {
	// 100 ピクセルを 1 ノッチ(120)とする。1 回の上限は 255
	const rotation = Math.min(
		255,
		Math.max(1, Math.round(Math.abs(delta) / 100)) * 120,
	);
	// 縦は向きが逆で、下へ回すと RDP では負になる。横は右へ回すと正のまま
	const negative = horizontal ? delta < 0 : delta > 0;
	const flags =
		(horizontal ? PTR.HWHEEL : PTR.WHEEL) |
		(negative ? PTR.WHEEL_NEGATIVE | ((0x100 - rotation) & 0xff) : rotation);
	return mouse(flags, 0, 0);
}

function mouse(flags: number, x: number, y: number): Uint8Array {
	return new Writer(7)
		.u8(EVENT.MOUSE << 5)
		.u16(flags)
		.u16(clamp(x))
		.u16(clamp(y))
		.done();
}

const clamp = (v: number) => Math.max(0, Math.min(0xffff, Math.round(v)));

/** Num / Caps / Scroll Lock の状態を伝える。つないだ直後に 0 で送る */
export function syncEvent(flags = 0): Uint8Array {
	return Uint8Array.of(flags | (EVENT.SYNC << 5));
}

/** イベントを Fast-Path Input の PDU にする。1 つの PDU は 15 イベントまで */
export function fastPathInput(events: Uint8Array[]): Uint8Array {
	if (events.length === 0 || events.length > 15)
		throw new RangeError("Fast-Path Input は 1〜15 イベント");
	const body = concat(...events);
	// 長さは PDU 全体。ヘッダー 1 バイト、長さ 1〜2 バイト、本体を足したもの
	const short = 2 + body.length;
	const length =
		short < 0x80
			? Uint8Array.of(short)
			: Uint8Array.of(0x80 | ((short + 1) >> 8), (short + 1) & 0xff);
	return concat(Uint8Array.of(events.length << 2), length, body);
}
