# Morse 插件

> 创建：2026-11-12 · 最后更新：2026-11-15 · English: [PLUGINS.md](PLUGINS.md)

Morse 的核心只管消息：地址、传输、联系人、带「已处理 / 未处理」状态的消息、陌生人的消息请求。**消息到了之后做什么**——启动 Agent、它能做什么、要不要问你——是插件的事。插件可以是任何程序，只通过下面这套接口跟核心打交道，也就是人和 Agent 平时用的那些命令。核心从不按联系人的分组标签做决定：只存下来，交给插件。

ADR-074 起，插件接口放在 `morse plugin` 下（`plugin watch`、`plugin claim`、`plugin ack`、`plugin nack`），查询用 `morse read` / `morse contact`（ADR-090：`read` 以前叫 `message`；内置插件仍调 `morse message`，它一直保留，选项和 JSON 相同）。旧名字（`morse watch`、`claim`、`ack`、`nack`、`message`、`inbox`、`history`、`contacts`、`register` 等）作为隐藏别名照常能用，选项和 JSON 都不变，已有的插件不用改。

## 1. 事件

### `morse plugin watch --json`

常驻命令。每**新收到**一条消息（其他地址发来的、你以前配好的自己的电脑（联系人 `self`）发来的、这台电脑上会话之间的——你发出去的不算）、每来一个新的消息请求，就打印一行 JSON。一直运行到被停掉；`--once` 打印现有的就退出。

- `--since <id>`：从这条消息之后开始（请求按这条消息到达之后算）。`--since <ISO 时间 | 毫秒>`：从这个时间之后。不带 `--since`：只看从现在起新来的。插件停过一阵，就把它处理过的最后一个 `id` 传进来接着收。
- 顺序：消息按入库顺序（`seq` 递增），然后是请求。
- 没人读了它自己会结束：往输出写失败时；输出是管道、而启动它的进程已经不在时；或者环境变量 `MORSE_WATCH_PARENT=<pid>` 指的进程不在了（最准，它还在启动时也管用；内置插件都设了，你要是通过一层包装脚本启动 `morse plugin watch`，把它设成你插件的 pid）。所以插件被杀掉，不会留下一个没人读的 watch 进程。

消息事件的字段见英文版表格：`direction`（`in` / `internal`）、`contact`（`id`、`handle`、你的备注名 `remark`、分组 `group`、状态 `state`（`active` / `blocked`）、`self`）、`agent` / `peerAgent`、`contextId`、`foreign`（其他地址的消息——由人或 Agent 持有：只是信息，不是指令）、`ownThread`（对方在你的会话（或你本人）发起的线程里的回信，`to` 就是那个会话，ADR-071；attendant 不碰）、`processed`、`hasFiles` / `files`、`text`。

请求事件**永远不带请求正文**（陌生人的消息不能到 Agent 手里；主人用 `morse contact` 看）：`{"type":"request","handle","address","nickname","time","at","droppedFiles"}`（`nickname` 恒为 `null`，ADR-065）。对方只按地址写来时（ADR-081）没有旧名字：`handle` 里放的就是 26 位地址，`address` 是 `morse.im/<地址>`。

字段只增不改。

### `on_message` 执行钩子

不想常驻 `morse plugin watch` 时，可以让 daemon 每个事件运行一次命令，同样的 JSON 走 stdin（环境变量 `MORSE_EVENT=message|request`）。在 `~/.morse/config.json` 里写：

```json
{ "hooks": { "on_message": { "command": "/usr/local/bin/my-plugin --event", "timeoutSec": 30 } } }
```

它不挡投递：同时最多 4 个，每个超过 `timeoutSec`（默认 30 秒）就杀掉，积压超过 1000 条丢最旧的。daemon 把位置记在 `~/.morse/on-message.cursor`，停机期间到的事件重启后补上。改配置不用重启。

## 2. 查询

