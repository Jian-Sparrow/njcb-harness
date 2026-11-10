@echo off
rem Drag one or more .tgz/.zip files (or a folder) onto this file, or run it
rem from a console: Add-plugin.cmd D:\uploads\dsh-some-plugin-1.2.0.tgz
rem A .zip is repacked into an npm tarball on the way in.
cd /d "%~dp0"
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0add-plugin.mjs" %*
echo.
pause
