"""Dashboard coverage uses isolated installations, never the user's documents or index."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
from rag_dashboard import Dashboard, DashboardError
from rag_runtime import inspect_instance
from rag_platform import terminate_child
from rag_settings import atomic_json, load_settings, save_settings
from rag_ui import DashboardHTTPServer


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(check, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.04)
    raise AssertionError("Timed out waiting for the test process")


class InstallationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        for source in (PROJECT_ROOT / "scripts").glob("*.py"):
            shutil.copyfile(source, self.root / "scripts" / source.name)
        (self.root / "raw").mkdir()
        (self.root / "raw" / "guide.md").write_text(
            "Architecture uses a local SQLite knowledge index. Café reference. <script>alert('example')</script>", encoding="utf-8",
        )
        self.port = free_port()
        self.ui_port = free_port()
        while self.ui_port == self.port:
            self.ui_port = free_port()
        atomic_json(self.root / "magic_rag_settings.json", {
            "folders": ["raw"], "mcp_port": self.port, "ui_port": self.ui_port, "future_setting": {"keep": True},
        })
        self.app = Dashboard(self.root, self.ui_port)
        self.addCleanup(self.app.close)

    def start(self):
        self.app.start_mcp()
        wait_for(lambda: self.app.snapshot()["mcp"]["state"] == "running")

    def stop(self):
        self.app.stop_mcp()
        wait_for(lambda: self.app.snapshot()["mcp"]["state"] == "stopped")


class SettingsTests(InstallationTest):
    def test_defaults_legacy_and_unknown_settings_are_preserved(self):
        atomic_json(self.root / "magic_rag_settings.json", {"folders": ["raw"], "custom": 42})
        self.assertEqual(load_settings(self.root)["mcp_port"], 32187)
        self.assertEqual(load_settings(self.root)["ui_port"], 32188)
        saved = save_settings({"mcp_port": 32189}, self.root)
        self.assertEqual(saved["custom"], 42)
        self.assertEqual(saved["folders"], ["raw"])

    def test_invalid_ports_and_folders_never_overwrite_file(self):
        path = self.root / "magic_rag_settings.json"
        before = path.read_bytes()
        for change in ({"mcp_port": 0}, {"mcp_port": 65536}, {"mcp_port": True},
                       {"mcp_port": "32187"}, {"mcp_port": self.ui_port},
                       {"folders": ["raw", str(self.root / "raw")]},
                       {"folders": ["missing"]}, {"folders": [""]}, {"folders": "raw"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                save_settings(change, self.root)
            self.assertEqual(path.read_bytes(), before)

    def test_malformed_settings_are_reported_without_replacement(self):
        path = self.root / "magic_rag_settings.json"
        path.write_text('{"folders": invalid}', encoding="utf-8")
        self.app.refresh_settings()
        self.assertTrue(self.app.snapshot()["settings_error"])
        with self.assertRaises(ValueError):
            self.app.update_settings({"mcp_port": free_port()})
        self.assertEqual(path.read_text(), '{"folders": invalid}')

    def test_add_edit_remove_and_unavailable_folder(self):
        other = self.root / "other"
        other.mkdir()
        self.app.update_settings({"folders": ["raw", str(other)]})
        self.assertEqual(len(self.app.snapshot()["folders"]), 2)
        self.app.update_settings({"folders": ["other"]})
        self.assertTrue((self.root / "raw" / "guide.md").exists())
        other.rmdir()
        self.app.refresh_settings()
        self.assertFalse(self.app.snapshot()["folders"][0]["available"])
        with self.assertRaisesRegex(DashboardError, "Unavailable"):
            self.app.build_index()
        self.app.update_settings({"folders": []})
        self.assertEqual(load_settings(self.root)["folders"], [])

    def test_unavailable_sources_can_be_removed_one_at_a_time(self):
        settings = load_settings(self.root)
        atomic_json(self.root / "magic_rag_settings.json", {**settings, "folders": ["missing-one", "missing-two"]})
        self.app.refresh_settings()
        self.app.update_settings({"folders": ["missing-two"]})
        self.assertEqual(load_settings(self.root)["folders"], ["missing-two"])


class ProcessAndPlaygroundTests(InstallationTest):
    def test_real_query_pending_port_restart_and_connectors(self):
        self.start()
        result = self.app.playground_query("architecture")
        self.assertEqual(result["state"], "success")
        self.assertIn("raw/guide.md#chunk-1", result["text"])
        self.assertIn("<script>", result["text"])
        self.assertIn("content", result["result"])
        self.assertTrue(self.app.snapshot()["index"]["last_build"])
        self.assertEqual(self.app.playground_query("zzzzunmatched")["state"], "no_matches")
        new_port = free_port()
        self.app.update_settings({"mcp_port": new_port})
        status = self.app.snapshot()
        self.assertTrue(status["mcp"]["pending_port"])
        self.assertIn(f":{self.port}/mcp", status["connectors"][0]["commands"])
        self.assertIn(f":{self.port}/mcp", self.app.playground_query("architecture")["endpoint"])
        self.stop()
        self.assertIn(f":{new_port}/mcp", self.app.snapshot()["connectors"][1]["commands"])
        self.start()
        self.assertIn(f":{new_port}/mcp", self.app.playground_query("architecture")["endpoint"])

    def test_concurrent_start_has_only_one_owner(self):
        def start_once():
            try:
                self.app.start_mcp()
                return True
            except DashboardError as error:
                self.assertEqual(error.status, 409)
                return False
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: start_once(), range(3)))
        self.assertEqual(results.count(True), 1)
        wait_for(lambda: self.app.snapshot()["mcp"]["state"] == "running")
        self.assertEqual(inspect_instance(self.root)["instance_id"], self.app.mcp_instance_id)

    def test_port_in_use_and_startup_failure(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", self.port))
            occupied.listen()
            with self.assertRaisesRegex(DashboardError, "in use"):
                self.app.start_mcp()
            self.assertIsNone(self.app.mcp_process)
        (self.root / "scripts" / "rag_mcp.py").write_text("raise RuntimeError('startup sentinel')", encoding="utf-8")
        self.app.start_mcp()
        wait_for(lambda: self.app.snapshot()["mcp"]["state"] == "failed")
        wait_for(lambda: "startup sentinel" in (self.app.snapshot()["mcp"]["error"] or ""))

    def test_unexpected_exit_and_shutdown(self):
        self.start()
        process = self.app.mcp_process
        terminate_child(process)
        process.wait(timeout=5)
        self.assertEqual(self.app.snapshot()["mcp"]["state"], "failed")
        self.start()
        process = self.app.mcp_process
        self.app.close()
        self.assertIsNotNone(process.poll())
        self.assertIsNone(inspect_instance(self.root))

    def test_external_instance_blocks_second_port_and_is_never_stopped(self):
        external = subprocess.Popen(
            [sys.executable, str(self.root / "scripts" / "rag_mcp.py"), "--transport", "streamable-http"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        def cleanup():
            terminate_child(external)
            external.communicate(timeout=5)
        self.addCleanup(cleanup)
        wait_for(lambda: self.app.snapshot()["mcp"]["state"] == "external")
        self.app.update_settings({"mcp_port": free_port()})
        with self.assertRaises(DashboardError):
            self.app.start_mcp()
        with self.assertRaisesRegex(DashboardError, "original console"):
            self.app.stop_mcp()
        duplicate = subprocess.run(
            [sys.executable, str(self.root / "scripts" / "rag_mcp.py"), "--transport", "streamable-http"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("already running", duplicate.stderr)
        self.app.close()
        self.assertIsNone(external.poll())

    def test_query_errors_validation_timeout_and_real_mcp_tool_error(self):
        with self.assertRaisesRegex(DashboardError, "Start MCP"):
            self.app.playground_query("architecture")
        for query in ("", " ", "x" * 10001, None):
            with self.assertRaises(DashboardError):
                self.app.playground_query(query)
        self.start()
        with patch.object(self.app, "_query_mcp", new=AsyncMock(side_effect=TimeoutError)):
            with self.assertRaises(DashboardError) as error:
                self.app.playground_query("architecture")
            self.assertEqual(error.exception.code, "timeout")
        with patch.object(self.app, "_query_mcp", new=AsyncMock(side_effect=ConnectionError("interrupted"))):
            with self.assertRaises(DashboardError) as error:
                self.app.playground_query("architecture")
            self.assertEqual(error.exception.code, "connection_error")
        (self.root / "index" / "rag.db").write_bytes(b"not a sqlite database")
        result = self.app.playground_query("architecture")
        self.assertEqual(result["state"], "tool_error")
        self.assertTrue(result["result"]["isError"])
        self.assertIn("retrieval failed", result["text"])


class IndexTests(InstallationTest):
    def test_real_index_build_and_folder_changes(self):
        self.app.build_index()
        wait_for(lambda: self.app.snapshot()["index"]["state"] != "running")
        status = self.app.snapshot()["index"]
        self.assertEqual(status["state"], "completed", status["error"])
        self.assertEqual(status["files"], 1)
        self.assertEqual(status["chunks"], 1)
        self.assertFalse(status["sources_changed"])
        self.app.update_settings({"folders": []})
        self.assertTrue(self.app.snapshot()["index"]["sources_changed"])

    def test_progress_duplicate_build_failed_build_and_shutdown(self):
        script = self.root / "scripts" / "index_rag.py"
        script.write_text("import sys, time\nprint('Indexed 1,234 files / 5,678 chunks...', file=sys.stderr, flush=True)\ntime.sleep(0.7)\nraise RuntimeError('index sentinel')\n", encoding="utf-8")
        self.app.build_index()
        with self.assertRaises(DashboardError):
            self.app.build_index()
        with self.assertRaisesRegex(DashboardError, "finish"):
            self.app.update_settings({"folders": []})
        wait_for(lambda: self.app.snapshot()["index"]["files"] == 1234)
        self.assertEqual(self.app.snapshot()["index"]["chunks"], 5678)
        wait_for(lambda: self.app.snapshot()["index"]["state"] == "failed")
        self.assertIn("index sentinel", self.app.snapshot()["index"]["error"])
        script.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
        self.app.build_index()
        self.app.close()
        self.assertIsNotNone(self.app.index_process.poll())


class ApiTests(InstallationTest):
    def setUp(self):
        super().setUp()
        self.static = self.root / "web" / "dist"
        self.static.mkdir(parents=True)
        (self.static / "index.html").write_text("<html>dashboard</html>", encoding="utf-8")
        self.server = DashboardHTTPServer(("127.0.0.1", 0), self.app, self.static)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        def close():
            self.server.shutdown()
            self.server.server_close()
            thread.join(timeout=3)
        self.addCleanup(close)

    def api(self, path, body=None, headers=None):
        request_headers = {"Origin": self.url, "Content-Type": "application/json", "X-Magic-Rag-Token": self.server.session_token}
        request_headers.update(headers or {})
        request = Request(self.url + path, data=json.dumps(body).encode() if body is not None else None, headers=request_headers)
        try:
            response = urlopen(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.read()

    def test_security_static_paths_body_validation_and_picker_cancellation(self):
        self.assertEqual(self.api("/")[0], 200)
        self.assertEqual(self.api("/api/session")[0], 200)
        self.assertEqual(self.api("/api/status", headers={"Origin": "https://hostile.example"})[0], 403)
        self.assertEqual(self.api("/api/status", headers={"Host": "hostile.example"})[0], 403)
        self.assertEqual(self.api("/api/mcp/start", {}, {"X-Magic-Rag-Token": "wrong"})[0], 403)
        self.assertEqual(self.api("/../magic_rag_settings.json")[0], 404)
        self.assertEqual(self.api("/%2e%2e/magic_rag_settings.json")[0], 404)
        self.assertEqual(self.api("/api/playground/query", {"query": "architecture", "url": "http://elsewhere"})[0], 400)
        self.assertEqual(self.api("/api/settings", [1, 2])[0], 400)
        before = load_settings(self.root)
        with patch("rag_ui.choose_folder", return_value=None):
            status, body = self.api("/api/folders/pick", {})
        self.assertEqual((status, json.loads(body)), (200, {"path": None}))
        self.assertEqual(load_settings(self.root), before)

    def test_api_query_and_refresh_do_not_stop_jobs(self):
        self.assertEqual(self.api("/api/mcp/start", {})[0], 200)
        wait_for(lambda: self.app.snapshot()["mcp"]["state"] == "running")
        self.assertEqual(self.api("/api/session")[0], 200)
        status, body = self.api("/api/playground/query", {"query": "architecture"})
        self.assertEqual(status, 200)
        self.assertIn("raw/guide.md", json.loads(body)["text"])
        self.assertEqual(self.api("/api/index/build", {})[0], 200)
        self.assertEqual(self.api("/api/status")[0], 200)
        wait_for(lambda: self.app.snapshot()["index"]["state"] == "completed")
        self.assertTrue(self.app.snapshot()["mcp"]["available"])


if __name__ == "__main__":
    unittest.main()
