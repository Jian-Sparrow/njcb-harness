param([string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\njcb harness'))
$ErrorActionPreference = 'Stop'
$cli = Join-Path $InstallDir 'resources\runtime\cli\bin\dsh.cmd'
if (!(Test-Path $cli)) { throw "Cannot find dsh.cmd. Run: Install-plugins.cmd -InstallDir <your-install-directory>" }
if (Get-Process -Name 'njcb harness' -ErrorAction SilentlyContinue) { throw 'Fully quit njcb harness, including the tray icon, then retry.' }
$port = if ($env:NJCB_OFFLINE_PORT) { $env:NJCB_OFFLINE_PORT } else { '4873' }
$url = "http://127.0.0.1:$port/"
$health = Invoke-RestMethod ($url + '-/ping')
if ($health.service -ne 'njcb-offline-plugins') { throw 'The local registry is not the NJCB offline snapshot.' }
$selection = Get-Content (Join-Path $PSScriptRoot 'selection.json') -Raw | ConvertFrom-Json
$specs = @($selection.plugins.PSObject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" })
# Use the desktop's exact bundled package manager and normal compatibility checks.
# Remove inherited Corepack dispatch context only for this script's child processes.
Remove-Item Env:COREPACK_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:COREPACK_HOME -ErrorAction SilentlyContinue
$env:DO_NOT_TRACK = '1'
$env:NO_PROXY = '127.0.0.1,localhost'
& $cli plugin --profile desktop add --save-exact "--registry=$url" @specs
if ($LASTEXITCODE) { throw "Installation failed ($LASTEXITCODE). Keep the output and inspect the profile .plugin-manager logs." }
Write-Host 'Installed all selected plugins. Close the registry and restart njcb harness.'
