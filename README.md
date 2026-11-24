# Diff Sync (WebDAV)

[简体中文文档](README.zh-CN.md)

Diff Sync (WebDAV) synchronizes an Obsidian vault across desktop devices through a WebDAV server. It splits files into content-defined chunks and transfers only the blocks missing on the receiving side. When both devices edit the same file, the plugin keeps a conflict copy so both versions remain available.

## Requirements

- Obsidian 1.13.0 or later on desktop.
- A WebDAV server you can read and write to, such as Nextcloud, ownCloud, Synology, or Nutstore.
- The same WebDAV collection URL, remote subdirectory, and encryption settings on every device that syncs the vault.

## Install and connect

1. Download `main.js`, `manifest.json`, and `styles.css` from the [GitHub release](https://github.com/sylvaire/obsidian-diff-sync/releases/latest).
2. Put the files in the `plugins/diff-sync-webdav/` folder under your vault's Obsidian configuration directory. The default location is `.obsidian/plugins/diff-sync-webdav/`.
3. Enable **Diff Sync (WebDAV)** in Obsidian's Community plugins settings.
4. Enter the full WebDAV collection URL, user name, password or app password, and remote subdirectory. Use the connection test to verify that the plugin can read and write to the server.
5. Open the sync panel and start a sync. The panel shows progress, transfer counts, conflicts, and errors. The interface follows Obsidian's language: English by default and Simplified Chinese when Obsidian is set to Chinese.

## How sync works

- The first sync to an empty remote uploads the files in scope. Subsequent syncs reuse chunks already present on the receiving side.
- In **Advanced**, the conflict policy selects which version keeps the original filename. The default uses modification time. The size policy prefers the larger file and uses modification time when sizes match. The other version is kept as a conflict copy.
- The plugin syncs in both directions, including deletions. A mass-deletion guard can stop a sync before applying a large deletion.
- The active Obsidian configuration directory and local history folder are excluded. You can add your own exclusions using glob patterns.
- Optional end-to-end encryption protects remote chunks and the file index. Keep the passphrase available on each device.
- Optional local history saves old versions before a download overwrites a file. These snapshots cover overwritten files, while the WebDAV store represents the current sync state.

## Build and test

```sh
npm ci
npm run build
npm test
```

Distributed under the [MIT license](LICENSE).
