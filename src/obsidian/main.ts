import {
	App,
	Modal,
	Notice,
	Plugin,
	Setting,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	normalizePath,
} from 'obsidian';
import { runSync, SyncResult } from '../core/engine';
import { PathFilter } from '../core/glob';
import { HISTORY_DIR, historyPathFor, snapshotStamp, staleSnapshots } from '../core/history';
import { createEmptyState, parseState, SyncState } from '../core/manifest';
import { RemoteMeta, RemoteStore, VaultMismatchError } from '../core/remote';
import { SyncProgress, SyncSummary } from '../core/types';
import { errorMessage } from '../core/util';
import { WebDavClient, WebDavError } from '../core/webdav';
import { buildEncryptionConfig, unlockEncryption } from '../core/crypto';
import { DiskChunkCache } from './chunk-cache';
import { formatBytes, formatDuration } from './naming';
import { chunkerConfigFor, isConfigured, normalizeSettings, SyncSettings } from './settings';
import { DiffSyncSettingTab } from './settings-tab';
import { obsidianTransport } from './transport';
import { SyncPanelView, VIEW_TYPE_SYNC_PANEL } from './sync-panel';
import { ObsidianVault } from './vault-adapter';

const STATE_FILE = 'sync-state.json';
const MAX_LOG_LINES = 400;

export interface LogLine {
	at: number;
	level: 'info' | 'warn' | 'error';
	message: string;
}

export default class DiffSyncPlugin extends Plugin {
	settings!: SyncSettings;
	private chunkCache!: DiskChunkCache;
	private syncing = false;
	private abortController: AbortController | null = null;
	private statusEl: HTMLElement | null = null;
	private logLines: LogLine[] = [];
	private eventTimer: ReturnType<typeof setTimeout> | null = null;
	private lastResult: SyncResult | null = null;
	private sessionPassphrase: string | null = null;
	private panel: SyncPanelView | null = null;
	private intervalId: number | null = null;
	private lastIntervalSync = 0;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.chunkCache = new DiskChunkCache(this.app.vault.adapter, this.pluginDir());

		this.addRibbonIcon('refresh-cw', 'Diff Sync：立即同步', () => void this.sync());
		this.addCommand({ id: 'sync-now', name: '立即同步', callback: () => void this.sync() });
		this.addCommand({
			id: 'sync-full-rescan',
			name: '完整重新扫描并同步',
			callback: () => void this.sync({ alwaysRehash: true }),
		});
		this.addCommand({ id: 'cancel-sync', name: '取消当前同步', callback: () => this.cancelSync() });
		this.addCommand({
			id: 'show-sync-log',
			name: '显示同步日志',
			callback: () => this.showLog(),
		});
		this.addCommand({
			id: 'clear-chunk-cache',
			name: '清空本地分块缓存',
			callback: async () => {
				await this.chunkCache.clear();
				new Notice('已清空本地分块缓存；下次同步会按需重新上传分块');
			},
		});
		this.addCommand({
			id: 'clear-history',
			name: '清空本地历史快照',
			callback: async () => {
				await this.clearHistory();
				new Notice('已清空历史快照');
			},
		});

		this.registerView(VIEW_TYPE_SYNC_PANEL, (leaf) => {
			const view = new SyncPanelView(leaf, this);
			this.panel = view;
			return view;
		});
		this.addCommand({
			id: 'open-sync-panel',
			name: '打开同步面板',
			callback: () => void this.activatePanel(),
		});

		this.addSettingTab(new DiffSyncSettingTab(this.app, this));
		if (this.settings.showStatusBar) this.ensureStatusBar();
		this.setStatus('待同步');

