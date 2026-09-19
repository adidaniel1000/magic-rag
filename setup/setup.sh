#!/usr/bin/env bash
set -euo pipefail

rag_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
rag_python="$rag_root/index/.venv/bin/python"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' 'Install Node.js 22.12+ with npm, open a new terminal, and rerun setup.' >&2
    exit 1
fi
node -e "if (Number(process.versions.node.split('.')[0]) < 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 12)) { console.error('Node.js 22.12+ is required.'); process.exit(1); }"

if [[ ! -x "$rag_python" ]]; then
    if ! command -v python3 >/dev/null 2>&1; then
        printf '%s\n' 'Install Python 3 with pip and venv, then rerun setup.' >&2
        exit 1
    fi
    if ! python3 -m venv "$rag_root/index/.venv"; then
        printf '%s\n' 'Could not create the Python environment. Ensure Python includes venv and pip (on Debian/Ubuntu, install python3-venv).' >&2
        exit 1
    fi
fi
"$rag_python" -m pip install -r "$rag_root/setup/requirements.txt"
"$rag_python" "$rag_root/setup/verify_sqlite.py"

cd -- "$rag_root/web"
npm ci
npm run build
printf '%s\n' 'Setup complete. Run bash startMagicRagUI.sh to open the dashboard.'
