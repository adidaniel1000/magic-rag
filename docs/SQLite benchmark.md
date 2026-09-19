# SQLite migration verification

Measured on this Windows machine after the full source rebuild and database compaction.

| Measurement | Result |
| --- | ---: |
| Supported source files | 12,439 |
| Source data | 210.42 MB |
| Indexed chunks | 285,368 |
| SQLite database | 1,005.91 MB |
| Document build time, before final commit/checkpoint | 102.43 seconds |
| Initial database compaction and quick integrity check | 24.47 seconds |
| Representative queries | 20, each measured three times warm |
| Warm median | 13.08 ms |
| Warm p95 | 102.47 ms |
| First search in a fresh process, p95 | 128.48 ms |
| All-chunk query (`raw`), warm median | 508.01 ms |
| Broad corpus query (`wikitext`), warm median | 478.63 ms |
| Broad content query (`people history`), warm median | 186.77 ms |

MB uses decimal bytes. Query measurements include opening connections, loading the
SQLite vector extension, candidate selection, ranking, and fetching excerpts.
Fresh-process measurements exclude interpreter/import startup, and operating-system
file caches were not flushed; these are not uncached disk benchmarks. Queries are
synthetic examples spanning the recipe, assignment, game, and Wikipedia material
in this collection, not a sample of actual user traffic.

All matching candidates are scored. The `raw` query evaluates all 285,368 chunks.
The warm p95 goal of less than one second passed. The user's reported 40-second
JSON query was not remeasured, so it is not a controlled before/after comparison.

The database uses 32 KiB pages: the default 4 KiB pages wasted almost half of each
vector page because a 2 KiB vector plus row overhead prevented two rows fitting.
The first build used default pages and occupied 1,605.15 MB; it was compacted into
the final layout. Newly created databases now select the larger page size directly.

All 20 tests passed, covering reference ranking within a 1e-6 score tolerance,
chunk boundaries, matches beyond the first 500 candidates, blank queries, ties,
rebuild changes, rollback, concurrent threads/processes, reading during rebuild,
HTTP hooks, and both MCP transports. Float32 rounding may affect extremely close
ties or exact threshold boundaries. Setup was rerun successfully, and all three
launchers were checked from outside the project directory.

To repeat the benchmark from the project directory:

```powershell
python scripts\benchmark_rag.py --output index\benchmark.json
```

The generated report includes individual queries, candidate counts, and timings.
Use `--queries path\to\queries.json` to supply a JSON array of your own queries.
