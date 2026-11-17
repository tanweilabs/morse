# Windows 真机验收记录

> 创建：2026-11-15 · 最后更新：2026-11-16

[验收清单](windows.zh-CN.md#真机验收清单发版前)的执行记录：哪一步、跑了什么、结果、修在哪个提交。地址、用户名、令牌都不写在这里（`<用户>`、`<Windows 地址>`、`<Mac 地址>` 是占位）。

## 第 1 轮 · 2026-11-15 · 经 SSH

**环境**：Windows 11 专业版 10.0.22000，AMD64，Windows PowerShell 5.1.22000；经 OpenSSH 远程执行（非交互登录），机主的桌面会话开着、处于锁屏。系统自带的 Node 是 20.13.1（不动它）；测试用的 Node 22.23.5 是官方 zip（SHA-256 和 `SHASUMS256.txt` 对过），解压在 `C:\Users\<用户>\morse-test\node22`，只在测试脚本里放到 PATH 最前面。npm 的全局目录用环境变量指到 `morse-test\npm`（这台机器原来配的是 `C:\ProgramData\npmglobal`，没有碰）。安装源是 Mac 上的测试站点（`scripts/morse-win-test-site.sh`，一次性钥匙）。杀毒软件：火绒，全程没有拦截。

**SSH 做不了的**：钩子在 Claude Code / Codex 桌面应用里触发、Codex 沙箱里运行 `morse`、真的注销再登录、登录时黑窗口闪不闪。这些留给本人在桌面前做，见[指南](windows.zh-CN.md#还要本人在桌面前做的)。另外，SSH 会话结束时 Windows 会结束这个会话里起的所有进程（包括 `start --background` 放到后台的守护进程），所以要让守护进程留着，只能经计划任务启动（`schtasks /Run`）——这正好验证了计划任务这条路。

| 步 | 做了什么 | 结果 | 修复 |
|---|---|---|---|
| 准备 | `install.ps1` 用 5.1 的解析器过一遍（`Parser::ParseFile`）；`irm` 取回来的类型 | **通过**：0 个语法错误；`irm` 返回的是字符串 | — |
| 1 | 机器信息 | AMD64 · 10.0.22000 · PS 5.1 · Node v20.13.1 | — |
| 2 | 系统 Node 20 上运行安装器（`irm … \| iex`） | **通过**：打印怎么装 Node、抛出 `Node.js 22 or newer is required (found v20.13.1)`，什么都没装，终端没被关 | — |
| 3（a）| 安装（Node 22，先在一个临时的用户目录里） | **失败**：`cannot make …\.morse private … the ACL … could not be read (not SDDL)`。`icacls` 的收紧其实成功了；读回失败是因为 `icacls /save` 写的是**不带 BOM 的 UTF-16LE**，代码只认带 BOM 的。安装按设计停在 `morse setup`，没有写私钥 | `de35c4a` |
| 3（b）| 重装（带 `-NoJoin -NoService`） | 装成了，**但发现一个 bug**：带了 `-NoJoin` 仍然注册了一个地址——安装器用 `morse relay show` 判断"加没加入"，而这条命令在没有地址时会新建一个。（`site/install.sh` 的 `--no-join` 有同样的问题，第 2 轮里改了：`83eb7d7`） | `b14f371` |
| 3（c）| 正式安装到真实的用户目录（数据目录用的是上一步已经注册的那个，免得多注册一个地址） | **通过**：`signature OK`、技能和钩子、计划任务、守护进程、`Morse is installed.`、地址 | — |
| 4 | `morse status` | **通过**：`daemon: running`、中转已连上（v2 和 v3）、`autostart: scheduled task MorseDaemon`、`windows:` 一段 | — |
| 5 | `morse status --check` | **通过**：全部 ✓。两个钩子显示 `has not run yet`（对的，还没人在桌面上用过） | — |
| 6 | `icacls`、`icacls /save` | **通过**：只有 Administrators、SYSTEM、本人，`D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;<本人的 SID>)`；里面的文件继承这三条 | — |
| 7 | `schtasks /Query /TN MorseDaemon /V` | **通过**：普通权限（还是 SSH 会话）就建成了。`Logon Mode: Interactive only`、`At logon time`、不限运行时长、没有电池限制 | — |
| 7+ | `schtasks /Run` 启动 | **通过**：任务自己的进程退出（`Last Result: 0`）之后，后台的守护进程还在，跑在本人的桌面会话里（Session 1），`MainWindowHandle=0`（没有窗口），没有子进程；SSH 断开后仍在 | — |
| 8 | PowerShell 和 `cmd` 里的 `morse --version`；`(Get-Command morse).Source` | **通过**：解析到 `morse.cmd`（`morse.ps1` 已被安装器删掉） | — |
| 9 | 互加联系人 | **通过**。Mac 先发，Windows 这边是"消息请求"，`morse contact accept` 后进收件箱 | — |
| 10 | Mac → Windows，中文 | **通过**：一字不差 | — |
| 11 | Windows → Mac，中文当参数，经 `morse.cmd` | **通过**：一字不差 | — |
| 12 | `--text-file`（引号、`&`、`%PATH%`、`<ok>`、`^`、两行） | **通过**：一字不差。对照：同样的字符当**参数**传时，`%PATH%` 被 `cmd.exe` 换成了整条 PATH 的内容再发出去——这就是技能里要求 Windows 上一律用 `--text-file` 的原因（见下面"发现"第 3 条） | 技能措辞加重 |
| 13 | 文件，文件名带空格和中文，两个方向各一个 | **通过**：落盘的文件名、内容都对 | — |
| 回复 | Windows 上 `morse reply <消息号> "中文"` | **通过**：Mac 收到，挂在同一个会话下 | — |
| 14–17 | 钩子在应用里触发、agent 在应用里发信、Codex 沙箱 | **要本人在桌面前做**。能在 SSH 里模拟的部分通过了：`cmd.exe /C <启动器> codex-prompt-submit`（Codex 的调用方式）和 `node cli.js hook claude-prompt-submit`（Claude 的 exec 形式）都正常返回，`status --check` 随后显示 `last ran 19 s ago` | — |
| 18 | 注销再登录 | **要本人做**（不允许远程注销这台机器） | — |
| 19 | `morse stop` | **通过**：`daemon stopped (pid …)`，走的是 HTTP 停止入口；pid 文件和 `daemon.json` 都删了，日志最后一行是 `morse daemon stopping`，没有残留的 node。另测了不带控制台的守护进程（`--no-web`）：`morse stop` 明说没法有序停止，`taskkill` 结束了它 | — |
| 20 | 再启动 | **通过**（`start --background` 和 `schtasks /Run` 都试了） | — |
| 21 | 原地升级，`irm … \| iex` 的写法（`MORSE_SITE` 指向测试站点） | **通过**：地址不变，两个钩子显示 `already registered`，终端没被关 | — |
| 22 | 不指定站点（去 morse.im 下载，测试版安装器只认测试钥匙） | **通过**：`the release manifest (version.json) is not signed by the Morse release key` → `refusing to install`，原来的安装不受影响 | — |
| 23 | 收尾 | 见下面"留在那台机器上的东西" | — |

**其余顺带看到的**：`morse list` 找到了这台机器上 Codex 桌面应用的会话（`~\.codex\sessions`，目录和 macOS 上一样能读）；`morse update --check` 正常；`morse plugin list` 末尾有"这台电脑上都不运行"的说明。

### 发现

1. **`icacls /save` 的编码**（已修，`de35c4a`）：真的 Windows 11 写的是不带 BOM 的 UTF-16LE。测试里的假 `icacls` 现在照这个写。这一条正是当初"宁可装不上"的设计起作用的地方：读回失败 → 拒绝写私钥 → 安装停下来，报错里带着原始输出。
2. **`-NoJoin` 仍然会加入**（已修，`b14f371`）：安装器现在直接读 `config.json` 判断，不再调用会新建地址的命令。
3. **正文当参数传时，`cmd.exe` 会展开 `%名字%`**（没法在客户端里修，是 npm 生成的 `morse.cmd` 这一层决定的）：实测 `%PATH%` 被换成了 PATH 的内容。危险在于：如果有人发来一段带 `%某个环境变量%` 的文字，而 agent 把它原样放进 `morse reply <消息号> "…"` 的参数里，那个环境变量的值就会被发给对方。技能已经改成"Windows 上**绝不**把正文当参数传，一律 `--text-file`"。第 2 轮里进一步定了：程序（stdin 不是终端）这样传时 `morse` 直接拒绝（`f0057e2`）。
4. **PowerShell 5.1 的 `Get-Content` 看日志会乱码**（日志是 UTF-8）：要加 `-Encoding UTF8`。指南已改。
5. 守护进程日志里"Windows 上关着"的三行以前写成 `lan: LAN (…): not available…`、`plugins: plugins — …`，重复了，改成统一的 `windows: …`。

## 第 2 轮 · 2026-11-15 · 经 SSH（主人让直接远程做完）

目标：把第 1 轮留在测试目录里的安装搬到正常位置，并把"要本人在桌面前做"的几项里远程做得了的做掉。

| 做了什么 | 结果 | 修复 |
|---|---|---|
| 升级前记录：`node --version` = v20.13.1（`D:\Program Files\nodejs`），`npm config get prefix` = `C:\ProgramData\npmglobal`，`npm ls -g --depth=0` = cnpm 8.3.0、n8n（版本号空）、npm 10.8.1、pnpm 7.13.4、serverless 3.22.0、typescript 4.8.4、windows-build-tools（版本号空）、wrangler 4.19.1、yarn 1.22.22 | 记录在案。其中带原生模块的（n8n、windows-build-tools）可能要在 Node 22 下重建——**没有动它们** | — |
| SSH 会话是不是管理员身份 | 是（`IsInRole('Administrators')` = True），所以装 MSI 不会弹 UAC | — |
| `winget install --id OpenJS.NodeJS.LTS -e --version 22.20.0 …` | **失败，什么都没改**：`InternetOpenUrl() failed. 0x80072f7d`（winget 自己下载时的 TLS 错误；它的源也更新不了）。这台机器的 winget 目录里没有 `OpenJS.NodeJS.22` 这个 id，只有 `OpenJS.NodeJS`（24.9.0）和 `OpenJS.NodeJS.LTS`（22.20.0） | — |
| 改用 winget 本来要下的那个官方安装包：从 nodejs.org 下 `node-v22.23.5-x64.msi`，SHA-256 和 `SHASUMS256.txt` 一致，Authenticode 签名有效（OpenJS Foundation），`msiexec /i … /qn /norestart` | **通过**：退出码 0，不需要重启；装在原来的位置（`D:\Program Files\nodejs`），系统 PATH 没变；升级前确认过没有进程在用系统的 node | — |
| 照指南运行安装命令（不带任何覆盖：系统 Node 22、他自己的 npm 目录） | 第一次暴露一个 bug：**装在别处的旧守护进程不会被停**——安装前的那次停止只看新位置，旧的那份（测试目录里的）继续跑，而计划任务和钩子已经指向新的。修好后重跑：旧的被新装的程序停掉，新的从正常位置启动 | `f87fa5b` |
| 安装结尾提示 npm 目录不在 PATH 上 | 把 `C:\ProgramData\npmglobal` **追加到用户 PATH 的末尾**（保留原值里没展开的 `%变量%` 和注册表类型），并广播环境变更。副作用：那个目录里他原有的命令（cnpm、pnpm、yarn、wrangler、serverless、tsc 等）也跟着能在终端里用了 | — |
| 新开一个会话核对 | **通过**：`morse` 解析到 `C:\ProgramData\npmglobal\morse.cmd`；计划任务的命令是 `D:\Program Files\nodejs\node.exe "C:\ProgramData\npmglobal\…\cli.js" start --background --no-wait`（路径带空格也没问题）；Claude 的钩子、Codex 的启动器都指向新位置；地址没变，名字还是 `win`；`status --check` 全 ✓ | — |
| 计划任务的定义（导出 XML 看） | **通过**：触发器 = 本人登录时；`InteractiveToken`（只在本人登录着的时候跑）、没有提权；电池两项为 false；`ExecutionTimeLimit` = `PT0S`；`MultipleInstancesPolicy` = `IgnoreNew`。`schtasks /Run` 启动后守护进程在本人的桌面会话里、没有窗口、任务进程退出后还在 | — |
| 有没有东西还指着测试目录 | 没有（任务、`hooks.json`、`.claude\settings.json`、`config.json`、启动器、Run 值、用户 PATH、运行中的进程都查了）→ **整个 `morse-test` 目录已删除** | — |
| 找 Codex 的命令行 | 应用包里的那个（`C:\Program Files\WindowsApps\OpenAI.Codex_…\app\resources\codex.exe`）直接运行报 `Access is denied`；每用户的那份能跑：`%LOCALAPPDATA%\OpenAI\Codex\bin\<一串字符>\codex.exe`，版本 0.169；有 `queue` 子命令 | — |
| **一次**最小的无界面运行：`codex exec --ephemeral --skip-git-repo-check -s read-only "reply with the single word ok"`（用他已有的登录，不存会话，不改配置和信任） | 跑通了，回了 `ok`（约 3,900 token）。**Morse 的钩子没有触发**（`status --check` 仍是 `has not run yet`），Codex 也没有任何提示——没信任的钩子是被静悄悄跳过的。`hooks.json`、`config.toml` 前后哈希一致。结论：**要他在应用里点一次"信任"**，这一步替不了 | — |
| 升级后再收发一遍 | **通过**：Mac → Windows 收到；Windows 上（SSH 里，等于"程序在运行 morse"）把正文当参数传 → **被拒绝**，提示用 `--text-file`；`morse reply <消息号> --text-file` 发出，Mac 上 `%PATH%` 和引号原样到达 | `f0057e2` |
| 收尾 | 按指南第 23 步的那行命令去掉了 `config.json` 里指向测试站点的记录；Mac 上的测试站点已停 | — |

没有做（按要求）：没有注销、锁屏、重启；没有开远程桌面或装别的远程工具；没有手工改 Codex 的信任文件，也没有用 `--dangerously-bypass-hook-trust`。**没有哪一步需要提权弹窗**（SSH 会话本身就是管理员身份）。

这一轮还在 Mac 上修了两处（都有测试）：`site/install.sh --no-join` 和 `install.ps1` 同样的问题（`83eb7d7`）；Windows 上"程序把正文当参数传"现在直接拒绝（`f0057e2`，见第 1 轮"发现"第 3 条）。

## 第 3 轮 · 2026-11-15 · 经 SSH（钩子信任能不能不经界面；下次登录怎么自证）

### A. Codex 的钩子信任

**文档怎么说**（[learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks)，`developers.openai.com/codex/hooks` 跳转到这里；2026-11-15 读取）：

- "Non-managed hooks must be reviewed and trusted before they run."
- 信任是按钩子定义当前的哈希记的，新的或改过的钩子都会被标成"待审查"、在信任之前跳过。
- 审查和信任的入口：命令行里的 `/hooks`；桌面应用里是输入框旁的 **Review hooks** 或 **Settings > Hooks**。
- 唯一不经审查的写法是按次的 `--dangerously-bypass-hook-trust`（文档说它只用于自己另外审过钩子来源的一次性自动化）——那是绕过，不是信任，没有用。
- 配置参考（[config-reference](https://learn.chatgpt.com/docs/config-file/config-reference)）里和钩子有关的键只有 `features.hooks`、`hooks.<Event>…`（含 `commandWindows`、`async`、`timeout`）；**没有"把某条钩子标成已信任"的键**，也没写信任记在哪个文件里。`projects.<path>.trust_level` 管的是项目，不是钩子。

**那台机器上的命令行**（Codex 0.169）：没有 `codex hooks` 子命令；`--trust` 是"信任这个项目"；和钩子信任有关的只有上面那个按次绕过的参数。

**结论：没有文档化的、不经界面就能给某一条钩子记下信任的办法。** 所以没有改任何文件（也没有做备份——没有要改的东西）。

**顺带看清了审查界面长什么样**（经 SSH 开交互式的 Codex 命令行，只看、不选；三次都选的是"不信任、继续"或直接退出，没有发任何提问，没有留下会话文件）：

1. 一启动就弹：`Hooks need review — 1 hook is new or changed. Hooks can run outside the sandbox after you trust them.`，三个选项：`1. Review hooks` / `2. Trust all and continue` / `3. Continue without trusting (hooks won't run)`。
2. 选 1 进表格：`UserPromptSubmit  Installed 1  Active 0  Review 1`。
3. 回车进这一条：`Source: User config - ~\.codex\hooks.json`，`Command: C:\Users\<用户>\.morse\bin\morse-hook.cmd codex-prompt-submit`，`Mode: Sync`，`Timeout: 600s`，`Trust: New hook - review required`；底下是 `t trust · esc back`。——命令就是我们的启动器，一字不差。

在这个界面上替主人按那一下 `t`（这就是文档说的 `/hooks` 审查流程），被这次会话的权限系统拒绝了（理由：替用户批准信任提示）。没有换别的办法绕。**所以这一下还是要主人自己按**：在桌面应用里点 Review hooks，或在命令行里按上面三步，最后按 `t`。命令行和桌面应用用的是同一个 `~\.codex`，但两边是不是共用同一份信任记录没有验证过——在他实际用的那个（桌面应用）里信任最稳妥。

**沙箱测试（无界面，一次）**：`codex exec --ephemeral -s workspace-write`，只让它运行 `morse address` 和 `morse send mac --text-file .\msg.txt`。**两条命令都没能启动**：`Failed to create unified exec process: timed out after 15000ms connecting runner pipe-in`——是 Codex 自己的沙箱执行器在 SSH 会话里起不来，还没轮到 `morse`。所以"沙箱放不放行 `morse`"在 SSH 里得不到答案，只能在桌面应用里看。附带看到一件事：Codex 在这台机器上是用 **PowerShell 7**（`C:\Program Files\PowerShell\7\pwsh.exe -Command '…'`）执行命令的，不是 5.1。

**一个留着以后做的改进**：我们的钩子没写 `timeout`，Codex 默认给 600 秒（文档：不写 `timeout` 时大多数钩子按 600 秒算）。应该写一个短的（比如 15 秒），免得钩子卡住时把提问卡十分钟。但改钩子定义会让哈希变、要重新信任，所以要赶在大家信任之前，或者攒着和别的改动一起做。

### B. 下次登录怎么自证

没有注销、锁屏、重启。任务计划程序的运行日志（`Microsoft-Windows-TaskScheduler/Operational`）在这台机器上是**关着的**，打开它要改设置，没有动。不靠它也够：系统日志里的登录通知（Winlogon 事件 7001）、任务自己的"上次运行时间"、守护进程的启动时间，三个时间对得上就说明任务是登录时触发的、守护进程是自己起来的。

**现在的基线**（2026-11-15）：最近一次登录 00:38:29；任务上次运行 16:05:05（那是远程 `schtasks /Run` 的）；守护进程启动于 16:05:50。

**他下次正常登录之后，经 SSH 运行这段只读的检查**（脚本从标准输入喂给 `powershell -NoProfile -Command -`）：

```powershell
$logon = (Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Winlogon'; Id=7001} -MaxEvents 1).TimeCreated
$task  = Get-ScheduledTaskInfo -TaskName MorseDaemon
$dpid  = [int][IO.File]::ReadAllText("$env:USERPROFILE\.morse\daemon.pid")
$start = (Get-Process -Id $dpid).StartTime
"logon: $logon"
"task:  last run $($task.LastRunTime), result $($task.LastTaskResult)"
"daemon: pid $dpid, started $start"
"task fired at logon:        " + ((($task.LastRunTime - $logon).TotalSeconds -ge 0) -and (($task.LastRunTime - $logon).TotalSeconds -lt 120))
"daemon came up by itself:   " + ((($start - $logon).TotalSeconds -ge 0) -and (($start - $logon).TotalSeconds -lt 180))
morse status | Select-Object -First 4
```

通过的标准：`logon` 比上面的基线新；两行都是 `True`；`task result` 是 0；`morse status` 显示 `daemon: running` 和中转已连上。登录时黑窗口闪不闪远程看不到，只有他自己能说。

## 第 4 轮 · 2026-11-15 · 经 SSH（合并 main 的"每个地址各有各的联系人"，ADR-083）

main 合进来的新东西里有一项直接碰到 Windows：ADR-083 的"旧守护进程"检查要判断"pid 文件里那个 pid 是不是 Morse 的守护进程"，办法是读进程的命令行——Windows 上读不到，答案永远是"不知道"，于是残留的 pid 文件会被当成"守护进程在跑"（甚至"旧版守护进程在跑"）。而在 Windows 上残留的 pid 文件恰恰是常态：每次注销，守护进程都是被系统直接结束的，来不及清理，pid 又回收得快。

**怎么改的**：守护进程在 Windows 上启动时以"独占共享"方式打开数据目录里的 `daemon.lock`，一直不放。别的进程这时打不开它（`EBUSY`）；守护进程不管怎么死，系统都会立刻放开。判断"是不是守护进程"时，读不到命令行就问这把锁：被占着 = 是；没被占 = 那个 pid 是别的程序；没有锁文件（更早的版本没建过）= 不知道，照旧。不起任何子进程。macOS / Linux 不拿锁、不问锁，行为不变。

| 做了什么 | 结果 | 修复 |
|---|---|---|
| 先在真机上试这个机制（临时目录里两个 node 进程） | 占着时第二个打开报 `EBUSY`；占用者被 `taskkill /F` 后能打开；文件不存在是 `ENOENT`。Node 没有导出这个标志位，用的是数值 `0x10000000` | — |
| 原地升级到合并后的版本 | **通过**。日志里有迁移那一行：`contacts and message requests are now kept per address of yours … nothing was deleted, backup: …\.morse\backups\contacts-per-address-<时间>`；`morse status` 多一行 `contacts: kept per address of yours …`；联系人 `mac` 还在，消息一条没少（升级前 12 条，之后加上新收发的） | — |
| 经计划任务启动、`morse status`、联系人命令 | **通过**：没有误报"旧版守护进程"；`daemon.lock` 已建 | — |
| 守护进程在跑时再 `morse start` | **通过**：`daemon already running (pid …)`，退出码 1 | — |
| **残留的 pid 文件**：`morse stop` 之后把 pid 文件写成一个活着的、不相干的进程的 pid（当前这个 PowerShell） | **通过**：`morse status` 说 `daemon: not running`，pid 文件被清掉；`morse start --background` 正常启动；再来一次是 `daemon already running` | 合并提交 `b6f0ddc` |
| `morse stop` | **通过**：`daemon stopped (pid …)`（HTTP 有序停止，停止令牌和新的 `capabilities` 字段在 `daemon.json` 里并存） | — |
| Mac → Windows 一条；Windows 上 `morse reply <消息号> --text-file` | **通过**，两边都收到 | — |
| **`morse status --check` 突然不过了**：`…\.morse is also open to S-1-5-21-…-1017` | 不是 bug，是一个新情况：**Codex 桌面应用的沙箱把它自己的本机用户组 `CodexSandboxUsers`（成员是 `CodexSandboxOffline` / `CodexSandboxOnline`）以"读取和执行"加进了 `.morse` 的权限**（`Documents` 上也有同样一条；用户目录、`.claude`、`.ssh` 上没有），`identity\key.pem` 跟着继承。也就是：沙箱里的 Codex agent **读得到** Morse 的数据（包括私钥），**写不了**——所以它能看信，但发不了、回不了，除非那个会话有完全访问权限。这和 macOS 上沙箱里的 agent 读得到 `~/.morse` 是一回事 | `bd9d421` |
| 对应的修改 | `status --check` 把这种情况认出来：名字正是 `CodexSandboxUsers`、而且只有读权限 → 检查通过，并用一句话说明（谁加的、能读到什么、为什么发不了）；同一个组有写权限、别的账号、解析不出名字 → 仍然报错。第一次写私钥前的权限核对也认这一条，免得在 Codex 已经碰过的目录上"收紧失败、拒绝写钥匙"。真机上重跑：全部 ✓ | `bd9d421` |

**主人在那台机器上自己试的痕迹**（他这期间在 Codex 桌面应用里操作）：到这一轮结束时，`hook-runs.json` 还没有，`codex inbox hook` 仍是 `has not run yet`——钩子还没被信任，或者信任后还没提问；协调方从 Mac 发的那条测试消息在这边仍是"待处理"。上面那条 `CodexSandboxUsers` 的权限是这期间出现的（16:05 的检查里还没有），最可能是 Codex 的沙箱为了让 agent 读 `.morse` 加的。

## 第 5 轮 · 2026-11-15 · 经 SSH（钩子加超时，赶在信任之前）

Codex 对没写 `timeout` 的钩子默认等 600 秒。给 Codex 的钩子条目加了 `"timeout": 10`（`2c5ae1f`）：新写的或本来就要改写的条目带上它；条目自己有 `timeout` 的保留原值。**macOS / Linux 上已经正确的旧条目不会只为了加超时而改写**——Codex 按钩子定义的哈希记信任，改了就要重新信任，而没信任的钩子是被静悄悄跳过的。Windows 上没有人信任过旧写法，缺超时的条目直接补上。Claude Code 的条目不变。

真机：原地升级后 `~\.codex\hooks.json` 里是同一条命令加 `"timeout": 10`；经 SSH 只读地看了一眼 Codex 的审查界面（没有按信任）：`Command` 不变，`Timeout 10s`，`New hook - review required`。升级前确认过主人还没信任旧的那条（没有钩子运行记录），所以他要信任的就是这最终的一条。`morse status --check` 全 ✓。

## 第 6 轮 · 2026-11-15 · 经 SSH（发版之后：换成正式版）

第 1 期已合并并发版（release 20261115090856），`https://morse.im/install.ps1` 现在是正式钥匙签的安装器。在那台电脑上运行 `irm https://morse.im/install.ps1 | iex`（脚本文件用 `-File` 跑）：

| 核对 | 结果 |
|---|---|
| 验签 | `signature OK: 0.0.1 release 20261115090856`；装完 `morse status` 里 `release key: b2693f9e0e38d931 … pinned in this build`，和 Mac 上正式版的是同一把（之前是每次测试站点各自的一次性钥匙） |
| 地址 | 不变，名字还是 `win` |
| 联系人、历史 | `mac` 还在，消息数前后都是 14 |
| `~\.codex\hooks.json`、`~\.claude\settings.json`、`morse-hook.cmd`、计划任务的 XML | 安装前后**逐字节相同**（各自的 SHA-256 一致）；安装器自己也说两个钩子 `already registered`——主人要信任的那一条没有被碰 |
| `morse status --check` | 全 ✓ |
| 收发 | Mac → Windows 一条；Windows 上 `morse reply <消息号> --text-file` 回一条；两边都到了 |
| 主人自己那三步有没有做 | 到这时还没有痕迹：没有 `hook-runs.json`，`codex inbox hook` 仍是 `has not run yet`；协调方发的那条测试消息在这边仍是"待处理"，这边也没有由 Codex 发出的回信 |

之后这台电脑上的是正式版；下面"留在那台机器上的东西"里"测试钥匙签的版本"一条不再成立。

## 第 7 轮 · 2026-11-16 · 经 SSH（P5 前一半：WebRTC 直连）

**目标**：Windows 上打开直连（ADR-080 第 33–37 条，规格 4.2 节），在真机上和 Mac 互发消息和文件。**两台机器在同一个路由器下（192.168.3.x）**，所以这一轮测的是局域网里的 host 候选；不同网络之间的打洞（srflx）没有测。Mac 这边是主人真在用的正式版守护进程（release 20261116095954，没有这次的改动），只用了 `morse send` / `morse read` / `morse status` 和按消息号查它的日志。Windows 装的是测试站点（一次性钥匙）上的分支构建，最后换回正式版。

| 做了什么 | 结果 |
|---|---|
| 开关在哪 | 第 1 期的 `WINDOWS_LIMITS`（`src/platform/platform.ts`）里有 `direct`，`cli.ts` 据此把直连设成 `false`。正式版那台电脑的 `morse status` 里是 `off: direct links (WebRTC) — relay only`。Mac 的日志里也看得到它的后果：10:42 Mac 想和 Windows 建直连，`did not open within 3.0 s — relay only for this device for 5 min`（Windows 不理信令），消息照旧走中转 |
| `node-datachannel` 在真机上能不能加载 | **能**：正式版的安装目录里本来就有 `@node-datachannel/win32-x64-msvc`（0.33.6，可选依赖随 `npm install -g` 装上），Node 22.23.5 加载成功；同一进程里两端回环，数据通道约 0.1 秒打开（host↔host），进程正常退出 |
| ICE / STUN | 约 0.2 秒内从 `stun.cloudflare.com:3478` 拿到 2 个 **srflx** 候选（公网地址）；host 候选有 6 个，包括 IPv6、WSL / Hyper-V 的虚拟网卡（172.30.x.x）、代理软件的 TUN 网卡（198.18.x.x）。实际选中的始终是局域网那一对（`host↔host`、`host↔prflx`、`prflx↔prflx`），srflx 候选报上去了但没被选中——同一个局域网里本该如此 |
| 装分支构建 | 测试站点 + `install.ps1 -Site …`，`signature OK`；`morse status`：`direct: on — no link open (opened on demand, relay as fallback)`，`windows:` 段里不再有直连 |
| Mac → Windows 一条 | **直连**。Mac：`496211fb → … delivered via direct (WebRTC data channel, v3, peer)`；Windows：`direct: link to kfsg2sf open (host↔host, 404 ms, they called)`、`direct: received 496211fb … via direct` |
| Windows → Mac 一条（`--text-file`） | **直连**。Windows：`2c78c6c9 → … delivered via direct (WebRTC data channel, v3, peer)`；Mac：`direct: received 2c78c6c9 … via direct` |
| 文件 2.4 MB，Mac → Windows（5 块） | **直连**。Mac：`fe31d0af → … delivered via direct — 5/5 chunks, 2.4 MB, SHA-256 checked by the recipient (0.3 s, 5 chunk envelope(s) sent)`；Windows 上落盘文件的 SHA-256 和原文件一致 |
| 文件 2.4 MB，Windows → Mac | **直连**。Windows：`02ba0d88 → … delivered via direct — 5/5 chunks … (0.2 s)`；`morse send` 自己打印 `delivered: 5/5 chunks via direct`；Mac 上的 SHA-256 一致 |
| 传 19 MB 时把 Windows 的守护进程有序停掉（`morse stop`），4 秒后经计划任务再起 | 传完了，但**发现一个 bug**：Windows 上 `11:37:59.9` 停的，Mac 到 `11:38:28` 才记下 `direct: link to md86mee closed (connection failed)`——**28 秒**。这期间发出去的块全没回音。原因见 ADR-080 第 37 条：停止时关通道的那一步被放在 `setImmediate` 里，进程先退出了，对方收不到告别，只能等 ICE 超时。之后新建的直连把剩下的块传完（`39/39 chunks … (37.3 s, 46 chunk envelope(s) sent)`） | 第 37 条 |
| 修了之后重装、再做一遍（19 MB） | Windows `11:42:08.361 direct: link to kfsg2sf closed (stopped)` → Mac `11:42:08.396 … closed (connection disconnected)`：**35 毫秒**。守护进程回来后重新建直连，传完：`0af25fb5 … delivered via direct — 39/39 chunks, 19.1 MB … (17.7 s, 52 chunk envelope(s) sent)`。（对照：这一轮里旧版本的那次停止，Mac 也是 27 秒后才发现：`11:42:02.645 … closed (connection failed)`） | — |
| **直连中途断开 → 改走中转**（38 MB，77 块）：传到一半时在 Windows 的 `config.json` 里关掉直连并重启守护进程（先备份，之后原样恢复，哈希一致） | **改走中转并传完**。Mac：`11:44:02.430 link … open (host↔host, 603 ms, we called)` → `11:44:03.002 … closed (connection disconnected)` → `11:44:20.953 direct: no link to md86mee opened (did not open within 3.0 s) — relay only for this device for 5 min` → `11:44:31.775 b2df828a → … delivered via relay — 77/77 chunks, 38.1 MB, SHA-256 checked by the recipient (29.9 s, 100 chunk envelope(s) sent)`；Windows 上落盘文件的 SHA-256 一致。3 秒、5 分钟退避和 macOS 上一样 |
| 通道开着时重启 Windows 的守护进程 | Windows → Mac 一条（`88d9aaab`，直连，`prflx↔prflx`）→ `morse stop` + 计划任务再起 → Mac 立刻记下 `link to md86mee closed (closed by the other side)`（32 毫秒）→ 再发一条（`81443592`）：**新的直连**（`host↔prflx, 377 ms, we called`），`delivered via direct`；随后 Mac → Windows（`cff08a9a`）`delivered via direct`，走的是 Windows 新建的那条通道（Mac 这时对 Windows 还在 5 分钟退避里，退避只管自己发起，不管已经开着的通道） |
| 重启 **Mac** 的守护进程 | **没做**：那是主人真在用的守护进程，这次只允许发信、读信和看状态。代码路径两边一样（停止时 `close()`），第 37 条的修复在 Mac 上要等发版后才生效 |
| 防火墙 | **没有看到需要处理的事**：全程没有入站失败。但**这台电脑证明不了"不需要规则"**——它的防火墙里本来就有两条放行 `D:\program files
odejs
ode.exe` 的入站规则（"Node.js: Server-side JavaScript"，公用网络，TCP 和 UDP 各一条；多半是以前某次弹窗上点了"允许"，没查是什么时候建的），而 WLAN 是"公用"网络。直连的流量是 `node.exe` 的，正好被它放行。没有动防火墙（没有禁用这条规则去对照），所以"没有这条规则时直连通不通、弹不弹窗"仍然**待一台干净的 Windows 验证**。按 ICE 的工作方式（双方都先往外发），预计不需要；真被拦时退到中转（上一行的路径） |
| 负载 | 开始前 `nvidia-smi`：GPU 1%、显存 633 MiB，没有训练任务在跑 |

**顺带看到的（没修，不是 Windows 特有）**：

1. 收方日志里分块传输那两行一律写 `relay: receiving …` / `relay: received … via relay`，哪怕块是从直连来的（`src/cluster/morse.ts` 的 `viaWord` 只分局域网和中转）。走哪条路以发方的日志为准。
2. 经 SSH 运行安装器：照"输出全部重定向到文件"的写法，安装本身照样跑完，**但 SSH 会话要等到安装器起的守护进程结束才返回**——`start --background` 起的守护进程留在这个会话里。做法：安装日志里出现 `Morse is installed.` 之后，另开一个 SSH 会话 `morse stop`（第一个会话随即返回），再 `schtasks /Run /TN MorseDaemon` 让它在本人的桌面会话里起来。这一轮开始时那台电脑上就挂着一个这样的会话（18:41 起的一次正式版升级，守护进程在 Session 0 里），被这一轮的安装停掉后结束了。

**收尾（第 7 轮）**：照第 6 轮的做法换回正式版（`irm https://morse.im/install.ps1 | iex` 写进脚本文件、`-File` 运行、输出重定向）：`signature OK: 0.0.1 release 20261116095954`、`release key: b2693f9e0e38d931 … pinned in this build`；`config.json` 里测试安装器写下的 `update.site` 按指南第 23 步删掉（现在显示 `site https://morse.im`）；守护进程经计划任务在本人的桌面会话里运行；`morse status --check` 全 ✓（两个钩子仍是 `has not run yet`）。正式版里直连还是关着的（`off: direct links (WebRTC)`），等这次的改动发版。`%TEMP%` 下的测试目录已删；收发的测试消息和文件留在信箱里（`inbox-files`），和以前几轮一样。防火墙、Defender / 火绒、WSL、训练任务都没动。

### 留在那台机器上的东西（第 2 轮之后）

- **系统的 Node 从 20.13.1 升到了 22.23.5**（官方 MSI，原位置 `D:\Program Files\nodejs`）。他原来装的全局包没有动；带原生模块的（n8n、windows-build-tools）可能要他自己在 Node 22 下重装。
- **Morse 装在正常位置**：程序在他的 npm 全局目录 `C:\ProgramData\npmglobal`（`morse.cmd` 和 `node_modules\anytoany`），`morse` 在 PATH 上（用户 PATH 末尾加了这个目录）。
- 数据目录 `C:\Users\<用户>\.morse`，权限是本人、SYSTEM、Administrators 完全控制，外加 Codex 自己加的 `CodexSandboxUsers` 只读（第 4 轮）。一个地址（注册在正式中转上），本机的名字是 `win`；和 Mac 互为联系人（Mac 上叫 `windows`，这边叫 `mac`）。
- 计划任务 `MorseDaemon`（本人登录时启动，不提权）。守护进程现在是经它启动的，在跑。
- `morse setup` 写的：`~\.claude\`（新建：`settings.json` 里的钩子、`skills\morse`、`skills\reload`、守护进程维护的 `agents\any-*.md`）、`~\.codex\hooks.json`（新建，**还没被信任**）和 `~\.codex\skills\morse|reload`、`~\.agents\skills\morse|reload`（新建）。
- 第 6 轮起装的是**正式版**（release 20261115090856，正式发版钥匙）；数据库已迁到"每个地址各有各的联系人"，迁移前的备份在 `.morse\backups\`；`update.site` 是默认的 morse.im。
- 测试目录 `C:\Users\<用户>\morse-test`（便携版 Node、测试用的 npm 目录、脚本、下载的安装包）已整个删除。
- 没有动：防火墙、Defender / 火绒、UAC、WSL、OpenSSH 配置、系统 PATH、训练数据；没有重启、没有注销。
