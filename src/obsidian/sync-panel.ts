import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { t } from '../core/i18n';
import { formatBytes, formatDuration } from './naming';
import type DiffSyncPlugin from './main';
import type { SyncResult } from '../core/engine';
import type { SyncProgress } from '../core/types';

export const VIEW_TYPE_SYNC_PANEL = 'diff-sync-panel';

/**
 * Sidebar panel with a manual sync button.
 *
 * The ribbon icon and status bar already trigger a sync, but a panel makes the
 * state legible: whether a sync is running, what it is doing right now, and what
 * the last run moved. Buttons are disabled while a sync is in flight so a
 * double click cannot queue a second run.
 */
export class SyncPanelView extends ItemView {
	private plugin: DiffSyncPlugin;
	private syncButton: HTMLButtonElement | null = null;
	private cancelButton: HTMLButtonElement | null = null;
	private statusLine: HTMLElement | null = null;
	private detailLine: HTMLElement | null = null;
	private progressBar: HTMLElement | null = null;
	private statsEl: HTMLElement | null = null;
	private hintEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DiffSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_SYNC_PANEL;
	}

	getDisplayText(): string {
		return 'Diff Sync';
	}

	getIcon(): string {
		return 'refresh-cw';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('diff-sync-panel');

		const heading = root.createDiv({ cls: 'diff-sync-panel__heading' });
		setIcon(heading.createSpan({ cls: 'diff-sync-panel__icon' }), 'refresh-cw');
		heading.createSpan({ text: t('panel.heading') });

		const buttonRow = root.createDiv({ cls: 'diff-sync-panel__actions' });

		this.syncButton = buttonRow.createEl('button', {
			cls: 'mod-cta diff-sync-panel__sync',
		});
		setIcon(this.syncButton.createSpan({ cls: 'diff-sync-panel__btn-icon' }), 'play');
		this.syncButton.createSpan({ text: t('command.syncNow') });
		this.syncButton.addEventListener('click', () => void this.plugin.sync());

		this.cancelButton = buttonRow.createEl('button', {
			cls: 'diff-sync-panel__cancel',
		});
		this.cancelButton.setText(t('common.cancel'));
		this.cancelButton.addClass('is-hidden');
		this.cancelButton.addEventListener('click', () => this.plugin.cancelSync());

		this.statusLine = root.createDiv({ cls: 'diff-sync-panel__status' });
		this.progressBar = root.createDiv({ cls: 'diff-sync-panel__progress' }).createDiv({
			cls: 'diff-sync-panel__progress-fill',
		});
		this.detailLine = root.createDiv({ cls: 'diff-sync-panel__detail' });
		this.statsEl = root.createDiv({ cls: 'diff-sync-panel__stats' });

		const footer = root.createDiv({ cls: 'diff-sync-panel__footer' });

		const settingsButton = footer.createEl('button', { cls: 'diff-sync-panel__link' });
		settingsButton.setText(t('panel.settings'));
		settingsButton.addEventListener('click', () => {
			// Open this plugin's settings tab from the panel.
			const app = this.app as unknown as {
				setting?: { open(): void; openTabById(id: string): void };
			};
			app.setting?.open();
			app.setting?.openTabById(this.plugin.manifest.id);
		});

		const logButton = footer.createEl('button', { cls: 'diff-sync-panel__link' });
		logButton.setText(t('panel.log'));
		logButton.addEventListener('click', () => this.plugin.showLog());

		this.hintEl = root.createDiv({ cls: 'diff-sync-panel__hint' });

		this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/** Repaint from the plugin's current state. */
	refresh(): void {
		this.applyState(this.plugin.isSyncing());
	}

	/** Called by the plugin when a sync starts or ends. */
	setSyncing(syncing: boolean): void {
		this.applyState(syncing);
		if (syncing && this.statusLine) this.statusLine.setText(t('status.preparing'));
		if (!syncing) {
			this.setProgress(0);
			this.renderStats(this.plugin.lastSyncResult());
		}
	}

	private applyState(syncing: boolean): void {
		const configured = this.plugin.isConfigured();

		if (this.syncButton) {
			this.syncButton.disabled = syncing || !configured;
			this.syncButton.empty();
			setIcon(this.syncButton.createSpan({ cls: 'diff-sync-panel__btn-icon' }), 'play');
			this.syncButton.createSpan({ text: syncing ? t('panel.syncing') : t('command.syncNow') });
			this.syncButton.title = !configured
				? t('notice.notConfigured')
				: syncing
					? t('panel.syncingTooltip')
					: t('panel.syncTooltip');
		}

		this.cancelButton?.toggleClass('is-hidden', !syncing);

		if (this.hintEl) {
			this.hintEl.setText(configured ? '' : t('panel.notConfiguredHint'));
			this.hintEl.toggleClass('is-hidden', configured);
		}

		if (!syncing) this.renderStats(this.plugin.lastSyncResult());
	}

	/** Called by the plugin for every progress tick. */
	setStatus(text: string, detail?: string): void {
		if (this.statusLine) this.statusLine.setText(text);
		if (this.detailLine) this.detailLine.setText(detail ?? '');
	}

	setProgress(fraction: number): void {
		if (!this.progressBar) return;
		const clamped = Math.max(0, Math.min(1, fraction));
		this.progressBar.style.width = `${Math.round(clamped * 100)}%`;
		this.progressBar.toggleClass('is-indeterminate', clamped <= 0);
	}

	private renderStats(result: SyncResult | null): void {
		if (!this.statsEl) return;
		this.statsEl.empty();

		if (!result) {
			this.statsEl.createDiv({
				cls: 'diff-sync-panel__muted',
				text: t('panel.noHistory'),
			});
			return;
		}

		const s = result.summary;
		const rows: [string, string][] = [
			[
				t('panel.label.upload'),
				t('panel.value.files', {
					count: s.uploadedFiles,
					size: formatBytes(s.bytesUploaded),
				}),
			],
			[
				t('panel.label.download'),
				t('panel.value.files', {
					count: s.downloadedFiles,
					size: formatBytes(s.bytesDownloaded),
				}),
			],
			[
				t('panel.label.delete'),
				t('panel.value.count', { count: s.deletedLocal + s.deletedRemote }),
			],
			[t('panel.label.conflict'), t('panel.value.count', { count: s.conflicts })],
			[t('panel.label.duration'), formatDuration(s.durationMs)],
		];

		const saved = s.naiveBytes - (s.bytesUploaded + s.bytesDownloaded);
		if (s.naiveBytes > 0 && saved > 0) {
			rows.push([
				t('panel.label.saved'),
				t('panel.value.saved', {
					size: formatBytes(saved),
					percent: Math.round((saved / s.naiveBytes) * 100),
				}),
			]);
		}

		const table = this.statsEl.createDiv({ cls: 'diff-sync-panel__table' });
		for (const [label, value] of rows) {
			const row = table.createDiv({ cls: 'diff-sync-panel__row' });
			row.createSpan({ cls: 'diff-sync-panel__label', text: label });
			row.createSpan({ cls: 'diff-sync-panel__value', text: value });
		}

		if (s.conflictPaths.length > 0) {
			const conflicts = this.statsEl.createDiv({ cls: 'diff-sync-panel__conflicts' });
			conflicts.createDiv({ cls: 'diff-sync-panel__label', text: t('panel.conflicts') });
			for (const path of s.conflictPaths.slice(0, 5)) {
				conflicts.createDiv({ cls: 'diff-sync-panel__conflict-item', text: path });
			}
		}

		if (s.errors.length > 0) {
			const errors = this.statsEl.createDiv({ cls: 'diff-sync-panel__errors' });
			errors.createDiv({ cls: 'diff-sync-panel__label', text: t('panel.errors') });
			for (const error of s.errors.slice(0, 3)) {
				errors.createDiv({ cls: 'diff-sync-panel__error-item', text: error });
			}
		}
	}

	/** Progress text shown while syncing, derived from an engine phase update. */
	updateFromProgress(progress: SyncProgress): void {
		const labels: Record<SyncProgress['phase'], string> = {
			scan: t('panel.phase.scan'),
			plan: t('panel.phase.plan'),
			download: t('panel.phase.download'),
			upload: t('panel.phase.upload'),
			finalize: t('panel.phase.finalize'),
			gc: t('panel.phase.gc'),
		};
		this.setStatus(labels[progress.phase], progress.detail ?? '');
		if (progress.total > 0) {
			this.setProgress(progress.current / progress.total);
		} else {
			this.setProgress(0);
		}
	}
}
