# Second Mind

Private folder search for AI tools. Windows 11 x64, with a local browser interface and a shared MCP retrieval service.

## Install with one command

After the setup site is deployed, run this in PowerShell (replace the hostname):

```powershell
powershell -c "irm https://YOUR-HOST/install.ps1 | iex"
```

The installer checks Node.js 24, installs a private runtime if necessary, verifies downloads, installs Second Mind for your Windows user, adds its command to your user PATH, and opens the app. No administrator access or npm account is required. Installation downloads dependencies from the npm registry. The first model setup downloads about 24 MB from Hugging Face; subsequent local search and indexing run offline.

Choose a folder in the browser, wait for indexing, then open **Connections**. Closing the browser leaves indexing running. Keep the terminal open; Ctrl+C stops the app and its managed tunnel.

```powershell
secondmind
secondmind status
secondmind stop
```

## Run from this repository

Requires Windows x64 and Node.js 24.12+ within the Node 24 release line.

```powershell
npm ci
npm run dev
```

Development builds the service and browser assets, then starts the same secured local application used in distribution. Run it again after editing. Alternatively, run `npm run build` then `node dist/cli.js`.

The app never automatically indexes this repository's `raw` folder. Register only the folders you want searched. The old Python database and raw files are preserved; the new app creates its own index under `%LOCALAPPDATA%\SecondMind`.

## Prepare the Cloudflare Pages setup site

Everything to deploy is in **`public/`**: installer, landing page, setup guide, release manifest, checksums, and the installable package. The hostname is intentionally unconfigured until you choose it.

```powershell
# Build a package and manifest now, without choosing a hostname:
npm run release

# When you know the Pages address or custom domain:
npm run release -- --base-url https://YOUR-PROJECT.pages.dev
```

Upload the contents of `public/` to Cloudflare Pages, or configure a Pages project with that output directory. For a connected repository build, use `npm ci && npm run release` and set `SECONDMIND_INSTALL_BASE` to the HTTPS origin. The release build itself requires a Node 24 environment; installation targets Windows. The landing page displays and copies the correct one-liner using its deployed hostname. Use the same hostname when generating the installer. **The unconfigured installer intentionally refuses to run.**

The release command writes `public/releases/secondmind-local-0.1.0.tgz`, `public/release.json`, and `SHA256SUMS.txt`. It does not publish to npm or deploy anything. Bump the package version for each public release; release archives use immutable caching.

## Local and remote AI connections

Local clients can use **Streamable HTTP at `http://127.0.0.1:32187/mcp` without authentication**, or launch `secondmind mcp` over stdio. The local HTTP endpoint searches all registered knowledge folders and is available only on this PC; it works without a tunnel or public hostname. Connections shows the address with a copy button. Local administration still requires authentication.

The UI can preview and apply stdio configurations for Claude Code, Claude Desktop, Codex, and Cursor. Changes require clicking **Connect**, preserve other settings, and create backups. Restart the client afterward. A configured entry is not a guarantee that the AI client has connected or will invoke retrieval automatically.

For remote Claude/ChatGPT connections, supply your existing Cloudflare named tunnel's hostname and token in **Connections**. Install `cloudflared` separately and route the entire hostname to `http://127.0.0.1:32188`. Start the tunnel in the app, then add `https://YOUR-HOST/mcp` in your AI client. Approve its matching code and selected folders on your Windows PC. Developer clients may instead use named bearer tokens. See [integration instructions](docs/integrations.md).

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm run smoke
npm run evaluate
npm run benchmark
npm run test:ui
npm run release
npm run test:package
```

`smoke` downloads/verifies the real model and checks semantic retrieval. `evaluate` uses the cached model with downloads disabled for 300 labeled synthetic queries. `benchmark` measures synthetic storage at the prior corpus size of 12,439 documents / 285,368 chunks; it does not rebuild or evaluate the user's existing corpus. UI tests use installed Google Chrome and temporary folders. `test:package` installs the release archive in a separate temporary directory, then verifies real model retrieval, packaged browser assets, MCP, and clean shutdown. See [verification results](docs/verification.md) for measured results and remaining live checks.

Supported inputs: UTF-8 Markdown, text, JSON, HTML, PDF with text, DOCX, and common source code. JavaScript/TypeScript have symbol-aware parsing. Other source formats retain line provenance. Scanned PDFs require OCR elsewhere. Default exclusions omit dependency folders, Git internals, and common secret files; customize them with `.secondmindignore` or the UI.

See [architecture](docs/architecture.md), [security](docs/security.md), and [integrations](docs/integrations.md).
