# Verification record

Verified on 2026-09-18 using Windows 11 Pro (10.0.26200), an Intel Core Ultra 5 225F CPU, and Node.js 24.12.0 x64. Inference uses CPU only. Detailed local reports and screenshots are generated in `artifacts/` (excluded from Git).

## Automated checks

| Check | Result |
|---|---|
| TypeScript type check and production build | Passed |
| Unit and integration suite | 44 tests passed across four files |
| Unauthenticated local HTTP MCP | Passed: concurrent SDK clients, both search tools, operation without remote configuration, Host/Origin rejection, request-size limits, authenticated administration, and no public-gateway bypass |
| Browser workflow | Passed in installed Google Chrome at desktop and mobile sizes |
| Real embedding/storage smoke | Passed, including a fresh pinned-artifact download and lossless Unicode splitting |
| Offline evaluation | Passed with remote model loading disabled |
| Isolated npm archive installation | Passed on Windows; installed 231 runtime packages, then exercised real-model retrieval, packaged UI assets, stdio MCP and clean service shutdown |
| Installer syntax | Windows PowerShell parser accepted `public/install.ps1` |

Coverage includes document formats and malformed inputs, PDF page provenance/OCR rejection, DOCX archive limits, parser-worker timeout, full long-section preservation, SQLite migrations, atomic updates/deletion, per-source permissions, source boundaries and junctions, move reuse, watcher edits/deletes, unavailable roots, restart recovery, model-version rebuilding, query-cache isolation, ranking, empty results, serialized context budgets, CSRF, hostile Host/Origin, OAuth discovery/PKCE/audience/redirects, authorization-code and refresh replay, revocation, concurrent MCP clients, stopped-service behavior, and tunnel cancellation/owned-child cleanup.

Browser checks cover onboarding, cancelled folder selection through a platform test adapter, indexing status, search, the local MCP address and clipboard copy, configuration previews and cancellation, a tunnel configuration failure, and mobile overflow. The Windows folder dialog itself still needs a manual usability check. Client configuration tests use temporary files, including preservation, backups, and concurrent-edit protection.

## Retrieval evaluation

The evaluation corpus contains 60 synthetic source documents with 300 labeled queries: 100 personal/document, 100 enterprise/wiki, and 100 code-navigation queries. Query templates deliberately form a reproducible regression baseline; results are not an independently judged production retrieval benchmark.

Fixtures and labels are in `tests/fixtures/evaluation.ts` and `tests/fixtures/evaluation-queries.json`. The pinned quantized MiniLM model is used for every evaluation query. Recall measures whether the expected document appears within the first ten unique returned documents. MRR uses its reciprocal rank; a missing document scores zero.

| Set | Queries | Recall@10 | MRR | Mean returned tokens | p95 retrieval |
|---|---:|---:|---:|---:|---:|
| Personal documents | 100 | 1.000 | 1.000 | 135.19 | 11 ms |
| Enterprise/wiki | 100 | 0.990 | 0.980 | 160.95 | 13 ms |
| Code navigation | 100 | 0.930 | 0.930 | 164.29 | 37 ms |
| Overall | 300 | **0.9733** | **0.970** | **153.48** | **33 ms** |

Eight queries missed their expected document: one enterprise query and seven code-navigation queries. Overall nDCG@10 was 0.9709. The measured Recall@10 target of 0.90 is met on this fixture, including each category. This does not establish the same quality on an unseen private corpus. Token counts use `o200k_base` and include the emitted evidence framing and citations.

## Scale measurement

The separate scale benchmark uses 12,439 synthetic document records and 285,368 chunks to match the prior prototype's recorded corpus size. Representative embeddings come from the real local model but repeat across synthetic rows. This tests storage/retrieval load; it does not claim to reindex or measure semantic quality on the user's private corpus.

The final scale run built the fixture in 21.484 seconds, with a 655,994,880-byte database. Across 20 representative queries repeated three times, p50 was 636 ms and p95 was 800 ms. Considering only the two warm repetitions per query, p50 was **622 ms** and p95 was **775 ms**, below the one-second target. Mean returned context was 116.65 reference tokens. Hardware, source filtering, real vector distributions, background work, and corpus composition will affect performance.

## Delivery and remaining live checks

The tested npm archive, release manifest, SHA-256 checksum, PowerShell installer, landing page and guide are delivered in `public/`. The release process keeps the setup hostname unset until supplied with `--base-url` or `SECONDMIND_INSTALL_BASE`. The script intentionally refuses installation while that hostname is unset. Nothing has been published or deployed.

The packed installation test used an existing Node 24.12 runtime and copied the verified model cache into isolated application data. The separate cold-model smoke exercised the actual model download. The hosted `irm ... | iex` path, private Node-runtime download branch, and user-PATH changes have not been exercised end to end; those require a configured installation host and a clean Windows user environment.

The subsequent owner-authorized Cloudflare setup completed a live named-tunnel check on 2026-09-18: public DNS resolution and certificate-validated HTTPS passed; OAuth discovery returned 200; unauthenticated MCP returned 401; public administration paths returned 404. An official SDK client initialized over the public Streamable HTTP endpoint, listed both tools, and successfully searched a disposable document using the real embedding model. Revoking its scoped test token caused 401 responses. Test credentials were revoked and the temporary source and document were removed. The live result is recorded in `artifacts/live-tunnel-verification.json`.

Live Claude/ChatGPT account connections and a hosted HTTPS install remain environment-dependent checks. The installer hostname is intentionally deferred by the user and is separate from the configured MCP hostname. No installed AI-client configuration files or public registry entries were modified. The tunnel and DNS configuration were created under the owner's explicit setup request.

Before release to users, configure the installer origin and verify its one-liner from the hosted Pages site. Verify OAuth approval/search, revocation, reconnect and shutdown through actual Claude and ChatGPT accounts. The live tunnel and SDK checks do not establish vendor-account interoperability. The old Python entry points and setup examples were retired after their TypeScript replacements and the isolated package test passed; original documents, databases and local environments remain untouched.
