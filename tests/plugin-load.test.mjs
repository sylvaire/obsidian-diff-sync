/**
 * Load the built plugin bundle under a stubbed `obsidian` module to verify it
 * initialises and registers its commands/settings without throwing.
 *
 * This catches the class of bugs that only appear after bundling: bad default
 * export shape, top-level await, missing Obsidian API at load time.
 */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const bundlePath = path.join(root, 'main.js');

// --- stub the `obsidian` module -------------------------------------------

const registered = { commands: [], ribbonIcons: [], settingTabs: [], statusBar: 0, views: [] };

class StubPlugin {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest;
		this.data = {};
		this.intervals = [];
	}
	addCommand(command) {
		registered.commands.push(command);
		return command;
	}
	addRibbonIcon(icon, title, callback) {
		registered.ribbonIcons.push({ icon, title, callback });
		return { remove() {} };
	}
	addStatusBarItem() {
		registered.statusBar++;
		const el = {
			textContent: '',
			title: '',
			classes: [],
			setText(t) {
				this.textContent = t;
			},
			setAttribute() {},
			addClass(c) {
				this.classes.push(c);
			},
			addEventListener() {},
			remove() {},
		};
		return el;
	}
	addSettingTab(tab) {
		registered.settingTabs.push(tab);
	}
	registerView(type, creator) {
		registered.views = registered.views ?? [];
		registered.views.push({ type, creator });
	}
	async activatePanel() {}
	registerEvent() {}
	registerInterval(id) {
		this.intervals.push(id);
		return id;
	}
	async loadData() {
		return this.data;
	}
	async saveData(data) {
		this.data = data;
	}
}

class StubModal {
	constructor(app) {
		this.app = app;
		this.contentEl = makeEl();
	}
	open() {}
	close() {}
}

class StubSetting {
	constructor(containerEl) {
		this.containerEl = containerEl;
	}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	setHeading() {
		return this;
	}
	addText(cb) {
		cb({
			inputEl: makeEl(),
			setPlaceholder() {
				return this;
			},
			setValue() {
				return this;
			},
			onChange() {
				return this;
			},
		});
		return this;
	}
	addTextArea(cb) {
		cb({
			inputEl: makeEl(),
			setValue() {
				return this;
			},
			onChange() {
				return this;
			},
		});
		return this;
	}
	addToggle(cb) {
		cb({
			setValue() {
				return this;
			},
			onChange() {
				return this;
			},
		});
		return this;
	}
	addSlider(cb) {
		cb({
			setLimits() {
				return this;
			},
			setValue() {
				return this;
			},
			setDynamicTooltip() {
				return this;
			},
			onChange() {
				return this;
			},
		});
		return this;
	}
	addButton(cb) {
		cb({
			setButtonText() {
				return this;
			},
			setCta() {
				return this;
			},
			setDestructive() {
				return this;
			},
			setDisabled() {
				return this;
			},
			onClick() {
				return this;
			},
		});
		return this;
	}
}

function makeEl() {
	const el = {
		style: {},
		children: [],
		textContent: '',
		classList: { add() {}, remove() {} },
		empty() {
			this.children = [];
		},
		createEl(tag, opts = {}) {
			const child = makeEl();
			child.tagName = tag;
			child.textContent = opts.text ?? '';
			this.children.push(child);
			return child;
		},
		createDiv(opts = {}) {
			return this.createEl('div', opts);
		},
		setText(t) {
			this.textContent = t;
		},
		appendChild(child) {
			this.children.push(child);
			return child;
		},
		addEventListener() {},
		setAttribute() {},
	};
	return el;
}

class StubItemView {
	constructor(leaf) {
		this.leaf = leaf;
		this.app = { setting: { open() {}, openTabById() {} } };
		this.contentEl = makeEl();
	}
	addAction() {}
}

const obsidianStub = {
	ItemView: StubItemView,
	View: StubItemView,
	Plugin: StubPlugin,
	setIcon: () => {},
	Menu: class {
		addItem() {
			return this;
		}
		showAtMouseEvent() {}
	},
	Modal: StubModal,
	Setting: StubSetting,
	Notice: class {
		constructor(message) {
			this.message = message;
		}
	},
	TFile: class {},
	TAbstractFile: class {},
	PluginSettingTab: class {
		constructor(app, plugin) {
			this.app = app;
			this.plugin = plugin;
			this.containerEl = makeEl();
		}
	},
	Platform: { isWin: process.platform === 'win32', isMacOS: process.platform === 'darwin', isLinux: process.platform === 'linux' },
	normalizePath: (p) => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
	requestUrl: async () => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) }),
	debounce: (fn) => fn,
};

