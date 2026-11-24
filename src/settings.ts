import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type MoyuPlugin from './main';

export interface SiteConfig {
	id: string;
	name: string;
	url: string;
}

export type FallbackMode = 'keep' | 'note' | 'random';

export interface MoyuSettings {
	sites: SiteConfig[];
	activeSiteId: string | null;
	fallbackMode: FallbackMode;
	fallbackNotePath: string | null;
	randomScope: 'vault' | 'folders';
	randomFolders: string[];
	pollIntervalMs: number;
	hideDelayMs: number;
	edgeTolerancePx: number;
	restoreDelayMs: number;
	hideOnBlur: boolean;
	pauseMediaOnHide: boolean;
}

export const DEFAULT_SETTINGS: MoyuSettings = {
	sites: [],
	activeSiteId: null,
	fallbackMode: 'keep',
	fallbackNotePath: null,
	randomScope: 'vault',
	randomFolders: [],
	pollIntervalMs: 100,
	hideDelayMs: 0,
	edgeTolerancePx: 6,
	restoreDelayMs: 120,
	hideOnBlur: true,
	pauseMediaOnHide: true,
};

export function normalizeUrl(value: string): string {
	return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

type NumberKey = 'pollIntervalMs' | 'hideDelayMs' | 'restoreDelayMs' | 'edgeTolerancePx';

export class MoyuSettingTab extends PluginSettingTab {
	private saveTimer: number | null = null;

	constructor(app: App, private readonly plugin: MoyuPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderSites(containerEl);
		this.renderFallback(containerEl);
		this.renderTrigger(containerEl);
	}

	private renderSites(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('网页站点').setHeading();

		const sites = this.plugin.settings.sites;
		sites.forEach((site, index) => {
			new Setting(containerEl)
				.setName(`站点 ${index + 1}`)
				.addText((text) => {
					text.setPlaceholder('名称');
					text.setValue(site.name);
					text.onChange((value) => {
						site.name = value.trim();
						this.scheduleSave(() => this.plugin.updateSiteViews());
					});
				})
				.addText((text) => {
					text.setPlaceholder('网址');
					text.setValue(site.url);
					text.onChange((value) => {
						site.url = value.trim();
						this.scheduleSave(() => this.plugin.updateSiteViews());
					});
					text.inputEl.addEventListener('blur', () => {
						if (!site.url) {
							return;
						}
						const normalized = normalizeUrl(site.url);
						if (normalized !== site.url) {
							site.url = normalized;
							text.setValue(normalized);
							this.scheduleSave(() => this.plugin.updateSiteViews());
						}
					});
				})
				.addExtraButton((button) => {
					button
						.setIcon('arrow-up')
						.setTooltip('上移')
						.setDisabled(index === 0)
						.onClick(() => {
							this.moveSite(index, -1);
						});
				})
				.addExtraButton((button) => {
					button
						.setIcon('arrow-down')
						.setTooltip('下移')
						.setDisabled(index === sites.length - 1)
						.onClick(() => {
							this.moveSite(index, 1);
						});
				})
				.addExtraButton((button) => {
					button
						.setIcon('trash')
						.setTooltip('删除')
						.onClick(() => {
							this.removeSite(site.id);
						});
				});
		});

		new Setting(containerEl)
			.setName('添加站点')
			.setDesc('添加后在网页标签的地址栏下拉里切换')
			.addButton((button) => {
				button
					.setButtonText('添加')
					.setCta()
					.onClick(() => {
						this.addSite();
					});
			});

		if (sites.length > 0) {
			new Setting(containerEl)
				.setName('默认站点')
				.setDesc('打开网页标签时默认加载的站点')
				.addDropdown((dropdown) => {
					for (const site of sites) {
						dropdown.addOption(site.id, site.name || site.url);
					}
					const active = this.plugin.settings.activeSiteId;
					if (active && sites.some((site) => site.id === active)) {
						dropdown.setValue(active);
					}
					dropdown.onChange((value) => {
						this.plugin.settings.activeSiteId = value;
						void this.plugin.saveSettings();
					});
				});
		}
	}

	private renderFallback(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('回退').setHeading();

		const settings = this.plugin.settings;
		new Setting(containerEl)
			.setName('回退方式')
			.setDesc('鼠标离开网页后显示什么')
			.addDropdown((dropdown) => {
				dropdown.addOption('keep', '保持当前笔记');
				dropdown.addOption('note', '指定笔记');
				dropdown.addOption('random', '随机笔记');
				dropdown.setValue(settings.fallbackMode);
				dropdown.onChange((value) => {
					settings.fallbackMode = value as FallbackMode;
					void this.plugin.saveSettings();
					this.display();
				});
			});

		if (settings.fallbackMode === 'note') {
			new Setting(containerEl)
				.setName('回退笔记路径')
				.setDesc('库内路径，例如 日记/2026-11-24.md')
				.addText((text) => {
					text.setPlaceholder('日记/2026-11-24.md');
					text.setValue(settings.fallbackNotePath ?? '');
					text.onChange((value) => {
						settings.fallbackNotePath = value.trim() || null;
						this.scheduleSave();
					});
				});
		}

		if (settings.fallbackMode === 'random') {
			new Setting(containerEl)
				.setName('随机范围')
				.addDropdown((dropdown) => {
					dropdown.addOption('vault', '全库');
					dropdown.addOption('folders', '指定文件夹');
					dropdown.setValue(settings.randomScope);
					dropdown.onChange((value) => {
						settings.randomScope = value === 'folders' ? 'folders' : 'vault';
						void this.plugin.saveSettings();
						this.display();
					});
				});

			if (settings.randomScope === 'folders') {
				new Setting(containerEl)
					.setName('随机文件夹')
					.setDesc('每行一个文件夹路径')
					.addTextArea((area) => {
						area.setValue(settings.randomFolders.join('\n'));
						area.onChange((value) => {
							settings.randomFolders = value
								.split(/\r?\n/)
								.map((item) => item.trim())
								.filter(Boolean);
							this.scheduleSave();
						});
					});
			}
		}
	}

	private renderTrigger(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('触发与延迟').setHeading();

		this.addNumberSetting(containerEl, '轮询间隔', '毫秒，越小反应越快', 'pollIntervalMs', 20, 1000);
		this.addNumberSetting(containerEl, '隐藏延迟', '离开后等待多久才回退', 'hideDelayMs', 0, 2000);
		this.addNumberSetting(containerEl, '恢复延迟', '标签头悬停多久才切回', 'restoreDelayMs', 0, 2000);
		this.addNumberSetting(containerEl, '边缘容错', '像素，避免边缘抖动', 'edgeTolerancePx', 0, 40);

		new Setting(containerEl)
			.setName('失焦时回退')
			.setDesc('切换到其他应用时直接回退')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.hideOnBlur).onChange((value) => {
					this.plugin.settings.hideOnBlur = value;
					void this.plugin.saveSettings();
					this.plugin.applySettings();
				});
			});

		new Setting(containerEl)
			.setName('回退时暂停媒体')
			.setDesc('暂停视频/音频并静音')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.pauseMediaOnHide).onChange((value) => {
					this.plugin.settings.pauseMediaOnHide = value;
					void this.plugin.saveSettings();
				});
			});
	}

	private addNumberSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: NumberKey,
		min: number,
		max: number,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = String(min);
				text.inputEl.max = String(max);
				text.setValue(String(this.plugin.settings[key]));
				text.onChange((value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed)) {
						return;
					}
					this.plugin.settings[key] = Math.min(max, Math.max(min, Math.round(parsed)));
					this.scheduleSave(() => this.plugin.applySettings());
				});
			});
	}

	private moveSite(index: number, delta: number): void {
		const sites = this.plugin.settings.sites;
		const target = index + delta;
		if (target < 0 || target >= sites.length) {
			return;
		}
		const [site] = sites.splice(index, 1);
		if (!site) {
			return;
		}
		sites.splice(target, 0, site);
		void this.plugin.saveSettings();
		this.plugin.updateSiteViews();
		this.display();
	}

	private removeSite(id: string): void {
		const settings = this.plugin.settings;
		settings.sites = settings.sites.filter((site) => site.id !== id);
		if (settings.activeSiteId === id) {
			settings.activeSiteId = settings.sites[0]?.id ?? null;
		}
		void this.plugin.saveSettings();
		this.plugin.updateSiteViews();
		this.display();
		new Notice('已删除站点');
	}

	private addSite(): void {
		const settings = this.plugin.settings;
		settings.sites.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			name: '新站点',
			url: '',
		});
		void this.plugin.saveSettings();
		this.plugin.updateSiteViews();
		this.display();
	}

	private scheduleSave(after?: () => void): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.saveSettings().then(after);
		}, 400);
	}
}
