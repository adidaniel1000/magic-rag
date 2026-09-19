#!/usr/bin/env bash
# Usage: curl -fsSL https://raw.githubusercontent.com/adidaniel1000/magic-rag/refs/heads/main/setup/wrapper/install.sh | bash
set -euo pipefail

# Parse the whole function before running commands when this file is piped to Bash.
install_magic_rag() {
    if ! python -V >/dev/null 2>&1; then
        printf '%s\n' "Python 3 is required. Install Python with pip and make sure 'python -V' works in a new terminal, then rerun the installer." >&2
        exit 1
    fi
    local install_dir="${MAGIC_RAG_INSTALL_DIR:-$PWD/magic-rag}"
    if [[ -e "$install_dir" || -L "$install_dir" ]]; then
        printf 'Install directory already exists: %s\nRun its setup script to reuse it, or set MAGIC_RAG_INSTALL_DIR to a new directory.\n' "$install_dir" >&2
        exit 1
    fi
    if ! command -v git >/dev/null 2>&1; then
        printf '%s\n' 'Install Git, open a new terminal, and rerun the installer.' >&2
        exit 1
    fi

    printf 'Installing Magic RAG in %s\n' "$install_dir"
    # Child commands must not consume the remainder of a piped installer.
    GIT_TERMINAL_PROMPT=0 git clone --branch main --single-branch \
        https://github.com/adidaniel1000/magic-rag.git "$install_dir" </dev/null
    cd -- "$install_dir"
    bash setup/setup.sh </dev/null
    printf '%s\n' 'Starting Magic RAG. Keep this terminal open; press Ctrl+C to stop.'
    bash startMagicRagUI.sh </dev/null
}

install_magic_rag
