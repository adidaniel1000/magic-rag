"""Serve the local Magic RAG dashboard. Run setup/setup.bat before first use."""

import argparse
import hmac
import json
import mimetypes
from pathlib import Path
import secrets
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import webbrowser

from rag_dashboard import Dashboard, DashboardError
from rag_platform import choose_folder
from rag_runtime import InstanceBusy, InstanceLock, inspect_instance
from rag_settings import DEFAULT_UI_PORT, PROJECT_ROOT, load_settings


class DashboardHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, dashboard, static_dir):
        self.dashboard = dashboard
        self.static_dir = Path(static_dir).resolve()
        self.session_token = secrets.token_urlsafe(32)
        super().__init__(address, DashboardHandler)
        self.dashboard.ui_port = self.server_port

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class DashboardHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(75)

    def log_message(self, format, *args):
        # One-second status polling should not fill the user's terminal.
        pass

    def _send(self, status, body, content_type="application/json; charset=utf-8"):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    def send_json(self, status, payload):
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def _check_origin(self, mutation=False):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host") not in hosts:
            raise DashboardError("Unrecognized dashboard host.", 403, "forbidden")
        origin = self.headers.get("Origin")
        if (origin is not None and origin not in {f"http://{host}" for host in hosts}) or self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise DashboardError("Cross-origin access is not allowed.", 403, "forbidden")
        if mutation:
            token = self.headers.get("X-Magic-Rag-Token", "")
            if origin is None or not hmac.compare_digest(token, self.server.session_token):
                raise DashboardError("Refresh the dashboard before trying again.", 403, "forbidden")

    def _body(self):
        if self.headers.get("Transfer-Encoding"):
            raise DashboardError("Transfer-Encoding is not supported.")
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            raise DashboardError("Use an application/json request body.", 415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise DashboardError("Invalid request length.") from error
        if not 0 < length <= 65536:
            raise DashboardError("Request body must be between 1 byte and 64 KiB.", 413)
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise DashboardError("Request body must be a JSON object.")
        return payload

    def do_GET(self):
        self._handle(False)

    def do_POST(self):
        self._handle(True)

    def _handle(self, mutation):
        try:
            self._check_origin(mutation)
            path = urlsplit(self.path).path
            dashboard = self.server.dashboard
            if mutation:
                body = self._body()
                if path == "/api/settings":
                    result = dashboard.update_settings(body)
                elif path == "/api/folders/pick":
                    result = {"path": choose_folder()}
                elif path == "/api/mcp/start":
                    result = dashboard.start_mcp()
                elif path == "/api/mcp/stop":
                    result = dashboard.stop_mcp()
                elif path == "/api/index/build":
                    result = dashboard.build_index()
                elif path == "/api/playground/query":
                    if set(body) != {"query"}:
                        raise DashboardError("Provide only a query; the active MCP endpoint is selected by the dashboard.")
                    result = dashboard.playground_query(body["query"])
                else:
                    raise DashboardError("Endpoint not found.", 404)
            elif path == "/api/session":
                dashboard.refresh_settings()
                result = {"token": self.server.session_token}
            elif path == "/api/status":
                result = dashboard.snapshot()
            elif path == "/api/settings":
                dashboard.refresh_settings()
                result = dashboard.snapshot()
            elif path == "/api/connectors":
                result = dashboard.snapshot()["connectors"]
            elif path.startswith("/api/"):
                raise DashboardError("Endpoint not found.", 404)
            else:
                relative = unquote(path).lstrip("/") or "index.html"
                file = (self.server.static_dir / relative).resolve()
                if not file.is_relative_to(self.server.static_dir) or not file.is_file():
                    raise DashboardError("File not found. Run setup/setup.bat if the frontend has not been built.", 404)
                content_type = {".js": "text/javascript", ".css": "text/css", ".html": "text/html"}.get(file.suffix)
                self._send(200, file.read_bytes(), content_type or mimetypes.guess_type(str(file))[0] or "application/octet-stream")
                return
            self.send_json(200, result)
        except DashboardError as error:
            self.send_json(error.status, {"error": str(error), "code": error.code})
        except (ValueError, UnicodeDecodeError) as error:
            self.send_json(400, {"error": str(error), "code": "invalid_request"})
        except Exception as error:
            self.send_json(500, {"error": str(error), "code": "server_error"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-browser", action="store_true", help="Do not open the default browser")
    parser.add_argument("--port", type=int, help="Use a temporary dashboard port without changing settings")
    args = parser.parse_args()
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    static_dir = PROJECT_ROOT / "web" / "dist"
    if not (static_dir / "index.html").is_file():
        parser.exit(1, "The dashboard has not been built. Run setup\\setup.bat first.\n")
    lock = InstanceLock(PROJECT_ROOT, "dashboard")
    try:
        lock.acquire()
    except InstanceBusy:
        existing = inspect_instance(PROJECT_ROOT, "dashboard") or {}
        port = existing.get("port")
        if port:
            url = f"http://127.0.0.1:{port}"
            print(f"Magic RAG is already running at {url}", flush=True)
            if not args.no_browser:
                webbrowser.open(url)
            return
        parser.exit(1, "The dashboard is already starting. Try again in a moment.\n")
    dashboard = None
    try:
        try:
            port = load_settings()["ui_port"]
        except (ValueError, OSError):
            # Keep the UI available to explain a malformed settings file, without rewriting it.
            port = DEFAULT_UI_PORT
        if args.port is not None:
            port = args.port
        dashboard = Dashboard(PROJECT_ROOT, port)
        if not dashboard.settings_error and port == dashboard.settings["mcp_port"]:
            parser.error("The MCP and dashboard ports must be different")
        with DashboardHTTPServer(("127.0.0.1", port), dashboard, static_dir) as server:
            lock.publish(port=server.server_port, state="running")
            url = f"http://127.0.0.1:{server.server_port}"
            print(f"Magic RAG dashboard: {url}\nKeep this window open. Press Ctrl+C to shut down.", flush=True)
            if not args.no_browser:
                webbrowser.open(url)
            server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    except OSError as error:
        parser.exit(1, f"Could not start the dashboard on port {port}: {error}\n"
                    "If this port is occupied, use --port <another-port> or change ui_port in magic_rag_settings.json.\n")
    finally:
        if dashboard:
            dashboard.close()
        lock.release()


if __name__ == "__main__":
    main()
