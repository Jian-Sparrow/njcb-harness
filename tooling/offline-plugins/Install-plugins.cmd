@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-plugins.ps1" %*
pause
