#!/usr/bin/env bash
set -euo pipefail

rag_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
rag_python="$rag_root/index/.venv/bin/python"
if [[ ! -x "$rag_python" ]]; then
    printf 'Run bash "%s/setup/setup.sh" first.\n' "$rag_root" >&2
    exit 1
fi
exec "$rag_python" "$rag_root/scripts/rag_ui.py" "$@"
