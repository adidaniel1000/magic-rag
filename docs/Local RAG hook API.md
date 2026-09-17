# Hook and HTTP API migration

The Python HTTP service, `/rag` endpoint and sample hook configurations have been retired.

Second Mind's canonical local retrieval route is `POST http://127.0.0.1:32187/api/v1/retrieve`; `/api/search` is an alias. Both require authenticated local access. MCP integrations use the same retrieval service through `secondmind mcp`.

For an optional Claude Code UserPromptSubmit hook, use `secondmind hook`. It reads hook JSON from stdin, supplies bounded code-navigation context, and fails open when retrieval is unavailable. Hook configuration is manual; the app does not modify hooks automatically.

See [current integration instructions](integrations.md), [architecture](architecture.md), and [installation](../README.md).