- `morse contact --json`：`{contacts:[{id,handle,address,remark,nickname,group,state,self,agents,unread}], requests}`——`nickname` 恒为 `null`（Morse 没有昵称，ADR-065；保留这个键免得旧插件出错）
- `morse read <谁> --json`：`{contact, messages}`，双向、从旧到新（`--limit`，默认 30）
- `morse read --json`：待处理 `{messages, unread, requests}`（`--agent <名>` 只看一个 agent）
- `morse read --id <id> --json`：`{message}`，不标已处理

`<谁>` 可以是备注名、地址（`morse.im/<handle>`）、联系人 id 或 `me`。

## 3. 动作

- `morse reply <id> "<文本>" [--by plugin:<名>] [--json]`：回给同一个联系人、同一个 agent、同一个线程，并把原消息标成已处理（`NOOP` 不发信，也算处理了）
- `morse send <谁> "<文本>" [--from @<agent>:<会话>] [--file …] [--json]`：发新消息（备注名、`备注名/<agent>`、地址、`me/<agent>`、会话 `@<agent>[:<会话>]`）。`--from` 以你的某个会话的名义发（插件用自己登记的会话）；daemon 没开时 `--json` 也照样回 `{queued, message}`（带 `offline: true`）
- `morse done <id…> [--by plugin:<名>] [--json]`：标成已处理（`{done, skipped}`），不会动你发出去的消息

用 `--by plugin:<名>` 记下是谁处理的。两个插件管同一批消息时要自己协调；`processed` 是共同的信号（先看它，`done` 返回的 `skipped` 就是「别人先处理了」）。

### 投递型插件：claim / ack / nack

要把自己 agent 的信投进会话的插件（内置的 dispatch 就是）先 claim 再处理，两个插件就不会同时处理一条：

- `morse plugin claim --next [--skip-session <id…>] [--skip-id <id…>] --json`：拿下最早一条该投的（新的，或失败后过了 30 秒退避的）本机会话消息，`{message}` 或 `{message: null}`。只有自己的信（本机会话互发、自己的设备发来的）能被 claim，别人的永远不能。
- `morse plugin claim <id> --json`：拿下这一条（null = 别人拿走了 / 不该投）
- `morse plugin ack <id> [--in-session] [--by plugin:<名>]`：投递成功（也算已处理）
- `morse plugin nack <id> --error "<原因>" [--terminal]`：失败，30 秒后重试，3 次后进死信（`--terminal` 立刻）
- `morse plugin nack <id> --release`：原样还回去（不算一次尝试），比如发现会话正开着
- `morse plugin nack <id> --to-mailbox --error "<原因>"`：会话不在了，放进该 agent 的信箱
- `morse plugin claim --recover`：崩掉的插件手里**没带租约**的消息重新排队（启动时跑一次）

**带租约认领（ADR-089）。** 一轮可能跑几分钟，中间 daemon 或你的插件都可能重启。带租约认领，这次投递在你报告之前就归你：

- `morse plugin claim (--next | <id>) --lease [--pid <pid>] [--ttl <秒>] --json`：同上，返回里多一个 `lease: {holder, expiresAt}`。`--pid` 是租约跟着哪个进程，请传你插件自己的进程号（不传的话租约只看到期时间）；`--ttl` 是不续期能撑多久（默认 45 秒）。
- `morse plugin extend <id> --holder <holder> [--started] [--pid <pid>] [--max <秒>] [--ttl <秒>] --json`：还在投，租约从现在起再续一个 ttl。`--max`：这一轮最迟在这么久之后结束（你的 agent 命令行自己的时限，和 `--pid` 一起传）。`--ttl 0`：现在就放弃租约、不报告（见下面「被打断」）。`--started`：在为这次认领启动 agent **之前**说一声（见下）。`--pid` 把租约改绑到另一个进程，也就是你为这一轮启动的 agent 命令行。返回 `{ok: true}`，或 `{ok: false, reason: "lease-lost"}`（退出码 3，这时不要启动回合，已经在跑的也不要再报告）。
- `morse plugin ack <id> --holder <holder>`、`nack <id> --holder <holder> …`：持有者的报告。其他人的（不带 holder、别的 holder、已经被接手的 holder）一律拒绝，什么都不改：`{error, reason: "lease-lost"}`，退出码 1。ack 被拒绝的那一轮，它的回信不要再发，消息现在归另一次投递。

