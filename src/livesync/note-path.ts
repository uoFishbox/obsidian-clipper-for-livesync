import { LiveSyncError } from './messages';

const invalidPathCharacter = /[<>:"\\|?*#^\[\]\x00-\x1f\x7f]/;
const reservedName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const encoder = new TextEncoder();

export function liveSyncNotePath(folder: string, title: string, clipId: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clipId)) {
		throw new LiveSyncError('liveSyncInvalidPath');
	}
	const directory = folder.trim().replace(/\/+$/, '');
	if (folder.trim().startsWith('/') || (directory && directory.split('/').some(part =>
		!part || part.startsWith('.') || part !== part.trim() || part.endsWith('.') ||
		invalidPathCharacter.test(part) || reservedName.test(part) || encoder.encode(part).length > 255
	))) {
		throw new LiveSyncError('liveSyncInvalidPath');
	}
	const cleanTitle = [...title.trim().replace(/\.md$/i, '')]
		.filter(char => char !== '/' && !invalidPathCharacter.test(char))
		.join('').replace(/^[.\s]+|[.\s]+$/g, '') || 'Clip';
	const suffix = ` - ${clipId}.md`;
	let name = reservedName.test(cleanTitle) ? '_' : '';
	for (const char of cleanTitle) {
		if (encoder.encode(name + char + suffix).length > 255) break;
		name += char;
	}
	return directory ? `${directory}/${name}${suffix}` : name + suffix;
}
