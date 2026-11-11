param(
  [string]$ProfileName = 'desktop',
  [string]$ProcessName = 'njcb harness',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

# 失败时只打一行可读的原因，不要把 PowerShell 的调用栈糊到零基础用户脸上。
# 退出码 1 让 cmd 那边能显示出来，也方便批量部署时判断成败。
trap {
  Write-Host ''
  Write-Host ('[失败] ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}

# 清掉 profile 里记着的依赖解析结果：pnpm-lock.yaml 与 node_modules。
#
# 这两样东西决定「装哪个版本」——锁文件把上一次解析出来的版本号写死，
# node_modules 留着已装好的实物。内网源的包更新过之后，旧的解析结果就会
# 和新源对不上，症状是安装直接失败（例如
# No matching version found for ws@8.22.1），此时只有清掉这两样、让 pnpm
# 重新解析一遍才能好。
#
# 为什么是改名不是删除：node_modules 动辄几百 MB，改名是瞬间完成的，而且
# 随时能改回来；确认重装正常之后再删备份，才需要真正花时间删。
#
# 为什么先结束进程：客户端运行时 node_modules 里的 .node 原生模块已经加载
# 进进程，Windows 会锁住这些文件，改名必然报「另一个程序正在使用此文件」。

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$onWindows = ($PSVersionTable.PSEdition -ne 'Core') -or ($IsWindows -ne $false)

function Write-Step([string]$text) {
  Write-Host ''
  Write-Host $text -ForegroundColor Cyan
}

function Get-AppProcess {
  @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
}

function Get-FolderSize([string]$path) {
  # 只是给用户一个「能回收多少」的概念，统计失败不影响清理本身。
  try {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (!$item.PSIsContainer) { return [int64]$item.Length }
    # 只统计文件：目录项没有 Length 属性，混进 Measure-Object 会刷噪。
    $sum = (Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { -not $_.PSIsContainer } |
      Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return [int64]0 }
    return [int64]$sum
  } catch {
    return [int64]0
  }
}

function Format-Size([int64]$bytes) {
  if ($bytes -ge 1GB) { return ('{0:N2} GB' -f ($bytes / 1GB)) }
  if ($bytes -ge 1MB) { return ('{0:N1} MB' -f ($bytes / 1MB)) }
  if ($bytes -ge 1KB) { return ('{0:N0} KB' -f ($bytes / 1KB)) }
  return "$bytes B"
}

# 改名，而不是删除。目标名被占用时（上一次清理留下的备份）加时间戳另存，
# 绝不静默丢掉上一份备份——那可能是唯一还能改回去的副本。
function Move-Aside([string]$path) {
  $backup = $path + '.bak'
  if (Test-Path -LiteralPath $backup) {
    $backup = "$path.bak-$stamp"
    $n = 2
    while (Test-Path -LiteralPath $backup) {
      $backup = "$path.bak-$stamp-$n"
      $n++
    }
  }
  if ($DryRun) {
    Write-Host ("  [预览] {0} -> {1}" -f [System.IO.Path]::GetFileName($path), [System.IO.Path]::GetFileName($backup))
    return $null
  }
  $lastError = $null
  for ($i = 1; $i -le 3; $i++) {
    try {
      Rename-Item -LiteralPath $path -NewName ([System.IO.Path]::GetFileName($backup)) -ErrorAction Stop
      Write-Host ("  已改名 {0} -> {1}" -f [System.IO.Path]::GetFileName($path), [System.IO.Path]::GetFileName($backup))
      return $backup
    } catch {
      $lastError = $_
      if ($i -lt 3) { Start-Sleep -Seconds 2 }
    }
  }
  throw ("无法重命名 " + $path + "：" + $lastError.Exception.Message +
    [Environment]::NewLine + "多半是还有进程占着里面的文件。请在托盘图标上右键退出客户端后重试；" +
    [Environment]::NewLine + "仍然不行就用管理员身份运行一次。")
}

$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
if (!$homeDir) { throw '读不到用户主目录（USERPROFILE / HOME 都是空的）。' }
$profileDir = [System.IO.Path]::Combine($homeDir, '.dsh', 'profiles', $ProfileName)
$targets = @(
  [System.IO.Path]::Combine($profileDir, 'pnpm-lock.yaml'),
  [System.IO.Path]::Combine($profileDir, 'node_modules')
)

Write-Host ''
Write-Host '=== 清理 njcb harness 的旧解析记录 ==='
Write-Host ("配置目录：{0}" -f $profileDir)
if ($DryRun) { Write-Host '预览模式：只显示将要做什么，不改动任何文件。' -ForegroundColor Yellow }

if (!(Test-Path -LiteralPath $profileDir)) {
  Write-Host ''
  Write-Host '这个配置目录不存在，无需清理。' -ForegroundColor Green
  Write-Host '（客户端还没启动过，或 profile 名字不是 desktop。启动一次客户端会自动创建。）'
  exit 0
}

$existing = @($targets | Where-Object { Test-Path -LiteralPath $_ })
if ($existing.Count -eq 0) {
  Write-Host ''
  Write-Host '没有需要清理的内容：pnpm-lock.yaml 和 node_modules 都不存在。' -ForegroundColor Green
  Write-Host '如果安装仍报「没有匹配的版本」，问题不在本机的解析记录，请看 README 的故障一节。'
  exit 0
}

# 1) 先关进程，否则 Windows 会锁住 node_modules 里的原生模块。
Write-Step '[1/3] 关闭 njcb harness'
$running = Get-AppProcess
if ($running.Count -eq 0) {
  Write-Host '  没有在运行的进程。'
} else {
  Write-Host ("  发现 {0} 个进程：" -f $running.Count)
  foreach ($p in $running) {
    $path = '(路径不可读)'
    try { if ($p.Path) { $path = $p.Path } } catch { }
    Write-Host ("    PID {0}  {1}  {2}" -f $p.Id, $p.ProcessName, $path)
  }
  if ($DryRun) {
    Write-Host '  [预览] 会结束上面这些进程'
  } else {
    # 结束进程会丢掉客户端里没保存的东西，所以留 3 秒给人按 Ctrl+C 反悔。
    Write-Host '  3 秒后结束这些进程，要取消请按 Ctrl+C。'
    Start-Sleep -Seconds 3
    # taskkill 的 /T 连子进程一起结束；进程名相同的那几个 helper 由 /IM 覆盖。
    if ($onWindows) { & taskkill.exe /IM "$ProcessName.exe" /T /F *> $null }
    $left = Get-AppProcess
    if ($left.Count -gt 0) { $left | Stop-Process -Force -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-AppProcess).Count -gt 0 -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 300
    }
    $left = Get-AppProcess
    if ($left.Count -gt 0) {
      $detail = ($left | ForEach-Object { "    PID $($_.Id)  $($_.ProcessName)" }) -join [Environment]::NewLine
      throw ('这些进程没能结束，请手动从托盘图标退出后重试：' + [Environment]::NewLine + $detail)
    }
    Write-Host '  已全部结束。'
    Start-Sleep -Milliseconds 800
  }
}

# 2) 改名。锁文件在前：它是「记住的版本」，也是体积小的那个。
Write-Step '[2/3] 清理旧解析记录'
$renamed = @()
foreach ($path in $existing) {
  $name = [System.IO.Path]::GetFileName($path)
  $size = Get-FolderSize $path
  Write-Host ("  {0}（{1}）" -f $name, (Format-Size $size))
  $backup = Move-Aside $path
  if ($backup) {
    $renamed += [pscustomobject]@{ Source = $path; Backup = $backup; Size = $size }
  }
}

# 3) 汇总，并把下一步写清楚：这次清理本身不会重装任何东西。
Write-Step '[3/3] 完成'
if ($DryRun) {
  Write-Host '预览结束，没有改动任何文件。去掉 -DryRun 才会真的执行。' -ForegroundColor Yellow
  exit 0
}

$allBackups = @(Get-ChildItem -LiteralPath $profileDir -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'pnpm-lock.yaml.bak*' -or $_.Name -like 'node_modules.bak*' })
$totalBytes = [int64]0
Write-Host ''
Write-Host '磁盘上的备份（确认重装正常后可以删）：'
foreach ($b in $allBackups) {
  $isNew = @($renamed | Where-Object { $_.Backup -eq $b.FullName }).Count -gt 0
  $size = Get-FolderSize $b.FullName
  $totalBytes += $size
  $tag = if ($isNew) { '' } else { '  （更早一次清理留下的）' }
  Write-Host ("  {0}  {1}{2}" -f $b.Name, (Format-Size $size), $tag)
}
Write-Host ("  合计 {0}" -f (Format-Size $totalBytes))

Write-Host ''
Write-Host '下一步：' -ForegroundColor Green
Write-Host '  1) 双击 Install-plugins.cmd 重新安装，这次会重新解析版本，不再套用旧的。'
Write-Host '  2) 启动客户端 → 插件 → 已安装，确认 22 项都在并处于启用状态。'
Write-Host ''
Write-Host '想马上回收磁盘空间，在 cmd 里执行（路径按上面列出的逐个来）：'
foreach ($b in $allBackups) {
  if ($b.PSIsContainer) {
    Write-Host ('  rmdir /s /q "' + $b.FullName + '"')
  } else {
    Write-Host ('  del /q "' + $b.FullName + '"')
  }
}
exit 0
