# NJCB Harness Windows x64 插件离线包

> 面向使用者的分步操作随包分发：ZIP 里的 `INSTALL-GUIDE.zh-CN.md`（装客户端、配模型、装插件、加新插件、排错）。该文件只存在于离线包，不入库，本文是运维/打包侧的技术说明。

适用安装包：`njcb-harness-0.2.2-alpha.3.20261104.1-win-x64-unsigned.exe`，Harness 运行时 `0.2.2-alpha.3`。版本由 `selection.json` 选定、由提交在仓库里的 `selection-lock.json` 锁定（构建不再自行解析依赖，见下文「为什么依赖版本要锁死」）。此包提供 22 个插件——21 个来自 npm 上游，加上自建的插件市场 `dshmarket`——以及 Windows x64 的 npm 依赖和本地安装源，不包含模型服务。

## 内网安装

1. 完整解压 ZIP 到本地固定目录，例如 `C:\njcb-offline-plugins`，不要在 ZIP 内直接运行。
2. 双击 `Start-offline-registry.cmd`。窗口出现 `http://127.0.0.1:4873/` 后保持打开。自带 Node，不需要安装 npm、Node 或 Python；源只允许本机访问，不连接外网。
3. **先只装插件市场**（推荐）：启动 NJCB Harness → 「插件」→「添加插件」→ 选「自定义地址」→ 填 `http://127.0.0.1:4873/` → 名称填 `dshmarket`、版本选快照里的那个 → 安装 → 按提示重启。侧边栏打开市场，标题栏出现「内网离线」就对了。内网模式（`offline: true`）写在市场包自己的 `cordis.patch.yml` 里（`insert` 行的 `config`），所以从界面装也是内网模式，不需要任何人改配置文件；未指定 `npmRegistry` 时默认就是 `http://127.0.0.1:4873`。要换地址/端口才在 profile 的补丁层里写 `npmRegistry`（`config` 整块替换，`offline: true` 要一起写）。
4. **其余插件按需装**：市场把源当目录读——源里有哪些插件就列哪些，依赖包不会混进来；点安装即可，装完按提示重启。源窗口要一直开着，市场不存包。要往源里加插件见下文「往源里加插件」。
5. **一次装齐 22 个（可选）**：先启动过 NJCB Harness 以初始化 desktop profile，然后从托盘彻底退出；双击 `Install-plugins.cmd`。自定义安装目录时，在终端运行 `Install-plugins.cmd -InstallDir "D:\Apps\njcb harness"`。它调用安装包自带的 CLI，不替换现有配置，也不绕过版本检查。执行前建议备份 `%USERPROFILE%\.dsh\profiles\desktop`。如果它报「njcb harness is still running」，提示里会列出实际占用进程的 PID、进程名和路径；确认可以结束它们时加 `-Force`（脚本会自行结束并等它们退出）。
6. `Install-plugins.cmd` 装完后还会往 profile 的 `cordis.patch.yml` 里写一段 `- id: dsh-market` / `offline: true`。这与包里自带的那段并存，值相同、无冲突（先应用包，再应用 profile 层，后者胜）。写之前它检查三件事：profile 目录存在；文件里没有已启用的 `dsh-market` 行；没有别人配的 `npmRegistry`（那种情况只提示不覆盖）。新建 profile 的补丁层是一个 `[]` 空数组，直接往后追加会让整个文件解析失败、客户端起不来，所以它是**替换**那个 `[]` 而不是追加。文件按字节写入（不做转码），Notepad 存成 ANSI/GBK 的注释不会被打乱。不需要内网模式时加 `-SkipMarketConfig`。
7. 安装完成可关闭临时源窗口。插件自身运行不依赖这个源；后续安装/升级时才需再次打开。

装失败报 `No matching version found` 时不要重装客户端，也不要改版本号：双击 `Clean-profile.cmd -FreshPlugins` 清掉旧的解析记录与旧插件清单，再按第 3 步装市场（原理与逐条动作见「故障定位」）。

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

## 为什么依赖版本要锁死

`build-bundle.mjs` 不再自行解析依赖：解析结果提交为 `selection-lock.json`，构建只按它取包。

原因是一次现场故障。以前每次构建都跑一遍 `npm install --package-lock-only`，传递依赖取的是「当天最新」。2026-11-08 `ws` 从 8.22.1 升到 8.22.2，于是 06 号构建的源里是 8.22.1、10 号的是 8.22.2。客户端 profile 里存着自己的 `pnpm-lock.yaml`，它记着老版本；`pnpm add` 拿着这个版本去源里要，源说没有，**整批 21 个插件一起失败**，报错是 `No matching version found for ws@8.22.1`——一个谁都没选过的传递依赖。

