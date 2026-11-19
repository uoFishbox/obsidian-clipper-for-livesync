import { expect, it } from 'vitest';
import { upsertRemoteConfigurationInPlace } from '@vrtmrz/livesync-commonlib/remote-configurations';
import { createNewVaultSettings } from '@vrtmrz/livesync-commonlib/settings';
import { encodeTimeBoundSetupURI } from '@vrtmrz/livesync-commonlib/setup-uri';
import { importConnection } from './connection';
import { liveSyncNotePath } from './note-path';

const clipId = '01234567-89ab-4def-8123-456789abcdef';
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
	expect(liveSyncNotePath('資料/記事/', '日本語.md', clipId)).toBe(`資料/記事/日本語 - ${clipId}.md`);
	expect(new TextEncoder().encode(liveSyncNotePath('', '📝'.repeat(255), clipId)).length).toBeLessThanOrEqual(255);
});

it.each(['/absolute', 'folder/../escape', 'C:/drive', 'folder/.obsidian', 'folder//nested'])(
	'rejects the invalid vault folder %s',
	folder => expect(() => liveSyncNotePath(folder, 'Clip', clipId)).toThrow('liveSyncInvalidPath'),
);
