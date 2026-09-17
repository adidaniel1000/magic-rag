@echo off
setlocal
set "RAG_PYTHON=%~dp0index\.venv\Scripts\python.exe"
if not exist "%RAG_PYTHON%" (
    echo Run "%~dp0setup\setup.bat" first. 1>&2
    exit /b 1
)
"%RAG_PYTHON%" "%~dp0scripts\rag_mcp.py" --transport streamable-http %*
exit /b %errorlevel%
