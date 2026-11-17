# 调研：Kimi、ZCode、OpenCode 的门铃

> 创建：2026-10-13 · 最后更新：2026-11-17（按结论重写；ZCode 门铃已落地，见 ADR-029）
> 接 ADR-027：Claude（收件箱 socket）和 Codex（`codex queue`）已有门铃，这里看剩下三家。方法：本机实测（Kimi 0.41.0、ZCode App 3.11.2 / CLI 0.16.5）、ZCode 开源仓库源码、官方文档和 issue；OpenCode 本机没装，只看了文档。

## 结论一览

| | 会话开着时能马上送到吗 | 入口 | 能叫醒空闲会话吗 | 依据 |
|---|---|---|---|---|
| ZCode | 能：回合中、回合结束、下次开口 | 原生会话信箱，往 `~/.zcode/mailbox/<会话>/unread/` 放 JSON；要 `ZCODE_MESSAGE_ENABLED=1` | 不能 | 本机 CLI 实测，有对照组；桌面版未测 |
| OpenCode | 能，架构上就支持 | 终端界面本身是本地服务的客户端：`POST /session/:id/prompt_async` | 能 | 官方文档，未实测 |
| Kimi 终端界面 | 不能 | 没有入口（官方 issue #4112 提的就是这个，未回应） | — | issue |
| Kimi 网页界面（`kimi web`） | 能 | `POST /api/v1/sessions/{id}/prompts`，回合中可 `prompts:steer` | 能 | 本机 0.41.0 的 OpenAPI |

## ZCode：未公开的会话信箱

- 出处：开源仓库 `zai-org/ZCode` 的 `apps/zcode-cli/packages/core/src/hooks/session-mailbox.ts` 等，和本机 `glm/zcode.cjs`。
- 开关 `ZCODE_MESSAGE_ENABLED`（`1` 或 `true`），默认关。位置 `ZCODE_MAILBOX_ROOT`，默认 `~/.zcode/mailbox`，每个会话有 `unread/` 和 `read/`，按文件名排序，一次最多领 20 封。
- 信件严格校验：`{version: 1, messageId, fromSessionId, toSessionId, content, createdAt}`，都是字符串。
- 领取时点：`UserPromptSubmit`（作为附加上下文）、`PostToolUse`（插进进行中的回合）、`Stop`（注入后 `continue: true`，带着信接着干）。停在输入框的空闲会话不会被叫醒。
- 实测（一次性测试会话）：放一封要求回复里带口令的信，带开关续接后回复带出口令、信从 `unread/` 移到 `read/`；不带开关重来，口令不出现、信留在 `unread/`。
- 桌面版以子进程跑同一个运行时（`glm/zcode.cjs app-server --stdio`），按源码推断启动环境里带开关就会读信箱，没实测。桌面版内部还有自家「会话发信给会话」的管道和给手机通道用的任务队列，外部暂时接不进。
- 风险：未公开功能，版本间可能变；接入时校验格式，写失败就退回 `--resume`。

## OpenCode：终端界面就是服务的客户端

- 运行 `opencode` 同时起服务和终端界面，界面是服务的客户端。服务默认随机端口（`--port` 可固定），也可以 `opencode serve`（默认 `127.0.0.1:4096`）再 `opencode attach`。
- 投递 `POST /session/:id/prompt_async`（异步，204）或 `POST /session/:id/message`（同步，能直接拿回信）；`/tui/append-prompt` + `/tui/submit-prompt` 相当于替用户打字回车；`GET /event` 是 SSE。设了 `OPENCODE_SERVER_PASSWORD` 才有 HTTP Basic 认证。
- 难点是找端口：用 `lsof` 找监听端口再 `GET /global/health` 确认，或请用户固定端口，或 `serve --mdns`。
- Morse 目前没有 OpenCode 适配器。

## Kimi

- 终端界面：运行时在进程里，外部进不去。issue #4112 提议 `kimi queue --session … --message …`（和 `codex queue` 同构），没有回应；0.41.0 的 `kimi session` 只有 `list`。
- 网页界面：OpenAPI 有 `prompts`、`prompts:steer`、`status`、`approvals`、`questions`；实例登记在 `~/.kimi-code/server/instances/<id>.json`（`host`、`port`、`pid`、`heartbeat_at`），令牌在 `~/.kimi-code/server.token`（0600）。用户在网页界面里工作时，可以「找到实例、带令牌 POST」。
- 兜底：Kimi 有和 Claude 同类的 `UserPromptSubmit` hook，Morse 没有给 Kimi 装收件 hook，只靠 skill 里手动拉取。

## 建议（按收益排）

1. ZCode 信箱门铃：会话开着时写信箱，失败退回 `--resume`；`doctor` 提示开关；桌面版要机主配合验证一次。（已做，ADR-029。）
2. OpenCode 适配器：发现 + `prompt_async` / `message` + 找端口；先装上再实测。
3. Kimi：先装 `UserPromptSubmit` 收件 hook，做到下次开口就收到；网页界面可以接；终端界面等官方。

调研时 `kimi web` 的启动日志把本机服务令牌打进了工具输出（只能本机访问），稳妥起见可以 `kimi web rotate-token` 换掉。
