/**
 * Minimal WebDAV server for tests: OPTIONS/GET/HEAD/PUT/DELETE/MKCOL/PROPFIND,
 * ETag support, If-Match / If-None-Match preconditions.
 *
 * Backed by a temp directory, so tests exercise the real HTTP client.
 */
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const XML_MIME = 'application/xml; charset=utf-8';

export class WebDavServer {
	/**
	 * @param {{ root: string, user?: string, pass?: string,
	 *           ignoreConditional?: boolean, latencyMs?: number }} options
	 */
	constructor(options) {
		this.options = options;
		this.server = null;
		this.port = 0;
		this.stats = { requests: {}, bytesIn: 0, bytesOut: 0 };
		/** Per-path mutex: real servers apply preconditions atomically. */
		this.locks = new Map();
	}

	async withLock(key, fn) {
		const previous = this.locks.get(key) ?? Promise.resolve();
		let release;
		const current = new Promise((resolve) => (release = resolve));
		this.locks.set(key, previous.then(() => current));
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (this.locks.get(key) === previous.then(() => current)) this.locks.delete(key);
		}
	}

	get url() {
		return `http://127.0.0.1:${this.port}/dav`;
	}

	get davRoot() {
		return path.resolve(this.options.root, 'dav');
	}

	async start() {
		await fs.mkdir(this.davRoot, { recursive: true });
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((error) => {
				if (!res.headersSent) {
					res.statusCode = 500;
					res.end(String(error?.stack ?? error));
				}
			});
		});
		await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		this.port = this.server.address().port;
	}

	async stop() {
		await new Promise((resolve, reject) => {
			this.server?.close((error) => (error ? reject(error) : resolve()));
		});
	}

	resetStats() {
		for (const key of Object.keys(this.stats.requests)) delete this.stats.requests[key];
		this.stats.bytesIn = 0;
		this.stats.bytesOut = 0;
	}

	/** Files currently on disk under the DAV root, relative and sorted. */
	async listFiles() {
		const out = [];
		const walk = async (dir, prefix) => {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
				else out.push(rel);
			}
		};
		await walk(this.davRoot, '');
		return out.sort();
	}

	async readFile(relPath) {
		return fs.readFile(path.join(this.davRoot, ...relPath.split('/')));
	}

	fsPath(url) {
		const decoded = decodeURIComponent(url.pathname);
		if (!decoded.startsWith('/dav')) throw new Error(`unexpected path ${decoded}`);
		const rel = decoded.slice('/dav'.length).replace(/^\/+/, '');
		const resolved = path.resolve(this.davRoot, rel);
		if (resolved !== this.davRoot && !resolved.startsWith(this.davRoot + path.sep)) {
			throw new Error('path traversal attempt');
		}
		return resolved;
	}

	authorized(req) {
		const { user, pass } = this.options;
		if (!user && !pass) return true;
		const header = req.headers.authorization ?? '';
		if (!header.startsWith('Basic ')) return false;
		return Buffer.from(header.slice(6), 'base64').toString('utf8') === `${user}:${pass}`;
	}

	hrefFor(fsPath) {
		const rel = path.relative(this.davRoot, fsPath);
		const segments = rel.split(path.sep).filter(Boolean).map(encodeURIComponent);
		return `/dav/${segments.join('/')}`;
	}

	async etagFor(fsPath) {
		try {
			const stat = await fs.stat(fsPath);
			if (stat.isDirectory()) return null;
			const hash = createHash('md5').update(`${stat.size}:${stat.mtimeMs}`).digest('hex');
			return `"${hash}"`;
		} catch {
			return null;
		}
	}

	async readBody(req) {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		this.stats.bytesIn += body.length;
		return body;
	}

	send(res, status, body, headers = {}) {
		const payload = body ?? '';
		if (payload) this.stats.bytesOut += Buffer.byteLength(payload);
		res.writeHead(status, {
			'Content-Length': String(Buffer.byteLength(payload)),
			...headers,
		});
		res.end(payload);
	}

	async handle(req, res) {
		const method = req.method ?? 'GET';
		this.stats.requests[method] = (this.stats.requests[method] ?? 0) + 1;
		if (this.options.latencyMs) await new Promise((r) => setTimeout(r, this.options.latencyMs));

		if (!this.authorized(req)) {
			this.send(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Basic realm="test"' });
			return;
		}

		const url = new URL(req.url ?? '/', 'http://localhost');
		const fsPath = this.fsPath(url);

		switch (method) {
			case 'OPTIONS':
				this.send(res, 200, '', {
					DAV: '1,2',
					Allow: 'OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,PROPFIND',
				});
				return;

			case 'GET': {
				try {
					const data = await fs.readFile(fsPath);
					const etag = await this.etagFor(fsPath);
					this.stats.bytesOut += data.length;
					res.writeHead(200, {
						'Content-Length': String(data.length),
						'Content-Type': 'application/octet-stream',
						...(etag ? { ETag: etag } : {}),
					});
					res.end(data);
				} catch {
					this.send(res, 404, 'Not Found');
				}
				return;
			}

			case 'HEAD': {
				try {
					const stat = await fs.stat(fsPath);
					if (stat.isDirectory()) {
						this.send(res, 404, '');
						return;
					}
					const etag = await this.etagFor(fsPath);
					res.writeHead(200, {
						'Content-Length': String(stat.size),
						...(etag ? { ETag: etag } : {}),
					});
					res.end();
				} catch {
					this.send(res, 404, '');
				}
				return;
			}

			case 'PUT': {
				const body = await this.readBody(req);
				await this.withLock(fsPath, async () => {
					const existing = await this.etagFor(fsPath);
					if (!this.options.ignoreConditional) {
						const ifMatch = req.headers['if-match'];
						const ifNoneMatch = req.headers['if-none-match'];
						if (typeof ifMatch === 'string' && ifMatch !== '*' && ifMatch !== existing) {
							this.send(res, 412, 'Precondition Failed');
							return;
						}
						if (ifNoneMatch === '*' && existing !== null) {
							this.send(res, 412, 'Precondition Failed');
							return;
						}
					}
					await fs.mkdir(path.dirname(fsPath), { recursive: true });
					const created = existing === null;
					await fs.writeFile(fsPath, body);
					const etag = await this.etagFor(fsPath);
					this.send(res, created ? 201 : 204, '', etag ? { ETag: etag } : {});
				});
				return;
			}

			case 'DELETE':
				try {
					await fs.rm(fsPath, { recursive: true, force: false });
					this.send(res, 204, '');
				} catch {
					this.send(res, 404, 'Not Found');
				}
				return;

			case 'MKCOL':
				try {
					await fs.mkdir(fsPath, { recursive: false });
					this.send(res, 201, '');
				} catch (error) {
					const code = error?.code;
					if (code === 'EEXIST') this.send(res, 405, 'Method Not Allowed');
					else if (code === 'ENOENT') this.send(res, 409, 'Conflict');
					else this.send(res, 500, 'Error');
				}
				return;

			case 'PROPFIND': {
				const depth = req.headers.depth ?? '0';
				let stat;
				try {
					stat = await fs.stat(fsPath);
				} catch {
					this.send(res, 404, 'Not Found', { 'Content-Type': XML_MIME });
					return;
				}
				const entries = [{ fsPath, stat }];
				if (depth !== '0' && stat.isDirectory()) {
					for (const name of await fs.readdir(fsPath)) {
						const child = path.join(fsPath, name);
						entries.push({ fsPath: child, stat: await fs.stat(child) });
					}
				}
				const responses = [];
				for (const entry of entries) {
					const etag = entry.stat.isDirectory() ? null : await this.etagFor(entry.fsPath);
					responses.push(
						'<d:response>' +
							`<d:href>${this.hrefFor(entry.fsPath)}${entry.stat.isDirectory() ? '/' : ''}</d:href>` +
							'<d:propstat><d:prop>' +
							`<d:resourcetype>${entry.stat.isDirectory() ? '<d:collection/>' : ''}</d:resourcetype>` +
							`<d:getcontentlength>${entry.stat.isDirectory() ? 0 : entry.stat.size}</d:getcontentlength>` +
							(etag ? `<d:getetag>${etag}</d:getetag>` : '') +
							`<d:getlastmodified>${new Date(entry.stat.mtimeMs).toUTCString()}</d:getlastmodified>` +
							'</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>' +
							'</d:response>',
					);
				}
				this.send(
					res,
					207,
					'<?xml version="1.0" encoding="utf-8"?>' +
						'<d:multistatus xmlns:d="DAV:">' +
						responses.join('') +
						'</d:multistatus>',
					{ 'Content-Type': XML_MIME },
				);
				return;
			}

			default:
				this.send(res, 405, 'Method Not Allowed');
		}
	}
}