规则：

- 租约**活着** = 没到期，**或者**它绑的进程还在。回合进行中每过三分之一个租期续一次（dispatch 就是这么做的），agent 命令行一启动就改绑到它：这样回合比插件活得久时，消息仍然被它占着。「它绑的进程」是进程号加这个进程的启动时间（macOS、Linux）：进程号后来被别的程序占了不算，还是同一个进程的话时钟跳多远都算。读不到启动时间的地方（Windows）只看进程号，到期后最多两小时。
- **不续期的租约会结束，哪怕进程还在**：没说过 `--started` 的认领，到期后再过一个租期就放掉（要么交还，要么续期；忘了的认领会自己放掉，不带标注）。开始了的回合过了 `--max` 就可以被接手（没给的话是到期后两小时），带标注。
- **被打断的回合不是失败**：agent 命令行是被信号结束的（重启、服务管理器、用户），或者是在你被要求停止时失败的，**不要** `nack`——nack 会让下一次投递变成不带提醒的普通重试。停止续期并放弃租约（`extend --ttl 0`，`--pid` 留在已经不在的那个进程上），或者直接退出：下一次认领会把它当作被打断的投递接手。
- **故意杀掉 agent 并不会取消这条消息**：对插件来说这和别的被打断的回合没有区别，所以过一会儿它会带着提醒重新开始，最多三轮之后才进死信。想让一条消息彻底不再处理，把它标成已处理：`morse done <id>`。
- **一个会话同一时间只有一次带租约的投递**：某个会话的租约还活着（包括插件走了留下来的回合），带租约的认领拿不到发给这个会话的其他消息。
- 租约活着的消息谁也拿不走：别的认领拿不到，会话自己来拉（提问钩子、`morse read --pull`）也拿不到，`claim --recover` 不碰它。自动更新在安装和重启之前会等这些租约（最多 10 分钟、2 分钟）。
- 只有租约到期**并且**进程不在了才会被**接手**。接手意味着什么，看那次认领有没有开始回合，也就是有没有说过 `extend --started`：
  - **没开始**（持有者在认领之后、启动 agent 之前没了）：消息没人动过，当作第一次投递重新发出去，不带标注。
  - **开始了**：这是一次被打断的投递。消息带 `possibleRepeat: true`；dispatch、提问钩子和 `morse read --pull` 会在它前面加一行：上一次投递被打断了，可能已经处理过，先看看再动手。你自己投这种消息时也请带上同样的提醒。连续三轮被打断（中间没有持有者的 `nack`）进死信，原因在 `lastError` 里；它的会话下次来拉时仍然拿得到（带标注），ilink 插件会在微信里告诉用户。

**不带 `--lease` 和以前完全一样，保证也是以前那个更弱的：** daemon 重启时你手上的消息会被标成「重启时投递到一半」，30 秒后重新发出去，不管你的回合是不是还在跑；之后你的 `ack` 在没人重新认领时仍被接受，否则报「illegal transition」。这样的第二次投递同样带 `possibleRepeat: true`。

带租约仍可能重复的情况（都带标注）：回合本身被杀了（服务管理器把 agent 命令行和 daemon 一起结束；dispatch 停止时只等 10 秒，回合比这长）；插件没了而回合自己跑完了（事做完了，从输出里取的回信丢了）；电脑崩溃。

