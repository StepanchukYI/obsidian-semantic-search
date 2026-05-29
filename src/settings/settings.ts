import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SemanticSearch from '../../main';

export interface SemanticSearchSettings {
	// Embedding provider
	provider: 'local' | 'tei' | 'ollama' | 'openai';
	localModel: string;
	teiHost: string;
	teiPort: number;
	teiApiKey: string;
	ollamaHost: string;
	ollamaModel: string;
	ollamaApiKey: string;
	openaiApiKey: string;
	openaiModel: string;
	batchSize: number;

	// Engine
	autoStart: boolean;

	// Indexing
	ignoredFolders: string;
	autoIndex: boolean;

	// UI
	enableConnectionsPanel: boolean;
	apiEnabled: boolean;
	debugMode: boolean;
}

export const DEFAULT_SETTINGS: SemanticSearchSettings = {
	provider: 'local',
	localModel: 'multilingual-MiniLM-L12',
	teiHost: 'localhost',
	teiPort: 8082,
	teiApiKey: '',
	ollamaHost: 'localhost:11434',
	ollamaModel: 'bge-m3',
	ollamaApiKey: '',
	openaiApiKey: '',
	openaiModel: 'text-embedding-3-small',
	batchSize: 10,

	autoStart: false,

	ignoredFolders: '',
	autoIndex: false,

	enableConnectionsPanel: true,
	apiEnabled: false,
	debugMode: false,
};

export class SemanticSearchSettingTab extends PluginSettingTab {
	plugin: SemanticSearch;

	constructor(app: App, plugin: SemanticSearch) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Semantic Search' });

		// === Embedding Provider ===
		containerEl.createEl('h3', { text: 'Embedding Provider' });

		const running = this.plugin.isEngineRunning();
		new Setting(containerEl)
			.setName(running ? 'Engine running' : 'Engine stopped')
			.setDesc(running ? `${this.plugin.provider?.getName()} active` : 'Start engine to initialize provider.')
			.addButton(b => {
				if (running) {
					b.setButtonText('Stop').setWarning().onClick(async () => {
						await this.plugin.stopEngine();
						new Notice('Engine stopped');
						this.display();
					});
				} else {
					b.setButtonText('Start').setClass('mod-cta').onClick(async () => {
						new Notice('Starting engine...');
						try {
							await this.plugin.startEngine((msg) => new Notice(msg));
							new Notice('Engine started');
						} catch (err: any) {
							new Notice(`Engine failed: ${err.message}`);
						}
						this.display();
					});
				}
			});

