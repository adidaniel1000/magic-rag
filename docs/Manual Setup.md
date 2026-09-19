# Manual setup 

Run these commands in Linux / Windows terminal.

## Prerequisites

- Git and GitHub CLI (`gh`) available on your PATH.
- Python with the `py` launcher and pip. SQLite 3.41+ with FTS5 and extension loading is required; the verification command below checks this.
- Node.js 22.12+ with npm available on your PATH.

## Install

Open a terminal in the directory where you want to clone the project. Run each command in order and resolve any errors before continuing.

```cmd
gh repo clone adidaniel1000/magic-rag
cd magic-rag
py -m pip install -r setup/requirements.txt
py setup/verify_sqlite.py
cd web 
npm ci
npm run build
cd ..
```

The SQLite check should report that FTS5 and sqlite-vec are verified. The frontend build creates `web/dist/`.

## Start UI

From the `magic-rag` directory, run:

```cmd
py scripts/rag_ui.py
```

The dashboard opens in your browser at `http://127.0.0.1:32188` by default. If you have changed the port in `magic_rag_settings.json`, use the URL printed in terminal.

Keep the terminal window open while using the UI. Press `Ctrl+C` to stop it.

See [the dashboard guide](../docs/Web%20dashboard.md) for configuring source folders, building the index, and starting MCP.
