/**
 * Two-language message catalog for everything a user can see.
 *
 * The Obsidian layer activates the app language on load, so a non-Chinese UI
 * defaults to English. Core stays free of Obsidian imports: only `setLocale`
 * decides which catalog `t()` reads.
 */

export type Locale = 'en' | 'zh';

export type MessageParams = Record<string, string | number>;

const EN = {
	// ---------------------------------------------------------------- common
	'common.cancel': 'Cancel',
	'common.confirm': 'OK',
	'common.test': 'Test',

	// ------------------------------------------------------ commands & ribbon
	'command.syncNow': 'Sync now',
	'command.fullRescan': 'Full rescan and sync',
	'command.cancelSync': 'Cancel current sync',
	'command.showLog': 'Show sync log',
	'command.clearChunkCache': 'Clear local chunk cache',
	'command.clearHistory': 'Clear local history snapshots',
	'command.openPanel': 'Open sync panel',
	'ribbon.syncNow': 'Diff Sync: sync now',

	// ---------------------------------------------------------------- status
	'status.pending': 'Pending',
	'status.preparing': 'Preparing…',
	'status.failed': 'Sync failed',
	'status.upToDate': 'Up to date',
	'status.barTooltip': 'Diff Sync — click to sync now',
	'progress.scan': 'Scanning local',
	'progress.plan': 'Comparing',
	'progress.download': 'Downloading',
	'progress.upload': 'Uploading',
	'progress.finalize': 'Writing index',
	'progress.gc': 'Cleaning chunks',

	// --------------------------------------------------------------- notices
	'notice.alreadySyncing': 'A sync is already in progress',
	'notice.notConfigured': 'Set the WebDAV server URL in settings first',
	'notice.syncFailed': 'Diff Sync failed: {message}',
	'notice.noLog': 'No log entries yet',
	'notice.chunkCacheCleared': 'Local chunk cache cleared',
	'notice.chunkCacheClearedDetailed':
		'Local chunk cache cleared; chunks will be uploaded again on demand during the next sync',
	'notice.historyCleared': 'History snapshots cleared',
	'notice.stateReset': 'Local sync state reset',
	'notice.summary.line1':
		'↑{uploaded} file{uploadedPlural} / {uploadedBytes}, ↓{downloaded} file{downloadedPlural} / {downloadedBytes}',
	'notice.summary.saved':
		'Differential transfer saved {saved} ({percent}%, full transfer would be {naive})',
	'notice.summary.conflicts': '{count} conflict{plural} saved as copies:\n{paths}',
	'notice.summary.errors': 'Errors: {errors}',

	// ------------------------------------------------------------ sync log
	'log.cancelRequested': 'Sync cancellation requested',
	'log.syncStarted': 'Sync started',
	'log.syncStartedWith': 'Sync started ({trigger})',
	'log.syncFinished': 'Sync finished in {duration}',
	'log.conflictCopies': 'Conflict copies: {paths}',
	'log.gcRemoved': 'Removed {count} unreferenced chunk{plural}',
	'log.noChanges': 'No changes ({count} file{plural} up to date)',

	// ------------------------------------------------------------- triggers
	'trigger.startup': 'startup',
	'trigger.interval': 'scheduled sync',
	'trigger.fileChange': 'file change',

	// --------------------------------------------------- connect & encryption
	'connect.metaUnreadable': 'Could not read the remote meta.json',
	'connect.encryptionMetaMissing': 'Remote encryption metadata is missing',
	'connect.cancelledPassphraseRequired':
		'Cancelled: a passphrase is required to access the encrypted remote',
	'encryption.setTitle': 'Set an end-to-end encryption passphrase',
	'encryption.setDescription':
		'The passphrase is only used to derive a local key and is never uploaded. If it is lost, the remote backup cannot be recovered.',
	'encryption.enterTitle': 'Enter the end-to-end encryption passphrase',
	'encryption.enterDescription': 'The passphrase is kept in memory for this session only.',
	'encryption.cancelledNotSet': 'Cancelled: no encryption passphrase was set',
	'encryption.passphrase': 'Passphrase',
	'encryption.confirmPassphrase': 'Confirm passphrase',
	'encryption.error.empty': 'Enter a passphrase',
	'encryption.error.mismatch': 'The two entries do not match',
	'encryption.error.tooShort': 'The passphrase must be at least 8 characters',

	// ------------------------------------------------------- connection test
	'connection.ok': 'Connected; read and write work',
	'connection.okDegraded':
		'Connected, but the server does not implement conditional writes; concurrency protection is degraded',
	'connection.writeFailed': 'Failed to write the test file',
	'connection.readMismatch': 'The test file read back with different content',
	'connection.success': 'Diff Sync: {message}',
	'connection.failed': 'Diff Sync connection failed: {message}',

	// ---------------------------------------------------------------- errors
	'error.cannotConnect': 'Cannot reach the server: {message}',
	'error.vaultMismatch':
		'Remote and local belong to different vaults (remote {remote} / local {local}). Use a different remote folder, or reset the local sync state and start over.',
	'error.indexDecryptFailed':
		'Failed to decrypt the remote index: the passphrase does not match the remote encryption configuration',
	'error.indexFormat':
		'Unrecognized remote index format (possibly created by a newer plugin version)',
	'error.indexVaultIdMismatch':
		'The remote index vault id does not match meta.json; the remote folder is corrupt',
	'error.chunkUploadFailed': 'Failed to upload chunk {id}',
	'error.authFailed':
		'WebDAV authentication failed; check the username and password (Jianguoyun requires an app password)',
	'error.mkcolParentMissing': 'MKCOL {url} -> 409 (parent folder missing)',
	'error.collectionOutsideBase': 'Folder {url} is outside the server URL {base}',
	'error.invalidBaseUrl': 'The server URL must start with http:// or https://: {input}',
	'error.requestFailed': '{method} {url} failed: {detail}',
	'error.ciphertextLength': 'Unexpected ciphertext length',
	'error.wrongPassphrase': 'Decryption failed: wrong passphrase',
	'error.invalidChunkId': 'Invalid chunk id: {id}',

	// ---------------------------------------------------------------- engine
	'engine.warn.skipUnsafePath': 'Skipped unsafe path: {path}',
	'engine.warn.ignoreUnsafePath': 'Ignored unsafe path: {path}',
	'reason.localAdded': 'added locally',
	'reason.remoteAdded': 'added remotely',
	'reason.localDeletedRemoteChanged': 'deleted locally, modified remotely',
	'reason.remoteDeletedLocalChanged': 'deleted remotely, modified locally',
	'reason.localModified': 'modified locally',
	'reason.remoteModified': 'modified remotely',
	'engine.warn.localDeletedRemoteChanged':
		'{path}: deleted locally but modified remotely; local file restored',
	'engine.warn.remoteDeletedLocalChanged':
		'{path}: deleted remotely but modified locally; uploaded again',
	'engine.error.missingChunkRemote':
		'Remote chunk {id} is missing (the remote store may have been modified externally)',
	'engine.error.chunkCorruptRemote':
		'Chunk {id} failed verification (remote corruption or a different encryption passphrase)',
	'engine.error.chunkMissing': 'Missing chunk {id}',
	'engine.error.chunkCorrupt': 'Chunk {id} failed verification',
	'engine.error.sizeMismatch': 'File size mismatch: {actual} != {expected}',
	'engine.warn.snapshotFailed': '{path}: history snapshot failed ({error})',
	'engine.error.fileGone': 'File disappeared: {path}',
	'engine.log.conflictCopy': 'Conflict: the other version of {path} was saved as {copy}',
	'engine.phase.plan': 'Comparing local and remote',
	'engine.log.plan':
		'Plan: upload {upload}, download {download}, delete {delete}, conflicts {conflicts}',
	'engine.error.massDelete':
		'This sync would delete {count} files (more than 25%) and was aborted to avoid accidental data loss. If this is intended, temporarily enable "Allow mass deletion" in settings.',
	'engine.log.deleteLocal': 'Deleted locally {path}',
	'engine.progress.preparingDownload': 'Preparing downloads',
	'engine.log.download': 'Downloaded {path} ({reason})',
	'engine.log.conflictKeepLocal': '{path}: conflict; kept the local version',
	'engine.log.conflictTakeRemote': '{path}: conflict; took the newer remote version',
	'engine.error.uploadFailed': 'Upload failed {path}: {error}',
	'engine.log.deleteRemote': 'Deleted remotely {path}',
	'engine.log.untracked': 'No longer syncing excluded path {path}',
	'engine.phase.finalize': 'Writing remote index',
	'engine.phase.gc': 'Cleaning up unused chunks',
	'engine.warn.gcFailed': 'Chunk cleanup failed: {error}',
	'engine.log.indexOverwritten':
		'Remote index write was overwritten concurrently; merging again',
	'engine.log.indexConflictRetry': 'Remote index write conflict; retrying',
	'engine.error.indexConflictTooMany':
		'Too many remote index write conflicts; try again later',

	// --------------------------------------------------------------- panel
	'panel.heading': 'Differential sync',
	'panel.syncing': 'Syncing…',
	'panel.syncingTooltip': 'Sync in progress',
	'panel.syncTooltip': 'Start a sync now',
	'panel.notConfiguredHint':
		'WebDAV is not configured yet: open Settings → Diff Sync (WebDAV) and enter the server URL and password.',
	'panel.settings': 'Settings',
	'panel.log': 'Log',
	'panel.noHistory': 'No sync history yet',
	'panel.label.upload': 'Uploaded',
	'panel.label.download': 'Downloaded',
	'panel.label.delete': 'Deleted',
	'panel.label.conflict': 'Conflicts',
	'panel.label.duration': 'Duration',
	'panel.label.saved': 'Saved by diff',
	'panel.value.files': '{count} file{plural} · {size}',
	'panel.value.count': '{count} file{plural}',
	'panel.value.saved': '{size} ({percent}%)',
	'panel.conflicts': 'Conflict copies',
	'panel.errors': 'Errors',
	'panel.phase.scan': 'Scanning local files',
	'panel.phase.plan': 'Comparing local and remote',
	'panel.phase.download': 'Downloading changed chunks',
	'panel.phase.upload': 'Uploading changed chunks',
	'panel.phase.finalize': 'Writing remote index',
	'panel.phase.gc': 'Cleaning up unused chunks',

	// ------------------------------------------------------------- settings
	'settings.group.security': 'Security',
	'settings.group.schedule': 'Sync schedule',
	'settings.group.scope': 'Sync scope',
	'settings.group.advanced': 'Advanced',
	'settings.group.maintenance': 'Maintenance',
	'settings.serverUrl': 'Server URL',
	'settings.serverUrl.desc': 'Enter the full WebDAV URL, including the target folder.',
	'settings.username': 'Username',
	'settings.password': 'Password / app password',
	'settings.password.desc': 'Services such as Jianguoyun require an app password.',
	'settings.remoteDir': 'Remote subfolder',
	'settings.remoteDir.desc': 'Every device must use the same remote subfolder.',
	'settings.test': 'Test connection',
	'settings.test.desc':
		'Creates and deletes a temporary file to verify read, write, and conditional-write support.',
	'settings.test.running': 'Testing…',
	'settings.encryption': 'End-to-end encryption',
	'settings.encryption.desc':
		'Encryption is determined by the remote meta.json. Clear the remote folder before switching it.',
	'settings.encryptionPassphrase': 'Encryption passphrase',
	'settings.encryptionPassphrase.desc':
		'The passphrase is not saved to disk or the remote. If you forget it, the remote data cannot be recovered.',
	'settings.autoSyncOnStart': 'Sync on startup',
	'settings.interval': 'Scheduled sync interval',
	'settings.interval.desc': 'In minutes; 0 disables it.',
	'settings.syncOnFileChange': 'Sync after file changes',
	'settings.syncOnFileChange.desc':
		'Every edit triggers a scan; large vaults may see extra load.',
	'settings.changeDelay': 'Change merge delay (seconds)',
	'settings.changeDelay.desc': 'How long to wait after the last edit before syncing.',
	'settings.deviceName': 'Device name',
	'settings.deviceName.desc':
		'Used to name conflict copies so devices do not produce identical filenames.',
	'settings.excludePatterns': 'Exclude patterns',
	'settings.excludePatterns.desc': 'One glob per line; ** matches any depth.',
	'settings.restoreExcludes': 'Restore default exclusions',
	'settings.restore': 'Restore',
	'settings.conflictStrategy': 'Conflict overwrite policy',
	'settings.conflictStrategy.desc':
		'Decides which version keeps the original filename; the other is saved as a conflict copy. When overwriting by size, equal sizes fall back to time.',
	'settings.conflictStrategy.time': 'By time',
	'settings.conflictStrategy.size': 'By size (larger wins)',
	'settings.concurrency': 'Concurrent requests',
	'settings.concurrency.desc':
		'Number of chunks downloaded or uploaded at once; Jianguoyun recommends no more than 4.',
	'settings.chunkSize': 'Average chunk size (KB)',
	'settings.chunkSize.desc':
		'Smaller chunks reduce differential transfer but increase the number of remote files. Existing files are re-chunked after a change.',
	'settings.allowMassDelete': 'Allow mass deletion',
	'settings.allowMassDelete.desc':
		'When off, a large deletion aborts the sync to prevent local data loss from a corrupted remote index.',
	'settings.keepHistory': 'Keep local history snapshots',
	'settings.keepHistory.desc':
		'Before a download overwrites a local file, save the old version to .diff-sync-history/.',
	'settings.historyLimit': 'Snapshots to keep',
	'settings.showStatusBar': 'Show in status bar',
	'settings.showPanelOnStart': 'Open sync panel on startup',
	'settings.verboseLogging': 'Verbose logging',
	'settings.verboseLogging.desc': "Show routine sync events in the plugin's sync log.",
	'settings.localCache': 'Local chunk cache',
	'settings.localCache.desc': 'Calculate the cache file count and size on demand.',
	'settings.cache.viewUsage': 'View usage',
	'settings.cache.clear': 'Clear cache',
	'settings.cache.counting': 'Counting cache…',
	'settings.cache.usage': '{count} chunk{plural} using {size}',
	'settings.cache.unreadable': 'Could not read cache information',
	'settings.syncStatus': 'Sync status',
	'settings.lastSync': 'Last sync',
	'settings.lastSync.movement':
		'Uploaded {uploaded} / downloaded {downloaded} / deleted {deleted} / conflicts {conflicts}',
	'settings.lastSync.transfer':
		'Transferred {total}; full transfer would be {naive}; removed {gc} chunks',
	'settings.lastSync.errors': 'Errors: {errors}',
	'settings.reset': 'Reset local sync state',
	'settings.reset.desc':
		'Deletes the local merge base; the next sync behaves like a first sync and will not delete notes.',
	'settings.reset.button': 'Reset',
	'settings.reset.confirm': 'Reset local sync state?',
} as const;

