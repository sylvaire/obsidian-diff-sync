import { DataAdapter } from 'obsidian';
import { t } from '../core/i18n';
import { ChunkCache } from '../core/types';
import { safeSegment } from './naming';

/**
 * On-disk chunk cache under the plugin's own data directory.
 *
 * Keeping the chunk store on disk (not in memory) is what makes differential
 * sync practical across restarts: after a restart, chunks the remote and local
 * file already contain never have to be fetched again.
 */
export class DiskChunkCache implements ChunkCache {
	private readonly dir: string;
	private inflightPuts = new Map<string, Promise<void>>();

	constructor(
		private readonly adapter: DataAdapter,
		pluginDir: string,
	) {
		this.dir = `${pluginDir}/chunks`;
	}

	private pathFor(id: string): string {
		if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(t('error.invalidChunkId', { id }));
		return `${this.dir}/${id.slice(0, 2)}/${id}`;
	}

	async has(id: string): Promise<boolean> {
		return this.adapter.exists(this.pathFor(id));
	}

	async get(id: string): Promise<Uint8Array | null> {
		const path = this.pathFor(id);
		if (!(await this.adapter.exists(path))) return null;
		try {
			return new Uint8Array(await this.adapter.readBinary(path));
		} catch {
			return null;
		}
	}

	async put(id: string, data: Uint8Array): Promise<void> {
		const existing = this.inflightPuts.get(id);
		if (existing) return existing;

		const job = (async () => {
			const path = this.pathFor(id);
			const parent = `${this.dir}/${id.slice(0, 2)}`;
			if (!(await this.adapter.exists(parent))) {
				await this.adapter.mkdir(parent);
			}
			// tmp -> rename keeps a crash from leaving a half-written chunk behind.
			const tmp = `${path}.tmp`;
			await this.adapter.writeBinary(tmp, toArrayBuffer(data));
			if (await this.adapter.exists(path)) await this.adapter.remove(path);
			await this.adapter.rename(tmp, path);
		})();

		this.inflightPuts.set(id, job);
		try {
			await job;
		} finally {
			this.inflightPuts.delete(id);
		}
	}

	async delete(id: string): Promise<void> {
		const path = this.pathFor(id);
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
	}

	async list(): Promise<string[]> {
		const ids: string[] = [];
		if (!(await this.adapter.exists(this.dir))) return ids;
		const listing = await this.adapter.list(this.dir);
		for (const prefixDir of listing.folders) {
			const inner = await this.adapter.list(prefixDir);
			for (const file of inner.files) {
				const name = safeSegment(file);
				if (/^[0-9a-f]{32}$/.test(name)) ids.push(name);
			}
		}
		return ids;
	}

	async clear(): Promise<void> {
		if (await this.adapter.exists(this.dir)) {
			await this.adapter.rmdir(this.dir, true);
		}
	}

	/** Approximate size in bytes, for the status display. */
	async size(): Promise<{ count: number; bytes: number }> {
		let count = 0;
		let bytes = 0;
		if (!(await this.adapter.exists(this.dir))) return { count, bytes };
		const listing = await this.adapter.list(this.dir);
		for (const prefixDir of listing.folders) {
			const inner = await this.adapter.list(prefixDir);
			for (const file of inner.files) {
				const stat = await this.adapter.stat(file);
				if (!stat) continue;
				count++;
				bytes += stat.size;
			}
		}
		return { count, bytes };
	}
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
		? (data.buffer as ArrayBuffer)
		: data.slice().buffer;
}
