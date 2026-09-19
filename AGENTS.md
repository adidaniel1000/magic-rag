# Repository Guidelines

## Project Structure & Module Organization

- `scripts/` contains the Python backend: `rag_core.py` handles SQLite indexing and retrieval; `rag.py` exposes the hook API; `rag_mcp.py` exposes MCP; dashboard, settings, runtime, and platform modules support `rag_ui.py`.
- `web/src/` contains the React/TypeScript dashboard and CSS; `web/public/` holds static assets. Vite outputs to `web/dist/`.
- `tests/` covers retrieval, HTTP hooks, MCP transports, and dashboard behavior.
- `setup/` contains dependency installation, SQLite verification, and client configuration examples; `docs/` contains API and operational guides.
- `index/` stores generated databases and runtime state. `raw/` is the default document source.

## Build, Test, and Development Commands

Run from the repository root in PowerShell unless specified:

- `.\setup\setup.bat` installs dependencies with `python3 -m pip`, verifies SQLite support, and builds the dashboard. Install Python with SQLite/FTS5 as `python3` on PATH and Node.js 22.12+ first.
- `.\startMagicRagUI.bat` serves the dashboard at `http://127.0.0.1:32188` by default.
- `.\startMagicRagMcp.bat` starts the local HTTP MCP endpoint; add `--transport stdio` for client-managed operation.
- `.\build_index.bat` rebuilds the index from configured source folders.
- In `web/`, run `npm ci` to install locked dependencies, `npm run typecheck` to check TypeScript, and `npm run build` to check and compile. Refresh the dashboard after rebuilding.
- `python3 -m unittest discover -s tests -v` runs the Python suite.

## Coding Style & Naming Conventions

Use four-space Python indentation, `snake_case` functions/modules, `PascalCase` classes, and uppercase constants. Match existing TypeScript/CSS two-space indentation; use `camelCase` functions/variables and `PascalCase` components/interfaces. TypeScript uses strict checking, double quotes, and semicolons. No dedicated formatter or linter is configured; follow nearby code.

## Testing Guidelines

Use `unittest` with `test_*.py` files and `test_*` methods; async MCP tests use `IsolatedAsyncioTestCase`. Add regression coverage for behavioral changes. Use temporary installations/documents and clean up processes; never test against personal sources or the live index. No numeric coverage threshold or frontend test runner is configured. For UI changes, build and manually verify affected flows.

## Commit & Pull Request Guidelines

History uses short descriptive subjects without mandatory prefixes, such as `Index configured source folders and simplify Python launchers`. Prefer concise imperative summaries. PRs should explain behavior changes, list verification performed, link related issues when applicable, and include screenshots for visible UI changes.

## Configuration & Local Data

Configure folders and ports in `magic_rag_settings.json`; relative paths resolve against the installation root. Avoid committing machine-specific path changes. Keep ignored `raw/`, `index/`, `RAG.md`, dependencies, and build output untracked. Preserve loopback binding and dashboard Host/Origin/session-token checks.
