# daemon 常驻：开机就在，死了自己起来

> 创建：2026-08-12 · 最后更新：2026-11-17（按现状重写）
> 相关决策：ADR-035（服务名）、ADR-080（Windows）、ADR-089（停服务要等 agent 的回合）

## 为什么

投递全靠 daemon。2026-08 出过一次事故：daemon 是从某个 shell 里手动起的，shell 一没它就没了，`send` 只能回「已排队，daemon 离线」，消息一直滞留，看起来像「连本机都发不通」。所以 daemon 必须交给系统的服务管理器托管。

## 现在怎么做

安装脚本 `site/install.sh`（`morse.im/install.sh`）装完就把 daemon 注册成服务：

| 系统 | 服务 | 要点 |
|---|---|---|
| macOS | LaunchAgent `~/Library/LaunchAgents/talk.morse.daemon.plist` | `RunAtLoad`、`KeepAlive`、`ThrottleInterval=10`（崩了 10 秒后再起，防止刷屏式重启）、`ExitTimeOut=30` |
| Linux | systemd 用户服务 `morse.service` | `KillMode=mixed`，停服务时不连带杀掉正在跑的 agent 回合 |
| Windows | 登录时运行的计划任务，`morse start --background` | 见 [Windows 规格](windows-native.zh-CN.md) |

共同的几点：

- **用绝对路径启动**：服务管理器没有用户的 shell，命令里写 node 和 `dist/cli.js` 的绝对路径。
- **PATH 要带上各家 CLI 所在的目录**：daemon 投递时要拉起 `claude`、`codex`、`kimi` 等，服务默认的 PATH 很短，缺了就是「command not found」。安装时按 `command -v` 实际找到的位置写进去。
- **日志**：`~/.morse/daemon.log`。
- 旧版装的服务定义缺 `ExitTimeOut` / `KillMode=mixed` 时，daemon 启动时只把缺的几行补上（`src/update/service-file.ts`），不重载服务。

不走安装脚本的机器（从源码装）可以用 `scripts/install-daemon-launchd.sh` 写同样的 LaunchAgent，可重复执行；它会顺手卸掉旧名字 `dev.anytoany.daemon` 的服务。

## 注意

- 服务托管后，结束进程（包括 `morse stop`）它会被重新拉起来；这正是想要的。重启用 `morse stop --restart`（等手上的消息处理完再交给服务管理器重启）。要真的停，在 macOS 上 `launchctl unload ~/Library/LaunchAgents/talk.morse.daemon.plist`，Linux 上 `systemctl --user stop morse.service`。
- 验收看三件事：服务已注册、`kill -9` 后十几秒内出现新的进程、滞留的消息在 daemon 回来后被投出去。
