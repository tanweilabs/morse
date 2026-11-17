# 调研：消息怎么送进一个正开着的会话（2026-10）

> 创建：2026-10-13 · 最后更新：2026-11-17（按结论重写；据此定的是 ADR-027 门铃）

## 起因

当时 daemon 日志里有 251 次投递失败，没有一次出在设备之间，全在最后一步：把消息塞进对方的会话（Codex 写锁冲突、活会话假失败、CLI 版本错位、登录过期、超时）。ADR-023/026 之后活会话不再硬塞，但信要等用户下次开口才进去。所以要找的是「门铃」：让正在运行的 App 自己把信收进去，而不是从外面 headless 续接。

## Claude Code：官方跨会话收件箱——能用

- 依据：官方文档 cross-session-messaging；线协议细节来自社区项目 agents-can-communicate（ACC）的抓包（issue #130），不是官方文档。
- v2.1.224 起（macOS / Linux）默认开启。每个会话（包括桌面 App 的）在 `~/.claude/sessions/<pid>.json` 登记，字段有 `sessionId`、`cwd`、`messagingSocketPath`、`status`、`entrypoint`、`version` 等。同目录的 `*.key` 是会话自己的令牌，**不读、不转发**。
- 语义：空闲会话收到消息直接起一轮；忙的会话在两次工具调用之间读，不打断工具。
- 写法（社区实测）：连上 socket，写一行 JSON：`type: "user"`、`message: {role, content}`、`msg_id`、`priority`（`now` / `next` / `later`）。
- 权限：接收方知道这是「另一个会话」发的，不是用户；外来消息不能批准权限、不能改配置。**接收方是 Bypass 模式时外来消息会被扣下**，桌面 App 弹不出确认框，过期就丢——要机主自己设 `crossSessionInbound: "accept"`。不能伪造 `from-mode` 去绕过这道闸。
- 用法：daemon 按会话 id 找到 socket，只写一条「有新信」的唤醒帧；会话醒来后由已有的 `UserPromptSubmit` pull hook 注入正文。注册表里的 `version` 还能给版本检查（ADR-025）用。
- Claude Channels 不合适：自定义 channel 要用 `--dangerously-load-development-channels` 启动（Morse 不碰 `--dangerously-*`），而且只对带参数启动的交互会话有效，桌面会话用不上。ACC 也因此放弃了这条路。

## Codex 桌面版：写锁是公认的难题

- 0.147 起一个线程只能有一个写者，锁在 `~/.codex/thread-writer-locks/<thread>.lock`。桌面版打开过的线程一直持锁，彻底退出才放（openai/codex#37450，当时仍有新报告）。
- 往 `app-server-control.sock` 发 JSON-RPC 的绕路，前提是桌面版用的是那个共享服务；本机上那个 socket 是失效链接，桌面版跑的是自己的私有服务，走不通。
- 新命令 `codex queue --thread <id> --message <text>`（PR #39092，走 `thread/queue/add`）能往线程排队；它和桌面版写锁的关系文档没说，值得在专门新建的测试线程上做受控实验。（实验后来成立：桌面版持锁的线程 4 秒内消费排队消息，见 ADR-027。）

## 社区同类项目（2026-10-13）

ACC（最成熟，Claude 用收件箱 + hook，Codex 下一轮收到）、agent-talk（hook；Codex 唤醒要用它的启动器，桌面版不行）、coder/agentapi（虚拟终端抓屏，只管它自己启动的界面）、openmsg 和 agent-bridge（Claude 收件箱、Codex `codex queue`）。共同点：几乎都只做本机；在 Claude 上收敛到同一个官方收件箱，在 Codex 桌面版上都卡在写锁。部分细节只看了 README 和 issue，没有逐行读源码。

## 结论

1. Claude 门铃：按会话找 socket 写唤醒帧，失败就退回原样（pending + pull hook）；`doctor` 提示 `crossSessionInbound`。
2. Codex：在测试线程上验证 `codex queue`，成立就用它投桌面版开着的线程。
3. 跟踪 openai/codex#37450；Channels 开放自定义之前不碰。
4. 官方把跨会话消息定位为「不能批准、不能改配置」，和 ADR-016「信任队友」的口径要对齐：注入的正文要说明来源，不冒充用户。
