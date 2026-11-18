param(
  [string]$PythonPath,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\njcb harness'),
  [switch]$SkipPipConfig
)
$ErrorActionPreference = 'Stop'
if (!$PythonPath) {
  $dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $PythonPath = Join-Path $dshRoot 'dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
  if (!(Test-Path $PythonPath)) {
    $PythonPath = Join-Path $InstallDir 'resources\runtime\primary-runtime\dependencies\python\python.exe'
  }
}
if (!(Test-Path $PythonPath)) { throw "DSH Python not found: $PythonPath. Start Harness once, or pass -PythonPath." }
$PythonPath = (Resolve-Path $PythonPath).Path
& $PythonPath -c "import sys,struct,site; assert sys.version_info[:2]==(3,12) and sys.platform=='win32' and struct.calcsize('P')==8, 'Requires Windows Python 3.12 x64'; assert site.ENABLE_USER_SITE, 'Python user site is disabled'; print(sys.executable)"
if ($LASTEXITCODE) { throw 'Python compatibility check failed.' }
$wheels = Join-Path $PSScriptRoot 'python\wheels'
& $PythonPath -m pip --isolated --disable-pip-version-check install --user --no-cache-dir --no-index --find-links $wheels --require-hashes -r (Join-Path $PSScriptRoot 'python\requirements.txt')
if ($LASTEXITCODE) { throw 'Offline Python dependency installation failed.' }
& $PythonPath (Join-Path $PSScriptRoot 'python-smoke.py')
if ($LASTEXITCODE) { throw 'DSH Python could not use the installed dependencies.' }
if (!$SkipPipConfig) {
  $port = if ($env:NJCB_OFFLINE_PORT) { $env:NJCB_OFFLINE_PORT } else { '4873' }
  $config = Join-Path $env:APPDATA 'pip\pip.ini'
  if (Test-Path $config) { Copy-Item $config "$config.njcb-backup-$([guid]::NewGuid().ToString('N')).ini" }
  & $PythonPath -m pip config --user set global.index-url "http://127.0.0.1:$port/python/simple/"
  if ($LASTEXITCODE) { throw 'Could not configure the Python index.' }
  & $PythonPath -m pip config --user set global.extra-index-url "http://127.0.0.1:$port/python/simple/"
  if ($LASTEXITCODE) { throw 'Could not clear the fallback Python index.' }
  Write-Host "User pip index configured. Environment variables or command-line options may override it."
}
Write-Host 'Python dependencies ready. Use Python.cmd or the DSH Python path with -m pip.'
