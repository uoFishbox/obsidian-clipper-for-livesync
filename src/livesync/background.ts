import browser from 'webextension-polyfill';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DirectFileManipulator, type DirectFileManipulatorOptions } from '@vrtmrz/livesync-commonlib';
import type { MetaEntry } from '@vrtmrz/livesync-commonlib/compat/common/types';
import { LiveSyncError, type LiveSyncRequest, type LiveSyncResult } from './messages';
import { importConnection } from './connection';
import { dailyNotePath, dailyNoteSettingsKey, defaultDailyNote, liveSyncNotePath } from './note-path';
import { renderLiveSyncNote } from './note-content';

interface SavedConnection {
	id: string;
	options: DirectFileManipulatorOptions;
}

interface ConnectionDB extends DBSchema {
	connections: { key: string; value: SavedConnection };
	saves: { key: string; value: SavedAttempt; indexes: { startedAt: number } };
}

type SaveRequest = Extract<LiveSyncRequest, { action: 'liveSyncSave' }>;
type NotePath = Parameters<DirectFileManipulator['get']>[0];
type NoteId = Awaited<ReturnType<DirectFileManipulator['path2id']>>;

interface SavedAttempt {
	destinationId: string;
	startedAt: number;
	path: NotePath;
	baseRevision?: string;
	expectedHash: string;
	saved?: boolean;
}

const retryWindow = 24 * 60 * 60 * 1000;
const saveBehaviors = new Set<SaveRequest['behavior']>([
	'create', 'append-specific', 'prepend-specific', 'append-daily', 'prepend-daily', 'overwrite',
]);

let database: ReturnType<typeof openDB<ConnectionDB>> | undefined;

function connectionDB() {
	return database ??= openDB<ConnectionDB>('clipper-livesync', 2, {
		upgrade(db, oldVersion) {
			if (oldVersion === 0) db.createObjectStore('connections');
			db.createObjectStore('saves').createIndex('startedAt', 'startedAt');
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

async function getNoteMeta(client: DirectFileManipulator, id: NoteId) {
	try {
		return await client.liveSyncLocalDB.getRaw<MetaEntry>(id, { conflicts: true });
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) return undefined;
		throw error;
	}
}

async function getNoteText(client: DirectFileManipulator, meta?: MetaEntry): Promise<string | undefined> {
	if (!meta || meta.deleted) return undefined;
	const note = await client.liveSyncLocalDB.readDBEntryFromMeta(meta);
	if (!note) throw new LiveSyncError('liveSyncSaveFailed');
	return typeof note.data === 'string' ? note.data : note.data.join('');
}

async function hashNote(markdown: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(markdown));
	return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

async function saveNote(client: DirectFileManipulator, storage: IDBPDatabase<ConnectionDB>, clip: SaveRequest) {
	let attempt = await storage.get('saves', clip.clipId);
	if (attempt && attempt.destinationId !== clip.destinationId) throw new LiveSyncError('liveSyncDestinationChanged');
	if (attempt?.saved) return attempt.path;

	let dailyPath: string | undefined;
	if (!attempt && clip.behavior.endsWith('-daily')) {
		const settings = await browser.storage.local.get(dailyNoteSettingsKey) as {
			[dailyNoteSettingsKey]?: typeof defaultDailyNote;
		};
		dailyPath = dailyNotePath(settings[dailyNoteSettingsKey] ?? defaultDailyNote, new Date(clip.startedAt));
	}
	let path = (attempt?.path ?? dailyPath ?? liveSyncNotePath(clip.folder, clip.title)) as NotePath;
	let id = await client.path2id(path);
	let meta = await getNoteMeta(client, id);
	if (!attempt && clip.behavior === 'create') {
		for (let sequence = 2; meta; sequence++) {
			path = liveSyncNotePath(clip.folder, clip.title, sequence) as NotePath;
			id = await client.path2id(path);
			meta = await getNoteMeta(client, id);
		}
	}
	if (meta?._conflicts?.length) throw new LiveSyncError('liveSyncConflict');
	if (!attempt && meta?.path) path = meta.path;

	const previous = await getNoteText(client, meta);
	if (attempt && meta?._rev !== attempt.baseRevision) {
		if (previous === undefined || await hashNote(previous) !== attempt.expectedHash) {
			throw new LiveSyncError('liveSyncConflict');
		}
		await storage.put('saves', { ...attempt, saved: true }, clip.clipId);
		return path;
	}
	const markdown = renderLiveSyncNote(clip, previous);
	const expectedHash = await hashNote(markdown);
	if (!attempt) {
		attempt = {
			destinationId: clip.destinationId, startedAt: clip.startedAt,
			path, baseRevision: meta?._rev, expectedHash,
		};
		// Keep only a digest and revision so an uncertain response can be retried without replaying an edit.
		const tx = storage.transaction('saves', 'readwrite');
		const expired = await tx.store.index('startedAt').getAllKeys(IDBKeyRange.upperBound(Date.now() - retryWindow));
		for (const key of expired) await tx.store.delete(key);
		await tx.store.add(attempt, clip.clipId);
		await tx.done;
	}
	if (expectedHash !== attempt.expectedHash) throw new LiveSyncError('liveSyncConflict');
	if (previous !== markdown) {
		const body = new Blob([markdown], { type: 'text/plain' });
		const now = Date.now();
		// Commonlib 0.6.0 omits an undefined _rev in the CouchDB PUT, which also guards a new file against collisions.
		const result = await client.liveSyncLocalDB.putDBEntryWithLiveBaseRevision({
			_id: id, path, data: body, ctime: meta?.ctime ?? now, mtime: now, size: body.size,
			children: [], eden: {}, type: 'plain', datatype: 'plain',
		}, attempt.baseRevision as string);
		if (!result) {
			const latest = await getNoteMeta(client, id);
			if (latest?._rev !== attempt.baseRevision || latest?._conflicts?.length) throw new LiveSyncError('liveSyncConflict');
			throw new LiveSyncError('liveSyncSaveFailed');
		}
	}
	await storage.put('saves', { ...attempt, saved: true }, clip.clipId);
	return path;
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
			if (!Number.isSafeInteger(message.startedAt) || message.startedAt < Date.now() - retryWindow ||
				message.startedAt > Date.now()) throw new LiveSyncError('liveSyncSaveExpired');
			const connection = await storage.get('connections', 'active');
			if (!connection || message.destinationId !== connection.id) {
				throw new LiveSyncError('liveSyncDestinationChanged');
			}
			const path = await withClient(connection.options, client => saveNote(client, storage, message));
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
				!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(message.clipId) ||
				!saveBehaviors.has(message.behavior) || typeof message.title !== 'string' || typeof message.folder !== 'string' ||
				typeof message.frontmatter !== 'string' || typeof message.markdown !== 'string') return;
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
