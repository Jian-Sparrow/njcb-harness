param(
  [string]$ProfileName = 'desktop',
  [string]$ProcessName = 'njcb harness',
  [switch]$FreshPlugins,
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

# 把插件清单也清空，回到「只有客户端自带层」的状态。
#
# 只清 pnpm-lock.yaml 和 node_modules 不够：客户端的「添加插件」和市场的安装
# 都是在 profile 里跑 `pnpm add`，而 pnpm 会把 package.json 里已有的依赖一并装
# 回来。那些依赖是 `--save-exact` 存的，如果新离线包换了插件版本，旧版本号在
# 新源里不存在，装市场时会直接报 No matching version —— 清锁文件救不了这一层。
#
# 只删「插件」，不删整个 package.json：这个文件里还可能有安装自带的包覆盖
# （@deepseek-ai/dsh 一类），删掉会让客户端起不来。判定标准是「既是
# dependencies 里的项，又出现在 dsh.profile.bundles 里，或它自己的 manifest
# 声明了 dsh.bundle」—— 安装自带的层不在 dependencies 里，因此不会被误删。
function Reset-PluginList {
  $manifestPath = [System.IO.Path]::Combine($profileDir, 'package.json')
  if (!(Test-Path -LiteralPath $manifestPath)) {
    Write-Host '  没有 package.json（profile 还没初始化），跳过。'
    return
  }
  $raw = [System.IO.File]::ReadAllText($manifestPath)
  $manifest = $null
  try { $manifest = $raw | ConvertFrom-Json } catch {
    throw ("$manifestPath 不是合法 JSON，没有改动它：" + $_.Exception.Message)
  }
  if (!$manifest.dependencies) {
    Write-Host '  package.json 里没有依赖，插件清单已经是空的。'
    return
  }
  $bundles = @()
  if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $bundles = @($manifest.dsh.profile.bundles)
  }
  $plugins = New-Object System.Collections.ArrayList
  foreach ($name in @($manifest.dependencies.PSObject.Properties.Name)) {
    $isBundle = $bundles -contains $name
    $declares = $false
    $installed = [System.IO.Path]::Combine($profileDir, 'node_modules', $name, 'package.json')
    if (Test-Path -LiteralPath $installed) {
      try { $declares = $null -ne ($installed | Get-Content -Raw | ConvertFrom-Json).dsh.bundle } catch { }
    }
    if ($isBundle -or $declares) { [void]$plugins.Add($name) }
  }
  if ($plugins.Count -eq 0) {
    Write-Host '  dependencies 里没有插件（只剩安装自带的包），无需清空。'
    return
  }
  Write-Host ("  将移除 {0} 个插件：" -f $plugins.Count)
  foreach ($name in $plugins) { Write-Host ("    {0}" -f $name) }
  if ($DryRun) { return }

  $backup = "$manifestPath.bak-$stamp"
  $n = 2
  while (Test-Path -LiteralPath $backup) {
    $backup = "$manifestPath.bak-$stamp-$n"
    $n++
  }
  Copy-Item -LiteralPath $manifestPath -Destination $backup
  foreach ($name in $plugins) { $manifest.dependencies.PSObject.Properties.Remove($name) }
  if ($bundles.Count -gt 0) {
    $kept = @($bundles | Where-Object { $plugins -notcontains $_ })
    $manifest.dsh.profile.bundles = $kept
  }
  $json = $manifest | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("  已清空插件清单（原文件备份为 {0}）" -f [System.IO.Path]::GetFileName($backup))
  $script:freshBackup = $backup
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
$manifestPath = [System.IO.Path]::Combine($profileDir, 'package.json')
if ($existing.Count -eq 0 -and !($FreshPlugins -and (Test-Path -LiteralPath $manifestPath))) {
  Write-Host ''
  Write-Host '没有需要清理的内容：pnpm-lock.yaml 和 node_modules 都不存在。' -ForegroundColor Green
  Write-Host '如果安装仍报「没有匹配的版本」，问题不在本机的解析记录，请看 README 的故障一节。'
  exit 0
}

$total = if ($FreshPlugins) { 4 } else { 3 }
$freshBackup = $null

# 1) 先关进程，否则 Windows 会锁住 node_modules 里的原生模块。
Write-Step ("[1/{0}] 关闭 njcb harness" -f $total)
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

if ($FreshPlugins) {
  # 2) 插件清单必须在 node_modules 还在的时候处理：判定「是不是插件」要看
  #    每个包自己的 manifest 有没有 dsh.bundle。
  Write-Step ("[2/{0}] 清空插件清单" -f $total)
  Reset-PluginList
}

# 3) 改名。锁文件在前：它是「记住的版本」，也是体积小的那个。
$renameStep = if ($FreshPlugins) { 3 } else { 2 }
Write-Step ("[{0}/{1}] 清理旧解析记录" -f $renameStep, $total)
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

# 4) 汇总，并把下一步写清楚：这次清理本身不会重装任何东西。
Write-Step ("[{0}/{0}] 完成" -f $total)
if ($DryRun) {
  Write-Host '预览结束，没有改动任何文件。去掉 -DryRun 才会真的执行。' -ForegroundColor Yellow
  exit 0
}

$allBackups = @(Get-ChildItem -LiteralPath $profileDir -Force -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -like 'pnpm-lock.yaml.bak*' -or $_.Name -like 'node_modules.bak*' -or $_.Name -like 'package.json.bak*'
  })
$totalBytes = [int64]0
Write-Host ''
Write-Host '磁盘上的备份（确认重装正常后可以删）：'
foreach ($b in $allBackups) {
  $isNew = (@($renamed | Where-Object { $_.Backup -eq $b.FullName }).Count -gt 0) -or ($b.FullName -eq $freshBackup)
  $size = Get-FolderSize $b.FullName
  $totalBytes += $size
  $tag = if ($isNew) { '' } else { '  （更早一次清理留下的）' }
  Write-Host ("  {0}  {1}{2}" -f $b.Name, (Format-Size $size), $tag)
}
Write-Host ("  合计 {0}" -f (Format-Size $totalBytes))

Write-Host ''
Write-Host '下一步：' -ForegroundColor Green
if ($FreshPlugins) {
  Write-Host '  1) 启动客户端 → 插件 → 添加插件 → 自定义地址填 http://127.0.0.1:4873/ → 安装 dshmarket。'
  Write-Host '  2) 重启客户端，打开「插件市场」；标题栏出现「内网离线」即正常（市场包自带内网模式）。'
  Write-Host '  3) 在市场里按需安装其余插件，不用一次装齐。'
} else {
  Write-Host '  1) 双击 Install-plugins.cmd 重新安装，这次会重新解析版本，不再套用旧的。'
  Write-Host '  2) 启动客户端 → 插件 → 已安装，确认 22 项都在并处于启用状态。'
}
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
