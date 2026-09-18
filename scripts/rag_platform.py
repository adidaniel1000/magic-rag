"""Platform adapters kept separate from dashboard and connector presentation."""

import json
import os
from pathlib import Path
import subprocess
import sys


def child_options():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def terminate_child(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        # A Windows venv executable can be a redirector with a real Python child.
        # Terminating only the redirector leaves that child (and SQLite) alive.
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       capture_output=True, timeout=10, **child_options())
    else:
        process.kill()


def choose_folder():
    # Tk must run on its own main thread, never on an HTTP request worker.
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--pick-folder"],
        capture_output=True, text=True, encoding="utf-8", timeout=300, **child_options(),
    )
    if result.returncode:
        raise RuntimeError("The folder picker could not open. Paste the folder path instead.")
    return json.loads(result.stdout).get("path")


def connector_instructions(endpoint):
    return [
        {
            "id": "claude-code", "name": "Claude Code", "label": "Anthropic",
            "instructions": "Run these commands from the project you want Claude Code to use. If removal reports no existing server, continue with Add.",
            "commands": f"claude mcp remove --scope project magic-rag\nclaude mcp add --scope project --transport http magic-rag {endpoint}",
        },
        {
            "id": "codex", "name": "Codex", "label": "OpenAI",
            "instructions": "Run these commands in your terminal. This updates your user-level Codex configuration. If removal reports no existing server, continue with Add.",
            "commands": f"codex mcp remove magic-rag\ncodex mcp add magic-rag --url {endpoint}",
        },
    ]


if __name__ == "__main__":
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askdirectory(parent=root, title="Choose a Magic RAG source folder", mustexist=True)
        print(json.dumps({"path": selected or None}))
    finally:
        root.destroy()
