## MCP Additional Context Retrieval

**Always call the MagicRag MCP server first with the user's prompt to get additional context before responding.**

This project uses a local MCP server (`http://127.0.0.1:32187/mcp`) that provides contextual information retrieval. When a user submits a prompt use the MagicRag MCP server to retrieve relevant context based on their query and incorporate this context into your understanding of the request