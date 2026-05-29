# Design — Semantic Search ↔ Memory Plugin Integration (Phase B)

**Date:** 2026-05-29
**Status:** approved (design), pending spec review
**Scope:** Phase B of the memory-plugin initiative — rewire the memory plugin's semantic/hybrid
search to consume the `obsidian-semantic-search` plugin, and add the general filter capability the
plugin needs to serve that consumer. Repo extraction (Phase A) and multi-agent support (Phase C)
are separate specs.

## Guiding principle

Two products, clean boundary:

- **`obsidian-semantic-search`** — a **self-sufficient, general-purpose** Obsidian plugin. Knows
  nothing about "memory", "decisions", "importance", or "sub_type". It indexes a vault and answers
  semantic / lexical / hybrid queries with **generic** filters (path, tags, arbitrary frontmatter
  fields, mtime date range).
- **`memory`** plugin — a **layer on top**. Owns all memory-domain semantics (RAG protocol L0–L5
  routing, importance-boost ranking, path-keyword anchoring, `type`/`sub_type`/`valid_until`
  vocabulary). It consumes the semantic-search plugin's generic API and maps its domain concepts
  onto generic filters.

This resolves where each capability lives: generic search + generic filtering in the plugin;
domain ranking + domain vocabulary in the memory layer.

Grounding (from vault): `agent-memory-architecture-v2` already chose **BGE-M3** as the embedding
model (this plugin uses it). `amh-architecture-critique` rejects a separate centralized memory
platform (dual-write / ingestion lag); this plugin indexes the vault **in place** (no second source
of truth), which is the endorsed "protocol over Obsidian" approach. `Knowledge/RAG_PROTOCOL.md`
(canonical) defines L4 search with field filters `importance:>=4`, `sub_type:`, `path:`,
`valid_until:ongoing` — those filters must be preserved through the rewire.

## Architecture

```
agent (Claude/Codex/…) 
  └─ mem search {text|smart|hybrid} "q" [--path --type --from --to --importance --sub_type …]
       └─ memory/scripts/search.py
            ├─ backend.search()          → lexical
            ├─ backend.semantic_search() → /semantic/search/semantic   (NEW: bge-m3 via plugin)
            └─ _lib/hybrid_search.py     → RRF + importance-boost + path-anchoring (memory-owned)
                 └─ maps domain filters → generic plugin filter params
                 └─ fallback to mcp-tools /search/smart on plugin error
                      ↓ HTTPS (same Local REST API base + key)
obsidian-semantic-search plugin  /semantic/*  (general API + generic filters)
  └─ SearchEngine (cosine + FTS5 + RRF) over VectorStorage (sql.js-fts5, in-vault search.db)
```

Same transport for both: Obsidian **Local REST API** (`OBSIDIAN_API_URL`, `OBSIDIAN_API_KEY`,
self-signed TLS). No new endpoint, host, or auth.

## Part 1 — Plugin changes (general, self-contained)

### 1.1 Generic filters on `/semantic/*`

Add to `/semantic/search`, `/semantic/search/semantic`, `/semantic/search/lexical`:

| Param | Repeatable | Meaning |
|-------|-----------|---------|
| `eq=field:value` | yes | frontmatter `field` equals `value` (string) |
| `gte=field:N` | yes | frontmatter `field` numeric `>= N` |
| `from=YYYY-MM-DD` | no | file mtime `>=` date |
| `to=YYYY-MM-DD` | no | file mtime `<=` date |
| `path=` `tags=` `excludeTags=` | — | existing, unchanged |

Example: `/semantic/search?q=auth&eq=type:decision&gte=importance:4&from=2026-01-01`

No memory vocabulary in the plugin — `type`, `importance`, etc. are just whatever frontmatter keys
the caller names.

### 1.2 Index frontmatter fields

Today the indexer extracts only tags. Extend it to also store **scalar** frontmatter fields
(string/number/bool) as a JSON object per document.

- `storage.ts`: add column `frontmatter TEXT DEFAULT '{}'` (additive `ALTER TABLE` like the existing
  `tags` migration). Persist on `upsert`. Bump nothing else.
- `indexer.ts`: in `indexBatch`, read `metadataCache.getFileCache(file).frontmatter`, keep scalar
  keys, store as JSON alongside tags.
- `SearchEngine.applyFilters`: extend with predicate matching — `eq` (string compare), `gte`
  (numeric compare on parsed value), and `from`/`to` (compare against stored `mtime`).
