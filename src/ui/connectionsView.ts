import { ItemView, WorkspaceLeaf } from 'obsidian';
import { EmbeddingProvider } from '../providers/types';
import { SearchEngine, SearchResult, SearchFilters } from '../search';
import { VectorStorage } from '../storage';

export const CONNECTIONS_VIEW_TYPE = 'semantic-search';

export class ConnectionsView extends ItemView {
	private providerGetter: () => EmbeddingProvider | undefined;
	private searchEngine: SearchEngine;
	private storage: VectorStorage;
	private includeTags = new Set<string>();
	private excludeTags = new Set<string>();

	constructor(leaf: WorkspaceLeaf, providerGetter: () => EmbeddingProvider | undefined, searchEngine: SearchEngine, storage: VectorStorage) {
		super(leaf);
		this.providerGetter = providerGetter;
		this.searchEngine = searchEngine;
		this.storage = storage;
	}

	getViewType(): string {
		return CONNECTIONS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Semantic Search';
	}

	getIcon(): string {
		return 'search';
	}

	async onOpen() {
		this.render();
	}

	private render() {
		const container = this.contentEl;
		container.empty();

		// Search input row
		const inputRow = container.createDiv({ cls: 'ss-panel-input-row' });
		const input = inputRow.createEl('input', {
			cls: 'ss-panel-input',
			attr: { placeholder: 'Search query...', type: 'text' },
		});
		const btn = inputRow.createEl('button', { text: 'Search', cls: 'ss-panel-btn' });

		// Mode selector
		const modeRow = container.createDiv({ cls: 'ss-panel-mode-row' });
		const modes: { value: 'hybrid' | 'semantic' | 'lexical'; label: string }[] = [
			{ value: 'hybrid', label: 'Hybrid' },
			{ value: 'semantic', label: 'Semantic' },
			{ value: 'lexical', label: 'Lexical' },
		];
		let selectedMode: 'hybrid' | 'semantic' | 'lexical' = 'hybrid';
		for (const m of modes) {
			const pill = modeRow.createSpan({ text: m.label, cls: 'ss-mode-pill' });
			if (m.value === selectedMode) pill.addClass('ss-mode-active');
			pill.onclick = () => {
				selectedMode = m.value;
				modeRow.querySelectorAll('.ss-mode-pill').forEach(p => p.removeClass('ss-mode-active'));
				pill.addClass('ss-mode-active');
			};
		}

		// Filter bar: folder + tags
		const filterBar = container.createDiv({ cls: 'ss-filter-bar' });
		const folderInput = filterBar.createEl('input', {
			cls: 'ss-filter-folder',
			attr: { placeholder: 'Folder filter...', type: 'text' },
		});

		// Tag pills
		let allTags: string[] = [];
		try { allTags = this.storage.getAllTags(); } catch {}
		const tagContainer = filterBar.createDiv({ cls: 'ss-tag-pills' });
		for (const tag of allTags) {
			const pill = tagContainer.createSpan({ cls: 'ss-tag-pill', text: tag });
			pill.onclick = () => {
				if (this.includeTags.has(tag)) {
					this.includeTags.delete(tag);
					pill.removeClass('ss-tag-include');
				} else {
					this.includeTags.add(tag);
					this.excludeTags.delete(tag);
					pill.removeClass('ss-tag-exclude');
					pill.addClass('ss-tag-include');
				}
			};
			pill.oncontextmenu = (e) => {
				e.preventDefault();
				if (this.excludeTags.has(tag)) {
					this.excludeTags.delete(tag);
					pill.removeClass('ss-tag-exclude');
				} else {
					this.excludeTags.add(tag);
					this.includeTags.delete(tag);
					pill.removeClass('ss-tag-include');
					pill.addClass('ss-tag-exclude');
				}
			};
		}

		// Results container
		const resultsDiv = container.createDiv({ cls: 'ss-panel-results' });

		// Status line
		const statusDiv = container.createDiv({ cls: 'sem-search-placeholder' });
		const provider = this.providerGetter();
		if (!provider?.isReady()) {
			statusDiv.setText('Engine not running. Start it in plugin settings.');
		} else {
			const stats = this.storage.getStats();
			statusDiv.setText(`${stats.indexedDocs} sections indexed across ${stats.totalDocs} files`);
		}

		const doSearch = async () => {
			const query = input.value.trim();
			if (!query) return;

			resultsDiv.empty();
			statusDiv.setText('Searching...');

			try {
				const prov = this.providerGetter();
				if (!prov?.isReady()) {
					statusDiv.setText('Engine not running. Start it in plugin settings.');
					return;
				}

				const filters: SearchFilters = {
					pathPrefix: folderInput.value.trim() || undefined,
					includeTags: this.includeTags.size > 0 ? Array.from(this.includeTags) : undefined,
					excludeTags: this.excludeTags.size > 0 ? Array.from(this.excludeTags) : undefined,
				};

				let results: SearchResult[];
				if (selectedMode === 'semantic') {
					const emb = (await prov.embedQuery([query]))[0];
					results = this.searchEngine.semanticSearch(emb, 20, filters);
				} else if (selectedMode === 'lexical') {
					results = this.searchEngine.lexicalSearch(query, filters, 20);
				} else {
					const emb = (await prov.embedQuery([query]))[0];
					results = this.searchEngine.hybridSearch(emb, query, { limit: 20, filters });
				}

				resultsDiv.empty();
				statusDiv.setText(`${results.length} results (${selectedMode})`);

				for (const r of results) {
					this.renderResult(resultsDiv, r);
				}
			} catch (err) {
				resultsDiv.empty();
				statusDiv.setText(`Error: ${err}`);
			}
		};

		btn.onclick = doSearch;
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				doSearch();
			}
		});

		input.focus();
	}

	private renderResult(container: HTMLElement, result: SearchResult) {
		const item = container.createDiv({ cls: 'sem-search-result' });
		const name = result.path.split('/').pop()?.replace('.md', '') || result.path;

		const header = item.createDiv({ cls: 'sem-search-result-header' });
		header.createEl('a', {
			text: name,
			cls: 'sem-search-result-link',
			attr: { href: '#' },
		});
		header.createSpan({
			text: ` ${result.score.toFixed(3)} (${result.source})`,
			cls: 'sem-search-result-score',
		});

		if (result.section) {
			item.createDiv({ text: `§ ${result.section}`, cls: 'sem-search-result-section' });
		}

		let tags: string[] = [];
		try { tags = this.storage.getTagsForPath(result.path); } catch {}
		if (tags.length > 0) {
			const tagRow = item.createDiv({ cls: 'ss-result-tags' });
			for (const t of tags.slice(0, 5)) {
				tagRow.createSpan({ text: t, cls: 'ss-result-tag' });
			}
		}

		item.createDiv({ text: result.path, cls: 'sem-search-result-path' });

		item.addEventListener('click', (e) => {
			e.preventDefault();
			this.app.workspace.openLinkText(result.path, '');
		});
	}

	async onClose() {}
}