		new Setting(containerEl)
			.setName('Auto-start on launch')
			.setDesc('Initialize provider automatically when Obsidian starts.')
			.addToggle(t => t.setValue(this.plugin.settings.autoStart).onChange(async (v) => {
				this.plugin.settings.autoStart = v;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Local runs ONNX in browser (zero config). Others connect to external APIs.')
			.addDropdown(dd => dd
				.addOptions({
					local: 'Local (ONNX, zero-config)',
					tei: 'TEI (HuggingFace)',
					ollama: 'Ollama',
					openai: 'OpenAI API',
				})
				.setValue(this.plugin.settings.provider)
				.onChange(async (v) => {
					this.plugin.settings.provider = v as any;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.provider === 'local') {
			new Setting(containerEl)
				.setName('Local model')
				.setDesc('Multilingual supports 50+ languages including Russian.')
				.addDropdown(dd => dd
					.addOptions({
						'multilingual-MiniLM-L12': 'paraphrase-multilingual-MiniLM-L12-v2 (384d, 47MB, multilingual)',
						'all-MiniLM-L6': 'all-MiniLM-L6-v2 (384d, 28MB, English only)',
					})
					.setValue(this.plugin.settings.localModel)
					.onChange(async (v) => {
						this.plugin.settings.localModel = v;
						await this.plugin.saveSettings();
					}));
		}

		if (this.plugin.settings.provider === 'tei') {
			new Setting(containerEl)
				.setName('TEI Host')
				.addText(t => t.setValue(this.plugin.settings.teiHost).onChange(async (v) => {
					this.plugin.settings.teiHost = v;
					await this.plugin.saveSettings();
				}));
			new Setting(containerEl)
				.setName('TEI Port')
				.addText(t => t.setValue(String(this.plugin.settings.teiPort)).onChange(async (v) => {
					this.plugin.settings.teiPort = parseInt(v) || 8082;
					await this.plugin.saveSettings();
				}));
			new Setting(containerEl)
				.setName('API Key')
				.setDesc('Optional. Leave empty if TEI has no auth.')
				.addText(t => {
					t.setValue(this.plugin.settings.teiApiKey)
						.setPlaceholder('Bearer token or API key')
						.onChange(async (v) => {
							this.plugin.settings.teiApiKey = v;
							await this.plugin.saveSettings();
						});
				});
		}

		if (this.plugin.settings.provider === 'ollama') {
			new Setting(containerEl)
				.setName('Ollama Host')
				.addText(t => t.setValue(this.plugin.settings.ollamaHost).onChange(async (v) => {
					this.plugin.settings.ollamaHost = v;
					await this.plugin.saveSettings();
				}));
			new Setting(containerEl)
				.setName('Ollama Model')
				.addText(t => t.setValue(this.plugin.settings.ollamaModel).onChange(async (v) => {
					this.plugin.settings.ollamaModel = v;
					await this.plugin.saveSettings();
				}));
			new Setting(containerEl)
				.setName('API Key')
				.setDesc('Optional. Leave empty if Ollama has no auth.')
				.addText(t => {
					t.setValue(this.plugin.settings.ollamaApiKey)
						.setPlaceholder('Bearer token or API key')
						.onChange(async (v) => {
							this.plugin.settings.ollamaApiKey = v;
							await this.plugin.saveSettings();
						});
				});
		}

		if (this.plugin.settings.provider === 'openai') {
			new Setting(containerEl)
				.setName('API Key')
				.addText(t => {
					t.setValue(this.plugin.settings.openaiApiKey)
						.setPlaceholder('sk-...')
						.onChange(async (v) => {
							this.plugin.settings.openaiApiKey = v;
							await this.plugin.saveSettings();
						});
				});
			new Setting(containerEl)
				.setName('Model')
				.addText(t => t.setValue(this.plugin.settings.openaiModel).onChange(async (v) => {
					this.plugin.settings.openaiModel = v;
					await this.plugin.saveSettings();
				}));
		}

		new Setting(containerEl)
			.setName('Batch size')
			.setDesc('Number of texts to embed in one API call.')
			.addSlider(s => s.setLimits(1, 50, 1).setValue(this.plugin.settings.batchSize)
				.setDynamicTooltip()
				.onChange(async (v) => {
					this.plugin.settings.batchSize = v;
					await this.plugin.saveSettings();
				}));

		// === Connection Tests ===
		containerEl.createEl('h3', { text: 'Connection Tests' });

		new Setting(containerEl)
			.setName('Test provider')
			.addButton(b => b.setButtonText('Test').onClick(async () => {
				new Notice('Testing provider...');
				const result = await this.plugin.testProvider();
				new Notice(result.ok ? `OK: ${result.msg}` : `FAIL: ${result.msg}`);
				this.display();
			}));

		new Setting(containerEl)
			.setName('Test database')
			.addButton(b => b.setButtonText('Test').onClick(async () => {
				const result = await this.plugin.testDatabase();
				new Notice(result.ok ? `DB OK: ${result.msg}` : `DB FAIL: ${result.msg}`);
				this.display();
			}));

		new Setting(containerEl)
			.setName('Test full pipeline')
			.setDesc('Embed → store → search → cleanup')
			.addButton(b => b.setButtonText('Test').onClick(async () => {
				new Notice('Running pipeline test...');
				const result = await this.plugin.testPipeline();
				new Notice(result.ok ? `Pipeline OK: ${result.msg}` : `Pipeline FAIL: ${result.msg}`);
				this.display();
			}));

		// === Index Management ===
		containerEl.createEl('h3', { text: 'Index Management' });

		const stats = this.plugin.storage?.getStats?.();
		if (stats) {
			new Setting(containerEl)
				.setName('Index stats')
				.setDesc(`${stats.indexedDocs} sections across ${stats.totalDocs} files. Last: ${stats.lastUpdated}`);
		}

		new Setting(containerEl)
			.setName('Reindex vault')
			.addButton(b => b.setButtonText('Reindex').setClass('mod-cta').onClick(async () => {
				new Notice('Starting full reindex...');
				const result = await this.plugin.runReindex((msg) => new Notice(msg));
				new Notice(`Done: ${result.indexed} indexed, ${result.skipped} unchanged`);
				this.display();
			}));

			new Setting(containerEl)
				.setName('Validate & repair')
				.setDesc('Remove orphaned entries, reindex outdated files')
				.addButton(b => b.setButtonText('Validate').onClick(async () => {
					new Notice('Validating index...');
					try {
						const result = await this.plugin.validateIndex();
						new Notice(`Done: ${result.orphans} orphans removed, ${result.reindexed} reindexed`);
					} catch (err: any) {
						new Notice(`Validation failed: ${err.message}`);
					}
					this.display();
				}));

		new Setting(containerEl)
			.setName('Clear index')
			.setDesc('Delete all embeddings. Reindex after clearing.')
			.addButton(b => b.setButtonText('Clear').setWarning().onClick(async () => {
				this.plugin.storage.clearAll();
				await this.plugin.storage.save();
				new Notice('Index cleared');
				this.display();
			}));

		// === Auto-Indexing ===
		containerEl.createEl('h3', { text: 'Auto-Indexing' });

		new Setting(containerEl)
			.setName('Auto-index on file changes')
			.addToggle(t => t.setValue(this.plugin.settings.autoIndex).onChange(async (v) => {
				this.plugin.settings.autoIndex = v;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Ignored folders')
			.setDesc('One folder path per line')
			.addTextArea(t => t.setValue(this.plugin.settings.ignoredFolders).onChange(async (v) => {
				this.plugin.settings.ignoredFolders = v;
				await this.plugin.saveSettings();
			}));

		// === UI ===
		containerEl.createEl('h3', { text: 'UI' });

		new Setting(containerEl)
			.setName('Show connections panel')
			.setDesc('Right sidebar: similar notes for active file')
			.addToggle(t => t.setValue(this.plugin.settings.enableConnectionsPanel).onChange(async (v) => {
				this.plugin.settings.enableConnectionsPanel = v;
				await this.plugin.saveSettings();
				new Notice("Reload Obsidian to apply changes");
			}));

		new Setting(containerEl)
			.setName('Expose REST API')
			.setDesc('Register /semantic/* routes on Local REST API plugin (port 27124)')
			.addToggle(t => t.setValue(this.plugin.settings.apiEnabled).onChange(async (v) => {
				this.plugin.settings.apiEnabled = v;
				await this.plugin.saveSettings();
			}));

		if (this.plugin.apiServer?.isRegistered()) {
			new Setting(containerEl)
				.setName('API routes active')
				.setDesc('/semantic/health, /status, /search, /search/semantic, /search/lexical' + ((this.app as any).plugins?.enabledPlugins?.has?.('dataview') ? ', /dql' : ''))
				.addButton(b => b.setButtonText('Unregister').setWarning().onClick(async () => {
					this.plugin.apiServer?.unregister();
					new Notice('API routes unregistered');
					this.display();
				}));
		}

		new Setting(containerEl)
			.setName('Debug mode')
			.addToggle(t => t.setValue(this.plugin.settings.debugMode).onChange(async (v) => {
				this.plugin.settings.debugMode = v;
				await this.plugin.saveSettings();
			}));
	}
}
