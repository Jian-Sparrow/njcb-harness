# NJCB Harness Windows x64 插件离线包

> 面向使用者的分步操作随包分发：ZIP 里的 `INSTALL-GUIDE.zh-CN.md`（装客户端、配模型、装插件、加新插件、排错）。该文件只存在于离线包，不入库，本文是运维/打包侧的技术说明。

适用安装包：`njcb-harness-0.2.2-alpha.3.20261104.1-win-x64-unsigned.exe`，Harness 运行时 `0.2.2-alpha.3`。版本与完整依赖由 `selection.json`、`resolution/package-lock.json` 锁定。此包提供 21 个插件及 Windows x64 的 npm 依赖和本地安装源，不包含模型服务。

## 内网安装

1. 完整解压 ZIP 到本地固定目录，例如 `C:\njcb-offline-plugins`，不要在 ZIP 内直接运行。
2. 双击 `Start-offline-registry.cmd`。窗口出现 `http://127.0.0.1:4873/` 后保持打开。自带 Node，不需要安装 npm、Node 或 Python；源只允许本机访问，不连接外网。
3. 两种装法，任选：
   - **装了插件市场（dshmarket）**：打开市场即可看到本源的插件列表（名称、版本、说明）并直接安装。市场把源当目录读——源里有哪些插件就列哪些，依赖包不会混进来。后续往源里加插件见下文「往源里加插件」。
   - **用 NJCB Harness 自带入口**：在「添加插件」选「自定义地址」，填入 `http://127.0.0.1:4873/`，逐个复制 `plugins.txt` 中的完整 `包名@版本` 并安装。

   重启应用后检查插件状态。
4. 如需一次安装全部：先启动过 NJCB Harness 以初始化 desktop profile，然后从托盘彻底退出；双击 `Install-plugins.cmd`。自定义安装目录时，在终端运行 `Install-plugins.cmd -InstallDir "D:\Apps\njcb harness"`。它调用安装包自带的 CLI，不替换现有配置，也不绕过版本检查。执行前建议备份 `%USERPROFILE%\.dsh\profiles\desktop`。
5. 安装完成可关闭临时源窗口。插件自身运行不依赖这个源；后续安装/升级时才需再次打开。

源仅收录本次清单与依赖，不是全量 npm 镜像。已有额外插件、额外 scope 源配置或代理配置可能导致安装请求超出清单；如出现 `NOT IN SNAPSHOT`，保留包名和错误日志，不要随意更改版本。不要点「全部更新」尝试更新到公网最新版。

## 往源里加插件

源的清单就是 `registry.json` 加 `tarballs/`，`serve.mjs` 只读不写，所以「上传」在内网侧等于一次本地写入。把 `.tgz` 或 `.zip` 拖到 `Add-plugin.cmd` 上即可，或在命令行执行：

```bat
node\node.exe add-plugin.mjs D:\uploads\dsh-some-plugin-1.2.0.tgz
node\node.exe add-plugin.mjs D:\uploads\dsh-some-plugin.zip
node\node.exe add-plugin.mjs D:\uploads      :: 整个文件夹里的 .tgz/.zip 全加
node\node.exe add-plugin.mjs --list          :: 看源里现在有什么
```

它读包内的 `package.json`、把包写进 `tarballs/`、把版本写进 `registry.json`，并重算 `SHA256SUMS.txt` 与 `plugins.txt`。**源窗口不用重启**，刷新市场页面就能看到新插件。

两种压缩包都收：`npm pack` 出来的 `.tgz` 原样存入；`.zip` 会被**重新打包成 tarball**——客户端解包时会去掉一层路径，所以 zip 里那层 `dsh-foo/` 目录（或者干脆没有目录）必须先变成 `package/`，否则装进去是个空目录。转换规则：

- 只有一个顶层目录 → 去掉它，内容放到 `package/` 下；
- 顶层直接是文件（压缩时进到文件夹里再全选）→ 原样放到 `package/` 下；
- 已经是 `package/` 开头 → 不会重复套一层；
- `__MACOSX/`、`.DS_Store` 丢弃；可执行位保留；条目名里的反斜杠（旧版 PowerShell `Compress-Archive`）按路径分隔符处理；
- 转换结果是确定的：同一个 zip 转两次字节相同，所以重复执行会报「已存在且一致」，不会产生新版本。

