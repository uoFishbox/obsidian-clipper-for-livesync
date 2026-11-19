import { expect, it } from 'vitest';
import { upsertRemoteConfigurationInPlace } from '@vrtmrz/livesync-commonlib/remote-configurations';
import { createNewVaultSettings } from '@vrtmrz/livesync-commonlib/settings';
import { encodeTimeBoundSetupURI } from '@vrtmrz/livesync-commonlib/setup-uri';
import { importConnection } from './connection';
import { dailyNotePath, defaultDailyNote, liveSyncNotePath } from './note-path';
import { renderLiveSyncNote } from './note-content';

const setupPassphrase = 'test setup passphrase';

async function setupUri(server = 'https://sync.example.test/couchdb') {
	const settings = createNewVaultSettings();
	Object.assign(settings, {
		couchDB_URI: server,
		couchDB_DBNAME: 'vault',
		couchDB_USER: 'clipper',
		couchDB_PASSWORD: 'test password',
		encrypt: true,
		passphrase: 'test vault passphrase',
		usePathObfuscation: true,
		idDerivationVersion: 1,
		idDerivationKey: 'ab'.repeat(32),
		pathNormalizationVersion: 1,
		encryptInternalMetadata: true,
	});
	upsertRemoteConfigurationInPlace(settings, 'couchdb', { activate: true });
	return (await encodeTimeBoundSetupURI(settings, setupPassphrase, { mode: 'ephemeral' })).uri;
}

it('imports the active CouchDB profile and encrypted path settings from a generated Setup URI', async () => {
	const uri = await setupUri();
	await expect(importConnection(uri, setupPassphrase)).resolves.toMatchObject({
		url: 'https://sync.example.test/couchdb',
		database: 'vault',
		username: 'clipper',
		password: 'test password',
		passphrase: 'test vault passphrase',
		obfuscatePassphrase: 'test vault passphrase',
		idDerivationVersion: 1,
		idDerivationKey: 'ab'.repeat(32),
		pathNormalizationVersion: 1,
		encryptInternalMetadata: true,
	});
	await expect(importConnection(uri, 'wrong')).rejects.toMatchObject({ code: 'liveSyncInvalidSetup' });
});

it('rejects a remote over cleartext HTTP', async () => {
	const uri = await setupUri('http://sync.example.test');
	await expect(importConnection(uri, setupPassphrase)).rejects.toMatchObject({ code: 'liveSyncInvalidServer' });
});

it('uses a stable, vault-relative path with a byte limit for Unicode names', () => {
	expect(liveSyncNotePath('資料/記事/', '日本語.md')).toBe('資料/記事/日本語.md');
	expect(liveSyncNotePath('資料/記事/', '日本語', 2)).toBe('資料/記事/日本語 (2).md');
	expect(new TextEncoder().encode(liveSyncNotePath('', '📝'.repeat(255), 2)).length).toBeLessThanOrEqual(255);
});

it.each(['/absolute', 'folder/../escape', 'C:/drive', 'folder/.obsidian', 'folder//nested'])(
	'rejects the invalid vault folder %s',
	folder => expect(() => liveSyncNotePath(folder, 'Clip')).toThrow('liveSyncInvalidPath'),
);

it('formats the daily note relative to the configured folder in local time', () => {
	const date = new Date(2026, 10, 19, 0, 30);
	expect(dailyNotePath(defaultDailyNote, date)).toBe('2026-11-19.md');
	expect(dailyNotePath({ folder: '日記/', format: 'YYYY/MM/YYYY-MM-DD' }, date)).toBe('日記/2026/11/2026-11-19.md');
	expect(() => dailyNotePath({ folder: '日記', format: '[../]YYYY-MM-DD' }, date)).toThrow('liveSyncInvalidDailyNote');
});

const clipContent = { frontmatter: '---\nsource: web\n---\n', markdown: '新しい本文' };
const existingNote = '---\r\ntags: [daily]\r\n---\r\n元の本文';

it.each(['append-specific', 'append-daily'] as const)('appends only the clip body for %s', behavior => {
	expect(renderLiveSyncNote({ ...clipContent, behavior }, existingNote)).toBe(existingNote + '\n新しい本文');
});

it.each(['prepend-specific', 'prepend-daily'] as const)('prepends below the existing frontmatter for %s', behavior => {
	expect(renderLiveSyncNote({ ...clipContent, behavior }, existingNote)).toBe('---\r\ntags: [daily]\r\n---\r\n新しい本文\n元の本文');
	expect(renderLiveSyncNote({ ...clipContent, behavior }, '元の本文')).toBe('新しい本文\n元の本文');
});

it('writes the whole clip for a new note, a missing daily note, or an overwrite', () => {
	const expected = clipContent.frontmatter + clipContent.markdown;
	expect(renderLiveSyncNote({ ...clipContent, behavior: 'create' })).toBe(expected);
	expect(renderLiveSyncNote({ ...clipContent, behavior: 'append-daily' })).toBe(expected);
	expect(renderLiveSyncNote({ ...clipContent, behavior: 'overwrite' }, existingNote)).toBe(expected);
});