export type MessageKey = keyof typeof EN;

const ZH: Record<MessageKey, string> = {
	'common.cancel': '取消',
	'common.confirm': '确定',
	'common.test': '测试',

	'command.syncNow': '立即同步',
	'command.fullRescan': '完整重新扫描并同步',
	'command.cancelSync': '取消当前同步',
	'command.showLog': '显示同步日志',
	'command.clearChunkCache': '清空本地分块缓存',
	'command.clearHistory': '清空本地历史快照',
	'command.openPanel': '打开同步面板',
	'ribbon.syncNow': 'Diff Sync：立即同步',

	'status.pending': '待同步',
	'status.preparing': '准备中…',
	'status.failed': '同步失败',
	'status.upToDate': '已是最新',
	'status.barTooltip': 'Diff Sync — 点击立即同步',
	'progress.scan': '扫描本地',
	'progress.plan': '比较差异',
	'progress.download': '下载差异',
	'progress.upload': '上传差异',
	'progress.finalize': '写入索引',
	'progress.gc': '清理分块',

	'notice.alreadySyncing': '同步已在进行中',
	'notice.notConfigured': '请先在设置中填写 WebDAV 服务器地址',
	'notice.syncFailed': 'Diff Sync 失败：{message}',
	'notice.noLog': '暂无日志',
	'notice.chunkCacheCleared': '已清空本地分块缓存',
	'notice.chunkCacheClearedDetailed': '已清空本地分块缓存；下次同步会按需重新上传分块',
	'notice.historyCleared': '已清空历史快照',
	'notice.stateReset': '已重置本地同步状态',
	'notice.summary.line1':
		'↑{uploaded} 文件 / {uploadedBytes}，↓{downloaded} 文件 / {downloadedBytes}',
	'notice.summary.saved': '差分传输节省 {saved}（{percent}%，全量需 {naive}）',
	'notice.summary.conflicts': '{count} 个冲突已另存为副本：\n{paths}',
	'notice.summary.errors': '错误：{errors}',

	'log.cancelRequested': '已请求取消同步',
	'log.syncStarted': '开始同步',
	'log.syncStartedWith': '开始同步（{trigger}）',
	'log.syncFinished': '同步结束，用时 {duration}',
	'log.conflictCopies': '冲突副本：{paths}',
	'log.gcRemoved': '清理了 {count} 个无用分块',
	'log.noChanges': '无变化（{count} 个文件已是最新）',

	'trigger.startup': '启动',
	'trigger.interval': '定时同步',
	'trigger.fileChange': '文件变更',

	'connect.metaUnreadable': '无法读取远端 meta.json',
	'connect.encryptionMetaMissing': '远端加密元数据缺失',
	'connect.cancelledPassphraseRequired': '已取消：需要口令才能访问加密的远端',
	'encryption.setTitle': '设置端到端加密口令',
	'encryption.setDescription': '口令只用于派生本地密钥，绝不上传。口令遗失将无法恢复远端备份。',
	'encryption.enterTitle': '输入端到端加密口令',
	'encryption.enterDescription': '口令仅保存在本次会话的内存中。',
	'encryption.cancelledNotSet': '已取消：未设置加密口令',
	'encryption.passphrase': '口令',
	'encryption.confirmPassphrase': '确认口令',
	'encryption.error.empty': '请输入口令',
	'encryption.error.mismatch': '两次输入不一致',
	'encryption.error.tooShort': '口令至少 8 个字符',

	'connection.ok': '连接成功，读写正常',
	'connection.okDegraded': '连接成功（服务器未实现条件写入，并发保护已降级）',
	'connection.writeFailed': '写入测试文件失败',
	'connection.readMismatch': '读取测试文件内容不一致',
	'connection.success': 'Diff Sync：{message}',
	'connection.failed': 'Diff Sync 连接失败：{message}',

	'error.cannotConnect': '无法连接服务器：{message}',
	'error.vaultMismatch':
		'远端与本地属于不同的库（远端 {remote} / 本地 {local}）。' +
		'请换一个远端目录，或清空本地同步状态重新开始。',
	'error.indexDecryptFailed': '远端索引解密失败：口令与远端加密配置不匹配',
	'error.indexFormat': '远端索引格式无法识别（可能来自更新版本的插件）',
	'error.indexVaultIdMismatch': '远端索引与 meta.json 的库标识不一致，远端目录已损坏',
	'error.chunkUploadFailed': '上传分块失败: {id}',
	'error.authFailed': 'WebDAV 认证失败，请检查用户名与密码（坚果云需使用“应用密码”）',
	'error.mkcolParentMissing': 'MKCOL {url} -> 409（父目录不存在）',
	'error.collectionOutsideBase': '目录 {url} 不在服务器地址 {base} 之内',
	'error.invalidBaseUrl': '服务器地址必须以 http:// 或 https:// 开头: {input}',
	'error.requestFailed': '{method} {url} 失败: {detail}',
	'error.ciphertextLength': '密文长度异常',
	'error.wrongPassphrase': '解密失败：口令错误',
	'error.invalidChunkId': '非法分块 id: {id}',

	'engine.warn.skipUnsafePath': '跳过非法路径: {path}',
	'engine.warn.ignoreUnsafePath': '忽略非法路径: {path}',
	'reason.localAdded': '本地新增',
	'reason.remoteAdded': '远端新增',
	'reason.localDeletedRemoteChanged': '本地删除但远端已修改',
	'reason.remoteDeletedLocalChanged': '远端删除但本地已修改',
	'reason.localModified': '本地修改',
	'reason.remoteModified': '远端修改',
	'engine.warn.localDeletedRemoteChanged': '{path}: 本地已删除但远端有修改，已恢复本地文件',
	'engine.warn.remoteDeletedLocalChanged': '{path}: 远端已删除但本地有修改，已重新上传',
	'engine.error.missingChunkRemote': '远端缺少分块 {id}（远端仓库可能被外部修改）',
	'engine.error.chunkCorruptRemote': '分块 {id} 校验失败（远端损坏或加密口令不一致）',
	'engine.error.chunkMissing': '缺少分块 {id}',
	'engine.error.chunkCorrupt': '分块 {id} 校验失败',
	'engine.error.sizeMismatch': '文件大小不符: {actual} != {expected}',
	'engine.warn.snapshotFailed': '{path}: 历史快照失败 ({error})',
	'engine.error.fileGone': '文件已消失: {path}',
	'engine.log.conflictCopy': '冲突：{path} 的另一版本已保存为 {copy}',
	'engine.phase.plan': '比较本地与远端',
	'engine.log.plan': '计划：上传 {upload}，下载 {download}，删除 {delete}，冲突 {conflicts}',
	'engine.error.massDelete':
		'本次将删除 {count} 个文件（超过 25%），已中止以避免误删。' +
		'确认无误后可在设置中临时开启“允许批量删除”。',
	'engine.log.deleteLocal': '删除本地 {path}',
	'engine.progress.preparingDownload': '准备下载',
	'engine.log.download': '下载 {path}（{reason}）',
	'engine.log.conflictKeepLocal': '{path}: 冲突，保留本地版本',
	'engine.log.conflictTakeRemote': '{path}: 冲突，采用远端较新版本',
	'engine.error.uploadFailed': '上传失败 {path}: {error}',
	'engine.log.deleteRemote': '删除远端 {path}',
	'engine.log.untracked': '不再同步已排除的路径 {path}',
	'engine.phase.finalize': '写入远端索引',
	'engine.phase.gc': '清理无用分块',
	'engine.warn.gcFailed': '清理分块失败: {error}',
	'engine.log.indexOverwritten': '远端索引写入被并发覆盖，正在重新合并',
	'engine.log.indexConflictRetry': '远端索引写入冲突，正在重试',
	'engine.error.indexConflictTooMany': '远端索引写入冲突次数过多，请稍后重试',

	'panel.heading': '差分同步',
	'panel.syncing': '同步中…',
	'panel.syncingTooltip': '正在同步',
	'panel.syncTooltip': '立即开始一次同步',
	'panel.notConfiguredHint':
		'尚未配置 WebDAV：打开设置 → Diff Sync (WebDAV) 填写服务器地址与密码。',
	'panel.settings': '设置',
	'panel.log': '日志',
	'panel.noHistory': '尚无同步记录',
	'panel.label.upload': '上传',
	'panel.label.download': '下载',
	'panel.label.delete': '删除',
	'panel.label.conflict': '冲突',
	'panel.label.duration': '耗时',
	'panel.label.saved': '差分节省',
	'panel.value.files': '{count} 个 · {size}',
	'panel.value.count': '{count} 个',
	'panel.value.saved': '{size}（{percent}%）',
	'panel.conflicts': '冲突副本',
	'panel.errors': '错误',
	'panel.phase.scan': '扫描本地文件',
	'panel.phase.plan': '比较本地与远端',
	'panel.phase.download': '下载差异分块',
	'panel.phase.upload': '上传差异分块',
	'panel.phase.finalize': '写入远端索引',
	'panel.phase.gc': '清理无用分块',

	'settings.group.security': '安全',
	'settings.group.schedule': '同步时机',
	'settings.group.scope': '同步范围',
	'settings.group.advanced': '高级',
	'settings.group.maintenance': '维护',
	'settings.serverUrl': '服务器地址',
	'settings.serverUrl.desc': '填入包含目标目录的完整 WebDAV URL。',
	'settings.username': '用户名',
	'settings.password': '密码 / 应用密码',
	'settings.password.desc': '坚果云等服务要求使用应用密码。',
	'settings.remoteDir': '远端子目录',
	'settings.remoteDir.desc': '多台设备必须填写相同的远端子目录。',
	'settings.test': '测试连接',
	'settings.test.desc': '创建并删除临时文件以验证服务器的读写与条件写入能力。',
	'settings.test.running': '测试中…',
	'settings.encryption': '端到端加密',
	'settings.encryption.desc': '加密状态由远端 meta.json 决定，切换前需要清空远端目录。',
	'settings.encryptionPassphrase': '加密口令',
	'settings.encryptionPassphrase.desc': '口令不会保存到磁盘或远端。忘记口令意味着远端数据无法恢复。',
	'settings.autoSyncOnStart': '启动时自动同步',
	'settings.interval': '定时同步间隔',
	'settings.interval.desc': '单位分钟，0 表示关闭。',
	'settings.syncOnFileChange': '文件变更后自动同步',
	'settings.syncOnFileChange.desc': '每次编辑都会触发扫描，大库开启后可能增加负载。',
	'settings.changeDelay': '变更合并延迟（秒）',
	'settings.changeDelay.desc': '最后一次编辑后等待多久再同步。',
	'settings.deviceName': '设备名称',
	'settings.deviceName.desc': '用于命名冲突副本，避免设备之间生成同名文件。',
	'settings.excludePatterns': '排除规则',
	'settings.excludePatterns.desc': '一行一个 glob，支持 ** 匹配多级目录。',
	'settings.restoreExcludes': '恢复默认排除规则',
	'settings.restore': '恢复',
	'settings.conflictStrategy': '冲突覆盖策略',
	'settings.conflictStrategy.desc':
		'决定哪个版本沿用原文件名，另一份会保存为冲突副本。按大小覆盖时，同样大小按时间判断。',
	'settings.conflictStrategy.time': '按时间覆盖',
	'settings.conflictStrategy.size': '按大小覆盖（较大优先）',
	'settings.concurrency': '并发请求数',
	'settings.concurrency.desc': '同时下载或上传的分块数，坚果云建议不超过 4。',
	'settings.chunkSize': '平均分块大小 (KB)',
	'settings.chunkSize.desc':
		'较小的块可减少差分传输量，但会增加远端文件数。修改后已有文件会重新分块。',
	'settings.allowMassDelete': '允许批量删除',
	'settings.allowMassDelete.desc':
		'关闭时，大批量删除会中止同步，防止远端索引异常导致本地数据丢失。',
	'settings.keepHistory': '保留本地历史快照',
	'settings.keepHistory.desc': '下载覆盖本地文件前，将旧版本保存到 .diff-sync-history/。',
	'settings.historyLimit': '保留快照数量',
	'settings.showStatusBar': '状态栏显示',
	'settings.showPanelOnStart': '启动时打开同步面板',
	'settings.verboseLogging': '详细日志',
	'settings.verboseLogging.desc': '在插件的同步日志中显示常规同步事件。',
	'settings.localCache': '本地分块缓存',
	'settings.localCache.desc': '按需统计缓存文件的数量和大小。',
	'settings.cache.viewUsage': '查看用量',
	'settings.cache.clear': '清空缓存',
	'settings.cache.counting': '正在统计缓存…',
	'settings.cache.usage': '{count} 个分块，占用 {size}',
	'settings.cache.unreadable': '无法读取缓存信息',
	'settings.syncStatus': '同步状态',
	'settings.lastSync': '上次同步',
	'settings.lastSync.movement': '上传 {uploaded} / 下载 {downloaded} / 删除 {deleted} / 冲突 {conflicts}',
	'settings.lastSync.transfer': '传输 {total}，全量需 {naive}，清理 {gc} 个分块',
	'settings.lastSync.errors': '错误：{errors}',
	'settings.reset': '重置本地同步状态',
	'settings.reset.desc': '删除本地合并基线，下次同步会当作首次同步，不会删除笔记。',
	'settings.reset.button': '重置',
	'settings.reset.confirm': '重置本地同步状态？',
};

let currentLocale: Locale = 'en';

export function getLocale(): Locale {
	return currentLocale;
}

export function setLocale(locale: Locale): void {
	currentLocale = locale;
}

/** Map an Obsidian/BCP-47 language tag to a supported locale. */
export function localeFromLanguageTag(tag: string | null | undefined): Locale {
	return tag && tag.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** English plural suffix for a count; Chinese templates ignore it. */
export function pluralSuffix(count: number): string {
	return count === 1 ? '' : 's';
}

export function t(key: MessageKey, params?: MessageParams): string {
	const template = currentLocale === 'zh' ? ZH[key] : EN[key];
	if (!params) return template;
	const values: MessageParams =
		params.count !== undefined && params.plural === undefined
			? { ...params, plural: pluralSuffix(Number(params.count)) }
			: params;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in values ? String(values[name]) : match,
	);
}
