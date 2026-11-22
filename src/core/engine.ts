import { chunkBytes, ChunkerConfig, DEFAULT_CHUNKER } from './chunker';
import { contentId } from './hash';
import {
	isLive,
	RemoteFileLive,
	RemoteIndex,
	SyncState,
	SyncStateEntry,
	referencedChunkIds,
} from './manifest';
import { conflictCopyPath, normalizePath } from './paths';
import { RemoteStore, VaultMismatchError } from './remote';
import {
	ChunkCache,
	ScannedLocalFile,
	SyncEngineOptions,
	SyncProgress,
	SyncSummary,
	createSummary,
} from './types';
import { assertNotAborted, errorMessage, mapLimit } from './util';

export interface SyncResult {
	summary: SyncSummary;
	state: SyncState;
	index: RemoteIndex;
	indexEtag: string | null;
}

type Action =
	| { kind: 'upload'; path: string; reason: string }
	| { kind: 'download'; path: string; entry: RemoteFileLive; reason: string }
	| { kind: 'delete-remote'; path: string }
	/** Path is excluded now: stop advertising it remotely, keep all local files. */
	| { kind: 'untrack-remote'; path: string }
	| { kind: 'delete-local'; path: string }
	/** Both sides changed: local wins, the remote version is preserved beside it. */
	| { kind: 'conflict-local'; path: string; entry: RemoteFileLive }
	/** Both sides changed: remote wins, the local version is preserved beside it. */
	| { kind: 'conflict-remote'; path: string; entry: RemoteFileLive };

const MAX_INDEX_ATTEMPTS = 5;
const CLOCK_SKEW_MS = 2_000;
/** Bytes of rehashed files kept in memory between scan and upload. */
const CARRY_BUDGET = 32 * 1024 * 1024;

export class MemoryChunkCache implements ChunkCache {
	private readonly map = new Map<string, Uint8Array>();

	async has(id: string): Promise<boolean> {
		return this.map.has(id);
	}
	async get(id: string): Promise<Uint8Array | null> {
		return this.map.get(id) ?? null;
	}
	async put(id: string, data: Uint8Array): Promise<void> {
		this.map.set(id, data);
	}
	async delete(id: string): Promise<void> {
		this.map.delete(id);
	}
	async list(): Promise<string[]> {
		return [...this.map.keys()];
	}
}

