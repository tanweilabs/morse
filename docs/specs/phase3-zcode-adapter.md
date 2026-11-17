# ZCode 投递通道

> 创建：2026-08-06 · 最后更新：2026-11-17（按现状重写，并入原调研里还用得上的事实）
> 代码：`src/adapters/zcode.ts`、`src/adapters/zcode-mailbox.ts`。相关决策：ADR-029（ZCode 门铃）。

ZCode 是智谱（Z.ai）的桌面 ADE，不是 Zed 编辑器。桌面版内置完整的 CLI 引擎，桌面版和 CLI 共用一份会话库，所以从外面续接的回合在桌面版里直接看得见。

## 找会话

- 只读方式打开 `~/.zcode/cli/db/db.sqlite`（桌面版一直在用 WAL 写它），`SELECT * FROM session`，查完就关。路径写死：实测 `ZCODE_DATA_BASE_DIR` 只挪凭据，不挪这个库。
- 去掉子代理会话：id 以 `sess_subagent` 开头、`parent_id` 不为空、或 `task_type = 'subagent_child'`。子会话不接受直接输入。
- 字段在 JS 里宽松地取，防止版本之间列名变化让整条查询失败：id 原样（带 `sess_` 前缀，可直接续接）；标题 = `title`，没有就用目录名，再没有就 `untitled`（最长 80 字）；目录 = `directory`；最近活跃 = `time_updated`（毫秒）。
- 库打不开或没有这张表：当作没装 ZCode，返回空。

## 投递

找引擎的顺序：`MORSE_ZCODE_BIN`（旧名 `ANYTOANY_ZCODE_BIN` 仍认）→ PATH 里的 `zcode` → `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（`.cjs` 用 `node` 跑）。

**会话空闲时**：起一个 headless 回合续接：

```
[--cwd <目录>] --resume <sessionId> --mode <模式> --prompt <信封>
```

- 模式默认 `build`。`--prompt` 不写模式时默认是 yolo（所有确认都跳过），所以一定显式传。`build` 下需要确认的工具在无人值守的回合里会被拒，等于只读。
- 机主可以在本机 `~/.morse/config.json` 里放开：`{"zcode": {"deliverMode": "yolo"}}`（只认 `plan` / `edit` / `build` / `yolo`，别的值回到 `build`）；单回合时限 `zcode.deliverTimeoutSec`（60–3600 秒，默认 300）。每次投递现读配置，改了不用重启。发信的一方永远指定不了模式。
- 不加 `--max-turns`（0.15.2 的解析器不认），也不用 `--json`（JSON 转义会破坏回信标记后面的正文）；回信从 stdout 里按标记取。退出码非 0 就失败，错误带 stderr 最后 500 字。

**会话正在跑回合时（门铃，ADR-029）**：再起一个回合等于两个写者同时写一个会话，所以改走 ZCode 自己的会话信箱（未公开功能）：

- 开关是环境变量 `ZCODE_MESSAGE_ENABLED=1`；信箱在 `ZCODE_MAILBOX_ROOT`，默认 `~/.zcode/mailbox/<会话>/{unread,read}/`。信件格式 `{version:1, messageId, fromSessionId, toSessionId, content, createdAt}`。ZCode 在 `UserPromptSubmit`、`PostToolUse`（插进当前回合）和 `Stop`（带着信继续）三个时点领信，空闲会话不会被叫醒。
- 判断「正在跑」：最新一条消息是还没有 `time.completed` 的助手消息（30 分钟内），或者是 60 秒内刚写的用户消息。
- 判断「开关开着」：读不了进程环境（ZCode 改了进程名，把那块内存覆盖了），改看痕迹：开着开关的运行时每个回合开头都会建好该会话的 `unread/` 目录。
- 两个条件都满足 → 先写临时文件再 `rename` 进 `unread/`，信封改成让对方用 `morse reply` 回信；每秒看一次，文件没了就是送达（记为会话内送达）。回合结束信还在 → 再用 `rename` 原子收回，照旧续接。收回和领取只会有一个成功，不丢也不重。路由结论缓存 5 秒，保证回信方式和投递方式一致。
- 不写 ZCode 内部的 `session_input` 表。`morse doctor` 报告信箱开关的状态和打开方法（`launchctl setenv ZCODE_MESSAGE_ENABLED 1` 后重开 ZCode）；Morse 不替机主改。

## 还没确认的

桌面版门铃：桌面版以子进程跑同一个引擎（`glm/zcode.cjs app-server --stdio`），按源码应当继承开关，还要在开着开关的桌面版里实际跑一个回合确认。
