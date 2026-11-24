import { utf8Decode, utf8Encode } from './bytes';
import { seal, open } from './crypto';
import { t } from './i18n';
import { parseIndex, RemoteIndex, serializeIndex } from './manifest';
import { WebDavClient } from './webdav';

export const META_FILE = 'meta.json';
export const PLAIN_INDEX_FILE = 'index.json';
export const ENCRYPTED_INDEX_FILE = 'index.enc';
export const CHUNK_DIR = 'chunks';
export const LOCK_FILE = 'lock.json';

export interface RemoteMeta {
	v: 1;
	vaultId: string;
	encrypted: boolean;
	kdf?: { salt: string; iterations: number };
	verifier?: string;
}

export interface RemoteIndexSnapshot {
	index: RemoteIndex;
	etag: string | null;
}

export class VaultMismatchError extends Error {
	constructor(
		readonly remoteVaultId: string,
		readonly localVaultId: string,
	) {
		super(
			t('error.vaultMismatch', {
				remote: remoteVaultId,
				local: localVaultId,
			}),
		);
		this.name = 'VaultMismatchError';
	}
}

export interface RemoteStoreOptions {
	client: WebDavClient;
	/** `meta.json` contents for this remote root. */
	meta: RemoteMeta;
	key: CryptoKey | null;
	concurrency: number;
}

/**
 * Remote layout:
 *   <root>/meta.json            vault identity + encryption parameters
 *   <root>/index.json|.enc      the file manifest
 *   <root>/chunks/<id>          content-addressed chunk blobs
 *   <root>/lock.json            advisory sync lock
 */
export class RemoteStore {
	private readonly client: WebDavClient;
	private readonly meta: RemoteMeta;
	private readonly key: CryptoKey | null;
	readonly concurrency: number;

	constructor(options: RemoteStoreOptions) {
		this.client = options.client;
		this.meta = options.meta;
		this.key = options.key;
		this.concurrency = Math.max(1, options.concurrency);
	}

	get vaultId(): string {
		return this.meta.vaultId;
	}

	get encrypted(): boolean {
		return this.meta.encrypted;
	}

	// ---------------------------------------------------------------- bootstrap

	static async readMeta(client: WebDavClient): Promise<RemoteMeta | null> {
		const bytes = await client.get(client.urlFor(META_FILE));
		if (!bytes) return null;
		try {
			const parsed = JSON.parse(utf8Decode(bytes)) as Partial<RemoteMeta>;
			if (parsed.v !== 1 || typeof parsed.vaultId !== 'string') return null;
			return {
				v: 1,
				vaultId: parsed.vaultId,
				encrypted: parsed.encrypted === true,
				kdf: parsed.kdf,
				verifier: parsed.verifier,
			};
		} catch {
			return null;
		}
	}

	static async writeMeta(client: WebDavClient, meta: RemoteMeta): Promise<void> {
		await client.put(client.urlFor(META_FILE), utf8Encode(JSON.stringify(meta, null, 2)), {
			contentType: 'application/json',
			// Refuse to clobber a different vault's metadata.
			createOnly: true,
		});
	}

	async ensureCollections(): Promise<void> {
		await this.client.ensureCollection(this.client.rootUrl);
		await this.client.ensureCollection(this.client.urlFor(CHUNK_DIR));
	}

	// -------------------------------------------------------------------- index

	private get indexUrl(): string {
		return this.client.urlFor(this.encrypted ? ENCRYPTED_INDEX_FILE : PLAIN_INDEX_FILE);
	}

	async loadIndex(): Promise<RemoteIndexSnapshot | null> {
		const result = await this.client.getWithEtag(this.indexUrl);
		if (!result) return null;

		let payload: Uint8Array = result.body;
		if (this.key) {
			try {
				payload = await open(this.key, result.body, 'index');
			} catch {
				throw new Error(t('error.indexDecryptFailed'));
			}
		}

		const index = parseIndex(utf8Decode(payload));
		if (!index) throw new Error(t('error.indexFormat'));
		if (index.vaultId !== this.meta.vaultId) {
			throw new Error(t('error.indexVaultIdMismatch'));
		}
		return { index, etag: result.etag };
	}

	async saveIndex(index: RemoteIndex, etag: string | null): Promise<{ ok: boolean; etag: string | null }> {
		const payload = utf8Encode(serializeIndex(index));
		const body = this.key ? await seal(this.key, payload, 'index') : payload;
		const result = await this.client.put(this.indexUrl, body, {
			contentType: this.key ? 'application/octet-stream' : 'application/json',
			// Absent ETag => the index did not exist; guard the first write so we
			// never clobber an index another device created in the meantime.
			ifMatch: etag ?? undefined,
			createOnly: etag === null,
		});
		if (!result.ok) return { ok: false, etag: null };
		const head = await this.client.head(this.indexUrl);
		return { ok: true, etag: head?.etag ?? null };
	}

	// ------------------------------------------------------------------- chunks

	private chunkUrl(id: string): string {
		return this.client.urlFor(CHUNK_DIR, id.slice(0, 2), id);
	}

	async getChunk(id: string): Promise<Uint8Array | null> {
		const body = await this.client.get(this.chunkUrl(id));
		if (!body) return null;
		return this.key ? open(this.key, body, id) : body;
	}

	async putChunk(id: string, plaintext: Uint8Array): Promise<void> {
		const body = this.key ? await seal(this.key, plaintext, id) : plaintext;
		// Collections are sharded by id prefix to keep directory listings sane.
		await this.client.ensureCollection(this.client.urlFor(CHUNK_DIR, id.slice(0, 2)));
		const result = await this.client.put(this.chunkUrl(id), body);
		if (!result.ok) throw new Error(t('error.chunkUploadFailed', { id }));
	}

	async deleteChunk(id: string): Promise<void> {
		await this.client.delete(this.chunkUrl(id));
	}

	// --------------------------------------------------------------------- lock

	async acquireLock(device: string, ttlMs: number): Promise<{ ok: true } | { ok: false; holder: string }> {
		const now = Date.now();
		const existing = await this.client.get(this.client.urlFor(LOCK_FILE));
		if (existing) {
			try {
				const parsed = JSON.parse(utf8Decode(existing)) as { device?: string; expires?: number };
				if (typeof parsed.expires === 'number' && parsed.expires > now && parsed.device !== device) {
					return { ok: false, holder: parsed.device ?? 'unknown' };
				}
			} catch {
				// Fall through: treat a corrupt lock as stale.
			}
		}
		await this.client.put(
			this.client.urlFor(LOCK_FILE),
			utf8Encode(JSON.stringify({ device, expires: now + ttlMs, at: now })),
			{ contentType: 'application/json' },
		);
		return { ok: true };
	}

	async releaseLock(): Promise<void> {
		try {
			await this.client.delete(this.client.urlFor(LOCK_FILE));
		} catch {
			// A stale lock expires on its own; never fail a sync over it.
		}
	}

	/** Probe support for conditional writes; some WebDAV servers ignore If-Match. */
	async supportsConditionalWrites(): Promise<boolean | null> {
		return this.client.conditionalWritesSupported;
	}
}
