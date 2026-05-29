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

function parseList(v: any): string[] { return Array.isArray(v) ? v : (v ? [v] : []); }

function parseFilters(req: any): SearchFilters {
	const f: SearchFilters = {
		pathPrefix: req.query.path as string | undefined,
		includeTags: req.query.tags ? String(req.query.tags).split(',').map(t => t.startsWith('#') ? t : '#' + t) : undefined,
		excludeTags: req.query.excludeTags ? String(req.query.excludeTags).split(',').map(t => t.startsWith('#') ? t : '#' + t) : undefined,
	};
	const eq: Record<string, string> = {};
	for (const item of parseList(req.query.eq)) { const s = String(item); const i = s.indexOf(':'); if (i > 0) eq[s.slice(0, i)] = s.slice(i + 1); }
	if (Object.keys(eq).length) f.fieldEq = eq;
	const gte: Record<string, number> = {};
	for (const item of parseList(req.query.gte)) { const s = String(item); const i = s.indexOf(':'); if (i > 0) { const n = Number(s.slice(i + 1)); if (Number.isFinite(n)) gte[s.slice(0, i)] = n; } }
	if (Object.keys(gte).length) f.fieldGte = gte;
	if (req.query.from) { const d = Date.parse(String(req.query.from)); if (!Number.isNaN(d)) f.dateFrom = d; }
	if (req.query.to) { const d = Date.parse(String(req.query.to)); if (!Number.isNaN(d)) f.dateTo = d + 86_399_000; } // end-of-day inclusive
	return f;
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