interface EngineContext {
	store: RemoteStore;
	options: SyncEngineOptions;
	summary: SyncSummary;
	chunker: ChunkerConfig;
	cache: ChunkCache;
	signal: AbortSignal | undefined;
	now: () => number;
	local: Map<string, ScannedLocalFile>;
	carry: Map<string, Uint8Array>;
	carryBytes: number;
	remoteKnown: Set<string>;
	uploadJobs: Map<string, Promise<void>>;
	uploadedChunkIds: Set<string>;
	/** Ids known to be present in the cache right now. */
	cached: Set<string>;
	fetchedChunks: number;
	fetchedBytes: number;
	state: SyncState;
	index: RemoteIndex;
	indexEtag: string | null;
	touched: Set<string>;
	progress: (phase: SyncProgress['phase'], current: number, total: number, detail?: string) => void;
	log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

function isSafePath(path: string): boolean {
	if (!path || path.length > 1024) return false;
	if (path.startsWith('/') || path.startsWith('\\')) return false;
	if (/^[a-zA-Z]:/.test(path)) return false;
	const segments = path.split('/');
	return !segments.some((segment) => segment === '..' || segment === '' || segment === '.');
}

function stateEntry(hash: string, size: number, mtime: number, chunks: readonly string[]): SyncStateEntry {
	return { h: hash, s: size, m: mtime, c: [...chunks] };
}

// ------------------------------------------------------------------------ scan

async function scanLocal(ctx: EngineContext): Promise<void> {
	const isExcluded = ctx.options.isExcluded ?? (() => false);
	const files = (await ctx.options.vault.list()).filter(
		(info) => !isExcluded(normalizePath(info.path)),
	);
	const total = files.length;
	let current = 0;

	await mapLimit(files, Math.max(2, ctx.options.concurrency), async (info) => {
		assertNotAborted(ctx.signal);
		const path = normalizePath(info.path);
		if (!isSafePath(path)) {
			ctx.summary.warnings.push(`跳过非法路径: ${path}`);
			return;
		}

		const previous = ctx.state.files[path];
		const mtime = Math.round(info.mtime);
		const unchangedByStat =
			!ctx.options.alwaysRehash &&
			previous != null &&
			previous.s === info.size &&
			Math.round(previous.m) === mtime;

		if (unchangedByStat) {
			ctx.local.set(path, {
				path,
				size: info.size,
				mtime,
				hash: previous.h,
				chunkIds: [...previous.c],
				rehashed: false,
			});
		} else {
			const bytes = await ctx.options.vault.read(path);
			const chunked = await chunkBytes(bytes, ctx.chunker);
			ctx.local.set(path, {
				path,
				size: bytes.length,
				mtime,
				hash: chunked.hash,
				chunkIds: chunked.chunks.map((chunk) => chunk.id),
				rehashed: true,
			});
			if (ctx.carryBytes + bytes.length <= CARRY_BUDGET) {
				ctx.carry.set(path, bytes);
				ctx.carryBytes += bytes.length;
			}
		}

		current++;
		if (current === total || current % 20 === 0) ctx.progress('scan', current, total, path);
	});
}

// ------------------------------------------------------------------------ plan

function planActions(ctx: EngineContext): Action[] {
	const actions: Action[] = [];
	const excluded = ctx.options.isExcluded ?? (() => false);
	const paths = new Set<string>([
		...ctx.local.keys(),
		...Object.keys(ctx.state.files),
		...Object.keys(ctx.index.files),
	]);

	for (const rawPath of [...paths].sort()) {
		const path = normalizePath(rawPath);
		if (!isSafePath(path)) {
			ctx.summary.warnings.push(`忽略非法路径: ${rawPath}`);
			continue;
		}
		if (excluded(path)) {
			// Paths excluded now but synced earlier must be retired from the
			// remote index, otherwise they keep reappearing on every device.
			delete ctx.state.files[path];
			if (ctx.index.files[path] && isLive(ctx.index.files[path])) {
				actions.push({ kind: 'untrack-remote', path });
			}
			continue;
		}

		const local = ctx.local.get(path) ?? null;
		const base = ctx.state.files[path] ?? null;
		const rawRemote = ctx.index.files[path];
		const remote = isLive(rawRemote) ? rawRemote : null;

		// ---- no merge base ----
		if (!base) {
			if (local && !remote) {
				actions.push({ kind: 'upload', path, reason: '本地新增' });
			} else if (!local && remote) {
				actions.push({ kind: 'download', path, entry: remote, reason: '远端新增' });
			} else if (local && remote) {
				if (local.hash === remote.h) {
					ctx.state.files[path] = stateEntry(local.hash, local.size, local.mtime, local.chunkIds);
					ctx.summary.skippedFiles++;
				} else {
					actions.push(conflictAction(path, local, remote));
				}
			}
			continue;
		}

		// ---- both sides gone ----
		if (!local && !remote) {
			delete ctx.state.files[path];
			continue;
		}

		// ---- deleted locally ----
		if (!local) {
			const remoteChanged = !remote || remote.h !== base.h;
			if (remoteChanged && remote) {
				ctx.summary.warnings.push(`${path}: 本地已删除但远端有修改，已恢复本地文件`);
				actions.push({ kind: 'download', path, entry: remote, reason: '本地删除但远端已修改' });
			} else {
				actions.push({ kind: 'delete-remote', path });
			}
			continue;
		}

		// ---- deleted remotely ----
		if (!remote) {
			const localChanged = local.hash !== base.h;
			if (localChanged) {
				ctx.summary.warnings.push(`${path}: 远端已删除但本地有修改，已重新上传`);
				actions.push({ kind: 'upload', path, reason: '远端删除但本地已修改' });
			} else if (rawRemote !== undefined) {
				actions.push({ kind: 'delete-local', path });
			} else {
				actions.push({ kind: 'upload', path, reason: '本地新增' });
			}
			continue;
		}

		// ---- both present ----
		const localChanged = local.hash !== base.h;
		const remoteChanged = remote.h !== base.h;

		if (!localChanged && !remoteChanged) {
			ctx.state.files[path] = stateEntry(local.hash, local.size, local.mtime, local.chunkIds);
			ctx.summary.skippedFiles++;
		} else if (localChanged && !remoteChanged) {
			actions.push({ kind: 'upload', path, reason: '本地修改' });
		} else if (!localChanged && remoteChanged) {
			actions.push({ kind: 'download', path, entry: remote, reason: '远端修改' });
		} else if (local.hash === remote.h) {
			ctx.state.files[path] = stateEntry(local.hash, local.size, local.mtime, local.chunkIds);
			ctx.summary.skippedFiles++;
		} else {
			actions.push(conflictAction(path, local, remote));
		}
	}

	return actions;
}

/** Newest write wins; the losing version is preserved as a copy. */
function conflictAction(path: string, local: ScannedLocalFile, remote: RemoteFileLive): Action {
	const remoteIsNewer = remote.m - local.mtime > CLOCK_SKEW_MS;
	return remoteIsNewer
		? { kind: 'conflict-remote', path, entry: remote }
		: { kind: 'conflict-local', path, entry: remote };
}

// ------------------------------------------------------------------- transfers

/**
 * Make sure every chunk of `entry` is in the cache.
 *
 * Differential downloads depend on this: chunks of the *old* local version are
 * reconstructed from the file already on disk, so a small edit only costs a few
 * new chunks over the wire.
 */
async function ensureChunks(ctx: EngineContext, path: string, entry: RemoteFileLive): Promise<void> {
	const missing: string[] = [];
	for (const id of entry.c) {
		if (!ctx.cached.has(id) && !(await ctx.cache.has(id))) missing.push(id);
		else ctx.cached.add(id);
	}
	if (missing.length === 0) return;

	// Seed from the local file when it still holds the previous version.
	const base = ctx.state.files[path];
	if (base && base.h !== entry.h && (await ctx.options.vault.exists(path))) {
		try {
			const bytes = await ctx.options.vault.read(path);
			const chunked = await chunkBytes(bytes, ctx.chunker);
			const wanted = new Set(missing);
			for (const chunk of chunked.chunks) {
				if (!wanted.has(chunk.id)) continue;
				await ctx.cache.put(chunk.id, bytes.subarray(chunk.start, chunk.end));
				ctx.cached.add(chunk.id);
				wanted.delete(chunk.id);
			}
		} catch {
			// A seeding failure only costs bandwidth.
		}
	}

	const pending = missing.filter((id) => !ctx.cached.has(id));
	await mapLimit(pending, ctx.options.concurrency, async (id) => {
		assertNotAborted(ctx.signal);
		if (ctx.cached.has(id)) return;
		const body = await ctx.store.getChunk(id);
		if (!body) throw new Error(`远端缺少分块 ${id}（远端仓库可能被外部修改）`);
		if ((await contentId(body)) !== id) {
			throw new Error(`分块 ${id} 校验失败（远端损坏或加密口令不一致）`);
		}
		await ctx.cache.put(id, body);
		ctx.cached.add(id);
		ctx.fetchedChunks++;
		ctx.fetchedBytes += body.length;
		ctx.progress('download', ctx.fetchedChunks, 0, id.slice(0, 8));
	});
}

async function assemble(ctx: EngineContext, entry: RemoteFileLive): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for (const id of entry.c) {
		let bytes = await ctx.cache.get(id);
		if (!bytes) {
			const fetched = await ctx.store.getChunk(id);
			if (!fetched) throw new Error(`缺少分块 ${id}`);
			if ((await contentId(fetched)) !== id) throw new Error(`分块 ${id} 校验失败`);
			await ctx.cache.put(id, fetched);
			ctx.cached.add(id);
			ctx.fetchedChunks++;
			ctx.fetchedBytes += fetched.length;
			bytes = fetched;
		}
		parts.push(bytes);
	}