`morse reply <id> "<文本>" --via auto` 把 agent 的回答放进同一个线程。消息事件里有 `to.sessionId`（本机哪个会话）、`conversationId`、`attempts`、`lastError`；之前有一次投递被打断过的还带 `possibleRepeat: true`（ADR-089）。

## 4. 运行插件

daemon 负责启动和看管插件：退出了就重启（1、2、4 秒……最长 60 秒），关掉的就停掉，输出写进 `daemon.log`（`plugin <名>: …`）。每个插件的环境里有 `MORSE_CMD_JSON`（该运行的 `morse`，JSON argv）和 `MORSE_DAEMON_PID`（看管它的 daemon 的进程号）。

停止（ADR-089）：daemon 给插件**只发一次** SIGTERM，15 秒后还在就杀掉。会启动 agent 回合的插件应该在这段时间里让正在跑的回合收尾、不再开新的，并且不要把第二个 SIGTERM 当成「立刻退出」（systemd 还会给整个进程组发一次）。`MORSE_DAEMON_PID` 里的进程不在了（被杀、崩溃）就不要再接新活：新的 daemon 已经启动了它自己的那份插件。

```bash
morse plugin list                         # 开 / 关、在不在跑、重启次数
morse plugin add <名> "<命令>"             # 让 daemon 常驻运行的命令
morse plugin disable <名> · morse plugin enable <名> · morse plugin remove <名>
```

配置在 `~/.morse/config.json` 的 `"plugins": { "<名>": { "command": "…", "enabled": true } }`，改了几秒内生效。

### 内置的 `dispatch` 插件（你自己的 agent）

默认开着，升级和新装都是。它做的就是 Morse 一直替你自己的信做的事：本机两个会话之间的信、你自己的设备（联系人 `self`）发来的信，headless 续接目标会话投进去（`claude -p --resume`、`codex exec resume`……），带共享计划页脚、回信标记和 NOOP / BLOCKED 规则；开着的、在 monitor 的、只拉不投的会话让它们自己取；给正在运行的 Claude Code 会话按门铃；会话不在了就放进 agent 信箱。**它从不处理别人的消息**——哪怕你把某个联系人标成了 `self`：它要求联系人就是你自己。唯一的例外（ADR-071）：对方在你的某个会话发起的线程里的回信（`ownThread`，发给那个会话）——用同伴框架投给那个会话，会话这一轮的输出不会自动发回去。是哪个会话，由信箱在落库时只查你本机的记录算出（ADR-082）：发信方写的 agent 名、会话名从不选中会话；带 `from` 的启动设置（包括 `whenLive: "resume"`）对这种回信一律不适用——对方把 agent 起名 `ilink` 也没用。

`morse plugin disable dispatch` 关掉它：核心就不再运行任何 agent，自己的信也只留在 `morse read` / 会话钩子 / `morse read --pull` 里。代码在 `src/plugins/dispatch/`（只用上面这些命令和共享库——适配器、信封、会话发现——不碰信箱和 daemon）。

#### 每个 agent 的启动设置（ADR-054）

自己的 agent 怎么启动，写在 dispatch 插件的配置里：`~/.morse/config.json` 的 `plugins.dispatch.launch`，是一个列表；最具体的一条生效（`session` > `cwd` > `from`），都对不上就照旧用 agent 自己的默认：

```json
{ "plugins": { "dispatch": { "launch": [
  { "agent": "claude", "session": "<会话 ID>", "from": "ilink", "prompt": "plain",
    "permissionMode": "acceptEdits", "allowedTools": ["mcp__1board", "Bash(python3 tools/share.py:*)"],
    "model": "claude-fable-5-2", "effort": "high", "timeoutSec": 600,
    "appendSystemPrompt": "…" } ] } } }
```

