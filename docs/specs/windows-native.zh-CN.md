# Morse 原生支持 Windows：技术规格（方案稿）

> 创建：2026-11-15 · 最后更新：2026-11-16（P5 前一半：Windows 上打开 WebRTC 直连）

> 2026-11-16：P5 的前一半（Windows 上打开 WebRTC 直连）见 4.2 节。
>
> 状态：**第 1 期（P1）已在分支 `feat/windows-native` 上实现；真机验收两轮（2026-11-15，经 SSH）通过，只差两件要主人在桌面前做的事**——在 Codex 里信任钩子并收发一条、注销再登录一次（[验收记录](../guides/windows-test-log.zh-CN.md)）；P2–P6 还只是方案。决策见 ADR-080。主人在 Windows 电脑上照着做的步骤和真机清单在 [docs/guides/windows.zh-CN.md](../guides/windows.zh-CN.md)。第 2 节各表里的行号是 2026-11-14 的 `origin/main`（58ddb8a）的，之后 main 合进了按地址的联系人（ADR-077、081、082），行号已经对不上，以文件名和函数名为准；P1 实际怎么做的见 4.1 节。
>
> 标注约定：**【已核实】** = 在官方文档或包的发布页上读到的，带链接；**【旁证】** = 来自源码、issue 或第三方文章；**【待真机】** = 只是推断，要在真的 Windows 11 上试过才算数。文中没有一条结论是在 Windows 上实际跑出来的——写这份文档和实现 P1 的环境都是 macOS。

## 0. 先说结论

- 起因：主人在 Windows 11 的 Codex 桌面应用里跑 `curl -fsSL https://morse.im/install.sh | bash`，`site/install.sh:125` 直接退出（"Windows is not supported yet. Install WSL2"），而 Codex 进 WSL 报 "Access denied"。主人定：原生支持 Windows。
- 客户端里的 Unix 假设分八组列在第 2 节（一百多处，其中 62 处是不起作用但无害的权限位调用）。**没有一处是做不了的**，但有四类不是"换个路径"能解决的：
  1. **Windows 没有信号**。`SIGTERM` 在 Windows 上等于直接杀进程，守护进程、插件、`morse stop`、更新后的重启全靠它做"有序停止"，都得换成别的办法。
  2. **正在运行的原生模块文件被系统锁住**。自动更新现在是"守护进程自己跑 `npm install -g` 覆盖自己"，在 Windows 上会失败或装成半截。
  3. **所有 shell 相关的写法都是 POSIX 的**：`/bin/sh -c`、单引号转义的钩子命令、`|| exit 2`、`which`、`pgrep`、`ps`、`lsof`。
  4. **npm 装出来的 `claude` / `codex` / `morse` 是 `.cmd` 文件**，Node 从 2024 年 4 月的安全修复起不带 shell 就不能执行 `.cmd`；而带 shell 执行又会把消息正文交给 `cmd.exe` 解析。
- 分六期（第 4 节）。**第 1 期只做"装得上、发得出、收得到"**：`irm https://morse.im/install.ps1 | iex` 装好、拿到地址、登录后守护进程自己起来，Codex 桌面应用或 Claude Code 里的 agent 能 `morse send` / `morse message` / `morse reply`，只走中转。消息靠钩子在下一次提问时带进会话，或者 agent 主动拉；**不做**"守护进程把消息直接送进会话"（那是第 4 期）。
- 第 1 期的量：约 1,300–1,800 行（含测试和 `install.ps1`），18 个文件左右。六期合计约 4,000–6,000 行。
- 最大的不确定不在 Morse 自己的代码，而在 **Claude Code / Codex 在 Windows 上到底怎么跑钩子、能不能被后台进程无界面地续接会话**。这部分文档只能回答一半，剩下的列在第 6 节，要在主人的 Windows 11 上试。

## 1. 范围与前提

- **目标系统**：Windows 11 x64。Windows 11 ARM64 两个原生模块都有预编译包（2.5 节），理论上能用，没人试过，不承诺。Windows 10 不单独适配。
- **Node.js 22 及以上**（不是现在写的 20）。原因：`better-sqlite3` 12.10 起不再给 Node 20 出预编译包，没有预编译包就要现场用 Visual Studio 编译，普通用户的机器上没有（2.5 节）。Node 20 已在 2026-04 停止维护。macOS / Linux 的要求不变。
- **不装管理员权限的东西**：整个安装和运行都不需要"以管理员身份运行"。
- **不发原生可执行文件**：还是一个 npm 包（`morse.tgz`），不做 `.exe` / MSI 安装包。
- **不改线上协议**，不改中转。
- **WSL 里的安装照旧可用**，和原生安装互不干扰（2.8 节）。

## 2. 现状盘点：代码里的 Unix 假设

每张表四列：位置、现在怎么做、在 Windows 上会怎样、怎么改（括号里是第几期）。

### 2.1 安装与更新

**`site/install.sh`（454 行 bash）整个不能在 Windows 上用**，不是改几行的事：

