import { isHashLike } from './hash';

export const INDEX_FORMAT_VERSION = 1;
export const STATE_FORMAT_VERSION = 1;

export interface RemoteFileLive {
	h: string;
	s: number;
	m: number;
	c: string[];
}

export interface RemoteFileDeleted {
	d: true;
	m: number;
}

export type RemoteFileEntry = RemoteFileLive | RemoteFileDeleted;

export interface RemoteIndex {
	v: number;
	vaultId: string;
	/** Monotonic counter, bumped on every successful write. */
	seq: number;
	updated: number;
	files: Record<string, RemoteFileEntry>;
	/** Ids of chunk blobs believed to exist remotely. */
	known: string[];
}

export interface SyncStateEntry {
	h: string;
	s: number;
	m: number;
	c: string[];
}

export interface SyncState {
	v: number;
	vaultId: string;
	/** Last known common state per path: the merge base. */
	files: Record<string, SyncStateEntry>;
	lastSync: number | null;
}

export function isLive(entry: RemoteFileEntry | undefined): entry is RemoteFileLive {
	return !!entry && !(entry as RemoteFileDeleted).d;
}

export function createEmptyState(vaultId: string): SyncState {
	return { v: STATE_FORMAT_VERSION, vaultId, files: {}, lastSync: null };
}

export function createEmptyIndex(vaultId: string, now: number): RemoteIndex {
	return {
		v: INDEX_FORMAT_VERSION,
		vaultId,
		seq: 0,
		updated: now,
		files: {},
		known: [],
	};
}

function validLiveEntry(value: unknown): value is RemoteFileLive {
	if (!value || typeof value !== 'object') return false;
	const e = value as Partial<RemoteFileLive>;
	return (
		isHashLike(e.h) &&
		typeof e.s === 'number' &&
		Number.isFinite(e.s) &&
		e.s >= 0 &&
		typeof e.m === 'number' &&
		Array.isArray(e.c) &&
		e.c.every((id) => isHashLike(id))
	);
}

function validDeletedEntry(value: unknown): value is RemoteFileDeleted {
	if (!value || typeof value !== 'object') return false;
	const e = value as Partial<RemoteFileDeleted>;
	return e.d === true && typeof e.m === 'number';
}

/**
 * Defensive parse of a remote index. Unknown/invalid entries are dropped
 * rather than failing the whole sync: a single corrupt record must not brick
 * the vault.
 */
export function parseIndex(raw: unknown): RemoteIndex | null {
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (!raw || typeof raw !== 'object') return null;
	const data = raw as Partial<RemoteIndex>;
	if (data.v !== INDEX_FORMAT_VERSION) return null;
	if (typeof data.vaultId !== 'string' || data.vaultId.length === 0) return null;

	const files: Record<string, RemoteFileEntry> = {};
	if (data.files && typeof data.files === 'object') {
		for (const [path, entry] of Object.entries(data.files)) {
			if (validLiveEntry(entry)) {
				files[path] = { h: entry.h, s: entry.s, m: entry.m, c: [...entry.c] };
			} else if (validDeletedEntry(entry)) {
				files[path] = { d: true, m: entry.m };
			}
		}
	}

	const known = Array.isArray(data.known) ? data.known.filter(isHashLike) : [];

	return {
		v: INDEX_FORMAT_VERSION,
		vaultId: data.vaultId,
		seq: typeof data.seq === 'number' && Number.isFinite(data.seq) ? data.seq : 0,
		updated: typeof data.updated === 'number' ? data.updated : 0,
		files,
		known: [...new Set(known)],
	};
}

export function parseState(raw: unknown): SyncState | null {
	if (!raw || typeof raw !== 'object') return null;
	const data = raw as Partial<SyncState>;
	if (data.v !== STATE_FORMAT_VERSION) return null;
	if (typeof data.vaultId !== 'string' || data.vaultId.length === 0) return null;

	const files: Record<string, SyncStateEntry> = {};
	if (data.files && typeof data.files === 'object') {
		for (const [path, entry] of Object.entries(data.files)) {
			if (!validLiveEntry(entry)) continue;
			files[path] = { h: entry.h, s: entry.s, m: entry.m, c: [...entry.c] };
		}
	}

	return {
		v: STATE_FORMAT_VERSION,
		vaultId: data.vaultId,
		files,
		lastSync: typeof data.lastSync === 'number' ? data.lastSync : null,
	};
}

/** Serialize deterministically so unchanged data yields an unchanged ETag. */
export function serializeIndex(index: RemoteIndex): string {
	const files: Record<string, RemoteFileEntry> = {};
	for (const path of Object.keys(index.files).sort()) files[path] = index.files[path];
	return JSON.stringify({
		v: index.v,
		vaultId: index.vaultId,
		seq: index.seq,
		updated: index.updated,
		files,
		known: [...new Set(index.known)].sort(),
	});
}

export function referencedChunkIds(index: RemoteIndex): Set<string> {
	const ids = new Set<string>();
	for (const entry of Object.values(index.files)) {
		if (isLive(entry)) for (const id of entry.c) ids.add(id);
	}
	return ids;
}
