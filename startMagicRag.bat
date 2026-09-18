@echo off
setlocal
title MagicRag Local Server
cd "%~dp0"
python "scripts\rag.py" --serve --port 8000
exit /b %errorlevel%
