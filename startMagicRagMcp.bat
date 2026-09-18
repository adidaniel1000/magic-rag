@echo off
setlocal
cd "%~dp0"
python "scripts\rag_mcp.py" --transport streamable-http
exit /b %errorlevel%
