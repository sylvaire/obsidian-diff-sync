/**
 * End-to-end test of the *built plugin bundle* against a real WebDAV server.
 *
 * Unlike run-tests.mjs (which tests the pure core), this exercises the actual
 * Obsidian layer shipped to users: DiskChunkCache, ObsidianVault, the request
 * transport, state persistence and the plugin's own sync() entry point.
 */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebDavServer } from './dav-server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const bundlePath = path.join(root, 'main.js');

if (typeof window === 'undefined') globalThis.window = globalThis;

// ------------------------------------------------------------- obsidian stub

const notices = [];

class StubPlugin {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest;
		this.data = null;
	}
	addCommand() {}
	addRibbonIcon() {
		return { remove() {} };
	}
	addStatusBarItem() {
		return {
			setText() {},
			setAttribute() {},
			addEventListener() {},
			addClass() {},
			remove() {},
			title: '',
		};
	}
	addSettingTab() {}
	registerView() {}
	registerEvent() {}
	registerInterval() {}
	async loadData() {
		return this.data;
	}
	async saveData(data) {
		this.data = data;
	}
}

class StubItemView {
	constructor(leaf) {
		this.leaf = leaf;
		this.app = { setting: { open() {}, openTabById() {} } };
		this.contentEl = { empty() {}, createEl: () => ({ style: {}, createSpan: () => ({}) }), createDiv: () => ({ createDiv: () => ({}) }) };
	}
	addAction() {}
}

const obsidianStub = {
	ItemView: StubItemView,
	View: StubItemView,
	setIcon: () => {},
	Plugin: StubPlugin,
	Modal: class {
		constructor() {
			this.contentEl = { empty() {}, createEl: () => ({ style: {} }), createDiv: () => ({ createEl: () => ({ addEventListener() {} }) }) };
		}
		open() {}
		close() {}
	},
	Setting: class {
		constructor() {}
		setName() {
			return this;
		}
		setDesc() {
			return this;
		}
		setHeading() {
			return this;
		}
		addText() {
			return this;
		}
		addTextArea() {
			return this;
		}
		addToggle() {
			return this;
		}
		addSlider() {
			return this;
		}
		addButton() {
			return this;
		}
	},
	Notice: class {
		constructor(message, duration) {
			notices.push({ message, duration });
		}
	},
	TFile: class {},
	TAbstractFile: class {},
	PluginSettingTab: class {
		constructor() {
			this.containerEl = {};
		}
	},
	Platform: { isWin: process.platform === 'win32', isMacOS: process.platform === 'darwin', isLinux: process.platform === 'linux' },
	normalizePath: (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, ''),
	requestUrl: async (request) => {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body ? Buffer.from(request.body) : undefined,
		});
		const headers = {};
		response.headers.forEach((v, k) => (headers[k] = v));
		return {
			status: response.status,
			headers,
			arrayBuffer: await response.arrayBuffer(),
		};
	},
	debounce: (fn) => fn,
};

// ------------------------------------------------------------ vault adapter

class DiskAdapter {
	constructor(dir) {
		this.dir = dir;
	}
	abs(p) {
		return path.join(this.dir, ...p.split('/').filter(Boolean));
	}
	async exists(p) {
		try {
			await fs.access(this.abs(p));
			return true;
		} catch {
			return false;
		}
	}
	async read(p) {
		return fs.readFile(this.abs(p), 'utf8');
	}
	async write(p, data) {
		const full = this.abs(p);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, data);
	}
	async readBinary(p) {
		const buffer = await fs.readFile(this.abs(p));
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	}
	async writeBinary(p, data) {
		const full = this.abs(p);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, Buffer.from(data));
	}
	async mkdir(p) {
		await fs.mkdir(this.abs(p), { recursive: true });
	}
	async rmdir(p, recursive) {
		await fs.rm(this.abs(p), { recursive: recursive !== false, force: true });
	}
	async remove(p) {
		await fs.rm(this.abs(p), { force: true });
	}
	async rename(from, to) {
		await fs.mkdir(path.dirname(this.abs(to)), { recursive: true });
		await fs.rename(this.abs(from), this.abs(to));
	}
	async list(p) {
		const full = this.abs(p);
		let entries;
		try {
			entries = await fs.readdir(full, { withFileTypes: true });
		} catch {
			return { files: [], folders: [] };
		}
		const prefix = p ? `${p}/` : '';
		return {
			files: entries.filter((e) => e.isFile()).map((e) => `${prefix}${e.name}`),
			folders: entries.filter((e) => e.isDirectory()).map((e) => `${prefix}${e.name}`),
		};
	}
	async stat(p) {
		try {
			const s = await fs.stat(this.abs(p));
			if (!s.isFile()) return null;
			return { type: 'file', size: s.size, mtime: s.mtimeMs };
		} catch {
			return null;
		}
	}
}

