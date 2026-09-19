# Magic RAG

Local document search with a browser dashboard and MCP server.

## Install

Install [Git](https://git-scm.com/downloads), [Python](https://www.python.org/downloads/) with pip and venv, and [Node.js 22.12+](https://nodejs.org/) with npm first. Python must include SQLite 3.41+, FTS5, and extension loading; setup verifies these features. On macOS, use a current Python build with SQLite extension support, such as Homebrew Python. On Debian/Ubuntu, you may also need `python3-venv`.

Choose your platform and paste its one-liner into a terminal in the folder where you want to install Magic RAG.

<details open>
<summary><strong>Windows (PowerShell or CMD)</strong></summary>

```powershell
powershell -c "irm https://raw.githubusercontent.com/adidaniel1000/magic-rag/refs/heads/main/setup/wrapper/install.ps1 | iex"
```

</details>

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/adidaniel1000/magic-rag/refs/heads/main/setup/wrapper/install.sh | bash
```

</details>

The installer clones into `magic-rag`, installs dependencies in `index/.venv`, builds the dashboard, and opens it at `http://127.0.0.1:32188` by default. Keep the terminal open while using it; press `Ctrl+C` to stop.

An existing install folder is left untouched. To choose another destination, set `MAGIC_RAG_INSTALL_DIR` before running the installer. To rerun setup in an existing checkout, use `setup\setup.bat` on Windows or `bash setup/setup.sh` on macOS/Linux. To start it again, run `startMagicRagUI.bat` or `bash startMagicRagUI.sh` from that checkout.

See [manual Windows setup](<docs/Manual Setup.md>) and the [dashboard guide](<docs/Web dashboard.md>) for more options.
