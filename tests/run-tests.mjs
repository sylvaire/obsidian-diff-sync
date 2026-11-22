import { fetchTransport } from './fetch-transport.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { WebDavServer } from './dav-server.mjs';
import { DiskVault } from './disk-vault.mjs';
import {
	chunkBytes,
	chunkSpans,
	contentId,
	createEmptyState,
	globToRegExp,
	RemoteStore,
	runSync,
	WebDavClient,
	buildEncryptionConfig,
	unlockEncryption,
	conflictCopyPath,
	isLive,
	serializeIndex,
	parseIndex,
	MemoryChunkCache,
	EMPTY_CONTENT_HASH,
	hashOfChunkIds,
	utf8Decode,
	utf8Encode,
	sha256,
	base64Encode,
	base64Decode,
	createKdfParams,
	deriveKey,
	seal,
	open,
	normalizePath,
	dirname,
	basename,
	extensionOf,
	sanitizeSegment,
	PathFilter as PF,
} from './.build/core.mjs';

// ---------------------------------------------------------------- mini runner

const tests = [];
function test(name, fn) {
	tests.push({ name, fn });
}

let failures = 0;
let currentName = '';

async function main() {
	const only = process.argv[2];
	for (const t of tests) {
		if (only && !t.name.includes(only)) continue;
		currentName = t.name;
		const started = Date.now();
		try {
			await withTimeout(t.fn(), 60_000, t.name);
			console.log(`  ok   ${t.name} (${Date.now() - started}ms)`);
		} catch (error) {
			failures++;
			console.error(`  FAIL ${t.name}`);
			console.error(indent(error?.stack ?? String(error)));
		} finally {
			await closeServers();
		}
	}
	console.log('');
	if (failures > 0) {
		console.error(`${failures} test(s) failed`);
		process.exit(1);
	} else {
		console.log('all tests passed');
		process.exit(0);
	}
}

function indent(text) {
	return text
		.split('\n')
		.map((line) => `       ${line}`)
		.join('\n');
}

// ------------------------------------------------------------------ utilities

let tmpRoot;
async function makeTmp(name) {
	const dir = path.join(tmpRoot, name);
	await mkdir(dir, { recursive: true });
	return dir;
}

const openServers = [];
async function makeServer(options = {}) {
	const root = await mkdtemp(path.join(tmpRoot, 'srv-'));
	const server = new WebDavServer({ root, ...options });
	await server.start();
	openServers.push(server);
	return { server, root };
}

async function closeServers() {
	await Promise.all(openServers.splice(0).map((server) => server.stop().catch(() => {})));
}