function makeApp(vaultRoot, configDir = '.obsidian') {
	const adapter = new DiskAdapter(vaultRoot);
	return {
		vault: {
			adapter,
			configDir,
			getAbstractFileByPath: (filePath) => filePath === 'notes/small.md'
				? Object.assign(new obsidianStub.TFile(), { path: filePath })
				: null,
			on: () => ({ unref() {} }),
		},
		fileManager: {
			trashFile: async (file) => {
				await adapter.mkdir('.trash');
				await adapter.rename(file.path, '.trash/small.md');
			},
		},
		workspace: { onLayoutReady: () => {} },
	};
}

function loadPlugin(app) {
	const originalRequire = Module.createRequire(path.join(root, 'package.json'));
	const code = readFileSync(bundlePath, 'utf8');
	const moduleObj = { exports: {} };
	const wrapper = new Function('module', 'exports', 'require', code);
	wrapper(moduleObj, moduleObj.exports, (id) =>
		id === 'obsidian' ? obsidianStub : originalRequire(id),
	);
	const PluginClass = moduleObj.exports.default ?? moduleObj.exports;
	return new PluginClass(app, {
		id: 'diff-sync-webdav',
		name: 'Diff Sync (WebDAV)',
		version: '0.1.0',
		minAppVersion: '1.7.2',
		description: 'e2e',
		author: 'e2e',
		dir: `${app.vault.configDir}/plugins/diff-sync-webdav`,
	});
}

// ------------------------------------------------------------------- scenario

