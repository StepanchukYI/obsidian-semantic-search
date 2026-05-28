import { App } from 'obsidian';
import { EmbeddingProvider } from '../providers/types';
import { VectorStorage } from '../storage';
import { SearchEngine, SearchFilters } from '../search';

interface LocalRestApi {
	addRoute(path: string): any;
	addPublicRoute(path: string): any;
	unregister(): void;
}

type RouteHandler = {
	get(handler: (req: any, res: any) => void): RouteHandler;
	post(handler: (req: any, res: any) => void): RouteHandler;
};

function parseFilters(req: any): SearchFilters {
	const pathPrefix = req.query.path as string | undefined;
	const tags = req.query.tags as string | undefined;
	const excludeTags = req.query.excludeTags as string | undefined;
	return {
		pathPrefix,
		includeTags: tags ? tags.split(',').map((t: string) => t.startsWith('#') ? t : '#' + t) : undefined,
		excludeTags: excludeTags ? excludeTags.split(',').map((t: string) => t.startsWith('#') ? t : '#' + t) : undefined,
	};
}

export class ApiServer {
	private app: App;
	private manifest: any;
	private providerGetter: () => EmbeddingProvider | undefined;
	private storage: VectorStorage;
	private searchEngine: SearchEngine;
	private api: LocalRestApi | null = null;
	private registered = false;

	constructor(
		app: App,
		manifest: any,
		providerGetter: () => EmbeddingProvider | undefined,
		storage: VectorStorage,
		searchEngine: SearchEngine,
	) {
		this.app = app;
		this.manifest = manifest;
		this.providerGetter = providerGetter;
		this.storage = storage;
		this.searchEngine = searchEngine;
	}

	private getProvider(): EmbeddingProvider {
		const p = this.providerGetter();
		if (!p) throw new Error('Provider not initialized. Start engine first.');
		return p;
	}

	async register(): Promise<void> {
		if (this.registered) return;

		const restPlugin = (this.app as any).plugins?.plugins?.['obsidian-local-rest-api'];
		if (!restPlugin) {
			throw new Error('Local REST API plugin not found. Install and enable it first.');
		}

		const getPublicApi = (restPlugin as any).getPublicApi;
		if (!getPublicApi) {
			throw new Error('Local REST API plugin does not expose extension API. Update it to latest version.');
		}

		this.api = getPublicApi.call(restPlugin, this.manifest);
		if (!this.api) {
			throw new Error('Failed to get Local REST API extension handle.');
		}

		this.setupRoutes();
		this.registered = true;

		console.log('[semantic-search] Routes registered on Local REST API');
	}

	private setupRoutes() {
		const api = this.api!;

		// Public: health check (no auth required)
		(api.addPublicRoute('/semantic/health') as RouteHandler)
			.get((_req: any, res: any) => {
				const provider = this.providerGetter();
				res.json({ status: 'ok', provider: provider?.getName() ?? 'not initialized' });
			});

		// Authenticated routes
		(api.addRoute('/semantic/status') as RouteHandler)
			.get((_req: any, res: any) => {
				try {
					const provider = this.getProvider();
					res.json({
						...this.storage.getStats(),
						provider: provider.getName(),
						dimension: provider.getDimension(),
					});
				} catch (_err: any) {
					res.json({ ...this.storage.getStats(), provider: 'not initialized' });
				}
			});

		(api.addRoute('/semantic/tags') as RouteHandler)
			.get((_req: any, res: any) => {
				try {
					const tags = this.storage.getAllTags();
					res.json({ ok: true, data: tags });
				} catch (err: any) {
					res.status(500).json({ ok: false, error: err.message });
				}
			});

		(api.addRoute('/semantic/search') as RouteHandler)
			.get(async (req: any, res: any) => {
				try {
					const query = req.query.q as string;
					const limit = parseInt(req.query.limit as string) || 10;

					if (!query) {
						res.status(400).json({ error: 'Missing query parameter "q"' });
						return;
					}

					const filters = parseFilters(req);
					const provider = this.getProvider();
					const queryEmbedding = (await provider.embed([query]))[0];
					const results = this.searchEngine.hybridSearch(queryEmbedding, query, { limit, filters });
					res.json({ ok: true, data: results, total: results.length });
				} catch (err: any) {
					res.status(500).json({ ok: false, error: err.message });
				}
			});

		(api.addRoute('/semantic/search/semantic') as RouteHandler)
			.get(async (req: any, res: any) => {
				try {
					const query = req.query.q as string;
					const limit = parseInt(req.query.limit as string) || 10;

					if (!query) {
						res.status(400).json({ error: 'Missing query parameter "q"' });
						return;
					}

					const filters = parseFilters(req);
					const provider = this.getProvider();
					const queryEmbedding = (await provider.embed([query]))[0];
					const results = this.searchEngine.semanticSearch(queryEmbedding, limit, filters);
					res.json({ ok: true, data: results, total: results.length });
				} catch (err: any) {
					res.status(500).json({ ok: false, error: err.message });
				}
			});

		(api.addRoute('/semantic/search/lexical') as RouteHandler)
			.get((req: any, res: any) => {
				try {
					const query = req.query.q as string;
					const limit = parseInt(req.query.limit as string) || 20;

					if (!query) {
						res.status(400).json({ error: 'Missing query parameter "q"' });
						return;
					}

					const filters = parseFilters(req);
					const results = this.searchEngine.lexicalSearch(query, filters, limit);
					res.json({ ok: true, data: results, total: results.length });
				} catch (err: any) {
					res.status(500).json({ ok: false, error: err.message });
				}
			});
	}

	isRegistered(): boolean {
		return this.registered;
	}

	unregister() {
		if (this.api) {
			this.api.unregister();
			this.api = null;
			this.registered = false;
		}
	}
}
