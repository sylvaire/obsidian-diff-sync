import { base64Encode } from './bytes';

export interface WebDavConfig {
	/** Collection URL, e.g. https://dav.jianguoyun.com/dav/obsidian-sync */
	baseUrl: string;
	username: string;
	password: string;
	/** Remote sub-folder inside the collection, e.g. `diff-sync`. */
	rootDir: string;
	/**
	 * Minimum spacing between requests, in ms. Providers such as Jianguoyun
	 * throttle by request count and answer bursts with 503, so a small gap is
	 * far more effective than retry storms.
	 */
	minRequestIntervalMs?: number;
}

export interface HttpResponse {
	status: number;
	/** Header names must be lowercased. */
	headers: Record<string, string>;
	bytes: Uint8Array;
}

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: Uint8Array;
	timeoutMs: number;
}

/**
 * How the plugin talks HTTP.
 *
 * Obsidian's renderer applies CORS to plain `fetch`, which third-party WebDAV
 * servers do not satisfy. The plugin therefore injects a transport backed by
 * Obsidian's `requestUrl`; tests inject the fetch-based default.
 */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export class WebDavError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly url: string,
	) {
		super(message);
		this.name = 'WebDavError';
	}

	get notFound(): boolean {
		return this.status === 404;
	}

	get preconditionFailed(): boolean {
		return this.status === 412;
	}

	get unauthorized(): boolean {
		return this.status === 401 || this.status === 403;
	}
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 5;
/** Throttled requests retry longer: provider rate limits clear in tens of seconds. */
const THROTTLE_RETRIES = 8;
/** Modest pacing by default: cheap for fast servers, enough to avoid bursts. */
const DEFAULT_MIN_INTERVAL_MS = 120;

/** Default transport using `fetch`. Used by tests and by Node environments. */
export const fetchTransport: HttpTransport = async (request) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), request.timeoutMs);
	try {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body as BodyInit | undefined,
			signal: controller.signal,
			credentials: 'omit',
		});
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		const bytes = new Uint8Array(await response.arrayBuffer());
		return { status: response.status, headers, bytes };
	} finally {
		clearTimeout(timer);
	}
};

export class WebDavClient {
	private authHeader: string;
	/** Set once a conditional PUT has been observed to work (or not). */
	private conditionalWrites: boolean | null = null;
	/** When the server has told us to slow down, requests wait until this time. */
	private throttleUntil = 0;
	private throttledRequests = 0;
	/**
	 * Serialized minimum gap between requests. WebDAV providers rate-limit on
	 * request count, not bytes, so pacing matters more than concurrency.
	 */
	private nextSlot = 0;

	constructor(
		private readonly config: WebDavConfig,
		private readonly transport: HttpTransport = fetchTransport,
	) {
		// RFC 7617: the credentials are sent as-is. Percent-encoding them (the
		// reflex from URL building) breaks any username containing '@', which
		// includes every email-style login such as Jianguoyun's.
		this.authHeader = `Basic ${base64Encode(
			new TextEncoder().encode(`${config.username}:${config.password}`),
		)}`;
	}

	/** Absolute URL of the sync root (base + rootDir), without trailing slash. */
	get rootUrl(): string {
		const base = this.config.baseUrl.trim().replace(/\/+$/, '');
		const dir = this.config.rootDir.trim().replace(/^\/+|\/+$/g, '');
		return dir ? `${base}/${encodePath(dir)}` : base;
	}

	urlFor(...segments: readonly string[]): string {
		const parts = segments
			.flatMap((segment) => segment.split('/'))
			.filter((segment) => segment.length > 0)
			.map(encodePathSegment);
		return [this.rootUrl, ...parts].join('/');
	}