// Obsidian runs in an Electron renderer; provide the browser globals the
// plugin legitimately uses.
if (typeof window === 'undefined') {
	globalThis.window = globalThis;
}

const originalRequire = Module.createRequire(path.join(root, 'package.json'));
const stubRequire = (id) => {
	if (id === 'obsidian') return obsidianStub;
	return originalRequire(id);
};

// Load as CJS with a patched `require` for the bundle's `obsidian` dependency.
const code = readFileSync(bundlePath, 'utf8');
const moduleObj = { exports: {} };
const wrapper = new Function('module', 'exports', 'require', code);
wrapper(moduleObj, moduleObj.exports, stubRequire);

const pluginExport = moduleObj.exports.default ?? moduleObj.exports;
assert.equal(typeof pluginExport, 'function', 'bundle must default-export a plugin class');

// --- instantiate it -------------------------------------------------------

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
		onLayoutReady: (cb) => {
			// Do not auto-run a network sync during the load test.
			void cb;
		},
	},
};

const plugin = new pluginExport(app, {
	id: 'diff-sync-webdav',
	name: 'Diff Sync (WebDAV)',
	version: '0.1.0',
	minAppVersion: '1.4.0',
	description: 'test',
	author: 'test',
	dir: '.obsidian/plugins/diff-sync-webdav',
});

await plugin.onload();

assert.ok(registered.commands.length >= 4, `expected several commands, got ${registered.commands.length}`);
const ids = registered.commands.map((c) => c.id);
for (const expected of ['sync-now', 'sync-full-rescan', 'cancel-sync', 'show-sync-log']) {
	assert.ok(ids.includes(expected), `missing command ${expected} (have ${ids.join(',')})`);
}
assert.ok(registered.settingTabs.length === 1, 'one settings tab registered');
assert.ok(registered.ribbonIcons.length === 1, 'one ribbon icon registered');
assert.equal(plugin.settings.remoteDir, 'diff-sync', 'defaults applied');
assert.ok(plugin.settings.deviceName.length > 0, 'device name defaulted');

// Exercise the declarative settings definitions and their custom rows.
const tab = registered.settingTabs[0];
tab.refreshDomState = () => {};
const groups = tab.getSettingDefinitions();
assert.equal(groups.length, 6);
const rows = groups.flatMap((group) => group.items);
const conflictRow = rows.find((row) => row.control?.key === 'conflictStrategy');
assert.deepEqual(Object.keys(conflictRow.control.options), ['time', 'size']);
assert.equal(plugin.settings.conflictStrategy, 'time');
await tab.setControlValue('conflictStrategy', 'size');
assert.equal(plugin.data.conflictStrategy, 'size');
await tab.setControlValue('conflictStrategy', 'invalid');
assert.equal(plugin.settings.conflictStrategy, 'size');
const cache = plugin.getCache();
const originalSize = cache.size;
let cacheScans = 0;
cache.size = async () => {
	cacheScans++;
	return { count: 0, bytes: 0 };
};
for (const definition of rows) {
	assert.ok(definition.name, 'each setting has a search label');
	if (definition.visible && !definition.visible()) continue;
	const row = new StubSetting(tab.containerEl);
	row.descEl = makeEl();
	definition.render?.(row);
}
assert.equal(cacheScans, 0, 'opening settings does not scan the chunk cache');
cache.size = originalSize;

const delayRow = rows.find((row) => row.name === '变更合并延迟（秒）');
assert.equal(delayRow.visible(), false);
await tab.setControlValue('syncOnFileChange', true);
assert.equal(delayRow.visible(), true);
assert.equal(plugin.data.syncOnFileChange, true);
await tab.setControlValue('syncOnFileChange', false);

plugin.log('normal sync event');
plugin.log('sync warning', 'warn');
assert.deepEqual(plugin.getLog().map(({ level }) => level), ['warn']);
await tab.setControlValue('verboseLogging', true);
assert.deepEqual(plugin.getLog().map(({ level }) => level), ['info', 'warn']);
await plugin.loadSettings();
assert.equal(plugin.settings.conflictStrategy, 'size');

// Commands must be callable without crashing on an unconfigured plugin
// (they should show a Notice rather than throw).
await plugin.sync();

plugin.onunload();
console.log(`plugin load test passed (${registered.commands.length} commands, ${registered.settingTabs.length} settings tab)`);
process.exit(0);
