/** In-memory vault implementing the engine's LocalVault contract. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class DiskVault {
	constructor(root) {
		this.root = root;
		this.mtimes = new Map();
	}

	abs(p) {
		return path.join(this.root, ...p.split('/'));
	}

	async list() {
		const out = [];
		const walk = async (dir, prefix) => {
			let entries;
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) await walk(full, rel);
				else {
					const stat = await fs.stat(full);
					out.push({ path: rel, size: stat.size, mtime: this.mtimes.get(rel) ?? stat.mtimeMs });
				}
			}
		};
		await walk(this.root, '');
		return out;
	}

	async stat(p) {
		try {
			const stat = await fs.stat(this.abs(p));
			return { path: p, size: stat.size, mtime: this.mtimes.get(p) ?? stat.mtimeMs };
		} catch {
			return null;
		}
	}

	async read(p) {
		return new Uint8Array(await fs.readFile(this.abs(p)));
	}

	async write(p, data) {
		const full = this.abs(p);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, data);
		this.mtimes.set(p, Date.now() + (this.mtimes.size + 1) * 10);
	}

	async remove(p) {
		await fs.rm(this.abs(p), { force: true });
		this.mtimes.delete(p);
	}

	async exists(p) {
		try {
			await fs.access(this.abs(p));
			return true;
		} catch {
			return false;
		}
	}

	/** Test helper: write and set an explicit mtime. */
	async writeAt(p, text, mtime) {
		const full = this.abs(p);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, text);
		this.mtimes.set(p, mtime);
	}

	async readText(p) {
		return fs.readFile(this.abs(p), 'utf8');
	}

	async paths() {
		return (await this.list()).map((f) => f.path);
	}
}
