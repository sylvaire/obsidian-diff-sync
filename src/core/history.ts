/**
 * Local snapshot history.
 *
 * Before a download overwrites a file, the previous revision is copied into a
 * hidden folder inside the vault. This is the last-resort safety net for the
 * case where a bad remote state arrives (e.g. a peer synced a corrupted index):
 * the conflict-copy strategy protects concurrent edits, this protects history.
 */

export const HISTORY_DIR = '.diff-sync-history';
export const DEFAULT_RETENTION = 20;

export interface HistoryEntry {
	/** Snapshot folder name, e.g. `20240101-120000`. */
	stamp: string;
	/** Vault-relative path of the snapshot. */
	path: string;
}

export function historyPathFor(originalPath: string, stamp: string): string {
	const normalized = originalPath.replace(/^\/+/, '');
	return `${HISTORY_DIR}/${stamp}/${normalized}`;
}

/** Sortable, filesystem-safe timestamp used as the snapshot folder. */
export function snapshotStamp(now: number): string {
	const d = new Date(now);
	const pad = (n: number, width = 2) => String(n).padStart(width, '0');
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
		`${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
		`${pad(d.getMilliseconds(), 3)}`
	);
}

/**
 * Which snapshot folders to delete so that at most `limit` remain.
 * Pure so it can be tested without a vault.
 */
export function staleSnapshots(folders: readonly string[], limit: number): string[] {
	const sorted = [...new Set(folders)].filter((f) => /^\d{8}-\d{6}-\d{3}$/.test(f)).sort();
	if (sorted.length <= limit) return [];
	return sorted.slice(0, sorted.length - limit);
}
