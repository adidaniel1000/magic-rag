# Architecture

Second Mind is a foreground Node.js process serving a React application on loopback. Its modules share TypeScript domain contracts without importing vendor or MCP types into the retrieval core.

## Runtime boundaries

- `apps/service`: local HTTP service, CLI, indexing orchestration, OAuth provider, and tunnel management.
- `apps/web`: React/Vite interface. It has no direct filesystem, model, or database access.
- `packages`: core contracts, configuration, platform adapters, parsers, embeddings, storage, retrieval, and MCP tools.

The Windows adapter owns native folder selection, Explorer/browser opening, DPAPI protection, AI-client configuration paths, and child-process control. Shared code uses Node filesystem/path APIs. Only Windows x64 ships in this beta; no macOS adapter is supplied.

## Storage and indexing

Machine-local data lives under `%LOCALAPPDATA%\SecondMind`. SQLite uses WAL, foreign keys, transactional schema migrations, FTS5, and sqlite-vec. One service owns index writes. MCP shims only call the authenticated service. Schema versions newer than the application are refused.

Registered folder roots are canonicalized. Descendant symlinks and junctions are skipped, overlapping roots are rejected, and application data cannot be registered. Parsers preserve headings, paragraphs, code symbols, page numbers, and line positions where available. DOCX archive expansion is checked before parsing. PDF extraction does not perform OCR. Files are limited to 100 MB and ten million extracted characters by default.

Structural parent sections target 550 reference tokens. A pinned MiniLM WordPiece tokenizer splits embedding children to at most 220 tokens, below the model's 256-token window. Child text is never silently truncated. Complete structural parents, including long sections, are stored once per document with child references; candidate retrieval loads only bounded parents into memory. Document parsers run in a separate worker with a time limit and memory limit. The initial packer deduplicates excerpts and limits each document's contribution; it does not construct code dependency graphs.

The quantized model runs in a worker thread. Four model artifacts are downloaded from a pinned revision, SHA-256 verified, and subsequently loaded as local files with remote model loading disabled. The model is `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`, producing normalized 384-dimensional vectors.

Filesystem events are debounced. Reconciliation runs every five minutes and full hash verification hourly, plus a full pass on startup. Unavailable or partly unreadable folders do not trigger wholesale deletion. File updates replace metadata, chunks, lexical rows and vectors in one transaction. Content-addressed embedding reuse avoids inference for unchanged text and moves. Indexing can pause between units of work. Model setup failures retain previous working documents.

## Retrieval

The stable interface is `retrieve(principal, query, options)`. The browser, stdio shim and Streamable HTTP gateway use it. Source permissions and optional path/language filters apply to both candidate channels before ranking. Reciprocal rank fusion combines 30 vector and 30 lexical candidates by default, with 40 fused / 20 reranking candidates / 10 packed results. The no-op reranker is replaceable.

The relevance gate uses semantic similarity or an exact lexical-term match. Results may be empty. Code navigation emits short excerpts, symbols, lines, and the indexed Git commit. A reference `o200k_base` tokenizer measures the complete formatted context; counts can differ from a host model's tokenizer. MCP emits the context once, without duplicating snippets in structured output. Metadata and token counts remain available through the local API.

The query-vector cache contains only vectors, is bounded to 128 entries with a five-minute TTL, and never caches authorized result sets. Source/document existence and versions are checked before results leave retrieval. Query text and excerpt bodies are not persisted in logs.

## Public interfaces

- `secondmind [start|stop|status|mcp|hook]`, `--no-browser`, `--data-dir PATH`.
- Local: `POST /api/v1/retrieve` (`/api/search` alias); source, settings, diagnostics, progress SSE, client configuration, tunnel, and authorization management APIs.
- Remote gateway: `/mcp`, OAuth discovery and authorization endpoints only.
- MCP: `second_mind_search` and `second_mind_code_search`, accepting `query`, optional `max_tokens` and `source_ids`; general search also accepts `mode`.

Responses contain retrieval ID, context, reference-token count, latency, index version and result provenance. Document URIs use `secondmind://SOURCE_ID/encoded/relative/path` and are identifiers, not filesystem download endpoints.

## Distribution

The package bundles workspace code and compiled UI assets; native and third-party runtime dependencies remain npm dependencies. The static `public/` folder is suitable for Cloudflare Pages. Its PowerShell installer verifies release checksums, installs per-user, and provides a private Node runtime when needed. No public npm publication is required. Existing raw folders, legacy indexes and local Python environments are not touched.
