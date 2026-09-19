#!/usr/bin/env bash
set -euo pipefail

rag_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' 'Install Node.js 22.12+ with npm, open a new terminal, and rerun setup.' >&2
    exit 1
fi
node -e "if (Number(process.versions.node.split('.')[0]) < 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 12)) { console.error('Node.js 22.12+ is required.'); process.exit(1); }"

python -m pip install -r "$rag_root/setup/requirements.txt"
python "$rag_root/setup/verify_sqlite.py"

cd -- "$rag_root/web"
npm ci
npm run build
printf '%s\n' 'Setup complete. Run bash startMagicRagUI.sh to open the dashboard.'
