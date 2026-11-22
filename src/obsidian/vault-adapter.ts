import { App, DataAdapter, normalizePath, TFile } from 'obsidian';
import { LocalFileInfo, LocalVault } from '../core/types';

/**
 * `LocalVault` over the Obsidian vault adapter.
 *
 * The adapter is used instead of the Vault API so binary files, hidden paths and
 * files Obsidian has not indexed are all handled uniformly.
 */
export class ObsidianVault implements LocalVault {
	constructor(
		private readonly app: App,
		private readonly excluded: (path: string) => boolean,
	) {}

	private get adapter(): DataAdapter {
		return this.app.vault.adapter;
	}

	async list(): Promise<LocalFileInfo[]> {
		const files: LocalFileInfo[] = [];

		const walk = async (dir: string): Promise<void> => {
			const listing = await this.adapter.list(dir);
			for (const folder of listing.folders) {
				await walk(folder);
			}
			for (const file of listing.files) {
				const rel = normalizePath(file);
				if (this.excluded(rel)) continue;
				const stat = await this.adapter.stat(rel);
				if (!stat) continue;
				files.push({ path: rel, size: stat.size, mtime: stat.mtime });
			}
		};

		await walk('');
		return files;
	}

	async stat(path: string): Promise<LocalFileInfo | null> {
		const stat = await this.adapter.stat(normalizePath(path));
		if (!stat || stat.type !== 'file') return null;
		return { path: normalizePath(path), size: stat.size, mtime: stat.mtime };
	}

	async read(path: string): Promise<Uint8Array> {
		const buffer = await this.adapter.readBinary(normalizePath(path));
		return new Uint8Array(buffer);
	}

	async write(path: string, data: Uint8Array): Promise<void> {
		const normalized = normalizePath(path);
		await this.ensureParent(normalized);
		await this.adapter.writeBinary(normalized, copyToArrayBuffer(data));
	}

	async remove(path: string): Promise<void> {
		const normalized = normalizePath(path);
		// Prefer the Vault API when the file is tracked, so Obsidian's own caches
		// and open editors stay consistent.
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
			return;
		}
		const stat = await this.adapter.stat(normalized);
		if (stat?.type === 'file') {
			if (!(await this.adapter.trashSystem(normalized))) {
				await this.adapter.trashLocal(normalized);
			}
		}
	}

	async exists(path: string): Promise<boolean> {
		return this.adapter.exists(normalizePath(path));
	}

	private async ensureParent(path: string): Promise<void> {
		const idx = path.lastIndexOf('/');
		if (idx <= 0) return;
		const dir = path.slice(0, idx);
		if (await this.adapter.exists(dir)) return;
		await this.adapter.mkdir(dir);
	}
}

/** Structured clone of the bytes: some adapters keep a reference to the buffer. */
function copyToArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
		? (data.buffer as ArrayBuffer)
		: (data.slice().buffer as ArrayBuffer);
}
