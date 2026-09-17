@echo off
setlocal
title MagicRag Local Server
set "RAG_PYTHON=%~dp0index\.venv\Scripts\python.exe"
if not exist "%RAG_PYTHON%" (
    echo Run "%~dp0setup\setup.bat" first. 1>&2
    exit /b 1
)
"%RAG_PYTHON%" "%~dp0scripts\rag.py" --serve --port 8000 %*
exit /b %errorlevel%
