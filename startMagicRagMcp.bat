@echo off
cd "%~dp0"
python "scripts\rag_mcp.py" --transport streamable-http
