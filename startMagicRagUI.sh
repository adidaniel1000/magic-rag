#!/usr/bin/env bash
set -euo pipefail

rag_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$rag_root/scripts/rag_ui.py" "$@"
