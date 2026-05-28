import { describe, it, expect } from 'vitest';

// Extract splitSections logic from indexer for testing
function splitSections(content: string): { heading: string; content: string }[] {
	const sections: { heading: string; content: string }[] = [];
	const lines = content.split('\n');
	let currentHeading = '';
	let currentContent: string[] = [];

	for (const line of lines) {
		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			if (currentContent.length > 0) {
				sections.push({ heading: currentHeading, content: currentContent.join('\n') });
			}
			currentHeading = match[2].trim();
			currentContent = [];
		} else {
			currentContent.push(line);
		}
	}

	if (currentContent.length > 0) {
		sections.push({ heading: currentHeading, content: currentContent.join('\n') });
	}

	return sections.filter(s => s.content.trim().length > 20);
}

function isIgnored(filePath: string, ignoredFolders: string[]): boolean {
	return ignoredFolders.some(f => filePath.startsWith(f));
}

describe('splitSections', () => {
	it('splits by h2 headings', () => {
		const md = `# Title

Some intro text that is longer than twenty characters.

## Section 1

Content of section one with enough length.

## Section 2

Content of section two with enough length.`;

		const sections = splitSections(md);
		expect(sections).toHaveLength(3);
		expect(sections[0].heading).toBe('Title');
		expect(sections[1].heading).toBe('Section 1');
		expect(sections[2].heading).toBe('Section 2');
	});

	it('handles h1 through h6', () => {
		const md = `## H2
content for h2 section with enough characters.

### H3
content for h3 section with enough characters.

###### H6
content for h6 section with enough characters.`;

		const sections = splitSections(md);
		expect(sections).toHaveLength(3);
		expect(sections[0].heading).toBe('H2');
		expect(sections[1].heading).toBe('H3');
		expect(sections[2].heading).toBe('H6');
	});

	it('no headings → single section', () => {
		const md = `Just a plain document with no headings at all but enough content to pass the filter threshold.`;
		const sections = splitSections(md);
		expect(sections).toHaveLength(1);
		expect(sections[0].heading).toBe('');
	});

	it('filters out sections with < 20 chars content', () => {
		const md = `## Short
tiny

## Long Enough
This section has more than twenty characters of content.`;

		const sections = splitSections(md);
		expect(sections).toHaveLength(1);
		expect(sections[0].heading).toBe('Long Enough');
	});

	it('empty content → empty array', () => {
		expect(splitSections('')).toHaveLength(0);
	});

	it('preserves content with inline markdown', () => {
		const md = `## Test
This has **bold** and *italic* and [links](http://example.com) and enough chars.`;

		const sections = splitSections(md);
		expect(sections[0].content).toContain('**bold**');
		expect(sections[0].content).toContain('[links]');
	});

	it('heading without content between headings', () => {
		const md = `## A
## B
Content for B section with enough characters to pass.`;

		const sections = splitSections(md);
		// A has empty content (filtered), B has content
		expect(sections).toHaveLength(1);
		expect(sections[0].heading).toBe('B');
	});

	it('Russian content', () => {
		const md = `## Настройка
Это раздел на русском языке с достаточным количеством символов.`;

		const sections = splitSections(md);
		expect(sections).toHaveLength(1);
		expect(sections[0].heading).toBe('Настройка');
	});
});

describe('isIgnored', () => {
	const ignored = ['templates/', '.obsidian/', 'archive/'];

	it('matches ignored prefix', () => {
		expect(isIgnored('templates/daily.md', ignored)).toBe(true);
		expect(isIgnored('.obsidian/plugins/test/main.js', ignored)).toBe(true);
	});

	it('does not match non-ignored paths', () => {
		expect(isIgnored('notes/test.md', ignored)).toBe(false);
		expect(isIgnored('docs/readme.md', ignored)).toBe(false);
	});

	it('empty ignored list → nothing ignored', () => {
		expect(isIgnored('anything/goes.md', [])).toBe(false);
	});

	it('partial match does not false-positive', () => {
		// "arch" should not match "archive/"
		expect(isIgnored('arch/notes.md', ignored)).toBe(false);
	});

	it('exact folder match', () => {
		expect(isIgnored('archive/old.md', ignored)).toBe(true);
	});
});
