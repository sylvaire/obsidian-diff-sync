import { App, Modal, Notice, PluginSettingTab } from 'obsidian';
import type { SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/glob';
import { formatBytes } from './naming';
import type { SyncSettings } from './settings';
import type DiffSyncPlugin from './main';

export class DiffSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: DiffSyncPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		return [
			{
				type: 'group',
				heading: 'WebDAV',
				items: [
					{
						name: '服务器地址',
						desc: '填入包含目标目录的完整 WebDAV URL。',
						render: (row) => {
							row.addText((text) => text
								.setPlaceholder('https://dav.jianguoyun.com/dav/obsidian-sync')
								.setValue(settings.serverUrl)
								.onChange(async (value) => {
									settings.serverUrl = value.trim();
									await save();
								}));
						},
					},
					{
						name: '用户名',
						control: { type: 'text', key: 'username' },
					},
					{
						name: '密码 / 应用密码',
						desc: '坚果云等服务要求使用应用密码。',
						render: (row) => {
							row.addText((text) => {
								text.inputEl.type = 'password';
								text.setValue(settings.password).onChange(async (value) => {
									settings.password = value;
									await save();
								});
							});
						},
					},
					{
						name: '远端子目录',
						desc: '多台设备必须填写相同的远端子目录。',
						render: (row) => {
							row.addText((text) => text.setPlaceholder('diff-sync')
								.setValue(settings.remoteDir).onChange(async (value) => {
									settings.remoteDir = value.trim() || 'diff-sync';
									await save();
								}));
						},
					},
					{
						name: '测试连接',
						desc: '创建并删除临时文件以验证服务器的读写与条件写入能力。',
						render: (row) => {
							row.addButton((button) => button.setButtonText('测试').onClick(async () => {
								button.setDisabled(true).setButtonText('测试中…');
								try {
									new Notice(`Diff Sync：${await this.plugin.testConnection()}`, 8_000);
								} catch (error) {
									new Notice(`Diff Sync 连接失败：${error instanceof Error ? error.message : String(error)}`, 12_000);
								} finally {
									button.setDisabled(false).setButtonText('测试');
								}
							}));
						},
					},
				],
			},
			{
				type: 'group',
				heading: '安全',
				items: [
					{
						name: '端到端加密',
						desc: '加密状态由远端 meta.json 决定，切换前需要清空远端目录。',
						render: (row) => {
							row.addToggle((toggle) => toggle.setValue(settings.encryptionEnabled).onChange(async (value) => {
								settings.encryptionEnabled = value;
								if (!value) {
									settings.encryptionSalt = '';
									settings.encryptionIterations = 0;
									settings.encryptionVerifier = '';
								}
								await save();
								this.refreshDomState();
							}));
						},
					},
					{
						name: '加密口令',
						desc: '口令不会保存到磁盘或远端。忘记口令意味着远端数据无法恢复。',
						visible: () => settings.encryptionEnabled,
					},
				],
			},
			{
				type: 'group',
				heading: '同步时机',
				items: [
					{ name: '启动时自动同步', control: { type: 'toggle', key: 'autoSyncOnStart' } },
					this.numberSetting('定时同步间隔', '单位分钟，0 表示关闭。', 'autoSyncIntervalMinutes', 0),
					{
						name: '文件变更后自动同步',
						desc: '每次编辑都会触发扫描，大库开启后可能增加负载。',
						control: { type: 'toggle', key: 'syncOnFileChange' },
					},
					{
						...this.numberSetting('变更合并延迟（秒）', '最后一次编辑后等待多久再同步。', 'syncOnFileChangeDelayMs', 2, 1000),
						visible: () => settings.syncOnFileChange,
					},
					{
						name: '设备名称',
						desc: '用于命名冲突副本，避免设备之间生成同名文件。',
						render: (row) => {
							row.addText((text) => text.setValue(settings.deviceName).onChange(async (value) => {
								settings.deviceName = value.trim() || 'device';
								await save();
							}));
						},
					},
				],
			},
			{
				type: 'group',
				heading: '同步范围',
				items: [
					{
						name: '排除规则',
						desc: '一行一个 glob，支持 ** 匹配多级目录。',
						render: (row) => {
							row.addTextArea((area) => {
								area.inputEl.rows = 8;
								area.inputEl.classList.add('diff-sync-excludes');
								area.setValue(settings.excludePatterns.join('\n')).onChange(async (value) => {
									settings.excludePatterns = value.split('\n').map((line) => line.trim()).filter(Boolean);
									await save();
								});
							});
						},
					},
					{
						name: '恢复默认排除规则',
						render: (row) => {
							row.addButton((button) => button.setButtonText('恢复').onClick(async () => {
								settings.excludePatterns = [...DEFAULT_EXCLUDE_PATTERNS];
								await save();
								this.update();
							}));
						},
					},
				],
			},
			{
				type: 'group',
				heading: '高级',
				items: [
					{
						name: '冲突覆盖策略',
						desc: '决定哪个版本沿用原文件名，另一份会保存为冲突副本。按大小覆盖时，同样大小按时间判断。',
						control: {
							type: 'dropdown',
							key: 'conflictStrategy',
							options: { time: '按时间覆盖', size: '按大小覆盖（较大优先）' },
						},
					},
					{
						name: '并发请求数',
						desc: '同时下载或上传的分块数，坚果云建议不超过 4。',
						control: { type: 'slider', key: 'requestConcurrency', min: 1, max: 12, step: 1 },
					},
					{
						name: '平均分块大小 (KB)',
						desc: '较小的块可减少差分传输量，但会增加远端文件数。修改后已有文件会重新分块。',
						control: { type: 'slider', key: 'chunkSizeKb', min: 2, max: 64, step: 2 },
					},
					{
						name: '允许批量删除',
						desc: '关闭时，大批量删除会中止同步，防止远端索引异常导致本地数据丢失。',
						control: { type: 'toggle', key: 'allowMassDelete' },
					},
					{
						name: '保留本地历史快照',
						desc: '下载覆盖本地文件前，将旧版本保存到 .diff-sync-history/。',
						control: { type: 'toggle', key: 'keepHistory' },
					},
					{
						name: '保留快照数量',
						visible: () => settings.keepHistory,
						control: { type: 'slider', key: 'historyLimit', min: 1, max: 100, step: 1 },
					},
					{ name: '状态栏显示', control: { type: 'toggle', key: 'showStatusBar' } },
					{
						name: '启动时打开同步面板',
						render: (row) => {
							row.addToggle((toggle) => toggle.setValue(settings.showPanelOnStart).onChange(async (value) => {
								settings.showPanelOnStart = value;
								await save();
								if (value) await this.plugin.activatePanel();
							}));
						},
					},
					{
						name: '详细日志',
						desc: '在插件的同步日志中显示常规同步事件。',
						control: { type: 'toggle', key: 'verboseLogging' },
					},
				],
			},
			{
				type: 'group',
				heading: '维护',
				items: [
					{
						name: '本地分块缓存',
						desc: '按需统计缓存文件的数量和大小。',
						render: (row) => {
							const cache = this.plugin.getCache();
							row.addButton((button) => button.setButtonText('查看用量').onClick(async () => {
								button.setDisabled(true);
								row.setDesc('正在统计缓存…');
								try {
									const { count, bytes } = await cache.size();
									row.setDesc(`${count} 个分块，占用 ${formatBytes(bytes)}`);
								} catch {
									row.setDesc('无法读取缓存信息');
								} finally {
									button.setDisabled(false);
								}
							}));
							row.addButton((button) => button.setButtonText('清空缓存').onClick(async () => {
								await cache.clear();
								new Notice('已清空本地分块缓存');
								this.update();
							}));
						},
					},
					{
						name: '同步状态',
						render: (row) => {
							row.addButton((button) => button.setButtonText('立即同步').setCta().onClick(async () => {
								await this.plugin.sync();
								this.update();
							}));
						},
					},
					{
						name: '上次同步',
						searchable: false,
						visible: () => this.plugin.lastSyncResult() !== null,
						render: (row) => {
							const result = this.plugin.lastSyncResult();
							if (!result) return;
							const summary = result.summary;
							row.descEl.createEl('p', {
								text: `上传 ${summary.uploadedFiles} / 下载 ${summary.downloadedFiles} / 删除 ${summary.deletedLocal + summary.deletedRemote} / 冲突 ${summary.conflicts}`,
							});
							row.descEl.createEl('p', {
								text: `传输 ${formatBytes(summary.bytesUploaded + summary.bytesDownloaded)}，全量需 ${formatBytes(summary.naiveBytes)}，清理 ${summary.gcRemoved} 个分块`,
							});
							if (summary.errors.length > 0) {
								row.descEl.createEl('p', { cls: 'mod-warning', text: `错误：${summary.errors.join('；')}` });
							}
						},
					},
					{
						name: '重置本地同步状态',
						desc: '删除本地合并基线，下次同步会当作首次同步，不会删除笔记。',
						render: (row) => {
							row.addButton((button) => button.setButtonText('重置').setDestructive().onClick(async () => {
								if (!(await confirmWithModal(this.app, '重置本地同步状态？'))) return;
								await this.plugin.resetLocalState();
								new Notice('已重置本地同步状态');
								this.update();
							}));
						},
					},
				],
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key) {
			case 'conflictStrategy':
				if (value !== 'time' && value !== 'size') return;
				settings.conflictStrategy = value;
				break;
			case 'username':
				if (typeof value !== 'string') return;
				settings.username = value;
				break;
			case 'requestConcurrency':
			case 'chunkSizeKb':
			case 'historyLimit':
				if (typeof value !== 'number' || !Number.isFinite(value)) return;
				settings[key] = value;
				break;
			case 'autoSyncOnStart':
			case 'syncOnFileChange':
			case 'allowMassDelete':
			case 'keepHistory':
			case 'showStatusBar':
			case 'verboseLogging':
				if (typeof value !== 'boolean') return;
				settings[key] = value;
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
		this.refreshDomState();
	}

	private numberSetting(
		name: string,
		desc: string,
		key: Extract<keyof SyncSettings, 'autoSyncIntervalMinutes' | 'syncOnFileChangeDelayMs'>,
		minimum: number,
		scale = 1,
	): SettingDefinition {
		const settings = this.plugin.settings;
		return {
			name,
			desc,
			render: (row) => {
				row.addText((text) => text.setValue(String(Math.round(settings[key] / scale))).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed < minimum) return;
					settings[key] = Math.round(parsed * scale);
					await this.plugin.saveSettings();
				}));
			},
		};
	}
}

function confirmWithModal(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new ConfirmModal(app, message, resolve);
		modal.open();
	});
}

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
