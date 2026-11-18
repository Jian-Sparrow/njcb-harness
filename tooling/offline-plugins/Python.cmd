@echo off
setlocal
set "dshRoot=%USERPROFILE%\.dsh"
if defined DSH_HOME set "dshRoot=%DSH_HOME%"
set "dshPython=%dshRoot%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%dshPython%" set "dshPython=%LOCALAPPDATA%\Programs\njcb harness\resources\runtime\primary-runtime\dependencies\python\python.exe"
"%dshPython%" %*
exit /b %errorlevel%
