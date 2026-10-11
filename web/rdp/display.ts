// ブラウザの画面。canvas に描き、ポインタを CSS の cursor にし、キー・マウスを RDP の入力にする。

import type { RdpClient, Screen } from "./client";
import * as input from "./input";
import type { Cursor } from "./pointer";

/** 表示上の位置(canvas の矩形の左上からの距離)→ RDP の座標。矩形は fit で拡縮された表示の大きさ */
export function toRdpPoint(
	clientX: number,
	clientY: number,
	rect: { left: number; top: number; width: number; height: number },
	width: number,
	height: number,
): { x: number; y: number } {
	if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
	const x = ((clientX - rect.left) * width) / rect.width;
	const y = ((clientY - rect.top) * height) / rect.height;
	return {
		x: Math.max(0, Math.min(width - 1, Math.floor(x))),
		y: Math.max(0, Math.min(height - 1, Math.floor(y))),
	};
}

/** 親の大きさに収まる最大の表示の大きさ(縦横比を保つ) */
export function fitSize(
	width: number,
	height: number,
	boxW: number,
	boxH: number,
): { width: number; height: number } {
	if (width <= 0 || height <= 0 || boxW <= 0 || boxH <= 0)
		return { width: 0, height: 0 };
	const k = Math.min(boxW / width, boxH / height);
	return { width: Math.floor(width * k), height: Math.floor(height * k) };
}

export class Display implements Screen {
	readonly canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private cursors = new Map<Cursor, string>();
	private observer: ResizeObserver;

	constructor(private parent: HTMLElement) {
		this.canvas = document.createElement("canvas");
		this.canvas.tabIndex = 0;
		this.canvas.style.outline = "none";
		this.canvas.style.display = "block";
		this.canvas.style.margin = "auto";
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("canvas が使えない");
		this.ctx = ctx;
		parent.append(this.canvas);
		this.observer = new ResizeObserver(() => this.fit());
		this.observer.observe(parent);
	}

	get width(): number {
		return this.canvas.width;
	}
	get height(): number {
		return this.canvas.height;
	}

	resize(width: number, height: number): void {
		this.canvas.width = width;
		this.canvas.height = height;
		this.fit();
	}

	/** 切れたあとの片付け: 画を消して、ポインタを既定に戻す */
	clear(): void {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.canvas.style.cursor = "default";
	}

	draw(
		x: number,
		y: number,
		w: number,
		h: number,
		rgba: Uint8ClampedArray,
	): void {
		// 写さずにそのまま渡す(タイルごとの複製を省く)。rgba は ArrayBuffer の上にある
		this.ctx.putImageData(
			new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h),
			x,
			y,
		);
	}

	/** GFX の面(canvas)の一部を画面へ写す */
	blit(
		src: CanvasImageSource,
		sx: number,
		sy: number,
		w: number,
		h: number,
		dx: number,
		dy: number,
	): void {
		this.ctx.clearRect(dx, dy, w, h);
		this.ctx.drawImage(src, sx, sy, w, h, dx, dy, w, h);
	}

	setCursor(cursor: Cursor | "default" | null): void {
		if (cursor === null) this.canvas.style.cursor = "none";
		else if (cursor === "default") this.canvas.style.cursor = "default";
		else this.canvas.style.cursor = this.cursorCss(cursor);
	}

	/** 画面の大きさを親に fit させる(CSS だけ。canvas の画素数は RDP の大きさのまま) */
	private fit(): void {
		const s = fitSize(
			this.canvas.width,
			this.canvas.height,
			this.parent.clientWidth,
			this.parent.clientHeight,
		);
		this.canvas.style.width = `${s.width}px`;
		this.canvas.style.height = `${s.height}px`;
	}

	private cursorCss(c: Cursor): string {
		const hit = this.cursors.get(c);
		if (hit) return hit;
		const cv = document.createElement("canvas");
		cv.width = c.width;
		cv.height = c.height;
		cv.getContext("2d")?.putImageData(
			new ImageData(new Uint8ClampedArray(c.rgba), c.width, c.height),
			0,
			0,
		);
		const css = `url(${cv.toDataURL()}) ${c.hotX} ${c.hotY}, auto`;
		this.cursors.set(c, css);
		return css;
	}

	dispose(): void {
		this.observer.disconnect();
		this.canvas.remove();
	}
}

