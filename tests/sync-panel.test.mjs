/**
 * Render the sidebar panel against a minimal DOM and assert the manual sync
 * button works: it must be present, enabled when configured, disabled while
 * syncing, and it must actually call into the plugin.
 */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bundlePath = path.join(root, 'main.js');
if (typeof window === 'undefined') globalThis.window = globalThis;

// ------------------------------------------------------------------ tiny DOM

class El {
	constructor(tag = 'div') {
		this.tagName = tag.toUpperCase();
		this.children = [];
		this.classes = new Set();
		this.style = {};
		this.textContent = '';
		this.title = '';
		this.attributes = {};
		this.listeners = {};
		this.disabled = false;
		this.parent = null;
	}
	get classList() {
		return {
			add: (...names) => names.forEach((n) => this.classes.add(n)),
			remove: (...names) => names.forEach((n) => this.classes.delete(n)),
			contains: (n) => this.classes.has(n),
		};
	}
	addClass(...names) {
		names.forEach((n) => this.classes.add(n));
	}
	removeClass(...names) {
		names.forEach((n) => this.classes.delete(n));
	}
	toggleClass(name, on) {
		if (on) this.classes.add(name);
		else this.classes.delete(name);
	}
	hasClass(name) {
		return this.classes.has(name);
	}
	setText(text) {
		this.textContent = String(text);
	}
	setAttr(name, value) {
		this.attributes[name] = value;
	}
	createEl(tag, opts = {}) {
		const child = new El(tag);
		if (opts.cls) child.addClass(...String(opts.cls).split(/\s+/).filter(Boolean));
		if (opts.text !== undefined) child.textContent = opts.text;
		child.parent = this;
		this.children.push(child);
		return child;
	}
	createDiv(opts = {}) {
		return this.createEl('div', opts);
	}
	createSpan(opts = {}) {
		return this.createEl('span', opts);
	}
	empty() {
		this.children = [];
		this.textContent = '';
	}
	appendChild(child) {
		child.parent = this;
		this.children.push(child);
		return child;
	}
	addEventListener(type, handler) {
		(this.listeners[type] ??= []).push(handler);
	}
	click() {
		if (this.disabled) return false;
		for (const handler of this.listeners.click ?? []) handler({ type: 'click' });
		return true;
	}
	/** Concatenated text of this node and all descendants. */
	get text() {
		let out = this.textContent;
		for (const child of this.children) out += child.text ?? '';
		return out;
	}

	/** Depth-first search for a node whose text contains `needle`. */
	find(needle) {
		if (this.textContent.includes(needle)) return this;
		for (const child of this.children) {
			const hit = child.find?.(needle);
			if (hit) return hit;
		}
		return null;
	}
	all(predicate, out = []) {
		if (predicate(this)) out.push(this);
		for (const child of this.children) child.all?.(predicate, out);
		return out;
	}
}

// ------------------------------------------------------------ obsidian stub

const registeredViews = [];

class StubPlugin {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest;
		this.data = {};
	}
	addCommand() {}
	addRibbonIcon() {
		return { remove() {} };
	}
	addStatusBarItem() {
		const el = new El('div');
		// Obsidian's status bar items are HTMLElements; alias the DOM spelling.
		el.setAttribute = (name, value) => el.setAttr(name, value);
		el.remove = () => {
			if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
		};
		return el;
	}
	addSettingTab() {}
	registerView(type, creator) {
		registeredViews.push({ type, creator });
	}
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
		this.contentEl = new El('div');
	}
	addAction() {}
}

const obsidianStub = {
	ItemView: StubItemView,
	View: StubItemView,
	Plugin: StubPlugin,
	setIcon: () => {},
	Notice: class {
		constructor(message) {
			this.message = message;
		}
	},
	Modal: class {
		constructor() {
			this.contentEl = new El();
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
	PluginSettingTab: class {
		constructor() {
			this.containerEl = new El();
		}
	},
	TFile: class {},
	TAbstractFile: class {},
	Platform: { isWin: process.platform === 'win32', isMacOS: process.platform === 'darwin', isLinux: process.platform === 'linux' },
	normalizePath: (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, ''),
	requestUrl: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) }),
	debounce: (fn) => fn,
};

// -------------------------------------------------------------- load bundle

const originalRequire = Module.createRequire(path.join(root, 'package.json'));
const code = readFileSync(bundlePath, 'utf8');
const moduleObj = { exports: {} };
new Function('module', 'exports', 'require', code)(moduleObj, moduleObj.exports, (id) =>
	id === 'obsidian' ? obsidianStub : originalRequire(id),
);
const PluginClass = moduleObj.exports.default ?? moduleObj.exports;