`package.json` 必须在压缩包的顶层——压的是它的**父目录**就会报错并列出包里实际有哪些条目。

规则都是刻意的：

| 情况 | 结果 |
|---|---|
| `package.json` 里有 `dsh` 字段 | 作为插件上架，出现在市场列表里 |
| 没有 `dsh` 字段 | 存进源但不上架——它是依赖，列进市场只会在安装时出错 |
| 同版本、字节不同 | 拒绝。npm 也不允许覆盖已发布版本，客户端缓存过的副本会校验失败；确实要换加 `--force` |
| 版本比当前低 | 存进去但不动 `dist-tags.latest`；要回滚加 `--latest` |
| 插件依赖不在源里 | 照常上架，但会列出缺哪些依赖——否则装完才在启动日志里看到 |
| zip 是 ZIP64 / 加密 / 非 deflate 压缩 | 拒绝并说明换哪种打包方式。都是少见格式，静默转换会做出装不上的包 |

`--dry-run` 只报告不写入。

打包侧不必手工维护清单：以后重建整包时，`build-bundle.mjs` 会用上游版本覆盖同名条目，两边的 tarball 命名规则是同一套（`sha256("包名@版本").tgz`），不会因为手工加过就多出一份。

## 办公与开发场景的插件

除通用插件外，本包按两个场景补了 8 个。选型依据是「离线可用优先，其次看实际使用量」：周下载量和 star 只是筛选入口，真正决定的是解析依赖时全部来自 `registry.npmjs.org`、不引入安装期下载、不依赖公网服务。

| 插件 | 版本 | 场景 | 离线前提 |
|---|---|---|---|
| `dsh-ppt` | 0.20.5 | 办公：给材料出可交付 PPTX | 纯 JS 生成；`@deepseek-ai/libreoffice-kit` 是可选 peer，不装也能出 pptx，只影响转 PDF/重算 |
| `dsh-excel-chat` | 0.43.0 | 办公：对话式清洗、改表、出报表 | 无外部依赖 |
| `@michengai/dsh-code-review` | 1.0.10 | 开发：Codex 风格代码审查、子 Agent、中英文报告 | 调用内网模型；与已有 `@michengai` 三个插件同族，依赖不冲突 |
| `@goodandready/dsh-context-lens` | 0.1.35 | 开发（含 Java）：AST 骨架化 + 构建/测试日志压缩 | 声明支持 Java 与 Maven/Gradle，无外部依赖 |
| `dsh-diff-approval` | 0.37.4 | 开发：改动逐文件 diff 审阅 + Keep/Revert | 无外部依赖；包体较大（约 16 MB） |
| `dsh-auto-review` | 0.15.0 | 开发 / AI：第二个模型预审工具调用 | 需要在插件设置里指定一个可用的内网模型；没有第二个模型时不要启用 |
| `dsh-mcp-connector` | 0.2.97 | AI 开发：接本地或内网 MCP 服务 | 客户端走本地 stdio/HTTP；插件自带的在线目录指向公网，内网打不开属预期，手工填服务配置即可 |
| `dsh-refactor-insight` | 0.2.0 | 开发：把代码坏味道整理成可执行的重构清单 | 无外部依赖，纯 skill |

这 8 个都以固定版本写进 `selection.json`，与原有 13 个一起解析、一起打包；升级需要改这里再重建，不在内网侧升级。

### 为什么没有 `dsh-office-kit`

它不适合这个部署，原因有两层，第二层更致命：

1. **它的 `postinstall` 需要外网。** 脚本找一个 Python 3.10–3.13，找不到就从 `python.org` 下载安装包（校验签名后静默安装），再用 `pip` 从 PyPI 装 `python-docx`、`openpyxl`、`pypdf`、`reportlab`、`pymupdf` 等 10 个库。Win10 不自带 Python，内网又到不了这两个站点，脚本必然失败。
2. **它的存在会让整批安装失败，不是它一个装不上。** pnpm 默认不信任依赖的构建脚本，遇到就报 `ERR_PNPM_IGNORED_BUILDS` 并以退出码 1 结束。用户看到的是「22 个插件一个都没装上」，而不是「Word 那个没装上」——这种失败信息在现场几乎无法定位。

