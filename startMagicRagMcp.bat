@echo off
setlocal
set "RAG_PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%RAG_PYTHON%" set "RAG_PYTHON=python"
"%RAG_PYTHON%" "%~dp0scripts\rag_mcp.py" --transport streamable-http %*
