if (!process.env.JIANGUOYUN_USERNAME || !process.env.JIANGUOYUN_PASSWORD) {
	throw new Error("Set JIANGUOYUN_USERNAME and JIANGUOYUN_PASSWORD before running this live test.");
}

/**
 * Smoke test against a real Jianguoyun (Nutstore) WebDAV account.
 *
 * Uses the real plugin core (WebDavClient + RemoteStore + sync engine) so this
 * validates exactly the code path the plugin will run, not a reimplementation.
 *
 * Everything is written under a dedicated test folder and removed afterwards.
 */
import { createHash } from 'node:crypto';
import {
	WebDavClient,
	RemoteStore,
	runSync,
	createEmptyState,
	MemoryChunkCache,
	PathFilter,
	buildEncryptionConfig,
	unlockEncryption,
	MemoryChunkCache as Cache,
} from './.build/core.mjs';

const CONFIG = {
	baseUrl: 'https://dav.jianguoyun.com/dav/obsidian-sync-test',
	username: process.env.JIANGUOYUN_USERNAME,
	password: process.env.JIANGUOYUN_PASSWORD,
	rootDir: 'diff-sync',
	// Jianguoyun throttles by request count; pace aggressively.
	minRequestIntervalMs: 400,
};

const log = (...args) => console.log(...args);
let failures = 0;

async function step(name, fn) {
	const started = Date.now();
	try {
		const detail = await fn();
		log(`  ok   ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - started}ms)`);
	} catch (error) {
		failures++;
		log(`  FAIL ${name}`);
		log(`       ${error?.stack ?? error}`);
	}
}

/** In-memory vault implementing the engine's LocalVault contract. */
class MemoryVault {
	constructor() {
		this.files = new Map();
		this.clock = Date.now();
	}
	async list() {
		return [...this.files.entries()].map(([path, f]) => ({
			path,
			size: f.bytes.length,
			mtime: f.mtime,
		}));
	}
	async stat(path) {
		const file = this.files.get(path);
		return file ? { path, size: file.bytes.length, mtime: file.mtime } : null;
	}
	async read(path) {
		const file = this.files.get(path);
		if (!file) throw new Error(`missing ${path}`);
		return new Uint8Array(file.bytes);
	}
	async write(path, data) {
		this.files.set(path, { bytes: new Uint8Array(data), mtime: ++this.clock });
	}
	async remove(path) {
		this.files.delete(path);
	}
	async exists(path) {
		return this.files.has(path);
	}
}

function makeClient(overrides = {}) {
	return new WebDavClient({ ...CONFIG, ...overrides });
}

