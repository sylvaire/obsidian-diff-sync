import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/glob';
import { formatBytes } from './naming';
import { SyncSettings, DEFAULT_SETTINGS } from './settings';
import type DiffSyncPlugin from './main';

export class DiffSyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: DiffSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('Diff Sync (WebDAV)').setHeading();
		containerEl.createEl('p', {
			text:
				'内容定义分块差分同步：只有变化的块会被传输。' +
				'两端同时修改同一文件时会保留两个版本，不会静默覆盖。',
			cls: 'setting-item-description',
		});

		this.renderConnection();
		this.renderSecurity();
		this.renderSyncBehaviour();
		this.renderSyncScope();
		this.renderAdvanced();
		this.renderMaintenance();
	}

	// ------------------------------------------------------------- connection

	private renderConnection(): void {
		const { containerEl } = this;

		new Setting(containerEl).setName('WebDAV').setHeading();

		new Setting(containerEl)
			.setName('服务器地址')
			.setDesc('包含目标目录的完整 URL，例如 https://dav.jianguoyun.com/dav/obsidian-sync')
			.addText((text) =>
				text
					.setPlaceholder('https://dav.jianguoyun.com/dav/obsidian-sync')
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('用户名')
			.addText((text) =>
				text.setValue(this.plugin.settings.username).onChange(async (value) => {
					this.plugin.settings.username = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('密码 / 应用密码')
			.setDesc('坚果云等多数服务要求使用「应用密码」，而不是登录密码。')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setValue(this.plugin.settings.password).onChange(async (value) => {
					this.plugin.settings.password = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('远端子目录')
			.setDesc('在服务器地址下再建一层目录，多台设备必须填写相同值。')
			.addText((text) =>
				text
					.setPlaceholder('diff-sync')
					.setValue(this.plugin.settings.remoteDir)
					.onChange(async (value) => {
						this.plugin.settings.remoteDir = value.trim() || 'diff-sync';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('会创建并删除一个临时文件，用来验证读写与条件写入支持。')
			.addButton((button) =>
				button.setButtonText('测试').onClick(async () => {
					button.setDisabled(true).setButtonText('测试中…');
					try {
						const message = await this.plugin.testConnection();
						new Notice(`Diff Sync：${message}`, 8_000);
					} catch (error) {
						new Notice(
							`Diff Sync 连接失败：${error instanceof Error ? error.message : String(error)}`,
							12_000,
						);
					} finally {
						button.setDisabled(false).setButtonText('测试');
					}
				}),
			);
	}

	// --------------------------------------------------------------- security

	private renderSecurity(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('安全').setHeading();

		new Setting(containerEl)
			.setName('端到端加密')
			.setDesc(
				'用口令加密所有远端分块与索引。' +
					'加密状态由远端 meta.json 决定，切换需要清空远端目录。',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.encryptionEnabled).onChange(async (value) => {
					this.plugin.settings.encryptionEnabled = value;
					if (!value) {
						this.plugin.settings.encryptionSalt = '';
						this.plugin.settings.encryptionIterations = 0;
						this.plugin.settings.encryptionVerifier = '';
					}
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.encryptionEnabled) {
			containerEl.createEl('p', {
				cls: 'setting-item-description mod-warning',
				text: '口令不会保存到磁盘或远端。忘记口令意味着远端数据无法恢复。',
			});
		}
	}

	// ------------------------------------------------------------- behaviour

	private renderSyncBehaviour(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('同步时机').setHeading();

		new Setting(containerEl)
			.setName('启动时自动同步')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncOnStart).onChange(async (value) => {
					this.plugin.settings.autoSyncOnStart = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('定时同步间隔')
			.setDesc('单位分钟，0 表示关闭定时同步。')
			.addText((text) =>
				text.setValue(String(this.plugin.settings.autoSyncIntervalMinutes)).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed < 0) return;
					this.plugin.settings.autoSyncIntervalMinutes = Math.round(parsed);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('文件变更后自动同步')
			.setDesc('不推荐在大库长期开启：每次编辑都会触发一次扫描。')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncOnFileChange).onChange(async (value) => {
					this.plugin.settings.syncOnFileChange = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.syncOnFileChange) {
			new Setting(containerEl)
				.setName('变更合并延迟（秒）')
				.setDesc('最后一次编辑后等待多久再同步，避免连续输入触发多次同步。')
				.addText((text) =>
					text
						.setValue(String(Math.round(this.plugin.settings.syncOnFileChangeDelayMs / 1000)))
						.onChange(async (value) => {
							const parsed = Number(value);
							if (!Number.isFinite(parsed) || parsed < 2) return;
							this.plugin.settings.syncOnFileChangeDelayMs = Math.round(parsed * 1000);
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName('设备名称')
			.setDesc('用于命名冲突副本，避免两台设备生成同名文件。')
			.addText((text) =>
				text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
					this.plugin.settings.deviceName = value.trim() || 'device';
					await this.plugin.saveSettings();
				}),
			);
	}

	// ------------------------------------------------------------------ scope

	private renderSyncScope(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('同步范围').setHeading();

		new Setting(containerEl)
			.setName('排除规则')
			.setDesc('一行一个 glob，支持 ** 匹配多级目录。')
			.addTextArea((area) => {
				area.inputEl.rows = 8;
				area.inputEl.classList.add('diff-sync-excludes');
				area.setValue(this.plugin.settings.excludePatterns.join('\n')).onChange(async (value) => {
					this.plugin.settings.excludePatterns = value
						.split('\n')
						.map((line) => line.trim())
						.filter((line) => line.length > 0);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('恢复默认排除规则')
			.addButton((button) =>
				button.setButtonText('恢复').onClick(async () => {
					this.plugin.settings.excludePatterns = [...DEFAULT_EXCLUDE_PATTERNS];
					await this.plugin.saveSettings();
					this.display();
				}),
			);
	}

	// --------------------------------------------------------------- advanced

	private renderAdvanced(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('高级').setHeading();

		new Setting(containerEl)
			.setName('并发请求数')
			.setDesc('同时下载/上传的分块数，坚果云建议不超过 4。')
			.addSlider((slider) =>
				slider
					.setLimits(1, 12, 1)
					.setValue(this.plugin.settings.requestConcurrency)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.requestConcurrency = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('平均分块大小 (KB)')
			.setDesc(
				'越小差分越精细，但远端文件数越多。修改后已有文件会重新分块（首次同步会较慢）。',
			)
			.addSlider((slider) =>
				slider
					.setLimits(2, 64, 2)
					.setValue(this.plugin.settings.chunkSizeKb)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkSizeKb = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('允许批量删除')
			.setDesc(
				'关闭时，单次同步删除超过 25% 的文件会被中止，防止远端索引异常导致本地被清空。',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.allowMassDelete).onChange(async (value) => {
					this.plugin.settings.allowMassDelete = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('保留本地历史快照')
			.setDesc('下载覆盖本地文件前，把旧版本存入 .diff-sync-history/（不计入同步）。')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.keepHistory).onChange(async (value) => {
					this.plugin.settings.keepHistory = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.keepHistory) {
			new Setting(containerEl)
				.setName('保留快照数量')
				.addSlider((slider) =>
					slider
						.setLimits(1, 100, 1)
						.setValue(this.plugin.settings.historyLimit)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.historyLimit = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName('状态栏显示')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
					this.plugin.settings.showStatusBar = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('启动时打开同步面板')
			.setDesc('在右侧边栏显示带「立即同步」按钮的面板。')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showPanelOnStart).onChange(async (value) => {
					this.plugin.settings.showPanelOnStart = value;
					await this.plugin.saveSettings();
					if (value) await this.plugin.activatePanel();
				}),
			);

		new Setting(containerEl)
			.setName('详细日志')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.verboseLogging).onChange(async (value) => {
					this.plugin.settings.verboseLogging = value;
					await this.plugin.saveSettings();
				}),
			);
	}

	// ------------------------------------------------------------ maintenance

	private renderMaintenance(): void {
		const { containerEl } = this;
		new Setting(containerEl).setName('维护').setHeading();

		const cacheRow = new Setting(containerEl)
			.setName('本地分块缓存')
			.setDesc('加载中…');

		void this.plugin
			.getCache()
			.size()
			.then(({ count, bytes }) => {
				cacheRow.setDesc(`${count} 个分块，占用 ${formatBytes(bytes)}`);
			})
			.catch(() => cacheRow.setDesc('无法读取缓存信息'));

		cacheRow.addButton((button) =>
			button.setButtonText('清空缓存').onClick(async () => {
				await this.plugin.getCache().clear();
				new Notice('已清空本地分块缓存');
				this.display();
			}),
		);

		new Setting(containerEl).setName('同步状态').addButton((button) =>
			button.setButtonText('立即同步').setCta().onClick(async () => {
				await this.plugin.sync();
			}),
		);

		const result = this.plugin.lastSyncResult();
		if (result) {
			const s = result.summary;
			const list = containerEl.createDiv({ cls: 'setting-item-description' });
			list.createEl('p', {
				text:
					`上次同步：上传 ${s.uploadedFiles} / 下载 ${s.downloadedFiles} / ` +
					`删除 ${s.deletedLocal + s.deletedRemote} / 冲突 ${s.conflicts}`,
			});
			list.createEl('p', {
				text:
					`传输 ${formatBytes(s.bytesUploaded + s.bytesDownloaded)}，` +
					`全量需 ${formatBytes(s.naiveBytes)}，清理 ${s.gcRemoved} 个分块`,
			});
			if (s.errors.length > 0) {
				list.createEl('p', { cls: 'mod-warning', text: `错误：${s.errors.join('；')}` });
			}
		}

		new Setting(containerEl)
			.setName('重置本地同步状态')
			.setDesc('删除本地合并基线，下次同步会当作首次同步（不会删除任何笔记）。')
			.addButton((button) =>
				button
					.setButtonText('重置')
					.setWarning()
					.onClick(async () => {
						if (!(await confirmWithModal(this.app, '重置本地同步状态？'))) return;
						await this.plugin.resetLocalState();
						new Notice('已重置本地同步状态');
						this.display();
					}),
			);
	}
}

function confirmWithModal(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new ConfirmModal(app, message, resolve);
		modal.open();
	});
}

import { Modal } from 'obsidian';

class ConfirmModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly message: string,
		private readonly resolve: (value: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.message });
		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		buttons.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
		buttons.createEl('button', { text: '确定', cls: 'mod-warning' }).addEventListener('click', () => {
			this.answered = true;
			this.resolve(true);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve(false);
	}
}

export type { SyncSettings, DEFAULT_SETTINGS };
