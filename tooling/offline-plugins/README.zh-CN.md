# NJCB Harness Windows x64 插件离线包

适用安装包：`njcb-harness-0.2.2-alpha.3.20261104.1-win-x64-unsigned.exe`，Harness 运行时 `0.2.2-alpha.3`。版本与完整依赖由 `selection.json`、`resolution/package-lock.json` 锁定。此包提供 13 个插件及 Windows x64 的 npm 依赖和本地安装源，不包含模型服务。

## 内网安装

1. 完整解压 ZIP 到本地固定目录，例如 `C:\njcb-offline-plugins`，不要在 ZIP 内直接运行。
2. 双击 `Start-offline-registry.cmd`。窗口出现 `http://127.0.0.1:4873/` 后保持打开。自带 Node，不需要安装 npm、Node 或 Python；源只允许本机访问，不连接外网。
3. 推荐在 NJCB Harness「添加插件」选择「自定义地址」，填入 `http://127.0.0.1:4873/`。逐个复制 `plugins.txt` 中的完整 `包名@版本` 并安装。重启应用后检查插件状态。
4. 如需一次安装全部：先启动过 NJCB Harness 以初始化 desktop profile，然后从托盘彻底退出；双击 `Install-plugins.cmd`。自定义安装目录时，在终端运行 `Install-plugins.cmd -InstallDir "D:\Apps\njcb harness"`。它调用安装包自带的 CLI，不替换现有配置，也不绕过版本检查。执行前建议备份 `%USERPROFILE%\.dsh\profiles\desktop`。
5. 安装完成可关闭临时源窗口。插件自身运行不依赖这个源；后续安装/升级时才需再次打开。

源仅收录本次清单与依赖，不是全量 npm 镜像。已有额外插件、额外 scope 源配置或代理配置可能导致安装请求超出清单；如出现 `NOT IN SNAPSHOT`，保留包名和错误日志，不要随意更改版本。不要点「全部更新」尝试更新到公网最新版。

## 功能所需的内网资源

- `@openviking/dsh-memory-plugin` 需要可访问的 OpenViking 服务。配置 `OPENVIKING_URL`、`OPENVIKING_API_KEY` 或 `%USERPROFILE%\.openviking\ovcli.conf`。此包只带 DSH 插件，不含 OpenViking 服务端、数据库或模型。所选版本不提供 0.5.33 新增的 rule-search 功能。官方说明：https://docs.openviking.ai/en/agent-integrations/17-dsh
- `@liustack/modlens` 需要插件设置中的视觉模型 API、模型名和密钥；使用内网视觉服务。安装完成不表示已有 OCR/图像理解模型。
- `dsh-ego-browser` 和 `dsh-univer-office` 的浏览器渲染功能需要本机 Chrome/Chromium/Edge。优先使用目标 Windows 已安装的 Edge；Office 可设置 `browserExecutablePath` 或 `UNIVER_RENDER_BROWSER`，Ego 可设置 `EGO_LINUX_CHROME`。不在线下载浏览器。
- `dsh-ops` 的 Windows Bash 载荷纳入 npm 依赖快照。PowerShell 由系统/管理员提供，PowerShell 7 不是本包内容；需要 7.x 的能力应提前离线部署对应运行时。
- `billion-context` 的压缩和其他调用模型的插件仍需可访问的内网模型服务；插件资源中的远程网页、在线技能仓库、云接口和更新检查不会因为离线安装而变成本地服务。
- 若组织要求禁用 Univer 匿名遥测，在启动 NJCB Harness 的环境中设置 `DO_NOT_TRACK=1`，或在插件中设置 `telemetry: false`。

## 故障定位

如果再次出现 `configured to use 11.7.0 of pnpm / current 11.28.5`，这是目标 profile 或上层目录中的包管理器版本声明冲突，不是缺少 npm 源。关闭应用后先尝试本包的批量安装脚本（它清除子进程继承的 Corepack 上下文）；如仍报错，保留 `%USERPROFILE%\.dsh\profiles\desktop\package.json`、`pnpm-workspace.yaml` 与 `.plugin-manager\logs`，定位声明后再修改。不要重装系统 pnpm 或删除整个 profile。

完整依赖原始 npm 压缩包保留上游许可证与 NOTICE；`registry.json` 记录上游下载地址、版本、SHA256。`SHA256SUMS.txt` 校验所有 tarball。`validation.json` 记录本次 Windows 构建验证范围；验证不包含真实模型、OpenViking 服务连接或银行业务场景验收。
