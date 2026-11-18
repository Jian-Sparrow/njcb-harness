@echo off
cd /d "%~dp0"
echo Starting npm registry and Python offline index...
"%~dp0node\node.exe" "%~dp0serve.mjs"
pause
