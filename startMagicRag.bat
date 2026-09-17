@echo off
title MagicRag Local Server
cd "%~dp0"
python "scripts\rag.py" --serve --port 8000
