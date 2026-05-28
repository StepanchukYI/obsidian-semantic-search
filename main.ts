import { Notice, Plugin } from 'obsidian';
import { SemanticSearchSettings, DEFAULT_SETTINGS, SemanticSearchSettingTab } from './src/settings/settings';
import { EmbeddingProvider } from './src/providers/types';
import { LocalProvider } from './src/providers/local';
import { TEIProvider } from './src/providers/tei';
import { OllamaProvider } from './src/providers/ollama';
import { OpenAIProvider } from './src/providers/openai';
import { VectorStorage } from './src/storage';
import { SearchEngine } from './src/search';
import { Indexer } from './src/indexer';
import { ApiServer } from './src/api/server';
import { ConnectionsView, CONNECTIONS_VIEW_TYPE } from './src/ui/connectionsView';
import { QueryModal } from './src/ui/queryModal';

export default class SemanticSearch extends Plugin {
	settings!: SemanticSearchSettings;
	provider!: EmbeddingProvider;
	storage!: VectorStorage;
	searchEngine!: SearchEngine;
	indexer!: Indexer;
	apiServer!: ApiServer;
	private engineRunning = false;

	async onload() {
		console.log('[semantic-search] onload started');
		await this.loadSettings();
		console.log('[semantic-search] settings loaded');

		// 1. Initialize storage
		const dbPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/search.db`;
		this.storage = new VectorStorage(this.app.vault, dbPath);
		try {
			await this.storage.init();
			console.log('[semantic-search] storage initialized');
		} catch (err) {
			console.error('[semantic-search] storage init FAILED:', err);
		}

		// 2. Initialize search engine
		this.searchEngine = new SearchEngine(this.storage);

		// 3. Initialize indexer
		const ignoredFolders = this.settings.ignoredFolders
			.split('\n')
			.map(f => f.trim())
			.filter(f => f.length > 0);

		this.indexer = new Indexer(this.app, () => this.provider, this.storage, {
			ignoredFolders,
			batchSize: this.settings.batchSize,
		});

		// 4. Register connections view (always available)
		this.registerView(CONNECTIONS_VIEW_TYPE, (leaf) => {
			return new ConnectionsView(leaf, () => this.provider, this.searchEngine, this.storage);
		});
		this.addRibbonIcon('search', 'Semantic Search', () => {
			this.activateConnectionsView();
		});
		console.log('[semantic-search] view + ribbon registered');

		// 5. Commands
		this.addCommand({
			id: 'semantic-search',
			name: 'Search (semantic)',
			callback: () => {
				new QueryModal(this.app, this.provider, this.searchEngine, this.storage).open();
			},
		});

		this.addCommand({
			id: 'reindex-vault',
			name: 'Reindex vault',
			callback: async () => {
				new Notice('Starting reindex...');
				const result = await this.runReindex((msg) => new Notice(msg));
				new Notice(`Done: ${result.indexed} indexed, ${result.skipped} unchanged`);
			},
		});

		this.addCommand({
			id: 'validate-index',
			name: 'Validate & repair index',
			callback: async () => {
				new Notice('Validating index...');
				try {
					const result = await this.validateIndex();
					new Notice(`Done: ${result.orphans} orphans removed, ${result.reindexed} reindexed`);
				} catch (err: any) {
					new Notice(`Validation failed: ${err.message}`);
				}
			},
		});

		this.addCommand({
			id: 'toggle-connections',
			name: 'Toggle connections panel',
			callback: () => {
				const existing = this.app.workspace.getLeavesOfType(CONNECTIONS_VIEW_TYPE);
				if (existing.length > 0) {
					existing[0].detach();
				} else {
					this.activateConnectionsView();
				}
			},
		});

		// 6. Auto-start: silently init provider, register events, API routes
		if (this.settings.autoStart) {
			try {
				await this.initProvider();
				this.engineRunning = true;

				if (this.settings.autoIndex) {
					this.indexer.registerEvents(this);
				}

				if (this.settings.apiEnabled) {
					await this.registerApiRoutes();
				}

				// Auto-validate: remove orphans, reindex outdated
				this.validateIndex().then(r => {
					if (r.orphans > 0 || r.reindexed > 0) console.log(`[semantic-search] Auto-validated: ${r.orphans} orphans, ${r.reindexed} reindexed`);
				}).catch(err => {
					console.error('[semantic-search] Auto-validate failed:', err.message);
				});

				console.log(`[semantic-search] Auto-started: ${this.provider.getName()}`);
			} catch (err: any) {
				console.error('[semantic-search] Auto-start failed:', err.message);
				this.engineRunning = false;
			}
		} else {
			// Even without auto-start, register API if enabled (routes handle missing provider)
			if (this.settings.apiEnabled) {
				await this.registerApiRoutes();
			}
		}

		// 7. Settings tab
		this.addSettingTab(new SemanticSearchSettingTab(this.app, this));
	}

	async onunload() {
		this.apiServer?.unregister();
		await this.storage.save();
		this.storage.close();
	}

	private async registerApiRoutes() {
		try {
			this.apiServer = new ApiServer(
				this.app,
				this.manifest,
				() => this.provider,
				this.storage,
				this.searchEngine,
			);

			await this.apiServer.register();
			console.log('[semantic-search] API routes registered');
		} catch (err: any) {
			console.warn('[semantic-search] Local REST API not ready yet, waiting...', err.message);

			this.registerEvent(
				this.app.workspace.on('obsidian-local-rest-api:loaded' as any, async () => {
					try {
						await this.apiServer.register();
						console.log('[semantic-search] API routes registered (delayed)');
					} catch (err2: any) {
						console.error('[semantic-search] Failed to register routes:', err2.message);
					}
				})
			);
		}
	}

	isEngineRunning(): boolean {
		return this.engineRunning;
	}

	async startEngine(onProgress?: (msg: string) => void): Promise<void> {
		if (this.engineRunning) return;
		await this.initProvider(onProgress);
		this.engineRunning = true;

		if (this.settings.autoIndex) {
			this.indexer.registerEvents(this);
		}
		if (this.settings.apiEnabled && !this.apiServer?.isRegistered()) {
			await this.registerApiRoutes();
		}
	}

	async stopEngine(): Promise<void> {
		if (!this.engineRunning) return;
		await this.storage.save();
		this.engineRunning = false;
	}

	async testProvider(): Promise<{ ok: boolean; msg: string; dims?: number; latencyMs?: number }> {
		try {
			const start = Date.now();
			if (!this.provider?.isReady()) {
				await this.initProvider();
			}
			const result = await this.provider.embed(['test connection']);
			const latencyMs = Date.now() - start;
			return {
				ok: true,
				msg: `${this.provider.getName()} connected, ${result[0].length}d, ${latencyMs}ms`,
				dims: result[0].length,
				latencyMs,
			};
		} catch (err: any) {
			return { ok: false, msg: err.message || String(err) };
		}
	}

	async testDatabase(): Promise<{ ok: boolean; msg: string }> {
		try {
			const stats = this.storage.getStats();
			return { ok: true, msg: `${stats.totalDocs} files, ${stats.indexedDocs} sections, last: ${stats.lastUpdated}` };
		} catch (err: any) {
			return { ok: false, msg: err.message || String(err) };
		}
	}

	async testPipeline(): Promise<{ ok: boolean; msg: string }> {
		try {
			if (!this.provider?.isReady()) await this.initProvider();
			const vecs = await this.provider.embed(['pipeline test document']);
			const emb = new Float32Array(vecs[0]);
			this.storage.upsert({
				path: '__test__/test.md',
				mtime: Date.now(),
				section: 'test',
				contentHash: 'test',
				embedding: emb,
				content: 'pipeline test document',
			});
			const results = this.searchEngine.hybridSearch(vecs[0], 'pipeline test', { limit: 1 });
			this.storage.deleteByPath('__test__/test.md');
			const found = results.length > 0;
			return { ok: found, msg: found ? `embed(${vecs[0].length}d) → store → search → found` : 'search returned 0 results' };
		} catch (err: any) {
			return { ok: false, msg: err.message || String(err) };
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async initProvider(onProgress?: (msg: string) => void) {
		switch (this.settings.provider) {
			case 'local': {
				const p = new LocalProvider(this.settings.localModel);
				await p.init(onProgress);
				this.provider = p;
				break;
			}
			case 'tei':
				this.provider = new TEIProvider(this.settings.teiHost, this.settings.teiPort, this.settings.teiApiKey);
				break;
			case 'ollama':
				this.provider = new OllamaProvider(this.settings.ollamaHost, this.settings.ollamaModel, this.settings.ollamaApiKey);
				break;
			case 'openai':
				this.provider = new OpenAIProvider(this.settings.openaiApiKey, this.settings.openaiModel);
				break;
			default:
				throw new Error(`Unknown provider: ${this.settings.provider}`);
		}
	}

	async validateIndex(): Promise<{ orphans: number; reindexed: number }> {
		const stats = this.storage.getStats();
		if (stats.totalDocs === 0) return { orphans: 0, reindexed: 0 };

		// Find orphaned entries (files in DB but deleted from vault)
		const dbPaths = this.storage.getAllPaths();
		const existingPaths = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			existingPaths.add(f.path);
		}
		const orphans = dbPaths.filter(p => !existingPaths.has(p));
		if (orphans.length > 0) {
			this.storage.deletePaths(orphans);
			await this.storage.save();
		}

		// Auto-reindex outdated/new files
		if (!this.provider?.isReady()) return { orphans: orphans.length, reindexed: 0 };
		const result = await this.indexer.fullReindex();
		return { orphans: orphans.length, reindexed: result.indexed };
	}

	async runReindex(onProgress?: (msg: string) => void): Promise<{ indexed: number; skipped: number }> {
		if (!this.provider?.isReady()) {
			await this.initProvider(onProgress);
		}
		return this.indexer.fullReindex(onProgress);
	}

	private async activateConnectionsView() {
		const existing = this.app.workspace.getLeavesOfType(CONNECTIONS_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: CONNECTIONS_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}
}