		this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultEvent(file)));
		this.registerEvent(this.app.vault.on('create', (file) => this.onVaultEvent(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.onVaultEvent(file)));
		this.registerEvent(this.app.vault.on('rename', (file) => this.onVaultEvent(file)));

		this.scheduleIntervalSync();

		// Restore the sidebar panel if the user left it open.
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.showPanelOnStart) void this.activatePanel(false);
			else void this.refreshPanel();
		});

		if (this.settings.autoSyncOnStart) {
			this.app.workspace.onLayoutReady(() => void this.sync({ silent: true, triggered: '启动' }));
		}
	}

	onunload(): void {
		this.cancelSync();
		if (this.eventTimer) clearTimeout(this.eventTimer);
		this.statusEl?.remove();
		this.statusEl = null;
		this.panel = null;
	}

	// ---------------------------------------------------------------- settings

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		if (!this.settings.deviceName) {
			this.settings.deviceName = defaultDeviceName();
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.lastIntervalSync = Date.now();
		if (this.settings.autoSyncIntervalMinutes > 0) this.scheduleIntervalSync();
		if (this.settings.showStatusBar) this.ensureStatusBar();
		else {
			this.statusEl?.remove();
			this.statusEl = null;
		}
	}

	// ------------------------------------------------------------------ status

	private ensureStatusBar(): void {
		if (this.statusEl) return;
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('mod-clickable');
		this.statusEl.addEventListener('click', () => void this.sync());
		this.statusEl.setText('⇅ 待同步');
		this.statusEl.setAttribute('aria-label', 'Diff Sync — 点击立即同步');
	}

	setStatus(text: string): void {
		if (this.statusEl) {
			this.statusEl.setText(`⇅ ${text}`);
			this.statusEl.title = `Diff Sync — ${text}`;
		}
	}

	/** Exposed for the panel's settings/log buttons. */
	isConfigured(): boolean {
		return isConfigured(this.settings);
	}

	showLog(): void {
		const lines = this.logLines.slice(-150);
		if (lines.length === 0) {
			new Notice('暂无日志');
			return;
		}
		const text = lines
			.map((line) => `${new Date(line.at).toLocaleTimeString()} [${line.level}] ${line.message}`)
			.join('\n');
		new Notice(text, 20_000);
	}

	/**
	 * Open (and focus) the sidebar panel. When `focus` is false the view is only
	 * created if the user had it open before, so a fresh workspace is not
	 * cluttered with a panel they never asked for.
	 */
	async activatePanel(focus = true): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_SYNC_PANEL)[0] ?? null;

		if (!leaf && focus) {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_SYNC_PANEL, active: true });
			}
		}
		if (leaf) await workspace.revealLeaf(leaf);
		this.refreshPanel();
	}

	private refreshPanel(): void {
		this.panel?.refresh();
	}

	// -------------------------------------------------------------------- sync

	cancelSync(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
			this.log('已请求取消同步', 'warn');
		}
	}

	async sync(
		options: { alwaysRehash?: boolean; silent?: boolean; triggered?: string } = {},
	): Promise<void> {
		if (this.syncing) {
			if (!options.silent) new Notice('同步已在进行中');
			return;
		}
		if (!isConfigured(this.settings)) {
			if (!options.silent) new Notice('请先在设置中填写 WebDAV 服务器地址');
			return;
		}

		this.syncing = true;
		this.abortController = new AbortController();
		const controller = this.abortController;
		const startedAt = Date.now();

		try {
			this.log(`开始同步${options.triggered ? `（${options.triggered}）` : ''}`);
			this.setStatus('准备中…');
			this.panel?.setSyncing(true);

			const { store, meta } = await this.connect();
			const state = await this.readState(store.vaultId);
			const excludeFilter = new PathFilter([
				// The history folder's *contents* must be excluded too, so use `/**`.
				`${HISTORY_DIR}/**`,
				...this.settings.excludePatterns,
			]);
			const vault = new ObsidianVault(this.app, (path) => excludeFilter.excluded(path));

			const result = await runSync(store, {
				vault,
				stateFiles: state.files,
				stateVaultId: state.vaultId || undefined,
				deviceName: this.settings.deviceName,
				concurrency: this.settings.requestConcurrency,
				chunker: chunkerConfigFor(this.settings),
				alwaysRehash: options.alwaysRehash ?? false,
				cache: this.chunkCache,
				collectGarbage: true,
				allowMassDelete: this.settings.allowMassDelete,
				isExcluded: (path) => excludeFilter.excluded(path),
				beforeOverwrite: this.settings.keepHistory
					? (path, previous) => this.saveSnapshot(path, previous)
					: undefined,
				signal: controller.signal,
				onProgress: (progress) => this.onProgress(progress),
				log: (message, level) => this.log(message, level),
			});

			await this.writeState(result.state);
			this.lastResult = result;
			if (this.settings.vaultId !== meta.vaultId) {
				this.settings.vaultId = meta.vaultId;
				await this.saveData(this.settings);
			}
			this.reportResult(result.summary, options.silent ?? false);
		} catch (error) {
			const message = describeSyncError(error);
			this.log(message, 'error');
			this.setStatus('同步失败');
			this.panel?.setStatus('同步失败', message);
			if (!options.silent) new Notice(`Diff Sync 失败：${message}`, 12_000);
		} finally {
			this.syncing = false;
			this.abortController = null;
			this.log(`同步结束，用时 ${formatDuration(Date.now() - startedAt)}`);
			this.panel?.setSyncing(false);
		}
	}

	private onProgress(progress: SyncProgress): void {
		const labels: Record<SyncProgress['phase'], string> = {
			scan: '扫描本地',
			plan: '比较差异',
			download: '下载差异',
			upload: '上传差异',
			finalize: '写入索引',
			gc: '清理分块',
		};
		this.setStatus(`${labels[progress.phase]} ${progress.detail ?? ''}`.trim());
		this.panel?.updateFromProgress(progress);
	}

	private reportResult(summary: SyncSummary, silent: boolean): void {
		const moved = summary.uploadedFiles + summary.downloadedFiles;
		const deleted = summary.deletedLocal + summary.deletedRemote;
		const parts: string[] = [];
		if (summary.uploadedFiles) parts.push(`↑${summary.uploadedFiles}`);
		if (summary.downloadedFiles) parts.push(`↓${summary.downloadedFiles}`);
		if (deleted) parts.push(`✕${deleted}`);
		if (summary.conflicts) parts.push(`⚠${summary.conflicts}`);
		this.setStatus(`${parts.join(' ') || '已是最新'} · ${formatDuration(summary.durationMs)}`);

		const total = summary.bytesUploaded + summary.bytesDownloaded;
		const saved = summary.naiveBytes - total;
		const savingPct =
			summary.naiveBytes > 0 ? Math.round((saved / summary.naiveBytes) * 100) : 0;

		for (const warning of summary.warnings) this.log(warning, 'warn');
		for (const error of summary.errors) this.log(error, 'error');

		if (summary.conflicts > 0) {
			this.log(`冲突副本：${summary.conflictPaths.join(', ')}`, 'warn');
		}
		if (summary.gcRemoved > 0) this.log(`清理了 ${summary.gcRemoved} 个无用分块`);

		if (silent && moved === 0 && deleted === 0 && summary.conflicts === 0) {
			this.log(`无变化（${summary.skippedFiles} 个文件已是最新）`);
			return;
		}

		const lines = [
			`↑${summary.uploadedFiles} 文件 / ${formatBytes(summary.bytesUploaded)}，` +
				`↓${summary.downloadedFiles} 文件 / ${formatBytes(summary.bytesDownloaded)}`,
		];
		if (summary.naiveBytes > 0) {
			lines.push(
				`差分传输节省 ${formatBytes(Math.max(0, saved))}（${savingPct}%，` +
					`全量需 ${formatBytes(summary.naiveBytes)}）`,
			);
		}
		if (summary.conflicts > 0) {
			lines.push(
				`${summary.conflicts} 个冲突已另存为副本：\n` +
					summary.conflictPaths.slice(0, 3).map((p) => `· ${p}`).join('\n'),
			);
		}
		if (summary.errors.length > 0) {
			lines.push(`错误：${summary.errors.slice(0, 2).join('；')}`);
		}
		new Notice(`Diff Sync\n${lines.join('\n')}`, 8_000);
	}

	// ----------------------------------------------------------------- connect

	private async connect(): Promise<{ store: RemoteStore; meta: RemoteMeta }> {
		const client = new WebDavClient(
			{
				baseUrl: this.settings.serverUrl,
				username: this.settings.username,
				password: this.settings.password,
				rootDir: this.settings.remoteDir || 'diff-sync',
			},
			obsidianTransport,
		);

		let meta = await RemoteStore.readMeta(client);

		if (!meta) {
			if (this.settings.encryptionEnabled && !this.settings.encryptionSalt) {
				await this.initializeEncryption();
			}
			await client.ensureCollection(client.rootUrl);
			const vaultId = this.settings.vaultId && !this.settings.encryptionEnabled
				? this.settings.vaultId
				: randomId();
			const created: RemoteMeta = {
				v: 1,
				vaultId,
				encrypted: this.settings.encryptionEnabled,
				...(this.settings.encryptionEnabled
					? {
							kdf: {
								salt: this.settings.encryptionSalt,
								iterations: this.settings.encryptionIterations,
							},
							verifier: this.settings.encryptionVerifier,
						}
					: {}),
			};
			const written = await client.put(
				client.urlFor('meta.json'),
				new TextEncoder().encode(JSON.stringify(created, null, 2)),
				{ contentType: 'application/json', createOnly: true },
			);
			if (!written.ok) {
				// Another device created it first: adopt theirs.
				meta = await RemoteStore.readMeta(client);
				if (!meta) throw new Error('无法读取远端 meta.json');
			} else {
				meta = created;
			}
		}

		if (this.settings.vaultId && meta.vaultId !== this.settings.vaultId) {
			throw new VaultMismatchError(meta.vaultId, this.settings.vaultId);
		}

		let key: CryptoKey | null = null;
		if (meta.encrypted) {
			if (!meta.kdf || !meta.verifier) throw new Error('远端加密元数据缺失');
			const passphrase = await this.askPassphrase();
			if (!passphrase) throw new Error('已取消：需要口令才能访问加密的远端');
			key = await unlockEncryption(passphrase, { kdf: meta.kdf, verifier: meta.verifier });
		}

		const store = new RemoteStore({
			client,
			meta,
			key,
			concurrency: this.settings.requestConcurrency,
		});
		await store.ensureCollections();
		return { store, meta };
	}

	private async initializeEncryption(): Promise<void> {
		const passphrase = await this.promptPassphrase({
			title: '设置端到端加密口令',
			description: '口令只用于派生本地密钥，绝不上传。口令遗失将无法恢复远端备份。',
			confirm: true,
		});
		if (!passphrase) throw new Error('已取消：未设置加密口令');
		const { config } = await buildEncryptionConfig(passphrase, 210_000);
		this.settings.encryptionSalt = config.kdf.salt;
		this.settings.encryptionIterations = config.kdf.iterations;
		this.settings.encryptionVerifier = config.verifier;
		this.sessionPassphrase = passphrase;
		await this.saveData(this.settings);
	}

	private async askPassphrase(): Promise<string | null> {
		if (this.sessionPassphrase) return this.sessionPassphrase;
		const entered = await this.promptPassphrase({
			title: '输入端到端加密口令',
			description: '口令仅保存在本次会话的内存中。',
			confirm: false,
		});
		if (entered) this.sessionPassphrase = entered;
		return entered;
	}

	private promptPassphrase(options: {
		title: string;
		description: string;
		confirm: boolean;
	}): Promise<string | null> {
		return new Promise((resolve) => new PassphraseModal(this.app, options, resolve).open());
	}

	// ------------------------------------------------------------------- state

	private pluginDir(): string {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}

	private statePath(): string {
		return normalizePath(`${this.pluginDir()}/${STATE_FILE}`);
	}

	private async readState(vaultId: string): Promise<SyncState> {
		const adapter = this.app.vault.adapter;
		const path = this.statePath();
		if (!(await adapter.exists(path))) return createEmptyState(vaultId);
		try {
			const state = parseState(JSON.parse(await adapter.read(path)));
			if (!state || state.vaultId !== vaultId) return createEmptyState(vaultId);
			return state;
		} catch {
			return createEmptyState(vaultId);
		}
	}

	private async writeState(state: SyncState): Promise<void> {
		await this.app.vault.adapter.write(this.statePath(), JSON.stringify(state));
	}

	// ----------------------------------------------------------------- history

	private async saveSnapshot(path: string, previous: Uint8Array): Promise<void> {
		if (previous.length === 0) return;
		const target = normalizePath(historyPathFor(path, snapshotStamp(Date.now())));
		const adapter = this.app.vault.adapter;
		const parent = target.slice(0, target.lastIndexOf('/'));
		if (!(await adapter.exists(parent))) await adapter.mkdir(parent);
		await adapter.writeBinary(target, toArrayBuffer(previous));
		await this.pruneHistory();
	}

	private async pruneHistory(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const root = normalizePath(HISTORY_DIR);
		if (!(await adapter.exists(root))) return;
		const listing = await adapter.list(root);
		const stamps = listing.folders.map((folder) => folder.split('/').pop() ?? '');
		for (const stale of staleSnapshots(stamps, this.settings.historyLimit)) {
			await adapter.rmdir(normalizePath(`${root}/${stale}`), true).catch(() => undefined);
		}
	}

	private async clearHistory(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const root = normalizePath(HISTORY_DIR);
		if (await adapter.exists(root)) await adapter.rmdir(root, true);
	}

	/** Called by the settings tab after the user changes connection details. */
	async onSettingsChanged(): Promise<void> {
		await this.saveSettings();
		this.sessionPassphrase = null;
	}

	/**
	 * Interval sync on a 30 s tick rather than a single long timer, so changing
	 * the interval in settings takes effect without restarting the plugin.
	 */
	private scheduleIntervalSync(): void {
		if (this.intervalId === null) {
			this.intervalId = window.setInterval(() => this.maybeIntervalSync(), 30_000);
			this.registerInterval(this.intervalId);
		}
		this.lastIntervalSync = Date.now();
	}

	private maybeIntervalSync(): void {
		const minutes = this.settings.autoSyncIntervalMinutes;
		if (minutes <= 0 || this.syncing) return;
		if (Date.now() - this.lastIntervalSync < minutes * 60_000) return;
		this.lastIntervalSync = Date.now();
		void this.sync({ silent: true, triggered: '定时同步' });
	}

	/** Forget the merge base so the next sync behaves like a first run. */
	async resetLocalState(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const path = this.statePath();
		if (await adapter.exists(path)) await adapter.remove(path);
		this.lastResult = null;
		this.log('已重置本地同步状态');
	}

	// -------------------------------------------------------------- file events

	private onVaultEvent(file: TAbstractFile): void {
		if (!this.settings.syncOnFileChange || this.syncing) return;
		if (!(file instanceof TFile)) return;
		const normalized = normalizePath(file.path);
		if (normalized === HISTORY_DIR || normalized.startsWith(`${HISTORY_DIR}/`)) return;
		if (new PathFilter(this.settings.excludePatterns).excluded(normalized)) return;
		if (this.eventTimer) clearTimeout(this.eventTimer);
		this.eventTimer = setTimeout(() => {
			this.eventTimer = null;
			if (!this.syncing) void this.sync({ silent: true, triggered: '文件变更' });
		}, this.settings.syncOnFileChangeDelayMs);
	}

	// --------------------------------------------------------------------- log

	log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
		this.logLines.push({ at: Date.now(), level, message });
		if (this.logLines.length > MAX_LOG_LINES) {
			this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
		}
		if (level === 'error') console.error(`[diff-sync] ${message}`);
		else if (level === 'warn' || this.settings.verboseLogging) {
			console.log(`[diff-sync] ${message}`);
		}
	}

	getLog(): readonly LogLine[] {
		return this.logLines;
	}

	lastSyncResult(): SyncResult | null {
		return this.lastResult;
	}

	isSyncing(): boolean {
		return this.syncing;
	}

	getCache(): DiskChunkCache {
		return this.chunkCache;
	}

	async testConnection(): Promise<string> {
		const client = new WebDavClient(
			{
				baseUrl: this.settings.serverUrl,
				username: this.settings.username,
				password: this.settings.password,
				rootDir: this.settings.remoteDir || 'diff-sync',
			},
			obsidianTransport,
		);
		await client.ensureCollection(client.rootUrl);
		const probe = client.urlFor('.connection-test');
		const written = await client.put(probe, new TextEncoder().encode('ok'), {
			contentType: 'text/plain',
		});
		if (!written.ok) throw new Error('写入测试文件失败');
		const read = await client.get(probe);
		await client.delete(probe);
		if (!read || new TextDecoder().decode(read) !== 'ok') {
			throw new Error('读取测试文件内容不一致');
		}
		const conditional = client.conditionalWritesSupported;
		return conditional === false
			? '连接成功（服务器未实现条件写入，并发保护已降级）'
			: '连接成功，读写正常';
	}
}

