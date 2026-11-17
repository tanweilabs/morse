# 在 Windows 上用 Morse（预览版）

> 创建：2026-11-15 · 最后更新：2026-11-16

> 状态：**第 1 期已发版**（2026-11-15，release 20261115090856）：`irm https://morse.im/install.ps1 | iex` 装的是正式钥匙签的版本。发版前在一台 Windows 11（x64）上经 SSH 做了几轮真机验收（记录在 [windows-test-log.zh-CN.md](windows-test-log.zh-CN.md)）；还有两件事只有坐在那台电脑前的人能做，见[还要本人在桌面前做的](#还要本人在桌面前做的)。

## 这一版能做什么

- 装得上：Windows 11（x64），Node.js 22 以上，**不需要管理员权限**，不需要 WSL。
- 发得出、收得到：Claude Code、Codex 里的 agent 用 `morse send` / `morse read` / `morse reply` 收发消息和文件，端到端加密，走中转。
- **只拉不推**：消息不会自己跳进会话。你在那个会话里说下一句话时，钩子把新消息带进来；或者让 agent 运行 `morse read`。
- 后台程序在你**登录 Windows 时启动，注销时停**。注销期间的消息由中转存着（最多 7 天），登录后收到。

这一版在 Windows 上**关着**的（`morse status` 会逐项列出来）：局域网直传、把消息直接送进会话（dispatch）、你的 agent 自动回答联系人（attendant）、自动更新。

**WebRTC 直连是开着的**（2026-11-16 起，和 macOS 一样）：联系人在线、能打通时消息和文件不经中转；约 3 秒打不开就走中转。`morse status` 的 `direct:` 一行说现状；要关：`config.json` 里写 `"morse": {"direct": {"enabled": false}}`。不用为它改防火墙：打不通时自动走中转。

## 安装

打开 PowerShell（普通窗口，不要"以管理员身份运行"）：

```powershell
irm https://morse.im/install.ps1 | iex
```

- 没装 Node.js 时它只会告诉你怎么装：`winget install OpenJS.NodeJS.LTS`，装完**新开一个** PowerShell 窗口再运行上面那行。
- 装完会打印 `Your address: morse.im/<26 个字符>`，这就是这台电脑的地址，发给朋友。
- 装完**新开一个终端**才有 `morse` 命令；Codex、Claude 桌面应用要重启一次才找得到它。
- **Codex 要多做一步**：新装的钩子要你信任之后才运行——在 Codex 里输入 `/hooks`（或 设置 → Hooks），信任 Morse 那一条。
- 带参数时不能用 `| iex`，换成：`& ([scriptblock]::Create((irm https://morse.im/install.ps1))) -NoService`（`-Agent <名字>` 仍然接受，只是兼容：给这次新建的地址起个备注名，只有一个地址时哪里都不显示；已经有地址的电脑上会被忽略，不新增地址、不改名。以前装的、叫 `win` 的地址保持原样）。

安装包下载后先核对发版签名，核对不过就不装，没有跳过的办法。

## 第一条消息

1. 加联系人：`morse contact add morse.im/<对方的地址> --name <备注>`
2. 发：`morse send <备注> "你好"`，或者对 agent 说"用 Morse 给 <备注> 发一句你好"。
3. 收：`morse read`。

**正文里有引号、`%`、`&`、换行，或者比较长时**，先把正文存成 UTF-8 文件，再 `morse send <备注> --text-file <文件>`（`morse reply <消息号> --text-file <文件>` 同理）。Windows 的命令行会把这些字符改掉——真机上试过：正文里的 `%PATH%` 当参数传时，发出去的是整条 PATH 的内容。所以 **agent（或脚本）在 Windows 上把正文当参数传时，`morse` 会直接拒绝**，提示改用 `--text-file`；技能里也是这么写的。你自己在终端里敲 `morse send <备注> "你好"` 不受影响。

## 日常

| 要做的事 | 命令 |
|---|---|
| 看状态（后台程序、中转、登录启动、关着的功能） | `morse status` |
| 自检（权限、钩子有没有运行过） | `morse status --check` |
| 停止 / 启动后台程序 | `morse stop` · `morse start --background` |
| 登录时启动：看 / 重新登记 / 取消 | `morse autostart` · `morse autostart enable` · `morse autostart disable` |
| 更新 | 再运行一遍安装命令（Windows 上没有自动更新） |
| 卸载 | `morse stop`；`morse autostart disable`；`npm.cmd uninstall -g anytoany`。`%USERPROFILE%\.morse` 里是你的钥匙和消息，删掉就等于放弃这个地址 |

## 出问题时

- **`morse` 找不到**：新开一个终端；还不行就按安装结尾的提示把 npm 的目录加进 PATH。
- **`cannot make … private to your Windows account`**：Morse 没能把数据目录的权限收紧到只有你本人，于是拒绝写私钥。把整段报错发给维护者。
- **消息没有出现在会话里**：`morse status --check` 看 `claude inbox hook` / `codex inbox hook` 那两行。`has not run yet` = 钩子一次都没运行过（Codex：还没信任；Claude Code：版本太旧）。这时让 agent 运行 `morse read` 照样能收。
- **Codex 里的 agent 看得到信、但发不了或回不了**：Codex 的沙箱只给了它读 `.morse` 的权限（它会把自己的 `CodexSandboxUsers` 组以只读加进这个目录，`morse status --check` 里看得到这句说明），写不进去。给那个会话完全访问权限就能发；报错的原话发给维护者。
- 日志在 `%USERPROFILE%\.morse\daemon.log`，是 UTF-8 的：`Get-Content -Encoding UTF8 -Tail 30 $env:USERPROFILE\.morse\daemon.log`（不加 `-Encoding UTF8`，PowerShell 5.1 里破折号和中文会乱码）。

## 真机验收清单（发版前）

给维护者：在自己的 Windows 11 上照着做，每一步把"贴回"的内容原样发回来。**哪一步失败了就停在那一步**，把输出贴回来，不用往下做。

**开始前要确认一件事**：这台电脑是 x64 还是 ARM（第 1 步的第一行输出）。这一版只承诺 Windows 11 x64。

**准备（在 Mac 上，本仓库的目录里）**——用测试站点装，不动正式发布：

```bash
git checkout feat/windows-native && git pull
scripts/morse-win-test-site.sh
```

它会打印一行以 `& ([scriptblock]::Create(` 开头的 PowerShell 命令（里面是 Mac 的局域网地址，下面写作 `<测试站点>`，形如 `http://192.168.1.20:8787`），然后一直开着；两台电脑要在同一个网络里。这个脚本只在内部仓库里有。

以下都在 Windows 的 PowerShell 里做（**不是管理员**），除非写了"在 Mac 上"。

| # | 做什么 | 运行 | 贴回 |
|---|---|---|---|
| 1 | 机器信息 | `$env:PROCESSOR_ARCHITECTURE; [Environment]::OSVersion.Version.ToString(); $PSVersionTable.PSVersion.ToString(); node -v` | 全部输出（没有 node 也贴） |
| 2 | 没有 Node 22+ 时：安装器只提示、不代装 | 运行 Mac 上打印的那行命令，看到提示后 `winget install OpenJS.NodeJS.LTS`，**新开窗口**。已有 Node 22+ 就跳过 | 那段提示 |
| 3 | **安装** | Mac 上打印的那行：`& ([scriptblock]::Create((irm <测试站点>/install.ps1))) -Site <测试站点>` | **全部输出**。应该有 `signature OK`、`Morse is installed.`、`Your address: morse.im/…`、`daemon: running in the background` |
| 4 | 状态（**新开一个 PowerShell**） | `morse status` | 全部输出。应该有 `daemon: running`、中转已连上、`autostart: scheduled task MorseDaemon`（或 `registry Run value`）、一段 `windows:` |
| 5 | 自检 | `morse status --check` | 全部输出。除了两个钩子可能写 `has not run yet`，不应该有 ✗ |
| 6 | 私钥目录的权限 | `icacls $env:USERPROFILE\.morse; icacls $env:USERPROFILE\.morse /save $env:TEMP\acl.txt; Get-Content $env:TEMP\acl.txt` | 全部输出。应该只有你本人、SYSTEM、Administrators |
| 7 | 登录启动是怎么登记的 | `schtasks /Query /TN MorseDaemon /V /FO LIST`（说找不到就再跑 `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v MorseDaemon`） | 全部输出 |
| 8 | 两种终端里都有 `morse` | PowerShell 里 `morse --version; (Get-Command morse).Source`；再开 `cmd` 运行 `morse --version` | 输出。`Source` 应该以 `morse.cmd` 结尾 |
| 9 | 互加联系人 | Windows：`morse contact add morse.im/<Mac 的地址> --name mac`；**在 Mac 上**：`morse contact add morse.im/<Windows 的地址> --name win` | 两边的输出 |
| 10 | **收** | **在 Mac 上**：`morse send win "你好，Windows。中文测试"`；Windows：`morse read` | Windows 的输出。中文乱不乱 |
| 11 | **发**（中文当参数） | `morse send mac "你好，来自 Windows"`；**在 Mac 上**：`morse read` | 两边的输出。Mac 上看到的字对不对 |
| 12 | 特殊字符走文件 | ``[IO.File]::WriteAllText("$env:USERPROFILE\t.txt", "他说 `"hi`" & 100% %PATH% <ok>`n第二行"); morse send mac --text-file $env:USERPROFILE\t.txt``；**在 Mac 上**：`morse read` | Mac 上看到的正文，应该一字不差（两行） |
| 13 | 收文件、中文文件名 | **在 Mac 上**：`echo 测试 > /tmp/报告.txt; morse send win "一个文件" --file /tmp/报告.txt`；Windows：`morse read` | Windows 的输出（应该有 `file: 报告.txt … <路径>`），以及这个路径能不能打开 |
| 14 | **Claude Code 的钩子**（装了才做） | **在 Mac 上**再发一条；Windows 的 Claude Code 里随便问一句；然后 `morse status --check; claude --version; Get-Content $env:USERPROFILE\.claude\settings.json` | 会话里有没有出现 `[morse] … new message`；三条命令的输出。`claude inbox hook` 那行应该写 `last ran …` |
| 15 | Claude Code 里发 | 对 agent 说：用 Morse 给 mac 发一句"你好"，然后运行 morse read | agent 实际运行的命令和输出；Mac 上收到没有 |
| 16 | **Codex 的钩子** | Codex 里 `/hooks` 信任 Morse 那条；**在 Mac 上**再发一条；Codex 里随便问一句；然后 `morse status --check; Get-Content $env:USERPROFILE\.codex\hooks.json; Get-Content $env:USERPROFILE\.morse\bin\morse-hook.cmd` | 消息有没有被带进会话；三条命令的输出。`codex inbox hook` 那行应该写 `last ran …` |
| 17 | **Codex 里发**（沙箱） | 对 Codex 说：运行 morse address，再用 Morse 给 mac 发一句"你好"，再运行 morse read | agent 运行的命令和**原样的报错**；它看到的地址和第 3 步的是不是同一个；Mac 上收到没有 |
| 18 | 注销再登录 | 注销 Windows，重新登录，等一分钟，`morse status` | 输出（应该还在跑，pid 变了）；登录时有没有黑窗口闪一下 |
| 19 | 停止后不留进程 | `morse stop; Get-CimInstance Win32_Process -Filter "name='node.exe'" \| Select-Object ProcessId, CommandLine` | 输出。不应该有命令行里带 `anytoany` 的 node |
| 20 | 再启动 | `morse start --background; morse status` | 输出 |
| 21 | 原地升级（`irm \| iex` 的写法） | `$env:MORSE_SITE = '<测试站点>'; irm <测试站点>/install.ps1 \| iex; morse address` | 全部输出。地址应该和第 3 步一样；PowerShell 窗口不应该被关掉 |
| 22 | 验签不过就不装 | `Remove-Item Env:MORSE_SITE; irm <测试站点>/install.ps1 \| iex`（这次会去 morse.im 下载，而测试版的安装器只认测试钥匙） | 输出。应该报 `failed the signature check`、什么都没装；之后 `morse --version` 照常 |
| 23 | 收尾 | **在 Mac 上** Ctrl+C 停掉测试站点。Windows：`node -e "const f=require('os').homedir()+'/.morse/config.json',fs=require('fs'),c=JSON.parse(fs.readFileSync(f,'utf8'));delete c.update;fs.writeFileSync(f,JSON.stringify(c,null,2))"`（去掉指向测试站点的记录） | 无 |

验收时装的是测试钥匙签的版本。正式发版后在 Windows 上再运行一遍 `irm https://morse.im/install.ps1 | iex` 换成正式版，地址不变。

### 还要本人在桌面前做的

两轮远程验收（2026-11-15）之后，第 1–13、19–23 步都通过了；那台电脑上的 Node 已经是 22，Morse 装在正常位置，`morse` 在 PATH 上，后台程序在跑。远程替不了的只剩两件：

1. **在 Codex 里信任钩子，再收发一条**（第 16、17 步）。桌面应用：输入框旁的 **Review hooks**（或 设置 → Hooks）→ 信任 Morse 那一条。命令行里是：启动时弹出 `Hooks need review` → 选 `1. Review hooks` → 回车进 `UserPromptSubmit` → 核对 `Command` 是 `…\.morse\bin\morse-hook.cmd codex-prompt-submit` → 按 `t`。然后让 Mac 发一条消息过来，在 Codex 里随便问一句：新消息应该被带进会话；`morse status --check` 里 `codex inbox hook` 那行应该变成 `last ran …`。再对 Codex 说："运行 morse address，然后用 Morse 给 mac 发一句你好"——看沙箱放不放行，发不出去就把它的原话贴回来。（这一步替不了：Codex 的文档里没有不经界面就能信任某条钩子的办法，没信任的钩子会被静悄悄跳过；无界面的 Codex 在 SSH 里连沙箱都起不来。见[验收记录第 3 轮](windows-test-log.zh-CN.md)。）
2. **下次正常登录就行，不用专门注销**（第 18 步）。任务有没有在登录时触发、后台程序是不是自己起来的，维护者事后经 SSH 用[验收记录里那段只读的检查](windows-test-log.zh-CN.md#b-下次登录怎么自证)就能确认。只有一件事要你自己看：登录时有没有黑窗口闪一下、闪多久。

装了 Claude Code 的话，第 14、15 步同理（那台电脑上现在没有装）。两件都过了就可以发版；发版后在这台电脑上运行一遍正式的 `irm https://morse.im/install.ps1 | iex`，换掉测试钥匙签的版本。

### 最可能出问题的五处

> 两轮之后的情况：第 1 条通过（5.1 解析 0 个错误，安装、升级、拒绝三条路都跑通）；第 2 条当场出了问题并已修好（`icacls /save` 写的是不带 BOM 的 UTF-16）；第 3 条除了"真的登录一次"都验证了（普通权限建得了任务，后台进程不会被连带结束，没有窗口）；第 4 条验证了一半（两种钩子按各自的调用方式手工触发都能跑；Codex 对没信任的钩子是静悄悄跳过）；第 5 条还没验证。剩下的就是上面那两件。

1. **第 3 步，`install.ps1` 本身**：它从没被 PowerShell 解析或执行过（写它的机器上没有 PowerShell）。语法错误、5.1 不支持的写法都只会在这里暴露。
2. **第 3 步里的 `cannot make … private`**：收紧数据目录权限用的 `icacls` 参数和读回格式是按微软文档推的；对不上的话 Morse 会**拒绝写私钥**，安装停在 `morse setup` 或拿地址那一步。这是故意的（宁可装不上），报错里带着原始输出。
3. **第 4、7、18 步，登录启动**：普通权限能不能建"本人登录时"的计划任务（不能时会自动退到注册表的 Run 值）；计划任务起的那个进程退出后，它放到后台的守护进程会不会被一起结束；登录时黑窗口闪多久。
4. **第 14、16 步，钩子**：Claude Code 认不认 `command` + `args` 这种写法（太旧的版本不认）；Codex 经 `cmd.exe` 能不能跑 `morse-hook.cmd`，信任之后升级要不要重新信任。钩子不运行不会报错，只能从 `morse status --check` 的 `last ran` 看出来。
5. **第 17 步，Codex 的沙箱**：沙箱里的 agent 能不能运行 `morse.cmd`、读写 `%USERPROFILE%\.morse`、连 `127.0.0.1:7433`；它的"用户目录"是不是你的用户目录（不是的话它会看到另一个空的 Morse）。