- `api/server.ts`: parse the new params (repeatable `eq`/`gte`, `from`/`to`) into the filter object.

Filters apply to all three search modes (semantic, lexical, hybrid) via the shared filter object.

### 1.3 Result metadata

Results stay generic: `{ path, section, score, source }`. Optionally include matched frontmatter
fields only if cheap; not required for Phase B.

### 1.4 Tests (vitest)

- `search.test.ts`: `eq` / `gte` / date-range filter behavior across semantic/lexical/hybrid.
- `storage.test.ts`: frontmatter JSON round-trips; migration is idempotent.
- `indexer.test.ts`: scalar frontmatter captured, non-scalar (objects/arrays except tags) skipped.

## Part 2 — Memory plugin changes (layer on top)

### 2.1 Backend

- `_lib/backend.py`: add `semantic_search(query, limit, filters)` → POST/GET `/semantic/search/semantic`
  with generic params. Keep `search()` (lexical) on built-in `/search/` for now; `search_smart()`
  retained only as **fallback** target.
- Map domain → generic in `hybrid_search.py` (memory-owned):
  - `--type decision|lesson|hub|session|context|idea|link` → `eq=type:<frontmatter-type>` when the
    note's frontmatter `type` is reliable, else keep current path-substring post-filter. (Decision:
    keep path-substring as the dependable default; add `eq=type:` only where frontmatter type is
    canonical. Documented per type in the plan.)
  - `importance>=N` → `gte=importance:N`
  - `sub_type:X` → `eq=sub_type:X`
  - `valid_until:ongoing` → `eq=valid_until:ongoing`
  - `--from/--to` → `from`/`to` (this fixes today's no-op date filter)

### 2.2 Ranking stays in memory

`hybrid_search.py` keeps RRF (k=60), importance-boost (×1.5 for `importance>=4`), path-keyword
anchoring, dedup-by-base-file. Only the **semantic source** changes (smart-connections → bge-m3).
Server-side filters reduce the candidate set before RRF; memory-side boosting runs on what returns.

### 2.3 Fallback

Wrapper around the semantic call: on HTTP 404 / connection error / non-OK, fall back to
`backend.search_smart()` (mcp-tools) and, if that is also unavailable, to built-in `/search/`.
Tag the response `backend: "semantic" | "fallback:mcp-tools" | "fallback:lexical"` so the agent
knows which path served it.

### 2.4 Timeout

`config.REQUEST_TIMEOUT` is 10s. bge-m3 query embedding is currently slow (VRAM contention being
fixed on the embedding host). Use a **separate, higher timeout for semantic calls** (default 60s,
env-overridable) so transient slowness does not spuriously trigger fallback. Lexical/CRUD keep 10s.

### 2.5 Tests (pytest)

- backend `semantic_search` builds correct params; parses plugin response shape.
- domain→generic filter mapping (type/importance/sub_type/valid_until/date).
- fallback chain on 404 / connection error (mock `requests`).

## Data flow (example)

`mem search hybrid "why tortoise orm" --path Aspects/ --type decision --importance 4`
→ map: `eq=type:decision`, `gte=importance:4`, `path=Aspects/`
→ `GET /semantic/search?q=why+tortoise+orm&path=Aspects/&eq=type:decision&gte=importance:4`
→ plugin: hybrid RRF over filtered candidates → `[{path,section,score,source}]`
→ memory: importance-boost + path-anchoring + dedup → ranked list
→ agent.

## Error handling

- Plugin unavailable / route 404 → fallback chain (2.3), response flagged.
- Self-signed TLS → `verify=False` (unchanged).
- Dimension mismatch (provider/model changed) → plugin returns its existing error; memory surfaces
  it verbatim and falls back. (Reindex is an operator action, out of scope here.)

## Out of scope (separate specs)

- Phase A: extract memory plugin into its own repo + own marketplace (OpenViking-style layout).
- Phase C: multi-agent (Hermes etc.) onboarding.
- Replacing the memory-side RRF with server-side hybrid (kept in memory to preserve domain ranking).
- Removing mcp-tools / smart-connections (retained as fallback).

## Success criteria

1. `mem search smart` / `hybrid` return bge-m3-backed results via the plugin (verified: results
   match, `backend: "semantic"`).
2. Domain filters (`--type`, `--importance`, `--from/--to`) work end-to-end; date filter is no
   longer a no-op.
3. With the plugin stopped, `mem search` still returns results via fallback, flagged as such.
4. Plugin vitest + memory pytest green. Plugin API stays free of memory vocabulary.
