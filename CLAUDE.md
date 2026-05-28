# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Obsidian plugin: hybrid semantic + lexical search over a vault, with pluggable embedding
providers, a persisted vector store, a connections sidebar, and a REST API mounted on the
Local REST API plugin. TypeScript, bundled to `main.js` by esbuild. `isDesktopOnly: true`.

Originally a Rust/WASM plugin (`bbawj/obsidian-semantic-search`), fully rewritten in TS — the
Rust toolchain references in old docs no longer apply.

## Commands

```bash
npm run dev          # esbuild watch, inline sourcemap (node esbuild.config.mjs)
npm run build        # production bundle (node esbuild.config.mjs production)
npm test             # vitest run
npm run test:watch   # vitest watch
npx vitest run src/search.test.ts          # single test file
npx vitest run -t "hybrid"                 # single test by name
./release.sh <version> <minObsidianVersion># bump package/manifest/versions.json, commit, tag, push
```

Test files live next to sources: `src/*.test.ts` (search, indexer, storage). vitest config in `vitest.config.ts`.

## Architecture

Entry `main.ts` (`SemanticSearch` plugin) wires five collaborators, all constructed in `onload`:

- **`VectorStorage`** (`src/storage.ts`) — `sql.js-fts5` (SQLite compiled to WASM) held in
  memory, exported to `<vault>/.obsidian/plugins/<id>/search.db` via the vault adapter on every
  `save()`. Two tables: `documents` (embeddings as Float32 BLOB + `tags` JSON) and `documents_fts`
  (FTS5 virtual table for lexical). Unique index on `(path, section)` drives upsert.
- **`Indexer`** (`src/indexer.ts`) — splits a note into sections by markdown headings
  (`splitSections`), re-splits chunks > 1500 chars on paragraph boundaries, embeds each section
  in batches, and upserts. `registerEvents` wires vault create/modify/delete/rename to a debounced
  (2s) reindex queue. `getOutdated` compares mtime to skip unchanged files.
- **`EmbeddingProvider`** (`src/providers/`) — one of `local` (ONNX via `@xenova/transformers`,
  runs in-browser, zero config), `tei`, `ollama`, `openai`. Selected by `settings.provider`,
  built in `initProvider`. **Each model has a fixed dimension** (bge-m3=1024, MiniLM=384,
  nomic=768, openai-3-small=1536).
- **`SearchEngine`** (`src/search.ts`) — `semanticSearch` (cosine over all stored embeddings),
  `lexicalSearch` (FTS5), and `hybridSearch` (Reciprocal Rank Fusion, k=60; 1.5× boost when both
  backends return a candidate; `pathPrefix` weights matches 2× / non-matches 0.3×). Results are
  deduped to one hit per file.
- **`ApiServer`** (`src/api/server.ts`) — calls `getPublicApi` on the `obsidian-local-rest-api`
  plugin to mount routes: `/semantic/health` (public), `/semantic/status`, `/semantic/tags`,
  `/semantic/search`, `/semantic/search/semantic`, `/semantic/search/lexical` (authed, port 27124).
  If the REST plugin isn't loaded yet, registration retries on its `obsidian-local-rest-api:loaded` event.

Engine lifecycle: `autoStart` initializes the provider on launch; otherwise the user starts it
from settings. `validateIndex` removes orphaned DB entries (files deleted from vault) and reindexes
outdated ones — runs automatically after auto-start.

## Load-bearing gotchas

- **esbuild post-build patches** (`esbuild.config.mjs`, steps 1–4) rewrite the bundled
  `@xenova/transformers` / `onnxruntime-web` code to force browser/WASM mode in Electron. Without
  them the local provider crashes (tries `onnxruntime-node`, `worker_threads`, `fs`). Do not remove
  or "clean up" these regex replacements; if you bump those deps, re-verify the patterns still match.
- **`main.js` is gitignored** — it ships as a GitHub *release* asset, not in the repo. A BRAT /
  community install needs `manifest.json`, `main.js`, and `styles.css` in the release.
- **`data.json` is gitignored** — it holds provider API keys (settings). Never commit it.
- **`sql-wasm.wasm` must exist in the plugin dir at runtime** — `VectorStorage.init` loads it via
  the vault adapter from beside `search.db`. Ship it alongside the other plugin files.
- **Switching provider or model changes embedding dimension** → `cosineSimilarity` throws
  `Dimension mismatch ... Reindex required`. After any provider/model change, run "Clear index"
  then "Reindex vault".
