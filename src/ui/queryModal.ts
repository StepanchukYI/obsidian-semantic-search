import { App, Modal } from 'obsidian';
import { EmbeddingProvider } from '../providers/types';
import { SearchEngine, SearchResult, SearchFilters } from '../search';
import { VectorStorage } from '../storage';

export class QueryModal extends Modal {
	private provider: EmbeddingProvider;
	private searchEngine: SearchEngine;
	private storage: VectorStorage;
	private includeTags = new Set<string>();
	private excludeTags = new Set<string>();

	constructor(app: App, provider: EmbeddingProvider, searchEngine: SearchEngine, storage: VectorStorage) {
		super(app);
		this.provider = provider;
		this.searchEngine = searchEngine;
		this.storage = storage;
	}

	onOpen(): void {
		const contentEl = this.modalEl;
		contentEl.removeClass('modal');
		contentEl.addClass('prompt');
		contentEl.querySelector('.modal-close-button')?.remove();

		const inputContainer = contentEl.createDiv({ cls: 'prompt-input-container' });
		const input = inputContainer.createEl('input', {
			cls: 'prompt-input',
			attr: { placeholder: 'Semantic search...' },
		});

		const button = inputContainer.createEl('button', {
			text: 'Search',
			cls: 'ss-query-submit-button',
		});

		// Filter bar
		const filterBar = contentEl.createDiv({ cls: 'ss-filter-bar' });

		const folderInput = filterBar.createEl('input', {
			cls: 'ss-filter-folder',
			attr: { placeholder: 'Folder filter...', type: 'text' },
		});

		// Tag pills
		const tagContainer = filterBar.createDiv({ cls: 'ss-tag-pills' });
		const allTags = this.storage.getAllTags();

		for (const tag of allTags) {
			const pill = tagContainer.createSpan({ cls: 'ss-tag-pill', text: tag });
			pill.onclick = () => this.toggleTag(tag, pill);
			pill.oncontextmenu = (e) => {
				e.preventDefault();
				this.toggleExcludeTag(tag, pill);
			};
		}

		const resultsDiv = contentEl.createDiv({ cls: 'prompt-results' });

		const submitQuery = async () => {
			const query = input.value.trim();
			if (!query) return;

			resultsDiv.empty();
			resultsDiv.createEl('p', { text: 'Searching...', cls: 'sem-search-status' });

			try {
				if (!this.provider.isReady()) {
					resultsDiv.empty();
					resultsDiv.createEl('p', { text: 'Model not loaded yet...', cls: 'sem-search-error' });
					return;
				}

				const filters: SearchFilters = {
					pathPrefix: folderInput.value.trim() || undefined,
					includeTags: this.includeTags.size > 0 ? Array.from(this.includeTags) : undefined,
					excludeTags: this.excludeTags.size > 0 ? Array.from(this.excludeTags) : undefined,
				};

				const queryEmbedding = (await this.provider.embedQuery([query]))[0];
				const results = this.searchEngine.hybridSearch(queryEmbedding, query, { limit: 15, filters });
				resultsDiv.empty();

				if (results.length === 0) {
					resultsDiv.createEl('p', { text: 'No results found', cls: 'sem-search-empty' });
					return;
				}

				for (const result of results) {
					this.renderResult(resultsDiv, result);
				}
			} catch (err) {
				resultsDiv.empty();
				resultsDiv.createEl('p', { text: `Error: ${err}`, cls: 'sem-search-error' });
			}
		};

		button.onclick = submitQuery;
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submitQuery();
			}
		});

		input.focus();
	}

	private toggleTag(tag: string, pill: HTMLSpanElement) {
		if (this.includeTags.has(tag)) {
			this.includeTags.delete(tag);
			pill.removeClass('ss-tag-include');
		} else {
			this.includeTags.add(tag);
			this.excludeTags.delete(tag);
			pill.removeClass('ss-tag-exclude');
			pill.addClass('ss-tag-include');
		}
	}

	private toggleExcludeTag(tag: string, pill: HTMLSpanElement) {
		if (this.excludeTags.has(tag)) {
			this.excludeTags.delete(tag);
			pill.removeClass('ss-tag-exclude');
		} else {
			this.excludeTags.add(tag);
			this.includeTags.delete(tag);
			pill.removeClass('ss-tag-include');
			pill.addClass('ss-tag-exclude');
		}
	}

	private renderResult(container: HTMLElement, result: SearchResult) {
		const item = container.createDiv({ cls: ['suggestion-item', 'ss-suggestion-item'] });
		const name = result.path.split('/').pop()?.replace('.md', '') || result.path;

		const header = item.createDiv({ cls: 'ss-suggestion-header' });
		header.createEl('span', { text: name });
		header.createSpan({
			text: ` ${result.score.toFixed(3)} (${result.source})`,
			cls: 'sem-search-result-score',
		});

		// Show tags for this result
		const tags = this.storage.getTagsForPath(result.path);
		if (tags.length > 0) {
			const tagRow = item.createDiv({ cls: 'ss-result-tags' });
			for (const t of tags.slice(0, 5)) {
				tagRow.createSpan({ text: t, cls: 'ss-result-tag' });
			}
		}

		if (result.section) {
			item.createDiv({
				text: `§ ${result.section}`,
				cls: 'sem-search-result-section',
			});
		}

		item.createDiv({
			text: result.path,
			cls: 'ss-suggestion-path',
		});

		item.onclick = () => {
			this.close();
			this.app.workspace.openLinkText(result.path, '');
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}
