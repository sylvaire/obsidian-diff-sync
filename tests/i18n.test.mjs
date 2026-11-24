/**
 * The message catalog: English is the default, Chinese is selected from the
 * Obsidian language tag, and interpolation/pluralisation behave in both.
 */
import assert from 'node:assert/strict';
import { localeFromLanguageTag, pluralSuffix, setLocale, t } from './.build/core.mjs';

// --- language detection ----------------------------------------------------

assert.equal(localeFromLanguageTag('zh'), 'zh', 'zh maps to Chinese');
assert.equal(localeFromLanguageTag('zh-TW'), 'zh', 'regional Chinese maps to Chinese');
assert.equal(localeFromLanguageTag('en'), 'en', 'en maps to English');
assert.equal(localeFromLanguageTag('en-GB'), 'en', 'regional English maps to English');
assert.equal(localeFromLanguageTag('fr'), 'en', 'other languages fall back to English');
assert.equal(localeFromLanguageTag(''), 'en', 'empty tag falls back to English');
assert.equal(localeFromLanguageTag(null), 'en', 'missing tag falls back to English');

// --- English is the default ------------------------------------------------

assert.equal(t('command.syncNow'), 'Sync now', 'English is active before any locale is set');
assert.equal(t('status.pending'), 'Pending');

// --- interpolation and plurals --------------------------------------------

assert.equal(pluralSuffix(1), '');
assert.equal(pluralSuffix(0), 's');
assert.equal(pluralSuffix(2), 's');

assert.equal(
	t('notice.summary.conflicts', { count: 1, paths: 'a.md' }),
	'1 conflict saved as copies:\na.md',
);
assert.equal(
	t('notice.summary.conflicts', { count: 2, paths: 'a.md' }),
	'2 conflicts saved as copies:\na.md',
);
assert.equal(t('panel.value.files', { count: 1, size: '1 KB' }), '1 file · 1 KB');
assert.equal(t('panel.value.files', { count: 3, size: '4 KB' }), '3 files · 4 KB');
assert.equal(
	t('engine.error.massDelete', { count: 12 }),
	'This sync would delete 12 files (more than 25%) and was aborted to avoid accidental data loss. If this is intended, temporarily enable "Allow mass deletion" in settings.',
);

// --- Chinese catalog -------------------------------------------------------

setLocale('zh');
assert.equal(t('command.syncNow'), '立即同步');
assert.equal(t('status.pending'), '待同步');
assert.equal(
	t('notice.summary.conflicts', { count: 1, paths: 'a.md' }),
	'1 个冲突已另存为副本：\na.md',
	'Chinese ignores the English plural slot',
);
assert.equal(t('panel.value.files', { count: 2, size: '4 KB' }), '2 个 · 4 KB');
assert.equal(
	t('error.vaultMismatch', { remote: 'r1', local: 'l1' }),
	'远端与本地属于不同的库（远端 r1 / 本地 l1）。请换一个远端目录，或清空本地同步状态重新开始。',
);

// --- back to English -------------------------------------------------------

setLocale('en');
assert.equal(t('command.syncNow'), 'Sync now');

console.log('i18n test passed');
