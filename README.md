# Semantic Search for Obsidian

Hybrid **semantic + lexical** search over your vault. Combines vector similarity (embeddings)
with full-text search (SQLite FTS5) via Reciprocal Rank Fusion, so you find notes by *meaning*
and by *keyword* at once. Embeddings come from a provider you choose — fully local (ONNX, no
network) or a remote API. Exposes a REST API and a "connections" sidebar of related notes.

> Rewritten in TypeScript from the original Rust/WASM plugin. No Rust toolchain required.

## Features

- **Hybrid search** — semantic (cosine over embeddings) + lexical (FTS5), fused with RRF.
- **Pluggable embedding providers** — Local (ONNX, in-browser, zero-config), TEI, Ollama, OpenAI.
- **Persistent vector store** — SQLite (`sql.js-fts5`) saved to the plugin folder; survives restarts.
- **Incremental auto-indexing** — debounced reindex on vault create/modify/delete/rename; skips unchanged files by mtime.
- **Connections panel** — right sidebar showing notes similar to the active file.
- **REST API** — `/semantic/*` routes mounted on the Local REST API plugin, with tag/path filters.
- **Multilingual** — default local model supports 50+ languages (incl. Russian).

## Quickstart

1. Install (see below) and enable the plugin.
2. Open **Settings → Semantic Search**, pick an **Embedding Provider**:
   - **Local** — zero config, runs ONNX in-browser.
   - **Ollama / TEI / OpenAI** — set host/model/key, then **Test provider**.
3. Click **Start** (or enable **Auto-start on launch**).
4. Click **Reindex vault** to build the index.
5. Run the **Search (semantic)** command, or open the connections panel from the ribbon.

## Commands

| Command | Description |
|---------|-------------|
| Search (semantic) | Open the hybrid search modal. |
| Reindex vault | Full index of all markdown files (skips unchanged by mtime). |
| Validate & repair index | Remove orphaned entries, reindex outdated files. |
| Toggle connections panel | Show/hide the related-notes sidebar. |

## Configuration

| Setting | Description |
|---------|-------------|
| Provider | `local` (ONNX), `tei`, `ollama`, or `openai`. |
| Local model | `multilingual-MiniLM-L12` (384d, multilingual) or `all-MiniLM-L6` (384d, English). |
| TEI / Ollama host, port, model, API key | Connection for remote providers. API key optional. |
| OpenAI API key / model | e.g. `text-embedding-3-small`. |
| Batch size | Texts embedded per API call. |
| Auto-start on launch | Initialize the provider when Obsidian starts. |
| Auto-index on file changes | Reindex notes as you edit them (debounced 2s). |
| Ignored folders | One folder path per line; excluded from indexing. |
| Show connections panel | Right-sidebar related-notes view. |
| Expose REST API | Register `/semantic/*` routes on Local REST API (port 27124). |
| Debug mode | Verbose logging. |

> Changing the provider or model changes the embedding dimension. After such a change, run
> **Clear index** then **Reindex vault** — mixing dimensions raises a "Reindex required" error.

## REST API

Requires the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin
and **Expose REST API** enabled. Routes (port 27124, bearer-authed except health):

| Route | Description |
|-------|-------------|
| `GET /semantic/health` | Liveness + provider name (public). |
| `GET /semantic/status` | Index stats, provider, embedding dimension. |
| `GET /semantic/tags` | All indexed tags. |
| `GET /semantic/search?q=&limit=` | Hybrid search. |
| `GET /semantic/search/semantic?q=&limit=` | Semantic-only. |
| `GET /semantic/search/lexical?q=&limit=` | Lexical-only. |

Filters (query params): `path=` (path prefix), `tags=`, `excludeTags=` (comma-separated).

## Installing

### Via BRAT (recommended for this fork)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin.
2. BRAT → **Add Beta plugin** → `StepanchukYI/obsidian-semantic-search`.
3. Enable **Semantic Search** in community plugins. BRAT keeps it auto-updated.

### Manual

1. Download `manifest.json`, `main.js`, `styles.css` (and `sql-wasm.wasm`) from the
   [latest release](https://github.com/StepanchukYI/obsidian-semantic-search/releases).
2. Copy them into `<vault>/.obsidian/plugins/obsidian-semantic-search/`.
3. Reload Obsidian and enable the plugin under Settings → Community plugins.

## Development

```bash
npm install
npm run dev      # watch build
npm test         # vitest
npm run build    # production bundle
```

See [CLAUDE.md](CLAUDE.md) for architecture and the load-bearing esbuild post-build patches.

## License

MIT. Forked from [bbawj/obsidian-semantic-search](https://github.com/bbawj/obsidian-semantic-search);
original idea inspired by [Robert's GPT-for-second-brain post](https://reasonabledeviations.com/2023/02/05/gpt-for-second-brain/).
