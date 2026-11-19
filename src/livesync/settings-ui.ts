import { getMessage } from '../utils/i18n';
import { LiveSyncError, liveSyncEnabled, requestLiveSync, type LiveSyncDestination } from './messages';

export async function initializeLiveSyncSettings() {
	if (!liveSyncEnabled) return;
	const form = document.querySelector<HTMLFormElement>('#livesync-form')!;
	const uri = form.querySelector<HTMLInputElement>('#livesync-uri')!;
	const passphrase = form.querySelector<HTMLInputElement>('#livesync-passphrase')!;
	const connect = form.querySelector<HTMLButtonElement>('#livesync-connect')!;
	const disconnect = form.querySelector<HTMLButtonElement>('#livesync-disconnect')!;
	const status = form.querySelector<HTMLElement>('#livesync-status')!;
	let destination: LiveSyncDestination | undefined;

	function showStatus() {
		disconnect.hidden = !destination;
		status.textContent = destination
			? getMessage('liveSyncConnected', destination.label)
			: getMessage('liveSyncDisconnected');
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
			try {
				({ destination } = await requestLiveSync({ action: 'liveSyncConnect', uri: uri.value, passphrase: passphrase.value }));
				uri.value = '';
			} finally {
				passphrase.value = '';
			}
		});
	});
	disconnect.addEventListener('click', () => {
		void update(async () => {
			await requestLiveSync({ action: 'liveSyncDisconnect' });
			destination = undefined;
		});
	});
	form.hidden = false;
	await update(async () => {
		({ destination } = await requestLiveSync({ action: 'liveSyncStatus' }));
	});
}
