import browser from '../utils/browser-polyfill';

declare const LIVESYNC_ENABLED: boolean;
export const liveSyncEnabled = LIVESYNC_ENABLED;

export type LiveSyncErrorCode =
	| 'liveSyncInvalidSetup'
	| 'liveSyncUnsupportedRemote'
	| 'liveSyncInvalidServer'
	| 'liveSyncConnectionFailed'
	| 'liveSyncDatabaseNotReady'
	| 'liveSyncDestinationChanged'
	| 'liveSyncInvalidPath'
	| 'liveSyncPathExists'
	| 'liveSyncSaveFailed'
	| 'liveSyncServiceUnavailable';

export class LiveSyncError extends Error {
	constructor(readonly code: LiveSyncErrorCode) {
		super(code);
	}
}

export interface LiveSyncDestination {
	id: string;
	label: string;
}

export type LiveSyncRequest =
	| { action: 'liveSyncStatus' }
	| { action: 'liveSyncConnect'; uri: string; passphrase: string }
	| { action: 'liveSyncDisconnect' }
	| { action: 'liveSyncSave'; destinationId: string; clipId: string; folder: string; title: string; markdown: string };

export type LiveSyncResult =
	| { ok: true; destination?: LiveSyncDestination; path?: string }
	| { ok: false; error: LiveSyncErrorCode };

export async function requestLiveSync(request: LiveSyncRequest) {
	let result: LiveSyncResult;
	try {
		result = await browser.runtime.sendMessage(request) as LiveSyncResult;
	} catch {
		throw new LiveSyncError('liveSyncServiceUnavailable');
	}
	if (!result) throw new LiveSyncError('liveSyncServiceUnavailable');
	if (!result.ok) throw new LiveSyncError(result.error);
	return result;
}
