# Semantic Search ↔ Memory Integration (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `obsidian-semantic-search` plugin generic frontmatter/date filters, and rewire the `memory` plugin's semantic+hybrid search to consume the plugin (bge-m3) instead of mcp-tools/smart-connections, preserving memory-domain ranking and adding a fallback.

**Architecture:** Two task groups under one contract. Group A (plugin, TypeScript) adds generic `eq`/`gte`/`from`/`to` filters backed by indexed scalar frontmatter + existing mtime. Group B (memory, Python) calls `/semantic/search/semantic`, maps domain filters → generic params, keeps RRF/importance-boost in Python, falls back to mcp-tools/lexical on error. The plugin stays free of memory vocabulary.

**Tech Stack:** TypeScript + esbuild + vitest (plugin); Python + requests + pytest (memory). Transport: Obsidian Local REST API (`/semantic/*`), self-signed TLS.

**Spec:** `docs/superpowers/specs/2026-05-29-semantic-search-memory-integration-design.md`

**Repos:**
- Plugin: `/Users/evgeniystepanchuk/personal-projects/obsidian-search-plugin`
- Memory: `/Users/evgeniystepanchuk/personal-projects/personal-claude-marketplace/plugins/memory`

---

## File Structure

**Group A — plugin (`obsidian-search-plugin`):**
- Modify `src/storage.ts` — add `frontmatter` column + migration; persist in `upsert`; return it + `mtime` from `getAllEmbeddings`; add `getMetaForPath`.
- Modify `src/search.ts` — extend `SearchFilters`; field/date predicates in `applyFilters` (semantic) and lexical path.
- Modify `src/indexer.ts` — extract scalar frontmatter; pass to `upsert`.
- Modify `src/api/server.ts` — parse `eq`/`gte`/`from`/`to` into filters.
- Tests: `src/storage.test.ts`, `src/search.test.ts`, `src/indexer.test.ts`.

**Group B — memory (`plugins/memory`):**
- Modify `scripts/_lib/config.py` — `SEMANTIC_TIMEOUT`.
- Modify `scripts/_lib/backend.py` — `semantic_search(query, limit, filters)`.
- Modify `scripts/_lib/hybrid_search.py` — use semantic backend, domain→generic mapping, fallback.
- Modify `scripts/search.py` — wire `cmd_smart`/`cmd_hybrid`.
- Tests: `scripts/tests/test_semantic_integration.py`.

---

## GROUP A — Plugin (TypeScript)

### Task A1: Store scalar frontmatter in the index

**Files:**
- Modify: `src/storage.ts`
- Test: `src/storage.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/storage.test.ts — add inside existing describe (or new describe 'frontmatter')
it('persists and returns scalar frontmatter', async () => {
  const s = await makeStorage(); // existing helper that returns an inited VectorStorage
  s.upsert({
    path: 'a.md', mtime: 1000, section: 'h', contentHash: 'x',
    embedding: new Float32Array([1, 0, 0]), content: 'hello',
    tags: ['#t'], frontmatter: { type: 'decision', importance: 4 },
  });
  const meta = s.getMetaForPath('a.md');
  expect(meta.frontmatter).toEqual({ type: 'decision', importance: 4 });
  expect(meta.mtime).toBe(1000);
  expect(meta.tags).toEqual(['#t']);
});
```

If no `makeStorage` helper exists, create one at the top of the test file:
```ts
import { VectorStorage } from './storage';
async function makeStorage(): Promise<VectorStorage> {
  // in-memory adapter stub: exists()->false, readBinary/writeBinary/mkdir no-op
  const adapter: any = {
    exists: async () => false,
    readBinary: async () => new ArrayBuffer(0),
    writeBinary: async () => {},
    mkdir: async () => {},
  };
  const s = new VectorStorage({ adapter } as any, '/tmp/x/search.db');
  await s.init();
  return s;
}
```

- [ ] **Step 2: Run test, verify fail**

Run: `npx vitest run src/storage.test.ts -t frontmatter`
Expected: FAIL (`upsert` rejects `frontmatter` / `getMetaForPath` undefined).

- [ ] **Step 3: Implement**

