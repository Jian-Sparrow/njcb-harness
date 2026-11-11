@echo off
rem Double-click this file to clear the profile's recorded dependency
rem resolutions (pnpm-lock.yaml and node_modules). Both are renamed to *.bak,
rem never deleted, so a wrong run can be undone by renaming them back.
rem Use it when an install fails with "No matching version found", then run
rem Install-plugins.cmd again.
rem Preview only, touch nothing: Clean-profile.cmd -DryRun
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Clean-profile.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo [FAILED] exit code %CODE%
pause
