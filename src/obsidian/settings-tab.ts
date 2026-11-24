import { App, Modal, Notice, PluginSettingTab } from 'obsidian';
import type { SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/glob';
import { t } from '../core/i18n';
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
						name: t('settings.serverUrl'),
						desc: t('settings.serverUrl.desc'),
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
						name: t('settings.username'),
						control: { type: 'text', key: 'username' },
					},
					{
						name: t('settings.password'),
						desc: t('settings.password.desc'),
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
						name: t('settings.remoteDir'),
						desc: t('settings.remoteDir.desc'),
						render: (row) => {
							row.addText((text) => text.setPlaceholder('diff-sync')
								.setValue(settings.remoteDir).onChange(async (value) => {
									settings.remoteDir = value.trim() || 'diff-sync';
									await save();
								}));
						},
					},
					{
						name: t('settings.test'),
						desc: t('settings.test.desc'),
						render: (row) => {
							row.addButton((button) => button
								.setButtonText(t('common.test'))
								.onClick(async () => {
									button.setDisabled(true).setButtonText(t('settings.test.running'));
									try {
										new Notice(
											t('connection.success', {
												message: await this.plugin.testConnection(),
											}),
											8_000,
										);
									} catch (error) {
										new Notice(
											t('connection.failed', {
												message: error instanceof Error ? error.message : String(error),
											}),
											12_000,
										);
									} finally {
										button.setDisabled(false).setButtonText(t('common.test'));
									}
								}));
						},
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.group.security'),
				items: [
					{
						name: t('settings.encryption'),
						desc: t('settings.encryption.desc'),
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
						name: t('settings.encryptionPassphrase'),
						desc: t('settings.encryptionPassphrase.desc'),
						visible: () => settings.encryptionEnabled,
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.group.schedule'),
				items: [
					{
						name: t('settings.autoSyncOnStart'),
						control: { type: 'toggle', key: 'autoSyncOnStart' },
					},
					this.numberSetting(
						t('settings.interval'),
						t('settings.interval.desc'),
						'autoSyncIntervalMinutes',
						0,
					),
					{
						name: t('settings.syncOnFileChange'),
						desc: t('settings.syncOnFileChange.desc'),
						control: { type: 'toggle', key: 'syncOnFileChange' },
					},
					{
						...this.numberSetting(
							t('settings.changeDelay'),
							t('settings.changeDelay.desc'),
							'syncOnFileChangeDelayMs',
							2,
							1000,
						),
						visible: () => settings.syncOnFileChange,
					},
					{
						name: t('settings.deviceName'),
						desc: t('settings.deviceName.desc'),
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
				heading: t('settings.group.scope'),
				items: [
					{
						name: t('settings.excludePatterns'),
						desc: t('settings.excludePatterns.desc'),
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
						name: t('settings.restoreExcludes'),
						render: (row) => {
							row.addButton((button) => button.setButtonText(t('settings.restore')).onClick(async () => {
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
				heading: t('settings.group.advanced'),
				items: [
					{
						name: t('settings.conflictStrategy'),
						desc: t('settings.conflictStrategy.desc'),
						control: {
							type: 'dropdown',
							key: 'conflictStrategy',
							options: {
								time: t('settings.conflictStrategy.time'),
								size: t('settings.conflictStrategy.size'),
							},
						},
					},
					{
						name: t('settings.concurrency'),
						desc: t('settings.concurrency.desc'),
						control: { type: 'slider', key: 'requestConcurrency', min: 1, max: 12, step: 1 },
					},
					{
						name: t('settings.chunkSize'),
						desc: t('settings.chunkSize.desc'),
						control: { type: 'slider', key: 'chunkSizeKb', min: 2, max: 64, step: 2 },
					},
					{
						name: t('settings.allowMassDelete'),
						desc: t('settings.allowMassDelete.desc'),
						control: { type: 'toggle', key: 'allowMassDelete' },
					},
					{
						name: t('settings.keepHistory'),
						desc: t('settings.keepHistory.desc'),
						control: { type: 'toggle', key: 'keepHistory' },
					},
					{
						name: t('settings.historyLimit'),
						visible: () => settings.keepHistory,
						control: { type: 'slider', key: 'historyLimit', min: 1, max: 100, step: 1 },
					},
					{
						name: t('settings.showStatusBar'),
						control: { type: 'toggle', key: 'showStatusBar' },
					},
					{
						name: t('settings.showPanelOnStart'),
						render: (row) => {
							row.addToggle((toggle) => toggle.setValue(settings.showPanelOnStart).onChange(async (value) => {
								settings.showPanelOnStart = value;
								await save();
								if (value) await this.plugin.activatePanel();
							}));
						},
					},
					{
						name: t('settings.verboseLogging'),
						desc: t('settings.verboseLogging.desc'),
						control: { type: 'toggle', key: 'verboseLogging' },
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.group.maintenance'),
				items: [
					{
						name: t('settings.localCache'),
						desc: t('settings.localCache.desc'),
						render: (row) => {
							const cache = this.plugin.getCache();
							row.addButton((button) => button.setButtonText(t('settings.cache.viewUsage')).onClick(async () => {
								button.setDisabled(true);
								row.setDesc(t('settings.cache.counting'));
								try {
									const { count, bytes } = await cache.size();
									row.setDesc(
										t('settings.cache.usage', { count, size: formatBytes(bytes) }),
									);
								} catch {
									row.setDesc(t('settings.cache.unreadable'));
								} finally {
									button.setDisabled(false);
								}
							}));
							row.addButton((button) => button.setButtonText(t('settings.cache.clear')).onClick(async () => {
								await cache.clear();
								new Notice(t('notice.chunkCacheCleared'));
								this.update();
							}));
						},
					},
					{
						name: t('settings.syncStatus'),
						render: (row) => {
							row.addButton((button) => button.setButtonText(t('command.syncNow')).setCta().onClick(async () => {
								await this.plugin.sync();
								this.update();
							}));
						},
					},
					{
						name: t('settings.lastSync'),
						searchable: false,
						visible: () => this.plugin.lastSyncResult() !== null,
						render: (row) => {
							const result = this.plugin.lastSyncResult();
							if (!result) return;
							const summary = result.summary;
							row.descEl.createEl('p', {
								text: t('settings.lastSync.movement', {
									uploaded: summary.uploadedFiles,
									downloaded: summary.downloadedFiles,
									deleted: summary.deletedLocal + summary.deletedRemote,
									conflicts: summary.conflicts,
								}),
							});
							row.descEl.createEl('p', {
								text: t('settings.lastSync.transfer', {
									total: formatBytes(summary.bytesUploaded + summary.bytesDownloaded),
									naive: formatBytes(summary.naiveBytes),
									gc: summary.gcRemoved,
								}),
							});
							if (summary.errors.length > 0) {
								row.descEl.createEl('p', {
									cls: 'mod-warning',
									text: t('settings.lastSync.errors', {
										errors: summary.errors.join('; '),
									}),
								});
							}
						},
					},
					{
						name: t('settings.reset'),
						desc: t('settings.reset.desc'),
						render: (row) => {
							row.addButton((button) => button
								.setButtonText(t('settings.reset.button'))
								.setDestructive()
								.onClick(async () => {
									if (!(await confirmWithModal(this.app, t('settings.reset.confirm')))) return;
									await this.plugin.resetLocalState();
									new Notice(t('notice.stateReset'));
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
		buttons
			.createEl('button', { text: t('common.cancel') })
			.addEventListener('click', () => this.close());
		buttons
			.createEl('button', { text: t('common.confirm'), cls: 'mod-warning' })
			.addEventListener('click', () => {
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
