"""Local process management and MCP client operations for the browser dashboard."""

import asyncio
from collections import deque
from contextlib import closing
import json
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

from mcp import Client

from rag_platform import child_options, connector_instructions, terminate_child
from rag_runtime import inspect_instance
from rag_settings import (DEFAULT_MCP_PORT, DEFAULT_UI_PORT, folder_statuses, load_settings,
                          resolve_folder, save_settings)


class DashboardError(Exception):
    def __init__(self, message, status=400, code="invalid_request"):
        super().__init__(message)
        self.status = status
        self.code = code


class Dashboard:
    def __init__(self, root, ui_port=DEFAULT_UI_PORT):
        self.root = Path(root).resolve()
        self.ui_port = ui_port
        self.lock = threading.RLock()
        self.closed = False
        self.settings = {"folders": [], "mcp_port": DEFAULT_MCP_PORT, "ui_port": DEFAULT_UI_PORT}
        self.settings_error = None
        self.folders = []
        self.mcp_process = None
        self.mcp_state = "stopped"
        self.mcp_port = None
        self.mcp_error = None
        self.mcp_logs = deque(maxlen=24)
        self.index_process = None
        self.index_job = {"state": "idle", "files": None, "chunks": None, "elapsed_seconds": 0, "error": None}
        self.index_started = None
        self.last_build = None
        self.index_error = None
        self.workers = []
        self.refresh_settings()
        self.refresh_index_metadata()

    def refresh_settings(self):
        with self.lock:
            try:
                self.settings = load_settings(self.root)
                self.folders = folder_statuses(self.settings, self.root)
                self.settings_error = None
            except (OSError, ValueError) as error:
                self.settings_error = str(error)
            return self.settings

    def refresh_index_metadata(self):
        metadata, error = None, None
        path = self.root / "index" / "rag.db"
        if path.exists():
            try:
                with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.2)) as db:
                    row = db.execute("SELECT metadata FROM index_state WHERE id=1").fetchone()
                    if row:
                        metadata = json.loads(row[0])
                        if not isinstance(metadata, dict) or not all(
                            key in metadata for key in ("file_count", "entry_count", "built_at", "build_seconds", "source_dirs")
                        ):
                            raise ValueError("Index metadata is invalid. Rebuild the index.")
            except (sqlite3.Error, ValueError) as exc:
                metadata, error = None, str(exc)
        with self.lock:
            self.last_build, self.index_error = metadata, error

    def _require_settings(self):
        self.refresh_settings()
        if self.settings_error:
            raise DashboardError(self.settings_error)

    def update_settings(self, changes):
        with self.lock:
            if self.closed:
                raise DashboardError("The dashboard is shutting down.", 409)
            if "folders" in changes and self.index_job["state"] == "running":
                raise DashboardError("Wait for indexing to finish before changing folders.", 409)
            if changes.get("mcp_port") == self.ui_port:
                raise DashboardError("The MCP port is occupied by this dashboard.")
            save_settings(changes, self.root)
            self.refresh_settings()
            return self.snapshot()

    def _spawn_worker(self, function, *args):
        worker = threading.Thread(target=function, args=args, daemon=True)
        self.workers = [item for item in self.workers if item.is_alive()]
        self.workers.append(worker)
        worker.start()

    def _mcp_snapshot(self):
        external = None
        if self.mcp_process and self.mcp_process.poll() is not None and self.mcp_state not in ("stopped", "failed"):
            if self.mcp_state == "stopping":
                self.mcp_state = "stopped"
            else:
                self.mcp_state = "failed"
                self.mcp_error = f"MCP exited with code {self.mcp_process.returncode}. " + "\n".join(self.mcp_logs)
        owned = bool(self.mcp_process and self.mcp_process.poll() is None)
        if not owned:
            external = inspect_instance(self.root)
        if external:
            port = external.get("port")
            state = "external" if external.get("state") == "running" else "external_starting"
        else:
            port = self.mcp_port if owned else None
            state = self.mcp_state
        endpoint = f"http://127.0.0.1:{port}/mcp" if type(port) is int else None
        return {
            "state": state, "owned": owned, "active_port": port, "endpoint": endpoint,
            "saved_port": self.settings["mcp_port"],
            "pending_port": port is not None and port != self.settings["mcp_port"],
            "error": self.mcp_error if not external else None,
            "available": state in ("running", "external") and endpoint is not None,
        }

    def snapshot(self):
        with self.lock:
            mcp = self._mcp_snapshot()
            job = dict(self.index_job)
            if job["state"] == "running" and self.index_started is not None:
                job["elapsed_seconds"] = round(time.monotonic() - self.index_started, 1)
            sources_changed = False
            if self.last_build:
                previous = {str(resolve_folder(path, self.root)).casefold() for path in self.last_build.get("source_dirs", [])}
                current = {str(resolve_folder(path, self.root)).casefold() for path in self.settings["folders"]}
                sources_changed = previous != current
            endpoint = mcp["endpoint"] or f"http://127.0.0.1:{self.settings['mcp_port']}/mcp"
            return {
                "settings": dict(self.settings), "settings_error": self.settings_error,
                "folders": self.folders, "ui_port": self.ui_port,
                "mcp": mcp, "index": {**job, "last_build": self.last_build, "metadata_error": self.index_error,
                                       "sources_changed": sources_changed},
                "endpoint": endpoint, "connectors": connector_instructions(endpoint),
            }

    def start_mcp(self):
        with self.lock:
            self._require_settings()
            if self.closed:
                raise DashboardError("The dashboard is shutting down.", 409)
            current = self._mcp_snapshot()
            if current["owned"] or current["state"] not in ("stopped", "failed"):
                raise DashboardError("MCP is already running or changing state. Stop an external instance in its original console.", 409)
            port = self.settings["mcp_port"]
            if port == self.ui_port:
                raise DashboardError("The MCP port is occupied by this dashboard.")
            try:
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", port))
            except OSError as error:
                raise DashboardError(f"Port {port} is in use. Stop its server or save another MCP port.", 409) from error
            self.mcp_logs.clear()
            self.mcp_error = None
            self.mcp_port = port
            self.mcp_instance_id = uuid.uuid4().hex
            try:
                process = subprocess.Popen(
                    [sys.executable, "-u", str(self.root / "scripts" / "rag_mcp.py"),
                     "--transport", "streamable-http", "--port", str(port), "--managed",
                     "--instance-id", self.mcp_instance_id],
                    cwd=self.root, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", **child_options(),
                )
            except OSError as error:
                self.mcp_state, self.mcp_error = "failed", str(error)
                raise DashboardError(f"MCP could not start: {error}", 500) from error
            self.mcp_process, self.mcp_state = process, "starting"
            self._spawn_worker(self._read_mcp_errors, process)
            self._spawn_worker(self._await_mcp_ready, process)
            self._spawn_worker(self._monitor_mcp_exit, process)
            return self.snapshot()

    def _read_mcp_errors(self, process):
        with process.stderr:
            for line in process.stderr:
                with self.lock:
                    if self.mcp_process is process:
                        self.mcp_logs.append(line.rstrip())

    def _await_mcp_ready(self, process):
        deadline = time.monotonic() + 20
        while process.poll() is None and time.monotonic() < deadline:
            metadata = inspect_instance(self.root)
            with self.lock:
                if self.mcp_process is not process or self.mcp_state != "starting":
                    return
                if metadata and metadata.get("instance_id") == self.mcp_instance_id and metadata.get("state") == "running":
                    self.mcp_state = "running"
                    return
            time.sleep(0.05)
        with self.lock:
            if self.mcp_process is process and self.mcp_state == "starting":
                self.mcp_state = "failed"
                self.mcp_error = "MCP did not start. " + ("\n".join(self.mcp_logs) or "Startup timed out.")
        self._finish_process(process, graceful=True)

    def _monitor_mcp_exit(self, process):
        process.wait()
        # If a Windows launcher exits unexpectedly, its child must see EOF too.
        if process.stdin and not process.stdin.closed:
            try:
                process.stdin.close()
            except OSError:
                pass

    @staticmethod
    def _finish_process(process, graceful=False):
        if graceful and process.stdin and not process.stdin.closed:
            try:
                process.stdin.close()
            except OSError:
                pass
        if process.poll() is None:
            if not graceful:
                terminate_child(process)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                terminate_child(process)
                process.wait(timeout=5)

    def stop_mcp(self):
        with self.lock:
            state = self._mcp_snapshot()
            if not state["owned"]:
                raise DashboardError("Stop an external MCP instance in its original console." if state["state"].startswith("external")
                                     else "MCP is not running.", 409)
            if state["state"] in ("starting", "stopping"):
                raise DashboardError("Wait for the current MCP transition to finish.", 409)
            self.mcp_state = "stopping"
            self._spawn_worker(self._stop_mcp, self.mcp_process)
            return self.snapshot()

    def _stop_mcp(self, process):
        self._finish_process(process, graceful=True)
        with self.lock:
            if self.mcp_process is process:
                self.mcp_state, self.mcp_error = "stopped", None

    def build_index(self):
        with self.lock:
            self._require_settings()
            if self.closed or self.index_job["state"] == "running":
                raise DashboardError("An index build is already running or the dashboard is shutting down.", 409)
            unavailable = [folder["path"] for folder in self.folders if not folder["available"]]
            if unavailable:
                raise DashboardError("Unavailable source folders: " + ", ".join(unavailable))
            try:
                process = subprocess.Popen(
                    [sys.executable, "-u", str(self.root / "scripts" / "index_rag.py")], cwd=self.root,
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, encoding="utf-8", errors="replace", **child_options(),
                )
            except OSError as error:
                raise DashboardError(f"Indexing could not start: {error}", 500) from error
            self.index_process = process
            self.index_started = time.monotonic()
            self.index_job = {"state": "running", "files": None, "chunks": None, "elapsed_seconds": 0, "error": None}
            self._spawn_worker(self._watch_index, process)
            return self.snapshot()

    def _watch_index(self, process):
        errors = deque(maxlen=30)
        def read_progress():
            with process.stderr:
                for line in process.stderr:
                    match = re.search(r"Indexed ([\d,]+) files / ([\d,]+) chunks", line)
                    with self.lock:
                        if match:
                            self.index_job.update(files=int(match[1].replace(",", "")), chunks=int(match[2].replace(",", "")))
                        else:
                            errors.append(line.rstrip())
        reader = threading.Thread(target=read_progress, daemon=True)
        reader.start()
        with process.stdout:
            output = process.stdout.read()
        code = process.wait()
        reader.join(timeout=5)
        with self.lock:
            self.index_job["elapsed_seconds"] = round(time.monotonic() - self.index_started, 1)
            try:
                if code:
                    raise ValueError("\n".join(errors) or f"Indexer exited with code {code}.")
                summary = json.loads(output)
                self.index_job.update(state="completed", files=summary["file_count"], chunks=summary["entry_count"], summary=summary)
            except (ValueError, KeyError) as error:
                self.index_job.update(state="failed", error=str(error))
            self.refresh_index_metadata()

    async def _query_mcp(self, endpoint, query):
        async with asyncio.timeout(60):
            async with Client(endpoint, read_timeout_seconds=60) as client:
                return await client.call_tool("search_rag", {"query": query}, read_timeout_seconds=60)

    def playground_query(self, query):
        if not isinstance(query, str) or not query.strip() or len(query) > 10000:
            raise DashboardError("Enter a query between 1 and 10,000 characters.")
        with self.lock:
            status = self._mcp_snapshot()
            if not status["available"]:
                raise DashboardError("Start MCP from the Dashboard before sending a query.", 409, "mcp_stopped")
            endpoint = status["endpoint"]
        started = time.monotonic()
        try:
            result = asyncio.run(self._query_mcp(endpoint, query))
        except TimeoutError as error:
            raise DashboardError("The MCP query timed out after 60 seconds. You can try again.", 504, "timeout") from error
        except Exception as error:
            raise DashboardError(f"Could not reach MCP: {error}", 502, "connection_error") from error
        text = "\n".join(part.text for part in result.content if part.type == "text")
        no_matches = text.strip() == "<RAG_CONTEXT>\nNo local matches found.\n</RAG_CONTEXT>"
        state = "tool_error" if result.is_error else "no_matches" if no_matches else "success"
        self.refresh_index_metadata()
        return {"result": result.model_dump(mode="json", by_alias=True), "text": text, "state": state,
                "elapsed_ms": round((time.monotonic() - started) * 1000), "endpoint": endpoint}

    def close(self):
        with self.lock:
            self.closed = True
            mcp_process, index_process = self.mcp_process, self.index_process
            if mcp_process and mcp_process.poll() is None:
                self.mcp_state = "stopping"
        if mcp_process:
            self._finish_process(mcp_process, graceful=True)
        if index_process:
            self._finish_process(index_process)
        for worker in self.workers:
            worker.join(timeout=6)
