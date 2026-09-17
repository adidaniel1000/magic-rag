"""Check the SQLite features required by every retrieval entry point."""

from contextlib import closing
import sqlite3

import sqlite_vec


def main():
    if sqlite3.sqlite_version_info < (3, 41, 0):
        raise RuntimeError("SQLite 3.41+ is required; install a newer Python and rerun setup.")
    with closing(sqlite3.connect(":memory:")) as db:
        db.execute("CREATE VIRTUAL TABLE tokens USING fts5(terms)")
        db.enable_load_extension(True)
        try:
            sqlite_vec.load(db)
        finally:
            db.enable_load_extension(False)
        distance = db.execute("SELECT vec_distance_cosine('[1,0]', '[1,0]')").fetchone()[0]
        if distance != 0:
            raise RuntimeError("SQLite vector calculation failed.")
        version = db.execute("SELECT vec_version()").fetchone()[0]
    print(f"SQLite {sqlite3.sqlite_version}: FTS5 and sqlite-vec {version} verified.")


if __name__ == "__main__":
    main()
