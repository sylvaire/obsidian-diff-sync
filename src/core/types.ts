import { ChunkerConfig } from './chunker';
import { SyncStateEntry } from './manifest';

export interface LocalFileInfo {
	path: string;
	size: number;
	mtime: number;
}

/**
 * Everything the sync engine needs from the vault.
 * Implemented by the Obsidian adapter and by the Node test harness.
 */
export interface LocalVault {
	list(): Promise<LocalFileInfo[]>;
	stat(path: string): Promise<LocalFileInfo | null>;
	read(path: string): Promise<Uint8Array>;
	write(path: string, data: Uint8Array): Promise<void>;
	remove(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

export interface ScannedLocalFile {
	path: string;
	size: number;
	mtime: number;
	/** Hash over chunk ids: the file's version identity. */
	hash: string;
	chunkIds: string[];
	/** True when content had to be read (mtime/size alone were not enough). */
	rehashed: boolean;
}

export type SyncPhase = 'scan' | 'plan' | 'download' | 'upload' | 'finalize' | 'gc';

export interface SyncProgress {
	phase: SyncPhase;
	current: number;
	total: number;
	detail?: string;
}

export interface SyncSummary {
	startedAt: number;
	durationMs: number;
	uploadedFiles: number;
	downloadedFiles: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	conflictPaths: string[];
	chunksUploaded: number;
	chunksDownloaded: number;
	bytesUploaded: number;
	bytesDownloaded: number;
	/** Bytes a naive full-transfer sync would have moved. */
	naiveBytes: number;
	skippedFiles: number;
	gcRemoved: number;
	warnings: string[];
	errors: string[];
}

export interface ChunkCache {
	has(id: string): Promise<boolean>;
	get(id: string): Promise<Uint8Array | null>;
	put(id: string, data: Uint8Array): Promise<void>;
	delete(id: string): Promise<void>;
	list?(): Promise<string[]>;
}

export type ConflictStrategy = 'time' | 'size';

export interface SyncEngineOptions {
	vault: LocalVault;
	/** Merge base from the previous successful sync, keyed by path. */
	stateFiles: Record<string, SyncStateEntry>;
	/** Vault id that `stateFiles` belongs to; guards against stale state. */
	stateVaultId?: string;
	deviceName: string;
	conflictStrategy?: ConflictStrategy;
	concurrency: number;
	chunker?: ChunkerConfig;
	/** Ignore mtime/size shortcuts and hash everything (used by "full rescan"). */
	alwaysRehash?: boolean;
	/** Cache chunk bytes read from local files, to avoid re-reading on upload. */
	cacheUploadedChunks?: boolean;
	cache?: ChunkCache;
	collectGarbage?: boolean;
	/** Guard against wiping the vault when the remote index is unexpectedly empty. */
	allowMassDelete?: boolean;
	/**
	 * Called with a file's current bytes immediately before they are overwritten
	 * or deleted (local snapshotting). Failures must not abort the sync.
	 */
	beforeOverwrite?: (path: string, previous: Uint8Array) => Promise<void>;
	/** Called before a file is removed locally. */
	beforeDelete?: (path: string, previous: Uint8Array | null) => Promise<void>;
	isExcluded?: (path: string) => boolean;
	signal?: AbortSignal;
	onProgress?: (progress: SyncProgress) => void;
	log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
	now?: () => number;
}

export function createSummary(now: number): SyncSummary {
	return {
		startedAt: now,
		durationMs: 0,
		uploadedFiles: 0,
		downloadedFiles: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: 0,
		conflictPaths: [],
		chunksUploaded: 0,
		chunksDownloaded: 0,
		bytesUploaded: 0,
		bytesDownloaded: 0,
		naiveBytes: 0,
		skippedFiles: 0,
		gcRemoved: 0,
		warnings: [],
		errors: [],
	};
}
