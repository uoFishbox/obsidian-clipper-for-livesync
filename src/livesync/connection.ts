import type { DirectFileManipulatorOptions } from '@vrtmrz/livesync-commonlib';
import { activateRemoteConfiguration } from '@vrtmrz/livesync-commonlib/remote-configurations';
import { DEFAULT_SETTINGS } from '@vrtmrz/livesync-commonlib/settings';
import { decodeSettingsFromSetupURI } from '@vrtmrz/livesync-commonlib/setup-uri';
import { LiveSyncError } from './messages';

const setupUriPrefix = 'obsidian://setuplivesync?settings=';

function couchServer(value: string): string {
	try {
		const url = new URL(value);
		const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
		if (url.username || url.password || url.search || url.hash ||
			(url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
			throw new Error();
		}
		return url.href.replace(/\/+$/, '');
	} catch {
		throw new LiveSyncError('liveSyncInvalidServer');
	}
}

export async function importConnection(uri: string, passphrase: string): Promise<DirectFileManipulatorOptions> {
	const trimmedUri = uri.trim();
	if (!trimmedUri.startsWith(setupUriPrefix) || !passphrase) {
		throw new LiveSyncError('liveSyncInvalidSetup');
	}
	const decoded = await decodeSettingsFromSetupURI(trimmedUri, passphrase).catch(() => false as const);
	if (!decoded) throw new LiveSyncError('liveSyncInvalidSetup');

	const settings = { ...DEFAULT_SETTINGS, ...decoded };
	if (typeof settings.activeConfigurationId !== 'string' ||
		!Object.prototype.hasOwnProperty.call(settings.remoteConfigurations ?? {}, settings.activeConfigurationId) ||
		!activateRemoteConfiguration(settings, settings.activeConfigurationId)) {
		throw new LiveSyncError('liveSyncUnsupportedRemote');
	}
	if (settings.remoteType !== '' || settings.useJWT || settings.couchDB_CustomHeaders?.trim()) {
		throw new LiveSyncError('liveSyncUnsupportedRemote');
	}
	if (typeof settings.couchDB_DBNAME !== 'string' || !/^[a-z][a-z0-9_$()+/-]*$/.test(settings.couchDB_DBNAME) ||
		typeof settings.couchDB_USER !== 'string' || !settings.couchDB_USER ||
		typeof settings.couchDB_PASSWORD !== 'string' || !settings.couchDB_PASSWORD) {
		throw new LiveSyncError('liveSyncInvalidServer');
	}
	if ((settings.encrypt || settings.usePathObfuscation) &&
		(typeof settings.passphrase !== 'string' || !settings.passphrase)) {
		throw new LiveSyncError('liveSyncInvalidSetup');
	}

	return {
		url: couchServer(settings.couchDB_URI),
		database: settings.couchDB_DBNAME,
		username: settings.couchDB_USER,
		password: settings.couchDB_PASSWORD,
		passphrase: settings.encrypt ? settings.passphrase : undefined,
		obfuscatePassphrase: settings.usePathObfuscation ? settings.passphrase : undefined,
		idDerivationVersion: settings.idDerivationVersion,
		idDerivationKey: settings.idDerivationKey,
		pathNormalizationVersion: settings.pathNormalizationVersion,
		encryptInternalMetadata: settings.encryptInternalMetadata,
		acceptUnencryptedContent: settings.acceptUnencryptedContent,
		useDynamicIterationCount: settings.useDynamicIterationCount,
		customChunkSize: settings.customChunkSize,
		minimumChunkSize: settings.minimumChunkSize,
		hashAlg: settings.hashAlg,
		useEden: settings.useEden,
		maxChunksInEden: settings.maxChunksInEden,
		maxTotalLengthInEden: settings.maxTotalLengthInEden,
		maxAgeInEden: settings.maxAgeInEden,
		enableChunkSplitterV2: settings.enableChunkSplitterV2,
		chunkSplitterVersion: settings.chunkSplitterVersion,
		enableCompression: settings.enableCompression,
		handleFilenameCaseSensitive: settings.handleFilenameCaseSensitive,
		E2EEAlgorithm: settings.E2EEAlgorithm,
	};
}
