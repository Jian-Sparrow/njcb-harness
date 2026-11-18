param([Parameter(Mandatory=$true)][string]$Bundle, [Parameter(Mandatory=$true)][string]$InstallDir)
$ErrorActionPreference = 'Stop'
$python = Join-Path $env:DSH_HOME 'dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
if (!(Test-Path $python)) { $python = Join-Path $InstallDir 'resources\runtime\primary-runtime\dependencies\python\python.exe' }
if (!(Test-Path $python)) { throw "Bundled DSH Python not found: $python" }
$work = Join-Path $env:RUNNER_TEMP ('njcb-python-test-' + [guid]::NewGuid().ToString('N'))
$oldUserBase = $env:PYTHONUSERBASE
$oldAppData = $env:APPDATA
$rules = @()
try {
  New-Item -ItemType Directory -Force $work | Out-Null
  $env:PYTHONUSERBASE = Join-Path $work 'user-packages'
  $env:APPDATA = Join-Path $work 'appdata'
  # Both the actual DSH interpreter and a clean venv must work without public access.
  & $python -m venv (Join-Path $work 'venv')
  if ($LASTEXITCODE) { throw 'Could not prepare clean Python test environment.' }
  $venvPython = Join-Path $work 'venv\Scripts\python.exe'
  foreach ($program in @($python, $venvPython)) {
    $rule = 'NJCB-python-test-' + [guid]::NewGuid().ToString('N')
    New-NetFirewallRule -DisplayName $rule -Direction Outbound -Program $program -Action Block -RemoteAddress '1.0.0.0-126.255.255.255','128.0.0.0-254.255.255.255','2000::/3' | Out-Null
    $rules += $rule
  }
  $probe = @'
import urllib.request
try:
    urllib.request.urlopen('https://pypi.org/simple/', timeout=4)
except OSError:
    print('Public Python index blocked')
else:
    raise SystemExit('ERROR: Public index unexpectedly reachable')
'@
  & $python -c $probe
  if ($LASTEXITCODE) { throw 'Python offline firewall check failed.' }
  # The shipped installer configures pip and installs directly from the wheel directory.
  & (Join-Path $Bundle 'Install-python.ps1') -InstallDir $InstallDir
  if ($LASTEXITCODE) { throw 'Shipped Python installation failed.' }
  & $python -m pip config --user get global.index-url
  if ($LASTEXITCODE) { throw 'User pip configuration missing.' }
  # A fresh venv has none of the office dependencies from the desktop runtime.
  & $venvPython -m pip --isolated --disable-pip-version-check install --no-cache-dir --only-binary=:all: --index-url http://127.0.0.1:4873/python/simple/ --require-hashes -r "$Bundle\python\requirements.txt"
  if ($LASTEXITCODE) { throw 'Cold installation through the Python HTTP index failed.' }
  & $venvPython -m pip check
  if ($LASTEXITCODE) { throw 'Incomplete Python dependency closure.' }
  & $venvPython "$Bundle\python-smoke.py"
  if ($LASTEXITCODE) { throw 'PDF to PPT smoke failed in clean environment.' }
  @{ python=(& $python --version); userInstall=$true; coldHttpInstall=$true; publicNetworkBlocked=$true; pdfRenderAndPptx=$true } | ConvertTo-Json | Set-Content "$Bundle\python-validation.json" -Encoding utf8
} finally {
  foreach ($rule in $rules) { Remove-NetFirewallRule -DisplayName $rule }
  $env:PYTHONUSERBASE = $oldUserBase
  $env:APPDATA = $oldAppData
}
