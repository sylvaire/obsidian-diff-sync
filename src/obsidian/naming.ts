/** Small naming helpers shared by the Obsidian layer. */

export function safeSegment(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	const idx = normalized.lastIndexOf('/');
	return idx < 0 ? normalized : normalized.slice(idx + 1);
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const value = bytes / Math.pow(1024, exponent);
	return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

export function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}
