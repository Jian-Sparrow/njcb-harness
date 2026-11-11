@echo off
rem Double-click this file to reset the profile: ends the running client, empties
rem the plugin list, and renames pnpm-lock.yaml / node_modules to *.bak. Nothing
rem is deleted, so a wrong run can be undone by renaming them back.
rem
rem Double-click runs the full reset (-FreshPlugins), because that is what an
rem end user needs: an old plugin list plus an old lock file blocks the offline
rem source with "No matching version found". Nobody has to type a command.
rem
rem Passing arguments overrides that default, e.g.:
rem   Clean-profile.cmd -DryRun              preview only, touch nothing
rem   Clean-profile.cmd -FreshPlugins        same as double-click
setlocal
cd /d "%~dp0"
set "ARGS=%*"
if "%~1"=="" set "ARGS=-FreshPlugins"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Clean-profile.ps1" %ARGS%
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo [FAILED] exit code %CODE%
pause
