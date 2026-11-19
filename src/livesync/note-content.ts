import type { LiveSyncClip } from './messages';

function joinMarkdown(left: string, right: string): string {
	const separator = left && right && !left.endsWith('\n') && !right.startsWith('\n') && !right.startsWith('\r\n') ? '\n' : '';
	return left + separator + right;
}

export function renderLiveSyncNote(clip: Pick<LiveSyncClip, 'behavior' | 'frontmatter' | 'markdown'>, existing?: string): string {
	const { behavior, frontmatter, markdown } = clip;
	if (existing === undefined || behavior === 'create' || behavior === 'overwrite') {
		return frontmatter + markdown;
	}
	if (behavior.startsWith('append')) return joinMarkdown(existing, markdown);
	const properties = existing.match(/^(?:\uFEFF)?---[ \t]*\r?\n(?:[^\r\n]*\r?\n)*?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/)?.[0] ?? '';
	return joinMarkdown(properties, joinMarkdown(markdown, existing.slice(properties.length)));
}
