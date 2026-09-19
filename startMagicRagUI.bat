@echo off
setlocal
call python3 "%~dp0scripts\rag_ui.py" %*
exit /b %errorlevel%
