@echo off
title MagicRag Local Server
python -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 exit /b %errorlevel%
python "%~dp0scripts\rag.py" --serve --port 8000
