import { DropdownComponent, ItemView, setIcon, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import type MoyuPlugin from './main';
import { WindowFocusWatcher } from './focus-watcher';
import { MouseWatcher } from './mouse-watcher';
import { SiteConfig } from './settings';
import { TabWatcher } from './tab-watcher';
import { NavigationState, WebviewPane } from './webview-pane';

export const VIEW_TYPE_MOYU_WEB = 'moyu-webview';

export class MoyuWebView extends ItemView {
	private siteId: string | null = null;
	private pane: WebviewPane | null = null;
	private dropdown: DropdownComponent | null = null;
	private watcher: MouseWatcher | null = null;
	private tabWatcher: TabWatcher | null = null;
	private focusWatcher: WindowFocusWatcher | null = null;
	private windowFocused = true;
	private mediaPaused = false;
	private backButton: HTMLButtonElement | null = null;
	private forwardButton: HTMLButtonElement | null = null;
	private addressEl: HTMLElement | null = null;
	private eventsBound = false;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: MoyuPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_MOYU_WEB;
	}

	getDisplayText(): string {
		return this.findSite(this.siteId)?.name ?? '网页';
	}

	getIcon(): string {
		return 'globe';
	}

	getState(): Record<string, unknown> {
		return { siteId: this.siteId };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (state && typeof state === 'object' && 'siteId' in state) {
			const siteId = (state as { siteId?: unknown }).siteId;
			if (typeof siteId === 'string') {
				this.siteId = siteId;
			}
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		this.disposeWatchers();
		this.contentEl.empty();
		this.contentEl.addClass('moyu-view');
		this.backButton = null;
		this.forwardButton = null;
		this.addressEl = null;
		this.backButton = null;
		this.forwardButton = null;

		const sites = this.plugin.settings.sites;
		this.siteId = this.resolveSiteId(sites);
		this.bindWorkspaceEvents();

		if (sites.length === 0) {
			this.renderEmptyState();
			return;
		}

		this.buildToolbar(sites);
		this.mountPane(sites);
		this.createTabWatcher();
		this.createWatcher();
		this.createFocusWatcher();
		this.syncVisibility();
		if (this.app.workspace.getActiveViewOfType(MoyuWebView) === this) {
			this.pane?.focus();
		}
	}

	async onClose(): Promise<void> {
		this.disposeWatchers();
		this.pane?.destroy();
		this.pane = null;
		this.dropdown = null;
		this.contentEl.removeClass('moyu-view');
	}

	/** 站点列表变化后重建界面，例如新增站点或修改配置。 */
	async refresh(): Promise<void> {
		this.disposeWatchers();
		this.pane?.destroy();
		this.pane = null;
		this.dropdown = null;
		await this.onOpen();
		this.refreshTabHeader();
	}

	/** 停止鼠标轮询、标签头监听与窗口焦点监听，插件卸载或视图关闭时调用。 */
	disposeWatchers(): void {
		this.watcher?.stop();
		this.watcher = null;
		this.tabWatcher?.detach();
		this.tabWatcher = null;
		this.focusWatcher?.detach();
		this.focusWatcher = null;
		this.windowFocused = true;
		this.mediaPaused = false;
	}

	/** 轮询参数变化后即时生效，不重建 webview。 */
	applySettings(): void {
		this.watcher?.restart();
	}

	/** 站点列表变化后同步下拉列表、标签标题与当前地址，不重建 webview。 */
	updateSites(): void {
		const sites = this.plugin.settings.sites;
		if (sites.length === 0 || !this.pane) {
			void this.refresh();
			return;
		}

		this.siteId = this.resolveSiteId(sites);
		this.rebuildDropdown(sites);

		const site = this.findSite(this.siteId);
		if (site && site.url !== this.pane.getUrl()) {
			void this.pane.load(site.url);
		}
		this.refreshTabHeader();
	}

	private resolveSiteId(sites: SiteConfig[]): string | null {
		if (sites.length === 0) {
			return null;
		}
		if (this.siteId && sites.some((site) => site.id === this.siteId)) {
			return this.siteId;
		}
		if (this.plugin.settings.activeSiteId && sites.some((site) => site.id === this.plugin.settings.activeSiteId)) {
			return this.plugin.settings.activeSiteId;
		}
		return sites[0]?.id ?? null;
	}

	private buildToolbar(sites: SiteConfig[]): void {
		const toolbar = this.contentEl.createDiv({ cls: 'moyu-toolbar' });

		this.dropdown = new DropdownComponent(toolbar);
		this.dropdown.onChange((value) => {
			void this.switchSite(value);
		});
		this.rebuildDropdown(sites);

		this.addressEl = toolbar.createDiv({ cls: 'moyu-address' });

		this.backButton = this.createNavButton(toolbar, 'arrow-left', '后退', () => {
			this.pane?.goBack();
		});
		this.forwardButton = this.createNavButton(toolbar, 'arrow-right', '前进', () => {
			this.pane?.goForward();
		});

		const refresh = toolbar.createEl('button', {
			cls: 'clickable-icon moyu-refresh',
			attr: { 'aria-label': '刷新网页' },
		});
		setIcon(refresh, 'refresh-cw');
		refresh.addEventListener('click', () => {
			this.pane?.reload();
		});
	}

	private createNavButton(
		toolbar: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const button = toolbar.createEl('button', {
			cls: 'clickable-icon moyu-nav',
			attr: { 'aria-label': label },
		});
		setIcon(button, icon);
		button.disabled = true;
		button.addEventListener('click', onClick);
		return button;
	}

	private updateNavigation(state: NavigationState): void {
		if (this.backButton) {
			this.backButton.disabled = !state.canGoBack;
		}
		if (this.forwardButton) {
			this.forwardButton.disabled = !state.canGoForward;
		}
		if (this.addressEl) {
			this.addressEl.setText(state.url);
			this.addressEl.title = state.url;
		}
	}

	private rebuildDropdown(sites: SiteConfig[]): void {
		if (!this.dropdown) {
			return;
		}
		this.dropdown.selectEl.empty();
		for (const site of sites) {
			this.dropdown.addOption(site.id, site.name);
		}
		if (this.siteId) {
			this.dropdown.setValue(this.siteId);
		}
	}

	private mountPane(sites: SiteConfig[]): void {
		const body = this.contentEl.createDiv({ cls: 'moyu-body' });
		this.pane = new WebviewPane(body, {
			onOpenUrl: (url) => {
				void this.pane?.load(url);
			},
			onNavigate: (state) => {
				this.updateNavigation(state);
			},
		});

		const site = this.findSite(this.siteId);
		if (site) {
			void this.pane.load(site.url);
		}
	}

	private renderEmptyState(): void {
		this.contentEl.createDiv({ cls: 'moyu-empty' }, (empty) => {
			empty.createEl('p', { text: '还没有配置网页。' });
			empty.createEl('p', {
				cls: 'moyu-empty-hint',
				text: '在插件设置里添加站点后即可在这个标签里浏览。',
			});
			const button = empty.createEl('button', { cls: 'mod-cta', text: '打开设置' });
			button.addEventListener('click', () => {
				const setting = (
					this.app as unknown as {
						setting?: { open(): void; openTabById(id: string): void };
					}
				).setting;
				setting?.open();
				setting?.openTabById(this.plugin.manifest.id);
			});
		});
	}

	private async switchSite(siteId: string): Promise<void> {
		const site = this.findSite(siteId);
		if (!site) {
			return;
		}
		this.siteId = site.id;
		this.plugin.settings.activeSiteId = site.id;
		await this.plugin.saveSettings();
		await this.pane?.load(site.url);
		this.refreshTabHeader();
	}

	private refreshTabHeader(): void {
		const leaf = this.leaf as unknown as { updateHeader?: () => void };
		leaf.updateHeader?.();
	}

	/** 监听本视图的激活/失活，重复 onOpen 时不会重复绑定。 */
	private bindWorkspaceEvents(): void {
		if (this.eventsBound) {
			return;
		}
		this.eventsBound = true;
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf === this.leaf) {
					this.pane?.focus();
				}
				this.tabWatcher?.attach();
				this.syncVisibility();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.tabWatcher?.attach();
				this.syncVisibility();
			}),
		);
	}

	/**
	 * 可见时轮询鼠标，切到别的标签后停止轮询；隐藏或窗口失焦时暂停媒体。
	 * 分屏时视图即使不是激活 leaf 也仍然可见，此时判定要继续工作。
	 */
	private syncVisibility(): void {
		if (!this.pane) {
			return;
		}
		if (this.contentEl.isShown()) {
			this.watcher?.start();
		} else {
			this.watcher?.stop();
		}
		this.applyMediaState();
	}

	/** 视图可见且窗口处于激活状态时才发声，其余情况按开关暂停并静音。 */
	private applyMediaState(): void {
		if (!this.pane) {
			return;
		}
		if (this.windowFocused && this.contentEl.isShown()) {
			this.pane.setMuted(false);
			if (this.mediaPaused) {
				this.mediaPaused = false;
				this.pane.resumeMedia();
			}
			return;
		}
		if (this.plugin.settings.pauseMediaOnHide) {
			this.mediaPaused = true;
			this.pane.pauseMedia();
			this.pane.setMuted(true);
		}
	}

	private createWatcher(): void {
		this.watcher = new MouseWatcher({
			doc: this.contentEl.ownerDocument,
			getRect: () => this.getWatchRect(),
			intervalMs: () => this.plugin.settings.pollIntervalMs,
			hideDelayMs: () => this.plugin.settings.hideDelayMs,
			tolerancePx: () => this.plugin.settings.edgeTolerancePx,
			hideOnBlur: () => this.plugin.settings.hideOnBlur,
			isBlocked: () => this.contentEl.ownerDocument.querySelector('.modal-container') !== null,
			onLeave: () => {
				this.plugin.handleMouseLeave(this.leaf);
			},
		});
	}

	private createFocusWatcher(): void {
		this.focusWatcher = new WindowFocusWatcher({
			win: this.contentEl.ownerDocument.defaultView ?? window,
			isGuestFocused: () => this.pane?.isFocused() ?? false,
			onChange: (focused) => {
				this.windowFocused = focused;
				this.syncVisibility();
			},
		});
		this.focusWatcher.attach();
	}

	private createTabWatcher(): void {
		this.tabWatcher = new TabWatcher({
			leaf: this.leaf,
			getDelayMs: () => this.plugin.settings.restoreDelayMs,
			onHover: () => {
				this.activateSelf();
			},
		});
		this.tabWatcher.attach();
	}

	private activateSelf(): void {
		if (this.app.workspace.getActiveViewOfType(MoyuWebView) === this) {
			return;
		}
		this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
	}

	/** 判定区域 = 内容区 ∪ 网页标签头，保证从标签头切回后不会立刻被判为离开。 */
	private getWatchRect(): DOMRect | null {
		const content = this.contentEl.getBoundingClientRect();
		if (content.width <= 0 || content.height <= 0) {
			return null;
		}

		// 实时取标签头：标签栏重建后缓存的元素可能是已脱离文档的旧节点。
		const leaf = this.leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement };
		const header = leaf.tabHeaderEl?.getBoundingClientRect() ?? null;
		if (!header || header.width <= 0 || header.height <= 0) {
			return content;
		}

		const left = Math.min(content.left, header.left);
		const top = Math.min(content.top, header.top);
		const right = Math.max(content.right, header.right);
		const bottom = Math.max(content.bottom, header.bottom);
		return new DOMRect(left, top, right - left, bottom - top);
	}

	private findSite(siteId: string | null): SiteConfig | undefined {
		if (!siteId) {
			return undefined;
		}
		return this.plugin.settings.sites.find((site) => site.id === siteId);
	}
}
