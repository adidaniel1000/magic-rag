from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from threading import Barrier, Event
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import rag_core as rag


def original_embedding(text):
    vector = [0.0] * 512
    for token in rag.tokenize(text):
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        vector[int.from_bytes(digest[:4], "big") % 512] += 1.0
    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm else vector


class RagIndexTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        self.index = self.root / "index" / "rag.db"
        for key, value in (("PROJECT_ROOT", self.root), ("RAW_DIR", self.raw), ("INDEX_PATH", self.index)):
            context = patch.object(rag, key, value)
            context.start()
            self.addCleanup(context.stop)

    def write(self, name, text):
        path = self.raw / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def reference(self, query, top_k=4, min_score=0.08):
        qv = original_embedding(query)
        qt = set(rag.tokenize(query))
        if not qt:
            return []
        results = []
        # Read in stored order to reproduce the original traversal tie-break.
        with closing(sqlite3.connect(self.index)) as db:
            for path, chunk, text in db.execute("SELECT path, chunk, text FROM chunks ORDER BY id"):
                tokens = set(rag.tokenize(f"{path} {text}"))
                overlap = len(tokens & qt) / len(qt)
                if not overlap:
                    continue
                vector = original_embedding(f"{path}\n{text}")
                score = 0.75 * sum(a*b for a, b in zip(qv, vector)) + 0.25 * overlap
                if score >= min_score:
                    results.append(dict(score=score, path=path, chunk=chunk, text=text))
        results.sort(key=lambda r: r["score"], reverse=True)
        return results[:top_k]

    def test_ranking_matches_original_and_uses_all_candidates(self):
        self.write("architecture.md", "Python architecture server server deployment café!")
        self.write("deployment.json", '{"service": "sqlite search deployment", "port": 8000}')
        self.write("nested/onlyfilename.txt", "Bananas and oranges.")
        self.write("long.txt", " ".join(f"token{i % 29}" for i in range(700)))
        metadata = rag.build_index()
        self.assertNotIn("entries", metadata)
        self.assertEqual(metadata["file_count"], 4)
        for query in ("server server deployment", "architecture", "onlyfilename", "token17 token2",
                      "sqlite OR \"port\"*", "zzzzunmatched", "", "!!!", "the and", "café"):
            for top_k, threshold in ((1, 0), (4, .08), (20, .5), (4, 1)):
                with self.subTest(query=query, top_k=top_k, threshold=threshold):
                    actual = rag.search(query, top_k, threshold)
                    expected = self.reference(query, top_k, threshold)
                    self.assertEqual([(r["path"], r["chunk"]) for r in actual],
                                     [(r["path"], r["chunk"]) for r in expected])
                    for a, e in zip(actual, expected):
                        self.assertAlmostEqual(a["score"], e["score"], delta=1e-6)

    def test_embeddings_and_chunk_boundaries_are_unchanged(self):
        for text in ("", "!!!", "A server server servers 123", "café python" * 50):
            self.assertEqual(rag.embed_text(text), original_embedding(text))
        for size in (0, 1, 179, 180, 181, 320, 321, 999):
            words = [f"word{i}" for i in range(size)]
            expected = []
            for start in range(0, len(words), 140):
                expected.append(" ".join(words[start:start+180])[:1400])
                if start + 180 >= len(words):
                    break
            self.assertEqual(list(rag.chunk_text(" \n ".join(words))), expected)

    def test_configured_folders_are_indexed_without_duplicates(self):
        self.write("excluded.txt", "excludedword")
        small = self.root / "small"
        wiki = self.root / "wikitext"
        small.mkdir()
        (wiki / "nested").mkdir(parents=True)
        (small / "same.txt").write_text("smallword", encoding="utf-8")
        (wiki / "nested" / "same.md").write_text("wikiword", encoding="utf-8")
        (wiki / "ignored.csv").write_text("ignoredword", encoding="utf-8")
        (self.root / "magic_rag_settings.json").write_text(json.dumps({
            "folders": [str(small), "wikitext", "wikitext/nested", str(small)],
        }), encoding="utf-8")

        metadata = rag.build_index()
        self.assertEqual(metadata["file_count"], 2)
        self.assertEqual(metadata["source_dirs"], ["small", "wikitext", "wikitext/nested", "small"])
        self.assertEqual(rag.search("smallword")[0]["path"], "small/same.txt")
        self.assertEqual(rag.search("wikiword")[0]["path"], "wikitext/nested/same.md")
        self.assertEqual(rag.search("excludedword ignoredword"), [])

    def test_explicit_raw_dir_overrides_configured_folders(self):
        self.write("guide.txt", "architecture")
        (self.root / "magic_rag_settings.json").write_text(
            json.dumps({"folders": []}), encoding="utf-8",
        )
        self.assertEqual(rag.build_index()["file_count"], 0)
        self.assertEqual(rag.build_index(raw_dir=self.raw)["file_count"], 1)

    def test_invalid_folders_preserve_existing_index(self):
        self.write("guide.txt", "architecture")
        rag.build_index()
        for folders in ("raw", [""], [123], None):
            with self.subTest(folders=folders):
                (self.root / "magic_rag_settings.json").write_text(
                    json.dumps({"folders": folders}), encoding="utf-8",
                )
                with self.assertRaisesRegex(ValueError, "folders"):
                    rag.build_index()
                self.assertEqual(len(rag.search("architecture")), 1)

    def test_ties_follow_index_order(self):
        self.write("repeat.txt", "echo " * 320)
        rag.build_index()
        matches = rag.search("echo", top_k=20)
        self.assertEqual([m["chunk"] for m in matches], [1, 2])
        self.assertEqual(matches[0]["score"], matches[1]["score"])

    def test_best_match_after_500_candidates_is_not_discarded(self):
        paths = [self.write(f"noise{i}.txt", "needle " + "noise " * 100) for i in range(600)]
        paths.append(self.write("winner.txt", "needle " * 100))
        with patch.object(rag, "iter_source_files", return_value=iter(paths)):
            rag.build_index()
        self.assertEqual(rag.search("needle", top_k=1)[0]["path"], "raw/winner.txt")

    def test_blank_and_stopword_queries_do_not_build(self):
        for query in ("", " ", "?!", "the and", None):
            self.assertEqual(rag.search(query), [])
        self.assertFalse(self.index.exists())

    def test_rebuild_add_edit_delete_and_empty_collection(self):
        first = self.write("first.txt", "oldword")
        deleted = self.write("deleted.txt", "removedword")
        rag.build_index()
        first.write_text("newword", encoding="utf-8")
        deleted.unlink()
        added = self.write("added.txt", "addedword")
        rag.build_index()
        for query in ("oldword", "removedword"):
            self.assertEqual(rag.search(query), [])
        for query in ("newword", "addedword"):
            self.assertEqual(len(rag.search(query)), 1)
        first.unlink()
        added.unlink()
        self.assertEqual(rag.build_index()["entry_count"], 0)
        self.assertEqual(rag.search("newword"), [])

    def test_failed_rebuild_rolls_back_and_legacy_json_is_untouched(self):
        source = self.write("guide.txt", "originalword")
        rag.build_index()
        legacy = self.index.with_name("vector_index.json")
        legacy.write_text("legacy sentinel", encoding="utf-8")
        source.write_text("replacementword", encoding="utf-8")
        with patch.object(rag, "_insert_batch", side_effect=OSError("disk failure")):
            with self.assertRaisesRegex(OSError, "disk failure"):
                rag.build_index()
        self.assertEqual(len(rag.search("originalword")), 1)
        self.assertEqual(rag.search("replacementword"), [])
        self.assertEqual(legacy.read_text(encoding="utf-8"), "legacy sentinel")

    def test_concurrent_initial_searches_build_once(self):
        self.write("guide.txt", "architecture")
        barrier = Barrier(4)
        def query():
            barrier.wait(timeout=10)
            return rag.search("architecture")
        with patch.object(rag, "_create_schema", wraps=rag._create_schema) as create:
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: query(), range(4)))
            self.assertEqual(create.call_count, 1)
        self.assertTrue(all(len(result) == 1 for result in results))

    def test_reader_sees_old_index_during_rebuild_then_new_index(self):
        source = self.write("guide.txt", "originalword")
        rag.build_index()
        source.write_text("replacementword", encoding="utf-8")
        entered, release = Event(), Event()
        original_insert = rag._insert_batch
        def paused_insert(db, batch):
            original_insert(db, batch)
            entered.set()
            if not release.wait(timeout=10):
                raise TimeoutError("test reader did not finish")
        with ThreadPoolExecutor(max_workers=1) as pool:
            with patch.object(rag, "_insert_batch", side_effect=paused_insert):
                future = pool.submit(rag.build_index)
                try:
                    self.assertTrue(entered.wait(timeout=10))
                    self.assertEqual(len(rag.search("originalword")), 1)
                    self.assertEqual(rag.search("replacementword"), [])
                finally:
                    release.set()
                future.result(timeout=10)
        self.assertEqual(rag.search("originalword"), [])
        self.assertEqual(len(rag.search("replacementword")), 1)

    def test_separate_processes_can_create_and_query_first_index(self):
        self.write("guide.txt", "architecture")
        code = """
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import rag_core as rag
rag.PROJECT_ROOT = Path(sys.argv[2])
rag.RAW_DIR = rag.PROJECT_ROOT / 'raw'
rag.INDEX_PATH = rag.PROJECT_ROOT / 'index' / 'rag.db'
print(json.dumps(rag.search('architecture')))
"""
        children = []
        try:
            for _ in range(3):
                children.append(subprocess.Popen(
                    [sys.executable, "-c", code, str(Path(rag.__file__).parent), str(self.root)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                ))
            for child in children:
                output, errors = child.communicate(timeout=20)
                self.assertEqual(child.returncode, 0, errors)
                self.assertEqual(len(json.loads(output)), 1)
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.communicate()

    def test_invalid_schema_and_corrupt_database_report_errors(self):
        rag.build_index()
        with closing(sqlite3.connect(self.index)) as db:
            metadata = json.loads(db.execute("SELECT metadata FROM index_state").fetchone()[0])
            metadata["version"] = -1
            db.execute("UPDATE index_state SET metadata=?", (json.dumps(metadata),))
            db.commit()
        with self.assertRaisesRegex(ValueError, "rebuild"):
            rag.search("architecture")
        self.index.write_bytes(b"not a sqlite database")
        with self.assertRaises(sqlite3.DatabaseError):
            rag.search("architecture")


if __name__ == "__main__":
    unittest.main()