`build-bundle.mjs` 现在会在构建时检查整棵依赖树，只要有包声明 `preinstall`/`install`/`postinstall` 就直接中止并列出包名。这不是保守：内网里没有让这些脚本成功的条件，而放行它们等于把失败推迟到用户面前。要让这类插件可用，得先给它准备离线运行时（例如随包带 Python 和 wheelhouse），那是另一件事，不是改个配置能解决的。

## 功能所需的内网资源

- `@openviking/dsh-memory-plugin` 需要可访问的 OpenViking 服务。配置 `OPENVIKING_URL`、`OPENVIKING_API_KEY` 或 `%USERPROFILE%\.openviking\ovcli.conf`。此包只带 DSH 插件，不含 OpenViking 服务端、数据库或模型。所选版本不提供 0.5.33 新增的 rule-search 功能。官方说明：https://docs.openviking.ai/en/agent-integrations/17-dsh
- `@liustack/modlens` 需要插件设置中的视觉模型 API、模型名和密钥；使用内网视觉服务。安装完成不表示已有 OCR/图像理解模型。
- `dsh-ego-browser` 和 `dsh-univer-office` 的浏览器渲染功能需要本机 Chrome/Chromium/Edge。优先使用目标 Windows 已安装的 Edge；Office 可设置 `browserExecutablePath` 或 `UNIVER_RENDER_BROWSER`，Ego 可设置 `EGO_LINUX_CHROME`。不在线下载浏览器。
- `dsh-ops@0.4.1` 的 Windows Bash 载荷纳入 npm 依赖快照。该旧版本可通过当前 Harness 的版本检查及安装检查，但上游新版明确限制宿主 `<0.2.2-0`，且上游尚未确认完整支持 0.2.2。因此此插件仅作为待验收项提供，建议先不启用，单独验收文件/命令工具后再启用；不能以旧版声明较宽推断全面兼容。PowerShell 由系统/管理员提供，PowerShell 7 不是本包内容；需要 7.x 的能力应提前离线部署对应运行时。上游说明：https://github.com/T-Auto/dsh-ops/blob/main/docs/CHANGELOG.md
- `billion-context` 的压缩和其他调用模型的插件仍需可访问的内网模型服务；插件资源中的远程网页、在线技能仓库、云接口和更新检查不会因为离线安装而变成本地服务。
- `dsh-auto-review` 启用前必须在插件设置里指定一个可用的模型，否则每次工具调用都会停在待审状态。没有第二个模型时保持关闭。
- `dsh-mcp-connector` 的在线服务目录取自公网（jsDelivr / raw.githubusercontent），内网只会超时，不影响它连接本机或内网的 MCP 服务；按 `command`/`url` 手工配置即可。
- 若组织要求禁用 Univer 匿名遥测，在启动 NJCB Harness 的环境中设置 `DO_NOT_TRACK=1`，或在插件中设置 `telemetry: false`。

## 故障定位

如果再次出现 `configured to use 11.7.0 of pnpm / current 11.28.5`，这是目标 profile 或上层目录中的包管理器版本声明冲突，不是缺少 npm 源。关闭应用后先尝试本包的批量安装脚本（它清除子进程继承的 Corepack 上下文）；如仍报错，保留 `%USERPROFILE%\.dsh\profiles\desktop\package.json`、`pnpm-workspace.yaml` 与 `.plugin-manager\logs`，定位声明后再修改。不要重装系统 pnpm 或删除整个 profile。

完整依赖原始 npm 压缩包保留上游许可证与 NOTICE；`registry.json` 记录来源（上游下载地址，或手工加入时的 `upload:<文件名>`）、版本、SHA256。`SHA256SUMS.txt` 校验所有 tarball。`validation.json` 记录本次 Windows 构建验证范围；验证不包含真实模型、OpenViking 服务连接或银行业务场景验收。
