/** Vault-relative path helpers (always '/'-separated). */

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '');
}

export function dirname(path: string): string {
	const normalized = normalizePath(path);
	const idx = normalized.lastIndexOf('/');
	return idx <= 0 ? '' : normalized.slice(0, idx);
}

export function basename(path: string): string {
	const normalized = normalizePath(path);
	const idx = normalized.lastIndexOf('/');
	return idx < 0 ? normalized : normalized.slice(idx + 1);
}

export function extensionOf(name: string): string {
	const base = basename(name);
	const idx = base.lastIndexOf('.');
	return idx <= 0 ? '' : base.slice(idx);
}

export function joinPath(...parts: readonly string[]): string {
	const cleaned = parts.map((p) => normalizePath(p)).filter((p) => p.length > 0);
	return cleaned.join('/');
}

/** Make a string safe as a single path segment on every platform. */
export function sanitizeSegment(input: string): string {
	return (
		input
			// eslint-disable-next-line no-control-regex -- Control characters are invalid in portable filenames.
			.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-')
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/[. ]+$/, '')
			.slice(0, 64) || 'device'
	);
}

export function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	);
}

/**
 * Name for the losing side of a conflict, e.g.
 * `note.conflict-20240101-120000-laptop.md`.
 */
export function conflictCopyPath(
	path: string,
	deviceName: string,
	now: number,
	isTaken: (candidate: string) => boolean,
): string {
	const dir = dirname(path);
	const base = basename(path);
	const ext = extensionOf(base);
	const stem = ext ? base.slice(0, -ext.length) : base;
	const device = sanitizeSegment(deviceName);
	const stamp = formatTimestamp(now);

	for (let attempt = 0; attempt < 1000; attempt++) {
		const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
		const candidate = joinPath(
			dir,
			`${stem}.conflict-${stamp}-${device}${suffix}${ext}`,
		);
		if (!isTaken(candidate)) return candidate;
	}
	throw new Error(`Unable to find a free conflict copy name for "${path}"`);
}
