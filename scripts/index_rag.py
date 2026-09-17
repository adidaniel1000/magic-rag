import json
import argparse
import sys
import time

from rag_core import INDEX_PATH, build_index


def main():
    parser = argparse.ArgumentParser(description="Rebuild the local SQLite RAG index from raw/.")
    parser.parse_args()
    last_report = time.perf_counter()

    def progress(files, chunks):
        nonlocal last_report
        now = time.perf_counter()
        if now - last_report >= 5:
            print(f"Indexed {files:,} files / {chunks:,} chunks...", file=sys.stderr, flush=True)
            last_report = now

    index = build_index(progress=progress)
    print(
        json.dumps(
            {
                "index_path": str(INDEX_PATH),
                "entry_count": index["entry_count"],
                "embedding": index["embedding"],
                "file_count": index["file_count"],
                "build_seconds": round(index["build_seconds"], 3),
                "database_bytes": INDEX_PATH.stat().st_size,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
