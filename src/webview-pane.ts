interface ElectronWebviewElement extends HTMLElement {
	loadURL(url: string): Promise<void>;
	reload(): void;
	executeJavaScript(code: string): Promise<unknown>;
	setAudioMuted(muted: boolean): void;
	canGoBack(): boolean;
	goBack(): void;
	canGoForward(): boolean;
	goForward(): void;
	getURL(): string;
}

export interface NavigationState {
	canGoBack: boolean;
	canGoForward: boolean;
	url: string;
}

export interface WebviewPaneOptions {
	onOpenUrl: (url: string) => void;
	onNavigate?: (state: NavigationState) => void;
}

const OPEN_MARKER = '__MOYU_OPEN__';

/**
 * 负责一个 webview 元素的创建、导航与生命周期。
 * 首次加载用 src 属性，之后切换站点复用同一个元素，保留登录态与历史。
 */
export class WebviewPane {
	private readonly webview: ElectronWebviewElement;
	private ready = false;
	private currentUrl = '';

	constructor(container: HTMLElement, private readonly options: WebviewPaneOptions) {
		// webview 是 Electron 自定义元素，未收录在 HTMLElementTagNameMap 的类型里，运行时仍可按标签名创建。
		const webviewEl = container.createEl('webview' as keyof HTMLElementTagNameMap);
		this.webview = webviewEl as unknown as ElectronWebviewElement;
		this.webview.setAttribute('partition', 'persist:moyu');

		this.webview.addEventListener('dom-ready', () => {
			this.ready = true;
			this.injectClickInterceptor();
			this.emitNavigation();
		});

		this.webview.addEventListener('did-navigate', () => {
			this.emitNavigation();
		});

		this.webview.addEventListener('did-navigate-in-page', () => {
			this.emitNavigation();
		});

		this.webview.addEventListener('console-message', (event: Event) => {
			const message = (event as Event & { message?: unknown }).message;
			if (typeof message !== 'string' || !message.startsWith(OPEN_MARKER)) {
				return;
			}
			const url = message.slice(OPEN_MARKER.length);
			if (url) {
				this.options.onOpenUrl(url);
			}
		});
	}

	async load(url: string): Promise<void> {
		if (!url) {
			return;
		}
		this.currentUrl = url;
		if (!this.ready) {
			this.webview.setAttribute('src', url);
			this.emitNavigation(url);
			return;
		}
		try {
			await this.webview.loadURL(url);
			this.emitNavigation(url);
		} catch (error) {
			console.error('摸鱼模式：网页加载失败', error);
		}
	}

	reload(): void {
		if (this.ready) {
			this.webview.reload();
		}
	}

	canGoBack(): boolean {
		return this.ready && this.webview.canGoBack();
	}

	goBack(): void {
		if (this.canGoBack()) {
			this.webview.goBack();
		}
	}

	canGoForward(): boolean {
		return this.ready && this.webview.canGoForward();
	}

	goForward(): void {
		if (this.canGoForward()) {
			this.webview.goForward();
		}
	}

	/** 当前配置的站点地址，用于和设置比较是否需要重新加载。 */
	getUrl(): string {
		return this.currentUrl;
	}

	setMuted(muted: boolean): void {
		if (!this.ready) {
			return;
		}
		this.webview.setAudioMuted(muted);
	}

	focus(): void {
		this.webview.focus();
	}

	/** 失活时暂停正在播放的媒体，避免后台发声。 */
	pauseMedia(): void {
		if (!this.ready) {
			return;
		}
		this.webview
			.executeJavaScript(`
				document.querySelectorAll('video, audio').forEach((media) => {
					try {
						media.pause();
					} catch (error) {
						// 部分媒体元素不可控，忽略即可。
					}
				});
			`)
			.catch(() => {
				// 页面禁止脚本注入时无法暂停，静音仍然生效。
			});
	}

	destroy(): void {
		this.webview.remove();
	}

	private emitNavigation(url?: string): void {
		const resolved = url ?? (this.ready ? this.webview.getURL() : '');
		this.options.onNavigate?.({
			canGoBack: this.canGoBack(),
			canGoForward: this.canGoForward(),
			url: resolved,
		});
	}

	/**
	 * 拦截 target="_blank" 的链接，让它们在当前视图内导航。
	 */
	private injectClickInterceptor(): void {
		this.webview
			.executeJavaScript(`
				(() => {
					if (window.__moyuClickBound) return;
					window.__moyuClickBound = true;
					document.addEventListener('click', (event) => {
						const target = event.target;
						if (!(target instanceof Element)) return;
						const anchor = target.closest('a[target="_blank"]');
						if (!anchor || !anchor.href) return;
						event.preventDefault();
						console.log('${OPEN_MARKER}' + anchor.href);
					}, true);
				})();
			`)
			.catch(() => {
				// 部分页面禁止注入脚本，忽略即可，链接会在页面内正常跳转。
			});
	}
}
