import { App, TFile, Vault } from 'obsidian';
import { EmbeddingProvider } from './providers/types';
import { VectorStorage, hashContent } from './storage';

export function extractScalarFrontmatter(fm: Record<string, any> | undefined | null): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	if (!fm) return out;
	for (const [k, v] of Object.entries(fm)) {
		if (k === 'tags' || k === 'position') continue;
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
	}
	return out;
}

interface IndexerConfig {
	ignoredFolders: string[];
	sectionDelimiter: string;
	batchSize: number;
}

const DEFAULT_CONFIG: IndexerConfig = {
	ignoredFolders: [],
	sectionDelimiter: '##',
	batchSize: 10,
};

export class Indexer {
	private app: App;
	private vault: Vault;
	private providerGetter: () => EmbeddingProvider | undefined;
	private storage: VectorStorage;
	private config: IndexerConfig;
	private queue: string[] = [];
	private processing = false;
	private eventsRegistered = false;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		app: App,
		providerGetter: () => EmbeddingProvider | undefined,
		storage: VectorStorage,
		config: Partial<IndexerConfig> = {}
	) {
		this.app = app;
		this.vault = app.vault;
		this.providerGetter = providerGetter;
		this.storage = storage;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	registerEvents(plugin: { registerEvent: (e: any) => void }) {
		if (this.eventsRegistered) return;
		this.eventsRegistered = true;
		plugin.registerEvent(this.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.scheduleReindex(file.path);
			}
		}));
		plugin.registerEvent(this.vault.on('create', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.scheduleReindex(file.path);
			}
		}));
		plugin.registerEvent(this.vault.on('delete', (file) => {
			if (file instanceof TFile) {
				this.storage.deleteByPath(file.path);
			}
		}));
		plugin.registerEvent(this.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile) {
				this.storage.deleteByPath(oldPath);
				this.scheduleReindex(file.path);
			}
		}));
	}

	private scheduleReindex(filePath: string) {
		if (this.isIgnored(filePath)) return;
		if (!this.queue.includes(filePath)) {
			this.queue.push(filePath);
		}
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.processQueue();
		}, 2000);
	}

	async fullReindex(onProgress?: (msg: string) => void): Promise<{ indexed: number; skipped: number }> {
		const files = this.vault.getMarkdownFiles()
			.filter(f => !this.isIgnored(f.path));

		onProgress?.(`Found ${files.length} markdown files`);

		const outdated = this.storage.getOutdated(
			files.map(f => ({ path: f.path, mtime: f.stat.mtime }))
		);

		onProgress?.(`${outdated.length} files to index`);

		let indexed = 0;
		for (let i = 0; i < outdated.length; i += this.config.batchSize) {
			const batch = outdated.slice(i, i + this.config.batchSize);
			await this.indexBatch(batch, onProgress);
			indexed += batch.length;
			await this.storage.save();
			onProgress?.(`Indexed ${indexed}/${outdated.length}`);
		}

		return { indexed, skipped: files.length - outdated.length };
	}

	private async indexBatch(filePaths: string[], onProgress?: (msg: string) => void) {
		const allSections: { path: string; section: string; content: string; hash: string; tags: string[]; frontmatter: Record<string, string | number | boolean> }[] = [];

		for (const fp of filePaths) {
			const file = this.vault.getAbstractFileByPath(fp);
			if (!(file instanceof TFile)) continue;

			this.storage.deleteByPath(fp);
			const content = await this.vault.read(file);
			const tags = this.extractTags(file);
			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = extractScalarFrontmatter(cache?.frontmatter);
			const sections = this.splitSections(content);

			for (const sec of sections) {
				const hash = hashContent(sec.content);
				allSections.push({ path: fp, section: sec.heading, content: sec.content, hash, tags, frontmatter });
			}
		}

		if (allSections.length === 0) return;

		// Batch embed
		const texts = allSections.map(s => s.content.slice(0, 2000));
		const provider = this.providerGetter();
		if (!provider) throw new Error('Embedding provider not initialized');
		const embeddings = await provider.embed(texts);

		// Store
		for (let i = 0; i < allSections.length; i++) {
			const s = allSections[i];
			const emb = new Float32Array(embeddings[i]);
			this.storage.upsert({
				path: s.path,
				mtime: Date.now(),
				section: s.section,
				contentHash: s.hash,
				embedding: emb,
				content: s.content,
				tags: s.tags,
				frontmatter: s.frontmatter,
			});
		}
	}

	private async processQueue() {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;

		try {
			while (this.queue.length > 0) {
				const batch = this.queue.splice(0, this.config.batchSize);
				await this.indexBatch(batch);
			}
		} catch (err) {
			console.error('[semantic-search] Indexing error:', err);
		} finally {
			await this.storage.save();
			this.processing = false;
		}
	}

	private static readonly MAX_CHUNK_SIZE = 1500;
	private static readonly MIN_SECTION_SIZE = 30;

	private splitSections(content: string): { heading: string; content: string }[] {
		const sections: { heading: string; content: string }[] = [];
		const lines = content.split('\n');
		let currentHeading = '';
		let currentContent: string[] = [];

		const flush = () => {
			const text = currentContent.join('\n').trim();
			if (text.length < Indexer.MIN_SECTION_SIZE) return;

			// Split oversized chunks by paragraph boundaries
			if (text.length > Indexer.MAX_CHUNK_SIZE) {
				const chunks = this.splitLargeChunk(text);
				for (const chunk of chunks) {
					sections.push({ heading: currentHeading, content: chunk });
				}
			} else {
				sections.push({ heading: currentHeading, content: text });
			}
		};

		for (const line of lines) {
			const match = line.match(/^(#{1,6})\s+(.+)$/);
			if (match) {
				flush();
				currentHeading = match[2].trim();
				currentContent = [];
			} else {
				currentContent.push(line);
			}
		}
		flush();

		return sections;
	}

	private splitLargeChunk(text: string): string[] {
		const paragraphs = text.split(/\n\n+/);
		const chunks: string[] = [];
		let current = '';

		for (const para of paragraphs) {
			if (current.length + para.length + 2 > Indexer.MAX_CHUNK_SIZE && current.length > 0) {
				chunks.push(current.trim());
				current = para;
			} else {
				current += (current ? '\n\n' : '') + para;
			}
		}
		if (current.trim().length >= Indexer.MIN_SECTION_SIZE) {
			chunks.push(current.trim());
		}
		return chunks.length > 0 ? chunks : [text.slice(0, Indexer.MAX_CHUNK_SIZE)];
	}

	private extractTags(file: TFile): string[] {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return [];

		const tags = new Set<string>();

		// Frontmatter tags
		const fm = cache.frontmatter;
		if (fm?.tags) {
			const fmTags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
			for (const t of fmTags) {
				tags.add('#' + String(t).replace(/^#/, ''));
			}
		}

		// Inline tags
		if (cache.tags) {
			for (const t of cache.tags) {
				tags.add(t.tag.startsWith('#') ? t.tag : '#' + t.tag);
			}
		}

		return Array.from(tags);
	}

	private isIgnored(filePath: string): boolean {
		return this.config.ignoredFolders.some(f => filePath.startsWith(f));
	}
}
