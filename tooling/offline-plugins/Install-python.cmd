@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-python.ps1" %*
set "result=%errorlevel%"
pause
exit /b %result%
