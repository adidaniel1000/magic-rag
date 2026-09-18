@echo off
setlocal
set "RAG_ROOT=%~dp0.."
set "RAG_PYTHON=%RAG_ROOT%\index\.venv\Scripts\python.exe"
if not exist "%RAG_PYTHON%" (
    py -3 -m venv "%RAG_ROOT%\index\.venv"
    if errorlevel 1 exit /b 1
)
"%RAG_PYTHON%" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 exit /b 1
"%RAG_PYTHON%" "%~dp0verify_sqlite.py"
if errorlevel 1 exit /b 1
where npm >nul 2>&1
if errorlevel 1 (
    echo Install Node.js 22.12+ or 24+ to build the dashboard, then rerun setup. 1>&2
    exit /b 1
)
pushd "%RAG_ROOT%\web"
call npm ci
if errorlevel 1 (
    popd
    exit /b 1
)
call npm run build
if errorlevel 1 (
    popd
    exit /b 1
)
popd
echo Setup complete. Run startMagicRagUI.bat to open the dashboard.
exit /b 0
