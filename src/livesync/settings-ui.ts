import { getMessage } from '../utils/i18n';
import browser from '../utils/browser-polyfill';
import { LiveSyncError, requestLiveSync, type LiveSyncDestination } from './messages';
import { dailyNotePath, dailyNoteSettingsKey, defaultDailyNote } from './note-path';

async function initializeDailyNoteSettings() {
	const form = document.querySelector<HTMLFormElement>('#livesync-daily-form')!;
	const folder = form.querySelector<HTMLInputElement>('#livesync-daily-folder')!;
	const format = form.querySelector<HTMLInputElement>('#livesync-daily-format')!;
	const status = form.querySelector<HTMLElement>('#livesync-daily-status')!;
	const stored = await browser.storage.local.get(dailyNoteSettingsKey) as {
		[dailyNoteSettingsKey]?: typeof defaultDailyNote;
	};
	({ folder: folder.value, format: format.value } = stored[dailyNoteSettingsKey] ?? defaultDailyNote);
	form.addEventListener('submit', async event => {
		event.preventDefault();
		try {
			const settings = { folder: folder.value.trim(), format: format.value.trim() };
			const example = dailyNotePath(settings, new Date());
			await browser.storage.local.set({ [dailyNoteSettingsKey]: settings });
			status.textContent = getMessage('liveSyncDailySaved', example);
		} catch (error) {
			status.textContent = getMessage(error instanceof LiveSyncError ? error.code : 'liveSyncServiceUnavailable');
		}
	});
}

export async function initializeLiveSyncSettings() {
	const form = document.querySelector<HTMLFormElement>('#livesync-form')!;
	const uri = form.querySelector<HTMLInputElement>('#livesync-uri')!;
	const passphrase = form.querySelector<HTMLInputElement>('#livesync-passphrase')!;
	const connect = form.querySelector<HTMLButtonElement>('#livesync-connect')!;
	const disconnect = form.querySelector<HTMLButtonElement>('#livesync-disconnect')!;
	const status = form.querySelector<HTMLElement>('#livesync-status')!;
	let destination: LiveSyncDestination | undefined;
	let requiredOrigin: string | undefined;

	function showStatus() {
		disconnect.hidden = !destination;
		connect.textContent = getMessage(requiredOrigin ? 'liveSyncAllowAccess' : 'liveSyncConnect');
		const connectionStatus = destination
			? getMessage('liveSyncConnected', destination.label)
			: getMessage('liveSyncDisconnected');
		status.textContent = requiredOrigin
			? `${connectionStatus} ${getMessage('liveSyncHostPermissionRequired', requiredOrigin.slice(0, -2))}`
			: connectionStatus;
	}

	async function update(action: () => Promise<void>) {
		connect.disabled = disconnect.disabled = true;
		status.textContent = getMessage('liveSyncWorking');
		try {
			await action();
			showStatus();
		} catch (error) {
			const message = getMessage(error instanceof LiveSyncError ? error.code : 'liveSyncServiceUnavailable');
			status.textContent = destination ? `${getMessage('liveSyncConnected', destination.label)} ${message}` : message;
		} finally {
			connect.disabled = disconnect.disabled = false;
		}
	}

	form.addEventListener('submit', event => {
		event.preventDefault();
		void update(async () => {
			if (requiredOrigin) {
				// Request permission from this user gesture before any other asynchronous work.
				const granted = await browser.permissions.request({ origins: [requiredOrigin] }).catch(() => false);
				if (!granted) throw new LiveSyncError('liveSyncHostPermissionDenied');
				requiredOrigin = undefined;
				connect.textContent = getMessage('liveSyncConnect');
			}
			try {
				const result = await requestLiveSync({ action: 'liveSyncConnect', uri: uri.value, passphrase: passphrase.value });
				requiredOrigin = result.requiredOrigin;
				if (requiredOrigin) return;
				destination = result.destination;
				uri.value = '';
			} finally {
				if (!requiredOrigin) passphrase.value = '';
			}
		});
	});
	form.addEventListener('input', () => {
		if (!requiredOrigin) return;
		requiredOrigin = undefined;
		showStatus();
	});
	disconnect.addEventListener('click', () => {
		void update(async () => {
			await requestLiveSync({ action: 'liveSyncDisconnect' });
			destination = undefined;
		});
	});
	await initializeDailyNoteSettings().catch(() => {
		const status = document.getElementById('livesync-daily-status')!;
		status.textContent = getMessage('liveSyncServiceUnavailable');
	});
	document.getElementById('livesync-settings')!.hidden = false;
	await update(async () => {
		({ destination } = await requestLiveSync({ action: 'liveSyncStatus' }));
	});
}
