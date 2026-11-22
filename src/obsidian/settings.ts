import { DEFAULT_CHUNKER, ChunkerConfig } from '../core/chunker';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/glob';
import { DEFAULT_RETENTION } from '../core/history';

export interface SyncSettings {
	serverUrl: string;
	username: string;
	password: string;
	remoteDir: string;

	/** End-to-end encryption. Passphrase is never persisted remotely. */
	encryptionEnabled: boolean;
	/** Verifier/salt from the remote; cached so we can detect a wrong vault. */
	encryptionSalt: string;
	encryptionIterations: number;
	encryptionVerifier: string;

	autoSyncOnStart: boolean;
	autoSyncIntervalMinutes: number;
	syncOnFileChange: boolean;
	syncOnFileChangeDelayMs: number;

	excludePatterns: string[];
	requestConcurrency: number;
	chunkSizeKb: number;
	verifyDownloads: boolean;
	allowMassDelete: boolean;
	maxFileSizeKb: number;

	/** Keep local snapshots before overwriting on download. */
	keepHistory: boolean;
	historyLimit: number;

	deviceName: string;
	vaultId: string | null;

	showStatusBar: boolean;
	showPanelOnStart: boolean;
	verboseLogging: boolean;
}

export const DEFAULT_SETTINGS: SyncSettings = {
	serverUrl: '',
	username: '',
	password: '',
	remoteDir: 'diff-sync',

	encryptionEnabled: false,
	encryptionSalt: '',
	encryptionIterations: 0,
	encryptionVerifier: '',

	autoSyncOnStart: true,
	autoSyncIntervalMinutes: 30,
	syncOnFileChange: false,
	syncOnFileChangeDelayMs: 20_000,

	excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
	requestConcurrency: 4,
	chunkSizeKb: 8,
	verifyDownloads: true,
	allowMassDelete: false,
	maxFileSizeKb: 50 * 1024,

	keepHistory: true,
	historyLimit: DEFAULT_RETENTION,
	deviceName: '',
	vaultId: null,

	showStatusBar: true,
	showPanelOnStart: false,
	verboseLogging: false,
};

/** Validate and coerce persisted data (settings.json is user-editable). */
export function normalizeSettings(raw: unknown): SyncSettings {
	const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<SyncSettings>;
	const settings: SyncSettings = { ...DEFAULT_SETTINGS };

	const str = (value: unknown, fallback: string): string =>
		typeof value === 'string' ? value : fallback;
	const bool = (value: unknown, fallback: boolean): boolean =>
		typeof value === 'boolean' ? value : fallback;
	const num = (value: unknown, fallback: number, min: number, max: number): number => {
		if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
		return Math.min(max, Math.max(min, value));
	};

	settings.serverUrl = str(input.serverUrl, settings.serverUrl).trim();
	settings.username = str(input.username, settings.username);
	settings.password = str(input.password, settings.password);
	settings.remoteDir = str(input.remoteDir, settings.remoteDir).trim() || 'diff-sync';

	settings.encryptionEnabled = bool(input.encryptionEnabled, settings.encryptionEnabled);
	settings.encryptionSalt = str(input.encryptionSalt, '');
	settings.encryptionIterations = num(input.encryptionIterations, 0, 0, 2_000_000);
	settings.encryptionVerifier = str(input.encryptionVerifier, '');

	settings.autoSyncOnStart = bool(input.autoSyncOnStart, settings.autoSyncOnStart);
	settings.autoSyncIntervalMinutes = num(
		input.autoSyncIntervalMinutes,
		settings.autoSyncIntervalMinutes,
		0,
		24 * 60,
	);
	settings.syncOnFileChange = bool(input.syncOnFileChange, settings.syncOnFileChange);
	settings.syncOnFileChangeDelayMs = num(
		input.syncOnFileChangeDelayMs,
		settings.syncOnFileChangeDelayMs,
		2_000,
		10 * 60_000,
	);

	if (Array.isArray(input.excludePatterns)) {
		settings.excludePatterns = input.excludePatterns.filter(
			(pattern): pattern is string => typeof pattern === 'string',
		);
	}

	settings.requestConcurrency = num(input.requestConcurrency, settings.requestConcurrency, 1, 16);
	settings.chunkSizeKb = num(input.chunkSizeKb, settings.chunkSizeKb, 2, 64);
	settings.verifyDownloads = bool(input.verifyDownloads, settings.verifyDownloads);
	settings.allowMassDelete = bool(input.allowMassDelete, settings.allowMassDelete);
	settings.maxFileSizeKb = num(input.maxFileSizeKb, settings.maxFileSizeKb, 0, 10 * 1024 * 1024);

	settings.keepHistory = bool(input.keepHistory, settings.keepHistory);
	settings.historyLimit = num(input.historyLimit, settings.historyLimit, 1, 500);
	settings.deviceName = str(input.deviceName, settings.deviceName);
	settings.vaultId = typeof input.vaultId === 'string' && input.vaultId ? input.vaultId : null;

	settings.showStatusBar = bool(input.showStatusBar, settings.showStatusBar);
	settings.showPanelOnStart = bool(input.showPanelOnStart, settings.showPanelOnStart);
	settings.verboseLogging = bool(input.verboseLogging, settings.verboseLogging);

	return settings;
}

export function chunkerConfigFor(settings: SyncSettings): ChunkerConfig {
	const avg = Math.max(2, settings.chunkSizeKb) * 1024;
	return {
		minSize: Math.max(512, Math.floor(avg / 4)),
		avgSize: avg,
		maxSize: avg * 4,
	};
}

export function isConfigured(settings: SyncSettings): boolean {
	return settings.serverUrl.trim().length > 0 && settings.remoteDir.trim().length > 0;
}

export { DEFAULT_CHUNKER };
