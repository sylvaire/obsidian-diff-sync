if (!process.env.JIANGUOYUN_USERNAME || !process.env.JIANGUOYUN_PASSWORD) {
	throw new Error("Set JIANGUOYUN_USERNAME and JIANGUOYUN_PASSWORD before running this live test.");
}

/**
 * Focused Jianguoyun test: encryption + batch upload.
 *
 * Split out from jianguoyun-live.mjs because the provider rate-limits a long
 * session, and a fresh run against a cleared limit isolates these two checks.
 */
import {
	WebDavClient,
	RemoteStore,
	runSync,
	createEmptyState,
	MemoryChunkCache,
	buildEncryptionConfig,
	unlockEncryption,
} from './.build/core.mjs';

const CONFIG = {
	baseUrl: 'https://dav.jianguoyun.com/dav/obsidian-sync-test-2',
	username: process.env.JIANGUOYUN_USERNAME,
	password: process.env.JIANGUOYUN_PASSWORD,
	rootDir: 'diff-sync',
	minRequestIntervalMs: 500,
};

class MemoryVault {
	constructor() {
		this.files = new Map();
		this.clock = Date.now();
	}
	async list() {
		return [...this.files].map(([path, f]) => ({ path, size: f.length, mtime: ++this.clock }));
	}
	async stat(path) {
		const f = this.files.get(path);
		return f ? { path, size: f.length, mtime: this.clock } : null;
	}
	async read(path) {
		const f = this.files.get(path);
		if (!f) throw new Error(`missing ${path}`);
		return new Uint8Array(f);
	}
	async write(path, data) {
		this.files.set(path, new Uint8Array(data));
		this.clock++;
	}
	async remove(path) {
		this.files.delete(path);
	}
	async exists(path) {
		return this.files.has(path);
	}
}

const client = new WebDavClient(CONFIG, fetchTransport);
let failures = 0;
async function step(name, fn) {
	const t = Date.now();
	try {
		const detail = await fn();
		console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - t}ms)`);
	} catch (e) {
		failures++;
		console.log(`  FAIL ${name}`);
		console.log(`       ${e?.stack ?? e}`);
	}
}

console.log('\n=== 坚果云专项测试 ===\n');
await step('创建测试目录', async () => {
	await client.ensureCollection(client.rootUrl);
	return client.rootUrl;
});

// ---------------------------------------------------------------- encryption
await step('端到端加密：服务端不可读 + 跨设备解密', async () => {
	const secret = '机密标记 SECRET_MARKER_9f3a\n' + '加密测试内容。\n'.repeat(400);
	const vaultA = new MemoryVault();
	await vaultA.write('secret.md', new TextEncoder().encode(secret));

	const { config, key } = await buildEncryptionConfig('test-passphrase-2024', 210_000);
	const encMeta = {
		v: 1,
		vaultId: 'jianguoyun-enc',
		encrypted: true,
		kdf: config.kdf,
		verifier: config.verifier,
	};
	await client.put(client.urlFor('meta.json'), new TextEncoder().encode(JSON.stringify(encMeta)), {
		contentType: 'application/json',
	});

	const store = new RemoteStore({ client, meta: encMeta, key, concurrency: 1 });
	await store.ensureCollections();
	let state = createEmptyState('jianguoyun-enc');
	const r = await runSync(store, {
		vault: vaultA,
		stateFiles: state.files,
		deviceName: 'enc-a',
		concurrency: 1,
		alwaysRehash: true,
		allowMassDelete: true,
		cache: new MemoryChunkCache(),
	});
	state = { ...state, files: r.state.files };
	if (r.summary.errors.length) throw new Error(r.summary.errors.join('; '));

	// Confirm the server holds no plaintext.
	const entry = Object.values(r.index.files)[0];
	const raw = await client.get(client.urlFor('chunks', entry.c[0].slice(0, 2), entry.c[0]));
	if (!raw) throw new Error('无法读取分块');
	if (Buffer.from(raw).toString('utf8').includes('SECRET_MARKER')) {
		throw new Error('服务端数据包含明文！');
	}

	// A second device derives the key from the passphrase alone.
	const metaBack = await RemoteStore.readMeta(client);
	const key2 = await unlockEncryption('test-passphrase-2024', {
		kdf: metaBack.kdf,
		verifier: metaBack.verifier,
	});
	const store2 = new RemoteStore({ client, meta: metaBack, key: key2, concurrency: 1 });
	const vaultB = new MemoryVault();
	let stateB = createEmptyState('jianguoyun-enc');
	const rb = await runSync(store2, {
		vault: vaultB,
		stateFiles: stateB.files,
		deviceName: 'enc-b',
		concurrency: 1,
		alwaysRehash: true,
		allowMassDelete: true,
		cache: new MemoryChunkCache(),
	});
	stateB = { ...stateB, files: rb.state.files };
	const decrypted = new TextDecoder().decode(await vaultB.read('secret.md'));
	if (decrypted !== secret) throw new Error('解密内容不一致');

	// Wrong passphrase must be rejected.
	let rejected = false;
	try {
		await unlockEncryption('wrong-passphrase', {
			kdf: metaBack.kdf,
			verifier: metaBack.verifier,
		});
	} catch {
		rejected = true;
	}
	if (!rejected) throw new Error('错误口令未被拒绝');

	return `服务端无明文，解密一致，错误口令被拒（${(Buffer.byteLength(secret) / 1024).toFixed(0)}KB）`;
});

// --------------------------------------------------------------- batch upload
await step('批量上传 20 个文件并校验', async () => {
	const vault = new MemoryVault();
	for (let i = 0; i < 20; i++) {
		await vault.write(
			`bulk/note-${i}.md`,
			new TextEncoder().encode(`# 笔记 ${i}\n\n` + `内容 ${i} ${'填充文本 '.repeat(30)}\n`.repeat(4)),
		);
	}
	const meta = { v: 1, vaultId: 'jianguoyun-bulk', encrypted: false };
	await client.put(client.urlFor('meta.json'), new TextEncoder().encode(JSON.stringify(meta)), {
		contentType: 'application/json',
	});
	const store = new RemoteStore({ client, meta, key: null, concurrency: 1 });
	let state = createEmptyState('jianguoyun-bulk');
	const started = Date.now();
	const r = await runSync(store, {
		vault,
		stateFiles: state.files,
		deviceName: 'bulk',
		concurrency: 1,
		alwaysRehash: true,
		allowMassDelete: true,
		cache: new MemoryChunkCache(),
	});
	state = { ...state, files: r.state.files };
	if (r.summary.errors.length) throw new Error(r.summary.errors.slice(0, 2).join('; '));

	// Read everything back on a second device.
	const vault2 = new MemoryVault();
	let state2 = createEmptyState('jianguoyun-bulk');
	const r2 = await runSync(store, {
		vault: vault2,
		stateFiles: state2.files,
		deviceName: 'bulk-b',
		concurrency: 1,
		alwaysRehash: true,
		allowMassDelete: true,
		cache: new MemoryChunkCache(),
	});
	state2 = { ...state2, files: r2.state.files };
	if (r2.summary.downloadedFiles !== 20) throw new Error(`仅下载 ${r2.summary.downloadedFiles} 个文件`);

	return `↑${r.summary.uploadedFiles} ↓${r2.summary.downloadedFiles} 文件，` +
		`${r.summary.chunksUploaded} 块，${((Date.now() - started) / 1000).toFixed(0)}s`;
});

console.log('');
console.log(failures === 0 ? '全部通过 ✓' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
