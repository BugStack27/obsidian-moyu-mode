interface CursorPoint {
	x: number;
	y: number;
}

interface ContentOrigin {
	x: number;
	y: number;
}

interface ElectronRemote {
	screen?: { getCursorScreenPoint?: () => CursorPoint };
	getCurrentWindow?: () => { getContentBounds?: () => ContentOrigin } | null;
}

interface ElectronEnv {
	webFrame?: { getZoomFactor?: () => number };
	remote?: ElectronRemote;
}

interface ScreenRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface MouseWatcherOptions {
	doc: Document;
	/** 返回需要保持显示的矩形（内容区 + 标签头），为空表示当前无需判定。 */
	getRect: () => DOMRect | null;
	intervalMs: () => number;
	hideDelayMs: () => number;
	tolerancePx: () => number;
	hideOnBlur: () => boolean;
	/** 弹窗打开等场景下暂停判定，避免误触发。 */
	isBlocked?: () => boolean;
	onLeave: () => void;
}

/**
 * 轮询全局鼠标位置，判断光标是否离开了视图矩形。
 * —— webview 会吞掉鼠标事件，只能从系统层拿坐标。
 */
export class MouseWatcher {
	private timer: number | null = null;
	private outsideSince: number | null = null;
	private armed = true;

	constructor(private readonly options: MouseWatcherOptions) {}

	start(): void {
		if (this.timer !== null) {
			return;
		}
		this.outsideSince = null;
		// 启动时先不武装：光标要真实进入过视图，之后离开才算离开。
		// 否则从标签头恢复的瞬间会被判成已在外部，页面刚出现就被切走。
		this.armed = false;
		const win = this.getWindow();
		this.timer = win.setInterval(() => this.tick(), Math.max(this.options.intervalMs(), 20));
	}

	stop(): void {
		if (this.timer !== null) {
			this.getWindow().clearInterval(this.timer);
			this.timer = null;
		}
		this.outsideSince = null;
	}

	/** 设置里的轮询参数变化后重启计时器。 */
	restart(): void {
		const running = this.timer !== null;
		this.stop();
		if (running) {
			this.start();
		}
	}

	private tick(): void {
		if (this.options.isBlocked?.()) {
			this.outsideSince = null;
			return;
		}

		const point = this.getCursorPoint();
		const bounds = this.getScreenBounds();
		if (!point || !bounds) {
			return;
		}

		const tolerance = this.options.tolerancePx();
		const inside =
			point.x >= bounds.left - tolerance &&
			point.x <= bounds.right + tolerance &&
			point.y >= bounds.top - tolerance &&
			point.y <= bounds.bottom + tolerance;

		if (inside) {
			this.outsideSince = null;
			this.armed = true;
			return;
		}

		// 离开只触发一次；光标重新进入后再次武装，避免在外部停留时反复回调。
		if (!this.armed) {
			return;
		}

		// 失焦判定放在位置判定之后：焦点在 webview 内部时 hasFocus 可能为 false，
		// 若排在前面会在刚恢复显示的瞬间误判为「切到其他应用」。
		if (this.options.hideOnBlur() && !this.options.doc.hasFocus()) {
			this.triggerLeave();
			return;
		}

		const now = Date.now();
		if (this.outsideSince === null) {
			this.outsideSince = now;
		}
		if (now - this.outsideSince >= Math.max(this.options.hideDelayMs(), 0)) {
			this.triggerLeave();
		}
	}

	private triggerLeave(): void {
		this.armed = false;
		this.outsideSince = null;
		this.options.onLeave();
	}

	private getScreenBounds(): ScreenRect | null {
		const rect = this.options.getRect();
		if (!rect || rect.width <= 0 || rect.height <= 0) {
			return null;
		}
		const origin = this.getContentOrigin();
		const zoom = this.getZoom();
		const left = origin.x + rect.left * zoom;
		const top = origin.y + rect.top * zoom;
		return {
			left,
			top,
			right: left + rect.width * zoom,
			bottom: top + rect.height * zoom,
		};
	}

	/** 内容区左上角的屏幕坐标；优先用 Electron 的窗口位置，避免自己算边框。 */
	private getContentOrigin(): ContentOrigin {
		const bounds = this.getElectron()?.remote?.getCurrentWindow?.()?.getContentBounds?.();
		if (bounds) {
			return bounds;
		}
		const zoom = this.getZoom();
		const win = this.getWindow();
		return {
			x: win.screenX + (win.outerWidth - win.innerWidth * zoom) / 2,
			y: win.screenY + (win.outerHeight - win.innerHeight * zoom),
		};
	}

	private getCursorPoint(): CursorPoint | null {
		return this.getElectron()?.remote?.screen?.getCursorScreenPoint?.() ?? null;
	}

	private getZoom(): number {
		return this.getElectron()?.webFrame?.getZoomFactor?.() ?? 1;
	}

	private getElectron(): ElectronEnv | null {
		const win = this.getWindow() as Window & { electron?: ElectronEnv };
		return win.electron ?? null;
	}

	private getWindow(): Window {
		return this.options.doc.defaultView ?? window;
	}
}