const app = {
	vault: {
		adapter: {
			exists: async () => false,
			read: async () => '',
			write: async () => {},
			readBinary: async () => new ArrayBuffer(0),
			writeBinary: async () => {},
			mkdir: async () => {},
			rmdir: async () => {},
			remove: async () => {},
			rename: async () => {},
			list: async () => ({ files: [], folders: [] }),
			stat: async () => null,
		},
		configDir: '.obsidian',
		getAbstractFileByPath: () => null,
		on: () => ({ unref() {} }),
		delete: async () => {},
	},
	workspace: {
		onLayoutReady: () => {},
		getLeavesOfType: () => [],
		getRightLeaf: () => null,
		revealLeaf: async () => {},
	},
};

const plugin = new PluginClass(app, {
	id: 'diff-sync-webdav',
	name: 'Diff Sync (WebDAV)',
	version: '0.1.0',
	minAppVersion: '1.4.0',
	description: 'panel test',
	author: 'test',
	dir: '.obsidian/plugins/diff-sync-webdav',
});
await plugin.onload();

// --------------------------------------------------------- drive the panel

const registration = registeredViews.find((v) => v.type === 'diff-sync-panel');
assert.ok(registration, 'plugin registered the sync panel view');
assert.equal(typeof registration.creator, 'function', 'view creator is a factory');

const leaf = { view: null };
const view = registration.creator(leaf);
assert.ok(view, 'factory returns a view instance');
assert.equal(view.getViewType(), 'diff-sync-panel', 'view type matches');
assert.equal(view.getDisplayText(), 'Diff Sync', 'view title');

// Render it — this exercises every createEl/setIcon/classList call.
await view.onOpen();
const dom = view.contentEl;

// --- the main button exists and is labelled in Chinese
const button = dom.all((n) => n.tagName === 'BUTTON' && n.classes.has('diff-sync-panel__sync'))[0];
assert.ok(button, 'sync button rendered');
assert.ok(button.text.includes('立即同步'), `button label: ${JSON.stringify(button.text)}`);

// --- unconfigured: button disabled + hint shown
assert.equal(plugin.isConfigured(), false, 'starts unconfigured');
view.refresh();
assert.equal(button.disabled, true, 'button disabled when unconfigured');
const hint = dom.all((n) => n.classes.has('diff-sync-panel__hint'))[0];
assert.ok(hint && !hint.classes.has('is-hidden'), 'setup hint visible when unconfigured');

// --- configured: button enabled, clicking triggers a sync attempt
plugin.settings.serverUrl = 'https://example.invalid/dav/notes';
assert.equal(plugin.isConfigured(), true, 'configured after setting serverUrl');
view.refresh();
assert.equal(button.disabled, false, 'button enabled when configured');

let syncTriggered = false;
const realSync = plugin.sync.bind(plugin);
plugin.sync = async (...args) => {
	syncTriggered = true;
	return realSync(...args);
};
button.click();
await new Promise((r) => setTimeout(r, 10));
assert.equal(syncTriggered, true, 'clicking the button starts a sync');
plugin.sync = realSync;

// --- syncing state: button disabled, cancel button revealed
view.setSyncing(true);
assert.equal(button.disabled, true, 'button disabled while syncing');
const cancel = dom.all((n) => n.tagName === 'BUTTON' && n.classes.has('diff-sync-panel__cancel'))[0];
assert.ok(cancel, 'cancel button rendered');
assert.equal(cancel.classes.has('is-hidden'), false, 'cancel visible while syncing');

view.setSyncing(false);
assert.equal(cancel.classes.has('is-hidden'), true, 'cancel hidden when idle');

// --- progress plumbing
view.updateFromProgress({ phase: 'upload', current: 3, total: 10, detail: 'notes/a.md' });
const status = dom.all((n) => n.classes.has('diff-sync-panel__status'))[0];
assert.ok(status.text.includes('上传'), `status text: ${status.text}`);
const fill = dom.all((n) => n.classes.has('diff-sync-panel__progress-fill'))[0];
assert.equal(fill.style.width, '30%', 'progress bar reflects 3/10');

// --- stats rendering with a real-shaped summary
view.renderStatsForTest?.(null);
const muted = dom.all((n) => n.classes.has('diff-sync-panel__muted'));
assert.ok(muted.length > 0, 'empty state shown when there is no result');

// --- settings/log buttons exist
const links = dom.all((n) => n.classes.has('diff-sync-panel__link'));
assert.equal(links.length, 2, `footer has settings + log buttons, got ${links.length}`);

await view.onClose();
plugin.onunload();
console.log('sync panel test passed');
process.exit(0);