	let total = 0;
	for (const part of parts) total += part.length;
	if (total !== entry.s) throw new Error(`文件大小不符: ${total} != ${entry.s}`);

	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

async function writeFromRemote(
	ctx: EngineContext,
	path: string,
	entry: RemoteFileLive,
): Promise<void> {
	const bytes = await assemble(ctx, entry);
	if (ctx.options.beforeOverwrite && (await ctx.options.vault.exists(path))) {
		try {
			const previous = await ctx.options.vault.read(path);
			await ctx.options.beforeOverwrite(path, previous);
		} catch (error) {
			ctx.summary.warnings.push(`${path}: 历史快照失败 (${errorMessage(error)})`);
		}
	}
	await ctx.options.vault.write(path, bytes);
	// Record the mtime the *next* scan will see, not the remote's: otherwise a
	// remote entry with an older mtime makes every subsequent sync think the
	// file changed locally and re-uploads it.
	const stats = await ctx.options.vault.stat(path);
	ctx.state.files[path] = stateEntry(
		entry.h,
		entry.s,
		stats ? Math.round(stats.mtime) : ctx.now(),
		entry.c,
	);
	ctx.index.files[path] = { h: entry.h, s: entry.s, m: entry.m, c: [...entry.c] };
	ctx.touched.add(path);
	ctx.summary.downloadedFiles++;
	ctx.summary.naiveBytes += entry.s;
}

async function uploadFile(ctx: EngineContext, path: string): Promise<void> {
	const scanned = ctx.local.get(path) ?? null;
	const stats = await ctx.options.vault.stat(path);
	if (!stats) throw new Error(`文件已消失: ${path}`);

	// Reuse bytes read during the scan only if the file has not changed since.
	const carried =
		scanned?.rehashed &&
		scanned.size === stats.size &&
		scanned.mtime === Math.round(stats.mtime)
			? ctx.carry.get(path) ?? null
			: null;
	const bytes = carried ?? (await ctx.options.vault.read(path));
	const chunked = await chunkBytes(bytes, ctx.chunker);
	// The file's chunk list must preserve duplicates (a repeated paragraph is a
	// repeated chunk id); only the upload set is deduplicated.
	const chunkIds = chunked.chunks.map((chunk) => chunk.id);

	const existing = ctx.index.files[path];
	if (isLive(existing) && existing.h === chunked.hash) {
		// Remote already holds this exact content (e.g. a rename).
		ctx.state.files[path] = stateEntry(chunked.hash, bytes.length, Math.round(stats.mtime), chunkIds);
		ctx.index.files[path] = {
			h: chunked.hash,
			s: bytes.length,
			m: Math.round(stats.mtime),
			c: chunkIds,
		};
		ctx.touched.add(path);
		ctx.summary.skippedFiles++;
		ctx.carry.delete(path);
		ctx.carryBytes -= carried?.length ?? 0;
		return;
	}

	const missing = new Map<string, Uint8Array>();
	for (const chunk of chunked.chunks) {
		if (ctx.remoteKnown.has(chunk.id) || missing.has(chunk.id)) continue;
		missing.set(chunk.id, bytes.subarray(chunk.start, chunk.end));
	}

	await mapLimit([...missing], ctx.options.concurrency, async ([id, data]) => {
		assertNotAborted(ctx.signal);
		let job = ctx.uploadJobs.get(id);
		if (!job) {
			job = ctx.store.putChunk(id, data);
			ctx.uploadJobs.set(id, job);
		}
		await job;
		ctx.uploadedChunkIds.add(id);
		ctx.remoteKnown.add(id);
	});

	const mtime = Math.round(stats.mtime);
	ctx.index.files[path] = { h: chunked.hash, s: bytes.length, m: mtime, c: chunkIds };
	ctx.state.files[path] = stateEntry(chunked.hash, bytes.length, mtime, chunkIds);
	ctx.touched.add(path);

	ctx.summary.uploadedFiles++;
	ctx.summary.chunksUploaded += missing.size;
	for (const data of missing.values()) ctx.summary.bytesUploaded += data.length;
	ctx.summary.naiveBytes += bytes.length;

	ctx.carry.delete(path);
	ctx.carryBytes -= carried?.length ?? 0;
}

/**
 * Preserve `bytes` beside `path`, unless the same content already exists
 * locally (which happens once the other device's conflict copy has arrived).
 */
async function preserveCopy(
	ctx: EngineContext,
	path: string,
	bytes: Uint8Array,
	taken: Set<string>,
): Promise<string | null> {
	const chunked = await chunkBytes(bytes, ctx.chunker);
	for (const [otherPath, entry] of Object.entries(ctx.state.files)) {
		if (otherPath === path || entry.h !== chunked.hash) continue;
		if (await ctx.options.vault.exists(otherPath)) return null;
	}

	const copyPath = conflictCopyPath(path, ctx.options.deviceName, ctx.now(), (candidate) =>
		taken.has(normalizePath(candidate)),
	);
	taken.add(copyPath);
	await ctx.options.vault.write(copyPath, bytes);
	ctx.summary.conflicts++;
	ctx.summary.conflictPaths.push(copyPath);
	ctx.log(`冲突：${path} 的另一版本已保存为 ${copyPath}`, 'warn');
	return copyPath;
}

// --------------------------------------------------------------------- execute

export async function runSync(store: RemoteStore, options: SyncEngineOptions): Promise<SyncResult> {
	const now = options.now ?? (() => Date.now());
	const summary = createSummary(now());
	const cache = options.cache ?? new MemoryChunkCache();
	const ctx: EngineContext = {
		store,
		options,
		summary,
		chunker: options.chunker ?? DEFAULT_CHUNKER,
		cache,
		signal: options.signal,
		now,
		local: new Map(),
		carry: new Map(),
		carryBytes: 0,
		remoteKnown: new Set(),
		uploadJobs: new Map(),
		uploadedChunkIds: new Set(),
		cached: new Set(),
		fetchedChunks: 0,
		fetchedBytes: 0,
		state: {
			v: 1,
			vaultId: store.vaultId,
			files: { ...options.stateFiles },
			lastSync: null,
		},
		index: { v: 1, vaultId: store.vaultId, seq: 0, updated: now(), files: {}, known: [] },
		indexEtag: null,
		touched: new Set(),
		progress: (phase, current, total, detail) => options.onProgress?.({ phase, current, total, detail }),
		log: (message, level) => options.log?.(message, level),
	};

	// 1. Remote index.
	const snapshot = await store.loadIndex();
	if (snapshot) {
		ctx.index = snapshot.index;
		ctx.indexEtag = snapshot.etag;
	}
	if (ctx.index.vaultId !== store.vaultId) {
		throw new VaultMismatchError(ctx.index.vaultId, store.vaultId);
	}
	if (options.stateVaultId && options.stateVaultId !== store.vaultId) {
		throw new VaultMismatchError(store.vaultId, options.stateVaultId);
	}
	for (const id of ctx.index.known) ctx.remoteKnown.add(id);
	for (const id of referencedChunkIds(ctx.index)) ctx.remoteKnown.add(id);

	// 2. Scan local files.
	await scanLocal(ctx);

	// 3. Plan.
	ctx.progress('plan', 0, 1, '比较本地与远端');
	const actions = planActions(ctx);
	const count = (kind: Action['kind']) => actions.filter((a) => a.kind === kind).length;
	const destructive = count('delete-local') + count('delete-remote');
	ctx.log(
		`计划：上传 ${count('upload')}，下载 ${count('download')}，` +
			`删除 ${destructive}，冲突 ${count('conflict-local') + count('conflict-remote')}`,
	);

	if (destructive > 0 && !options.allowMassDelete) {
		const tracked = Object.keys(ctx.state.files).length;
		if (destructive > 5 && destructive > Math.max(10, tracked * 0.25)) {
			throw new Error(
				`本次将删除 ${destructive} 个文件（超过 25%），已中止以避免误删。` +
					'确认无误后可在设置中临时开启“允许批量删除”。',
			);
		}
	}

	// 4. Deletions first: frees space before downloads.
	for (const action of actions) {
		if (action.kind !== 'delete-local') continue;
		assertNotAborted(ctx.signal);
		if (ctx.options.beforeDelete) {
			try {
				const previous = await ctx.options.vault.read(action.path).catch(() => null);
				await ctx.options.beforeDelete(action.path, previous);
			} catch (error) {
				ctx.summary.warnings.push(`${action.path}: 历史快照失败 (${errorMessage(error)})`);
			}
		}
		await ctx.options.vault.remove(action.path);
		delete ctx.state.files[action.path];
		ctx.summary.deletedLocal++;
		ctx.log(`删除本地 ${action.path}`);
	}

	// 5. Downloads.
	const downloads = actions.filter(
		(a): a is Extract<Action, { kind: 'download' }> => a.kind === 'download',
	);
	let downloaded = 0;
	if (downloads.length > 0) ctx.progress('download', 0, downloads.length, '准备下载');
	for (const action of downloads) {
		assertNotAborted(ctx.signal);
		await ensureChunks(ctx, action.path, action.entry);
		await writeFromRemote(ctx, action.path, action.entry);
		downloaded++;
		ctx.progress('download', downloaded, downloads.length, action.path);
		ctx.log(`下载 ${action.path}（${action.reason}）`);
	}

	// 6. Conflicts.
	const taken = new Set<string>([...ctx.local.keys(), ...Object.keys(ctx.index.files)]);
	const pendingUploads = new Set<string>();
	for (const action of actions) {
		if (action.kind === 'conflict-local') {
			await ensureChunks(ctx, action.path, action.entry);
			const remoteBytes = await assemble(ctx, action.entry);
			const copyPath = await preserveCopy(ctx, action.path, remoteBytes, taken);
			ctx.summary.naiveBytes += remoteBytes.length;
			ctx.log(`${action.path}: 冲突，保留本地版本`, 'warn');
			pendingUploads.add(action.path);
			if (copyPath) {
				// The preserved remote version still has to reach the remote.
				ctx.local.set(copyPath, {
					path: copyPath,
					size: remoteBytes.length,
					mtime: now(),
					hash: '',
					chunkIds: [],
					rehashed: true,
				});
				ctx.carry.set(copyPath, remoteBytes);
				ctx.carryBytes += remoteBytes.length;
				pendingUploads.add(copyPath);
			}
		} else if (action.kind === 'conflict-remote') {
			const localBytes = ctx.carry.get(action.path) ?? (await ctx.options.vault.read(action.path));
			const copyPath = await preserveCopy(ctx, action.path, localBytes, taken);
			await ensureChunks(ctx, action.path, action.entry);
			await writeFromRemote(ctx, action.path, action.entry);
			ctx.summary.naiveBytes += localBytes.length;
			ctx.log(`${action.path}: 冲突，采用远端较新版本`, 'warn');
			if (copyPath) {
				ctx.local.set(copyPath, {
					path: copyPath,
					size: localBytes.length,
					mtime: now(),
					hash: '',
					chunkIds: [],
					rehashed: true,
				});
				ctx.carry.set(copyPath, localBytes);
				ctx.carryBytes += localBytes.length;
				pendingUploads.add(copyPath);
			}
		}
	}

	// 7. Uploads: changed files, conflict winners, preserved copies.
	for (const action of actions) if (action.kind === 'upload') pendingUploads.add(action.path);

	let uploaded = 0;
	const uploadList = [...pendingUploads];
	await mapLimit(uploadList, Math.max(1, Math.min(4, options.concurrency)), async (path) => {
		assertNotAborted(ctx.signal);
		try {
			await uploadFile(ctx, path);
			uploaded++;
			ctx.progress('upload', uploaded, uploadList.length, path);
		} catch (error) {
			const message = `上传失败 ${path}: ${errorMessage(error)}`;
			ctx.summary.errors.push(message);
			ctx.log(message, 'error');
		}
	});

	// 8. Remote deletions.
	for (const action of actions) {
		if (action.kind === 'delete-remote') {
			ctx.index.files[action.path] = { d: true, m: now() };
			delete ctx.state.files[action.path];
			ctx.touched.add(action.path);
			ctx.summary.deletedRemote++;
			ctx.log(`删除远端 ${action.path}`);
		} else if (action.kind === 'untrack-remote') {
			delete ctx.index.files[action.path];
			ctx.touched.add(action.path);
			ctx.log(`不再同步已排除的路径 ${action.path}`);
		}
	}

	// 9. Persist the index — only if this sync actually changed something.
	ctx.summary.chunksDownloaded = ctx.fetchedChunks;
	ctx.summary.bytesDownloaded = ctx.fetchedBytes;
	if (ctx.touched.size > 0 || ctx.uploadedChunkIds.size > 0) {
		ctx.progress('finalize', 0, 1, '写入远端索引');
		await saveIndex(ctx);
	}

	// 10. Garbage collection.
	if (options.collectGarbage !== false) {
		ctx.progress('gc', 0, 1, '清理无用分块');
		await collectGarbage(ctx);
	}

	ctx.state.lastSync = now();
	summary.durationMs = now() - summary.startedAt;
	return { summary, state: ctx.state, index: ctx.index, indexEtag: ctx.indexEtag };
}

async function collectGarbage(ctx: EngineContext): Promise<void> {
	try {
		const referenced = referencedChunkIds(ctx.index);
		const stale = ctx.index.known.filter((id) => !referenced.has(id));
		if (stale.length > 0) {
			await mapLimit(stale, Math.max(2, ctx.options.concurrency), async (id) => {
				try {
					await ctx.store.deleteChunk(id);
					ctx.summary.gcRemoved++;
				} catch {
					// A chunk that refuses deletion only costs space.
				}
			});
			ctx.index.known = [...referenced];
			await saveIndex(ctx);
		}
	} catch (error) {
		ctx.summary.warnings.push(`清理分块失败: ${errorMessage(error)}`);
	}
}

/**
 * True when every path this sync touched is present in the stored index with
 * exactly the entry we wrote. Detects silently lost writes on servers that do
 * not enforce If-Match atomically.
 */
async function verifyTouched(ctx: EngineContext): Promise<boolean> {
	if (ctx.touched.size === 0) return true;
	const stored = await ctx.store.loadIndex();
	if (!stored) return false;
	for (const path of ctx.touched) {
		const expected = ctx.index.files[path];
		const actual = stored.index.files[path];
		if (!expected) continue;
		if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) return false;
	}
	return true;
}