| 位置 | 现在怎么做 | Windows 上 | 怎么改 |
|---|---|---|---|
| `site/install.sh:41` | `set -euo pipefail`，全文 bash 语法，用到 `tr` `sed` `awk` `paste` `mktemp` `seq` `id -u` | 没有 bash（除非装了 Git for Windows） | 另写 `site/install.ps1`（P1） |
| `site/install.sh:122-127` | `uname -s` 判断系统，MINGW/MSYS/CYGWIN 直接退出 | 就是主人碰到的那一行 | 提示改成给出 PowerShell 那条命令（P1） |
| `site/install.sh:144-149` | `command -v node`，要求 ≥ 20 | — | ps1 里 `Get-Command node.exe`，要求 ≥ 22（P1） |
| `site/install.sh:152-160` | 找 `<node 目录>/../lib/node_modules/npm/bin/npm-cli.js`，用这个 node 去跑 | Windows 上 npm 在 `<node.exe 所在目录>\node_modules\npm\bin\npm-cli.js`，没有 `lib` 这一层【已核实，[npm folders](https://docs.npmjs.com/cli/v11/configuring-npm/folders)】 | ps1 按 Windows 的位置找，同样用 `node.exe npm-cli.js` 跑——顺带绕开 `npm.ps1` 被执行策略拦住的问题（P1） |
| `site/install.sh:161,167,172` | `curl` 下载 | — | `Invoke-WebRequest -UseBasicParsing -OutFile`（P1） |
| `site/install.sh:164` | `mktemp -d "${TMPDIR:-/tmp}/…"` | 没有 `/tmp` | `$env:TEMP` 下建随机目录（P1） |
| `site/install.sh:173-186` | 内嵌一段 Node 脚本验签名、比 SHA-256 | **这段可移植**，Node 自己干活 | ps1 把同一段脚本写成临时 `.js` 文件再跑，不走 `node -e`（避开 PowerShell 的引号问题）（P1） |
| `site/install.sh:193` | `npm install -g <tgz>` | 装之前旧的守护进程必须已经停了，否则原生模块文件被锁（见下） | ps1 先停再装（P1） |
| `site/install.sh:204-208` | 入口是 `<prefix>/lib/node_modules/anytoany/dist/cli.js` | Windows 上是 `<prefix>\node_modules\anytoany\dist\cli.js`，默认 prefix 是 `%APPDATA%\npm`【已核实，同上】 | ps1 按 Windows 布局拼（P1） |
| `site/install.sh:211-214` | 用同一个 node 加载一次 `better-sqlite3` 确认能用 | 可移植 | 照搬（P1） |
| `site/install.sh:227-249,302-425` | launchd plist / systemd unit，`launchctl bootstrap`，`systemctl --user` | 都没有 | 见 2.2（P1 最简，P2 打磨） |
| `site/install.sh:253-255` | `$HOME/.morse`，`[ -L … ]` 判断旧目录是不是软链接 | Windows 没有旧安装，不需要 | ps1 里固定 `$env:USERPROFILE\.morse`（P1） |
| `site/install.sh:295-300` | 给守护进程拼 PATH：`:` 分隔，末尾补 `/usr/local/bin:/usr/bin:…` | 分隔符是 `;`，目录完全不同 | 守护进程从登录会话启动，直接继承用户的 PATH；再把 `claude.exe` / `codex.exe` 的已知安装目录补进去（2.4）（P1） |
| `site/install.sh:448-453` | PATH 提示写的是 `export PATH=…` | — | 提示用 `[Environment]::SetEnvironmentVariable('Path', …, 'User')`，并说明桌面应用要重启才看得到新 PATH（P1） |

**`install.ps1` 要做的事**（`irm https://morse.im/install.ps1 | iex`，流程和 `install.sh` 一一对应）：

1. 全文包在一个函数里，`$ErrorActionPreference = 'Stop'`；**不用 `exit`**（`iex` 里 `exit` 会把用户的终端关掉），失败就 `throw`。文件只用 ASCII、不带 BOM（Windows PowerShell 5.1 在没有 charset 时会按 ISO-8859-1 解码【待真机】）。开头设 TLS 1.2（Chocolatey 的一行安装至今还这么做【已核实，[docs.chocolatey.org](https://docs.chocolatey.org/en-us/choco/setup/)】）。
2. 认系统：只接受 `AMD64` / `ARM64`。
3. 找 `node.exe`，取它的真实路径（`process.execPath`——nvm-windows 的 `C:\Program Files\nodejs` 是个会换指向的链接，记下真实路径才不会在用户切 Node 版本后原生模块对不上），要求 ≥ 22。没有就**只打印怎么装**（`winget install OpenJS.NodeJS.LTS` 或 nodejs.org），和 `install.sh` 一样不替用户装——是否改成"问一句再代装"见第 5 节。
4. 下载 `morse.tgz`、`version.json`、`version.json.sig`，用内嵌的发版公钥验签名、比 SHA-256。不过就不装。
5. **先停旧的守护进程**（旧版 `cli.js stop`，等它的 pid 消失，最多 10 秒），再 `node npm-cli.js install -g --no-fund --no-audit <tgz>`。
6. 用同一个 node 加载一次 `better-sqlite3`。
7. **删掉 `<prefix>\morse.ps1` 和 `anyd.ps1`**，只留 `morse.cmd`。原因：Windows 客户端默认执行策略是 Restricted，它"允许单条命令，不允许脚本"【已核实，[about_Execution_Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)】；PowerShell 里敲 `morse` 会先选中 `morse.ps1` 然后被拦下（npm 自己的 `npm.ps1` 就是这个老问题【旁证，[npm/cli#470](https://github.com/npm/cli/issues/470)】）。Codex 桌面应用的 agent 正是在 PowerShell 里跑命令的（2.4）。
8. `node cli.js setup`（技能 + 钩子）。
9. 加入：和 `install.sh` 第 4 步同样的三个分支。**这一步的命令行要等 `feat/identity-v3-p2` 合并后按新的 `address` 命令对齐。**
10. 登记登录时启动，并立刻启动一次（2.2）。
11. 检查 `<prefix>` 在不在用户 PATH 里，不在就打印怎么加。
12. 打印和 `install.sh` 一样的收尾说明。

带参数的写法（`iex` 不能直接传参）：`& ([scriptblock]::Create((irm https://morse.im/install.ps1))) k7f3a9xq -Code abcde-fghjk -Agent win`（Scoop 的官方安装说明用的是同一类写法【已核实，[ScoopInstaller/Install](https://github.com/ScoopInstaller/Install#readme)】）。同时支持环境变量（`$env:MORSE_JOIN`、`$env:MORSE_CODE`、`$env:MORSE_AGENT`），因为 agent 替用户敲命令时环境变量更不容易写错。

**站点构建和签名怎么改**：

| 位置 | 现在 | 改动 |
|---|---|---|
| `scripts/build-site.mjs:168` | 只拷 `index.html` 和 `_headers` | 不变 |
| `scripts/build-site.mjs:174-177` | 读 `site/install.sh`，把 `__MORSE_RELEASE_PUBLIC_KEY__` 换成公钥，写到输出目录，`chmod 755` | 对 `site/install.ps1` 做同样的替换（不用 chmod）；缺占位符同样报错（P1） |
| `site/_headers` | 有 `/install.sh` 一段 | 加 `/install.ps1`：`Content-Type: text/plain; charset=utf-8`、`Cache-Control: no-cache`（P1） |
| `scripts/export-client.mjs:38` | 公开仓库的导出清单里有 `site/install.sh` | 加 `site/install.ps1`（P1） |
| 签名 | `install.sh` 本身不签名，信任来自 morse.im 的 HTTPS；它用内嵌公钥去验 `morse.tgz` | `install.ps1` 同样处理。发版钥匙、`version.json` 的格式、轮换链都不动 |
| `scripts/build-site.mjs:39,88` | `npm.cmd` 不带 shell 调用、读 macOS 钥匙串 | 发版只在 macOS 发版机上做，不改；只在文档里写明"不能在 Windows 上发版" |
| `site/index.html`、`README*.md`、`docs/QUICKSTART.md:9`（"需要：macOS 或 Linux"） | 只有 curl 那一条 | 加 Windows 的一条（P1） |
| `src/cluster/join.ts:190,475-476`、`src/cluster/pair-commands.ts:14,59` | 打印给"另一台电脑"用的安装命令，写死 `curl … \| bash -s -- …` | 多打一行 PowerShell 版（P1；`join.ts` 另一条分支在改，合并后再动） |

**`src/update/`（自动更新，ADR-039）**：

| 位置 | 现在怎么做 | Windows 上 | 怎么改 |
|---|---|---|---|
| `src/update/updater.ts:51-62` `globalPrefixOf` | 认 `<prefix>/lib/node_modules/<pkg>`，上两级目录必须叫 `lib` | Windows 没有 `lib` 这层 → 返回 null → `updater.ts:80` 报 "not an npm global install"，`morse update` 和自动更新都拒绝 | 按平台认两种布局（P3） |
| `src/update/updater.ts:65-73` `npmCommand` | 第二个候选 `<node 目录>/node_modules/npm/bin/npm-cli.js` 恰好就是 Windows 的布局 | 能找到；但找不到时的两个退路——`<node 目录>/npm`（`:70`，是个没后缀的 sh 脚本）和裸的 `npm`（`:72`，实际是 `npm.cmd`）——`execFile` 都执行不了 | Windows 上找不到 `npm-cli.js` 就报错，不退到 `.cmd`（P3） |
| `src/update/updater.ts:83-93` | 守护进程自己跑 `npm install -g --prefix <prefix> <tgz>` 覆盖自己 | 守护进程加载着 `better_sqlite3.node`（和 `node_datachannel.node`），它们是映射进进程的 DLL，**能改名，不能删也不能覆盖**【旁证，[TechNet](https://learn.microsoft.com/en-us/previous-versions/technet-magazine/cc983682(v=msdn.10))】。npm 覆盖安装会 EPERM / EBUSY，可能留下装了一半的包【待真机】 | 换成"先停后换再起"，见第 3.5 节（P3） |
| `src/update/updater.ts:99-138` | 认 launchd / systemd，问它们"这个 pid 是不是你管的" | `win32` 落到 `return null` → 永远是"请手动重启" | 加 Windows 的一支（P3） |
| `src/update/updater.ts:101` | `/bin/launchctl` 绝对路径 | 无关 | — |
| `src/update/updater.ts:141-148` `spawnRestart` | `detached` 起一个重启命令 | Windows 上要加 `windowsHide: true`，否则弹黑窗 | P3 |
| `src/update/updater.ts:337-340` | `os.tmpdir()` + `mode: 0o600` | `tmpdir()` 可移植；`mode` 无效但无害 | 不改 |
| `src/update/release-key.ts:43` | 服务名 `talk.morse.daemon` / `morse.service` | — | 加计划任务名常量（P2） |
| `src/cli.ts:66`、`src/cli.ts:789-790` | 更新后跑一次 `setup` | 用 `process.execPath` + 绝对路径，可移植 | 不改 |

**第 1、2 期里 Windows 上自动更新是关的**：`update.auto` 在 `win32` 上按 false 处理，`morse update` 打印"重新运行 install.ps1"。直到 P3 做完。代价见风险 2。

**`scripts/`**：15 个 `.sh`（`morse-e2e-*.sh`、`smoke.sh`、`lan-smoke.sh`、`install-daemon-launchd.sh`、`lib/test-release.sh`）全是 bash 的验收脚本，只在开发机上用，不随包发布（`package.json` 的 `files` 只有 `dist` `skills` `webui` `plugins`）。**不移植**；Windows 的验收用第 4 节每期的手工清单。`package.json` 的 `prepare`（`test -f dist/cli.js || npm run build`）在 `cmd.exe` 下 `test` 不存在 → 走 `||` 后半段多构建一次，不会失败，不改。

### 2.2 后台服务

| 位置 | 现在怎么做 | Windows 上 | 怎么改 |
|---|---|---|---|
| `site/install.sh:302-329,369-401` | launchd：`KeepAlive`、`RunAtLoad`、stdout/stderr 写到 `daemon.log` | 没有 | 计划任务（见下）（P1 / P2） |
| `site/install.sh:331-348,402-425` | `systemd --user`：`Restart=always` | 没有 | 同上 |
| `src/cli.ts:312-323` | `morse start` 是前台进程，靠服务管理器放到后台、接管日志 | 直接从登录项启动会留一个黑色控制台窗口（`node.exe` 是控制台程序） | 加 `morse start --background`：自己再起一个 `detached` + `windowsHide` 的子进程跑真正的守护进程，stdout / stderr 指向它自己打开的 `daemon.log`，然后退出（P1） |
| `src/cli.ts:377-399`、`src/daemon/pidfile.ts:32-38` | `daemon.pid` + `process.kill(pid, 0)` 判断在不在 | `process.kill(pid, 0)` 在 Windows 上可以当存在性检查用【已核实，[process 文档](https://nodejs.org/api/process.html#signal-events)】。但 Windows 的 pid 回收得快，进程被强杀后 pid 文件留着（见下一行），撞上别的进程的概率比 Unix 高 | `start` 已经另外查了 7433 端口（`src/cli.ts:386-397`）；再加一条：pid 活着但端口不应答就当它不是我们的（P2） |
| `src/cli.ts:645-646` | `SIGINT` / `SIGTERM` → 有序停止（停插件、发 mDNS 告别、关库） | `SIGINT` 只在控制台 Ctrl+C 时有；`SIGTERM` 的处理函数可以注册，但 Windows 不支持，永远不会被调用【已核实，同上】 | 守护进程加一个只在 127.0.0.1 上听的停止入口（`POST /api/shutdown`，控制台端口本来就只绑回环，`src/daemon/server.ts:457`），走同一个 `shutdown()`（P1） |
| `src/cli.ts:659-661` | pid 文件丢了就 `pgrep -f "(anyd|morse) start"` | 没有 `pgrep` | Windows 上改问 7433 端口；问不到就说没在跑（P1） |
| `src/cli.ts:677` | `process.kill(pid, 'SIGTERM')` | 等于 `TerminateProcess`：进程立刻没了，不跑任何清理【已核实，[child_process 文档](https://nodejs.org/api/child_process.html)】。后果：`process.on('exit')` 不执行、pid 文件不删、**插件子进程变孤儿继续跑**（Windows 上父进程死了子进程不会跟着死）、mDNS 不告别 | `morse stop` 先调上面的停止入口，等 pid 消失；3 秒不走再强杀（P1） |
| `src/migrate-home.ts:71,108-118` | 搬旧数据目录前 `SIGTERM` 停守护进程 | Windows 没有旧目录，走不到 | 不改 |
| `src/update/updater.ts:114-135` | 问 launchd / systemd 要守护进程的 pid | — | 见 2.1 |
| `src/daemon/log-hygiene.ts:62-89` | 日志文件是服务管理器打开的，自己只能"拷一份再截断" | 用 `ino` / `dev` 判断"fd 1 是不是这个文件"；Windows 上日志是我们自己打开的 | `--background` 模式下逻辑不变（fd 1 就是日志文件）；`ftruncate` 在 Windows 上对追加打开的文件是否如预期【待真机】（P2） |
| `src/daemon/notify.ts:17-23` | `osascript` 发系统通知，非 macOS 直接返回 | 没有通知，不出错 | 不做（以后可以用 PowerShell 的 toast，不在本方案内） |

**Windows 上用什么当"服务"**——四个候选：

| | 要管理员？ | 注销后还在跑？ | 崩了自动拉起？ | 卸载 | 黑窗口 |
|---|---|---|---|---|---|
| (a) 计划任务，触发器 = 当前用户登录时 | 给自己建、以自己身份交互式运行，文档说不需要【已核实，[Security Contexts for Tasks](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)】；但 `schtasks /SC ONLOGON` 的文档又写"只有管理员能建"【已核实，[schtasks create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create)】，那是"任何用户登录"的触发器。**以当前用户为限的登录触发器，普通权限到底行不行【待真机】** | 否 | 可以配（`RestartOnFailure`，最短间隔 1 分钟）【已核实，[RestartOnFailure](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element)】——但只管任务直接起的那个进程 | 一条 `Unregister-ScheduledTask` | 直接跑 `node.exe` 会有 |
| (b) 注册表 `HKCU\…\CurrentVersion\Run` | 否 | 否 | 否 | 删一个注册表值 | 会有 |
| (c) 启动文件夹里的快捷方式 | 否 | 否 | 否 | 删一个文件 | 会有 |
| (d) 真正的 Windows 服务（nssm / node-windows / `sc create`） | **要**【已核实，[node-windows](https://github.com/coreybutler/node-windows#readme)、[sc create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/sc-create)】 | 是 | 是 | 要管理员 | 无 |

**推荐 (a) 计划任务，建不了时自动退到 (b)**。理由：

- **(d) 不选**。要管理员；默认以 LocalSystem 运行，读不到用户的 `%USERPROFILE%\.claude`、`.codex`，也用不了用户登录 Claude / Codex 的凭据；改成以用户身份运行又要存用户的密码。Morse 的守护进程要做的事（读用户的会话文件、替用户起 `claude` / `codex`）本来就属于"这个用户登录着的时候"。
- **注销后停掉是对的**：注销后用户的 agent 会话也都没了，没什么可投递的；v3 的离线信箱会替不在线的地址存着（ADR-073），下次登录再收。
- **(a) 比 (b)(c) 多出来的**：能随时启动 / 查询 / 停止（`Start-ScheduledTask`、`Get-ScheduledTask`），装完立刻起、更新后重启都走同一个入口；命令行没有 260 字符的限制（Run 值有【已核实，[Run and RunOnce](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)】）；卸载是标准的一条命令。
- **建任务时必须改掉的三个默认值**【已核实，[ExecutionTimeLimit](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit)】：跑满 72 小时会被停（设 `PT0S` = 不限）、用电池时不启动、切到电池就停。笔记本上不改这三项，守护进程会莫名其妙消失。
- **黑窗口**：任务的动作是 `node.exe cli.js start --background`，它起一个隐藏的后台进程后几百毫秒内退出——登录时可能闪一下【待真机】。不用 VBScript 包一层（微软已宣布 VBScript 2027 年前后默认停用【已核实，[techcommunity](https://techcommunity.microsoft.com/blog/windows-itpro-blog/vbscript-deprecation-timelines-and-next-steps/4148301)】），也不用 `conhost --headless`（没有文档，还会被安全软件的规则盯上【旁证】）。
- **崩了怎么办**：因为真正的守护进程是 `--background` 再起的那个，计划任务的 `RestartOnFailure` 管不到它。改由 Morse 自己兜：每次 `morse hook …`（用户每提一次问就跑一次）和每条 `morse` 命令开头，发现守护进程不在就按同样的方式拉起来。P2 再评估"让 node 做任务的直接进程 + 想办法隐藏窗口"，那样可以用上 `RestartOnFailure`。
- 卸载：P2 提供 `irm https://morse.im/uninstall.ps1 | iex`（停进程、删任务或注册表值、`npm uninstall -g anytoany`、去掉钩子；数据目录留着，除非加 `-Purge`）。

### 2.3 路径与文件系统

| 位置 | 现在怎么做 | Windows 上 | 怎么改 |
|---|---|---|---|
| `src/home.ts:19` 和所有 `homedir()`（26 处） | `os.homedir()`，没有一处直接读 `$HOME` | `homedir()` 返回 `%USERPROFILE%`，数据目录就是 `C:\Users\<名字>\.morse`。**可移植** | 不改。不搬到 `%APPDATA%`：和 `.claude`、`.codex` 放在同一层，文档和排错都简单 |
| `src/cluster/identity.ts:158-161`、`src/cluster/e2e.ts:76-78`、`src/identity/address-key.ts:33-34,58-59`、`src/identity/prekeys.ts:79-80`、`src/cluster/trust.ts:68`、`src/cluster/morse.ts:347,690-704,2323-2328`、`src/cluster/chunks.ts:331-465`、`src/cluster/blocklist.ts:32`、各插件的 `state.ts` / `store.ts`（全仓 `chmodSync` / `mode: 0o…` 共 62 处） | `mkdir … 0o700` + `chmod 0o700`；文件 `0o600` | `chmod` 在 Windows 上只能改"只读"这一位【已核实，[fs 文档](https://nodejs.org/api/fs.html)】，这些调用**不报错也不起作用**。私钥靠什么保护见第 3.3 节 | 调用留着（无害）；加一次性的 ACL 收紧（P1） |
| `src/doctor.ts:155-163` | 检查 `key.pem` 的权限位是不是 `0600`，不是就报错并建议 `chmod 600` | Windows 上 `stat().mode & 0o777` 恒为 `0o666`（只读文件是 `0o444`）【已核实，libuv [fs.c](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c)】→ **每台 Windows 都误报"私钥别人可读"** | Windows 上改成解析 `icacls` 的输出（P1） |
| `src/file-lock.ts:129-141`、`src/plugins/attendant/permissions.ts:178-187` | 原子写：保留原文件的权限位，写临时文件、`chmod`、`rename` 覆盖 | `rename` 覆盖已存在的文件可以（`MoveFileExW` + `REPLACE_EXISTING`）【已核实，同上】。**但目标文件这一刻被别的进程开着（另一个 `morse` 在读、杀毒软件在扫、索引服务）就会 EPERM / EBUSY**【已核实错误码映射，libuv [error.c](https://github.com/libuv/libuv/blob/v1.x/src/win/error.c)；触发频率待真机】。现在一失败就抛出、删临时文件（`file-lock.ts:142-145`） | `rename` 遇到 EPERM / EBUSY / EACCES 时短暂重试（5 ms 起、翻倍、总共约 2 秒）。`graceful-fs` 对 Windows 上的 `rename` 就是这么处理的（P1） |
| `src/file-lock.ts:57-67` | 清掉过期锁：先 `rename` 到旁边再删 | 同上，可能 EPERM；现在的 `catch` 当作"别人已经清了"，循环会再试 → 最坏是多等一会儿 | 同一个重试函数（P1） |
| `src/file-lock.ts:82`、`src/plugin/lane-lock.ts:27` | `openSync(lock, 'wx')` 独占创建 | 可移植 | 不改 |
| `src/plugins/dispatch/state.ts:80-81`、`src/plugins/attendant/state.ts:117-118`、`src/plugins/attendant/approvals.ts:157-158`、`src/plugins/ilink/store.ts:44-45`、`src/update/rotation.ts:259-266`、`src/adapters/zcode-mailbox.ts:62-64,75` | 各自手写的"临时文件 + rename" | 同样的 EPERM / EBUSY 问题 | 改用 `writeFileAtomic`，或共用那个重试函数（P1 改核心的，插件的随 P6） |
| `src/migrate-home.ts:72,131-173`、`src/home.ts:35-43` | `~/.anytoany` 搬到 `~/.morse` 后留一个软链接 | Windows 上建软链接要开发者模式或管理员【已核实，[CreateSymbolicLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw)】。**但 Windows 没有 `~/.anytoany` 的旧安装，这段永远走"全新"分支** | 不改；加一条测试钉住"win32 上不建链接" |
| `src/file-lock.ts:123` | `realpathSync`，为了不把用户软链接出去的配置文件替换成普通文件 | 可移植 | 不改 |
| `src/setup.ts:56-73` | 技能是**拷贝**进各 agent 的目录，不是链接 | 可移植 | 不改 |
| `src/cluster/morse.ts:301-305` `safeFileName` | 去掉路径、控制字符、开头的点，截到 200 字符 | **不够**：(1) 文件名里的 `:` 在 NTFS 上是"备用数据流"，`report.txt:x` 会写进 `report.txt` 的隐藏流；(2) `< > " \| ? *` 是非法字符，写文件直接失败；(3) `CON` `NUL` `COM1` `LPT1` 等保留名（带后缀也算，如 `NUL.txt`）会写到设备上；(4) 结尾的点和空格会被系统悄悄去掉，可能和另一个文件撞名；(5) 200 字符的名字加上 `C:\Users\…\.morse\inbox-files\<36 位消息号>\` 超过 260——Node 自己能读写，但 agent 用 PowerShell 5.1 去读可能读不了。**这是别人发来的文件名，属于安全面** | 所有平台统一收紧（不只 Windows——文件可能被转到 Windows 上）：把 `< > : " \| ? *` 换成 `_`，去掉结尾的点和空格，保留名前面加 `_`；Windows 上截到 120（P1） |
| `src/plugins/attendant/engine.ts:110` | 只留字母数字和 `._ -` | 字符没问题；保留名和结尾的点没处理 | 改用同一个函数（P6） |
| `src/cluster/chunks.ts:213` | 暂存目录名是哈希 | 可移植 | 不改 |
| `src/plugin/lane-lock.ts:19`、`src/plugins/attendant/config.ts:364` | 文件名只留 `A-Za-z0-9._-` | 可移植 | 不改 |
| `src/hooks/prompt-hook.ts:25-27` | `hook-cursors/<会话号>` | 会话号是 UUID，可移植 | 不改 |
| `src/cluster/sync-agents.ts:105` | 以 `/tmp/`、`/private/tmp/`、`/var/folders/` 开头的工作目录算临时目录，不进 @ 名单 | Windows 的临时目录是 `%TEMP%` | 加上 `os.tmpdir()` 前缀的判断（P4） |
| `src/plugins/dispatch/launch.ts:101`、`src/plugins/dispatch/commands.ts:59`、`src/plugins/ilink/config.ts:75,104` | 用 `cwd.startsWith('/')` 判断"是不是绝对路径" | `C:\work` 被判成不是 → 这些配置在 Windows 上一律报错 | 改 `path.isAbsolute`（P4 / P6） |
| `src/plugins/attendant/config.ts:169-171`、`src/plugins/attendant/permissions.ts:117`、`src/adapters/zcode-mailbox.ts:29` | 只认 `~/` 开头 | `~\` 不认 | 文档里规定配置一律写 `~/`（`path.join` 会处理）；不改代码 |
| `src/plugins/attendant/approvals.ts:121-122` | 拼 `${home}/…`、`~/…`、`$HOME/…` 去匹配命令文本 | Windows 上分隔符是 `\`，变量是 `$env:USERPROFILE` / `%USERPROFILE%` → **敏感目录的匹配规则失效** | 和 attendant 一起重做（P6）；这是 attendant 在 Windows 上默认关的原因之一 |
| `src/format.ts:15` | `path.startsWith(home)` 缩写成 `~` | 可移植（只是显示） | 不改 |
| `src/plugins/ilink/inbound.ts:275` | `path.split('/')`（只用于日志） | 日志里显示整条路径，无害 | P6 顺手改 |
| 大小写 | 比较路径用 `path.relative`（`src/plugins/attendant/config.ts:143`、`src/plugins/ilink/config.ts:137`） | `path.win32.relative` 不区分大小写，可移植。地址、会话号都是小写 | 不改。会话的 `cwd` 和用户配置的 `cwd` 做字符串相等比较的地方，P4 开工时再搜一遍 |
| `src/mailbox/db.ts:130-132` | SQLite WAL 模式 | Windows 上 WAL 正常；多进程靠 `busy_timeout` | 不改。数据目录不能放在网络盘上（WAL 的要求），文档里写一句 |
| `.sh` 钩子脚本 | 包里**没有** `.sh` 文件；钩子是 `node cli.js hook …` | — | 钩子命令行的引号写法是问题，见 2.4 |
| `src/cli.ts:1`、各插件 `main.ts:1` | `#!/usr/bin/env node` | npm 在 Windows 上生成 `.cmd` 包装，不看这一行 | 不改 |

### 2.4 Agent 接入

Morse 接 agent 的四件事：**找到会话**（读它们的会话文件）、**装技能**（拷 `SKILL.md`）、**装钩子**（用户每次提问时把待收的消息带进去）、**无界面投递**（后台起 `claude -p --resume` / `codex exec resume`）。

**各家在 Windows 上把东西放在哪**（文档查到的）：

| | 结论 | 来源 |
|---|---|---|
| Claude Code 的安装 | `irm https://claude.ai/install.ps1 \| iex`、`winget install Anthropic.ClaudeCode`，或 npm。原生安装的程序在 `%USERPROFILE%\.local\bin\claude.exe`，**安装器不改 PATH**。npm 装的是 `claude.cmd` + `claude.ps1` 两个包装 | 【已核实】[code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup)、[troubleshoot-install](https://code.claude.com/docs/en/troubleshoot-install) |
| Claude Code 要不要 Git for Windows | 不要。没有 Git Bash 时用 PowerShell 工具，Bash 工具不注册 | 【已核实】同上 |
| Claude Code 的配置目录 | `%USERPROFILE%\.claude`（`CLAUDE_CONFIG_DIR` 可以改）；`settings.json`、`skills\`、`projects\`、`sessions\` 都在里面 | 【已核实】[claude-directory](https://code.claude.com/docs/en/claude-directory) |
| Claude 会话文件 | `projects\<项目>\<会话号>.jsonl`，`<项目>` = 工作目录里所有非字母数字的字符换成 `-`。所以 `C:\Users\me\proj` → `C--Users-me-proj` | 规则【已核实】[sessions](https://code.claude.com/docs/en/sessions)；Windows 的例子是按规则推的【待真机】。Morse 不依赖这个名字——它遍历 `projects\` 下所有目录，从 jsonl 里读 `cwd`（`src/adapters/claude.ts:266-296`），**可移植** |
| Claude 桌面应用（Code 页签） | 和命令行**共用** `~/.claude/settings.json`、钩子、技能、会话文件；自己带一份 Claude Code，版本可能和命令行的不一样；自己的数据在应用数据目录里 | 【已核实】[desktop](https://code.claude.com/docs/en/desktop)、[data-storage](https://claude.com/docs/third-party/claude-desktop/data-storage) |
| Claude 钩子在 Windows 上用什么 shell | 写成一整条字符串的（shell 形式）：**装了 Git Bash 就用 bash，没装就用 PowerShell**。写成 `command` + `args` 数组的（exec 形式）：**不经过任何 shell**，`command` 必须是真正的 `.exe`，`.cmd` 不行 | 【已核实】[hooks](https://code.claude.com/docs/en/hooks) |
| Codex 的安装 | 原生 Windows 是正式支持的（命令行、桌面应用、IDE 插件），WSL2 可选。`irm https://chatgpt.com/codex/install.ps1 \| iex`（装到 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`，并加进用户 PATH），或 `npm i -g @openai/codex`（得到 `codex.cmd`） | 【已核实】[windows-sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)、[openai/codex README](https://github.com/openai/codex)、[windows-deployment](https://learn.chatgpt.com/docs/enterprise/windows-deployment) |
| Codex 的配置目录 | `%USERPROFILE%\.codex`（`CODEX_HOME` 可以改）。桌面应用和原生命令行共用；**WSL 里的 Codex 用的是 Linux 的家目录** | 【已核实】[windows-app](https://learn.chatgpt.com/docs/windows/windows-app)、[environment-variables](https://learn.chatgpt.com/docs/config-file/environment-variables) |
| Codex 桌面应用 | 现在叫 ChatGPT 桌面应用，从微软商店装。**agent 默认是 Windows 原生的，在 PowerShell 里跑命令**，套着 Windows 沙箱；WSL 要在设置里手动打开 | 【已核实】同上 |
| Codex 桌面应用自带的 `codex` | 在 `C:\Program Files\WindowsApps\OpenAI.Codex_…\app\resources\codex.exe`，**不在 PATH 上** | 【旁证】第三方文章；官方文档没写 |
| Codex 会话文件 | `sessions\YYYY\MM\DD\rollout-*.jsonl` 和 `session_index.jsonl` 这个布局**官方文档没有写**，Windows 上是否一样 | 【待真机】 |
| Codex 钩子 | 支持，默认开，写在 `~/.codex/hooks.json` 或 `config.toml` 的 `[hooks]`。有 Windows 专用的字段 `commandWindows`。**新装的或改过的钩子在用户审过、信任之前不会运行**（`/hooks` 或 设置 → Hooks） | 【已核实】[hooks](https://learn.chatgpt.com/docs/hooks) |
| Codex 钩子用什么 shell | Windows 上是 `%COMSPEC% /C "<命令>"`，也就是 `cmd.exe` | 【旁证】源码 [command_runner.rs](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/command_runner.rs) |
| 技能目录 | Claude：`~/.claude/skills/<名字>/SKILL.md`。Codex：`$HOME/.agents/skills`；`~/.codex/skills` 已经不在文档的位置表里了，据说还作为旧位置在读 | 【已核实】[skills](https://code.claude.com/docs/en/skills)、[build-skills](https://learn.chatgpt.com/docs/build-skills)；旧位置【旁证】 |
| 主人碰到的 WSL "Access denied" | 文档里没有。有一个公开 issue 说 WSL 模式会经 `/mnt/c` 继承 Windows 的 `CODEX_HOME`；论坛有人报微软商店版的辅助程序 os error 5 | 【旁证】[openai/codex#13762](https://github.com/openai/codex/issues/13762)。**结论：不去修它，Morse 走原生** |

**代码里要改的**：

| 位置 | 现在怎么做 | Windows 上 | 怎么改 |
|---|---|---|---|
| `src/setup.ts:14,21-23` `hookCommand` | 钩子命令是一条字符串，用 POSIX 单引号转义：`'/path/node' '/path/cli.js' hook claude-prompt-submit`。安全字符集里没有反斜杠，所以 Windows 路径一定会被套上单引号 | Claude：装了 Git Bash 应该能跑（bash 认单引号，单引号里反斜杠不变）【待真机】；没装 → PowerShell 把 `'C:\…\node.exe' '…'` 当成一个字符串表达式而不是命令，**钩子不执行**。Codex：`cmd.exe` 不认单引号，**不执行** | Claude 的钩子在 Windows 上写成 exec 形式：`{"type":"command","command":"C:\\…\\node.exe","args":["C:\\…\\cli.js","hook","claude-prompt-submit"]}`——不经过 shell，没有引号问题，也不依赖用户装没装 Git Bash。Codex 的钩子加 `commandWindows`，用双引号：`"C:\…\node.exe" "C:\…\cli.js" hook codex-prompt-submit`（P1） |
| `src/setup.ts:39-44` `isOurHook`、`:93-110` `mergeHook` | 靠命令字符串的结尾认"这是不是我们的钩子"，升级时原地改写 | exec 形式的 `command` 只是 node 的路径，认不出来 → 每次 `setup` 追加一条重复的 | 同时认 `args` 里的 `hook <名字>`（P1） |
| `src/setup.ts:116-140` | 改 `~/.claude/settings.json` | 路径可移植 | 不改 |
| `src/setup.ts:146-169` | 改 `~/.codex/hooks.json` | 路径可移植。**装完钩子不会立刻生效**，要用户在 Codex 里信任一次（上表） | `setup` 和 `install.ps1` 的收尾说明里写清这一步（P1） |
| `src/setup.ts:52-54` | 技能拷到 `.claude/skills`、`.codex/skills`、`.agents/skills` | 可移植 | 不改 |
| `skills/morse/SKILL.md`、`skills/reload/SKILL.md` | 例子是 bash 代码块；没有用 heredoc、`$( )` 这类 bash 专有写法 | 命令本身（`morse send …`）在 PowerShell 里也能敲。问题在**正文怎么传**，见下一行 | 加一小段 Windows 说明（P1） |
| `src/commands/messaging.ts`（`send` / `reply` 的正文只能当命令行参数传） | `morse send <地址> "<正文>"` | agent 在 PowerShell 5.1 里敲这条命令，实际经过三层：PowerShell → `morse.cmd`（npm 的包装，`cmd.exe` 解释）→ `node.exe`。(1) PowerShell 5.1 给原生程序传参时会弄坏正文里的双引号（PowerShell 7.3 才修）；(2) `cmd.exe` 会展开正文里的 `%名字%`，`& \| < > ^` 在引号外会被当命令符；(3) 把正文从管道喂进去的话，5.1 的 `$OutputEncoding` 默认是 ASCII，中文会变成 `?`【(1)(3) 是广为人知的 PowerShell 行为，这里没有逐条核实；整体待真机】 | `send` 和 `reply` 加 `--text-file <路径>`（UTF-8 文件）。技能里写：Windows 上正文带中文以外的特殊字符（引号、`%`、`&`、换行）或者超过一行时，先用写文件的工具把正文写成文件，再 `--text-file`。纯中文、不带特殊字符的短句直接当参数传应该没问题【待真机】（P1） |
| `src/cli.ts:804-823` `morse hook` | 从 stdin 读一段 JSON，往 stdout 写一段 JSON | 可移植。钩子收到的 JSON 里文件路径是反斜杠的【已核实，hooks 文档】；我们只用 `session_id` / `thread_id` | 不改 |
| `src/hooks/prompt-hook.ts:53,66,80,100` | 提示 agent "To answer, run: anyd reply …" | `anyd.cmd` 存在，能用 | 不改 |
| `src/adapters/claude.ts:202,266-296` | 扫 `~/.claude/projects/*/*.jsonl` | 可移植 | 不改 |
| `src/adapters/codex.ts:98-99,186-255` | 扫 `~/.codex/sessions/**/rollout-*.jsonl` + `session_index.jsonl` | 布局是否相同【待真机】。代码本身可移植：`readdir(…, {recursive: true})` 在 Windows 上返回反斜杠的相对路径，`:197-198` 先取 `basename` 再匹配 | 真机看过目录后定（只读不写，风险低） |
| `src/adapters/claude.ts:229`、`src/adapters/codex.ts:118-121,152-155`、`src/adapters/version-guard.ts:100`、`src/plugins/attendant/runner.ts:132,153` | `spawn('claude', …)` / `spawn('codex', …)`，裸名字，不带 shell | 见 2.6：只有 PATH 上有 `claude.exe` / `codex.exe` 才行；npm 装的 `.cmd` 起不来；只装了桌面应用的话 PATH 上根本没有 | 新增 `resolveAgentCli()`（第 3.4 节）（P4） |
| `src/adapters/claude.ts:96-97`、`src/adapters/codex.ts:154` | 整个信封（含对方发来的正文）当**最后一个命令行参数**传 | Windows 的命令行总长上限是 32,767 个字符（Unix 上是几百 KB 到几 MB）→ 长消息投递失败 | Windows 上正文走 stdin（`claude -p` 从 stdin 读提示、`codex exec … -` 从 stdin 读，都【待真机】确认）（P4） |
| `src/daemon/session-liveness.ts:51` | `ps -axww -o command` 找"正开着的 Claude 会话"，避免往活会话里无界面续接（ADR-023） | 没有 `ps` → 被 `catch` 吞掉 → 返回空集合 → **所有会话都被当成"没开着"** → 可能往用户正在用的会话里重复注入 | Windows 上用 PowerShell `Get-CimInstance Win32_Process` 取命令行，或者只依赖下面的会话登记文件（P4） |
| `src/daemon/session-liveness.ts:93-95` | `lsof` 查谁开着 Codex 的线程锁文件（ADR-026） | 没有 `lsof`。Windows 上"谁开着这个文件"没有不要管理员的现成命令 | 【待真机】看 Codex 在 Windows 上的线程锁是什么样；备选：只要锁文件存在且新就当它活着（P4） |
| `src/daemon/claude-inbox.ts:78-107,142` | 门铃（ADR-027）：读 `~/.claude/sessions/<pid>.json` 里的 `messagingSocketPath`，`existsSync` 确认后用 `net.createConnection` 往 Unix 套接字写一行 | Windows 上这个字段是什么（命名管道 `\\.\pipe\…`？）文档没有【待真机】。Node 的 `createConnection` 能连命名管道；但对命名管道路径做 `existsSync` 会不会干扰对方也不确定 | 真机看过那个 json 再定（P4）。在那之前门铃在 Windows 上关着，消息靠钩子在下一次提问时带进去——和 ADR-027 之前一样，不丢 |
| `src/adapters/codex.ts:112-121` | `codex queue --thread …` 把消息排进 Codex 桌面应用（ADR-027） | Windows 上有没有这个子命令、桌面应用认不认【待真机】 | P4 |
| `src/adapters/kimi.ts:10,33-36` | 找 `~/.kimi-code/bin/kimi` 和 PATH 上的 `kimi`，没有 `.exe` 后缀 | 找不到 → 这个适配器返回"不可用"，不出错 | 不做（Kimi 不在本方案范围） |
| `src/adapters/zcode.ts:13,69`、`src/doctor.ts:67,170` | `/Applications/ZCode.app/…`、`launchctl setenv` | 找不到，不出错 | 不做 |
| `src/integrations/sds.ts:52-55` | 闪电说的数据目录写死 `~/Library/Application Support/Shandianshuo` | 找不到 → 当作没装，不出错 | 不做；闪电说出 Windows 版再说 |
| `src/doctor.ts:71-74` | `which claude` / `which codex` | 没有 `which`（是 `where.exe`）→ 一律报"没找到" | 改用 `resolveAgentCli()`（P1） |
| `src/cluster/sync-agents.ts:99` | 往 `~/.claude/agents/any-*.md` 写 @ 名单 | 路径可移植 | 不改 |
| `src/cluster/agents.ts:37-42`、`src/cluster/device.ts:17` | 默认 agent 名从电脑名里猜（mini / air / pro） | Windows 的电脑名是 `DESKTOP-AB12CD3` 这种，猜不出好名字 | Windows 上默认叫 `win`，重名加数字（P1；`agents.ts` 另一条分支在改，合并后再动） |

**Codex 沙箱**：`src/commands/messaging.ts:492-497` 已经处理了"沙箱里写不了 `~/.morse/mailbox.db`"（SQLite 报只读 → 告诉 agent 把结论写在可见的回答里）。Codex 在 Windows 上的沙箱（MXC / elevated / unelevated 三种【已核实】）对 `%USERPROFILE%\.morse` 的写入、对 127.0.0.1 的访问是什么态度【待真机】——这决定了 Codex 桌面应用里的 agent 能不能直接 `morse send`，是第 1 期最先要试的一件事。

### 2.5 原生模块与网络

| 模块 | `package.json` | 锁定版本 | win32-x64 / win32-arm64 预编译包 | 备注 |
|---|---|---|---|---|
| `better-sqlite3` | `^12.2.0`（必需） | 12.11.1 | **有**，Node 22 / 24 / 25 / 26 各一份；**没有 Node 20 的**（12.9.0 是最后一个带 Node 20 的版本，12.10.0 去掉了） | 【已核实】[发布页 v12.11.1](https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v12.11.1)。安装脚本是 `prebuild-install \|\| node-gyp rebuild`：没有匹配的包就现场编译，要 Python + Visual Studio 的 C++ 工具【已核实，[node-gyp](https://github.com/nodejs/node-gyp#on-windows)】。所以 Windows 上要求 Node ≥ 22。注意 `morse.tgz` 里没有锁文件，`npm install -g` 会按 `^12.2.0` 装当时最新的 12.x |
| `node-datachannel` | `~0.33.6`（可选依赖） | 0.33.6 | **有**，以 npm 子包的形式：`@node-datachannel/win32-x64-msvc`、`@node-datachannel/win32-arm64-msvc`，N-API 8，一份二进制通吃 Node ≥ 18.20 | 【已核实】[registry](https://registry.npmjs.org/node-datachannel/0.33.6)。没有编译退路：平台包缺了，加载时抛错。`src/cluster/direct.ts:61-63` 已经是动态 `import()` + 捕获，缺了就只走中转，**可移植** |
| `bonjour-service` 1.4.4 | 必需 | — | 纯 JavaScript（底下是 `multicast-dns`），不需要系统装 Bonjour 服务 | 【已核实】[registry](https://registry.npmjs.org/bonjour-service/latest) |
| `ws`、`@hpke/core`、`commander`、`uuid` | — | — | 纯 JavaScript | — |

**网络**：

| 位置 | 现在怎么做 | Windows 上 | 怎么改 |
|---|---|---|---|
| `src/daemon/server.ts:457` | 控制台只绑 `127.0.0.1:7433` | 只绑回环不触发防火墙弹窗【旁证】 | 不改 |
| `src/cluster/secure-transport.ts:117` | 局域网的双向 TLS 端口绑 `0.0.0.0`（7434） | **第一次监听会弹"Windows Defender 防火墙已阻止此应用的部分功能"**。管理员点了"取消"、或者普通用户不管点什么，都会留下阻止规则，之后不再弹，局域网就静悄悄地不通【已核实，[Windows Firewall rules](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules)】。而且规则是按程序路径（`node.exe`）记的：一条放行规则放行的是这个 node 跑的所有脚本，换了 Node 的安装位置规则就失效 | 第 1–4 期 Windows 上默认 `--no-lan`，不监听、不弹窗。P5 再开：装的时候明说会弹窗、该点哪个；`morse status --check` 检查端口从本机的局域网地址连不连得上 |
| `src/cluster/peers.ts:83,103` | mDNS：发布一个、浏览一个（UDP 5353 组播） | 绑 5353 也会触发同样的弹窗【待真机】。机器上有多块网卡（Hyper-V、WSL、VPN 的虚拟网卡）时 `multicast-dns` 有已知问题：收不到应答、选错网卡【旁证，[#41](https://github.com/mafintosh/multicast-dns/issues/41)、[#68](https://github.com/mafintosh/multicast-dns/issues/68)】——装了 WSL 的机器正好有虚拟网卡 | P5：给 `multicast-dns` 指定局域网那块网卡的地址；发现不了时退到 `--peer host:port` 手工指定（现成的，`src/cluster/lan.ts:130-148`） |
| `src/cluster/direct.ts`（WebRTC 直连，ADR-069） | `node-datachannel` 在随机 UDP 端口上收发 | 会不会弹防火墙窗：见 4.2 节（2026-11-16 真机） | 第 1 期 Windows 上强制关；**2026-11-16 起和 macOS 一样默认开**（4.2 节，ADR-080 第 33–36 条） |
| `src/cluster/relay-client.ts`（中转） | 出站 WebSocket（wss） | 出站连接不触发弹窗。公司网络的代理：Node 的 `ws` 不读系统代理设置（macOS 上也一样） | 不改 |
| `src/cluster/identity.ts`（设备证书） | 用 Node 的 `crypto` 生成，不调用 `openssl` 命令 | 可移植 | 不改 |

### 2.6 子进程

背景：Node 在 2024 年 4 月的安全更新（CVE-2024-27980，18.20.2 / 20.12.2 / 21.7.3 起）之后，`spawn` / `execFile` 不带 `shell` 去执行 `.bat` / `.cmd` 会直接返回 `EINVAL`【已核实，[Node 安全公告](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)】。另外 Windows 上不带 shell 的 `spawn('名字')` 只会自动补 `.com` 和 `.exe`，**不看 `PATHEXT`，找不到 `名字.cmd`**【已核实，libuv [process.c](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)】。带 `shell: true` 时参数只是用空格拼起来，不做任何转义（Node 24 起是运行时弃用警告 DEP0190【已核实】）。

全部子进程调用（`src/` 下直接调 `child_process` 的 14 处，另有 10 处经 `realExec`）：

| 位置 | 起什么 | Windows 上 | 怎么改 |
|---|---|---|---|
| `src/adapters/exec.ts:13-17` `realExec` | 所有 agent 命令行的统一入口：不带 shell、stdin 关着 | 命令是 `.exe` 就没问题；是 `.cmd` → ENOENT。**不能简单改成 `shell: true`**：信封里是对方发来的文字，交给 `cmd.exe` 等于命令注入 | 见第 3.4 节（P4） |
| `src/adapters/exec.ts:28` | 超时后 `child.kill('SIGKILL')` | 能杀掉直接子进程。如果子进程是个包装（`cmd.exe`、npm 的 `.cmd`），**真正干活的孙子进程活着** | Windows 上超时用 `taskkill /pid <pid> /T /F` 杀整棵树；加 `windowsHide: true`（P4） |
| `src/adapters/claude.ts:229`、`src/adapters/codex.ts:118,152`、`src/adapters/kimi.ts:81`、`src/adapters/zcode.ts:166`、`src/adapters/version-guard.ts:100`、`src/plugins/attendant/runner.ts:132,153`、`src/doctor.ts:95` | 经 `realExec` 起 `claude` / `codex` / … | 同上 | 同上 |
| `src/plugin/on-message.ts:81` | `spawn('/bin/sh', ['-c', cfg.command])`：用户配的 `on_message` 命令 | 没有 `/bin/sh` → `spawn` 报错，被记日志（`:96-99`），功能不可用 | Windows 上 `cmd.exe /d /s /c <命令>`（命令是机主自己写在配置里的，可信；事件内容从 stdin 进，不进命令行）（P6） |
| `src/plugin/manager.ts:45` | 用户自己加的插件：`['/bin/sh', '-c', e.command]` | 同上，起不来，每隔几秒重试一次并记日志 | 同上（P6）。`src/cli.ts:1776` 的帮助文字一起改 |
| `src/plugin/manager.ts:100` | 起内置插件：`[process.execPath, …, main.js]` | 绝对路径的 `node.exe`，**可移植** | 加 `windowsHide: true`（P1） |
| `src/plugin/manager.ts:134,140,149,172` | `child.kill('SIGTERM')` 让插件有序停止，3 秒后 `SIGKILL`（`:165`） | `SIGTERM` = 立刻杀掉。插件里的 `process.on('SIGTERM', shutdown)`（`src/plugins/dispatch/main.ts:181`、`src/plugins/attendant/main.ts:112`、`src/plugins/ilink/main.ts:68`）**永远不会被调用** → "先关事件流、等手上的命令做完"（2026-11-14 刚修的那条）在 Windows 上不成立；插件正在跑的 `claude -p` 变孤儿 | 插件的 stdin 从 `'ignore'` 改成管道：守护进程要它停就把管道关掉，插件读到 EOF 走 `shutdown()`。顺带解决"守护进程被强杀，插件不知道"——系统会替死掉的进程关管道。所有平台都这么做，信号留作第二道（P2） |
| `src/plugin/cli-client.ts:20` | 没设 `MORSE_CMD_JSON` 时默认命令是裸的 `morse` | `morse` 是 `morse.cmd` → `execFile` 起不来。内置插件不受影响（守护进程给它们设了 `[node, cli.js]`，`src/cli.ts:261,625`）；第三方插件和 `plugins/examples/auto-ack.mjs` 受影响 | Windows 上默认值改成 `[process.execPath, <本包的 cli.js>]`（P6） |
| `src/plugin/cli-client.ts:32,122` | 插件起 `morse …` 和 `morse plugin watch --json` | 用的是上面那个 argv，可移植 | 加 `windowsHide: true`（P1） |
| `src/plugin/cli-client.ts:56` | `child.kill()` 停掉还在跑的 `morse` 命令 | 立刻杀掉；这些命令本来就短，可以接受 | 不改 |
| `src/cli.ts:1865-1902` `morse plugin watch` | 靠 `MORSE_WATCH_PARENT` 的 pid 还在不在、或 `fstatSync(1).isFIFO()` + `ppid` 变没变，判断读它输出的插件是不是没了 | `process.kill(pid, 0)` 可移植，内置插件走这条。`fstat` 一个 Windows 管道返回什么、`process.ppid` 在父进程死后变不变【待真机】——只影响没设 `MORSE_WATCH_PARENT` 的第三方插件 | P6 |
| `src/cli.ts:1829-1832` | `morse plugin dispatch\|attendant\|ilink …` 起内置插件，`stdio: 'inherit'` | 绝对路径 node，可移植 | 不改 |
| `src/cli.ts:659-661` | `execSync('pgrep -f …')` | 见 2.2 | P1 |
| `src/cli.ts:789-790` | `spawnSync(process.execPath, [cli.js, 'setup'])` | 可移植 | 不改 |
| `src/update/updater.ts:88,106,143` | `npm`、`launchctl` / `systemctl` | 见 2.1 | P3 |
| `src/daemon/session-liveness.ts:51,95` | `ps`、`lsof` | 见 2.4 | P4 |
| `src/daemon/notify.ts:19` | `osascript` | 非 macOS 不执行 | 不改 |
| `src/plugins/attendant/runner.ts:64-68` | attendant 的审批钩子（Claude 的 PreToolUse）：POSIX 单引号拼出来的命令，后面跟 `\|\| exit 2` | Git Bash 下能跑。PowerShell 5.1 **不认 `\|\|`**（PowerShell 7 才有）→ 整条钩子语法错误。没有 Git Bash 时，PreToolUse 钩子以 0 和 2 以外的状态退出算失败、可能拦住工具调用【已核实，hooks 文档】——是拦住还是放行，决定了"联系人的消息让我的 agent 动手之前先过审批"这道闸还在不在 | 改成 exec 形式（`command` + `args`），退出码在我们自己的进程里处理成 2。**在真机上确认这道闸有效之前，attendant 在 Windows 上默认关**（P6） |

### 2.7 测试与 CI

80 个测试文件，都在 macOS / Linux 上写的。按原因分，在 Windows 上会失败的：

| 原因 | 文件（举例的行） | 数量 |
|---|---|---|
| **断言权限位** `statSync(…).mode & 0o777` 等于 `0o600` / `0o700` / `0o640` | `file-lock.test.ts:95-105`、`identity.test.ts:90-91`、`identity-keys.test.ts:32-93`、`morse-chunks.test.ts:134,180-181,410`、`morse-relay.test.ts:512`、`morse-e2e-crypto.test.ts:23`、`rotation.test.ts:153`、`contact-permissions.test.ts:164,177`、`dispatch-parity.test.ts:181-182`、`ilink-protocol.test.ts:139-329`、`ilink-plugin.test.ts:155-562` | 11 个文件，约 30 条断言 |
| **建软链接**（Windows 上要开发者模式） | `file-lock.test.ts:112`、`attendant-plugin.test.ts:669`、`ilink-protocol.test.ts:265`、`migrate-home.test.ts`（整个文件）、`update.test.ts`、`install-sh.test.ts:40-57` | 6 |
| **假的 agent 命令是带 `#!` 的脚本 + `chmod 755`**，或直接 `/bin/sh -c` | `ilink-plugin.test.ts:366,474`、`dispatch-plugin.test.ts:63`、`attendant-plugin.test.ts`、`dispatch-launch.test.ts`、`install-sh.test.ts:41-68` | 5–6 |
| **写死 Unix 路径**并断言结果（`/tmp/…`、`/Users/…`、`cwd: '/…'`） | `scanner.test.ts:18,50,71`（夹具文件里的 `cwd`，只是字符串，多半能过）、`format.test.ts:28`、`migrate-home.test.ts:53-57`、`sync-agents.test.ts`、`dispatch-launch.test.ts`、`attendant-plugin.test.ts:368-380` 等约 25 个文件里出现；真正会因此失败的估计不到一半 | 待跑过才知道 |
| **Unix 套接字** | `claude-inbox.test.ts:38-117`（在临时目录里建 `.sock`） | 1 |
| **信号** | `plugin-interface.test.ts:185-203`、`ilink-plugin.test.ts:35`（用 `SIGKILL` 杀子进程——能用；但依赖"`SIGTERM` 后有序停止"的断言会失败） | 2 |
| **bash 本身** | `install-sh.test.ts`（整个文件跑 `site/install.sh`） | 1（Windows 上跳过） |
| **断言 CI 策略** | `ci-policy.test.ts`（断言 `ci.yml` 里没有 macOS） | 要加 Windows 的同类断言 |
| 起真的 `node` 子进程 | `cli-slim`、`core-commands`、`core-safety`、`send-cli`、`reply-classify`、`name-deprecated`、`agent-add-code`、`morse-domain` 等 14 个文件 | 用 `process.execPath`，多半能过；慢 |

粗估：80 个文件里 **20–25 个要改才能在 Windows 上过**，其余的要跑一遍才知道。改法：权限断言换成一个辅助函数（Windows 上查 ACL 或跳过）；软链接用例在建不了链接时跳过；假命令改成 `.mjs` + `process.execPath`（哪个平台都能跑）。

**CI 提案**（CLAUDE.md 第 7 条：新增 runner 前写出每月分钟影响）：

- 新增 `.github/workflows/ci-windows.yml`，照 `ci-macos.yml` 的样子：**只有 `workflow_dispatch`（手动）+ 每周一次定时**，`windows-latest`、Node 22，`npm ci` → `npm run build` → `npm test`；`concurrency.cancel-in-progress: true`。不进常规的 push / PR 流程，`ci.yml` 不动。
- 第一步先只跑一个子集（`npm ci` 能不能装上两个原生模块、`build`、加十来个已经改好的测试文件），随着测试改完再放开到全量。
- **分钟估算**：Ubuntu 上一个 job 约 2 分钟（最近几次 `ci.yml` 的实测）。Windows runner 慢，按 5 分钟算；私有仓库的 Windows 分钟按 2 倍计费 → 一次约 10 分钟额度。每周一次 ≈ **每月 45 分钟**；开发那一个月加上手动触发（按 10–15 次）≈ **每月 150–200 分钟**，之后回到约 45。
- `test/ci-policy.test.ts` 加断言：`ci.yml` 里不出现 `windows`；`ci-windows.yml` 有 `workflow_dispatch` 和 `schedule`。
- 这个 job 只能证明"单元测试在 Windows 上过、原生模块装得上"，证明不了下面这些。

**只能在主人的 Windows 11 上手工试的**：见第 6 节和每期的清单。CI 里没有 Claude Code、没有 Codex 桌面应用、没有登录会话、没有防火墙弹窗、没有 PowerShell 5.1 的中文代码页。

### 2.8 WSL

装在 WSL 里的 Morse **看不到 Windows 这边的 agent 会话**：WSL 是一台独立的 Linux，`~` 是 `/home/<用户>`，那里的 `~/.claude`、`~/.codex` 和 Windows 的 `%USERPROFILE%\.claude`、`.codex` 是两套目录（Codex 的文档明确写了 WSL 里的 Codex 用 Linux 家目录【已核实】）；WSL 里的守护进程起的是 Linux 版的 `claude` / `codex`，续接不了 Windows 进程写的会话，也按不了 Windows 这边会话的门铃；WSL2 默认的网络是 NAT，mDNS 出不去。反过来也一样。所以**同一台电脑上，原生 Windows 的安装和 WSL 里的安装是两个地址**——各有各的 `~/.morse`、各有各的钥匙，各管各那边的 agent；按"一个 agent 一个地址"这本来就是对的。两边要互相发消息，就像两台电脑一样互相加联系人（或者用配对码加到同一个人名下）。不做 `/mnt/c` 共享数据目录：SQLite 的 WAL 在跨系统的文件共享上不可靠，两个守护进程抢同一个身份还会互相顶掉中转连接。

## 3. 设计要点

### 3.1 一个平台模块

新增 `src/platform.ts`，把分散的平台判断收在一处：`isWindows`、`resolveAgentCli(name)`、`killTree(pid)`、`shellCommand(str)`（返回 `['/bin/sh','-c',str]` 或 `['cmd.exe','/d','/s','/c',str]`）、`renameWithRetry(from, to)`、`restrictToOwner(path)`。其余文件只调它，不各写各的 `process.platform === 'win32'`。可测：每个函数接受注入的 `platform` 参数，在 macOS 的 CI 上就能测 Windows 分支的逻辑（路径拼接用 `path.win32`）。

### 3.2 有序停止，不靠信号

- 守护进程：127.0.0.1 上的 `POST /api/shutdown`。`morse stop`、`install.ps1`、更新都调它。所有平台都加，Unix 上信号照旧。
- 插件：守护进程握着它们的 stdin；关掉 = 请停。插件读到 EOF 走原来的 `shutdown()`。
- 兜底：3 秒不走，`taskkill /T /F` 杀整棵树。

### 3.3 私钥靠什么保护

- **默认情况下靠用户目录本身的权限**：`C:\Users\<名字>` 默认只有本人、SYSTEM、Administrators 能进【这是通常的说法，没有在微软文档里核实到原文；待真机用 `icacls %USERPROFILE%` 确认】。`.morse` 建在它下面，继承这套权限，别的普通用户读不到。管理员读得到——和 Unix 上 root 读得到 `0600` 的文件是一回事。
- **不能只靠默认**：`MORSE_HOME` 指到用户目录以外（比如 `D:\`，非系统盘的根目录通常"已登录的用户"都能改【待真机】）时，`chmod` 不起作用，私钥就是公开的。所以数据目录第一次建好时，Windows 上跑一次 `%SystemRoot%\System32\icacls.exe <数据目录> /inheritance:r /grant:r <本人的 SID>:(OI)(CI)F /grant:r *S-1-5-18:(OI)(CI)F /grant:r *S-1-5-32-544:(OI)(CI)F`（去掉继承，只留本人、SYSTEM、Administrators；用 SID 不用名字，中文系统上组名是本地化的【已核实写法，[icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)、[OpenSSH key management](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement)】）。先例：Windows 版 OpenSSH 对私钥文件就是这个要求，权限宽了拒绝使用【已核实，[Win32-OpenSSH wiki](https://github.com/PowerShell/Win32-OpenSSH/wiki/Security-protection-of-various-files-in-Win32-OpenSSH)】。
- `morse status --check` 在 Windows 上读 `icacls` 的输出，有别的主体（Users、Authenticated Users、Everyone）就报错并给出修复命令。
- **不做**：用 DPAPI 加密私钥文件（要原生模块或者每次起 PowerShell，换来的只是防"拷走文件"，不防同一用户下的其他程序）。

### 3.4 找到并启动 agent 的命令行

`resolveAgentCli('claude' | 'codex')`，按顺序：

1. 环境变量 / 配置里写死的路径（`MORSE_CLAUDE_BIN`、`MORSE_CODEX_BIN`，和现有的 `MORSE_KIMI_BIN` 一个路数）。
2. PATH 上的 `<名字>.exe`。
3. 已知的安装位置：`%USERPROFILE%\.local\bin\claude.exe`（Claude 的原生安装器不改 PATH【已核实】）、`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`【已核实】。
4. PATH 上只有 `<名字>.cmd`（npm 装的）：读这个 `.cmd`，找出它实际调用的 `.js` 或 `.exe`，直接用 `node.exe <那个 js>` 或那个 `.exe` 起——**不经过 `cmd.exe`**。npm 生成的包装格式是固定的；解析不出来就报"请用官方安装器装，或者设 `MORSE_CLAUDE_BIN`"，不退到 `shell: true`。
5. 都没有：报清楚的错（"只装了桌面应用？桌面应用自带的命令行不在 PATH 上"）。

对方的消息正文**永远不进 `cmd.exe` 的命令行**；Windows 上正文一律从 stdin 进（也顺带避开 32,767 字符的上限）。

### 3.5 更新：先停，后换，再起（P3）

守护进程发现新版本并验完签名后，不自己装，而是：把 `morse.tgz` 存到数据目录 → 起一个**独立的、不加载任何原生模块的**小脚本（`dist/update/win-apply.js`，`detached` + `windowsHide`，拷到临时目录里跑，这样它自己的文件也不在要被替换的包里）→ 自己有序退出。小脚本等守护进程的 pid 消失 → `npm install -g` → 失败就重试一次；再失败就把结果写进 `update-state.json`，下一次 `morse` 命令告诉用户 → 删 `morse.ps1` → 跑 `setup` → 起守护进程。全程写日志到 `update.log`。

装到一半失败的后果是"旧的删了、新的没装上"，这是这一期最大的风险，所以：开装之前先把旧包目录整个改名成 `anytoany.old`（能改名说明没有文件被锁着——改名是这里唯一便宜的"有没有人占着"的探测），装成功再删，装失败改回来。目录里有被锁的文件时整个目录能不能改名【待真机】。

## 4. 分期计划

每期都是：先更新本文档 → 测试先行 → `npm run build`、dist 一起提交 → 分支上推 → 主人在真机上按清单试 → 主人点头才合并。行数是 `src` + `test` + 脚本的增改合计，不含 `dist`。

### P1　装得上、发得出、收得到（只走中转，只拉不推）

- **做什么**：`install.ps1`；站点构建发布它；`install.sh:125` 的提示改成给 PowerShell 命令；`morse start --background`；登录启动（计划任务，退路是 Run 注册表值）；`POST /api/shutdown` + `morse stop` 改走它；`rename` 重试；数据目录 ACL；`safeFileName` 收紧；Claude 钩子写成 exec 形式、Codex 钩子加 `commandWindows`；`send` / `reply` 加 `--text-file`；`doctor` 的三处误报；Windows 上的默认值：不开局域网、不开直连、`dispatch` 和 `attendant` 插件关、自动更新关；技能和文档加 Windows 说明。
- **不做**：消息自动送进会话（要等用户下一次提问由钩子带进去，或 agent 自己 `morse message`）。
- **改哪些文件**：新增 `site/install.ps1`、`src/platform.ts`、`test/platform.test.ts`、`test/install-ps1.test.ts`（只做静态检查：占位符、ASCII、没有 `exit`）；改 `site/install.sh`、`site/_headers`、`site/index.html`、`scripts/build-site.mjs`、`scripts/export-client.mjs`、`src/cli.ts`（`start` / `stop` / 默认值）、`src/daemon/server.ts`、`src/daemon/pidfile.ts`、`src/file-lock.ts`、`src/setup.ts`、`src/doctor.ts`、`src/cluster/morse.ts`（`safeFileName`）、`src/cluster/identity.ts`（建目录后收紧 ACL）、`src/commands/messaging.ts`、`src/plugin/manager.ts`、`src/plugin/cli-client.ts`、`skills/morse/SKILL.md`、`README*.md`、`docs/QUICKSTART*.md`，以及对应的测试。
- **量**：约 1,300–1,800 行，18–22 个文件。`install.ps1` 约 300 行，它没法在 macOS 上跑，只能靠真机——预计真机来回 2–3 轮。
- **风险**：(1) Codex 的 Windows 沙箱不让 agent 写 `.morse` 或连 127.0.0.1 → Codex 桌面应用里发不出去，得让主人在 Codex 里给 Morse 目录放行；(2) 普通权限建不了登录任务 → 自动退到 Run 值；(3) PowerShell 5.1 传中文参数乱码；(4) `src/cli.ts` 和 `feat/identity-v3-p2` 冲突——等它合并后再开工。
- **真机清单**（主人的 Windows 11）：
  1. 新开 PowerShell（不是管理员）跑 `irm https://morse.im/install.ps1 | iex`：没装 Node 时提示清楚；装了 Node 22 后一路走完，打印出地址。
  2. `morse status`：守护进程在跑、连上了中转。注销再登录后还在跑；登录时有没有黑窗闪一下。
  3. `morse status --check`：没有误报；`icacls %USERPROFILE%\.morse` 只有三个主体。
  4. 从 Mac 上的 agent 给这个地址发一条中文消息；在 Windows 的 PowerShell 里 `morse message` 能看到，中文不乱。
  5. **Codex 桌面应用**里对 agent 说"用 Morse 给 morse.im/<Mac 的地址> 发一句'你好'"：发得出去，Mac 收到，中文不乱。发不出去就把 agent 看到的报错原样记下来。
  6. 同一件事在 **Claude Code**（命令行和桌面应用各一次）里做一遍。
  7. Mac 回一条；在 Claude Code 里随便问一句，钩子把那条消息带进来了。Codex 里先在 `/hooks` 信任 Morse 的钩子，再试同样的事。
  8. 发一条带双引号、`%PATH%`、`&`、换行的消息（技能应该引导 agent 用 `--text-file`）：收到的和发的一字不差。
  9. Mac 发一个文件名带中文的文件、一个叫 `a:b.txt` 的文件：都收到，后者落盘成 `a_b.txt`。
  10. `morse stop` 后任务管理器里没有残留的 `node.exe`；再跑一遍 `install.ps1` 是原地升级，地址不变。

### 4.1 P1 实现记录（2026-11-15）

写代码前定下来的事（主人授权代定，记在 ADR-080 第 10–15 条）和实现时相对上面方案的调整。**这些全是在 macOS 上写、在 macOS 上测的**——Windows 分支的逻辑靠注入 `platform` 参数和假的 `icacls` / `schtasks` / `reg` 在 Mac 上跑单元测试，没有一行在真的 Windows 上执行过。

**代码放在哪**：Windows 的逻辑集中在新目录 `src/platform/`（不是 3.1 节说的单个 `src/platform.ts`，拆成了几个小文件），每个函数都接受注入的 `platform` 和外部命令：

| 文件 | 做什么 |
|---|---|
| `src/platform/platform.ts` | `isWindows()`；Windows 上这一期关掉的功能清单（`morse status` 打印它） |
| `src/platform/filename.ts` | `safeFileName`（所有平台） |
| `src/platform/rename.ts` | `renameWithRetry`（只在 Windows 上重试） |
| `src/platform/acl.ts` | `protectDataDir`（`icacls` 收紧）、`checkOwnerOnly`（给 `status --check` 用）、解析 SDDL |
| `src/platform/which.ts` | 不起子进程地在 `PATH` × `PATHEXT` 里找命令（替代 `which`） |
| `src/platform/autostart.ts` | 登录时启动：计划任务的 XML、`schtasks`、退路 `reg`（Run 值） |
| `src/platform/win-hooks.ts` | Windows 形式的钩子：Claude 的 `command` + `args`，Codex 的 `commandWindows` 和启动器 `.cmd` |
| `src/daemon/background.ts` | `morse start --background` |
| `src/daemon/stop.ts` | `morse stop` 在 Windows 上的流程（HTTP 停止 → 等 → 杀进程树） |
| `src/platform/process.ts` | `killTree`（Windows：`taskkill /T /F`） |
| `src/platform/status.ts`、`src/platform/doctor-win.ts` | `morse status` 在 Windows 上多打的几行；`morse status --check` 的 Windows 版检查 |
| `src/commands/text-file.ts` | `--text-file` 怎么读文件 |
| `scripts/lib/installers.mjs` | 站点构建给两个安装器填公钥（`install.ps1` 不是纯 ASCII 就拒绝构建） |

**和方案不一样的地方**：

1. **登录启动由 `morse autostart enable` 登记，不写在 `install.ps1` 里**。原方案是在 PowerShell 里 `Register-ScheduledTask`。改成 Node 里生成任务 XML 再调 `schtasks.exe /Create /XML`：XML 的内容能在 Mac 上测，P2 / P3 也要用同一个入口。建不了任务（普通权限被拒）时自动退到 `reg.exe add HKCU\…\Run`，两种只留一种。任务的动作是 `node.exe cli.js start --background --no-wait`（`--no-wait`：起了后台进程立刻退出，黑窗停留的时间最短）。`morse autostart status` / `disable` 也有；`morse status` 在 Windows 上多一行 `autostart:`。
2. **停止入口带令牌**。`POST /api/shutdown` 只绑回环还不够：浏览器里任何网页都能对 `127.0.0.1:7433` 发一个不带自定义头的 POST。守护进程每次启动生成一个随机令牌写进 `daemon.json`（数据目录里，只有本人读得到），请求必须带 `x-morse-token` 头；自定义头会让浏览器先发预检请求，而守护进程不应答预检。令牌不对一律 403。**macOS / Linux 上 `morse stop` 仍然发 `SIGTERM`，行为和输出一个字不变**；HTTP 停止只在 Windows 上用（入口本身所有平台都有）。
3. **Windows 上 `morse stop` 的顺序**：调停止入口 → 等 pid 消失（最多 5 秒）→ 还在就 `taskkill /PID <pid> /T /F` 杀整棵进程树，并明说是强杀。守护进程不带控制台（`--no-web`）启动时没有停止入口，直接走强杀并说明。pid 文件丢了的时候不再去找进程（Windows 没有 `pgrep`），只说"没在跑"。
4. **私钥目录的权限：收紧失败就拒绝写钥匙（宁可装不上，不能悄悄裸奔）**。`protectDataDir` 在三处生成私钥的地方（设备钥匙、加密钥匙、地址钥匙）和守护进程启动时调用：`whoami /user` 取本人的 SID → `icacls <数据目录> /inheritance:r /grant:r *<SID>:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F` → 再用 `icacls <数据目录> /save <临时文件>` 读回 SDDL 核对：只允许出现本人、SYSTEM、Administrators 三个主体，并且继承已断开。**核对用 SDDL 而不是 `icacls` 的普通输出**，因为普通输出里的组名随系统语言变（中文、德文系统上不一样），SDDL 里是 SID 或固定的两字母缩写。任何一步失败（`icacls` 不存在、退出码非 0、读回的内容看不懂、多出别的主体）都抛错，错误里带原始输出，方便主人原样贴回来。成功后在数据目录里留一个标记文件 `.owner-only`，之后的命令只看标记，不再每次起 `icacls`。**代价**：`icacls /save` 的输出格式是按文档推的，真机上对不上的话，第一次 `morse join` 就会失败——这是故意的，见真机清单。
5. **`morse status --check` 在 Windows 上每次都重新读一遍 ACL**（不信标记文件），多出别的主体就报错并给出修复命令。
6. **Codex 的钩子用一个启动器 `.cmd`，命令行里不带引号**。方案原来写的是 `commandWindows` 里放带双引号的整条命令。问题：默认的 Node 装在 `C:\Program Files\nodejs`，路径带空格就必须加引号，而 Codex 是把整条命令当一个参数交给 `cmd.exe /C` 的——如果它按 Rust 的常规办法转义参数里的引号，`cmd.exe` 不认这种转义，命令就坏了；它到底怎么传【待真机】。所以 `morse setup` 在数据目录里写一个 `bin\morse-hook.cmd`（里面才是带引号的 `"node.exe" "cli.js" hook %*`），钩子命令只是 `C:\Users\<名字>\.morse\bin\morse-hook.cmd codex-prompt-submit`：用户目录不带空格时整条命令没有引号，两种传法都对；用户目录带空格时仍要加引号，`setup` 会明说"这种情况没验证过"。路径里有非 ASCII 字符时启动器开头加 `chcp 65001`，同样标为没验证。Claude 的钩子按方案写成 `command` + `args`（不经过 shell）。
7. **钩子跑没跑过看得见**。钩子不执行是无声的失败（消息就是不出现）。Windows 上每次 `morse hook …` 运行都在数据目录的 `hook-runs.json` 里记一个时间，`morse status --check` 显示"上次运行：……"或"还没运行过"。只在 Windows 上记，macOS / Linux 不多写这个文件。
8. **`install.ps1` 的验签比 `install.sh` 严**。`install.sh` 在两种情况下会不验签就装：脚本不是站点构建出来的（公钥占位符还在）、站点上没有 `version.json`。`install.ps1` 这两种情况都拒绝安装，没有"跳过验签"的开关。验签那段 Node 脚本和 `install.sh` 里的是同一段（测试逐行比对，只允许取参数那一行和一个省略号不同），在 Mac 上用真的签名清单测过：签名对、包被改、清单被改、钥匙不对四种情况。
9. **Windows 上这一期关掉的功能是"强制关"，不是"默认关"**：局域网（等于总带 `--no-lan`）、直连、所有插件（`dispatch`、`attendant`、`ilink` 和自定义插件——后者要 `/bin/sh`，本来也起不来）、自动更新。配置文件里写了开也不生效，`morse plugin enable <名字>` 会明说"Windows 上这一期不可用"。`morse status` 在 Windows 上打印一段 `windows:`，逐项列出关了什么、各自等哪一期；`morse update` 可以查有没有新版，要装就提示重新运行 `install.ps1`。Windows 上发给本机会话的信也不再做"命令行版本太旧"的预检（那是给无界面续接用的，这一期没有）。attendant 强制关的理由：它的审批钩子现在是 POSIX 写法，在 Windows 上失败时是拦住还是放行不知道（第 6 节第 22 条），放行就等于没有闸。
10. **`safeFileName` 所有平台统一收紧**（安全修复）：`< > : " | ? *` 换成 `_`；去掉结尾的点和空格；保留设备名（`CON` `PRN` `AUX` `NUL` `COM0–9` `LPT0–9` `CONIN$` `CONOUT$`，带后缀也算，如 `NUL.txt`、`com1.tar.gz`）前面加 `_`；Windows 上截到 120 个字符，其他平台仍是 200。普通文件名的结果和以前完全一样。
11. **`--text-file <路径>`**：`morse send` 和 `morse reply` 都加。文件按 UTF-8 读，去掉开头的 BOM 和结尾的**一个**换行；带 BOM 的 UTF-16 也认（PowerShell 5.1 的 `>` 和 `Out-File` 写出来的就是）；别的编码（5.1 的 `Set-Content` 写的是系统代码页）不是合法 UTF-8，直接报错，不把乱码发出去。和命令行里的正文二选一，都给或都不给就报错。
12. **`rename` 重试只在 Windows 上生效**：遇到 `EPERM` / `EBUSY` / `EACCES` 从 5 ms 起翻倍重试，总共约 2 秒；macOS / Linux 上这三个错误码是真的权限问题，照旧立刻抛出。
13. **默认的 agent 名**：`install.ps1` 在"新地址"这一支不带 `-Agent` 时传 `--agent win`（电脑名 `DESKTOP-AB12CD3` 猜不出好名字）；客户端里的 `defaultAgentName` 不动（别的代码用它猜别的电脑的名字）。
14. **Node 最低版本**：`install.ps1` 要求 22。全平台统一成 22 是另外定的（ADR-084，已在 main 上：`package.json` 的 `engines`、`install.sh`、CI 的矩阵），本分支没有碰那些。

**P1 里没做、留到后面的**（原因写在后面）：

- "守护进程不在时由 `morse hook` / `morse` 命令拉起"——方案正文里提过，但分期表把它排在 P2。P1 里守护进程崩了要等下次登录，或手工 `morse start --background`。
- `src/cluster/join.ts`、`src/cluster/pair-commands.ts` 打印给"另一台电脑"的安装命令没有加 PowerShell 版：会改变 macOS / Linux 上的输出，而且配对码这条路已经不再主推（ADR-079）。
- `src/plugin/manager.ts`、`src/plugin/cli-client.ts` 的 `windowsHide`：P1 里 Windows 上不起任何插件，用不到；留给 P2 / P4 和插件停止协议一起改。
- `uninstall.ps1`（P2）。卸载的手工步骤写在指南里。
- 现有测试套件在 Windows 上全绿（P6）。`ci-windows.yml` 的第一版只跑一个子集。
- **`site/index.html`、`README*.md`、`docs/QUICKSTART*.md` 还没写 Windows 的安装命令**：真机验收通过之前不对外说"支持 Windows"。验收过了再加（`QUICKSTART` 里那句"Windows 暂不支持，可以在 WSL2 里装"到时一起改）。`site/install.sh` 遇到 Windows 时的提示已经改成给出 PowerShell 那条命令。
- **CI 里没有"真的装一遍"**：`scripts/build-site.mjs` 用 `npm.cmd` 不带 shell 调用，在 Windows 上跑不了，所以 Windows runner 上建不出测试站点。要做的话得加一个 Ubuntu job 先建站点再传给 Windows job，每月多约 7 分钟额度——没有擅自加，等主人定。现在的 Windows job 只做：两个原生模块装得上、`build`、`install.ps1` 在 PowerShell 5.1 和 7 里能解析、Windows 相关的测试子集。
- 收文件时两个只差大小写的文件名（`A.txt`、`a.txt`）在 Windows / macOS 默认的文件系统上会落到同一个文件——这是 `src/cluster/morse.ts` 的 `storeFiles` 里按大小写敏感去重造成的，早就有，不是这次引入的；那个文件另一条分支在改，这次没动，记在这里。

**第 1 轮真机验收发现并修掉的**（2026-11-15）：(1) `icacls /save` 的输出是不带 BOM 的 UTF-16LE，读回失败 → 按设计拒绝写私钥、安装停住（`de35c4a`）；(2) `install.ps1 -NoJoin` 仍然注册了地址，因为它用 `morse relay show` 判断"加没加入"，而那条命令在没有地址时会新建一个——改成直接读 `config.json`（`b14f371`）。`site/install.sh` 的 `--no-join` 有同样的问题（它也调 `relay show`），第 2 轮里一并改了（`83eb7d7`）——顺带修好了另一个后果：以前第一次安装时 `relay show` 已经先建好了地址，文档里写的那句 `morse join --relay … --agent …` 实际走不到，`--relay` 和 `--agent` 在首次安装时不起作用。

**第 4 轮（合并 ADR-083 之后）**：(5) ADR-083 靠读进程命令行判断"那个 pid 是不是守护进程"，Windows 上读不到 → 守护进程在 Windows 上独占打开 `daemon.lock`，读不到命令行时问这把锁（`src/platform/daemon-lock.ts`，合并提交 `b6f0ddc`）；这顺带解决了分期表里排在 P2 的"pid 被别的进程占用时不误判"。(6) 权限检查认得 Codex 沙箱组的只读权限（`bd9d421`）。停止令牌只在守护进程带控制台时才写进 `daemon.json`。

**发版之后（2026-11-15，分支 `fix/windows-followups`，独立评审的四条低危意见）**：(7) `parseSddl` 对带嵌套括号的条件式条目会连同其后的条目一起跳过（读成"没有别人"）→ 数着括号逐条读，读不懂的剩余内容算失败；(8) `.owner-only` 标记被永久信任 → 守护进程每次启动重读 ACL，不对就重新收紧或拒绝启动；(9) ADR-080 第 26 条写明"拒绝正文参数"只看 stdin 是不是终端，拿到伪控制台的外壳拦不住；(10) 钩子可能成为第一个打开信箱的进程而去做（或等）迁移，和 10 秒超时冲突 → 钩子遇到没有信箱或旧版本的信箱直接输出空结果。另外钩子带进会话的"怎么回信"在 Windows 上改成指向 `--text-file`。那台验收用的电脑已经换成正式发版钥匙签的版本（`irm https://morse.im/install.ps1 | iex`），钩子文件、计划任务前后逐字节相同。

**第 2 轮（同一天）又修了两处**：(3) 换了 Node 或 npm 目录之后重装，旧位置上的守护进程不会被停（安装前的那次停止只看新位置）→ 装完后用新装的程序再停一次（`f87fa5b`）；(4) **Windows 上程序（stdin 不是终端）把正文当参数传给 `morse send` / `morse reply` 时直接拒绝**，只接受 `--text-file`（`f0057e2`）——因为 `cmd.exe` 已经把参数里的 `%名字%` 换成了环境变量的值，客户端事后查不出来；人在终端里手敲不受影响。**留给 P4 / P6 的后果**：插件现在是用 `morse reply <消息号> "<正文>"` 回信的（`src/plugin/cli-client.ts`），在 Windows 上打开插件之前要改成 `--text-file`。

**真机验收怎么装**（不发版）：`scripts/morse-win-test-site.sh` 在 Mac 上用一把一次性的钥匙建一个测试站点（和 e2e 脚本用的是同一条路：`scripts/lib/test-release.sh`，不碰钥匙串里的发版钥匙，不写 `site/public`），在局域网上开着，并打印 Windows 上要运行的那一行 PowerShell。步骤在[指南](../guides/windows.zh-CN.md#真机验收清单发版前)里。

**CI**：`.github/workflows/ci-windows.yml`，只有每周一次（周一 03:30 UTC）和手动触发，`windows-latest`、Node 22，`npm ci` → `npm run build` → `install.ps1` 的语法检查（PowerShell 5.1 和 7 各一次）→ 只跑 Windows 相关的那几个测试文件（`platform`、`setup-windows`、`install-ps1`、`text-file`、`ci-policy`、`sanity`、`envelope`；清单写在 workflow 里）；有 15 分钟的硬上限；`concurrency.cancel-in-progress: true`；不进 push / PR 流程，`ci.yml` 不动。分钟估算见 2.7 节：每次约 5 分钟、Windows 按 2 倍计费 ≈ 10 分钟额度，每周一次 ≈ 每月 45 分钟。

**注意**：`workflow_dispatch` 和定时触发都要求 workflow 文件在默认分支上，所以这个 job 在本分支合并到 `main` 之前**一次都跑不了**——它帮不上真机验收之前的忙。

### P2　后台服务打磨

- **做什么**：**命令行里改动信箱的操作改走守护进程的本机接口**（第 4 轮真机验收发现：Codex 的 Windows 沙箱只给 agent 读 `.morse` 的权限，`morse reply`、把消息标成已处理这些是命令行直接写 `mailbox.db` 的，会被拦住；`morse send` 本来就是经 7433 端口交给守护进程的。守护进程在跑的时候，让 `reply` / `done` 等也经它的本机接口去做，沙箱里的 agent 就能回信了；守护进程不在时照旧直接写库）；插件停止改走 stdin（所有平台）；pid 被别的进程占用时不误判；守护进程不在时由 `morse hook` / `morse` 命令拉起；日志轮换在 Windows 上验证；`uninstall.ps1`；评估"node 做计划任务的直接进程 + 隐藏窗口"以用上 `RestartOnFailure`；`morse status` 显示登录启动是哪种方式。
- **文件**：`src/plugin/manager.ts`、`src/plugins/{dispatch,attendant,ilink}/main.ts`、`src/daemon/pidfile.ts`、`src/daemon/log-hygiene.ts`、`src/cli.ts`、`src/update/release-key.ts`、新增 `site/uninstall.ps1`、`scripts/build-site.mjs`、测试。
- **量**：约 600–900 行。
- **风险**：插件停止协议改动影响 macOS / Linux（刚修过一次有序停止，别改坏）——靠现有的 `test/plugin-interface.test.ts`。
- **清单**：任务管理器里强杀守护进程 → 插件进程几秒内自己退；下一次提问后守护进程回来了。笔记本拔电源、合盖再开：还在跑。连续开机 4 天：没被 72 小时的限制停掉。`uninstall.ps1` 之后任务、PATH 上的命令、钩子都没了，`.morse` 还在。

### P3　自动更新

- **做什么**：第 3.5 节；`globalPrefixOf` / `npmCommand` 认 Windows 布局；`detectServiceManager` 加 Windows；`morse update` 可用；打开 `update.auto`。
- **文件**：`src/update/updater.ts`、新增 `src/update/win-apply.ts`、`src/cli.ts`、`test/update.test.ts`、新增一份 Windows 更新的手工验收说明。
- **量**：约 500–700 行。
- **风险**：**这是唯一可能把一台已经装好的机器弄坏的一期**。换文件中途失败、杀毒软件锁文件、用户恰好在更新时敲 `morse`。回退靠"先改名再装"；兜底是重新跑 `install.ps1`。
- **清单**：用测试站点（`MORSE_SITE` 指过去）发一个新发布号 → `morse update` 成功、守护进程是新版、钩子还指向对的文件；自动更新在设定间隔内自己完成；更新期间正好有 agent 在发消息：命令要么成功要么报"正在更新，稍后再试"，没有半截状态；故意让 `npm install` 失败（断网）→ 旧版还能用。

### P4　把消息直接送进会话（dispatch 插件）

- **做什么**：第 3.4 节的命令行解析；正文走 stdin；超时杀进程树；Windows 上的"会话是不是开着"（`ps` / `lsof` 的替代）；Claude 门铃、`codex queue` 在 Windows 上是否可用；`dispatch` 在 Windows 上默认打开；`cwd.startsWith('/')` 那几处。
- **文件**：`src/adapters/exec.ts`、`src/adapters/claude.ts`、`src/adapters/codex.ts`、`src/adapters/version-guard.ts`、`src/daemon/session-liveness.ts`、`src/daemon/claude-inbox.ts`、`src/plugins/dispatch/*.ts`、`src/cluster/sync-agents.ts`、`src/doctor.ts`、`src/platform.ts`、测试。
- **量**：约 500–800 行；真机上要先花时间看清楚各家的行为，再写代码。
- **风险**：判断不出会话是不是开着 → 往用户正在用的会话里重复注入（ADR-023 的老问题）。拿不准的时候宁可不推、留给钩子。
- **清单**：会话关着时从 Mac 发一条 → 几秒内被无界面续接，Mac 收到回信；会话开着时发一条 → 不出现重复的一轮；3 万字以上的长消息；`claude` 是 npm 装的（只有 `.cmd`）时也能投递；只装了 Codex 桌面应用时报的错看得懂。

### P5　局域网和直连

- **做什么**：Windows 上打开 `--lan` 和直连；mDNS 选对网卡；防火墙弹窗的说明和事后检查。
- **文件**：`src/cluster/peers.ts`、`src/cluster/lan.ts`、`src/cluster/direct.ts`、`src/cli.ts`、`src/doctor.ts`、`site/install.ps1`、文档。
- **量**：约 200–400 行，多数是检查和说明。
- **风险**：用户在防火墙弹窗上点了"取消"（或者不是管理员），之后局域网悄悄不通而且不再弹。只能靠 `status --check` 把它查出来并告诉用户去哪删那条阻止规则。
- **清单**：Windows 和 Mac 在同一个路由器下：`morse pair` 互相看得到；发文件走的是局域网（`morse status` 显示）；关掉局域网后直连能建起来；在弹窗上点"取消"之后 `status --check` 报得出来；装着 WSL / Hyper-V 的机器上 mDNS 仍然找得到对方。
- **拆成两半做**（2026-11-16）：ADR-091 之后局域网在所有平台上都是默认关，配对（`morse pair`）也删了，上面清单里局域网那几条要按"局域网按地址"重写。**前一半只开 WebRTC 直连**（4.2 节）；局域网（监听 TCP、mDNS、防火墙弹窗的检查）是后一半，Windows 上仍然强制关。

### 4.2 P5 前一半：Windows 上打开 WebRTC 直连（2026-11-16）

**开关在哪**：第 1 期把直连放进了 `src/platform/platform.ts` 的 `WINDOWS_LIMITS`（"这一期 Windows 上强制关"的列表，ADR-080 第 19 条），`src/cli.ts` 三处 `platformOff('direct')` 据此：守护进程启动时把 `direct` 设成 `false`、日志打 `windows: direct links (WebRTC): not available …`、`morse status` 不打 `direct:` 那一行。直连本身的代码（`src/cluster/direct.ts`、`morse.ts` 里的信令和兜底）没有任何平台分支。

**改了什么**：从 `WINDOWS_LIMITS` 里去掉 `direct`，`PlatformLimitKey` 里也去掉，`cli.ts` 三处判断删掉——Windows 上走和 macOS 同一条路：默认开、`morse.direct.enabled: false` / `MORSE_DIRECT=0` 关；3 秒打不开走中转、按设备 5 分钟起翻倍退避（最多 6 小时）、空闲 5 分钟关、中途断了改走中转。`morse status` 在 Windows 上的 `windows:` 段不再列直连，改由通用的 `direct:` 行说现状。安装器结尾和技能里"Windows 上没有直连"的说法改掉。

**逐项核对过、不用改的**：

| 项 | 结论 |
|---|---|
| 预编译包 | `node-datachannel` 0.33.6 的 `@node-datachannel/win32-x64-msvc` 在 `npm install -g` 时作为可选依赖装上（正式版那台电脑上本来就在）；**真机上 Node 22.23.5 加载成功**，两端回环数据通道约 0.1 秒打开（[验收记录](../guides/windows-test-log.zh-CN.md)第 7 轮） |
| ICE / STUN | `stun:stun.cloudflare.com:3478`，真机上约 0.2 秒拿到 srflx 候选；host 候选里有 WSL / Hyper-V 的虚拟网卡和代理软件的 TUN 网卡地址——libdatachannel 都报上去，由连通性检查挑能通的那一对 |
| 信令 | 走 v3 连接上的 `signal` 帧（ADR-069 第 4 条、ADR-091），只在这台电脑的第一个地址和它的联系人之间；和平台无关 |
| 路径、套接字 | 直连不碰文件路径；UDP 套接字由 libdatachannel 自己开，Node 这边没有 Unix 套接字或信号 |
| 停止 | 有序停止（`POST /api/shutdown`，第 1 期）→ `morse.stop()` → `direct.close()` 关掉所有通道 → `process.exit`。**真机上发现关通道被延后到 `setImmediate`、进程先退了，对方要等约 30 秒才知道**——已修（ADR-080 第 37 条，所有平台）：停止时当场关，对方几十毫秒内就知道。注销时被系统直接结束没有机会关：对方仍要等约 30 秒 ICE 超时，之后改走中转 |
| 升级 | `.node` 加载后不能被覆盖：`install.ps1` 升级前先停守护进程（第 1 期已有，`better-sqlite3` 也是这样） |
| 防火墙 | 直连只在随机 UDP 端口上先发后收，不监听 TCP。真机上没有弹窗、没有入站失败，但那台电脑本来就有放行 `node.exe` 的入站规则（公用网络，TCP/UDP），所以"没有规则也通"要在一台干净的 Windows 上再看一次；不通时退到中转 |

**真机结果**（2026-11-16，验收记录第 7 轮）：除"重启 Mac 的守护进程"（那是主人在用的守护进程，没碰）以外全部通过；顺带修了第 37 条。还没测：不同网络之间（srflx 打洞，必要时对称 NAT 退中转）、干净的 Windows 上的防火墙。

**清单**（真机，同一个路由器下的 Mac 和 Windows——所以测的是 host 候选，不同网络之间的 srflx 打洞要另测）：两个方向的消息日志里都是 `delivered via direct`；1–3 MB 的文件两个方向分块走直连；传文件途中把直连断掉 → 改走中转并传完；通道开着时重启任何一边的守护进程 → 之后的消息仍然送到（先中转或重新建直连）；`morse status` 的 `direct:` 行；防火墙有没有弹窗、要不要规则。

### P6　其余插件和测试收尾

- **做什么**：`attendant`（审批钩子改 exec 形式、敏感目录规则适配 Windows 路径、真机确认审批闸有效后再默认打开）、`on_message` 和自定义插件的 `cmd.exe` 版本、`ilink`、`plugin watch` 的"读的人没了"判断、测试套件在 Windows 上全绿、`ci-windows.yml` 放开到全量。
- **文件**：`src/plugins/attendant/*.ts`、`src/plugins/ilink/*.ts`、`src/plugin/on-message.ts`、`src/plugin/manager.ts`、`src/plugin/cli-client.ts`、`src/cli.ts`、20–25 个测试文件、`.github/workflows/ci-windows.yml`、`test/ci-policy.test.ts`、`docs/PLUGINS*.md`。
- **量**：约 900–1,400 行（其中测试改动 400–600）。
- **风险**：attendant 是让别人的消息驱动你的 agent 的那一层，Windows 上的审批钩子如果失败时是"放行"，等于没有闸。这一期要单独做一次安全审查。
- **清单**：联系人发来一条要动文件的请求 → 审批请求出现、不批就不执行；把钩子故意弄坏（改错 node 路径）→ 工具调用被拦住而不是放行；`morse plugin add` 一条 `cmd` 写法的自定义插件能起来、能停。

`ci-windows.yml` 的第一版（只跑子集）跟 P1 一起加，之后每期放开一部分。

**合计**：约 4,000–6,000 行。P1 是能不能用的分界；P2 + P3 做完才算"装了不用管"；P4 做完才和 macOS 上的体验一样。

## 5. 要主人定的事（2026-11-15 已按主人的授权代定，记在 ADR-080）

1. **第 1 期"只拉不推"先上**。Windows 上第一版，消息不会被自动送进会话，要等你在那个会话里说下一句话（钩子带进来），或者让 agent 去查（`morse message`）。"发过去对方立刻开工"等 P4。
2. **守护进程按用户跑**：登录时启动，注销时停；注销期间的消息由中转的离线信箱存着。不做 Windows 服务，不要管理员权限。
3. **没装 Node 时 `install.ps1` 只告诉怎么装**，不代装。最低 Node 22（全平台统一改 22 见 ADR-084）。
4. **attendant 在 Windows 上先关**，直到真机上确认审批那道闸有效（对 ADR-066 的临时例外）。局域网、直连、`dispatch`、自动更新在 P1 里同样关着；每一项都在 `morse status` 里明说，不悄悄失败。
5. **Windows 的 CI**：每周一次 + 手动，只跑子集，平时每月约 45 分钟额度。
6. **只承诺 Windows 11 x64**；ARM 版和 Windows 10 "可能能用、没试过"。**这一条要在真机验收前和主人确认**（他那台是 x64 还是 ARM）。

## 6. 只有真的 Windows 才能回答的事

按"卡住哪一期"排。

**2026-11-15 第 1 轮真机验收（Windows 11 x64，经 SSH）之后已经有答案的**——细节在[验收记录](../guides/windows-test-log.zh-CN.md)：

- 第 2 条：**行**。普通权限的 `schtasks /Create /XML`（当前用户登录时、不提权）建得了，连 SSH 会话里都行。
- 第 3 条：`irm` 取回来是字符串，5.1 解析 `install.ps1` 0 个错误；`Invoke-WebRequest` 下载 tgz 正常；npm 用 `node npm-cli.js` 调，没有碰到 `npm.ps1`。
- 第 4 条：PowerShell 5.1 → `morse.cmd` → node，中文参数、带空格的参数都对；**但 `cmd.exe` 会把参数里的 `%名字%` 展开成环境变量的值**（实测 `%PATH%`）——所以正文不能当参数传，见 4.1 节第 11 条和技能。输出在 UTF-8 的控制台里不乱；在 Codex / Claude Code 的工具结果里乱不乱还要桌面上看。
- 第 7 条：`%USERPROFILE%\.morse` 收紧之后的 ACL 是 `D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;<SID>)`，`icacls` 那条命令在中文系统上跑得通。**`icacls /save` 写的是不带 BOM 的 UTF-16LE**（当初按"带 BOM"写的，第一次安装因此失败、已修）。
- 第 8 条：`%USERPROFILE%\.codex\sessions` 在，`morse list` 读得出 Codex 桌面应用的会话（标题、工作目录都对）。`.claude` 那台机器上没有。
- 第 9 条：计划任务启动的守护进程没有窗口（`MainWindowHandle = 0`），任务自己的进程退出后它还活着，跑在用户的桌面会话里。登录时黑窗闪不闪还没看。（另：经 SSH 会话起的后台进程会在 SSH 断开时被系统一起结束——那是 OpenSSH 的会话管理，和计划任务无关。）
- 第 2 轮补充（Codex，0.169）：应用包里的 `codex.exe`（`C:\Program Files\WindowsApps\OpenAI.Codex_…\app\resources\`）直接运行报 "Access is denied"；每用户的那份能跑：`%LOCALAPPDATA%\OpenAI\Codex\bin\<一串字符>\codex.exe`（这是 3.4 节"找命令行"该加的位置）。`codex exec` 从没有窗口的后台会话里、用已有的登录能跑完一轮（第 15 条的 Codex 一半）。`codex queue` 子命令存在（第 17 条的一半）。**没信任的钩子被静悄悄跳过，没有任何输出**（第 6 条的一半）。`~\.codex\session_index.jsonl` 存在。
- 第 3 轮补充（Codex 的钩子信任）：文档里**没有**不经界面给某条钩子记信任的办法（没有子命令、没有配置键；只有按次绕过的 `--dangerously-bypass-hook-trust`）。信任是按钩子定义的哈希记的，**改钩子定义就要重新信任**——所以给钩子补 `timeout`（现在没写，Codex 默认 600 秒）这类改动要攒着一次做。Codex 在 Windows 上执行命令用的是 PowerShell 7（装了的话），不是 5.1。无界面的 `codex exec` 在 SSH 会话里起不了沙箱执行器（`timed out … connecting runner pipe-in`），所以第 1 条在 SSH 里没法答。
- 第 4 轮补充（第 1 条的一半）：**Codex 桌面应用的沙箱以两个本机账号运行**（`CodexSandboxOffline`、`CodexSandboxOnline`，同属本机组 `CodexSandboxUsers`），需要读哪个目录就把这个组以"读取和执行"加进那个目录的权限——真机上 `.morse` 和 `Documents` 上各有一条。所以沙箱里的 agent 读得到 `.morse`（含私钥），写不了：`morse message` 这类只读的命令能不能跑还要看 SQLite 在只读目录上开 WAL 库的表现，`morse reply`（直接写库）一定不行，`morse send`（经本机 7433 端口交给守护进程）取决于沙箱放不放回环连接。权限检查已经认这一条（不算失败，明说）。
- 还没答案的：第 1 条剩下的一半（沙箱里 `morse` 各条命令实际的报错）、第 5、6 条（两家应用里钩子触不触发、信任之后升级要不要重新信任）、第 10 条（并发改名的失败频率）。

**P1 之前要知道的**
1. Codex 桌面应用的 agent（PowerShell + Windows 沙箱）能不能：运行 `morse.cmd`；写 `%USERPROFILE%\.morse\mailbox.db`；连 `127.0.0.1:7433`。不能的话报什么错。
2. 普通权限的 PowerShell 能不能 `Register-ScheduledTask` 建一个"当前用户登录时"的任务。
3. `irm … | iex` 在 Windows PowerShell 5.1 默认设置下：脚本解码对不对；`Invoke-WebRequest` 下载 tgz 行不行；`npm` 会不会被解析成 `npm.ps1`。
4. PowerShell 5.1 → `morse.cmd` → node：中文参数、带空格的参数到 node 里对不对；`morse message` 的中文输出在 Codex / Claude Code 的工具结果里乱不乱。
5. Claude Code 在 Windows 上接不接受 exec 形式（`command` + `args`）的 UserPromptSubmit 钩子（最低版本）；桌面应用的 Code 页签里钩子触不触发。
6. Codex 的钩子：`commandWindows` 里带双引号、带空格路径的命令经 `cmd.exe /C` 之后对不对；钩子的环境里有没有 `PATH`；信任一次之后，我们升级改了钩子命令要不要重新信任；桌面应用里触不触发。
7. `%USERPROFILE%` 的默认 ACL；`icacls` 那条命令在中文系统上跑不跑得通。
8. `%USERPROFILE%\.codex\sessions\`、`session_index.jsonl`、`%USERPROFILE%\.claude\projects\` 的实际样子（目录名、文件名、jsonl 里的 `cwd` 字段是 `C:\…` 还是别的）。
9. 登录时黑窗闪不闪；`detached` + `windowsHide` 起的守护进程在父进程退出后是不是还活着、有没有窗口。
10. 两个 `morse` 进程同时改 `config.json`，`rename` 多久失败一次、重试几次能过（开着 Defender 实时保护）。

**P2–P3**
11. 目录里有被加载的 `.node` 文件时，整个目录能不能改名；`npm install -g` 覆盖一个正在运行的安装具体怎么失败。
12. 计划任务的 `RestartOnFailure` 在进程被强杀后触不触发；有没有不闪窗、又让 node 做任务直接进程的办法。
13. `ftruncate` 一个自己以追加方式打开的日志文件后，后续写入的位置。
14. win32-arm64 上两个原生模块实际能不能加载（如果有 ARM 机器）。

**P4**
15. `claude -p --resume <id>` 和 `codex exec resume <id>` 从一个没有窗口的后台进程里起，能不能跑完一轮；Codex 的沙箱在这种情况下的行为；正文从 stdin 给行不行。
16. `%USERPROFILE%\.claude\sessions\<pid>.json` 在 Windows 上有没有、`messagingSocketPath` 是什么；往里写一行能不能叫醒会话。
17. Codex 在 Windows 上的线程写锁是什么形式；`codex queue` 有没有。
18. npm 装的 `claude.cmd` / `codex.cmd` 里面实际调的是什么（决定第 3.4 节第 4 步怎么解析）；只装桌面应用时自带的命令行在哪、能不能直接调。
19. 往一个正开着的会话里无界面续接，在 Windows 上会发生什么（重复一轮？报错？）。

**P5–P6**
20. 监听 `0.0.0.0:7434`、绑 UDP 5353、WebRTC 的 UDP 端口，各自弹不弹防火墙窗；管理员和非管理员各是什么结果。
21. 有 WSL / Hyper-V 虚拟网卡时 mDNS 找不找得到局域网里的 Mac。
22. 没装 Git Bash 时，Claude 的 PreToolUse 钩子执行失败是拦住工具调用还是放行。
23. `fstat` 一个管道、`process.ppid` 在父进程死后的值。
24. 主人碰到的 WSL "Access denied" 到底是什么原因——不影响本方案，但值得记一笔。

## 7. 资料来源

官方文档与发布页（2026-11-14 读取）：

- Claude Code：[setup](https://code.claude.com/docs/en/setup) · [troubleshoot-install](https://code.claude.com/docs/en/troubleshoot-install) · [claude-directory](https://code.claude.com/docs/en/claude-directory) · [sessions](https://code.claude.com/docs/en/sessions) · [hooks](https://code.claude.com/docs/en/hooks) · [desktop](https://code.claude.com/docs/en/desktop) · [skills](https://code.claude.com/docs/en/skills) · [Claude Desktop data storage](https://claude.com/docs/third-party/claude-desktop/data-storage)
- Codex（`developers.openai.com/codex/*` 现在跳转到 learn.chatgpt.com）：[windows-sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) · [windows-app](https://learn.chatgpt.com/docs/windows/windows-app) · [windows-deployment](https://learn.chatgpt.com/docs/enterprise/windows-deployment) · [hooks](https://learn.chatgpt.com/docs/hooks) · [non-interactive-mode](https://learn.chatgpt.com/docs/non-interactive-mode) · [environment-variables](https://learn.chatgpt.com/docs/config-file/environment-variables) · [build-skills](https://learn.chatgpt.com/docs/build-skills) · [openai/codex](https://github.com/openai/codex)
- Node.js：[child_process](https://nodejs.org/api/child_process.html) · [process · Signal events](https://nodejs.org/api/process.html#signal-events) · [fs](https://nodejs.org/api/fs.html) · [2024-04 安全公告（CVE-2024-27980）](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2) · [DEP0190](https://nodejs.org/api/deprecations.html#DEP0190)
- libuv 源码：[win/process.c](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c) · [win/fs.c](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c) · [win/error.c](https://github.com/libuv/libuv/blob/v1.x/src/win/error.c)
- 原生模块：[better-sqlite3 v12.11.1 发布页](https://api.github.com/repos/WiseLibs/better-sqlite3/releases/tags/v12.11.1) · [node-datachannel 0.33.6](https://registry.npmjs.org/node-datachannel/0.33.6) · [@node-datachannel/win32-arm64-msvc](https://registry.npmjs.org/@node-datachannel/win32-arm64-msvc/0.33.6) · [node-gyp on Windows](https://github.com/nodejs/node-gyp#on-windows) · [bonjour-service](https://registry.npmjs.org/bonjour-service/latest)
- npm：[folders](https://docs.npmjs.com/cli/v11/configuring-npm/folders)
- 微软：[Security Contexts for Tasks](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks) · [schtasks create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create) · [LogonTrigger.UserId](https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger-userid) · [ExecutionTimeLimit](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit) · [RestartOnFailure](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element) · [Run and RunOnce keys](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys) · [sc create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/sc-create) · [Windows Firewall rules](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules) · [about_Execution_Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies) · [icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls) · [OpenSSH key management](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement) · [CreateSymbolicLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw) · [VBScript 停用时间表](https://techcommunity.microsoft.com/blog/windows-itpro-blog/vbscript-deprecation-timelines-and-next-steps/4148301)

旁证（源码、issue、第三方）：[Codex 钩子的命令执行器](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/command_runner.rs) · [openai/codex#13762](https://github.com/openai/codex/issues/13762) · [npm/cli#470](https://github.com/npm/cli/issues/470) · [multicast-dns#41](https://github.com/mafintosh/multicast-dns/issues/41)、[#68](https://github.com/mafintosh/multicast-dns/issues/68) · [node-windows](https://github.com/coreybutler/node-windows#readme) · [Win32-OpenSSH wiki](https://github.com/PowerShell/Win32-OpenSSH/wiki/Security-protection-of-various-files-in-Win32-OpenSSH) · [ScoopInstaller/Install](https://github.com/ScoopInstaller/Install#readme)
