# Magic RAG dashboard

The dashboard manages this installation's source folders, local HTTP MCP server,
index builds, and client setup instructions. The Playground sends real MCP
`search_rag` requests and displays the original response, including source citations.

## Start

Install Python with SQLite/FTS5 support and Node.js 22.12+ (or Node.js 24+), then run:

```powershell
.\setup\setup.bat
.\startMagicRagUI.bat
```

Setup installs Python packages with `python -m pip`, installs the locked frontend
dependencies, and builds the React app. The launcher opens
`http://127.0.0.1:32188` in your browser. Keep its console open; Ctrl+C shuts down
the dashboard and the MCP/indexer processes it started. Closing a browser tab
does not stop them. Starting the dashboard a second time opens the existing one.
Use `startMagicRagUI.bat --no-browser` to suppress automatic browser opening.
If the saved dashboard port is in use, run `startMagicRagUI.bat --port 32189`
for a temporary override, or change `ui_port` in the settings file. An override
does not rewrite the saved port.

MCP starts **manually** from the Dashboard. Its default endpoint is
`http://127.0.0.1:32187/mcp`. Only one HTTP MCP instance may run per installation,
including instances started through `startMagicRagMcp.bat`. An instance started
outside the dashboard must be stopped in its original console. Stop any old
server started before this update before using the new launchers.

## Configuration and indexing

All application configuration lives in the project root's `magic_rag_settings.json`:

```json
{
  "folders": ["C:\\Knowledge"],
  "mcp_port": 32187,
  "ui_port": 32188
}
```

Existing folder-only settings are supported, and unknown fields are preserved.
Relative folder paths resolve against the installation directory. The dashboard
can add/edit folders by path or a Windows folder picker. Removing a source never
deletes files. Unavailable sources are reported and must be fixed or removed
before building. Overlapping folders remain supported; the indexer deduplicates files.

Folder changes and source-file edits require **Build index** / **Rebuild index**.
The indexer reads `.md`, `.txt`, and `.json` files recursively. The dashboard
captures its existing progress messages (at most once every five seconds) and
final counts. There is no extra discovery pass or percentage calculation.
Short jobs may finish before producing a progress update. Counts are approximate
work-in-progress until the final build summary. Existing searches use the last
committed index during a rebuild; a failed build preserves that index.

A saved MCP port takes effect only after **Stop**, then **Start**. While running,
the endpoint, connector commands, and Playground keep using the active port.
Changing the dashboard port under **Dashboard settings** takes effect when you
relaunch the dashboard. UI and MCP ports must be different.

Runtime process locks and metadata are derived state under `index/runtime/`;
they are not settings. Stale metadata alone does not mark a server as running.
The index remains at `index/rag.db`. No query history is persisted.

## Playground and connectors

Start MCP, open **Playground**, enter a query, and select **Send query** (or
Ctrl+Enter). The server uses its defaults: up to four excerpts and minimum score
0.08. Queries may contain up to 10,000 characters. Responses render as plain text
and can be copied. The latest query/result survives tab switching but not page
reload. The request times out after 60 seconds; its server-side work may finish
later. If no index exists, the MCP server retains its first-query automatic build.
For a large collection, build the index from the Dashboard before querying.

Connector cards display commands for Claude Code (project scope) and Codex
(user scope), plus an endpoint for other MCP clients. Nothing is executed and no
client/OS settings are changed. After changing the MCP port, rerun the displayed
commands in each client. A remove command can report that no prior entry exists;
continue with the add command. Restart/reconnect the client if needed.

## Development and verification

```powershell
cd web
npm ci
npm run build
cd ..
python -m unittest discover -s tests -v
```

Refresh the browser after rebuilding. Node is needed for building, not for
running the compiled UI. Tests use temporary installations and document sets.

The Python management API binds to loopback. It validates Host/Origin, rejects
cross-origin requests, requires a per-process session token on POST requests,
and serves only files inside the compiled frontend directory. The Playground
selects the tracked active MCP endpoint; it does not accept arbitrary URLs.

API endpoints: GET `/api/session`, `/api/status`, `/api/settings`, `/api/connectors`;
POST `/api/settings`, `/api/folders/pick`, `/api/mcp/start`, `/api/mcp/stop`,
`/api/index/build`, and `/api/playground/query` (body: `{"query":"architecture"}`).
Status polling reads cached job/index information, not source-file contents.
