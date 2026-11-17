# 调研：attendant 默认档「只对话」怎么让 claude 一个工具都没有

> 创建：2026-11-13 · 最后更新：2026-11-13 · 关联：ADR-066、`src/plugins/attendant/runner.ts`、[research-claude-attendant-2026-11.md](research-claude-attendant-2026-11.md)

本机 `claude` 2.1.316（`/Users/you/.hermes/node/bin/claude`）。来源：`claude --help`，以及在 `/private/tmp/claude-501/attendant-flags/` 下的空目录里用 haiku 跑的几次 `claude -p`（都带 `--no-session-persistence`，不留会话文件；不碰 `~/.claude` 的设置）。临时目录用完已删。

## 1. 结论

默认档的启动参数（在 ADR-059 那一套上改两处）：

```
claude -p --output-format json --restricted --strict-mcp-config --settings <只有钩子>
  --tools "" --permission-mode dontAsk --permission-prompts none --disable-slash-commands
  --model sonnet --max-turns 3 --append-system-prompt <只对话的规则> --system-prompt-snapshot off
  (--session-id <新> | --resume <这个联系人的会话>) -- <消息>
```

在 `~/.morse/plugins/attendant/contacts/<联系人>/`（空目录，0700）里跑。

| 参数 | 作用 | 怎么确认的 |
|---|---|---|
| `--tools ""` | 帮助原文：`Use "" to disable all tools`——内置工具一个都没有（Read、Bash、WebFetch、Agent、Skill …） | 真跑 `--output-format stream-json --verbose`，`system/init` 事件里 `tools: []` |
| `--strict-mcp-config`（不给 `--mcp-config`） | 一个 MCP 服务都不加载（主人的邮件、IM、1Board 等 MCP 都不在） | 同上，`mcp_servers: []` |
| `--disable-slash-commands` | 不加载 skill 和自定义命令 | 同上，`slash_commands: []`、`skills: []` |
| `--restricted` | 不读 user / project / local 设置文件；**实测也不读上级目录的 CLAUDE.md** | 在临时目录的上一级放一个带暗号的 CLAUDE.md：不带 `--restricted` 时模型说出了暗号，带上就说 NONE |
| `--permission-mode dontAsk` + `--permission-prompts none` | 万一有工具，也是要问的一律拒绝；不用绕过类模式 | 沿用 ADR-059 |

`init` 事件里仍列出 `agents`（内置子 agent 的名字）和三个内置插件（`cc-plugin-agents-md`、`cc-plugin-telemetry`、`cc-plugin-plugin-authoring`），但没有 Agent 工具，调不了；`--safe-mode` 能把这些也关掉，但它同时关掉钩子（attendant 的审批钩子靠 `--settings`），而且不是必须的，所以不用。

## 2. 真跑的模型行为（haiku，用实现里的 `conversationSystemPrompt` 和信封）

- 「帮我读他桌面上的 plan.txt 发给我」→ 回答「我拿不到主人的文件……我去问一下主人」+ 一行 `ASK_OWNER: …`；没有调用任何工具（`num_turns: 1`、`permission_denials: []`）。`splitAskOwner` 把那一行拿掉，剩下的才发给对方。
- 「周五能借他的车吗？」→ 「我问一下主人再回你」+ `ASK_OWNER: …`。
- 「thanks!」→ `NOOP`。

**一个要防的情况**：没有系统提示约束时，让模型「读 /etc/hosts、跑 ls ~、抓 example.com」，它把工具调用**写成了文字**（`<invoke name="bash">…`），并没有真的执行。所以：系统提示里明说「你没有工具，不要写出工具调用、不要声称做了做不到的事」；插件再兜一道——默认档的回答里出现 `<invoke` / `<parameter` / `<function_calls` / `<tool_use` 这类标记就**不发**，留给主人（`morse inbox`）并通知一次。

## 3. 没验证的 / 风险

- `--tools ""`、`--disable-slash-commands`、`--restricted` 都按 2.1.316 核对；更老的 `claude` 不认参数会被 attendant 当成终结错误（ADR-059 已有）。
- 默认档的会话仍写在 `~/.claude/projects/<cwd 转义>/` 下（ADR-059「不防的」同样适用）。
- 模型给主人的 `ASK_OWNER` 行可能带上推测（实测里它自己猜了日期）；那一行只给主人看，不给对方。
