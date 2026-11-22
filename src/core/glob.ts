/** Tiny glob matcher for vault include/exclude patterns. */

function escapeRegex(ch: string): string {
	return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(pattern: string): RegExp {
	const cleaned = pattern.trim().replace(/^\.?\/+/, '').replace(/\\/g, '/');
	let source = '^';
	for (let i = 0; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (ch === '*') {
			if (cleaned[i + 1] === '*') {
				// `**/` matches zero or more directories; bare `**` matches anything.
				if (cleaned[i + 2] === '/') {
					source += '(?:.*/)?';
					i += 2;
				} else {
					source += '.*';
					i += 1;
				}
			} else {
				source += '[^/]*';
			}
		} else if (ch === '?') {
			source += '[^/]';
		} else if (ch === '/') {
			source += '/';
		} else {
			source += escapeRegex(ch);
		}
	}
	source += '$';
	return new RegExp(source);
}

export class PathFilter {
	private readonly matchers: RegExp[];

	constructor(patterns: readonly string[]) {
		this.matchers = patterns
			.map((p) => p.trim())
			.filter((p) => p.length > 0 && !p.startsWith('#'))
			.map(globToRegExp);
	}

	/** True when the path is excluded by any pattern. */
	excluded(path: string): boolean {
		const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
		return this.matchers.some((re) => re.test(normalized));
	}
}

export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
	'# 一行一个 glob，** 表示任意层级',
	'.trash/**',
	'.git/**',
	'**/.DS_Store',
	'**/desktop.ini',
	'**/Thumbs.db',
	'**/*.tmp',
	'**/~$*',
];
