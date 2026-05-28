import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js-fts5';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { hashContent } from './storage';

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
			CREATE TABLE IF NOT EXISTS documents (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				path TEXT NOT NULL,
				mtime INTEGER NOT NULL,
				section TEXT DEFAULT '',
				content_hash TEXT NOT NULL,
				embedding BLOB,
				updated_at INTEGER DEFAULT (strftime('%s', 'now'))
			);
		`);
		this.db.run(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path)`);
		this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_path_section ON documents(path, section)`);
		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
				path, section, content
			);
		`);
	}

	upsert(entry: { path: string; mtime: number; section: string; contentHash: string; embedding: Float32Array | null; content?: string }) {
		const emb = entry.embedding ? new Uint8Array(entry.embedding.buffer, entry.embedding.byteOffset, entry.embedding.byteLength) : null;
		this.db.run(
			`INSERT INTO documents (path, mtime, section, content_hash, embedding) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(path, section) DO UPDATE SET
				mtime = excluded.mtime, content_hash = excluded.content_hash,
				embedding = excluded.embedding, updated_at = strftime('%s', 'now')`,
			[entry.path, entry.mtime, entry.section, entry.contentHash, emb]
		);

		if (entry.content) {
			this.db.run(`DELETE FROM documents_fts WHERE path = ? AND section = ?`, [entry.path, entry.section]);
			this.db.run(`INSERT INTO documents_fts (path, section, content) VALUES (?, ?, ?)`,
				[entry.path, entry.section, entry.content]);
		}
	}

	deleteByPath(filePath: string) {
		this.db.run('DELETE FROM documents_fts WHERE path = ?', [filePath]);
		this.db.run('DELETE FROM documents WHERE path = ?', [filePath]);
	}

	getByPath(filePath: string) {
		const stmt = this.db.prepare('SELECT * FROM documents WHERE path = ?');
		stmt.bind([filePath]);
		const rows: any[] = [];
		while (stmt.step()) {
			rows.push(stmt.getAsObject());
		}
		stmt.free();
		return rows;
	}

	getOutdated(files: { path: string; mtime: number }[]): string[] {
		const outdated: string[] = [];
		for (const f of files) {
			const stmt = this.db.prepare('SELECT mtime FROM documents WHERE path = ? LIMIT 1');
			stmt.bind([f.path]);
			if (!stmt.step() || (stmt.getAsObject() as any).mtime < f.mtime) {
				outdated.push(f.path);
			}
			stmt.free();
		}
		return outdated;
	}

	getAllEmbeddings(): { id: number; path: string; section: string; embedding: Float32Array }[] {
		const stmt = this.db.prepare('SELECT id, path, section, embedding FROM documents WHERE embedding IS NOT NULL');
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
		if (pathPrefix) {
			sql += ' AND path LIKE ?';
			params.push(pathPrefix + '%');
		}
		sql += ' ORDER BY rank LIMIT ?';
		params.push(limit);

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

	getStats() {
		const totalResult = this.db.exec('SELECT COUNT(DISTINCT path) as c FROM documents');
		const total = (totalResult[0]?.values[0]?.[0] as number) ?? 0;
		const indexedResult = this.db.exec('SELECT COUNT(*) as c FROM documents WHERE embedding IS NOT NULL');
		const indexed = (indexedResult[0]?.values[0]?.[0] as number) ?? 0;
		return { totalDocs: total, indexedDocs: indexed };
	}

	close() {
		if (this.db) this.db.close();
	}
}

function makeEmbedding(values: number[]): Float32Array {
	return new Float32Array(values);
}

describe('hashContent', () => {
	it('produces consistent hashes', () => {
		expect(hashContent('hello')).toBe(hashContent('hello'));
	});

	it('different content → different hash', () => {
		expect(hashContent('hello')).not.toBe(hashContent('world'));
	});

	it('empty string', () => {
		expect(hashContent('')).toBe('0');
	});
});

