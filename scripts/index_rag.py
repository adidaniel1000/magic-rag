import json

from rag_core import INDEX_PATH, build_index


if __name__ == "__main__":
    index = build_index()
    print(
        json.dumps(
            {
                "index_path": str(INDEX_PATH),
                "entry_count": index["entry_count"],
                "embedding": index["embedding"],
            },
            indent=2,
        )
    )
