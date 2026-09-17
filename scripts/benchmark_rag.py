"""Benchmark an existing SQLite index without modifying or rebuilding it."""

import argparse
from contextlib import closing
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import time

import rag_core as rag


# Synthetic queries spanning the current recipe, assignment, game, and wiki corpus.
DEFAULT_QUERIES = [
    "apple pie", "aglio olio", "almeirim stone soup", "chicken marinade", "bread yeast",
    "assignment deadline", "course schedule", "project tasks", "dataview query",
    "adrenaline pill", "artifact damage", "gatekeeper achievements", "adjuster",
    "valkyria chronicles", "little rock arsenal", "cicely mary barker",
    "gambia football team", "plain maskray", "columbus blue jackets", "national railway",
]
BROAD_QUERIES = ["raw", "wikitext", "people history"]


def measure(query):
    started = time.perf_counter()
    matches = rag.search(query)
    return {"ms": (time.perf_counter() - started) * 1000, "matches": len(matches)}


def p95(values):
    return sorted(values)[math.ceil(len(values) * .95) - 1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=rag.INDEX_PATH)
    parser.add_argument("--queries", type=Path, help="JSON array of representative query strings")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", type=Path, help="Save the JSON report here")
    parser.add_argument("--single", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    rag.INDEX_PATH = args.index.resolve()
    if not rag.INDEX_PATH.is_file():
        parser.error("Build the SQLite index first with build_index.bat")
    if args.single is not None:
        print(json.dumps(measure(args.single)))
        return
    queries = json.loads(args.queries.read_text(encoding="utf-8")) if args.queries else DEFAULT_QUERIES
    if not isinstance(queries, list) or not queries or not all(isinstance(q, str) and rag.tokenize(q) for q in queries):
        parser.error("--queries must contain a nonempty array of searchable strings")
    with closing(rag._connect(rag.INDEX_PATH, readonly=True, vectors=False)) as db:
        metadata = rag._metadata(db)
        if metadata is None:
            parser.error("Index has no completed build; run build_index.bat first")
        rag._validate_metadata(metadata)
        rows = []
        for kind, group in (("representative", queries), ("broad", BROAD_QUERIES)):
            for query in group:
                child = subprocess.run(
                    [sys.executable, str(Path(__file__).resolve()), "--index", str(rag.INDEX_PATH), "--single", query],
                    capture_output=True, text=True, check=True, timeout=120,
                )
                fresh = json.loads(child.stdout)
                measure(query)
                warm = [measure(query)["ms"] for _ in range(args.repeats)]
                candidates = db.execute(
                    "SELECT count(DISTINCT doc) FROM chunk_vocab WHERE term IN (SELECT value FROM json_each(?))",
                    (json.dumps(sorted(set(rag.tokenize(query)))),),
                ).fetchone()[0]
                row = {
                    "kind": kind, "query": query, "candidates": candidates,
                    "matches": fresh["matches"], "fresh_process_ms": fresh["ms"],
                    "warm_ms": warm, "warm_median_ms": statistics.median(warm),
                }
                rows.append(row)
                print(f"{kind}: {query!r}: {candidates:,} candidates, warm median {row['warm_median_ms']:.1f} ms",
                      file=sys.stderr, flush=True)
    normal = [row for row in rows if row["kind"] == "representative"]
    warm_all = [ms for row in normal for ms in row["warm_ms"]]
    report = {
        "index_path": str(rag.INDEX_PATH), "database_bytes": rag.INDEX_PATH.stat().st_size,
        "metadata": metadata, "query_count": len(queries), "repeats": args.repeats,
        "timing_note": "Fresh-process measurements time the first search, excluding interpreter/import startup. OS file caches are not flushed. Warm measurements include connection and retrieval work.",
        "warm_median_ms": statistics.median(warm_all), "warm_p95_ms": p95(warm_all),
        "fresh_process_p95_ms": p95([row["fresh_process_ms"] for row in normal]),
        "warm_p95_under_one_second": p95(warm_all) < 1000,
        "results": rows,
    }
    output = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