/** canvas のキー・マウスを RDP の入力にする。戻り値で解除 */
export function bindInput(
	canvas: HTMLCanvasElement,
	client: RdpClient,
	display: Display,
): () => void {
	const down = new Set<string>();
	let pending: { x: number; y: number } | undefined;
	let raf = 0;

	const point = (e: MouseEvent) =>
		toRdpPoint(
			e.clientX,
			e.clientY,
			canvas.getBoundingClientRect(),
			display.width,
			display.height,
		);

	const flushMove = () => {
		raf = 0;
		if (!pending) return;
		client.sendInput([input.mouseMove(pending.x, pending.y)]);
		pending = undefined;
	};

	const key = (e: KeyboardEvent, isDown: boolean) => {
		const ev = input.keyEvent(e.code, isDown);
		if (ev) {
			if (isDown) down.add(e.code);
			else down.delete(e.code);
			client.sendInput([ev]);
		} else if (e.key.length === 1) {
			client.sendInput([input.unicodeEvent(e.key.charCodeAt(0), isDown)]);
		} else return;
		e.preventDefault();
	};
	const onKeyDown = (e: KeyboardEvent) => key(e, true);
	const onKeyUp = (e: KeyboardEvent) => key(e, false);
	const onMove = (e: MouseEvent) => {
		pending = point(e);
		if (!raf) raf = requestAnimationFrame(flushMove);
	};
	const button = (e: MouseEvent, isDown: boolean) => {
		if (isDown) canvas.focus();
		const p = point(e);
		const ev = input.mouseButton(e.button, isDown, p.x, p.y);
		if (!ev) return;
		pending = undefined;
		client.sendInput([ev]);
		e.preventDefault();
	};
	// 押したまま canvas の外へ出して離しても、ボタンが押しっぱなしにならないよう、押している間は window で離すのを待つ
	const held = new Set<number>();
	const onUp = (e: MouseEvent) => {
		if (!held.delete(e.button)) return;
		if (held.size === 0) window.removeEventListener("mouseup", onUp);
		button(e, false);
	};
	const onDown = (e: MouseEvent) => {
		if (held.size === 0) window.addEventListener("mouseup", onUp);
		held.add(e.button);
		button(e, true);
	};
	const onWheel = (e: WheelEvent) => {
		const events: Uint8Array[] = [];
		// deltaMode 1 は行単位(1 行 = 40px 相当)
		const k = e.deltaMode === 1 ? 40 : 1;
		if (e.deltaY) events.push(input.mouseWheel(e.deltaY * k));
		if (e.deltaX) events.push(input.mouseWheel(e.deltaX * k, true));
		if (events.length) client.sendInput(events);
		e.preventDefault();
	};
	const onMenu = (e: Event) => e.preventDefault();
	const onBlur = () => {
		const ups: Uint8Array[] = [];
		for (const b of held) {
			const ev = input.mouseButton(b, false, 0, 0);
			if (ev) ups.push(ev);
		}
		held.clear();
		window.removeEventListener("mouseup", onUp);
		for (const code of down) {
			const ev = input.keyEvent(code, false);
			if (ev) ups.push(ev);
		}
		down.clear();
		if (ups.length) client.sendInput(ups);
	};

	canvas.addEventListener("keydown", onKeyDown);
	canvas.addEventListener("keyup", onKeyUp);
	canvas.addEventListener("mousemove", onMove);
	canvas.addEventListener("mousedown", onDown);
	canvas.addEventListener("wheel", onWheel, { passive: false });
	canvas.addEventListener("contextmenu", onMenu);
	canvas.addEventListener("blur", onBlur);
	return () => {
		canvas.removeEventListener("keydown", onKeyDown);
		canvas.removeEventListener("keyup", onKeyUp);
		canvas.removeEventListener("mousemove", onMove);
		canvas.removeEventListener("mousedown", onDown);
		window.removeEventListener("mouseup", onUp);
		canvas.removeEventListener("wheel", onWheel);
		canvas.removeEventListener("contextmenu", onMenu);
		canvas.removeEventListener("blur", onBlur);
		if (raf) cancelAnimationFrame(raf);
	};
}

/** 親の大きさが変わって落ち着いたら(debounce)cb を呼ぶ。戻り値で解除 */
export function watchSize(
	el: HTMLElement,
	cb: (width: number, height: number) => void,
	delay = 300,
): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const ro = new ResizeObserver(() => {
		clearTimeout(timer);
		timer = setTimeout(() => cb(el.clientWidth, el.clientHeight), delay);
	});
	ro.observe(el);
	return () => {
		clearTimeout(timer);
		ro.disconnect();
	};
}