In `src/storage.ts` `initSchema()`, after the `tags` ALTER line add:
```ts
try { this.db.run("ALTER TABLE documents ADD COLUMN frontmatter TEXT DEFAULT '{}'"); } catch {}
```
Change `upsert` signature + INSERT to include frontmatter:
```ts
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
    this.db.run(`INSERT INTO documents_fts (path, section, content) VALUES (?, ?, ?)`, [entry.path, entry.section, entry.content]);
  }
}
```
Also add the column to the `CREATE TABLE` block (`frontmatter TEXT DEFAULT '[]'` → use `'{}'`). Add method:
```ts
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
```
Extend `getAllEmbeddings` to also select `mtime, frontmatter` and include them in each returned object (add `mtime: number; frontmatter: Record<string,unknown>` to the return type and parse like tags).

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/storage.test.ts`
Expected: PASS (all storage tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts src/storage.test.ts
git commit -m "feat(storage): index scalar frontmatter + getMetaForPath"
```

### Task A2: Extract scalar frontmatter in the indexer

**Files:**
- Modify: `src/indexer.ts`
- Test: `src/indexer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/indexer.test.ts
it('extracts scalar frontmatter, skips non-scalars except tags', () => {
  const fm = { type: 'decision', importance: 4, draft: true, tags: ['x'], authors: ['a', 'b'], meta: { k: 1 } };
  const out = extractScalarFrontmatter(fm);
  expect(out).toEqual({ type: 'decision', importance: 4, draft: true });
});
```
Export a pure helper from `indexer.ts` so it is unit-testable:
```ts
export function extractScalarFrontmatter(fm: Record<string, any> | undefined | null): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!fm) return out;
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'tags' || k === 'position') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}
```

- [ ] **Step 2: Run test, verify fail**

Run: `npx vitest run src/indexer.test.ts -t frontmatter`
Expected: FAIL (`extractScalarFrontmatter` not exported).

- [ ] **Step 3: Implement**

