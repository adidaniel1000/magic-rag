import sys
import json
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer

from rag_core import PROJECT_ROOT, format_context, search


def run_rag(payload):
    if not isinstance(payload, dict):
        raise ValueError("Request must be a JSON object")
    prompt = payload.get("prompt", "")
    if not isinstance(prompt, str):
        raise ValueError("prompt must be a string")

    try:
        matches = search(prompt)
        context = format_context(prompt, matches)
    except Exception as error:
        context = (
            "<RAG_CONTEXT>\n"
            "Local RAG retrieval failed, so no retrieved context is available.\n"
            f"Error: {type(error).__name__}: {error}\n"
            "</RAG_CONTEXT>"
        )

    result = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }

    with (PROJECT_ROOT / "RAG.md").open("w", encoding="utf-8") as log_file:
        log_file.write(context or "<RAG_CONTEXT>\nNo local matches found.\n</RAG_CONTEXT>")

    return result


class RagHandler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/rag":
            self.send_json(404, {"error": "Use POST /rag"})
            return
        if self.headers.get("Transfer-Encoding"):
            self.send_json(400, {"error": "Use Content-Length instead of Transfer-Encoding"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                raise ValueError("A JSON request body is required")
            if length > 1024 * 1024:
                self.send_json(413, {"error": "Request body exceeds 1 MiB"})
                return
            payload = json.loads(self.rfile.read(length))
            result = run_rag(payload)
        except (ValueError, UnicodeDecodeError) as error:
            self.send_json(400, {"error": str(error)})
            return
        except Exception:
            self.log_error("RAG request failed")
            self.send_json(500, {"error": "RAG request failed; check the server"})
            return
        self.send_json(200, result)


def main():
    parser = argparse.ArgumentParser(description="Retrieve local RAG context via stdin or HTTP")
    parser.add_argument("--serve", action="store_true", help="Serve POST /rag on localhost")
    parser.add_argument("--port", type=int, default=8000, help="Local HTTP port (default: 8000)")
    args = parser.parse_args()
    if args.serve:
        with HTTPServer(("127.0.0.1", args.port), RagHandler) as server:
            print(f"RAG listening at http://127.0.0.1:{server.server_port}/rag", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
    else:
        print(json.dumps(run_rag(json.load(sys.stdin))))


if __name__ == "__main__":
    main()
