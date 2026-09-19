@echo off
setlocal
call python "%~dp0scripts\rag_ui.py" %*
exit /b %errorlevel%
