import browser from 'webextension-polyfill';
import { openDB, type DBSchema } from 'idb';
import { DirectFileManipulator, type DirectFileManipulatorOptions } from '@vrtmrz/livesync-commonlib';
import { LiveSyncError, type LiveSyncRequest, type LiveSyncResult } from './messages';
import { importConnection } from './connection';
import { liveSyncNotePath } from './note-path';

interface SavedConnection {
	id: string;
	options: DirectFileManipulatorOptions;
}

interface ConnectionDB extends DBSchema {
	connections: { key: string; value: SavedConnection };
}

let database: ReturnType<typeof openDB<ConnectionDB>> | undefined;

function connectionDB() {
	return database ??= openDB<ConnectionDB>('clipper-livesync', 1, {
		upgrade(db) {
			db.createObjectStore('connections');
		},
	}).catch(error => {
		database = undefined;
		throw error;
	});
}

function databaseURL(options: DirectFileManipulatorOptions): string {
	return `${options.url}/${encodeURIComponent(options.database)}`;
}

function describeConnection(connection: SavedConnection) {
	return { id: connection.id, label: databaseURL(connection.options) };
}

function remoteFetch(dbURL: string): typeof fetch {
	const database = new URL(dbURL);
	return (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const isRoot = url.pathname === database.pathname || url.pathname === database.pathname + '/';
		if (url.origin !== database.origin ||
			(url.pathname !== database.pathname && !url.pathname.startsWith(database.pathname + '/'))) {
			throw new LiveSyncError('liveSyncInvalidServer');
		}
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
		if (isRoot && (method === 'PUT' || method === 'DELETE')) {
			throw new LiveSyncError('liveSyncDatabaseNotReady');
		}
		return fetch(input, {
			...init,
			redirect: 'error',
			credentials: 'omit',
			cache: 'no-store',
			signal: AbortSignal.timeout(15_000),
		});
	};
}

async function withClient<T>(options: DirectFileManipulatorOptions, use: (client: DirectFileManipulator) => Promise<T>): Promise<T> {
	const url = databaseURL(options);
	const request = remoteFetch(url);
	const userAndPassword = new TextEncoder().encode(`${options.username}:${options.password}`);
	const authorization = 'Basic ' + btoa(Array.from(userAndPassword, byte => String.fromCharCode(byte)).join(''));
	// The direct client can create an empty remote. Require an initialized LiveSync database first.
	const response = await request(url + '/obsydian_livesync_version', {
		headers: { Authorization: authorization },
	}).catch(() => { throw new LiveSyncError('liveSyncConnectionFailed'); });
	if (response.status === 404) throw new LiveSyncError('liveSyncDatabaseNotReady');
	if (!response.ok) throw new LiveSyncError('liveSyncConnectionFailed');
	const version = await response.json().catch(() => null);
	if (version?.type !== 'versioninfo') throw new LiveSyncError('liveSyncDatabaseNotReady');

	const client = new DirectFileManipulator({ ...options, database: encodeURIComponent(options.database) }, { fetch: request });
	try {
		await client.ready.promise.catch(() => { throw new LiveSyncError('liveSyncDatabaseNotReady'); });
		return await use(client);
	} finally {
		await client.close().catch(() => {});
	}
}

async function handleRequest(message: LiveSyncRequest): Promise<LiveSyncResult> {
	const storage = await connectionDB();
	switch (message.action) {
		case 'liveSyncStatus': {
			const connection = await storage.get('connections', 'active');
			return { ok: true, destination: connection && describeConnection(connection) };
		}
		case 'liveSyncConnect': {
			const options = await importConnection(message.uri, message.passphrase);
			await withClient(options, async () => {});
			const connection = { id: crypto.randomUUID(), options };
			await storage.put('connections', connection, 'active');
			return { ok: true, destination: describeConnection(connection) };
		}
		case 'liveSyncDisconnect':
			await storage.delete('connections', 'active');
			return { ok: true };
		case 'liveSyncSave': {
			const connection = await storage.get('connections', 'active');
			if (!connection || message.destinationId !== connection.id) {
				throw new LiveSyncError('liveSyncDestinationChanged');
			}
			const path = liveSyncNotePath(message.folder, message.title, message.clipId);
			await withClient(connection.options, async client => {
				const notePath = path as Parameters<DirectFileManipulator['get']>[0];
				const noteId = await client.path2id(notePath);
				// Retrying a save with an unknown outcome must preserve its path and any existing revision.
				const existing = await client.rawGet(noteId);
				if (existing) {
					const note = await client.get(notePath);
					if (note && 'data' in note &&
						(typeof note.data === 'string' ? note.data : note.data.join('')) === message.markdown) return;
					throw new LiveSyncError('liveSyncPathExists');
				}
				const body = new Blob([message.markdown], { type: 'text/plain' });
				const now = Date.now();
				if (!await client.put(path, body, { ctime: now, mtime: now, size: body.size })) {
					throw new LiveSyncError('liveSyncSaveFailed');
				}
			});
			return { ok: true, path };
		}
	}
}

browser.runtime.onMessage.addListener((request: unknown, sender, respond) => {
	if (!request || typeof request !== 'object' || sender.id !== browser.runtime.id) return;
	const message = request as LiveSyncRequest;
	const page = sender.url?.split(/[?#]/, 1)[0];
	const settings = page === browser.runtime.getURL('settings.html');
	const clipper = page === browser.runtime.getURL('popup.html') || page === browser.runtime.getURL('side-panel.html');
	switch (message.action) {
		case 'liveSyncStatus':
			if (!settings && !clipper) return;
			break;
		case 'liveSyncConnect':
			if (!settings || typeof message.uri !== 'string' || typeof message.passphrase !== 'string') return;
			break;
		case 'liveSyncDisconnect':
			if (!settings) return;
			break;
		case 'liveSyncSave':
			if (!clipper || typeof message.destinationId !== 'string' || typeof message.clipId !== 'string' ||
				typeof message.title !== 'string' || typeof message.folder !== 'string' || typeof message.markdown !== 'string') return;
			break;
		default:
			return;
	}
	handleRequest(message).then(respond).catch(error => {
		const fallback = message.action === 'liveSyncSave' ? 'liveSyncSaveFailed' : 'liveSyncServiceUnavailable';
		respond({ ok: false, error: error instanceof LiveSyncError ? error.code : fallback } satisfies LiveSyncResult);
	});
	return true;
});
