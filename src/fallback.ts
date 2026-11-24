import { App, MarkdownView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type MoyuPlugin from './main';

const RECENT_LIMIT = 10;

/**
 * 回退策略：把网页标签所在标签组切到一篇笔记上。
 * 网页视图仍然留在后台，重新切回时不需要重新加载。
 */
export class FallbackManager {
	private fallbackLeaf: WorkspaceLeaf | null = null;
	private recentPaths: string[] = [];

	constructor(private readonly app: App, private readonly plugin: MoyuPlugin) {}

	async trigger(webLeaf: WorkspaceLeaf): Promise<void> {
		switch (this.plugin.settings.fallbackMode) {
			case 'keep':
				await this.activateKeep(webLeaf);
				break;
			case 'note':
				await this.activateConfiguredNote(webLeaf);
				break;
			case 'random':
				await this.activateRandomNote(webLeaf);
				break;
		}
	}

	private async activateKeep(webLeaf: WorkspaceLeaf): Promise<void> {
		const preferred = this.plugin.lastNoteLeaf;
		if (preferred && preferred !== webLeaf && this.isAlive(preferred)) {
			if (await this.activateLeafNote(webLeaf, preferred)) {
				return;
			}
		}

		// 会话里没有激活过笔记时，退而使用工作区里已经打开的笔记标签。
		const openNote = this.findNoteLeaf(webLeaf);
		if (openNote && (await this.activateLeafNote(webLeaf, openNote))) {
			return;
		}

		// 连打开的笔记标签都没有，就用最近打开过的笔记文件。
		const lastFile = this.plugin.lastNoteFile;
		const alive = lastFile ? this.app.vault.getAbstractFileByPath(lastFile.path) : null;
		if (alive instanceof TFile) {
			await this.openInFallback(webLeaf, alive);
			return;
		}

		new Notice('没有可回退的笔记');
	}

	private async activateLeafNote(webLeaf: WorkspaceLeaf, target: WorkspaceLeaf): Promise<boolean> {
		// 同一个标签组里直接切过去，不动文件内容。
		if (target.parent === webLeaf.parent) {
			this.fallbackLeaf = target;
			this.app.workspace.setActiveLeaf(target, { focus: true });
			return true;
		}

		const file = target.view instanceof MarkdownView ? target.view.file : null;
		if (!file) {
			return false;
		}
		await this.openInFallback(webLeaf, file);
		return true;
	}

	private findNoteLeaf(webLeaf: WorkspaceLeaf): WorkspaceLeaf | null {
		let sameGroup: WorkspaceLeaf | null = null;
		let other: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf === webLeaf || !(leaf.view instanceof MarkdownView) || !leaf.view.file) {
				return;
			}
			if (leaf.parent === webLeaf.parent) {
				if (!sameGroup) {
					sameGroup = leaf;
				}
			} else if (!other) {
				other = leaf;
			}
		});
		return sameGroup ?? other;
	}

	private async activateConfiguredNote(webLeaf: WorkspaceLeaf): Promise<void> {
		const path = this.plugin.settings.fallbackNotePath;
		if (!path) {
			new Notice('还没有设置回退笔记');
			await this.activateKeep(webLeaf);
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`回退笔记不存在：${path}`);
			await this.activateKeep(webLeaf);
			return;
		}
		await this.openInFallback(webLeaf, file);
	}

	private async activateRandomNote(webLeaf: WorkspaceLeaf): Promise<void> {
		const file = this.pickRandom();
		if (!file) {
			await this.activateKeep(webLeaf);
			return;
		}
		await this.openInFallback(webLeaf, file);
	}

	private async openInFallback(webLeaf: WorkspaceLeaf, file: TFile): Promise<void> {
		const leaf = this.ensureFallbackLeaf(webLeaf);
		await leaf.openFile(file, { active: true });
	}

	/** 回退标签固定在同组内复用；被关掉或换了组时重新找/建一个。 */
	private ensureFallbackLeaf(webLeaf: WorkspaceLeaf): WorkspaceLeaf {
		const existing = this.fallbackLeaf;
		if (
			existing &&
			existing !== webLeaf &&
			existing.parent === webLeaf.parent &&
			this.isAlive(existing)
		) {
			return existing;
		}

		let sameGroupNote: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (sameGroupNote || leaf === webLeaf || leaf.parent !== webLeaf.parent) {
				return;
			}
			if (leaf.view instanceof MarkdownView) {
				sameGroupNote = leaf;
			}
		});
		if (sameGroupNote) {
			this.fallbackLeaf = sameGroupNote;
			return sameGroupNote;
		}

		// getLeaf('tab') 在激活 leaf 所在的标签组里新建标签，先临时切到网页标签。
		this.app.workspace.setActiveLeaf(webLeaf, { focus: false });
		const leaf = this.app.workspace.getLeaf('tab');
		this.fallbackLeaf = leaf;
		return leaf;
	}

	private isAlive(target: WorkspaceLeaf): boolean {
		let alive = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf === target) {
				alive = true;
			}
		});
		return alive;
	}

	private pickRandom(): TFile | null {
		const candidates = this.collectCandidates();
		if (candidates.length === 0) {
			return null;
		}

		const fresh = candidates.filter((file) => !this.recentPaths.includes(file.path));
		const lastPath = this.recentPaths[this.recentPaths.length - 1];
		const pool =
			fresh.length > 0
				? fresh
				: candidates.filter((file) => file.path !== lastPath);
		const source = pool.length > 0 ? pool : candidates;

		const file = source[Math.floor(Math.random() * source.length)] ?? null;
		if (file) {
			this.remember(file.path);
		}
		return file;
	}

	private collectCandidates(): TFile[] {
		const all = this.app.vault.getMarkdownFiles();
		if (this.plugin.settings.randomScope !== 'folders') {
			return all;
		}

		const folders = this.plugin.settings.randomFolders;
		if (folders.length === 0) {
			return [];
		}
		return all.filter((file) =>
			folders.some(
				(folder) => file.path === folder || file.path.startsWith(`${folder}/`),
			),
		);
	}

	private remember(path: string): void {
		this.recentPaths.push(path);
		if (this.recentPaths.length > RECENT_LIMIT) {
			this.recentPaths.splice(0, this.recentPaths.length - RECENT_LIMIT);
		}
	}
}
