param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\njcb harness'),
  [switch]$Force,
  [switch]$SkipMarketConfig
)
$ErrorActionPreference = 'Stop'
$ProfileName = 'desktop'
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

# The market's intranet switch is one row in the profile's own patch layer, and
# the operator who needs it is the one least able to hand-edit YAML in Notepad:
# a stray Tab, a `.txt` suffix or an ANSI save turns the row off silently, and
# the symptom is a market that hangs instead of an error about the file. So the
# installer writes it once, after the row it targets exists.
#
# Three facts this has to survive, each learned the hard way:
#
#  - A freshly initialized profile's patch layer is three comments and a
#    top-level `[]` (PROFILE_PATCH_TEMPLATE). Appending rows after that flow
#    array is a YAML parse error — measured: "end of the stream or a document
#    separator is expected" — and parsePatchList throws, so the whole profile
#    fails to load and the client does not start. The placeholder is REPLACED,
#    never appended to.
#  - An existing file may have been saved as ANSI/GBK by Notepad. It is never
#    decoded: a byte-per-char view (ISO-8859-1) is used for the ASCII checks and
#    the same view is written back, so every byte this script does not insert
#    leaves the file exactly as it was. Re-encoding a GBK comment through UTF-8
#    would replace it with U+FFFD and break the file.
#  - A row that already names a registry is a decision about THIS network, and
#    `config` replaces wholesale — writing ours would take their mirror away.
#    That case is reported, not overwritten.
function Enable-OfflineMarket([string]$name) {
  $profileDir = Join-Path $env:USERPROFILE (Join-Path '.dsh\profiles' $name)
  if (!(Test-Path $profileDir)) {
    Write-Host "WARN: $profileDir does not exist, so the plugin market was left alone."
    Write-Host 'WARN: start njcb harness once (it creates the profile), then re-run this script without -SkipMarketConfig.'
    return
  }
  $patch = Join-Path $profileDir 'cordis.patch.yml'
  $block = @(
    '# Added by Install-plugins.cmd: point the plugin market at the local snapshot',
    '# registry instead of the public catalog. Delete these three lines to restore',
    '# the default (public internet) behaviour.',
    '- id: dsh-market',
    '  config:',
    '    offline: true'
  ) -join "`r`n"
  $latin1 = [System.Text.Encoding]::GetEncoding(28591)
  if (!(Test-Path $patch)) {
    [System.IO.File]::WriteAllBytes($patch, $latin1.GetBytes($block + "`r`n"))
    Write-Host "Plugin market: intranet mode enabled in $patch"
    return
  }

  # One byte in, one char out: indexes below are byte offsets, and no byte is
  # ever re-encoded, so a BOM or a GBK comment survives untouched.
  $bytes = [System.IO.File]::ReadAllBytes($patch)
  $text = $latin1.GetString($bytes)
  # `\r?$` and not `$`: these files are written on Windows, and .NET anchors
  # `$` before the \n while leaving the \r inside the line, so a plain `$`
  # never matches a CRLF row — the check would report "no row" forever and
  # append a duplicate on every run.
  $row = [regex]::Match($text, '(?m)^[ \t]*-[ \t]*id:[ \t]*dsh-market[ \t]*\r?$')
  if ($row.Success) {
    # Only this row's own body counts: another plugin's `offline: true`
    # elsewhere in the file says nothing about the market.
    $rest = $text.Substring($row.Index + $row.Length)
    $next = [regex]::Match($rest, '(?m)^[ \t]*-[ \t]*id:')
    $body = if ($next.Success) { $rest.Substring(0, $next.Index) } else { $rest }
    if ($body -match '(?m)^[ \t]+offline:[ \t]*true[ \t]*\r?$') {
      Write-Host "Plugin market: intranet mode already configured in $patch"
      return
    }
    if ($body -match '(?m)^[ \t]+npmRegistry:') {
      Write-Host "WARN: $patch already has a dsh-market row with its own npmRegistry and no 'offline: true'."
      Write-Host "WARN: add 'offline: true' under that row's config: and restart njcb harness. Left unchanged."
      return
    }
    # A row with neither is what an earlier manual attempt leaves behind —
    # often carrying a `catalog:` address that cannot answer. Our entry comes
    # later in the same layer, so it wins per row and replaces that config.
    Write-Host "Plugin market: replacing the existing dsh-market row (it set neither offline nor npmRegistry)."
  }

  $lines = $text -split "`r`n|`n"
  $significant = @($lines | Where-Object { $_ -match '\S' -and $_ -notmatch '^\s*#' })
  if ($significant.Count -eq 1 -and $significant[0] -match '^\s*\[\s*\]\s*$') {
    $placeholder = [regex]::Match($text, '(?m)^[ \t]*\[\][ \t]*(?:\r?\n|$)')
    $remainder = if ($placeholder.Success) { $text.Remove($placeholder.Index, $placeholder.Length) } else { $text }
    $remainder = $remainder.TrimEnd([char]13, [char]10)
    $rewritten = if ($remainder -eq '') { $block } else { $remainder + "`r`n" + $block }
    [System.IO.File]::WriteAllBytes($patch, $latin1.GetBytes($rewritten + "`r`n"))
    Write-Host "Plugin market: intranet mode enabled in $patch (the empty [] placeholder was replaced)"
    return
  }
  $append = if ($bytes.Length -gt 0) { "`r`n" + $block } else { $block }
  [System.IO.File]::WriteAllBytes($patch, $latin1.GetBytes($text + $append + "`r`n"))
  Write-Host "Plugin market: intranet mode enabled in $patch"
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
& $cli plugin --profile $ProfileName add --save-exact "--registry=$url" @specs
if ($LASTEXITCODE) { throw "Installation failed ($LASTEXITCODE). Keep the output and inspect the profile .plugin-manager logs." }
Write-Host 'Installed all selected plugins.'
if (-not $SkipMarketConfig) { Enable-OfflineMarket $ProfileName }
Write-Host 'Close the registry and restart njcb harness.'
