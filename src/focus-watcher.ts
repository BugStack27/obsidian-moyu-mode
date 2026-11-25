interface ElectronWindowTarget {
	isFocused?: () => boolean;
}

interface ElectronRemote {
	getCurrentWindow?: () => ElectronWindowTarget | null;
}

interface ElectronEnv {
	remote?: ElectronRemote;
}

export interface WindowFocusWatcherOptions {
	win: Window;
	/** 焦点是否落在嵌入的 webview 里：此时宿主窗口并没有真正切走。 */
	isGuestFocused?: () => boolean;
	onChange: (focused: boolean) => void;
}

/** 焦点交接需要一点时间落定，延后一拍再确认，避免误判。 */
const VERIFY_DELAY_MS = 60;

/**
 * 监听 Obsidian 窗口的失焦与聚焦。
 * 只看 window 的 blur/focus 事件：webview 抢焦点时也可能触发 blur，
 * 所以失焦后先等一拍，再用 Electron 的窗口状态和网页焦点复核一次。
 */
export class WindowFocusWatcher {
	private attached = false;
	private focused = true;
	private timer: number | null = null;

	private readonly handleBlur = (): void => {
		this.scheduleVerify();
	};

	private readonly handleFocus = (): void => {
		this.cancelVerify();
		this.apply(true);
	};

	constructor(private readonly options: WindowFocusWatcherOptions) {}

	attach(): void {
		if (this.attached) {
			return;
		}
		this.attached = true;
		this.options.win.addEventListener('blur', this.handleBlur);
		this.options.win.addEventListener('focus', this.handleFocus);
	}

	detach(): void {
		if (!this.attached) {
			return;
		}
		this.attached = false;
		this.cancelVerify();
		this.options.win.removeEventListener('blur', this.handleBlur);
		this.options.win.removeEventListener('focus', this.handleFocus);
		this.focused = true;
	}

	private scheduleVerify(): void {
		this.cancelVerify();
		this.timer = this.options.win.setTimeout(() => {
			this.timer = null;
			this.apply(this.isWindowActive());
		}, VERIFY_DELAY_MS);
	}

	private apply(focused: boolean): void {
		if (focused === this.focused) {
			return;
		}
		this.focused = focused;
		this.options.onChange(focused);
	}

	private isWindowActive(): boolean {
		const electronFocused = this.getElectronWindow()?.isFocused?.();
		if (typeof electronFocused === 'boolean') {
			return electronFocused;
		}
		if (this.options.isGuestFocused?.()) {
			return true;
		}
		return this.options.win.document.hasFocus();
	}

	private getElectronWindow(): ElectronWindowTarget | null {
		const electron = (this.options.win as Window & { electron?: ElectronEnv }).electron;
		return electron?.remote?.getCurrentWindow?.() ?? null;
	}

	private cancelVerify(): void {
		if (this.timer !== null) {
			this.options.win.clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
