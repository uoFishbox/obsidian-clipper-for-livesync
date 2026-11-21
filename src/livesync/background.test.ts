import { afterEach, expect, it, vi } from 'vitest';
import type { LiveSyncRequest, LiveSyncResult } from './messages';

const { addListener, getRaw, writeNote } = vi.hoisted(() => ({
	addListener: vi.fn(),
	getRaw: vi.fn(),
	writeNote: vi.fn(async (_note: { path: string; data: Blob }, _revision?: string) => true),
}));

vi.mock('webextension-polyfill', () => ({
	default: {
		runtime: { id: 'clipper', getURL: (path: string) => path, onMessage: { addListener } },
	},
}));

vi.mock('@vrtmrz/livesync-commonlib', () => ({
	DirectFileManipulator: class {
		ready = { promise: Promise.resolve() };
		path2id = async (path: string) => path;
		close = async () => {};
		liveSyncLocalDB = { getRaw, putDBEntryWithLiveBaseRevision: writeNote };
	},
}));

vi.mock('idb', () => ({
	openDB: async () => ({
		get: async (store: string) => store === 'connections' ? {
			id: 'vault',
			options: { url: 'https://sync.example.test', database: 'vault', username: 'clipper', password: 'test' },
		} : undefined,
		put: async () => {},
		transaction: () => ({
			store: { index: () => ({ getAllKeys: async () => [] }), add: async () => {} },
			done: Promise.resolve(),
		}),
	}),
}));

import './background';

afterEach(() => {
	getRaw.mockReset();
	writeNote.mockClear();
	vi.unstubAllGlobals();
});

it.each([
	{ deleted: true, path: 'Note.md', revision: '2-original' },
	{ deleted: false, path: 'Note (2).md', revision: undefined },
])('chooses $path when the original has deleted=$deleted', async ({ deleted, path, revision }) => {
	vi.stubGlobal('IDBKeyRange', { upperBound: (value: number) => value });
	vi.stubGlobal('fetch', async () => Response.json({ type: 'versioninfo' }));
	getRaw.mockImplementation(async (id: string) => {
		if (id === 'Note.md') return { path: id, _rev: '2-original', deleted };
		throw { status: 404 };
	});

	const request: LiveSyncRequest = {
		action: 'liveSyncSave', destinationId: 'vault', clipId: crypto.randomUUID(), startedAt: Date.now(),
		behavior: 'create', title: 'Note', folder: '', frontmatter: '', markdown: 'New content',
	};
	const [listener] = addListener.mock.calls[0];
	const response = await new Promise<LiveSyncResult>(resolve => {
		expect(listener(request, { id: 'clipper', url: 'popup.html' }, resolve)).toBe(true);
	});

	expect(response).toEqual({ ok: true, path });
	expect(writeNote).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path }), revision);
	expect(await writeNote.mock.calls[0][0].data.text()).toBe('New content');
});