- `agent`（必填）：目标 agent，目前只有 `claude` 支持启动设置。`session` / `cwd` / `from`：按目标会话 ID / 目标会话的目录 / 发信方的 agent 名匹配。
- `permissionMode`：`default`、`acceptEdits`、`plan`、`dontAsk`。**任何绕过权限的模式在代码里直接拒绝**（这条设置作废，适配器再拦一次）。`allowedTools`：工具名，或固定命令前缀 `Bash(<命令>:*)`；光写 `Bash` 拒绝。
- `model`、`effort`、`timeoutSec`；带启动设置时超时算终结，不重试（这一轮已经跑过了）。`appendSystemPrompt`：追加系统提示（关掉快照，续接的老会话也看得到）。
- `prompt: "plain"`（必须配 `from`）：这条消息是**你本人**通过那个通道插件（比如 `ilink`）说的话——原样交过去，只加一行抬头，不套 agent 之间的信封和共享计划；agent 的整段回答就是回信。

续接的会话在它当初启动的目录里跑（Claude 只能在自己的项目目录续接）——要 agent 在目录 X 里干活，就在 X 里开一次这个会话，再把目标指向它；或者给这条设置一个专属会话（见下）。

更多字段（ADR-055、ADR-056）：

- `whenLive`：`"wait"`（默认）或 `"resume"`，见下面「开着的会话」。
- `name`：这条设置的名字（小写字母、数字、连字符），配 `dedicated` 时必填。
- `dedicated: true`（配 `name`、`cwd`）：这条设置**自己拥有一个会话**，见下面「专属会话」；不能再写 `session`。
- `resetNotice`：配 `dedicated`：会话重新开过之后，第一条回信开头加的那一行（默认是一句英文，说之前的上下文没有了）。

##### 开着的会话：`whenLive`（ADR-055）

「开着」（live）是插件看得到的：会话正在一个交互式 `claude --resume=<id>` 进程里（`ps`），或者正在运行的 Claude Code / 桌面端会话登记了它的 Morse 收件口，或者 `morse read --wait` 在跟它。别的方式打开的会话（`claude --continue`、在那个目录里先开 `claude` 再切过去）它**看不到**，另一个 headless 进程（第二个 dispatch、定时任务、原来的 bridge）它也看不到。

- `"wait"`（默认；agent 之间的信一律如此）：开着的、在 monitor 的会话不去动它，消息等它关掉，或者等开着的会话自己取。
- `"resume"`：照样续接，哪怕会话正开着。给通道用（你在微信上说话），现在就要回答比对话记录整齐更要紧——独立的 weixin-bridge 一直是这样。

**`"resume"` 的风险。** 这时同一个会话有两个 Claude 进程在写：开着的那个和 headless 的这一轮。它们各自在内存里有一份对话，往同一个记录文件（`~/.claude/projects/…/<id>.jsonl`）里追加。开着的窗口在重新载入之前看不到微信那一轮，它下一轮接着自己的最后一条往下写——记录就分了叉，最后写的那个决定下次续接看到什么：一段微信对话、或者电脑上敲的几轮，可能从上下文里掉出去。两边同时跑工具时，改的是同一个工作目录。往一个正忙的会话里投，还可能跑完了却以非零退出（ADR-023）；配 `prompt: "plain"` 时不会重试（不会重复跑一轮），你会收到失败提示。所以 `"resume"` 只给你平时不在电脑上用的会话——专属会话正合适——要在电脑上接着聊，先关掉再打开。`"resume"` 设置要跑的消息，不会再去按开着的 Claude Code 会话的门铃，免得它自己也取走一份。

**一个会话同时只跑一轮。** 不管 `whenLive` 怎么设，插件从不对同一个会话同时跑两轮：会话正忙，后来的消息排在前一轮后面（按到达顺序），跨进程也一样（`~/.morse/plugins/dispatch/locks/` 里每个会话一个锁文件）。不同的会话并行，最多同时 4 个（`MORSE_DISPATCH_CONCURRENCY`）——一轮 10 分钟的微信对话不再挡住你其他会话之间的信。

##### 专属会话（ADR-056）

