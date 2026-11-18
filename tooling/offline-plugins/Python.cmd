@echo off
setlocal
set "dshRoot=%USERPROFILE%\.dsh"
if defined DSH_HOME set "dshRoot=%DSH_HOME%"
"%dshRoot%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" %*
exit /b %errorlevel%