function withTimeout(promise, ms, name) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`test timed out after ${ms}ms: ${name}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function randomText(size, seed = 1) {
	const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'obsidian', 'markdown', 'sync'];
	let x = seed;
	const out = [];
	let length = 0;
	while (length < size) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		const word = words[x % words.length];
		const line = `${word} ${x % 1000} ${'-'.repeat(x % 7)}\n`;
		out.push(line);
		length += line.length;
	}
	return out.join('').slice(0, size);
}

function makeStore(server, { vaultId = 'vault-test', encrypted = false } = {}) {
	return { vaultId, encrypted, server };
}

async function connect(server, { vaultId = 'vault-1', key = null, meta = null } = {}) {
	const client = new WebDavClient({
		baseUrl: server.url,
		username: 'u',
		password: 'p',
		rootDir: 'sync',
	}, fetchTransport);
	const existing = meta ?? (await RemoteStore.readMeta(client));
	const remoteMeta =
		existing ??
		({
			v: 1,
			vaultId,
			encrypted: key !== null,
			...(key ? {} : {}),
		});
	if (!existing) await RemoteStore.writeMeta(client, remoteMeta);
	const store = new RemoteStore({ client, meta: remoteMeta, key, concurrency: 3 });
	await store.ensureCollections();
	return { client, store, meta: remoteMeta };
}

async function sync(store, vault, state, overrides = {}) {
	return runSync(store, {
		vault,
		stateFiles: state.files,
		stateVaultId: state.vaultId,
		deviceName: overrides.deviceName ?? 'device-a',
		concurrency: 3,
		cache: overrides.cache ?? new MemoryChunkCache(),
		collectGarbage: overrides.collectGarbage ?? true,
		alwaysRehash: overrides.alwaysRehash ?? true,
		allowMassDelete: overrides.allowMassDelete ?? true,
		now: overrides.now,
		isExcluded: overrides.isExcluded,
	});
}

function newState(vaultId) {
	return createEmptyState(vaultId);
}

function withState(prev, result) {
	return { ...prev, files: result.state.files, lastSync: result.state.lastSync };
}

// --------------------------------------------------------------------- tests

test('bytes: base64 round-trips and matches Buffer', async () => {
	for (const size of [0, 1, 2, 3, 4, 5, 17, 255, 1000]) {
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = (i * 37 + size) & 0xff;
		const encoded = base64Encode(bytes);
		assert.equal(encoded, Buffer.from(bytes).toString('base64'), `encode size=${size}`);
		assert.deepEqual(base64Decode(encoded), bytes, `decode size=${size}`);
	}
});

test('hash: empty chunk list matches truncated sha256("")', async () => {
	const emptyDigest = Buffer.from(await sha256(new Uint8Array(0))).subarray(0, 16).toString('hex');
	assert.equal(await hashOfChunkIds([]), emptyDigest);
	assert.equal(EMPTY_CONTENT_HASH, emptyDigest);
});

test('chunker: spans cover the file exactly', async () => {
	for (const size of [0, 1, 100, 5000, 100_000]) {
		const bytes = utf8Encode(randomText(size, size + 1));
		const spans = chunkSpans(bytes);
		assert.equal(spans.length > 0, size > 0);
		let expected = 0;
		for (const span of spans) {
			assert.equal(span.start, expected);
			assert.ok(span.end > span.start);
			expected = span.end;
		}
		assert.equal(expected, bytes.length);
	}
});

test('chunker: is deterministic and edit-local (few chunks change)', async () => {
	const original = randomText(200_000, 7);
	const a = await chunkBytes(utf8Encode(original));
	const again = await chunkBytes(utf8Encode(original));
	assert.deepEqual(a.chunks.map((c) => c.id), again.chunks.map((c) => c.id));
	assert.equal(a.hash, again.hash);

	// Insert a paragraph in the middle.
	const mid = Math.floor(original.length / 2);
	const edited = original.slice(0, mid) + '\n## inserted heading\n\n' + original.slice(mid);
	const b = await chunkBytes(utf8Encode(edited));

	const before = new Set(a.chunks.map((c) => c.id));
	const after = new Set(b.chunks.map((c) => c.id));
	let retained = 0;
	for (const id of after) if (before.has(id)) retained++;
	const changed = after.size - retained;
	assert.ok(
		changed <= 4,
		`expected edit to change at most 4 chunks, changed ${changed} of ${after.size}`,
	);
	assert.notEqual(a.hash, b.hash);
});

test('chunker: whole-file dedupe gives identical hash across files', async () => {
	const text = randomText(50_000, 11);
	const one = await chunkBytes(utf8Encode(text));
	const two = await chunkBytes(utf8Encode(text));
	assert.equal(one.hash, two.hash);
});

test('glob: patterns match vault paths', async () => {
	assert.ok(globToRegExp('.obsidian/**').test('.obsidian/app.json'));
	assert.ok(globToRegExp('**/*.tmp').test('notes/deep/a.tmp'));
	assert.ok(globToRegExp('**/.DS_Store').test('.DS_Store'));
	assert.ok(!globToRegExp('**/*.tmp').test('notes/a.md'));
	assert.ok(globToRegExp('attachments/*').test('attachments/img.png'));
	assert.ok(!globToRegExp('attachments/*').test('attachments/sub/img.png'));
	const filter = new PF(['.obsidian/**', '**/*.tmp', '# comment']);
	assert.ok(filter.excluded('.obsidian/plugins/x/main.js'));
	assert.ok(filter.excluded('a/b.tmp'));
	assert.ok(!filter.excluded('notes/a.md'));
});

test('paths: helpers and conflict copy naming', async () => {
	assert.equal(normalizePath('/a//b/'), 'a/b');
	assert.equal(dirname('a/b/c.md'), 'a/b');
	assert.equal(basename('a/b/c.md'), 'c.md');
	assert.equal(extensionOf('a/b/c.tar.gz'), '.gz');
	assert.equal(sanitizeSegment('my:device?*'), 'my-device--');
	const taken = new Set(['note.conflict-20240101-120000-laptop.md']);
	const again = conflictCopyPath('note.md', 'laptop', new Date(2024, 0, 1, 12, 0, 0).getTime(), (p) =>
		taken.has(p),
	);
	assert.equal(again, 'note.conflict-20240101-120000-laptop-2.md');
	const first = conflictCopyPath('note.md', 'laptop', new Date(2024, 0, 1, 12, 0, 0).getTime(), () => false);
	assert.equal(first, 'note.conflict-20240101-120000-laptop.md');
});

test('manifest: index round-trips and rejects bad data', async () => {
	const index = {
		v: 1,
		vaultId: 'v1',
		seq: 3,
		updated: 123,
		files: {
			'a.md': { h: 'a'.repeat(32), s: 10, m: 5, c: ['b'.repeat(32)] },
			'gone.md': { d: true, m: 9 },
		},
		known: ['b'.repeat(32)],
	};
	const parsed = parseIndex(serializeIndex(index));
	assert.deepEqual(parsed, index);
	assert.equal(parseIndex('{"v":2}'), null);
	assert.equal(parseIndex('not json'), null);
	const dirty = parseIndex({
		v: 1,
		vaultId: 'v1',
		seq: 1,
		updated: 1,
		files: { bad: { h: 'nope' }, ok: index.files['a.md'] },
		known: ['zzz'],
	});
	assert.deepEqual(Object.keys(dirty.files), ['ok']);
	assert.deepEqual(dirty.known, []);
});

test('crypto: seal/open round-trip, wrong key fails', async () => {
	const { config, key } = await buildEncryptionConfig('hunter2-hunter2', 1000);
	const plaintext = utf8Encode('some secret markdown # note');
	const sealed = await seal(key, plaintext, 'chunk-1');
	assert.notDeepEqual(sealed, plaintext);
	assert.equal(utf8Decode(await open(key, sealed, 'chunk-1')), 'some secret markdown # note');

	const reopened = await unlockEncryption('hunter2-hunter2', config);
	assert.equal(utf8Decode(await open(reopened, sealed, 'chunk-1')), 'some secret markdown # note');

	await assert.rejects(() => unlockEncryption('wrong-passphrase', config), /口令错误/);

	// Associated data must be bound.
	await assert.rejects(() => open(key, sealed, 'chunk-2'));
});

// ------------------------------------------------------------ sync scenarios

test('sync: initial upload then a no-op second sync', async () => {
	const { server } = await makeServer();
	const vault = new DiskVault(await makeTmp('vault-a-1'));
	await vault.writeAt('notes/a.md', '# A\nhello world\n', Date.now());
	await vault.writeAt('notes/b.md', '# B\nsecond note\n', Date.now());
	await vault.writeAt('attach/img.bin', randomText(3000, 3), Date.now());

	const { store } = await connect(server, { vaultId: 'vault-a-1' });
	let state = newState('vault-a-1');

	const first = await sync(store, vault, state);
	assert.equal(first.summary.uploadedFiles, 3);
	assert.equal(first.summary.errors.length, 0);
	state = withState(state, first);

	const remoteFiles = await server.listFiles();
	assert.ok(remoteFiles.includes('sync/meta.json'));
	assert.ok(remoteFiles.some((f) => f.startsWith('sync/chunks/')));

	server.resetStats();
	const second = await sync(store, vault, state);
	assert.equal(second.summary.uploadedFiles, 0, 'no re-upload');
	assert.equal(second.summary.downloadedFiles, 0);
	assert.equal(second.summary.deletedLocal + second.summary.deletedRemote, 0);
	assert.equal(server.stats.requests.PUT ?? 0, 0, 'no PUT on a no-op sync');
});

test('sync: second device downloads everything (bootstrap)', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-2'));
	const b = new DiskVault(await makeTmp('vault-b-2'));
	await a.writeAt('notes/a.md', randomText(2000, 5), Date.now());
	await a.writeAt('notes/sub/b.md', randomText(5000, 6), Date.now());

	const conn = await connect(server, { vaultId: 'vault-2' });
	let stateA = newState('vault-2');
	stateA = withState(stateA, await sync(conn.store, a, stateA, { deviceName: 'a' }));

	let stateB = newState('vault-2');
	const firstB = await sync(conn.store, b, stateB, { deviceName: 'b' });
	assert.equal(firstB.summary.downloadedFiles, 2);
	stateB = withState(stateB, firstB);

	assert.equal(await b.readText('notes/a.md'), await a.readText('notes/a.md'));
	assert.equal(await b.readText('notes/sub/b.md'), await a.readText('notes/sub/b.md'));

	server.resetStats();
	const secondB = await sync(conn.store, b, stateB, { deviceName: 'b' });
	assert.equal(server.stats.requests.GET ?? 0, 1, 'only the index is fetched');
	assert.equal(secondB.summary.uploadedFiles + secondB.summary.downloadedFiles, 0);
});

test('sync: differential transfer only sends changed chunks', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-3'));
	const b = new DiskVault(await makeTmp('vault-b-3'));

	const original = randomText(400_000, 42);
	await a.writeAt('big.md', original, Date.now());

	const conn = await connect(server, { vaultId: 'vault-3' });
	let stateA = newState('vault-3');
	stateA = withState(stateA, await sync(conn.store, a, stateA, { deviceName: 'a' }));

	let stateB = newState('vault-3');
	stateB = withState(stateB, await sync(conn.store, b, stateB, { deviceName: 'b' }));
	assert.equal(await b.readText('big.md'), original);

	// Edit ~200 bytes in the middle of a 400 KB file.
	const mid = Math.floor(original.length / 2);
	const edited =
		original.slice(0, mid) +
		'\n' +
		'The quick brown fox jumps over the lazy dog, repeatedly and with gusto.\n' +
		original.slice(mid + 40);
	await a.writeAt('big.md', edited, b.mtimes.get('big.md') + 10_000);

	server.resetStats();
	const up = await sync(conn.store, a, stateA, { deviceName: 'a' });
	stateA = withState(stateA, up);
	assert.equal(up.summary.uploadedFiles, 1);
	assert.ok(
		up.summary.bytesUploaded < original.length * 0.1,
		`differential upload should be small, got ${up.summary.bytesUploaded} of ${original.length}`,
	);
	assert.ok(up.summary.chunksUploaded <= 4, `changed chunks: ${up.summary.chunksUploaded}`);

	server.resetStats();
	const down = await sync(conn.store, b, stateB, { deviceName: 'b' });
	stateB = withState(stateB, down);
	assert.equal(down.summary.downloadedFiles, 1);
	assert.equal(await b.readText('big.md'), edited);
	assert.ok(
		down.summary.bytesDownloaded < original.length * 0.1,
		`differential download should be small, got ${down.summary.bytesDownloaded}`,
	);
});

test('sync: rename costs nothing (content-addressed chunks are reused)', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-4'));
	const conn = await connect(server, { vaultId: 'vault-4' });
	await a.writeAt('old-name.md', randomText(120_000, 8), Date.now());
	let state = newState('vault-4');
	state = withState(state, await sync(conn.store, a, state));

	const content = await a.readText('old-name.md');
	await a.remove('old-name.md');
	await a.writeAt('new-name.md', content, Date.now() + 5000);

	server.resetStats();
	const result = await sync(conn.store, a, state);
	state = withState(state, result);
	assert.equal(result.summary.uploadedFiles, 1);
	assert.equal(result.summary.chunksUploaded, 0, 'renamed file reuses all chunks');
	assert.equal(result.summary.bytesUploaded, 0);
});

test('sync: remote edit propagates to a second device', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-5'));
	const b = new DiskVault(await makeTmp('vault-b-5'));
	await a.writeAt('note.md', 'version one\n', Date.now());

	const conn = await connect(server, { vaultId: 'vault-5' });
	let stateA = withState(newState('vault-5'), await sync(conn.store, a, newState('vault-5')));
	let stateB = withState(newState('vault-5'), await sync(conn.store, b, newState('vault-5')));
	assert.equal(await b.readText('note.md'), 'version one\n');

	await a.writeAt('note.md', 'version two\n', a.mtimes.get('note.md') + 10_000);
	stateA = withState(stateA, await sync(conn.store, a, stateA));

	const bResult = await sync(conn.store, b, stateB);
	assert.equal(bResult.summary.downloadedFiles, 1);
	assert.equal(await b.readText('note.md'), 'version two\n');
});

test('sync: delete propagates in both directions', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-6'));
	const b = new DiskVault(await makeTmp('vault-b-6'));
	await a.writeAt('keep.md', 'keep\n', Date.now());
	await a.writeAt('drop.md', 'drop\n', Date.now());

	const conn = await connect(server, { vaultId: 'vault-6' });
	let stateA = withState(newState('vault-6'), await sync(conn.store, a, newState('vault-6')));
	let stateB = withState(newState('vault-6'), await sync(conn.store, b, newState('vault-6')));
	assert.ok(await b.exists('drop.md'));

	// Delete on A.
	await a.remove('drop.md');
	const delA = await sync(conn.store, a, stateA);
	stateA = withState(stateA, delA);
	assert.equal(delA.summary.deletedRemote, 1);

	const delB = await sync(conn.store, b, stateB);
	stateB = withState(stateB, delB);
	assert.equal(delB.summary.deletedLocal, 1);
	assert.equal(await b.exists('drop.md'), false);
	assert.equal(await b.exists('keep.md'), true);

	// Delete on B (the other direction).
	await b.remove('keep.md');
	stateB = withState(stateB, await sync(conn.store, b, stateB));
	stateA = withState(stateA, await sync(conn.store, a, stateA));
	assert.equal(await a.exists('keep.md'), false);
});

test('sync: simultaneous edit creates a conflict copy, no data loss', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-7'));
	const b = new DiskVault(await makeTmp('vault-b-7'));
	const base = Date.now();
	await a.writeAt('shared.md', 'base content\n', base);

	const conn = await connect(server, { vaultId: 'vault-7' });
	let stateA = withState(newState('vault-7'), await sync(conn.store, a, newState('vault-7'), { deviceName: 'a' }));
	let stateB = withState(newState('vault-7'), await sync(conn.store, b, newState('vault-7'), { deviceName: 'b' }));

	// Both edit, B slightly newer.
	await a.writeAt('shared.md', 'A version\n', base + 10_000);
	await b.writeAt('shared.md', 'B version\n', base + 20_000);

	stateA = withState(stateA, await sync(conn.store, a, stateA, { deviceName: 'a' }));
	const resultB = await sync(conn.store, b, stateB, { deviceName: 'b' });
	stateB = withState(stateB, resultB);

	assert.equal(resultB.summary.conflicts, 1, 'one conflict copy');

	// B's version wins (newer); A's content survives in a conflict file.
	assert.equal(await b.readText('shared.md'), 'B version\n');
	const bPaths = await b.paths();
	const copy = bPaths.find((p) => p.includes('.conflict-'));
	assert.ok(copy, `conflict copy exists, paths=${bPaths.join(',')}`);
	assert.equal(await b.readText(copy), 'A version\n');

	// A converges to the same state.
	stateA = withState(stateA, await sync(conn.store, a, stateA, { deviceName: 'a' }));
	assert.equal(await a.readText('shared.md'), 'B version\n');
	const aCopy = (await a.paths()).find((p) => p.includes('.conflict-'));
	assert.ok(aCopy, 'conflict copy propagated to A');
	assert.equal(await a.readText(aCopy), 'A version\n');
});

test('sync: local edit vs remote delete resurrects the file', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-8'));
	const b = new DiskVault(await makeTmp('vault-b-8'));
	const base = Date.now();
	await a.writeAt('doc.md', 'original\n', base);

	const conn = await connect(server, { vaultId: 'vault-8' });
	let stateA = withState(newState('vault-8'), await sync(conn.store, a, newState('vault-8'), { deviceName: 'a' }));
	let stateB = withState(newState('vault-8'), await sync(conn.store, b, newState('vault-8'), { deviceName: 'b' }));

	// A deletes, B edits.
	await a.remove('doc.md');
	await b.writeAt('doc.md', 'edited after delete\n', base + 30_000);

	stateA = withState(stateA, await sync(conn.store, a, stateA, { deviceName: 'a' }));
	const resultB = await sync(conn.store, b, stateB, { deviceName: 'b' });
	stateB = withState(stateB, resultB);

	assert.equal(await b.readText('doc.md'), 'edited after delete\n', 'edit survives');
	assert.ok(resultB.summary.warnings.some((w) => w.includes('远端已删除')), 'warned about resurrect');

	stateA = withState(stateA, await sync(conn.store, a, stateA, { deviceName: 'a' }));
	assert.equal(await a.readText('doc.md'), 'edited after delete\n', 'file comes back on A');
});

test('sync: excluded paths are never touched', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-9'));
	await a.writeAt('.obsidian/app.json', '{"x":1}', Date.now());
	await a.writeAt('notes/a.md', 'hello\n', Date.now());
	const conn = await connect(server, { vaultId: 'vault-9' });
	const filter = new PF(['.obsidian/**']);
	const result = await sync(conn.store, a, newState('vault-9'), { isExcluded: (p) => filter.excluded(p) });
	assert.equal(result.summary.uploadedFiles, 1);
	const remote = await server.listFiles();
	assert.ok(!remote.some((f) => f.includes('app.json')), 'obsidian config not uploaded');
});

test('sync: encryption hides content from the server', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-10'));
	const b = new DiskVault(await makeTmp('vault-b-10'));
	const secret = 'TOP SECRET MARKER 12345\n' + randomText(4000, 9);
	await a.writeAt('secret.md', secret, Date.now());

	const { config, key } = await buildEncryptionConfig('correct horse battery staple', 1000);
	const client = new WebDavClient({ baseUrl: server.url, username: 'u', password: 'p', rootDir: 'sync' }, fetchTransport);
	await RemoteStore.writeMeta(client, {
		v: 1,
		vaultId: 'vault-10',
		encrypted: true,
		kdf: config.kdf,
		verifier: config.verifier,
	});
	const storeA = new RemoteStore({ client, meta: await RemoteStore.readMeta(client), key, concurrency: 3 });
	await storeA.ensureCollections();

	let stateA = withState(newState('vault-10'), await sync(storeA, a, newState('vault-10'), { deviceName: 'a' }));

	// Nothing readable on the server.
	for (const file of await server.listFiles()) {
		if (!file.endsWith('.enc') && !file.endsWith('meta.json') && !file.startsWith('sync/chunks/')) continue;
		const raw = await server.readFile(file);
		assert.ok(!raw.toString('utf8').includes('TOP SECRET MARKER'), `leaked in ${file}`);
	}

	// Correct passphrase on device B.
	const meta = await RemoteStore.readMeta(client);
	assert.equal(meta.encrypted, true);
	assert.equal(meta.verifier, config.verifier);
	const reopenedKey = await unlockEncryption('correct horse battery staple', {
		kdf: meta.kdf,
		verifier: meta.verifier,
	});
	const storeB = new RemoteStore({ client, meta, key: reopenedKey, concurrency: 3 });
	let stateB = withState(newState('vault-10'), await sync(storeB, b, newState('vault-10'), { deviceName: 'b' }));
	assert.equal(await b.readText('secret.md'), secret);

	// Wrong passphrase is rejected.
	await assert.rejects(
		() => unlockEncryption('wrong', { kdf: meta.kdf, verifier: meta.verifier }),
		/口令错误/,
	);
});

test('sync: mass deletion guard stops an accidental wipe', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-11'));
	const conn = await connect(server, { vaultId: 'vault-11' });
	for (let i = 0; i < 12; i++) await a.writeAt(`n${i}.md`, `note ${i}\n`, Date.now());
	let state = withState(newState('vault-11'), await sync(conn.store, a, newState('vault-11')));

	for (let i = 0; i < 12; i++) await a.remove(`n${i}.md`);
	await assert.rejects(
		() => sync(conn.store, a, state, { allowMassDelete: false }),
		/批量删除|超过 25%/,
	);
});

test('sync: garbage collection reclaims orphaned chunks', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-12'));
	const conn = await connect(server, { vaultId: 'vault-12' });
	await a.writeAt('doc.md', randomText(100_000, 12), Date.now());
	let state = withState(newState('vault-12'), await sync(conn.store, a, newState('vault-12')));

	const chunksBefore = (await server.listFiles()).filter((f) => f.startsWith('sync/chunks/')).length;
	await a.writeAt('doc.md', randomText(100_000, 99), Date.now() + 20_000);
	const result = await sync(conn.store, a, state);
	state = withState(state, result);
	const chunksAfter = (await server.listFiles()).filter((f) => f.startsWith('sync/chunks/')).length;

	assert.ok(result.summary.gcRemoved > 0, `removed ${result.summary.gcRemoved} chunks`);
	assert.ok(chunksAfter < chunksBefore * 2, `chunks did not accumulate: ${chunksBefore} -> ${chunksAfter}`);
});

test('sync: concurrent writers do not lose each other (index merge)', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-13'));
	const b = new DiskVault(await makeTmp('vault-b-13'));
	const conn = await connect(server, { vaultId: 'vault-13' });

	await a.writeAt('from-a.md', 'A\n', Date.now());
	await b.writeAt('from-b.md', 'B\n', Date.now());

	// Both sync "at the same time" from an empty base.
	const [ra, rb] = await Promise.all([
		runSync(conn.store, {
			vault: a,
			stateFiles: {},
			deviceName: 'a',
			concurrency: 3,
			alwaysRehash: true,
			collectGarbage: false,
			allowMassDelete: true,
		}),
		runSync(conn.store, {
			vault: b,
			stateFiles: {},
			deviceName: 'b',
			concurrency: 3,
			alwaysRehash: true,
			collectGarbage: false,
			allowMassDelete: true,
		}),
	]);
	assert.ok(ra.summary.errors.length + rb.summary.errors.length === 0, 'no hard failures');

	// A third device must see both files.
	const c = new DiskVault(await makeTmp('vault-c-13'));
	const rc = await sync(conn.store, c, newState('vault-13'), { deviceName: 'c' });
	assert.equal(await c.exists('from-a.md'), true, 'from-a survived the race');
	assert.equal(await c.exists('from-b.md'), true, 'from-b survived the race');
	assert.ok(rc.summary.downloadedFiles >= 2);
});

test('sync: vault mismatch between two different vaults is rejected', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-14'));
	await a.writeAt('a.md', 'a\n', Date.now());
	const conn = await connect(server, { vaultId: 'vault-14' });
	await sync(conn.store, a, newState('vault-14'));

	// A second vault pointed at the same remote with different state id.
	const b = new DiskVault(await makeTmp('vault-b-14'));
	const staleState = { files: {}, vaultId: 'other-vault', lastSync: null };
	await assert.rejects(
		() =>
			runSync(conn.store, {
				vault: b,
				stateFiles: staleState.files,
				stateVaultId: 'other-vault',
				deviceName: 'b',
				concurrency: 2,
				alwaysRehash: true,
				allowMassDelete: true,
			}),
		/不同的库|VaultMismatch|库标识/,
	);
});

test('sync: conditional-write-ignoring server still merges safely', async () => {
	const { server } = await makeServer({ ignoreConditional: true });
	const a = new DiskVault(await makeTmp('vault-a-15'));
	const b = new DiskVault(await makeTmp('vault-b-15'));
	const conn = await connect(server, { vaultId: 'vault-15' });

	await a.writeAt('a.md', 'A\n', Date.now());
	await b.writeAt('b.md', 'B\n', Date.now());

	await Promise.all([
		sync(conn.store, a, newState('vault-15'), { deviceName: 'a' }),
		sync(conn.store, b, newState('vault-15'), { deviceName: 'b' }),
	]);

	const c = new DiskVault(await makeTmp('vault-c-15'));
	await sync(conn.store, c, newState('vault-15'), { deviceName: 'c' });
	const cPaths = await c.paths();
	// One of the two may win on a server that ignores If-Match, but the store
	// must remain consistent and readable.
	assert.ok(cPaths.filter((p) => p.endsWith('.md')).length >= 1);
	for (const p of cPaths) assert.ok((await c.readText(p)).length > 0);
});

test('sync: large file survives chunk round-trip', async () => {
	const { server } = await makeServer();
	const a = new DiskVault(await makeTmp('vault-a-16'));
	const b = new DiskVault(await makeTmp('vault-b-16'));
	const size = 3 * 1024 * 1024;
	const binary = new Uint8Array(size);
	for (let i = 0; i < size; i++) binary[i] = (i * 131 + (i >> 8)) & 0xff;
	await a.write('blob/asset.bin', binary);

	const conn = await connect(server, { vaultId: 'vault-16' });
	let stateA = withState(newState('vault-16'), await sync(conn.store, a, newState('vault-16')));
	let stateB = withState(newState('vault-16'), await sync(conn.store, b, newState('vault-16')));

	const restored = await b.read('blob/asset.bin');
	assert.equal(restored.length, size);
	assert.ok(Buffer.from(restored).equals(Buffer.from(binary)), 'binary content identical');

	// Flip bytes near the end: only the tail chunk should move.
	const edited = new Uint8Array(binary);
	for (let i = size - 200; i < size - 100; i++) edited[i] = 7;
	await a.write('blob/asset.bin', edited);
	server.resetStats();
	const up = await sync(conn.store, a, stateA, { alwaysRehash: true });
	stateA = withState(stateA, up);
	assert.ok(up.summary.bytesUploaded < 100 * 1024, `tail edit uploaded ${up.summary.bytesUploaded} bytes`);
});

// ----------------------------------------------------------------------- run

tmpRoot = await mkdtemp(path.join(tmpdir(), 'diff-sync-test-'));
try {
	await main();
} finally {
	await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}
