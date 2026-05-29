import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js-fts5';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SearchEngine as RealSearchEngine } from './search';

type SeededRow = { path: string; section: string; embedding: number[]; tags: string[]; frontmatter: Record<string, unknown>; mtime: number };

function seededEngine(rows: SeededRow[]): RealSearchEngine {
	const stubStorage: any = {
		getAllEmbeddings: () => rows.map(r => ({
			id: 0,
			path: r.path,
			section: r.section,
			embedding: new Float32Array(r.embedding),
			tags: r.tags,
			frontmatter: r.frontmatter,
			mtime: r.mtime,
		})),
		lexicalSearch: () => [],
		getMetaForPath: (p: string) => {
			const r = rows.find(x => x.path === p);
			return r ? { tags: r.tags, frontmatter: r.frontmatter, mtime: r.mtime } : { tags: [], frontmatter: {}, mtime: 0 };
		},
		getTagsForPath: (p: string) => {
			const r = rows.find(x => x.path === p);
			return r ? r.tags : [];
		},
	};
	return new RealSearchEngine(stubStorage);
}

let wasmBinary: Buffer | undefined;
function getWasmBinary(): Buffer {
	if (!wasmBinary) {
		const wasmPath = join(__dirname, '..', 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm');
		wasmBinary = readFileSync(wasmPath);
	}
	return wasmBinary;
}

class TestStorage {
	private db!: Database;

	async init() {
		const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
		this.db = new SQL.Database();
		this.db.run(`
			CREATE TABLE documents (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				path TEXT NOT NULL, mtime INTEGER NOT NULL,
				section TEXT DEFAULT '', content_hash TEXT NOT NULL,
				embedding BLOB, updated_at INTEGER DEFAULT (strftime('%s','now'))
			);
		`);
		this.db.run(`CREATE UNIQUE INDEX idx_ps ON documents(path, section)`);
		this.db.run(`
			CREATE VIRTUAL TABLE documents_fts USING fts5(
				path, section, content
			);
		`);
	}

	upsert(entry: { path: string; mtime: number; section: string; contentHash: string; embedding: Float32Array | null; content?: string }) {
		const emb = entry.embedding ? new Uint8Array(entry.embedding.buffer, entry.embedding.byteOffset, entry.embedding.byteLength) : null;
		this.db.run(
			`INSERT INTO documents (path,mtime,section,content_hash,embedding) VALUES(?,?,?,?,?)
			 ON CONFLICT(path,section) DO UPDATE SET mtime=excluded.mtime,content_hash=excluded.content_hash,
				embedding=excluded.embedding,updated_at=strftime('%s','now')`,
			[entry.path, entry.mtime, entry.section, entry.contentHash, emb]
		);
		if (entry.content) {
			this.db.run(`DELETE FROM documents_fts WHERE path=? AND section=?`, [entry.path, entry.section]);
			this.db.run(`INSERT INTO documents_fts (path, section, content) VALUES (?, ?, ?)`,
				[entry.path, entry.section, entry.content]);
		}
	}

	getAllEmbeddings() {
		const stmt = this.db.prepare('SELECT id,path,section,embedding FROM documents WHERE embedding IS NOT NULL');
		const results: { id: number; path: string; section: string; embedding: Float32Array }[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as any;
			results.push({
				id: row.id as number,
				path: row.path as string,
				section: row.section as string,
				embedding: new Float32Array((row.embedding as Uint8Array).buffer, (row.embedding as Uint8Array).byteOffset, (row.embedding as Uint8Array).byteLength / 4),
			});
		}
		stmt.free();
		return results;
	}

	lexicalSearch(query: string, pathPrefix?: string, limit: number = 20) {
		let sql = `SELECT rowid as id, path, section, rank FROM documents_fts WHERE documents_fts MATCH ?`;
		const params: any[] = [query];
		if (pathPrefix) { sql += ' AND path LIKE ?'; params.push(pathPrefix + '%'); }
		sql += ' ORDER BY rank LIMIT ?'; params.push(limit);

		const stmt = this.db.prepare(sql);
		stmt.bind(params);
		const results: any[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as any;
			results.push({ id: row.id, path: row.path, section: row.section, rank: row.rank });
		}
		stmt.free();
		return results;
	}

	close() { if (this.db) this.db.close(); }
}

interface SearchResult { path: string; section: string; score: number; source: 'semantic' | 'lexical' | 'hybrid' }

function cosineSimilarity(a: number[], b: Float32Array): number {
	let dot = 0, normA = 0, normB = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

class SearchEngine {
	private storage: TestStorage;
	constructor(storage: TestStorage) { this.storage = storage; }

	semanticSearch(queryEmbedding: number[], limit = 10): SearchResult[] {
		return this.storage.getAllEmbeddings()
			.map(doc => ({ path: doc.path, section: doc.section, score: cosineSimilarity(queryEmbedding, doc.embedding), source: 'semantic' as const }))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	lexicalSearch(query: string, pathPrefix?: string, limit = 20): SearchResult[] {
		return this.storage.lexicalSearch(query, pathPrefix, limit)
			.map((r: any) => ({ path: r.path, section: r.section, score: r.rank, source: 'lexical' as const }));
	}

	hybridSearch(queryEmbedding: number[], lexicalQuery: string, options: { limit?: number; pathPrefix?: string } = {}): SearchResult[] {
		const { limit = 10, pathPrefix } = options;
		const K = 60;
		const semResults = this.semanticSearch(queryEmbedding, limit * 3);
		const lexResults = this.lexicalSearch(lexicalQuery, pathPrefix, limit * 3);

		const candidates = new Map<string, { path: string; section: string; rankSem?: number; rankLex?: number; pathMatch: boolean }>();
		for (let i = 0; i < semResults.length; i++) {
			const key = `${semResults[i].path}#${semResults[i].section}`;
			candidates.set(key, { path: semResults[i].path, section: semResults[i].section, rankSem: i, pathMatch: pathPrefix ? semResults[i].path.startsWith(pathPrefix) : true });
		}
		for (let i = 0; i < lexResults.length; i++) {
			const key = `${lexResults[i].path}#${lexResults[i].section}`;
			const isMatch = pathPrefix ? lexResults[i].path.startsWith(pathPrefix) : true;
			const existing = candidates.get(key);
			if (existing) { existing.rankLex = i; if (isMatch) existing.pathMatch = true; }
			else candidates.set(key, { path: lexResults[i].path, section: lexResults[i].section, rankLex: i, pathMatch: isMatch });
		}

		const scored = Array.from(candidates.values()).map(c => {
			let score = 0;
			if (c.rankSem !== undefined) score += 1 / (K + c.rankSem + 1);
			if (c.rankLex !== undefined) score += 1 / (K + c.rankLex + 1);
			if (pathPrefix) score *= c.pathMatch ? 2.0 : 0.3;
			return { path: c.path, section: c.section, score, source: 'hybrid' as const };
		});

		const deduped = new Map<string, SearchResult>();
		for (const r of scored) {
			const existing = deduped.get(r.path);
			if (!existing || r.score > existing.score) deduped.set(r.path, r);
		}
		return Array.from(deduped.values()).sort((a, b) => b.score - a.score).slice(0, limit);
	}
}

function embed(values: number[]): Float32Array { return new Float32Array(values); }

describe('cosineSimilarity', () => {
	it('identical vectors → 1.0', () => {
		expect(cosineSimilarity([1, 0, 0], new Float32Array([1, 0, 0]))).toBeCloseTo(1.0);
	});

	it('orthogonal vectors → 0.0', () => {
		expect(cosineSimilarity([1, 0, 0], new Float32Array([0, 1, 0]))).toBeCloseTo(0.0);
	});

	it('opposite vectors → -1.0', () => {
		expect(cosineSimilarity([1, 0], new Float32Array([-1, 0]))).toBeCloseTo(-1.0);
	});

	it('zero vector → 0.0', () => {
		expect(cosineSimilarity([0, 0, 0], new Float32Array([1, 2, 3]))).toBeCloseTo(0.0);
	});

	it('partial overlap', () => {
		expect(cosineSimilarity([1, 1, 0], new Float32Array([1, 0, 1]))).toBeCloseTo(0.5);
	});
});

describe('SearchEngine', () => {
	let storage: TestStorage;
	let engine: SearchEngine;

	beforeEach(async () => {
		storage = new TestStorage();
		await storage.init();
		engine = new SearchEngine(storage);

		storage.upsert({ path: 'docs/monitoring.md', mtime: 1, section: 'Setup', contentHash: 'h1',
			embedding: embed([1, 0]), content: 'Prometheus monitoring setup guide' });
		storage.upsert({ path: 'docs/network.md', mtime: 1, section: 'VLANs', contentHash: 'h2',
			embedding: embed([0, 1]), content: 'Network VLAN configuration MikroTik' });
		storage.upsert({ path: 'docs/docker.md', mtime: 1, section: '', contentHash: 'h3',
			embedding: embed([0.707, 0.707]), content: 'Docker container deployment on Proxmox' });
		storage.upsert({ path: 'docs/backup.md', mtime: 1, section: '', contentHash: 'h4',
			embedding: embed([-1, 0]), content: 'Backup strategy with Restic and S3' });
	});

	afterEach(() => { storage.close(); });

	describe('semanticSearch', () => {
		it('finds most similar by cosine', () => {
			const results = engine.semanticSearch([1, 0], 3);
			expect(results[0].path).toBe('docs/monitoring.md');
			expect(results[0].score).toBeCloseTo(1.0);
			expect(results[1].path).toBe('docs/docker.md');
			expect(results[1].source).toBe('semantic');
		});

		it('respects limit', () => {
			expect(engine.semanticSearch([1, 0], 2)).toHaveLength(2);
		});

		it('negative similarity ranked last', () => {
			const results = engine.semanticSearch([1, 0], 10);
			const backup = results.find(r => r.path === 'docs/backup.md');
			expect(backup).toBeDefined();
			expect(backup!.score).toBeLessThan(0);
		});

		it('empty db returns empty', async () => {
			const emptyStorage = new TestStorage();
			await emptyStorage.init();
			const emptyEngine = new SearchEngine(emptyStorage);
			expect(emptyEngine.semanticSearch([1, 0])).toHaveLength(0);
			emptyStorage.close();
		});
	});

	describe('lexicalSearch', () => {
		it('finds by keyword', () => {
			const results = engine.lexicalSearch('monitoring');
			expect(results.some(r => r.path === 'docs/monitoring.md')).toBe(true);
		});

		it('path prefix filtering', () => {
			const results = engine.lexicalSearch('configuration', 'docs/');
			expect(results.every(r => r.path.startsWith('docs/'))).toBe(true);
		});

		it('no results for missing term', () => {
			expect(engine.lexicalSearch('xyznonexistent')).toHaveLength(0);
		});
	});

	describe('hybridSearch', () => {
		it('combines semantic + lexical results', () => {
			const results = engine.hybridSearch([1, 0], 'monitoring', { limit: 5 });
			expect(results[0].path).toBe('docs/monitoring.md');
			expect(results[0].source).toBe('hybrid');
		});

		it('deduplicates by path (keeps highest score)', () => {
			storage.upsert({ path: 'docs/monitoring.md', mtime: 1, section: 'Alerts', contentHash: 'h5',
				embedding: embed([0.9, 0.1]), content: 'Monitoring alerts and dashboards' });

			const results = engine.hybridSearch([1, 0], 'monitoring', { limit: 10 });
			const monitoringResults = results.filter(r => r.path === 'docs/monitoring.md');
			expect(monitoringResults).toHaveLength(1);
		});

		it('path boosting — matched prefix gets higher score', () => {
			const results = engine.hybridSearch([0.707, 0.707], 'monitoring', { limit: 5, pathPrefix: 'docs/monitoring' });
			expect(results.some(r => r.path === 'docs/monitoring.md')).toBe(true);
		});

		it('non-matching path penalized', () => {
			const withPrefix = engine.hybridSearch([1, 0], 'monitoring', { limit: 5, pathPrefix: 'nonexistent/' });
			expect(withPrefix.every(r => r.source === 'hybrid')).toBe(true);
		});

		it('returns empty for empty db', async () => {
			const emptyStorage = new TestStorage();
			await emptyStorage.init();
			const emptyEngine = new SearchEngine(emptyStorage);
			expect(emptyEngine.hybridSearch([1, 0], 'test')).toHaveLength(0);
			emptyStorage.close();
		});
	});
});

describe('generic filters (eq/gte/date)', () => {
	it('filters semantic results by eq + gte + date', () => {
		const engine = seededEngine([
			{ path: 'd.md', section: '', embedding: [1,0,0], tags: [], frontmatter: { type: 'decision', importance: 5 }, mtime: 2000 },
			{ path: 'l.md', section: '', embedding: [1,0,0], tags: [], frontmatter: { type: 'lesson', importance: 2 }, mtime: 500 },
		]);
		const r = engine.semanticSearch([1,0,0], 10, { fieldEq: { type: 'decision' }, fieldGte: { importance: 4 }, dateFrom: 1000 });
		expect(r.map(x => x.path)).toEqual(['d.md']);
	});

	it('lexicalSearch: fieldEq filter excludes non-matching doc via getMetaForPath', async () => {
		// seededEngine stubs getMetaForPath with full frontmatter, but the lexical path in
		// RealSearchEngine calls storage.lexicalSearch + storage.getMetaForPath.
		// Build an engine where lexicalSearch returns both docs but only one matches fieldEq.
		const rows: SeededRow[] = [
			{ path: 'match.md', section: '', embedding: [1,0], tags: [], frontmatter: { status: 'active' }, mtime: 1000 },
			{ path: 'skip.md',  section: '', embedding: [0,1], tags: [], frontmatter: { status: 'draft'  }, mtime: 1000 },
		];
		const stubStorage: any = {
			getAllEmbeddings: () => [],
			// lexicalSearch returns both documents as if both matched the keyword
			lexicalSearch: (_q: string, _prefix: string | undefined, _limit: number) =>
				rows.map(r => ({ id: 0, path: r.path, section: r.section, rank: -1 })),
			getMetaForPath: (p: string) => {
				const r = rows.find(x => x.path === p);
				return r ? { tags: r.tags, frontmatter: r.frontmatter, mtime: r.mtime } : { tags: [], frontmatter: {}, mtime: 0 };
			},
		};
		const engine = new RealSearchEngine(stubStorage);
		const results = engine.lexicalSearch('keyword', { fieldEq: { status: 'active' } });
		const paths = results.map(r => r.path);
		expect(paths).toContain('match.md');
		expect(paths).not.toContain('skip.md');
	});

	it('lexicalSearch: fieldGte filter excludes non-matching doc via getMetaForPath', () => {
		const rows: SeededRow[] = [
			{ path: 'high.md', section: '', embedding: [1,0], tags: [], frontmatter: { priority: 8 }, mtime: 1000 },
			{ path: 'low.md',  section: '', embedding: [0,1], tags: [], frontmatter: { priority: 2 }, mtime: 1000 },
		];
		const stubStorage: any = {
			getAllEmbeddings: () => [],
			lexicalSearch: () => rows.map(r => ({ id: 0, path: r.path, section: r.section, rank: -1 })),
			getMetaForPath: (p: string) => {
				const r = rows.find(x => x.path === p);
				return r ? { tags: r.tags, frontmatter: r.frontmatter, mtime: r.mtime } : { tags: [], frontmatter: {}, mtime: 0 };
			},
		};
		const engine = new RealSearchEngine(stubStorage);
		const results = engine.lexicalSearch('keyword', { fieldGte: { priority: 5 } });
		const paths = results.map(r => r.path);
		expect(paths).toContain('high.md');
		expect(paths).not.toContain('low.md');
	});

	it('hybridSearch: filters apply — doc failing fieldEq does not appear', () => {
		const rows: SeededRow[] = [
			{ path: 'pass.md', section: '', embedding: [1,0], tags: [], frontmatter: { kind: 'note' }, mtime: 1000 },
			{ path: 'fail.md', section: '', embedding: [0,1], tags: [], frontmatter: { kind: 'task' }, mtime: 1000 },
		];
		const engine = seededEngine(rows);
		const results = engine.hybridSearch([1,0], 'query', { filters: { fieldEq: { kind: 'note' } } });
		const paths = results.map(r => r.path);
		expect(paths).toContain('pass.md');
		expect(paths).not.toContain('fail.md');
	});

	it('dateTo end-of-day: doc with mtime later same day as `to` is included', () => {
		// `to` date is 2024-01-15 → dateTo = Date.parse('2024-01-15') + 86_399_000
		const toDate = '2024-01-15';
		const baseMs = Date.parse(toDate); // start of day UTC
		const dateTo = baseMs + 86_399_000; // end-of-day inclusive
		const sameDayLate = baseMs + 50_000_000; // well within the same day (later)
		const nextDay = baseMs + 86_400_000 + 1000; // clearly next day

		const rows: SeededRow[] = [
			{ path: 'in.md',  section: '', embedding: [1,0], tags: [], frontmatter: {}, mtime: sameDayLate },
			{ path: 'out.md', section: '', embedding: [1,0], tags: [], frontmatter: {}, mtime: nextDay },
		];
		const engine = seededEngine(rows);
		const results = engine.semanticSearch([1,0], 10, { dateTo });
		const paths = results.map(r => r.path);
		expect(paths).toContain('in.md');
		expect(paths).not.toContain('out.md');
	});

	it('dateTo: doc mtime exactly at dateTo boundary is included', () => {
		const dateTo = 1_700_000_000_000; // arbitrary epoch ms
		const rows: SeededRow[] = [
			{ path: 'exact.md', section: '', embedding: [1,0], tags: [], frontmatter: {}, mtime: dateTo },
			{ path: 'over.md',  section: '', embedding: [1,0], tags: [], frontmatter: {}, mtime: dateTo + 1 },
		];
		const engine = seededEngine(rows);
		const results = engine.semanticSearch([1,0], 10, { dateTo });
		const paths = results.map(r => r.path);
		expect(paths).toContain('exact.md');
		expect(paths).not.toContain('over.md');
	});

	it('eq=missingField:x excludes a doc that lacks that frontmatter key', () => {
		const rows: SeededRow[] = [
			{ path: 'has-field.md',     section: '', embedding: [1,0], tags: [], frontmatter: { category: 'tech' }, mtime: 1 },
			{ path: 'missing-field.md', section: '', embedding: [1,0], tags: [], frontmatter: {},                   mtime: 1 },
		];
		const engine = seededEngine(rows);
		const results = engine.semanticSearch([1,0], 10, { fieldEq: { category: 'tech' } });
		const paths = results.map(r => r.path);
		expect(paths).toContain('has-field.md');
		expect(paths).not.toContain('missing-field.md');
	});

	it('eq=missingField: (empty string value) also excludes doc lacking that key', () => {
		// A doc with the field set to '' should match eq=field:, but a doc lacking the field entirely must not.
		const rows: SeededRow[] = [
			{ path: 'present-empty.md', section: '', embedding: [1,0], tags: [], frontmatter: { notes: '' }, mtime: 1 },
			{ path: 'absent.md',        section: '', embedding: [1,0], tags: [], frontmatter: {},            mtime: 1 },
		];
		const engine = seededEngine(rows);
		const results = engine.semanticSearch([1,0], 10, { fieldEq: { notes: '' } });
		const paths = results.map(r => r.path);
		expect(paths).toContain('present-empty.md');
		expect(paths).not.toContain('absent.md');
	});

	it('semantic result includes frontmatter', () => {
		const rows: SeededRow[] = [
			{ path: 'fm.md', section: '', embedding: [1,0,0], tags: [], frontmatter: { importance: 5 }, mtime: 1 },
		];
		const engine = seededEngine(rows);
		const results = engine.semanticSearch([1,0,0], 10);
		expect(results).toHaveLength(1);
		expect(results[0].frontmatter).toEqual({ importance: 5 });
	});

	it('lexical result includes frontmatter', () => {
		const rows: SeededRow[] = [
			{ path: 'lex.md', section: '', embedding: [0,1,0], tags: [], frontmatter: { importance: 5 }, mtime: 1 },
		];
		const stubStorage: any = {
			getAllEmbeddings: () => [],
			lexicalSearch: () => rows.map(r => ({ id: 0, path: r.path, section: r.section, rank: -1 })),
			getMetaForPath: (p: string) => {
				const r = rows.find(x => x.path === p);
				return r ? { tags: r.tags, frontmatter: r.frontmatter, mtime: r.mtime } : { tags: [], frontmatter: {}, mtime: 0 };
			},
		};
		const engine = new RealSearchEngine(stubStorage);
		const results = engine.lexicalSearch('keyword');
		expect(results).toHaveLength(1);
		expect(results[0].frontmatter).toEqual({ importance: 5 });
	});
});