describe('TestStorage (sql.js + FTS5)', () => {
	let storage: TestStorage;

	beforeEach(async () => {
		storage = new TestStorage();
		await storage.init();
	});
	afterEach(() => { storage.close(); });

	it('upsert and getByPath', () => {
		const emb = makeEmbedding([0.1, 0.2, 0.3]);
		storage.upsert({ path: 'notes/test.md', mtime: 1000, section: 'Intro', contentHash: 'abc', embedding: emb });

		const rows = storage.getByPath('notes/test.md');
		expect(rows).toHaveLength(1);
		expect((rows[0] as any).path).toBe('notes/test.md');
		expect((rows[0] as any).section).toBe('Intro');
	});

	it('upsert updates existing entry on conflict', () => {
		storage.upsert({ path: 'test.md', mtime: 1000, section: '', contentHash: 'v1', embedding: makeEmbedding([1, 0, 0]) });
		storage.upsert({ path: 'test.md', mtime: 2000, section: '', contentHash: 'v2', embedding: makeEmbedding([0, 1, 0]) });

		const rows = storage.getByPath('test.md');
		expect(rows).toHaveLength(1);
		expect((rows[0] as any).mtime).toBe(2000);
	});

	it('multiple sections for same file', () => {
		storage.upsert({ path: 'doc.md', mtime: 1000, section: 'Intro', contentHash: 'h1', embedding: makeEmbedding([1, 0]) });
		storage.upsert({ path: 'doc.md', mtime: 1000, section: 'Methods', contentHash: 'h2', embedding: makeEmbedding([0, 1]) });

		const rows = storage.getByPath('doc.md');
		expect(rows).toHaveLength(2);
	});

	it('deleteByPath removes all sections', () => {
		storage.upsert({ path: 'x.md', mtime: 1, section: 'A', contentHash: 'a', embedding: makeEmbedding([1]) });
		storage.upsert({ path: 'x.md', mtime: 1, section: 'B', contentHash: 'b', embedding: makeEmbedding([1]) });
		storage.deleteByPath('x.md');

		expect(storage.getByPath('x.md')).toHaveLength(0);
	});

	it('getOutdated returns files with no record or older mtime', () => {
		storage.upsert({ path: 'old.md', mtime: 500, section: '', contentHash: 'h', embedding: makeEmbedding([1]) });

		const outdated = storage.getOutdated([
			{ path: 'old.md', mtime: 600 },    // newer → outdated
			{ path: 'old.md', mtime: 400 },    // older → not outdated
			{ path: 'new.md', mtime: 1000 },   // no record → outdated
		]);
		expect(outdated).toContain('old.md');
	});

	it('getOutdated returns empty for up-to-date files', () => {
		storage.upsert({ path: 'current.md', mtime: 1000, section: '', contentHash: 'h', embedding: makeEmbedding([1]) });

		const outdated = storage.getOutdated([{ path: 'current.md', mtime: 500 }]);
		expect(outdated).toHaveLength(0);
	});

	it('getAllEmbeddings returns only rows with embeddings', () => {
		storage.upsert({ path: 'a.md', mtime: 1, section: '', contentHash: 'h', embedding: makeEmbedding([1, 2, 3]) });
		storage.upsert({ path: 'b.md', mtime: 1, section: '', contentHash: 'h', embedding: null });

		const all = storage.getAllEmbeddings();
		expect(all).toHaveLength(1);
		expect(all[0].path).toBe('a.md');
		expect(all[0].embedding[0]).toBeCloseTo(1);
		expect(all[0].embedding[1]).toBeCloseTo(2);
	});

	it('embedding roundtrip preserves Float32 values', () => {
		const original = makeEmbedding([0.123, -0.456, 0.789, 0.001, -1.0]);
		storage.upsert({ path: 'emb.md', mtime: 1, section: '', contentHash: 'h', embedding: original });

		const retrieved = storage.getAllEmbeddings();
		expect(retrieved).toHaveLength(1);
		for (let i = 0; i < original.length; i++) {
			expect(retrieved[0].embedding[i]).toBeCloseTo(original[i], 5);
		}
	});

	it('getStats returns correct counts', () => {
		storage.upsert({ path: 'a.md', mtime: 1, section: 's1', contentHash: 'h', embedding: makeEmbedding([1]) });
		storage.upsert({ path: 'a.md', mtime: 1, section: 's2', contentHash: 'h', embedding: makeEmbedding([1]) });
		storage.upsert({ path: 'b.md', mtime: 1, section: '', contentHash: 'h', embedding: null });

		const stats = storage.getStats();
		expect(stats.totalDocs).toBe(2);  // 2 distinct paths
		expect(stats.indexedDocs).toBe(2); // 2 rows with embedding
	});

	describe('FTS5 lexical search', () => {
		beforeEach(() => {
			storage.upsert({ path: 'notes/go.md', mtime: 1, section: '', contentHash: 'h', embedding: null, content: 'Golang is a statically typed programming language' });
			storage.upsert({ path: 'notes/python.md', mtime: 1, section: '', contentHash: 'h', embedding: null, content: 'Python is a dynamically typed programming language' });
			storage.upsert({ path: 'notes/rust.md', mtime: 1, section: '', contentHash: 'h', embedding: null, content: 'Rust is a systems programming language focused on safety' });
			storage.upsert({ path: 'recipes/pasta.md', mtime: 1, section: '', contentHash: 'h', embedding: null, content: 'Boil pasta in salted water for 8 minutes' });
		});

		it('finds by keyword', () => {
			const results = storage.lexicalSearch('programming');
			expect(results.length).toBeGreaterThanOrEqual(3);
		});

		it('path prefix filtering', () => {
			const results = storage.lexicalSearch('programming', 'notes/');
			expect(results.length).toBeGreaterThanOrEqual(3);
			const recipes = storage.lexicalSearch('programming', 'recipes/');
			expect(recipes).toHaveLength(0);
		});

		it('no results for nonsense query', () => {
			const results = storage.lexicalSearch('xyznonexistent12345');
			expect(results).toHaveLength(0);
		});
	});

	describe('Persistence', () => {
		const tmpDir = join(__dirname, '..', '.test-tmp');

		afterEach(() => {
			if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
		});

		it('data survives export → re-init cycle', async () => {
			const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });

			// Write data
			const db1 = new SQL.Database();
			db1.run(`CREATE TABLE IF NOT EXISTS documents (
				id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
				mtime INTEGER NOT NULL, section TEXT DEFAULT '',
				content_hash TEXT NOT NULL, embedding BLOB,
				updated_at INTEGER DEFAULT (strftime('%s', 'now'))
			)`);
			db1.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_path_section ON documents(path, section)`);
			db1.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(path, section, content)`);

			const emb = makeEmbedding([0.42, -0.17, 0.99]);
			const embBlob = new Uint8Array(emb.buffer, emb.byteOffset, emb.byteLength);
			db1.run('INSERT INTO documents (path, mtime, section, content_hash, embedding) VALUES (?, ?, ?, ?, ?)',
				['persist/test.md', 1000, 'intro', 'h1', embBlob]);
			db1.run('INSERT INTO documents_fts (path, section, content) VALUES (?, ?, ?)',
				['persist/test.md', 'intro', 'persistent data test']);

			// Export
			const dump = db1.export();
			db1.close();

			// Re-init from dump
			const db2 = new SQL.Database(dump);
			const stmt = db2.prepare('SELECT * FROM documents WHERE path = ?');
			stmt.bind(['persist/test.md']);
			expect(stmt.step()).toBe(true);
			const row = stmt.getAsObject() as any;
			expect(row.section).toBe('intro');

			const recoveredEmb = new Float32Array((row.embedding as Uint8Array).buffer, (row.embedding as Uint8Array).byteOffset, (row.embedding as Uint8Array).byteLength / 4);
			expect(recoveredEmb[0]).toBeCloseTo(0.42, 5);
			expect(recoveredEmb[2]).toBeCloseTo(0.99, 5);
			stmt.free();

			// FTS survives too
			const ftsStmt = db2.prepare("SELECT path FROM documents_fts WHERE documents_fts MATCH 'persistent'");
			expect(ftsStmt.step()).toBe(true);
			expect((ftsStmt.getAsObject() as any).path).toBe('persist/test.md');
			ftsStmt.free();
			db2.close();
		});

		it('clearAll removes all data from both tables', async () => {
			const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
			const db = new SQL.Database();
			db.run(`CREATE TABLE IF NOT EXISTS documents (
				id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
				mtime INTEGER NOT NULL, section TEXT DEFAULT '',
				content_hash TEXT NOT NULL, embedding BLOB,
				updated_at INTEGER DEFAULT (strftime('%s', 'now'))
			)`);
			db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(path, section, content)`);

			db.run('INSERT INTO documents (path, mtime, section, content_hash, embedding) VALUES (?, ?, ?, ?, ?)',
				['a.md', 1, '', 'h', null]);
			db.run('INSERT INTO documents (path, mtime, section, content_hash, embedding) VALUES (?, ?, ?, ?, ?)',
				['b.md', 1, 'sec', 'h', null]);
			db.run('INSERT INTO documents_fts (path, section, content) VALUES (?, ?, ?)',
				['a.md', '', 'content here']);

			// clearAll
			db.run('DELETE FROM documents');
			db.run('DELETE FROM documents_fts');

			const count = (db.exec('SELECT COUNT(*) FROM documents')[0]?.values[0]?.[0] as number) ?? -1;
			expect(count).toBe(0);

			const ftsStmt = db.prepare("SELECT COUNT(*) FROM documents_fts");
			ftsStmt.step();
			const ftsCount = (ftsStmt.getAsObject() as any)['COUNT(*)'];
			ftsStmt.free();
			expect(ftsCount).toBe(0);

			db.close();
		});
	});
});