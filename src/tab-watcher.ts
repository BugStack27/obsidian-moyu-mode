import { WorkspaceLeaf } from 'obsidian';

interface TabWatcherOptions {
	leaf: WorkspaceLeaf;
	getDelayMs: () => number;
	onHover: () => void;
}

/**
 * 监听网页标签头的悬停，停留一段时间后切回网页。
 * 只用 WorkspaceLeaf 的 tabHeaderEl，不依赖 Obsidian 内部 CSS 类名。
 */
export class TabWatcher {
	private headerEl: HTMLElement | null = null;
	private timer: number | null = null;

	private readonly handleEnter = (): void => {
		this.schedule();
	};

	private readonly handleLeave = (): void => {
		this.cancel();
	};

	constructor(private readonly options: TabWatcherOptions) {}

	/** 绑定当前标签头；标签栏重建后再次调用即可重新绑定。 */
	attach(): void {
		const leaf = this.options.leaf as WorkspaceLeaf & { tabHeaderEl?: HTMLElement };
		const header = leaf.tabHeaderEl ?? null;
		if (header === this.headerEl) {
			return;
		}

		this.detach();
		this.headerEl = header;
		header?.addEventListener('mouseenter', this.handleEnter);
		header?.addEventListener('mouseleave', this.handleLeave);
	}

	detach(): void {
		this.cancel();
		this.headerEl?.removeEventListener('mouseenter', this.handleEnter);
		this.headerEl?.removeEventListener('mouseleave', this.handleLeave);
		this.headerEl = null;
	}

	private schedule(): void {
		this.cancel();
		this.timer = this.getWindow().setTimeout(() => {
			this.timer = null;
			this.options.onHover();
		}, Math.max(this.options.getDelayMs(), 0));
	}

	private cancel(): void {
		if (this.timer !== null) {
			this.getWindow().clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private getWindow(): Window {
		return this.headerEl?.ownerDocument.defaultView ?? window;
	}
}
