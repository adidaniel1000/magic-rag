# Usage: powershell -c "irm https://raw.githubusercontent.com/adidaniel1000/magic-rag/refs/heads/main/setup/wrapper/install.ps1 | iex"
# A child scope also works with Invoke-Expression, where PSScriptRoot is empty.
& {
    $ErrorActionPreference = "Stop"
    try {
        try {
            & python -V *> $null
            if ($LASTEXITCODE -ne 0) { throw "python failed." }
        } catch {
            throw "Python 3 is required. Install Python with pip and make sure 'python -V' works in a new terminal, then rerun the installer."
        }
        $installDir = if ($env:MAGIC_RAG_INSTALL_DIR) {
            $env:MAGIC_RAG_INSTALL_DIR
        } else {
            Join-Path (Get-Location).Path "magic-rag"
        }
        if (Test-Path -LiteralPath $installDir) {
            throw "Install directory already exists: $installDir. Run its setup script to reuse it, or set MAGIC_RAG_INSTALL_DIR to a new directory."
        }
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            throw "Install Git, open a new terminal, and rerun the installer."
        }

        Write-Host "Installing Magic RAG in $installDir"
        $previousGitPrompt = $env:GIT_TERMINAL_PROMPT
        try {
            $env:GIT_TERMINAL_PROMPT = "0"
            & git clone --branch main --single-branch https://github.com/adidaniel1000/magic-rag.git $installDir
            if ($LASTEXITCODE -ne 0) { throw "Git clone failed (exit code $LASTEXITCODE)." }
        } finally {
            $env:GIT_TERMINAL_PROMPT = $previousGitPrompt
        }

        Push-Location -LiteralPath $installDir
        try {
            # Bypass applies only to this setup process, not the user's saved policy.
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup\setup.ps1
            if ($LASTEXITCODE -ne 0) { throw "Setup failed (exit code $LASTEXITCODE)." }
            Write-Host "Starting Magic RAG. Keep this terminal open; press Ctrl+C to stop."
            & .\startMagicRagUI.bat
            if ($LASTEXITCODE -ne 0) { throw "Dashboard exited with code $LASTEXITCODE." }
        } finally {
            Pop-Location
        }
    } catch {
        Write-Error $_ -ErrorAction Continue
        exit 1
    }
}
