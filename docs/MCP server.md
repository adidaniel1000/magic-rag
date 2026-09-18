# Local RAG API

## MCP server

MagicRag exposes `search_rag(query, top_k=4, min_score=0.08)` through the
[official MCP Python SDK](https://py.sdk.modelcontextprotocol.io/).
It searches the existing local index and returns a `<RAG_CONTEXT>` block with
excerpts and source paths. The MCP client decides when to call the tool; it does
not automatically run on every prompt like a hook.

Install once with a Windows Python installation that includes SQLite 3.41+ and
FTS5 (current Python 3.12+ installations are suitable). From the project directory:

```powershell
.\setup\setup.bat
.\build_index.bat
```

Setup creates `index/.venv/`, installs the pinned SQLite vector extension and MCP
dependencies there, and checks FTS5 and vector operations. Python supplies SQLite;
no database server is required. Setup can be rerun and does not rebuild documents.

For a local MCP client, merge the `mcpServers` entry in
[`mcp.stdio.json`](../setup/user_setup/mcp.stdio.json) into its MCP configuration
(for Claude Code, the project's `.mcp.json`). Adjust the absolute paths if the
project is elsewhere. The client launches and stops the server automatically.
The server works regardless of the client's working directory. The Python entry
point defaults to stdio, which waits for MCP messages and reserves stdout for
protocol output. To use stdio through the batch launcher, run
`startMagicRagMcp.bat --transport stdio`.

For **Claude Desktop on Windows**, merge the entry from
[`mcp.stdio.json`](../setup/user_setup/mcp.stdio.json) into
`%APPDATA%\Claude\claude_desktop_config.json`, preserving any existing servers,
then fully quit and reopen Claude Desktop. Claude launches the Python server
itself; you do not need to run the batch launcher.

Claude's **Add custom connector** URL field is for remote servers. It requires
a public HTTPS endpoint reachable from Anthropic's cloud, so the local
`http://127.0.0.1:32187/mcp` address cannot be added there. Changing the prefix
to `https://` will not fix this. Use the stdio configuration above for Desktop;
Claude web/mobile require a separately hosted remote server with HTTPS and
appropriate authentication. See [Claude's remote connector requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

For Streamable HTTP, start:

```powershell
.\startMagicRagMcp.bat
```

Then use the [HTTP MCP example](../setup/user_setup/claude_code_mcp/.claude/.mcp.json), or connect an MCP
client to `http://127.0.0.1:32187/mcp`. This endpoint listens only on this computer
and is separate from the existing `/rag` hook API. The batch launcher defaults
to Streamable HTTP using `mcp_port` in `magic_rag_settings.json` (default 32187);
pass `--port 9000` for a one-time override, and update the client URL to match.
Press Ctrl+C to stop it. Only one HTTP MCP instance may run per installation,
even on different ports. Stdio remains independently managed by its clients.

For browser controls and a query playground, see the [Web dashboard](Web%20dashboard.md).
The dashboard starts MCP manually, and port changes take effect only after Stop → Start.

Example tool arguments: `{"query": "project architecture", "top_k": 4}`.
`query` is required and accepts up to 10,000 characters; `top_k` must be an integer
from 1 to 20, and `min_score` must be between 0 and 1. Blank queries or no matches
return an explicit no-matches message. Invalid arguments and retrieval failures
return MCP errors. MCP searches do not write `RAG.md`.

Configure source folders in `magic_rag_settings.json`, or place `.md`, `.txt`, or
`.json` documents in `raw/` when using the default configuration. The database is `index/rag.db`.
It is built on the first searchable query if missing; an explicit build avoids
making that first request wait. After adding, editing, or deleting source documents,
rebuild it:

```powershell
.\build_index.bat
```

The build prints progress to stderr and a JSON summary to stdout. It reads documents
one at a time and inserts chunks in batches. Rebuilds are atomic: existing readers
continue seeing the previous index until the new one commits, and a failed rebuild
rolls back. SQLite's `rag.db-wal` and `rag.db-shm` sidecar files may exist while it is
in use. Keep the live database on local storage.

FTS5 indexes distinct normalized words from each chunk and source path. Searches
score all keyword-matching chunks using `sqlite-vec` cosine similarity, retaining
the original 75% vector / 25% query-word-overlap formula and minimum score. There is
no candidate cap. Broad queries can take longer because more vectors qualify.
Only the selected excerpt text is returned to Python. The embeddings remain hashed
word counts; this migration does not introduce a semantic embedding model.
Float32 storage can cause tiny score differences, including near-ties or results
exactly on a score threshold.

The former `index/vector_index.json` is retained but is no longer read or updated.
Source edits require a full rebuild; there is no background file watcher.

Run tests with `index\.venv\Scripts\python.exe -m unittest discover -s tests -v`.
Run `index\.venv\Scripts\python.exe scripts/benchmark_rag.py` for repeatable
fresh-process and warm query timings; it uses the existing database and never
rebuilds it.