// ---------------------------------------------------------------------------

function defaultDeviceName(): string {
	const platform = `${navigator.platform ?? ''}`;
	if (platform.includes('Win')) return 'windows';
	if (platform.includes('Mac')) return 'mac';
	if (platform.includes('Linux')) return 'linux';
	return 'device';
}

function randomId(): string {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
		? (data.buffer as ArrayBuffer)
		: (data.slice().buffer as ArrayBuffer);
}

function describeSyncError(error: unknown): string {
	if (error instanceof VaultMismatchError) return error.message;
	if (error instanceof WebDavError) {
		return error.status === 0 ? `无法连接服务器：${error.message}` : error.message;
	}
	return errorMessage(error);
}

class PassphraseModal extends Modal {
	private value = '';
	private confirmValue = '';
	private errorEl: HTMLElement | null = null;
	private settled = false;

	constructor(
		app: App,
		private readonly options: { title: string; description: string; confirm: boolean },
		private readonly resolve: (value: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: this.options.title });
		contentEl.createEl('p', {
			text: this.options.description,
			cls: 'setting-item-description',
		});

		new Setting(contentEl).setName('口令').addText((text) => {
			text.inputEl.type = 'password';
			text.onChange((value) => (this.value = value));
			text.inputEl.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') this.submit();
			});
			window.setTimeout(() => text.inputEl.focus(), 50);
		});

		if (this.options.confirm) {
			new Setting(contentEl).setName('确认口令').addText((text) => {
				text.inputEl.type = 'password';
				text.onChange((value) => (this.confirmValue = value));
				text.inputEl.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') this.submit();
				});
			});
		}

		this.errorEl = contentEl.createEl('p', { cls: 'mod-warning' });
		this.errorEl.style.display = 'none';

		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		buttons.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
		buttons.createEl('button', { text: '确定', cls: 'mod-cta' }).addEventListener('click', () =>
			this.submit(),
		);
	}

	private submit(): void {
		if (!this.value.trim()) return this.showError('请输入口令');
		if (this.options.confirm && this.value !== this.confirmValue) {
			return this.showError('两次输入不一致');
		}
		if (this.options.confirm && this.value.length < 8) {
			return this.showError('口令至少 8 个字符');
		}
		this.settled = true;
		this.resolve(this.value);
		this.close();
	}

	private showError(message: string): void {
		if (!this.errorEl) return;
		this.errorEl.setText(message);
		this.errorEl.style.display = '';
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) this.resolve(null);
	}
}
