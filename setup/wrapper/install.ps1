# Run in PowerShell: irm https://raw.githubusercontent.com/adidaniel1000/magic-rag/refs/heads/main/setup/wrapper/install.ps1 | iex
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
            # Use the current PowerShell session instead of launching another executable.
            # Match the former child process's policy only while setup runs.
            $previousPolicy = $env:PSExecutionPolicyPreference
            try {
                $env:PSExecutionPolicyPreference = "Bypass"
                & .\setup\setup.ps1
                if ($LASTEXITCODE -ne 0) { throw "Setup failed (exit code $LASTEXITCODE)." }
            } finally {
                $env:PSExecutionPolicyPreference = $previousPolicy
            }
            Write-Host "Starting Magic RAG. Keep this terminal open; press Ctrl+C to stop."
            & .\startMagicRagUI.bat
            if ($LASTEXITCODE -ne 0) { throw "Dashboard exited with code $LASTEXITCODE." }
        } finally {
            Pop-Location
        }
    } catch {
        throw "Magic RAG installation failed: $($_.Exception.Message)"
    }
}
