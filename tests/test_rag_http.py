import io
import json
from pathlib import Path
import sys
import sqlite3
import tempfile
from threading import Thread
from http.server import HTTPServer
from urllib.request import Request, urlopen
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import rag
import rag_core
from rag import RagHandler


class RagResponseTests(unittest.TestCase):
    def make_handler(self):
        handler = RagHandler.__new__(RagHandler)
        handler.request_version = "HTTP/1.1"
        handler.command = "POST"
        handler.requestline = "POST /rag HTTP/1.1"
        handler.close_connection = False
        handler.log_message = Mock()
        handler.wfile = io.BytesIO()
        return handler

    def test_json_response_headers_and_body(self):
        handler = self.make_handler()
        payload = {"message": "Local context"}

        handler.send_json(200, payload)

        headers, body = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
        self.assertIn(b"HTTP/1.0 200 OK", headers)
        self.assertIn(b"Content-Type: application/json; charset=utf-8", headers)
        self.assertIn(f"Content-Length: {len(body)}".encode(), headers)
        self.assertEqual(json.loads(body), payload)

    def test_disconnect_during_headers_or_body_is_handled(self):
        for error_type in (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            for stage in ("headers", "body"):
                for status in (200, 400, 500):
                    with self.subTest(error=error_type, stage=stage, status=status):
                        handler = self.make_handler()
                        error = error_type("client disconnected")
                        handler.wfile = Mock()
                        handler.wfile.write.side_effect = (
                            [error] if stage == "headers" else [None, error]
                        )

                        handler.send_json(status, {"message": "test"})

                        self.assertTrue(handler.close_connection)
                        self.assertEqual(handler.wfile.write.call_count, 1 if stage == "headers" else 2)
                        handler.log_message.assert_called_with(
                            "Client disconnected before the response was sent"
                        )

    def test_unrelated_io_errors_are_not_suppressed(self):
        handler = self.make_handler()
        handler.wfile = Mock()
        handler.wfile.write.side_effect = OSError("unexpected I/O failure")

        with self.assertRaisesRegex(OSError, "unexpected I/O failure"):
            handler.send_json(200, {})

    def test_serialization_errors_are_not_suppressed(self):
        handler = self.make_handler()

        with self.assertRaises(TypeError):
            handler.send_json(200, {"invalid": object()})


class RagHookIntegrationTests(unittest.TestCase):
    def test_get_post_and_database_error_preserve_hook_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / "raw"
            raw.mkdir()
            (raw / "guide.txt").write_text("Architecture uses SQLite search.", encoding="utf-8")
            with patch.object(rag, "PROJECT_ROOT", root), \
                 patch.object(rag_core, "PROJECT_ROOT", root), \
                 patch.object(rag_core, "RAW_DIR", raw), \
                 patch.object(rag_core, "INDEX_PATH", root / "index" / "rag.db"), \
                 HTTPServer(("127.0.0.1", 0), RagHandler) as server:
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                url = f"http://127.0.0.1:{server.server_port}/rag"
                try:
                    for request in (
                        url + "?prompt=architecture",
                        Request(url, data=b'{"prompt":"architecture"}', headers={"Content-Type": "application/json"}),
                    ):
                        with urlopen(request, timeout=10) as response:
                            self.assertEqual(response.status, 200)
                            result = json.load(response)["hookSpecificOutput"]
                            self.assertEqual(result["hookEventName"], "UserPromptSubmit")
                            self.assertIn("raw/guide.txt#chunk-1", result["additionalContext"])
                    self.assertIn("SQLite", (root / "RAG.md").read_text(encoding="utf-8"))
                    with patch.object(rag, "search", side_effect=sqlite3.DatabaseError("broken database")):
                        with urlopen(url + "?prompt=architecture", timeout=10) as response:
                            self.assertEqual(response.status, 200)
                            self.assertIn("retrieval failed", json.load(response)["hookSpecificOutput"]["additionalContext"])
                    with urlopen(url + "?prompt=zzzzunmatched", timeout=10) as response:
                        self.assertEqual(json.load(response)["hookSpecificOutput"]["additionalContext"], "")
                finally:
                    server.shutdown()
                    thread.join(timeout=10)


if __name__ == "__main__":
    unittest.main()
