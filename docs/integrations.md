# Connecting AI clients

Start Second Mind in a terminal and keep it open. The UI's **Connections** page previews changes before applying them, backs up existing files and preserves unrelated configuration. Restart your AI client after connecting. The UI reports configuration presence, not a verified active client connection.

## Local MCP

For an AI app that accepts an HTTP MCP address, choose **Streamable HTTP**, enter **`http://127.0.0.1:32187/mcp`**, and leave authentication disabled. No token, browser approval, public hostname, or tunnel is needed. The **Connections** page provides the address and a copy button, including the correct port if changed in settings. Second Mind must be running.

This endpoint is bound to `127.0.0.1` and permits local applications to search all registered folders. It validates the exact Host and rejects foreign or null browser Origins. Local administrative APIs remain authenticated. The gateway on port `32188` and the public HTTPS endpoint continue to require OAuth or a scoped bearer token; do not route a tunnel to port `32187`.

### Stdio client setup

The client launches the installed Node executable and the packaged CLI with `mcp`. Use the exact snippet shown in the UI; absolute paths avoid npm command resolution problems on Windows. The shim sends retrieval to the running service and does not open the index.

Supported setup targets:

| Client | User configuration |
|---|---|
| Claude Code | `%USERPROFILE%\.claude.json`, top-level `mcpServers` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Codex | `%CODEX_HOME%\config.toml`, or `%USERPROFILE%\.codex\config.toml` |
| Cursor | `%USERPROFILE%\.cursor\mcp.json` |

The server key is `secondmind`. For other clients, copy the command and arguments from Manual configuration. `secondmind hook` accepts Claude Code UserPromptSubmit JSON on stdin and writes additional context; retrieval failures emit an empty object so normal AI use continues. Hook installation is manual and optional.

The Python `search_rag` tool, `/rag` endpoint, old ports 8000/8001, and batch launchers are retired. Replace old client entries with the current UI-generated configuration. Old raw files and indexes are retained but are not imported automatically.

## Cloudflare named tunnel

1. Install the official Windows x64 `cloudflared` executable. Put it on PATH or set its complete executable path in Second Mind Settings.
2. In your Cloudflare account, create a remotely managed named tunnel and a public hostname, such as `mind.example.com`.
3. Route that entire hostname to **HTTP `127.0.0.1:32188`**, or your configured gateway port. OAuth discovery, authorization, token and MCP paths all need the same origin. Do not point the tunnel at the browser port 32187.
4. In Second Mind Connections, save `https://mind.example.com` and paste the tunnel token. Click **Start tunnel**. No Windows service is installed.
5. Add **`https://mind.example.com/mcp`** as a remote/custom connector in Claude or ChatGPT where your account supports that feature. Use OAuth with dynamic client registration.
6. The authorization page shows a matching code. On your Windows PC, choose the knowledge folders in Connections and approve that request. Return to the AI client's authorization page to complete the redirect.

Do not add an interactive Cloudflare Access login gate in front of the OAuth/MCP endpoints; the application already authenticates those requests. Cloudflare rules that block AI-client traffic will prevent the connection. The app does not create or modify Cloudflare account resources.

For developer clients supporting request headers, create a named token after selecting its allowed folders and send `Authorization: Bearer TOKEN`. Tokens default to 30 days and can be revoked from Connections. The token is shown only once. Local installation secrets are never remote credentials.

Cloudflare reconnects transient network interruptions; the app also retries unexpected child exits with bounded backoff. Stopping Second Mind stops its managed tunnel. Changing the public hostname revokes remote grants, so reconnect clients afterward.

## Deployment versus tunneling

The **Cloudflare Pages setup site** hosts only static installation files. It is separate from the **Cloudflare named tunnel** used for retrieval. The setup domain and MCP domain may differ. Deploying the `public/` folder does not expose your index or start a tunnel.

## Live acceptance checklist

Confirm local retrieval from at least two supported clients, OAuth approval and search from Claude and ChatGPT, revocation, reconnection, and tunnel shutdown. Automated SDK transport tests verify protocol behavior, but cannot establish compatibility with a particular third-party account or its administrative policies.
