param([Parameter(Mandatory=$true)][string]$Bundle, [Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$Bundle = (Resolve-Path $Bundle).Path
$dest = Join-Path $env:RUNNER_TEMP 'njcb-offline-installed'
$setup = Start-Process (Resolve-Path $Installer).Path -ArgumentList "/S /D=$dest" -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
$exe = Join-Path $dest 'njcb harness.exe'
$env:DSH_HOME = Join-Path $env:RUNNER_TEMP 'njcb-offline-empty-home'
$profileDir = Join-Path $env:DSH_HOME 'profiles\desktop'
$env:DO_NOT_TRACK = '1'
$env:DSH_TELEMETRY_DISABLED = '1'
$env:PNPM_HOME = Join-Path $env:RUNNER_TEMP 'njcb-empty-pnpm-home'
$env:npm_config_store_dir = Join-Path $env:RUNNER_TEMP 'njcb-empty-pnpm-store'
$env:npm_config_cache = Join-Path $env:RUNNER_TEMP 'njcb-empty-npm-cache'
Remove-Item Env:COREPACK_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$userData = Join-Path $env:RUNNER_TEMP 'njcb-offline-user-data'
$app = Start-Process $exe -ArgumentList "--user-data-dir=$userData" -PassThru
try {
  for ($i = 0; $i -lt 45; $i++) {
    if (Test-Path (Join-Path $profileDir 'package.json')) { break }
    Start-Sleep 1
  }
  if (!(Test-Path (Join-Path $profileDir 'package.json'))) { throw 'Desktop did not initialize its normal profile.' }
} finally { & taskkill.exe /PID $app.Id /T /F 2>$null | Out-Host }
Start-Sleep 3
$node = Join-Path $Bundle 'node\node.exe'
$registry = Start-Process $node -ArgumentList "`"$Bundle\serve.mjs`"" -RedirectStandardOutput "$Bundle\registry-stdout.log" -RedirectStandardError "$Bundle\registry-stderr.log" -PassThru
$rules = @()
$firewallProfiles = Get-NetFirewallProfile | Select-Object Name, Enabled
try {
  for ($i=0; $i -lt 20; $i++) {
    try { $null = Invoke-RestMethod 'http://127.0.0.1:4873/-/ping'; break } catch { Start-Sleep 1 }
  }
  foreach ($program in @($exe, $node)) {
    $name = 'NJCB-offline-test-' + [guid]::NewGuid().ToString()
    $null = New-NetFirewallRule -DisplayName $name -Direction Outbound -Program $program -Action Block -RemoteAddress '1.0.0.0-126.255.255.255','128.0.0.0-254.255.255.255','2000::/3'
    $rules += $name
  }
  Set-NetFirewallProfile -All -Enabled True
  & $node -e "fetch('https://registry.npmjs.org/',{signal:AbortSignal.timeout(4000)}).then(()=>{console.error('Internet unexpectedly reachable');process.exit(1)}).catch(()=>console.log('External network blocked'))"
  if ($LASTEXITCODE) { throw 'Offline firewall check failed' }
  & (Join-Path $Bundle 'Install-plugins.ps1') -InstallDir $dest
  if ($LASTEXITCODE) { throw 'Offline profile installation failed' }
  $selected = Get-Content "$Bundle\selection.json" -Raw | ConvertFrom-Json
  $installed = @()
  foreach ($property in $selected.plugins.PSObject.Properties) {
    $manifest = Get-Content (Join-Path $profileDir "node_modules\$($property.Name)\package.json") -Raw | ConvertFrom-Json
    if ($manifest.version -ne $property.Value) { throw "Wrong installed version for $($property.Name)" }
    $installed += "$($manifest.name)@$($manifest.version)"
  }
  # Launch the actual desktop again with the installed third-party profile.
  $app = Start-Process $exe -ArgumentList "--user-data-dir=$userData --remote-debugging-port=49317" -RedirectStandardOutput "$Bundle\desktop-stdout.log" -RedirectStandardError "$Bundle\desktop-stderr.log" -PassThru
  try {
    Start-Sleep 35
    $app.Refresh()
    if ($app.HasExited) { throw "Desktop exited after plugin installation: $($app.ExitCode)" }
    $pages = Invoke-RestMethod 'http://127.0.0.1:49317/json/list'
    $pages | ConvertTo-Json -Depth 10 | Set-Content "$Bundle\desktop-pages.json" -Encoding utf8
    if (!($pages | Where-Object { $_.type -eq 'page' })) { throw 'No desktop renderer page was created.' }
    & $node (Join-Path $PSScriptRoot 'inspect-desktop.mjs') $Bundle
    if ($LASTEXITCODE) { throw 'Desktop renderer inspection failed' }
  } finally { & taskkill.exe /PID $app.Id /T /F 2>$null | Out-Host }
  $profile = Get-Content (Join-Path $profileDir 'package.json') -Raw | ConvertFrom-Json
  $profile | ConvertTo-Json -Depth 30 | Set-Content "$Bundle\validated-profile.json" -Encoding utf8
  Copy-Item (Join-Path $profileDir 'pnpm-lock.yaml') "$Bundle\validated-pnpm-lock.yaml"
  @{ platform='Windows Server 2022 x64 GitHub runner'; target='Windows 10 22H2 x64'; runtime=$selected.runtime; installed=$installed; coldCache=$true; externalNetworkBlockedForNodeAndElectron=$true; desktopProcessStarted=$true; functionalAcceptance='Not exercised: model APIs, OpenViking service, browser actions, all plugin tools'; time=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 10 | Set-Content "$Bundle\validation.json" -Encoding utf8
} finally {
  foreach ($rule in $rules) { Remove-NetFirewallRule -DisplayName $rule }
  foreach ($state in $firewallProfiles) { Set-NetFirewallProfile -Name $state.Name -Enabled $state.Enabled }
  if (!$registry.HasExited) { Stop-Process -Id $registry.Id -Force }
  if (Test-Path "$userData\logs") { Copy-Item "$userData\logs" "$Bundle\desktop-logs" -Recurse }
  if (Test-Path "$profileDir\.plugin-manager\logs") { Copy-Item "$profileDir\.plugin-manager\logs" "$Bundle\install-logs" -Recurse }
}