async function main() {
	const work = await mkdtemp(path.join(tmpdir(), 'diff-sync-e2e-'));
	const server = new WebDavServer({ root: path.join(work, 'dav-root') });
	await server.start();

	try {
		const vaultA = path.join(work, 'vault-a');
		const vaultB = path.join(work, 'vault-b');
		await fs.mkdir(path.join(vaultA, 'notes'), { recursive: true });
		await fs.mkdir(path.join(vaultB, 'notes'), { recursive: true });

		// --- device A: write notes and sync via the real plugin entry point ---
		const bigNote = ('# Chapter\n\n' + 'Lorem ipsum dolor sit amet.\n'.repeat(6000)).repeat(2);
		await fs.writeFile(path.join(vaultA, 'notes', 'big.md'), bigNote);
		await fs.writeFile(path.join(vaultA, 'notes', 'small.md'), '# Small\n\nhello\n');

		const configDir = '.custom-config';
		await fs.mkdir(path.join(vaultA, configDir));
		await fs.writeFile(path.join(vaultA, configDir, 'settings.json'), '{}');
		const pluginA = loadPlugin(makeApp(vaultA, configDir));
		await pluginA.onload();
		Object.assign(pluginA.settings, {
			serverUrl: server.url,
			username: 'u',
			password: 'p',
			remoteDir: 'sync',
			autoSyncOnStart: false,
			autoSyncIntervalMinutes: 0,
			syncOnFileChange: false,
		});
		await pluginA.sync();

		const resultA = pluginA.lastSyncResult();
		assert.ok(resultA, 'device A produced a sync result');
		assert.equal(resultA.summary.errors.length, 0, `no errors: ${resultA.summary.errors}`);
		assert.equal(resultA.summary.uploadedFiles, 2, 'uploaded both notes');

		// --- device B: bootstrap from the same remote ---
		const pluginB = loadPlugin(makeApp(vaultB));
		await pluginB.onload();
		Object.assign(pluginB.settings, {
			serverUrl: server.url,
			username: 'u',
			password: 'p',
			remoteDir: 'sync',
			autoSyncOnStart: false,
			autoSyncIntervalMinutes: 0,
			syncOnFileChange: false,
		});
		await pluginB.sync();
		const resultB = pluginB.lastSyncResult();
		assert.equal(resultB.summary.errors.length, 0, `B errors: ${resultB.summary.errors}`);
		assert.equal(resultB.summary.downloadedFiles, 2, 'B downloaded both notes');
		assert.equal(
			await fs.readFile(path.join(vaultB, 'notes', 'big.md'), 'utf8'),
			bigNote,
			'big note content identical on B',
		);

		// --- edit one paragraph on A, verify B only pulls the diff ---
		const edited = bigNote.replace(
			'Lorem ipsum dolor sit amet.\n'.repeat(3),
			'REPLACED PARAGRAPH MARKER 42\n'.repeat(3),
		);
		assert.notEqual(edited, bigNote, 'edit applied');
		await fs.writeFile(path.join(vaultA, 'notes', 'big.md'), edited);

		server.resetStats();
		await pluginA.sync({ alwaysRehash: true });
		const upEdit = pluginA.lastSyncResult().summary;
		assert.equal(upEdit.errors.length, 0, `A edit errors: ${upEdit.errors}`);
		const uploadedBytes = upEdit.bytesUploaded;

		server.resetStats();
		await pluginB.sync();
		const downEdit = pluginB.lastSyncResult().summary;
		assert.equal(downEdit.errors.length, 0, `B edit errors: ${downEdit.errors}`);
		assert.equal(
			await fs.readFile(path.join(vaultB, 'notes', 'big.md'), 'utf8'),
			edited,
			'B received the edit',
		);

		// The whole point: a small edit must not move the whole file.
		const total = Buffer.byteLength(bigNote);
		assert.ok(
			uploadedBytes < total * 0.2,
			`differential upload moved ${uploadedBytes}B of ${total}B`,
		);
		assert.ok(
			downEdit.bytesDownloaded < total * 0.2,
			`differential download moved ${downEdit.bytesDownloaded}B of ${total}B`,
		);

		// --- no-op sync issues no writes ---
		server.resetStats();
		const puts = [];
		const originalHandle = server.handle.bind(server);
		server.handle = async (req, res) => {
			if (req.method === 'PUT') puts.push(req.url);
			return originalHandle(req, res);
		};
		await pluginB.sync();
		assert.equal(puts.length, 0, 'no-op sync performs no PUT');

		// --- state persisted per device ---
		const stateA = JSON.parse(
			await fs.readFile(
				path.join(vaultA, configDir, 'plugins', 'diff-sync-webdav', 'sync-state.json'),
				'utf8',
			),
		);
		assert.ok(Object.keys(stateA.files).length >= 2, 'A persisted merge base');

		// --- conflict handling end to end ---
		await fs.writeFile(path.join(vaultA, 'notes', 'small.md'), '# A edit\n');
		await fs.writeFile(path.join(vaultB, 'notes', 'small.md'), '# B edit\n');
		// Make B's write newer so it wins deterministically.
		const future = new Date(Date.now() + 60_000);
		await fs.utimes(path.join(vaultB, 'notes', 'small.md'), future, future);

		await pluginA.sync({ alwaysRehash: true });
		await pluginB.sync();
		const conflictSummary = pluginB.lastSyncResult().summary;
		assert.ok(conflictSummary.conflicts >= 1, 'conflict detected on B');

		const bFiles = await fs.readdir(path.join(vaultB, 'notes'));
		const copy = bFiles.find((f) => f.includes('.conflict-'));
		assert.ok(copy, `conflict copy created (files: ${bFiles.join(',')})`);
		assert.equal(
			await fs.readFile(path.join(vaultB, 'notes', 'small.md'), 'utf8'),
			'# B edit\n',
			'newer version wins',
		);
		assert.equal(
			await fs.readFile(path.join(vaultB, 'notes', copy), 'utf8'),
			'# A edit\n',
			'loser preserved verbatim',
		);

		// A converges and also has both versions.
		await pluginA.sync();
		const aFiles = await fs.readdir(path.join(vaultA, 'notes'));
		assert.ok(aFiles.some((f) => f.includes('.conflict-')), 'copy propagated to A');

		// --- delete propagation ---
		await fs.rm(path.join(vaultA, 'notes', 'small.md'));
		await pluginA.sync();
		await pluginB.sync();
		assert.equal(
			await fs
				.access(path.join(vaultB, 'notes', 'small.md'))
				.then(() => true)
				.catch(() => false),
			false,
			'deletion propagated to B',
		);
		assert.ok((await fs.stat(path.join(vaultB, '.trash', 'small.md'))).isFile());

		pluginA.onunload();
		pluginB.onunload();
		console.log('e2e plugin test passed');
	} finally {
		await server.stop();
		await rm(work, { recursive: true, force: true });
	}
}

await main();
process.exit(0);
