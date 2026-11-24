import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { FallbackManager } from './fallback';
import { MoyuWebView, VIEW_TYPE_MOYU_WEB } from './moyu-view';
import { DEFAULT_SETTINGS, MoyuSettings, MoyuSettingTab } from './settings';

export default class MoyuPlugin extends Plugin {
	settings!: MoyuSettings;
	fallback!: FallbackManager;
	/** 进入网页前最近一次激活的笔记 leaf，供 keep 模式回退使用。 */
	lastNoteLeaf: WorkspaceLeaf | null = null;
	/** 最近打开过的笔记文件，作为没有可用笔记标签时的兜底。 */
	lastNoteFile: TFile | null = null;

	async onload() {
		await this.loadSettings();
		this.fallback = new FallbackManager(this.app, this);
		this.registerView(VIEW_TYPE_MOYU_WEB, (leaf) => new MoyuWebView(leaf, this));

		this.lastNoteFile = this.app.workspace.getActiveFile();
		if (!this.lastNoteFile) {
			const recent = this.app.workspace
				.getLastOpenFiles()
				.find((path) => path.endsWith('.md'));
			const file = recent ? this.app.vault.getAbstractFileByPath(recent) : null;
			if (file instanceof TFile) {
				this.lastNoteFile = file;
			}
		}

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) {
					this.lastNoteFile = file;
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.lastNoteLeaf = leaf;
					this.lastNoteFile = leaf.view.file ?? this.lastNoteFile;
				}
			}),
		);

		this.addRibbonIcon('globe', '打开网页标签', () => {
			void this.openWebTab();
		});

		this.addCommand({
			id: 'open-web-tab',
			name: '打开网页标签',
			callback: () => {
				void this.openWebTab();
			},
		});

		this.addSettingTab(new MoyuSettingTab(this.app, this));
	}

	onunload(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MOYU_WEB)) {
			const view = leaf.view;
			if (view instanceof MoyuWebView) {
				view.disposeWatchers();
			}
		}
	}

	handleMouseLeave(webLeaf: WorkspaceLeaf): void {
		this.fallback.trigger(webLeaf).catch((error) => {
			console.error('摸鱼模式：回退失败', error);
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MoyuSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async openWebTab(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MOYU_WEB)[0];
		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			return;
		}

		if (this.settings.sites.length === 0) {
			new Notice('还没有配置网页，先添加一个站点');
		}

		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_MOYU_WEB,
			active: true,
			state: { siteId: this.settings.activeSiteId },
		});
	}

	/** 轮询/延迟类参数变化后即时生效。 */
	applySettings(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MOYU_WEB)) {
			const view = leaf.view;
			if (view instanceof MoyuWebView) {
				view.applySettings();
			}
		}
	}

	/** 站点列表变化后同步所有网页标签，不重建视图。 */
	updateSiteViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MOYU_WEB)) {
			const view = leaf.view;
			if (view instanceof MoyuWebView) {
				view.updateSites();
			}
		}
	}
}
