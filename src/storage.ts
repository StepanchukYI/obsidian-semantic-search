import initSqlJs, { Database } from 'sql.js-fts5';
import { Vault } from 'obsidian';

export interface DocEntry {
	id: number;
	path: string;
	mtime: number;
	section: string;
	contentHash: string;
	embedding: Float32Array | null;
}

export class VectorStorage {
	private db!: Database;
	private vault: Vault;
	private dbPath: string;
	private initialized = false;

	constructor(vault: Vault, dbPath: string) {
		this.vault = vault;
		this.dbPath = dbPath;
	}

	async init(): Promise<void> {
		if (this.initialized) return;

		// Load WASM from plugin directory via vault adapter (works in Obsidian Electron)
		const wasmPath = `${this.dbPath.substring(0, this.dbPath.lastIndexOf('/'))}/sql-wasm.wasm`;
		let wasmBinary: ArrayBuffer | undefined;
		if (await this.vault.adapter.exists(wasmPath)) {
			wasmBinary = await this.vault.adapter.readBinary(wasmPath);
		}

		const SQL = wasmBinary
			? await initSqlJs({ wasmBinary: new Uint8Array(wasmBinary) })
			: await initSqlJs();

		let existingData: Uint8Array | null = null;
		if (await this.vault.adapter.exists(this.dbPath)) {
			const buf = await this.vault.adapter.readBinary(this.dbPath);
			existingData = new Uint8Array(buf);
		}

		this.db = existingData ? new SQL.Database(existingData) : new SQL.Database();
		this.initSchema();
		this.initialized = true;
	}

