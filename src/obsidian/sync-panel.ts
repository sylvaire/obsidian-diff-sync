import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
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
		heading.createSpan({ text: '差分同步' });

		const buttonRow = root.createDiv({ cls: 'diff-sync-panel__actions' });

		this.syncButton = buttonRow.createEl('button', {
			cls: 'mod-cta diff-sync-panel__sync',
		});
		setIcon(this.syncButton.createSpan({ cls: 'diff-sync-panel__btn-icon' }), 'play');
		this.syncButton.createSpan({ text: '立即同步' });
		this.syncButton.addEventListener('click', () => void this.plugin.sync());

		this.cancelButton = buttonRow.createEl('button', {
			cls: 'diff-sync-panel__cancel',
		});
		this.cancelButton.setText('取消');
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
		settingsButton.setText('设置');
		settingsButton.addEventListener('click', () => {
			// Open this plugin's settings tab from the panel.
			const app = this.app as unknown as {
				setting?: { open(): void; openTabById(id: string): void };
			};
			app.setting?.open();
			app.setting?.openTabById(this.plugin.manifest.id);
		});

		const logButton = footer.createEl('button', { cls: 'diff-sync-panel__link' });
		logButton.setText('日志');
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
		if (syncing && this.statusLine) this.statusLine.setText('准备中…');
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
			this.syncButton.createSpan({ text: syncing ? '同步中…' : '立即同步' });
			this.syncButton.title = !configured
				? '请先在设置中填写 WebDAV 服务器地址'
				: syncing
					? '正在同步'
					: '立即开始一次同步';
		}

		this.cancelButton?.toggleClass('is-hidden', !syncing);

		if (this.hintEl) {
			this.hintEl.setText(
				configured ? '' : '尚未配置 WebDAV：打开设置 → Diff Sync (WebDAV) 填写服务器地址与密码。',
			);
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
				text: '尚无同步记录',
			});
			return;
		}

		const s = result.summary;
		const rows: [string, string][] = [
			['上传', `${s.uploadedFiles} 个 · ${formatBytes(s.bytesUploaded)}`],
			['下载', `${s.downloadedFiles} 个 · ${formatBytes(s.bytesDownloaded)}`],
			['删除', `${s.deletedLocal + s.deletedRemote} 个`],
			['冲突', `${s.conflicts} 个`],
			['耗时', formatDuration(s.durationMs)],
		];

		const saved = s.naiveBytes - (s.bytesUploaded + s.bytesDownloaded);
		if (s.naiveBytes > 0 && saved > 0) {
			rows.push([
				'差分节省',
				`${formatBytes(saved)}（${Math.round((saved / s.naiveBytes) * 100)}%）`,
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
			conflicts.createDiv({ cls: 'diff-sync-panel__label', text: '冲突副本' });
			for (const path of s.conflictPaths.slice(0, 5)) {
				conflicts.createDiv({ cls: 'diff-sync-panel__conflict-item', text: path });
			}
		}

		if (s.errors.length > 0) {
			const errors = this.statsEl.createDiv({ cls: 'diff-sync-panel__errors' });
			errors.createDiv({ cls: 'diff-sync-panel__label', text: '错误' });
			for (const error of s.errors.slice(0, 3)) {
				errors.createDiv({ cls: 'diff-sync-panel__error-item', text: error });
			}
		}
	}

	/** Progress text shown while syncing, derived from an engine phase update. */
	updateFromProgress(progress: SyncProgress): void {
		const labels: Record<SyncProgress['phase'], string> = {
			scan: '扫描本地文件',
			plan: '比较本地与远端',
			download: '下载差异分块',
			upload: '上传差异分块',
			finalize: '写入远端索引',
			gc: '清理无用分块',
		};
		this.setStatus(labels[progress.phase], progress.detail ?? '');
		if (progress.total > 0) {
			this.setProgress(progress.current / progress.total);
		} else {
			this.setProgress(0);
		}
	}
}
