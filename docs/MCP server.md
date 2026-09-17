# Local RAG API

## MCP server

MagicRag exposes `search_rag(query, top_k=4, min_score=0.08)` through the
[official MCP Python SDK](https://py.sdk.modelcontextprotocol.io/).
It searches the existing local index and returns a `<RAG_CONTEXT>` block with
excerpts and source paths. The MCP client decides when to call the tool; it does
not automatically run on every prompt like a hook.

Install once with Python 3.10+ from the project directory:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

For a local MCP client, merge the `mcpServers` entry in
[`settings/mcp.stdio.json`](settings/mcp.stdio.json) into its MCP configuration
(for Claude Code, the project's `.mcp.json`). Adjust the absolute paths if the
project is elsewhere. The client launches and stops the server automatically.
The server works regardless of the client's working directory. The Python entry
point defaults to stdio, which waits for MCP messages and reserves stdout for
protocol output. To use stdio through the batch launcher, run
`startMagicRagMcp.bat --transport stdio`.

For **Claude Desktop on Windows**, merge the entry from
[`settings/mcp.stdio.json`](settings/mcp.stdio.json) into
`%APPDATA%\Claude\claude_desktop_config.json`, preserving any existing servers,
then fully quit and reopen Claude Desktop. Claude launches the Python server
itself; you do not need to run the batch launcher.

Claude's **Add custom connector** URL field is for remote servers. It requires
a public HTTPS endpoint reachable from Anthropic's cloud, so the local
`http://127.0.0.1:8001/mcp` address cannot be added there. Changing the prefix
to `https://` will not fix this. Use the stdio configuration above for Desktop;
Claude web/mobile require a separately hosted remote server with HTTPS and
appropriate authentication. See [Claude's remote connector requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

For Streamable HTTP, start:

```powershell
.\startMagicRagMcp.bat
```

Then use [`settings/mcp.http.json`](settings/mcp.http.json), or connect an MCP
client to `http://127.0.0.1:8001/mcp`. This endpoint listens only on this computer
and is separate from the existing `/rag` hook API. The batch launcher defaults
to Streamable HTTP on port 8001; pass `--port 9000` to change the port, and update
the client URL to match. Press Ctrl+C to stop it.

Example tool arguments: `{"query": "project architecture", "top_k": 4}`.
`query` is required and accepts up to 10,000 characters; `top_k` must be an integer
from 1 to 20, and `min_score` must be between 0 and 1. Blank queries or no matches
return an explicit no-matches message. Invalid arguments and retrieval failures
return MCP errors. MCP searches do not write `RAG.md`.

Place `.md`, `.txt`, or `.json` documents in `raw/`. The index is built on the first
nonblank search if missing. After editing source documents, rebuild it:

```powershell
.\.venv\Scripts\python.exe scripts/index_rag.py
```

Run the test suite with `.\.venv\Scripts\python.exe -m unittest discover -s tests -v`.