/**
 * Persist our per-file decisions without clobbering other devices.
 *
 * Always re-reads the index immediately before writing and merges only the
 * paths this sync is responsible for (`ctx.touched`), then writes with the ETag
 * we just observed. That keeps a long sync from overwriting a peer's entries
 * that landed while we were transferring.
 */
async function saveIndex(ctx: EngineContext): Promise<void> {
	const known = new Set(ctx.index.known);
	for (const id of ctx.uploadedChunkIds) known.add(id);
	ctx.index.known = [...known];

	for (let attempt = 0; attempt < MAX_INDEX_ATTEMPTS; attempt++) {
		assertNotAborted(ctx.signal);

		// Read-modify-write: the freshest possible merge base.
		const latest = await ctx.store.loadIndex();
		if (latest && latest.index.vaultId !== ctx.index.vaultId) {
			throw new VaultMismatchError(latest.index.vaultId, ctx.index.vaultId);
		}

		const merged = latest ? latest.index : ctx.index;
		const knownUnion = new Set<string>([
			...(latest?.index.known ?? []),
			...ctx.index.known,
		]);
		let changed = false;
		for (const path of ctx.touched) {
			const entry = ctx.index.files[path];
			const before = merged.files[path];
			if (entry) {
				if (JSON.stringify(entry) !== JSON.stringify(before)) {
					merged.files[path] = entry;
					changed = true;
				}
			} else if (before !== undefined) {
				delete merged.files[path];
				changed = true;
			}
		}
		const knownUnchanged =
			knownUnion.size === merged.known.length &&
			[...knownUnion].every((id) => merged.known.includes(id));
		if (!changed && knownUnchanged && latest) {
			// Nothing to record and the remote copy already matches: skip the write.
			ctx.index = merged;
			ctx.indexEtag = latest.etag ?? ctx.indexEtag;
			return;
		}
		merged.known = [...knownUnion];
		merged.seq = (latest ? latest.index.seq : 0) + 1;
		merged.updated = ctx.now();
		ctx.index = merged;

		const result = await ctx.store.saveIndex(merged, latest?.etag ?? null);
		if (result.ok) {
			ctx.indexEtag = result.etag ?? null;
			// Post-write verification: on servers whose preconditions are not
			// atomic two writers can both succeed. Confirm our entries actually
			// landed; otherwise merge again.
			if (await verifyTouched(ctx)) return;
			ctx.log('远端索引写入被并发覆盖，正在重新合并', 'warn');
			continue;
		}
		ctx.log('远端索引写入冲突，正在重试', 'warn');
	}

	throw new Error('远端索引写入冲突次数过多，请稍后重试');
}
