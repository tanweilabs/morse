# Kimi Code 投递通道

> 创建：2026-08-10 · 最后更新：2026-11-17（按现状重写）
> 代码：`src/adapters/kimi.ts`。最初在 kimi 0.32.0 上实测；Kimi 的门铃调研见 [research-doorbell-kimi-zcode-opencode.md](../research/research-doorbell-kimi-zcode-opencode.md)。

## 找会话

- 读 `~/.kimi-code/session_index.jsonl`，一行一条。实测只有三个字段：`sessionId`（形如 `session_<uuid>`，可以直接拿去续接）、`sessionDir`、`workDir`。没有标题，也没有时间。
- 所以：目录 = `workDir`；标题 = 目录名（最长 80 字，没有就 `untitled`）；最近活跃 = `sessionDir` 的修改时间（目录不在了就算 0）。
- 同一个 id 出现多次，以后面的为准；按最近活跃排序。坏行跳过；文件不存在（没装 Kimi）就当没有会话。
- Kimi 的子代理记录放在会话目录里面，不进索引，不用额外过滤。

## 投递

- 找 `kimi` 的顺序：环境变量 `MORSE_KIMI_BIN`（旧名 `ANYTOANY_KIMI_BIN` 仍认）→ PATH 里的 `kimi` → `~/.kimi-code/bin/kimi`。都没有就报「kimi not found」。
- 命令：`kimi -S <sessionId> -p <信封> --output-format stream-json`，在会话的目录里跑，最长 5 分钟。退出码非 0 就失败，错误里带 stderr 的最后 500 字。
- 不加任何提权旗标：`-p` 默认就会执行工具；而且 `-p` 和 `-y` / `--yolo` / `--auto` / `--plan` 一起用 CLI 会直接报错，所以机主提权这件事在 Kimi 上不存在。

## 取回信

`stream-json` 每行一个 JSON。一个用了工具的回合大致是：一条内容为空的 assistant（准备调工具）、一条 `tool`（工具结果）、一条带回信标记的 assistant、最后一条 `meta`（「To resume…」提示）。只把内容非空的 `assistant` 行拼起来当回答，工具结果和 `meta` 提示都不要，否则会混进回信里。不用纯文本输出，因为它每行带 `• ` 前缀。

## 没做的

Kimi 有和 Claude 同类的 `UserPromptSubmit` hook，`kimi web` 还有 REST/WS 接口（发消息、追加、审批），都可以做「会话开着时直接送到」。目前没做，见上面的门铃调研。
