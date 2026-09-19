#!/usr/bin/env bash
set -euo pipefail

rag_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python "$rag_root/scripts/rag_ui.py" "$@"