规则：

- 改 `selection.json` 后必须 `node build-bundle.mjs --update-lock`，看一眼 diff，和 `selection.json` 一起提交。
- CI 第一步跑 `--check`，锁与选择不一致直接失败，不给「悄悄换一版」的机会。这一步不联网、不下载。
- 升级传递依赖等于抬高所有使用者的基线：已有的 profile 会和新源不兼容，见「故障定位」里清除旧 profile 的做法。

### 自建插件（vendor）

`dshmarket` 不走 npm 上游：公网上的 `dshmarket@1.73.17` 是加内网能力之前的构建，`lib/` 里没有 `offline.js` 和 `catalog-registry.js`，装上去市场在内网只会转圈。所以它从 `dsh-market` 仓库自己打包，放进本目录的 `vendor/`：

```bash
cd <dsh-market 仓库> && npm run build && npm pack --pack-destination <本目录>/vendor
```

在 `selection.json` 里登记：

```json
"vendor": { "dshmarket": "vendor/dshmarket-1.73.18-intra.2.tgz" }
```

构建时它按 `file:` 依赖解析（它的传递依赖照常从 npm 取、照常进锁），打进 `tarballs/`；包名、版本和 `dsh` 字段从 tgz 里的 `package.json` 读出来，所以它会出现在市场列表、`plugins.txt`，并被 `Install-plugins.cmd` 一起安装。`--check` 会核对 tgz 里的包名与登记名一致。

换版本：重新 `npm pack`、改 `selection.json` 里的文件名、`--update-lock`、一起提交。

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

**`No matching version found for <包>@<版本>`**：客户端 profile 里留着上一份源（或更早一次联网安装）的解析结果——`pnpm-lock.yaml` 钉死了传递依赖的版本，`node_modules` 是它们的实物。源里的包更新过之后，这些旧版本就不存在了，于是整批安装失败，不是某个插件坏了。处置：双击 `Clean-profile.cmd`，然后重跑 `Install-plugins.cmd`。它做三件事，顺序不能变：

1. 结束 `njcb harness.exe` 及其子进程（托盘里的应用会锁住 `node_modules` 里的 `.node` 原生模块，锁着就改不了名）；
2. 把 `pnpm-lock.yaml` 和 `node_modules` **改名**成 `*.bak`——不是删除，几百 MB 的目录改名是瞬间的，随时能改回来；
3. 打印备份清单、占用体积和下一步，页面需要回收空间时给出可复制的删除命令。

`package.json`、`pnpm-workspace.yaml`、`cordis.patch.yml` 不动，所以内网模式、模型配置、已填的插件设置都保留。已有 `*.bak` 时新备份带时间戳另存，不会覆盖上一份。只想看会做什么、不动文件：`Clean-profile.cmd -DryRun`。**不要**往源里手工补那个包来绕过——下一个传递依赖还会撞。

**`未找到相关插件`**：源通了，但源里没有这个包名。核对 `node add-plugin.mjs --list`；如果缺的是 `dshmarket`，说明这份 ZIP 是 22 个之前的旧包。

**市场报 `fetch failed … earlier: url:https://…`**：`dsh-market` 的配置里留了 `catalog:`，而那个地址连不上（常见是拼错、或根本没有主机名，如 `https://awesome-dsh-plugins.json`）。内网模式下不需要 `catalog:`——市场直接把源当目录读。删掉那一行；或重跑 `Install-plugins.cmd`，它在文件里没有 `npmRegistry` 时会用 `offline: true` 覆盖那段 `config`（`config` 是整块替换，旧的 `catalog` 随之消失）。`url:` 前缀是市场给「URL 型目录源」打的标签，看到它基本可以确定是配置问题，不是网络问题。

如果再次出现 `configured to use 11.7.0 of pnpm / current 11.28.5`，这是目标 profile 或上层目录中的包管理器版本声明冲突，不是缺少 npm 源。关闭应用后先尝试本包的批量安装脚本（它清除子进程继承的 Corepack 上下文）；如仍报错，保留 `%USERPROFILE%\.dsh\profiles\desktop\package.json`、`pnpm-workspace.yaml` 与 `.plugin-manager\logs`，定位声明后再修改。不要重装系统 pnpm 或删除整个 profile。

完整依赖原始 npm 压缩包保留上游许可证与 NOTICE；`registry.json` 记录来源（上游下载地址，或手工加入时的 `upload:<文件名>`）、版本、SHA256。`SHA256SUMS.txt` 校验所有 tarball。`validation.json` 记录本次 Windows 构建验证范围；验证不包含真实模型、OpenViking 服务连接或银行业务场景验收。
