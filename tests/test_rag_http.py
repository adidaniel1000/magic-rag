import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

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


if __name__ == "__main__":
    unittest.main()
