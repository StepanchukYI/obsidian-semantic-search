import { VectorStorage } from './storage';

export interface SearchResult {
	path: string;
	section: string;
	score: number;
	source: 'semantic' | 'lexical' | 'hybrid';
}

export interface SearchFilters {
	pathPrefix?: string;
	includeTags?: string[];
	excludeTags?: string[];
	fieldEq?: Record<string, string>;
	fieldGte?: Record<string, number>;
	dateFrom?: number; // epoch ms inclusive
	dateTo?: number;   // epoch ms inclusive
}

export class SearchEngine {
	private storage: VectorStorage;

	constructor(storage: VectorStorage) {
		this.storage = storage;
	}

	semanticSearch(queryEmbedding: number[], limit: number = 10, filters?: SearchFilters): SearchResult[] {
		let allDocs = this.storage.getAllEmbeddings();
		allDocs = this.applyFilters(allDocs, filters);
		const scored = allDocs.map(doc => ({
			path: doc.path,
			section: doc.section,
			score: cosineSimilarity(queryEmbedding, doc.embedding),
			source: 'semantic' as const,
		}));
		scored.sort((a, b) => b.score - a.score);
		return this.dedupByFile(scored, limit);
	}

	lexicalSearch(query: string, filters?: SearchFilters, limit: number = 20): SearchResult[] {
		const pathPrefix = filters?.pathPrefix;
		const results = this.storage.lexicalSearch(query, pathPrefix, limit * 3);
		const filtered = results.filter(r => {
			const meta = this.storage.getMetaForPath(r.path);
			return this.matchesTags(meta.tags, filters) && this.matchesFields(meta.frontmatter, meta.mtime, filters);
		});
		const scored = filtered.map(r => ({
			path: r.path,
			section: r.section,
			score: r.rank,
			source: 'lexical' as const,
		}));
		return this.dedupByFile(scored, limit);
	}

	hybridSearch(
		queryEmbedding: number[],
		lexicalQuery: string,
		options: { limit?: number; pathPrefix?: string; filters?: SearchFilters } = {}
	): SearchResult[] {
		const { limit = 10, filters } = options;
		const pathPrefix = filters?.pathPrefix ?? options.pathPrefix;
		const K = 60;

		// Raw results from both backends (no dedup yet — more candidates for RRF)
		const semRaw = this.rawSemantic(queryEmbedding, filters);
		const lexRaw = this.rawLexical(lexicalQuery, filters);

		// Build candidates with rank tracking
		const candidates = new Map<string, {
			path: string;
			section: string;
			rankSem?: number;
			rankLex?: number;
			semScore?: number;
			pathMatch: boolean;
		}>();

		for (let i = 0; i < semRaw.length; i++) {
			const key = `${semRaw[i].path}#${semRaw[i].section}`;
			const isMatch = pathPrefix ? semRaw[i].path.startsWith(pathPrefix) : true;
			candidates.set(key, {
				path: semRaw[i].path,
				section: semRaw[i].section,
				rankSem: i,
				semScore: semRaw[i].score,
				pathMatch: isMatch,
			});
		}

		for (let i = 0; i < lexRaw.length; i++) {
			const key = `${lexRaw[i].path}#${lexRaw[i].section}`;
			const isMatch = pathPrefix ? lexRaw[i].path.startsWith(pathPrefix) : true;
			const existing = candidates.get(key);
			if (existing) {
				existing.rankLex = i;
				if (isMatch) existing.pathMatch = true;
			} else {
				candidates.set(key, {
					path: lexRaw[i].path,
					section: lexRaw[i].section,
					rankLex: i,
					pathMatch: isMatch,
				});
			}
		}

		// RRF fusion + semantic score boost for results found by both
		const scored = Array.from(candidates.values()).map(c => {
			let score = 0;
			if (c.rankSem !== undefined) score += 1 / (K + c.rankSem + 1);
			if (c.rankLex !== undefined) score += 1 / (K + c.rankLex + 1);

			// Boost results found by both backends (confirmation signal)
			if (c.rankSem !== undefined && c.rankLex !== undefined) {
				score *= 1.5;
			}

			if (pathPrefix) {
				score *= c.pathMatch ? 2.0 : 0.3;
			}

			return {
				path: c.path,
				section: c.section,
				score,
				source: 'hybrid' as const,
			};
		});

		return this.dedupByFile(scored, limit);
	}

	private rawSemantic(queryEmbedding: number[], filters?: SearchFilters): SearchResult[] {
		let allDocs = this.storage.getAllEmbeddings();
		allDocs = this.applyFilters(allDocs, filters);
		return allDocs.map(doc => ({
			path: doc.path,
			section: doc.section,
			score: cosineSimilarity(queryEmbedding, doc.embedding),
			source: 'semantic' as const,
		})).sort((a, b) => b.score - a.score);
	}

	private rawLexical(query: string, filters?: SearchFilters): SearchResult[] {
		const pathPrefix = filters?.pathPrefix;
		const results = this.storage.lexicalSearch(query, pathPrefix, 60);
		return results.filter(r => {
			const meta = this.storage.getMetaForPath(r.path);
			return this.matchesTags(meta.tags, filters) && this.matchesFields(meta.frontmatter, meta.mtime, filters);
		}).map(r => ({
			path: r.path,
			section: r.section,
			score: r.rank,
			source: 'lexical' as const,
		}));
	}

	private applyFilters<T extends { path: string; section: string; tags: string[]; frontmatter: Record<string, unknown>; mtime: number }>(docs: T[], filters?: SearchFilters): T[] {
		if (!filters) return docs;
		return docs.filter(d => {
			if (filters.pathPrefix && !d.path.startsWith(filters.pathPrefix)) return false;
			if (!this.matchesTags(d.tags, filters)) return false;
			return this.matchesFields(d.frontmatter, d.mtime, filters);
		});
	}

	private matchesFields(frontmatter: Record<string, unknown>, mtime: number, f?: SearchFilters): boolean {
		if (!f) return true;
		if (f.fieldEq) for (const [k, v] of Object.entries(f.fieldEq)) {
			if (String(frontmatter[k] ?? '') !== String(v)) return false;
		}
		if (f.fieldGte) for (const [k, v] of Object.entries(f.fieldGte)) {
			const n = Number(frontmatter[k]); if (!(Number.isFinite(n) && n >= v)) return false;
		}
		if (f.dateFrom !== undefined && mtime < f.dateFrom) return false;
		if (f.dateTo !== undefined && mtime > f.dateTo) return false;
		return true;
	}

	private dedupByFile(results: SearchResult[], limit: number): SearchResult[] {
		const seen = new Map<string, SearchResult>();
		for (const r of results) {
			const existing = seen.get(r.path);
			if (!existing || r.score > existing.score) {
				seen.set(r.path, r);
			}
		}
		return Array.from(seen.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	private matchesTags(docTags: string[], filters?: SearchFilters): boolean {
		if (!filters) return true;
		if (filters.includeTags?.length) {
			if (!filters.includeTags.some(t => docTags.includes(t))) return false;
		}
		if (filters.excludeTags?.length) {
			if (filters.excludeTags.some(t => docTags.includes(t))) return false;
		}
		return true;
	}
}

function cosineSimilarity(a: number[], b: Float32Array): number {
	if (a.length !== b.length) {
		throw new Error(`Dimension mismatch: query=${a.length}, stored=${b.length}. Reindex required.`);
	}
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