	private initSchema() {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS documents (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				path TEXT NOT NULL,
				mtime INTEGER NOT NULL,
				section TEXT DEFAULT '',
				content_hash TEXT NOT NULL,
				embedding BLOB,
				tags TEXT DEFAULT '[]',
				frontmatter TEXT DEFAULT '{}',
				updated_at INTEGER DEFAULT (strftime('%s', 'now'))
			);
		`);
		this.db.run(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path)`);
		this.db.run(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash)`);
		this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_path_section ON documents(path, section)`);
		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
				path, section, content
			);
		`);
		try { this.db.run("ALTER TABLE documents ADD COLUMN tags TEXT DEFAULT '[]'"); } catch {}
		try { this.db.run("ALTER TABLE documents ADD COLUMN frontmatter TEXT DEFAULT '{}'"); } catch {}
	}

	upsert(entry: { path: string; mtime: number; section: string; contentHash: string; embedding: Float32Array | null; content?: string; tags?: string[]; frontmatter?: Record<string, unknown> }) {
		const emb = entry.embedding ? this.float32ToBlob(entry.embedding) : null;
		const tagsJson = JSON.stringify(entry.tags ?? []);
		const fmJson = JSON.stringify(entry.frontmatter ?? {});
		this.db.run(
			`INSERT INTO documents (path, mtime, section, content_hash, embedding, tags, frontmatter) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(path, section) DO UPDATE SET
				mtime = excluded.mtime, content_hash = excluded.content_hash,
				embedding = excluded.embedding, tags = excluded.tags, frontmatter = excluded.frontmatter,
				updated_at = strftime('%s', 'now')`,
			[entry.path, entry.mtime, entry.section, entry.contentHash, emb, tagsJson, fmJson]
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

	getAllPaths(): string[] {
		const stmt = this.db.prepare('SELECT DISTINCT path FROM documents');
		const paths: string[] = [];
		while (stmt.step()) {
			paths.push((stmt.getAsObject() as any).path as string);
		}
		stmt.free();
		return paths;
	}

	getOrphanedSections(existingPaths: Set<string>): string[] {
		const allPaths = this.getAllPaths();
		return allPaths.filter(p => !existingPaths.has(p));
	}

	deletePaths(paths: string[]): number {
		let count = 0;
		for (const p of paths) {
			this.deleteByPath(p);
			count++;
		}
		return count;
	}


	getAllTags(): string[] {
		const stmt = this.db.prepare('SELECT DISTINCT j.value FROM documents, json_each(documents.tags) AS j');
		const tags: string[] = [];
		while (stmt.step()) {
			tags.push((stmt.getAsObject() as any).value as string);
		}
		stmt.free();
		return tags.sort();
	}

	getTagsForPath(filePath: string): string[] {
		const stmt = this.db.prepare('SELECT tags FROM documents WHERE path = ? LIMIT 1');
		stmt.bind([filePath]);
		if (stmt.step()) {
			const raw = (stmt.getAsObject() as any).tags as string;
			stmt.free();
			return JSON.parse(raw || '[]');
		}
		stmt.free();
		return [];
	}

	getMetaForPath(filePath: string): { tags: string[]; frontmatter: Record<string, unknown>; mtime: number } {
		const stmt = this.db.prepare('SELECT tags, frontmatter, mtime FROM documents WHERE path = ? LIMIT 1');
		stmt.bind([filePath]);
		if (stmt.step()) {
			const row = stmt.getAsObject() as any;
			stmt.free();
			return {
				tags: JSON.parse(row.tags || '[]'),
				frontmatter: JSON.parse(row.frontmatter || '{}'),
				mtime: (row.mtime as number) ?? 0,
			};
		}
		stmt.free();
		return { tags: [], frontmatter: {}, mtime: 0 };
	}

	clearAll() {
		this.db.run('DELETE FROM documents');
		this.db.run('DELETE FROM documents_fts');
	}

	getByPath(filePath: string): DocEntry[] {
		const stmt = this.db.prepare('SELECT * FROM documents WHERE path = ?');
		stmt.bind([filePath]);
		const rows: DocEntry[] = [];
		while (stmt.step()) {
			rows.push(this.rowToEntry(stmt.getAsObject()));
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

	getAllEmbeddings(): { id: number; path: string; section: string; embedding: Float32Array; tags: string[]; mtime: number; frontmatter: Record<string, unknown> }[] {
		const stmt = this.db.prepare('SELECT id, path, section, embedding, tags, mtime, frontmatter FROM documents WHERE embedding IS NOT NULL');
		const results: { id: number; path: string; section: string; embedding: Float32Array; tags: string[]; mtime: number; frontmatter: Record<string, unknown> }[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as any;
			results.push({
				id: row.id as number,
				path: row.path as string,
				section: row.section as string,
				embedding: this.blobToFloat32(row.embedding as Uint8Array),
				tags: JSON.parse((row.tags as string) || '[]'),
				mtime: (row.mtime as number) ?? 0,
				frontmatter: JSON.parse((row.frontmatter as string) || '{}'),
			});
		}
		stmt.free();
		return results;
	}

	lexicalSearch(query: string, pathPrefix?: string, limit: number = 20): { id: number; path: string; section: string; rank: number }[] {
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
		const results: { id: number; path: string; section: string; rank: number }[] = [];
		while (stmt.step()) {
			const row = stmt.getAsObject() as any;
			results.push({ id: row.id, path: row.path, section: row.section, rank: row.rank });
		}
		stmt.free();
		return results;
	}

	getStats(): { totalDocs: number; indexedDocs: number; lastUpdated: string } {
		const total = (this.db.exec('SELECT COUNT(DISTINCT path) as c FROM documents')[0]?.values[0]?.[0] as number) ?? 0;
		const indexed = (this.db.exec('SELECT COUNT(*) as c FROM documents WHERE embedding IS NOT NULL')[0]?.values[0]?.[0] as number) ?? 0;
		const lastRow = this.db.exec('SELECT MAX(updated_at) as t FROM documents')[0]?.values[0]?.[0] as number | null;
		return {
			totalDocs: total,
			indexedDocs: indexed,
			lastUpdated: lastRow ? new Date(lastRow * 1000).toISOString() : 'never',
		};
	}

	async save(): Promise<void> {
		if (!this.db) return;
		const data = this.db.export();
		const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
		if (!(await this.vault.adapter.exists(dir))) {
			await this.vault.adapter.mkdir(dir);
		}
		await this.vault.adapter.writeBinary(this.dbPath, data.buffer as ArrayBuffer);
	}

	close() {
		if (this.db) {
			this.db.close();
			this.initialized = false;
		}
	}

	private rowToEntry(row: any): DocEntry {
		return {
			id: row.id as number,
			path: row.path as string,
			mtime: row.mtime as number,
			section: row.section as string,
			contentHash: row.content_hash as string,
			embedding: row.embedding ? this.blobToFloat32(row.embedding as Uint8Array) : null,
		};
	}

	private float32ToBlob(arr: Float32Array): Uint8Array {
		return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
	}

	private blobToFloat32(blob: Uint8Array): Float32Array {
		return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
	}
}

export function hashContent(content: string): string {
	let hash = 0;
	for (let i = 0; i < content.length; i++) {
		const chr = content.charCodeAt(i);
		hash = ((hash << 5) - hash) + chr;
		hash |= 0;
	}
	return hash.toString(36);
}
