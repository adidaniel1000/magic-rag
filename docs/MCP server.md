# MCP server migration

The Python MCP server and `search_rag` tool have been retired. Second Mind now exposes `second_mind_search` and `second_mind_code_search` through the official TypeScript MCP SDK.

Start `secondmind` in a terminal, then use **Connections** in its browser interface to preview a replacement client configuration. Click **Connect** to apply it. Local clients launch `secondmind mcp`; remote clients use the authenticated HTTPS gateway.

See [current integration instructions](integrations.md) and [installation](../README.md). Existing documents and Python indexes are preserved; register folders explicitly to build the separate Second Mind index.