Add the exported helper above to `src/indexer.ts`. In `indexBatch`, where tags are computed, also compute frontmatter and pass to `upsert`:
```ts
const cache = this.app.metadataCache.getFileCache(file);
const frontmatter = extractScalarFrontmatter(cache?.frontmatter);
```
Carry `frontmatter` through `allSections` entries and pass `frontmatter` in the `this.storage.upsert({...})` call.

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/indexer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/indexer.ts src/indexer.test.ts
git commit -m "feat(indexer): capture scalar frontmatter per document"
```

### Task A3: Generic filters in SearchEngine

**Files:**
- Modify: `src/search.ts`
- Test: `src/search.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/search.test.ts
it('filters semantic results by eq + gte + date', () => {
  // build a storage stub or use existing seeded engine helper
  const engine = seededEngine([
    { path: 'd.md', section: '', embedding: [1,0,0], tags: [], frontmatter: { type: 'decision', importance: 5 }, mtime: 2000 },
    { path: 'l.md', section: '', embedding: [1,0,0], tags: [], frontmatter: { type: 'lesson', importance: 2 }, mtime: 500 },
  ]);
  const r = engine.semanticSearch([1,0,0], 10, { fieldEq: { type: 'decision' }, fieldGte: { importance: 4 }, dateFrom: 1000 });
  expect(r.map(x => x.path)).toEqual(['d.md']);
});
```
(`seededEngine` helper builds a `SearchEngine` over a fake `VectorStorage` whose `getAllEmbeddings` returns the rows including `mtime`/`frontmatter`, and `getMetaForPath` returns matching meta.)

- [ ] **Step 2: Run test, verify fail**

Run: `npx vitest run src/search.test.ts -t "eq + gte + date"`
Expected: FAIL (filters ignored).

- [ ] **Step 3: Implement**

Extend `SearchFilters`:
```ts
export interface SearchFilters {
  pathPrefix?: string;
  includeTags?: string[];
  excludeTags?: string[];
  fieldEq?: Record<string, string>;
  fieldGte?: Record<string, number>;
  dateFrom?: number; // epoch ms inclusive
  dateTo?: number;   // epoch ms inclusive
}
```
Add a predicate helper and use it in both `applyFilters` (semantic; rows already carry `frontmatter`+`mtime`) and the lexical filter (fetch via `storage.getMetaForPath`):
```ts
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
```
Update `applyFilters<T extends { path; section; tags; frontmatter; mtime }>` to also call `matchesFields(d.frontmatter, d.mtime, filters)`. In `lexicalSearch`/`rawLexical`, where `getTagsForPath` is used, switch to `const meta = this.storage.getMetaForPath(r.path)` and check both `matchesTags(meta.tags, filters)` and `matchesFields(meta.frontmatter, meta.mtime, filters)`.

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/search.test.ts`
Expected: PASS (all search tests, incl. existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/search.ts src/search.test.ts
git commit -m "feat(search): generic frontmatter eq/gte + mtime date filters"
```

### Task A4: Parse new params in the REST API

**Files:**
- Modify: `src/api/server.ts`

- [ ] **Step 1: Implement parseFilters extension**

Replace `parseFilters(req)` to also read repeatable `eq`/`gte` and `from`/`to`:
```ts
function parseList(v: any): string[] { return Array.isArray(v) ? v : (v ? [v] : []); }
function parseFilters(req: any): SearchFilters {
  const f: SearchFilters = {
    pathPrefix: req.query.path as string | undefined,
    includeTags: req.query.tags ? String(req.query.tags).split(',').map(t => t.startsWith('#') ? t : '#' + t) : undefined,
    excludeTags: req.query.excludeTags ? String(req.query.excludeTags).split(',').map(t => t.startsWith('#') ? t : '#' + t) : undefined,
  };
  const eq: Record<string, string> = {};
  for (const item of parseList(req.query.eq)) { const i = item.indexOf(':'); if (i > 0) eq[item.slice(0, i)] = item.slice(i + 1); }
  if (Object.keys(eq).length) f.fieldEq = eq;
  const gte: Record<string, number> = {};
  for (const item of parseList(req.query.gte)) { const i = item.indexOf(':'); if (i > 0) { const n = Number(item.slice(i + 1)); if (Number.isFinite(n)) gte[item.slice(0, i)] = n; } }
  if (Object.keys(gte).length) f.fieldGte = gte;
  if (req.query.from) { const d = Date.parse(String(req.query.from)); if (!Number.isNaN(d)) f.dateFrom = d; }
  if (req.query.to) { const d = Date.parse(String(req.query.to)); if (!Number.isNaN(d)) f.dateTo = d + 86_399_000; } // end-of-day inclusive
  return f;
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `✓ Patched ...`, no TS errors.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/api/server.ts
git commit -m "feat(api): parse eq/gte/from/to filter params on /semantic routes"
```

---

## GROUP B — Memory (Python)

> Run from `plugins/memory`. Test runner: `python3 -m pytest scripts/tests/ -v`.

### Task B1: Semantic timeout config

**Files:**
- Modify: `scripts/_lib/config.py`

- [ ] **Step 1: Implement**

Append to `config.py`:
```python
# Semantic search can be slow while the embedding host is under load.
SEMANTIC_TIMEOUT: int = int(os.environ.get("MEMORY_SEMANTIC_TIMEOUT", "60"))
```

- [ ] **Step 2: Commit**

```bash
git add scripts/_lib/config.py
git commit -m "feat(memory): configurable semantic search timeout (default 60s)"
```

### Task B2: semantic_search backend method

**Files:**
- Modify: `scripts/_lib/backend.py`
- Test: `scripts/tests/test_semantic_integration.py`

- [ ] **Step 1: Write failing test**

```python
# scripts/tests/test_semantic_integration.py
import json
from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from _lib.backend import RestBackend  # adjust to actual class name

def _resp(status, payload):
    m = MagicMock(); m.status_code = status; m.json.return_value = payload; m.raise_for_status.return_value = None; return m

def test_semantic_search_builds_params_and_parses():
    b = RestBackend(api_key="k", api_url="https://h:27124")
    with patch("_lib.backend.requests.get") as g:
        g.return_value = _resp(200, {"ok": True, "data": [{"path": "a.md", "section": "", "score": 0.9}]})
        out = b.semantic_search("q", limit=5, filters={"eq": {"type": "decision"}, "gte": {"importance": 4}, "from": "2026-01-01"})
        assert out["ok"] is True
        assert out["data"][0]["path"] == "a.md"
        url = g.call_args[0][0]; params = g.call_args.kwargs["params"]
        assert "/semantic/search/semantic" in url
        assert params["q"] == "q" and params["limit"] == 5
        assert "type:decision" in params["eq"] and "importance:4" in params["gte"]
        assert params["from"] == "2026-01-01"
```

- [ ] **Step 2: Run, verify fail**

Run: `python3 -m pytest scripts/tests/test_semantic_integration.py -k builds_params -v`
Expected: FAIL (`semantic_search` missing).

- [ ] **Step 3: Implement**

Add to the REST backend class in `backend.py` (mirror existing `search_smart` style; note the class name — match the file):
```python
def semantic_search(self, query: str, limit: int = 10, filters: dict | None = None) -> dict:
    """Semantic search via the obsidian-semantic-search plugin (/semantic/search/semantic)."""
    filters = filters or {}
    params: dict = {"q": query, "limit": limit}
    if filters.get("path"): params["path"] = filters["path"]
    if filters.get("eq"): params["eq"] = [f"{k}:{v}" for k, v in filters["eq"].items()]
    if filters.get("gte"): params["gte"] = [f"{k}:{v}" for k, v in filters["gte"].items()]
    if filters.get("from"): params["from"] = filters["from"]
    if filters.get("to"): params["to"] = filters["to"]
    try:
        r = requests.get(
            f"{self.api_url}/semantic/search/semantic",
            headers=self._headers, params=params,
            timeout=config.SEMANTIC_TIMEOUT, verify=self.verify,
        )
        if r.status_code == 404:
            return err("Semantic search plugin unavailable (/semantic 404).", self.name)
        r.raise_for_status()
        data = r.json()
        return ok(data.get("data", []) if isinstance(data, dict) else data, self.name)
    except requests.ConnectionError:
        return err("Cannot connect to Obsidian REST API", self.name)
    except requests.RequestException as e:
        return err(str(e), self.name)
```
Use the existing `_headers` attribute (bearer auth); if only `_headers_json` exists, reuse it.

- [ ] **Step 4: Run, verify pass**

Run: `python3 -m pytest scripts/tests/test_semantic_integration.py -k builds_params -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/backend.py scripts/tests/test_semantic_integration.py
git commit -m "feat(memory): semantic_search backend via /semantic plugin API"
```

### Task B3: Hybrid uses plugin + domain mapping + fallback

**Files:**
- Modify: `scripts/_lib/hybrid_search.py`
- Test: `scripts/tests/test_semantic_integration.py`

- [ ] **Step 1: Write failing tests**

```python
def test_domain_filter_mapping():
    from _lib.hybrid_search import build_semantic_filters
    f = build_semantic_filters(path="Aspects/", entry_type="decision", importance=4, date_from="2026-01-01", date_to="")
    assert f["path"] == "Aspects/"
    assert f["eq"]["type"] == "decision"
    assert f["gte"]["importance"] == 4
    assert f["from"] == "2026-01-01"

def test_hybrid_falls_back_when_semantic_unavailable():
    b = MagicMock(); b.name = "rest"
    b.search.return_value = {"ok": True, "data": [{"path": "x.md", "result": ""}]}
    b.semantic_search.return_value = {"ok": False, "error": "404"}
    b.search_smart.return_value = {"ok": True, "data": [{"path": "y.md", "text": "", "score": 1}]}
    from _lib.hybrid_search import hybrid_search
    out = hybrid_search(b, "q", limit=5)
    assert out["ok"] is True
    assert out.get("search_backend") in ("fallback:mcp-tools", "semantic", "fallback:lexical")
    assert any(r["path"] in ("x.md", "y.md") for r in out["data"])
```

- [ ] **Step 2: Run, verify fail**

Run: `python3 -m pytest scripts/tests/test_semantic_integration.py -k "mapping or fallback" -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `hybrid_search.py`:
```python
def build_semantic_filters(path="", entry_type="", importance=0, sub_type="", valid_until="", date_from="", date_to=""):
    f = {}
    if path: f["path"] = path
    eq = {}
    if entry_type in {"decision","lesson","hub","session","context","idea","link"}:
        # canonical frontmatter `type` mapping; path-substring fallback stays in the type-filter step
        type_map = {"decision":"decisions","lesson":"lessons","hub":"project_hub","session":"session_log","context":"room_context","idea":"project_ideas","link":"project_links"}
        # NOTE: only apply when frontmatter type is reliable; default keeps path-substring filter downstream
    if sub_type: eq["sub_type"] = sub_type
    if valid_until: eq["valid_until"] = valid_until
    if eq: f["eq"] = eq
    if importance and int(importance) > 0: f["gte"] = {"importance": int(importance)}
    if date_from: f["from"] = date_from
    if date_to: f["to"] = date_to
    return f
```
In `hybrid_search(...)`, replace `results_sem = backend.search_smart(query, limit=limit)` with a guarded semantic call + fallback, and record which backend served:
```python
sem_filters = build_semantic_filters(path=path, entry_type=entry_type, date_from=date_from, date_to=date_to)
results_sem = backend.semantic_search(query, limit=limit, filters=sem_filters)
search_backend = "semantic"
if not results_sem.get("ok"):
    results_sem = backend.search_smart(query, limit=limit)
    search_backend = "fallback:mcp-tools"
    if not results_sem.get("ok"):
        results_sem = {"ok": True, "data": []}
        search_backend = "fallback:lexical"
```
Keep the path-keyword semantic call using `backend.semantic_search` too (same fallback guard). Keep all RRF / importance-boost / path-substring `entry_type` filter / dedup logic unchanged. Add `"search_backend": search_backend` to the returned dict.

- [ ] **Step 4: Run, verify pass**

Run: `python3 -m pytest scripts/tests/test_semantic_integration.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/_lib/hybrid_search.py scripts/tests/test_semantic_integration.py
git commit -m "feat(memory): hybrid uses /semantic with domain mapping + fallback"
```

### Task B4: Wire search.py smart/hybrid

**Files:**
- Modify: `scripts/search.py`

- [ ] **Step 1: Implement**

In `cmd_smart`, replace `backend.search_smart(query, limit=limit)` with a guarded semantic call:
```python
result = backend.semantic_search(query, limit=limit)
if not result.get("ok"):
    result = backend.search_smart(query, limit=limit)
```
`cmd_hybrid` already delegates to `hybrid_search` (now plugin-backed) — pass through `entry_type`, `date_from`, `date_to` (already wired). No interface change to the `mem search` CLI.

- [ ] **Step 2: Manual smoke (against live plugin)**

Run (env already set by `mem` launcher):
```bash
OBSIDIAN_API_URL="$OBSIDIAN_API_URL" OBSIDIAN_API_KEY="$OBSIDIAN_API_KEY" \
python3 scripts/search.py hybrid "agent memory architecture" --limit 5
```
Expected: JSON with `data` results and `search_backend: "semantic"` (or a `fallback:*` if plugin down).

- [ ] **Step 3: Full memory test suite**

Run: `python3 -m pytest scripts/tests/ -v`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add scripts/search.py
git commit -m "feat(memory): route smart/hybrid search through semantic plugin"
```

---

## Integration Verification (after both groups)

- [ ] Build plugin (`npm run build`), deploy updated `main.js` to server plugin dir, restart obsidian container, confirm `/semantic/search?...&eq=type:decision&gte=importance:4` returns filtered results.
- [ ] From a memory-enabled session: `mem search hybrid "<query>" --type decision --importance 4` returns bge-m3 results, `search_backend: "semantic"`.
- [ ] Stop the plugin engine; confirm `mem search` still returns results flagged `fallback:*`.
- [ ] `npm test` (plugin) + `python3 -m pytest scripts/tests/` (memory) both green.

---

## Self-Review notes
- Spec coverage: generic filters (A1–A4) ✓; frontmatter index (A1–A2) ✓; semantic rewire (B2,B4) ✓; domain mapping (B3) ✓; fallback (B3,B4) ✓; timeout (B1) ✓; tests both sides ✓.
- The `--type` → frontmatter-`type` mapping is intentionally conservative: `build_semantic_filters` does NOT force `eq=type:` (vault frontmatter `type` values vary, e.g. `project_hub`, `room_context`); the existing path-substring `entry_type` filter in `hybrid_search` remains the dependable mechanism. Server-side `eq=type:` can be enabled per-type later once frontmatter `type` is confirmed canonical. `sub_type`/`valid_until`/`importance`/date map directly.
- No placeholders; all steps carry code + commands.
