import dayjs from 'dayjs';
import { LiveSyncError } from './messages';

const invalidPathCharacter = /[<>:"\\|?*#^\[\]\x00-\x1f\x7f]/;
const reservedName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const encoder = new TextEncoder();

function isValidSegment(part: string): boolean {
	return !!part && !part.startsWith('.') && part === part.trim() && !part.endsWith('.') &&
		!invalidPathCharacter.test(part) && !reservedName.test(part) && encoder.encode(part).length <= 255;
}

function noteFolder(folder: string): string {
	const directory = folder.trim().replace(/\/+$/, '');
	if (folder.trim().startsWith('/') || (directory && !directory.split('/').every(isValidSegment))) {
		throw new LiveSyncError('liveSyncInvalidPath');
	}
	return directory;
}

export function liveSyncNotePath(folder: string, title: string, sequence = 1): string {
	const directory = noteFolder(folder);
	const cleanTitle = [...title.trim().replace(/\.md$/i, '')]
		.filter(char => char !== '/' && !invalidPathCharacter.test(char))
		.join('').replace(/^[.\s]+|[.\s]+$/g, '') || 'Clip';
	const suffix = sequence === 1 ? '.md' : ` (${sequence}).md`;
	let name = reservedName.test(cleanTitle) ? '_' : '';
	for (const char of cleanTitle) {
		if (encoder.encode(name + char + suffix).length > 255) break;
		name += char;
	}
	return directory ? `${directory}/${name}${suffix}` : name + suffix;
}

export const dailyNoteSettingsKey = 'liveSyncDailyNote';
export const defaultDailyNote = { folder: '', format: 'YYYY-MM-DD' };

export function dailyNotePath(settings: typeof defaultDailyNote, date: Date): string {
	try {
		const folder = noteFolder(settings.folder);
		const format = settings.format.trim();
		if (!format) throw new Error();
		const relativePath = dayjs(date).format(format);
		const path = relativePath.replace(/\.md$/i, '') + '.md';
		if (!path.split('/').every(isValidSegment)) throw new Error();
		return folder ? `${folder}/${path}` : path;
	} catch {
		throw new LiveSyncError('liveSyncInvalidDailyNote');
	}
}
