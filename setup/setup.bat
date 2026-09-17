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
echo Setup complete. Run build_index.bat to build the document index.
exit /b 0