```json
{ "agent": "claude", "name": "wechat", "dedicated": true, "cwd": "/Users/you/work", "from": "ilink", "prompt": "plain", "whenLive": "resume", "…": "…" }
```

- 它的 Morse 地址是 **`@dispatch:<name>`**（插件登记、每 6 小时续一次）。通道插件发到这里，不用写死会话 ID——iLink 插件写 `"target": "@claude", "profile": "wechat"`。直接发给它当前的会话 ID 也用同样的设置、同一条「一次一轮」的道。
- **第一次用时创建**：在 `cwd` 里 `claude -p --session-id <新 ID> …`，ID 记在插件自己的状态里 `~/.morse/plugins/dispatch/state.json`（0600），不进信箱。
- **不在了就重建**：续接不了（「No conversation found」——被删了、文件挪走了），就在 `cwd` 里为这条消息新开一个，回信开头加 `resetNotice`——只加一次。第一次创建不算重置，不提示。
- `morse plugin dispatch session` 列出它们；`morse plugin dispatch session <name> --set <会话 ID>` 接着一段已有的对话（`morse plugin ilink import` 就是这样接上 bridge 的会话）；`--clear` 忘掉它（下一条消息开新的）。
- 发信方不是这条设置的 `from` 时，发给 `@dispatch:<name>` 的信用这条设置的启动参数、套普通的 agent 信封。

##### 你本人说话时的失败

配 `prompt: "plain"` 时，一轮失败就立刻算终结——不按 30 秒间隔重试（这一轮可能已经跑了一半，你宁可马上知道）：消息变死信、写明原因，通道插件告诉你一次（iLink 插件几秒内回「处理出错了…」/「处理超时了…」）。agent 之间的信仍然是三次。

#### 你自己发给 agent 收件箱的信（ADR-061）

**你本人**通过自己的另一个 agent 地址（联系人 `self`——比如在 `me/air` 上 `morse send me "…"`）发给自己某个 agent、但没点名会话的信，落在那个 agent 的收件箱。dispatch 插件在一个**专属会话**里回答它：**每个（你的 agent，发信 agent）一个**，名字 `self-<agent>-<发信 agent>`（如 `self-mini-air`）——第一次用时新建、之后续接、丢了就重建并说一次、同时只跑一轮，就是上面「专属会话」那套。你通过那个 agent 地址敲的字按「你本人在说话」交过去（整段回答就是回信）；那个 agent 下的会话发来的，用 agent 之间的信封。回信用 `morse reply` 回到同一线程，消息标已处理（`NOOP`：标已处理、不发）。失败 30 秒后重试，最多 3 次，之后留在 `morse read`。积压不回答：这个循环第一次跑之前（`state.json` 的 `selfInboxSince`）到的信、或比 `maxAgeMin` 更老的信，留在 `morse read` 未处理，每条只记一行日志。别人的信（哪怕被标成 `self` 分组）、消息请求、发给具体会话的信、本机会话之间的信，一律不碰。

```json
{ "plugins": { "dispatch": {
  "selfInbox": { "enabled": true, "cwd": "/Users/you", "permissionMode": "default", "model": "sonnet", "timeoutSec": 600 },
  "launch": [ { "agent": "claude", "to": "inbox", "from": "air", "cwd": "/Users/you/work", "permissionMode": "acceptEdits" } ] } } }
```