	private async waitForCooldown(): Promise<void> {
		const now = Date.now();
		const cooldown = this.throttleUntil > now ? this.throttleUntil : now;
		const slot = Math.max(cooldown, this.nextSlot);
		this.nextSlot = slot + (this.config.minRequestIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
		const wait = slot - now;
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	}

	private async send(
		url: string,
		options: {
			method: string;
			body?: Uint8Array;
			headers?: Record<string, string>;
			retries?: number;
			timeoutMs?: number;
		},
	): Promise<HttpResponse> {
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let retries = options.retries ?? DEFAULT_RETRIES;
		let lastError: unknown = null;
		let wasThrottled = false;

		for (let attempt = 0; attempt <= retries; attempt++) {
			await this.waitForCooldown();
			if (attempt > 0) await this.backoff(attempt, wasThrottled);
			try {
				const response = await this.transport({
					url,
					method: options.method,
					headers: { Authorization: this.authHeader, ...(options.headers ?? {}) },
					body: options.body,
					timeoutMs,
				});
				if (isTransient(response.status)) {
					if (response.status === 503 || response.status === 429) {
						// Servers such as Jianguoyun rate-limit aggressively; ease off
						// globally rather than hammering the next request too.
						this.noteThrottle();
						wasThrottled = true;
						retries = Math.max(retries, THROTTLE_RETRIES);
					}
					if (attempt < retries) {
						lastError = new WebDavError(
							`${options.method} ${url} -> ${response.status}`,
							response.status,
							url,
						);
						continue;
					}
				}
				return response;
			} catch (error) {
				lastError = error;
				if (attempt >= retries) break;
			}
		}
		const detail = lastError instanceof Error ? lastError.message : String(lastError);
		throw new WebDavError(`${options.method} ${url} 失败: ${detail}`, 0, url);
	}

	/** Exponential backoff with jitter, widened while the server is throttling. */
	private async backoff(attempt: number, throttled: boolean): Promise<void> {
		// Throttling gets a long, linear ramp (3s, 6s, 9s…) because rate-limit
		// windows are measured in tens of seconds; other errors back off faster.
		const delay = throttled
			? Math.min(20_000, 3_000 * attempt) + Math.random() * 1_000
			: 300 * Math.pow(3, attempt - 1) + Math.random() * 250;
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	private noteThrottle(): void {
		this.throttledRequests++;
		// Cooldown grows with repeated throttling, capped at 30s.
		const cooldown = Math.min(30_000, 2_000 * this.throttledRequests);
		this.throttleUntil = Date.now() + cooldown;
	}

	private assertAuthorized(response: HttpResponse, url: string): void {
		if (response.status === 401 || response.status === 403) {
			throw new WebDavError(
				'WebDAV 认证失败，请检查用户名与密码（坚果云需使用“应用密码”）',
				response.status,
				url,
			);
		}
	}

	/** PROPFIND depth 0 — does the resource exist? */
	async exists(url: string): Promise<boolean> {
		const response = await this.send(url, {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
			body: new TextEncoder().encode(PROPFIND_BODY),
		});
		this.assertAuthorized(response, url);
		// 404 is the standard "not found"; 409 is what several servers (Jianguoyun
		// among them) return for a path whose parent is also missing.
		if (response.status === 404 || response.status === 409) return false;
		if (response.status === 207 || (response.status >= 200 && response.status < 300)) return true;
		if (response.status === 405) {
			// Minimal servers reject PROPFIND on files; fall back to HEAD.
			return (await this.head(url)) !== null;
		}
		throw new WebDavError(`PROPFIND ${url} -> ${response.status}`, response.status, url);
	}

	async head(url: string): Promise<{ size: number; etag: string | null } | null> {
		const response = await this.send(url, { method: 'HEAD', retries: 1 });
		if (response.status === 404 || response.status === 405) {
			// Some servers omit HEAD; PROPFIND would be the fallback but is rarely
			// needed on the hot path.
			return null;
		}
		if (response.status < 200 || response.status >= 300) return null;
		return {
			size: Number(response.headers['content-length'] ?? '0'),
			etag: normalizeEtag(response.headers['etag'] ?? null),
		};
	}

	/** GET bytes; null on 404. */
	async get(url: string, timeoutMs?: number): Promise<Uint8Array | null> {
		const result = await this.getWithEtag(url, timeoutMs);
		return result?.body ?? null;
	}

	/** GET bytes plus validator; used for optimistic concurrency on the index. */
	async getWithEtag(
		url: string,
		timeoutMs?: number,
	): Promise<{ body: Uint8Array; etag: string | null } | null> {
		const response = await this.send(url, { method: 'GET', timeoutMs });
		if (response.status === 404) return null;
		this.assertAuthorized(response, url);
		if (response.status < 200 || response.status >= 300) {
			throw new WebDavError(`GET ${url} -> ${response.status}`, response.status, url);
		}
		return {
			body: response.bytes,
			etag: normalizeEtag(response.headers['etag'] ?? null),
		};
	}

	/**
	 * PUT. Returns `ok: false` instead of throwing on 412, letting the caller
	 * re-read and retry.
	 */
	async put(
		url: string,
		body: Uint8Array,
		options: { ifMatch?: string | null; contentType?: string; createOnly?: boolean } = {},
	): Promise<{ ok: boolean; created: boolean }> {
		const headers: Record<string, string> = {
			'Content-Type': options.contentType ?? 'application/octet-stream',
		};
		if (options.ifMatch) headers['If-Match'] = options.ifMatch;
		else if (options.createOnly) headers['If-None-Match'] = '*';

		const response = await this.send(url, { method: 'PUT', body, headers });
		if (response.status === 412) {
			this.conditionalWrites = true;
			return { ok: false, created: false };
		}
		this.assertAuthorized(response, url);
		if (response.status < 200 || response.status >= 300) {
			throw new WebDavError(`PUT ${url} -> ${response.status}`, response.status, url);
		}
		if (options.ifMatch || options.createOnly) this.conditionalWrites = true;
		return { ok: true, created: response.status === 201 };
	}

	async delete(url: string): Promise<boolean> {
		const response = await this.send(url, { method: 'DELETE', retries: 1 });
		if (response.status === 404) return false;
		this.assertAuthorized(response, url);
		if (response.status < 200 || response.status >= 300) {
			throw new WebDavError(`DELETE ${url} -> ${response.status}`, response.status, url);
		}
		return true;
	}

	/** Create a collection; returns false when it already exists. */
	async mkcol(url: string): Promise<boolean> {
		const response = await this.send(url, { method: 'MKCOL', retries: 1 });
		if (response.status === 201) return true;
		// 405 = exists on most servers; 301/302 = already exists behind a redirect.
		if (response.status === 405 || response.status === 301 || response.status === 302) return false;
		this.assertAuthorized(response, url);
		if (response.status === 409) {
			throw new WebDavError(`MKCOL ${url} -> 409（父目录不存在）`, 409, url);
		}
		if (response.status < 200 || response.status >= 300) {
			throw new WebDavError(`MKCOL ${url} -> ${response.status}`, response.status, url);
		}
		return false;
	}

	/**
	 * Recursively create every collection on the way to `collectionUrl`.
	 *
	 * Walks the full path from the server root, not just from the sync root: the
	 * configured directory itself may not exist yet (a fresh Jianguoyun folder is
	 * exactly this case), and MKCOL there returns 409 "parent missing".
	 */
	async ensureCollection(collectionUrl: string): Promise<void> {
		const base = this.config.baseUrl.trim().replace(/\/+$/, '');
		if (!collectionUrl.startsWith(base)) {
			throw new Error(`目录 ${collectionUrl} 不在服务器地址 ${base} 之内`);
		}

		const url = parseAbsoluteUrl(base);

		// Walk the full path from the server root, creating every missing level.
		// Starting from the configured base instead would skip the base itself,
		// which is precisely the missing directory on a fresh provider account.
		const segments = collectionUrl
			.slice(url.origin.length)
			.split('/')
			.filter((segment) => segment.length > 0)
			.map(decodeURIComponent);

		let current = url.origin;
		for (const segment of segments) {
			current = `${current}/${encodePathSegment(segment)}`;
			// Probe first: Jianguoyun answers a repeated MKCOL on an existing
			// collection with 503 and starts rate-limiting. Only create what is
			// actually missing.
			if (await this.exists(current)) continue;
			await this.mkcol(current);
		}
	}

	/**
	 * True when the server honours If-Match / If-None-Match on PUT.
	 * `null` means not yet observed.
	 */
	get conditionalWritesSupported(): boolean | null {
		return this.conditionalWrites;
	}
}

const PROPFIND_BODY =
	'<?xml version="1.0" encoding="utf-8"?>' +
	'<d:propfind xmlns:d="DAV:"><d:prop>' +
	'<d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/>' +
	'</d:prop></d:propfind>';

function encodePath(path: string): string {
	return path
		.split('/')
		.filter((segment) => segment.length > 0)
		.map(encodePathSegment)
		.join('/');
}

function encodePathSegment(segment: string): string {
	return encodeURIComponent(segment).replace(/%2F/gi, '/');
}

function isTransient(status: number): boolean {
	return status === 0 || status === 429 || status === 503 || status === 502 || status === 504;
}

export function normalizeEtag(etag: string | null): string | null {
	if (!etag) return null;
	const trimmed = etag.trim();
	if (trimmed === '' || trimmed === 'W/"0"') return null;
	return trimmed;
}

/** Split an absolute URL into its origin and the encoded path prefix. */
function parseAbsoluteUrl(input: string): { origin: string; pathPrefix: string } {
	const marker = input.indexOf('://');
	if (marker < 0) throw new Error(`服务器地址必须以 http:// 或 https:// 开头: ${input}`);
	const afterScheme = input.slice(marker + 3);
	const slash = afterScheme.indexOf('/');
	const host = slash < 0 ? afterScheme : afterScheme.slice(0, slash);
	const path = slash < 0 ? '' : afterScheme.slice(slash);
	return {
		origin: `${input.slice(0, marker + 3)}${host}`,
		pathPrefix: path
			.split('/')
			.filter((segment) => segment.length > 0)
			.map((segment) => `/${encodePathSegment(decodeURIComponent(segment))}`)
			.join(''),
	};
}
