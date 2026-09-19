# Set up an existing checkout. Compatible with Windows PowerShell 5.1.
$ErrorActionPreference = "Stop"
$ragRoot = Split-Path -Parent $PSScriptRoot

function Invoke-SetupCommand {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed (exit code $LASTEXITCODE). Setup stopped."
    }
}

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw "Install Node.js 22.12+ with npm, open a new terminal, and rerun setup."
    }
    Invoke-SetupCommand node @("-e", "if (Number(process.versions.node.split('.')[0]) < 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 12)) { console.error('Node.js 22.12+ is required.'); process.exit(1); }")

    Invoke-SetupCommand python @("-m", "pip", "install", "-r", (Join-Path $PSScriptRoot "requirements.txt"))
    Invoke-SetupCommand python @((Join-Path $PSScriptRoot "verify_sqlite.py"))

    Push-Location -LiteralPath (Join-Path $ragRoot "web")
    try {
        # Use npm.cmd so a restricted policy does not block npm.ps1.
        Invoke-SetupCommand npm.cmd @("ci")
        Invoke-SetupCommand npm.cmd @("run", "build")
    } finally {
        Pop-Location
    }
    Write-Host "Setup complete. Run startMagicRagUI.bat to open the dashboard."
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