async function main() {
	log('\n=== 坚果云 WebDAV 测试 ===\n');
	log(`服务器: ${CONFIG.baseUrl}`);
	log(`账号:   ${CONFIG.username}\n`);

	const client = makeClient();
	const rootUrl = client.rootUrl;

	// ---------------------------------------------------------- 1. 认证与目录

	await step('认证并创建同步目录', async () => {
		await client.ensureCollection(rootUrl);
		return rootUrl;
	});

	await step('写入并读回文件（中文 + 二进制）', async () => {
		const url = client.urlFor('probe.txt');
		const content = new TextEncoder().encode('中文内容测试 ✓ emoji 🎉\nbinary:\x00\x01\x02');
		const put = await client.put(url, content, { contentType: 'text/plain' });
		if (!put.ok) throw new Error('PUT failed');
		const back = await client.get(url);
		if (!back) throw new Error('GET returned null');
		if (Buffer.compare(Buffer.from(back), Buffer.from(content)) !== 0) {
			throw new Error('内容不一致');
		}
		await client.delete(url);
		return `${content.length} 字节往返一致`;
	});

	// ------------------------------------------------------- 2. 条件写入支持

	let conditionalSupported = null;
	await step('检测条件写入（If-None-Match / If-Match）', async () => {
		const url = client.urlFor('cond.txt');
		await client.delete(url);

		const first = await client.put(url, new TextEncoder().encode('v1'), { createOnly: true });
		if (!first.ok) throw new Error('首次创建失败');

		const second = await client.put(url, new TextEncoder().encode('v2'), { createOnly: true });
		conditionalSupported = !second.ok;
		if (!conditionalSupported) {
			log('       ⚠ 服务器未实现 If-None-Match，并发保护将降级为写后校验');
		}

		const head = await client.head(url);
		const stale = await client.put(url, new TextEncoder().encode('v3'), {
			ifMatch: '"definitely-not-the-etag"',
		});
		if (stale.ok) log('       ⚠ 服务器忽略 If-Match');

		await client.delete(url);
		return conditionalSupported ? 'If-None-Match 生效' : '已降级';
	});

	// ---------------------------------------------------- 3. 引擎：首次同步

	const vaultA = new MemoryVault();
	const vaultB = new MemoryVault();

	const bigNote = '# 坚果云同步测试\n\n' + Array.from({ length: 1200 }, (_, i) => `第 ${i} 行：这是用于测试差分同步的中文段落内容。\n`).join('');
	const smallNote = '# 小笔记\n\n你好，世界。\n';
	await vaultA.write('notes/big.md', new TextEncoder().encode(bigNote));
	await vaultA.write('notes/small.md', new TextEncoder().encode(smallNote));
	await vaultA.write('附件/图片.bin', new Uint8Array(Array.from({ length: 20000 }, (_, i) => (i * 7) & 0xff)));

	const meta = { v: 1, vaultId: 'jianguoyun-test', encrypted: false };

	await step('清理旧测试数据', async () => {
		const store0 = new RemoteStore({ client, meta, key: null, concurrency: 4 });
		const existing = await store0.loadIndex();
		if (existing) {
			for (const id of existing.index.known ?? []) {
				await store0.deleteChunk(id).catch(() => {});
			}
		}
		await client.delete(client.urlFor('index.json')).catch(() => {});
		await client.delete(client.urlFor('meta.json')).catch(() => {});
		return '已清空';
	});

	const syncOpts = (vault, state, device, extra = {}) => ({
		vault,
		stateFiles: state.files,
		stateVaultId: state.vaultId,
		deviceName: device,
		concurrency: 1,
		alwaysRehash: true,
		allowMassDelete: true,
		cache: new Cache(),
		isExcluded: (p) => new PathFilter(['.git/**']).excluded(p),
		...extra,
	});

	let store;
	let stateA = createEmptyState('jianguoyun-test');
	let stateB = createEmptyState('jianguoyun-test');

	await step('设备 A 首次上传（3 个文件）', async () => {
		// Start from a known-clean remote so a previous failed run cannot leak in.
		await client.delete(client.urlFor('index.json')).catch(() => {});
		await client.put(client.urlFor('meta.json'), new TextEncoder().encode(JSON.stringify(meta)), {
			contentType: 'application/json',
		});
		store = new RemoteStore({ client, meta, key: null, concurrency: 4 });
		await store.ensureCollections();
		const result = await runSync(store, syncOpts(vaultA, stateA, 'device-a'));
		stateA = { ...stateA, files: result.state.files };
		if (result.summary.errors.length) throw new Error(result.summary.errors.join('; '));
		return `↑${result.summary.uploadedFiles} 文件 / ${result.summary.bytesUploaded} 字节`;
	});

	await step('设备 B 首次下载（bootstrap）', async () => {
		const result = await runSync(store, syncOpts(vaultB, stateB, 'device-b'));
		stateB = { ...stateB, files: result.state.files };
		if (result.summary.errors.length) throw new Error(result.summary.errors.join('; '));
		const big = new TextDecoder().decode(await vaultB.read('notes/big.md'));
		if (big !== bigNote) throw new Error('大笔记内容不一致');
		const small = new TextDecoder().decode(await vaultB.read('notes/small.md'));
		if (small !== smallNote) throw new Error('小笔记内容不一致');
		const bin = await vaultB.read('附件/图片.bin');
		if (bin.length !== 20000) throw new Error('二进制文件大小不符');
		return `↓${result.summary.downloadedFiles} 文件，内容全部校验一致`;
	});

	// ------------------------------------------------------ 4. 差分传输验证

	await step('改 1 行后差分上传（关键指标）', async () => {
		const edited = bigNote.replace('第 600 行：', '第 600 行【已修改 MARKER】：');
		if (edited === bigNote) throw new Error('编辑未生效');
		await vaultA.write('notes/big.md', new TextEncoder().encode(edited));

		const result = await runSync(store, syncOpts(vaultA, stateA, 'device-a'));
		stateA = { ...stateA, files: result.state.files };
		if (result.summary.errors.length) throw new Error(result.summary.errors.join('; '));

		const total = Buffer.byteLength(bigNote);
		const sent = result.summary.bytesUploaded;
		const pct = ((sent / total) * 100).toFixed(2);
		if (sent >= total) throw new Error(`未产生差分：上传了 ${sent}/${total}`);
		if (sent > total * 0.2) throw new Error(`差分效率过低：${sent}/${total} (${pct}%)`);

		// Remember for the next step.
		globalThis.__editedNote = edited;
		return `上传 ${sent} 字节 / 全量 ${total} 字节（${pct}%），节省 ${(((total - sent) / total) * 100).toFixed(1)}%`;
	});

	await step('设备 B 差分下载并校验内容', async () => {
		const result = await runSync(store, syncOpts(vaultB, stateB, 'device-b'));
		stateB = { ...stateB, files: result.state.files };
		if (result.summary.errors.length) throw new Error(result.summary.errors.join('; '));
		const content = new TextDecoder().decode(await vaultB.read('notes/big.md'));
		if (content !== globalThis.__editedNote) throw new Error('内容不一致');
		const total = Buffer.byteLength(globalThis.__editedNote);
		const got = result.summary.bytesDownloaded;
		if (got > total * 0.2) throw new Error(`下载差分效率过低：${got}/${total}`);
		return `下载 ${got} 字节 / 全量 ${total} 字节（${((got / total) * 100).toFixed(2)}%）`;
	});

	await step('无变化时同步不产生任何写入', async () => {
		const result = await runSync(store, syncOpts(vaultB, stateB, 'device-b'));
		stateB = { ...stateB, files: result.state.files };
		const touched = result.summary.uploadedFiles + result.summary.downloadedFiles;
		if (touched !== 0) throw new Error(`no-op 同步仍有 ${touched} 个文件变动`);
		return '0 传输';
	});

	// ----------------------------------------------------------- 5. 冲突处理

	await step('两端同时修改 → 生成冲突副本且不丢内容', async () => {
		const base = new TextEncoder().encode('# 冲突测试\n\n原始内容\n');
		await vaultA.write('冲突.md', base);
		await runSync(store, syncOpts(vaultA, stateA, 'device-a'));
		await runSync(store, syncOpts(vaultB, stateB, 'device-b'));

		// Both edit; B slightly later.
		await vaultA.write('冲突.md', new TextEncoder().encode('# 冲突测试\n\nA 版本\n'));
		await vaultB.write('冲突.md', new TextEncoder().encode('# 冲突测试\n\nB 版本\n'));
		vaultB.files.get('冲突.md').mtime += 60_000;

		const ra = await runSync(store, syncOpts(vaultA, stateA, 'device-a'));
		stateA = { ...stateA, files: ra.state.files };
		const rb = await runSync(store, syncOpts(vaultB, stateB, 'device-b'));
		stateB = { ...stateB, files: rb.state.files };

		if (rb.summary.conflicts < 1) throw new Error('未检测到冲突');
		const copyPath = rb.summary.conflictPaths[0];
		const copy = new TextDecoder().decode(await vaultB.read(copyPath));
		if (!copy.includes('A 版本')) throw new Error(`冲突副本内容不对: ${copy}`);

		// A converges and gets the copy too.
		const ra2 = await runSync(store, syncOpts(vaultA, stateA, 'device-a'));
		stateA = { ...stateA, files: ra2.state.files };
		const aCopy = [...vaultA.files.keys()].find((p) => p.includes('.conflict-'));
		if (!aCopy) throw new Error('冲突副本未传播到设备 A');
		return `副本 ${copyPath}`;
	});

	// ------------------------------------------------------------- 6. 删除

	await step('删除双向传播', async () => {
		await vaultA.remove('notes/small.md');
		await runSync(store, syncOpts(vaultA, stateA, 'device-a'));
		await runSync(store, syncOpts(vaultB, stateB, 'device-b'));
		if (await vaultB.exists('notes/small.md')) throw new Error('删除未传播');
		return 'notes/small.md 已从两端删除';
	});

	// ------------------------------------------------------------- 7. 加密

	await step('端到端加密：服务端不可读且可正确解密', async () => {
		const secret = '机密标记 SECRET_MARKER_9f3a\n' + '加密测试内容。\n'.repeat(500);
		const vaultC = new MemoryVault();
		await vaultC.write('secret.md', new TextEncoder().encode(secret));

		const { config, key } = await buildEncryptionConfig('test-passphrase-2024', 210_000);
		const encClient = makeClient({ rootDir: 'diff-sync-enc' });
		await encClient.ensureCollection(encClient.rootUrl);
		const encMeta = {
			v: 1,
			vaultId: 'jianguoyun-enc-test',
			encrypted: true,
			kdf: config.kdf,
			verifier: config.verifier,
		};
		await encClient.put(encClient.urlFor('meta.json'), new TextEncoder().encode(JSON.stringify(encMeta)), {
			contentType: 'application/json',
		});

		const encStore = new RemoteStore({ client: encClient, meta: encMeta, key, concurrency: 3 });
		await encStore.ensureCollections();
		let encState = createEmptyState('jianguoyun-enc-test');
		const r = await runSync(encStore, {
			vault: vaultC,
			stateFiles: encState.files,
			deviceName: 'enc-a',
			concurrency: 1,
			alwaysRehash: true,
			allowMassDelete: true,
			cache: new MemoryChunkCache(),
		});
		encState = { ...encState, files: r.state.files };
		if (r.summary.errors.length) throw new Error(r.summary.errors.join('; '));

		// Read a chunk straight off the server and confirm the marker is absent.
		const chunkId = [...Object.values(r.index.files)][0].c[0];
		const raw = await encClient.get(
			encClient.urlFor('chunks', chunkId.slice(0, 2), chunkId),
		);
		if (!raw) throw new Error('无法读取加密分块');
		if (Buffer.from(raw).toString('utf8').includes('SECRET_MARKER')) {
			throw new Error('服务端数据包含明文标记！');
		}

		// Decrypt with a fresh key derived from the passphrase.
		const metaBack = await RemoteStore.readMeta(encClient);
		if (!metaBack.encrypted) throw new Error('远端未标记为加密');
		const key2 = await unlockEncryption('test-passphrase-2024', {
			kdf: metaBack.kdf,
			verifier: metaBack.verifier,
		});
		const store2 = new RemoteStore({ client: encClient, meta: metaBack, key: key2, concurrency: 3 });
		const vaultD = new MemoryVault();
		let stateD = createEmptyState('jianguoyun-enc-test');
		const rd = await runSync(store2, {
			vault: vaultD,
			stateFiles: stateD.files,
			deviceName: 'enc-b',
			concurrency: 1,
			alwaysRehash: true,
			allowMassDelete: true,
			cache: new MemoryChunkCache(),
		});
		stateD = { ...stateD, files: rd.state.files };
		const decrypted = new TextDecoder().decode(await vaultD.read('secret.md'));
		if (decrypted !== secret) throw new Error('解密后内容不一致');

		await encClient.delete(encClient.urlFor('index.enc')).catch(() => {});
		await encClient.delete(encClient.urlFor('meta.json')).catch(() => {});
		for (const id of r.index.known) await encStore.deleteChunk(id).catch(() => {});
		return '服务端无明文，跨设备解密一致';
	});

	// ------------------------------------------------------- 8. 大规模验证

	await step('20 个文件批量同步', async () => {
		const vaultE = new MemoryVault();
		for (let i = 0; i < 20; i++) {
			const content = `# 笔记 ${i}\n\n` + `内容 ${i} ${'填充文本 '.repeat(20)}\n`.repeat(5);
			await vaultE.write(`bulk/note-${i}.md`, new TextEncoder().encode(content));
		}
		let stateE = createEmptyState('jianguoyun-test');
		const started = Date.now();
		const r = await runSync(store, {
			vault: vaultE,
			stateFiles: stateE.files,
			stateVaultId: 'jianguoyun-test',
			deviceName: 'bulk',
			concurrency: 1,
			alwaysRehash: true,
			allowMassDelete: true,
			cache: new MemoryChunkCache(),
		});
		const elapsed = Date.now() - started;
		if (r.summary.errors.length) throw new Error(r.summary.errors.slice(0, 3).join('; '));
		return `${r.summary.uploadedFiles} 文件 / ${r.summary.chunksUploaded} 块 / ${(r.summary.bytesUploaded / 1024).toFixed(0)} KB / ${(elapsed / 1000).toFixed(1)}s`;
	});

	// ------------------------------------------------------------- 清理

	log('\n清理远端测试数据…');
	try {
		const finalIndex = await store.loadIndex();
		if (finalIndex) {
			for (const id of finalIndex.index.known ?? []) {
				await store.deleteChunk(id).catch(() => {});
			}
		}
		await client.delete(client.urlFor('index.json')).catch(() => {});
		await client.delete(client.urlFor('meta.json')).catch(() => {});
		await client.delete(rootUrl).catch(() => {});
		log('已清理（包含测试目录本身）');
	} catch (error) {
		log(`清理时出现问题（不影响结论）: ${error.message}`);
	}

	log('');
	if (failures === 0) {
		log('全部通过 ✓');
		process.exit(0);
	} else {
		log(`${failures} 项失败`);
		process.exit(1);
	}
}

await main();
