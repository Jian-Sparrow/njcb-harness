param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\njcb harness'),
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$cli = Join-Path $InstallDir 'resources\runtime\cli\bin\dsh.cmd'
if (!(Test-Path $cli)) { throw "Cannot find dsh.cmd. Run: Install-plugins.cmd -InstallDir <your-install-directory>" }

# A running desktop keeps the profile's node_modules and pnpm store open, so an
# install underneath it leaves a half-linked tree that only a reinstall fixes.
# The app lives in the tray: closing the window is not quitting it, and its
# helper processes carry the same executable name — so the refusal names every
# process it found instead of only asking the user to quit again.
function Describe-RunningProcess($process) {
  $path = '(path unavailable)'
  try { if ($process.Path) { $path = $process.Path } } catch { }
  return "  PID $($process.Id)  $($process.ProcessName)  $path"
}
$running = @(Get-Process -Name 'njcb harness' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  $details = ($running | ForEach-Object { Describe-RunningProcess $_ }) -join [Environment]::NewLine
  if ($Force) {
    Write-Host 'Closing njcb harness because -Force was given:'
    Write-Host $details
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    $stillThere = @(Get-Process -Name 'njcb harness' -ErrorAction SilentlyContinue)
    if ($stillThere.Count -gt 0) {
      $left = ($stillThere | ForEach-Object { Describe-RunningProcess $_ }) -join [Environment]::NewLine
      throw ("These processes survived Stop-Process; quit them from the tray icon, then retry:" + [Environment]::NewLine + $left)
    }
  } else {
    throw ("njcb harness is still running. Right-click its tray icon and choose Quit (closing the window is not enough), then run this script again." + [Environment]::NewLine + "Running now:" + [Environment]::NewLine + $details + [Environment]::NewLine + "To let this script close them for you, run: Install-plugins.cmd -Force")
  }
}

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