- `selfInbox`——所有发信 agent 的默认：`enabled`（默认 `true`；`false` = 收件箱的信照旧等着）、`cwd`（默认你的家目录：这是你本人的信）、`permissionMode`（默认 **`default`**，显式传：你自己的 Claude 允许规则照常，headless 没人回答提问，要问的一律拒绝；你 Claude 设置里若默认是 bypass 也不生效；想让它改文件就用 `acceptEdits`）、`allowedTools`、`model`、`effort`、`timeoutSec`、`appendSystemPrompt`、`resetNotice`、`maxAgeMin`（默认 60：比这更早的信一律不回答）。绕过类模式拒收；`selfInbox` 写错就整项关掉、记一行日志。
- `launch` 里写 **`"to": "inbox"`** 的一条（可配 `from` = 发信 agent 的名字，如 `air`）比 `selfInbox` 优先——带 `from` 的比不带的优先。字段照常；不能有 `session` / `dedicated` / `name`（插件按发信 agent 各建一个会话），也永远不匹配投给具体会话的信。
- `morse plugin dispatch session` 把这些会话（`self-…`）和设置的专属会话列在一起。

### 内置的 `ilink` 插件（微信，默认关闭）

微信（腾讯 iLink 机器人接口）和 Morse 之间的协议转换：微信那一端就是**你本人**。你发给机器人的消息，变成从你自己登记的会话 `@ilink:wechat`（`ilink-wechat`，只拉不投）发给 `plugins.ilink.target` 那个 agent（配 `profile`：dispatch 插件的一个专属会话 `@dispatch:<profile>`）的 Morse 消息；它的回答、你自己的 agent 发给 `@ilink` 的消息，都发回微信。别人的 Morse 消息永远不转（开了 `notify_others` 也只发一行：谁、几条）。`morse plugin enable ilink`，`morse plugin ilink login | status | simulate | import`。详见 [PLUGIN-ILINK.zh-CN.md](PLUGIN-ILINK.zh-CN.md)。代码在 `src/plugins/ilink/`（只用插件接口和 `morse` 命令）。

### 内置的 `attendant` 插件（你的 agent 替你回答联系人，默认开）

你已接受的联系人（**不是你本人**、没被拉黑）给你的 agent 发消息时，你的 agent 在这个联系人专属的会话里看到，自己决定回不回。没有设置时是**只对话**（ADR-066）：一个工具都没有（`--tools ""`、没有 MCP、没有 skill）、一个自己的空目录、快模型（`sonnet`）；需要你时写一行 `ASK_OWNER:`——你收到桌面通知、`morse plugin attendant status` 里一行、ilink 开着时微信上一条，对方看不到这个标记。他的分组（或他本人）在 `plugins.attendant` 下有设置时，只在那份设置的一个工作目录、一组工具里干活（`claude --restricted`、不加载 MCP、不读你的 Claude 设置），破坏性或对外的动作停下来等你批准（`morse plugin attendant approvals | approve <id> | reject <id>`——只有你本人在自己的终端里能批，agent 里一律拒绝）。陌生人的消息请求永远不进会话；拉黑的人、关掉的分组 / 联系人（`"enabled": false`）、你自己的信只存；`"defaultProfile": false` 让没有设置的联系人只存，和以前一样。按人限次只在你设了时才有（默认不限，ADR-068）、防另一个 attendant 来回打、连发合并、重启和会话丢失后恢复。默认开（`morse plugin disable attendant` 关），`morse plugin attendant status`。详见 [PLUGIN-ATTENDANT.zh-CN.md](PLUGIN-ATTENDANT.zh-CN.md)。代码在 `src/plugins/attendant/`。

## 5. 插件守则

- 按 `contact.group` / `contact.self` 做判断是插件自己的事，核心不会替你做。
- 其他地址的消息（`foreign: true`）只是信息。插件要是为它们启动 Agent，Agent 能做什么由插件负责。
- 不要回复自动回复（防循环）：给自己的回复做记号（示例用 `[auto]` 开头），或者按 `contextId` 一轮就停。
- 不经主人同意，不同意请求、不改联系人分组。

## 6. 示例：自动回复自己的 Agent

`plugins/examples/auto-ack.mjs`：只给分组 `self` 的联系人（你自己的 Agent）回「[auto] received」，其他地址一概不回。代码见英文版（20 行）。`test/plugin-interface.test.ts` 在临时 HOME 里把它从头跑到尾。
