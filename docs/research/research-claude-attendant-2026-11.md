# 调研：attendant 插件用到的 Claude Code / Codex 启动参数和 PreToolUse 钩子

> 创建：2026-11-13 · 最后更新：2026-11-13 · 关联：ADR-059、ADR-060、`src/plugins/attendant/runner.ts`

本机版本：`claude` 2.1.316、`codex-cli` 0.153.4。来源：`claude --help`、`codex exec --help` / `codex exec resume --help`、claude 可执行文件里的字符串（钩子输出字段、隐藏参数），以及在临时目录（不在任何项目、不碰 `~/.claude` 设置）里用 haiku 跑的几次真实 `claude -p`。

## 1. 结论（attendant 依赖的每一条）

| 项 | 结论 | 怎么确认的 |
|---|---|---|
| `--settings <file>` 里的 `hooks.PreToolUse` 在 `-p` 模式生效 | 是 | 真跑：钩子收到调用、写下了输入 |
| `--restricted` 下 `--settings` 的钩子仍生效 | 是 | 同上（`--restricted` 只忽略 user / project / local 设置文件，`--settings` 和托管设置照常） |
| 钩子 stdin | JSON：`session_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name: "PreToolUse"`、`tool_name`、`tool_input`、`tool_use_id`（还有 `prompt_id`、`effort` 等） | 真跑时钩子写下的输入 |
| 钩子拒绝 | stdout 输出 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`，退出码 0；理由原样回给模型（"PreToolUse:Write hook error: …"） | 真跑；字段名和取值（allow / deny / ask）也见于可执行文件 |
| 钩子允许能越过 `dontAsk` | 能：`--permission-mode dontAsk`、`allowedTools` 里没有 Write，钩子回 `allow`，文件写成了 | 真跑 |
| 钩子允许**不能**越过 `--restricted` 的目录限制 | 对：钩子回 `allow`，写工作目录外的文件仍被拒（"--restricted confines the file tools to the working directory"），钩子确实被调用了 | 真跑 |
| `--restricted` + `dontAsk`、没有钩子 | 工作目录内的 Write 被拒（"running in don't ask mode"）；读工作目录外的文件被拒 | 真跑 |
| `--output-format json` | 一行 JSON：`result`（最后回答）、`session_id`、`is_error`、`subtype`（`success` / `error_max_turns` …）、`num_turns`、`permission_denials: [{tool_name, tool_use_id, tool_input}]` | 真跑 |
| `--max-turns <n>` | 有，帮助里不显示（"only works with --print"） | 可执行文件里的参数说明 |
| `--permission-prompts none` | 有：「本来要问的一律拒绝；其余仍由权限模式决定」 | `claude --help` |
| `--permission-mode` 可选值 | `acceptEdits`、`auto`、`bypassPermissions`、`manual`、`dontAsk`、`plan` | `claude --help`。attendant 沿用 dispatch 的白名单（`default`、`acceptEdits`、`plan`、`dontAsk`），`auto` 和任何 bypass 都不收 |
| `--tools` | 指定可用的内置工具；`--restricted` 下 Bash、WebFetch 只有在 `--tools` 点名时才有 | `claude --help` |
| `--strict-mcp-config` | 不给 `--mcp-config` 就一个 MCP 服务都不加载（不会带上主人的邮件、IM 等 MCP） | `claude --help` |
| `--system-prompt-snapshot off` | 追加的系统提示每次都按当前文本发（续接的会话也看到更新后的规则） | `claude --help`（ADR-054 已用） |
| 不存在的会话 `--resume <id>` | 输出 "No conversation found with session ID"（ADR-056 已确认） | 沿用 |
| `-p` 模式下设置文件校验失败会被**静默忽略** | 是（帮助原文） | `claude --help`。所以每轮生成的设置文件只放钩子，不放 `permissions` 规则——写错一条规则会让钩子一起失效 |
| 端到端 | 真 `claude` + `dist/` 里的钩子命令：拒绝 → 写下审批请求 → 同一会话 `--resume` + 授权一次 → 命令执行，输出原样 | 真跑（`runTurn` + `hookCommandFor`） |

## 2. Codex

- `codex exec` 的选项要放在 `resume` 子命令**之前**（ADR 早已记录：`--sandbox` 放后面会报 "unexpected argument"）。
- 用到的：`--json`（JSONL 事件，`thread.started` 带 `thread_id`，`item.completed` 的 `agent_message` 带文字）、`-o / --output-last-message <file>`、`-s / --sandbox read-only|workspace-write`、`--skip-git-repo-check`、`--ignore-user-config`（不读 `$CODEX_HOME/config.toml`，登录仍用 `CODEX_HOME`——不带上主人的 MCP 服务）、`--ignore-rules`、`-C <dir>`、`-c approval_policy="never"`、`-m`。
- **没有**按工具的白名单，也没有可靠的逐次调用审批钩子；`read-only` 沙箱仍能读整块盘（包括 `~/.ssh`）。所以 Codex 只在 `allowUnscopedReads: true` 时才允许用于联系人，审批靠模型在回答里写 `NEEDS_APPROVAL: <动作>`，副作用本身靠沙箱挡。
- 本次没有真跑 Codex（参数只按帮助核对），列为后续。

## 3. 没验证的 / 风险

- 钩子超时（设置里 30 秒）：Claude 把超时当作非阻断错误时调用会继续。钩子命令是 `<plugin> hook pretool … || exit 2`：插件进程崩溃时退出码 2（阻断）；插件自己出错时回 deny。真正的硬边界仍是 `--restricted` + `--tools` + `allowedTools` + 权限模式，钩子只是把「拒绝」变成「审批请求」。
- `--permission-prompts`、`--restricted` 是较新的参数；更老的 `claude` 会报未知参数，attendant 把这当作终结错误并在日志里说明（不重试）。
- Claude 的会话文件写在 `~/.claude/projects/<cwd 转义>/` 下，和主人自己的会话在同一个目录树；attendant 的会话因此会出现在会话列表里（见 ADR-059「不防的」）。
