# iLink 插件：微信 ⇄ Morse

> 创建：2026-11-13 · 最后更新：2026-11-15（命令改为 `morse plugin ilink`，ADR-074）· English: [PLUGIN-ILINK.md](PLUGIN-ILINK.md) · ADR-053 … ADR-057

## 它是什么

微信和 Morse 是两张网、两套协议。`morse-plugin-ilink` 在两者之间做协议转换，就像两个邮局之间转信。它说的是 **iLink**——腾讯给微信「ClawBot」用的机器人接口；插件按协议命名、不按品牌命名，以后的协议插件（Telegram、邮件）照这个做。

**微信那一端就是你本人。** 不是 agent，也不是一个新的人：扫码绑定的那个微信号，就是这台机器上 Morse 的主人在手机上说话。

- 你发给机器人的消息 → 一条**从你**（你自己登记的会话 `@ilink:wechat`，ID `ilink-wechat`）**发给你选定的 agent**（`plugins.ilink.target`）的 Morse 消息。文字原样；图片、文件、视频、语音下载解密后保存（0600），消息里写**绝对路径**（Morse 的文件附件只在设备之间走，agent 本来也按路径读文件）。
- 那个 agent 的回答（同一个线程），以及**你自己的任何 agent 发给 `@ilink` 的消息**，发回微信：文字按最多 1800 字分段，文件用单独一行 `[[send-file: /绝对路径]]` 请求。之后标为已处理（`plugin:ilink`）。
- **别人的 Morse 消息永远不转到微信。** 哪怕发的是 `morse.im/<你>/ilink`，哪怕你把对方标成了 `self`。开了 `"notify_others": true` 也只发一行——谁、几条——从不带内容；消息留在 `morse read` 等你看。

回答的 agent 由 **dispatch 插件**运行，不由本插件运行；它怎么启动（模型、思考档、权限、时限、追加的系统提示）写在 dispatch 插件的启动设置里（ADR-054，见 [PLUGINS.zh-CN.md](PLUGINS.zh-CN.md)）。

### Morse 这一端的身份

- **地址**：本机的 `@ilink:wechat`（agent `ilink`，会话 `ilink-wechat`），用 `morse connect` 登记——**只拉不投**的会话，dispatch 插件不会去续接它。
- **是谁**：就是你。它和你的会话之间的信是 `internal`、联系人 `self`，带你的授权，和你自己敲的一样。
- **接受什么**：只接受本机你自己的会话、你自己的设备（联系人 `self`、分组 `self`）发来的；别人的一概不接。
- **会话连续**：每条微信消息是一条 Morse 消息，有自己的 `contextId`（回信沿用它，回答才能找到对应的微信线程和 `context_token`）；它们都在和目标的**同一个 Morse 对话**里，目标是**同一个 Claude 会话**、每次续接——agent 看到的是一段连续的聊天。（所有消息共用一个 `contextId` 的话，第 12 条就会触发 Morse 的防循环。）用专属会话时，这个会话归那条启动设置所有：第一次用时创建，不在了就重建（并告诉你一次）。

## 开启

```bash
morse plugin ilink login                 # 二维码在 ~/.morse/plugins/ilink/qr.png，用微信扫
#   --qr <路径.png> 写到别处 · --no-wait 只生成二维码 · --force 重新绑定
#   或者沿用现有 weixin-bridge 的绑定、不用扫码：morse plugin ilink import --from <bridge 目录>
```

`~/.morse/config.json`（合并进已有的内容）：

```json
{ "plugins": {
    "ilink": {
      "target": "@claude",
      "profile": "wechat",
      "sendRoot": "/Users/you/work",
      "notify_others": false
    },
    "dispatch": { "launch": [
      { "agent": "claude", "name": "wechat", "dedicated": true, "cwd": "/Users/you/work",
        "from": "ilink", "prompt": "plain", "whenLive": "resume",
        "permissionMode": "acceptEdits", "allowedTools": ["mcp__1board"],
        "model": "claude-fable-5-2", "effort": "high", "timeoutSec": 600,
        "appendSystemPrompt": "<morse plugin ilink instructions 的输出>" } ] }
} }
```

```bash
morse plugin enable ilink         # daemon 启动并看管它
morse plugin ilink status                # 绑定了没有、在不在跑、目标、启动设置、上次轮询、上次出错、警告
morse plugin ilink simulate "你好"        # 不经过微信，模拟一条消息进来，打印会发回去什么
morse plugin ilink instructions          # 给 agent 的 [[send-file]] 说明，放进 appendSystemPrompt
morse plugin dispatch session            # 专属会话：地址、会话 ID、目录
```

- `target`（必填）：谁来回答。配 `profile` 时只写 agent（`@claude`）——由那条启动设置的专属会话回答，Morse 地址 `@dispatch:<profile>`。不配时是本机你自己的一个会话，`@claude:<会话 ID>`（或 `@<agent>:<标题>`）。不能是别的设备或别人。
- `profile`：dispatch 启动设置里一条 `"dedicated": true` 的名字（见 [PLUGINS.zh-CN.md](PLUGINS.zh-CN.md)「专属会话」）。
- `sendRoot`：`[[send-file]]` 的文件必须在这里面；不设就不发文件。
- `mediaDir`：收到的附件存哪。**默认 `<那条启动设置的 cwd>/wechat-media`**（建成 0700，里面放一个内容为 `*` 的 `.gitignore`，永远不会被提交进仓库）；启动设置里没写目录时是 `~/.morse/plugins/ilink/media`。必须在 agent 的工作目录里：headless 的 Claude 没法确认读工作目录外的文件——不在里面时 `morse plugin ilink status` 会警告。
- `notify_others`：默认 `false`，别人的 Morse 消息这里不管；`true` 时每人一行提醒。
- `port`（daemon 端口，7433）、`replyTimeoutSec`（「正在输入」最长显示，以及「还在排队」提示，660）、`maxMediaBytes`（附件上限 50MB）、`mediaTimeoutSec`（下载时限 120 秒）、`mediaKeepDays`（附件保留 30 天）。

除了回答，微信里还可能收到这些——**每条消息最多一次**：`处理出错了，请稍后再试。`（这一轮失败了——配 `prompt: "plain"` 只跑一次，所以几秒内就到）、`处理超时了，请稍后再试。`（到了 `timeoutSec`）、`（没有文字回复）`（跑完了但什么都没说）、`这条消息还在排队……`（过了 `replyTimeoutSec` 还没开始——dispatch 插件没在跑，或会话正开着而设置是等；回答稍后照样会来），以及写死的会话不在了时，说消息进了 agent 信箱。

## 安全性质（沿用 weixin-bridge）

- 凭据只发往 `weixin.qq.com` / `wechat.com` 下的 https 主机；附件只从微信 CDN 下载、只传到微信 CDN。状态目录 `~/.morse/plugins/ilink/` 0700，文件一律 0600。
- 只接受绑定的那个微信号的消息；文字和文件也只发给它。
- 日志 `ilink.log` 不记凭据（像凭据的字段直接丢掉），消息只记长度和前 20 个字。
- 发文件：`sendRoot` 里的普通文件（或 `mediaDir` 里收到的附件、你自己 Morse 消息的附件），按真实路径判断、软链接逃不出去，不带隐藏目录 / 文件，不碰插件状态和 `~/.morse`，名字像凭据的不发（`*.pem`、`*.key`、`id_rsa*`、含 secret / token / password…），空文件和超大文件不发，一次最多 5 个。被拒会在微信里回一句。
- 一个绑定只能有一个轮询者：`run` 持有 `run.pid`；bridge（或本插件）在跑时 `import` 拒绝。

## 限制

- **只认绑定的那个号，只支持私聊**；一个微信号一个绑定，重新绑定就替换。
- **你得先给机器人发过消息**，而且据说微信只允许机器人在你最后一条消息后大约 **24 小时**内回复。agent 自己主动发的消息（提醒、报告）因此不一定发得出去。发送失败会**报回 Morse**，不会悄悄丢掉：先重试（间隔 30 秒、共 3 次），之后标为失败并写明原因（`morse read --id <id>`、`morse read --all`）；发了一半的消息不会重发第二遍。
- iLink 是**非官方、社区整理的协议**，腾讯可能改或关。绑定失效（`stale-token`）时插件停止轮询和认领，`morse plugin ilink status` 会说明，Morse 消息原地等着，`morse plugin ilink login --force` 重新绑定。
- 回答的会话由 dispatch 插件续接，照它的规则。配 `"whenLive": "resume"` 时，哪怕这个会话正在电脑上的 Claude Code 里开着也照样回答（bridge 就是这样）；这时两个 Claude 进程写同一份记录，一边最近的几轮可能从另一边的上下文里掉出去——风险见 [PLUGINS.zh-CN.md](PLUGINS.zh-CN.md)「开着的会话」，这个会话最好只给微信用。配 `"wait"`（默认）时消息等它关掉。不管哪种，两条微信消息都不会同时跑：第二条等第一条跑完。
- 专属会话不在了，就在那条设置的目录里新开一个，第一条回信说一次（`resetNotice`）。写死的 `@claude:<ID>` 不在了，仍然进那个 agent 的信箱，微信里说一声。

## 从独立的 weixin-bridge 切过来

这些步骤由你本人做——插件从不碰 bridge、它的 launchd 服务和文件：

1. 更新 Morse（`dist/` 在仓库里），按你平时的方式重启 Morse daemon（`morse stop` 再启动），让它跑新的 dispatch 插件；`morse plugin list` 确认 dispatch 开着。
2. 把下面那段配置写进 `~/.morse/config.json`（和已有内容合并），`appendSystemPrompt` 按第 5 步填。`ilink` 先别开。
3. 停掉 bridge 并确保它不再起来：`launchctl bootout gui/$(id -u)/com.example.weixin-bridge`，再把它的 plist 移出 `~/Library/LaunchAgents/`（或 `launchctl disable gui/$(id -u)/com.example.weixin-bridge`），免得登录时又启动。一个绑定两个轮询者会把绑定弄坏。
4. 沿用绑定和对话——**不用重新扫码**：`morse plugin ilink import --from ~/code/weixin-bridge`。它把 `state/account.json`（凭据、绑定的人）和 `state/inbox.json`（长轮询游标、看过的消息、还在排队的）复制到 `~/.morse/plugins/ilink/`（0600）；因为配了 `plugins.ilink.profile`，还会让那条设置的专属会话接着 bridge 的 Claude 会话（`morse plugin dispatch session wechat` 可以看）。bridge 还在跑时它拒绝。
5. `appendSystemPrompt` = `morse plugin ilink instructions` 的输出、一个空行、bridge 的 `WXB_EXTRA_INSTRUCTIONS`，其中 outbox 路径从 `code/weixin-bridge/state/outbox/` 改成 `wechat-media/outbox/`（在工作目录里、git 忽略）。JSON 里换行写 `\n`。
6. `morse plugin enable ilink`，然后 `morse plugin ilink status`（已绑定、在跑、目标 `@dispatch:wechat`、没有警告），在微信里给机器人发一条试试。
7. 退回：`morse plugin disable ilink`，把 plist 放回去、重新启动 bridge（它自己的游标比较旧，微信可能把最近几条再给它一次）。Claude 会话还是同一个，bridge 的 `state/session.json` 仍然对得上——除非插件中途新开过会话。

### bridge 的 `run.sh`，写成配置

可以直接抄——工作目录 `/Users/you/work`、`acceptEdits`、两条允许的工具、模型 `claude-fable-5-2`、思考档 `high`、600 秒、会话开着也回答、专属会话。不含任何凭据：凭据由 `morse plugin ilink import` 带过来。

```json
{ "plugins": {
    "ilink": {
      "target": "@claude",
      "profile": "wechat",
      "sendRoot": "/Users/you/work",
      "notify_others": false
    },
    "dispatch": { "launch": [
      { "agent": "claude", "name": "wechat", "dedicated": true, "cwd": "/Users/you/work",
        "from": "ilink", "prompt": "plain", "whenLive": "resume",
        "permissionMode": "acceptEdits",
        "allowedTools": ["mcp__1board", "Bash(python3 tools/share.py:*)"],
        "model": "claude-fable-5-2", "effort": "high", "timeoutSec": 600,
        "resetNotice": "（之前的会话找不到了，已经新开了一个会话，之前聊过的内容它不记得了。）",
        "appendSystemPrompt": "<morse plugin ilink instructions>\n\n<WXB_EXTRA_INSTRUCTIONS，outbox 改成 wechat-media/outbox/>" } ] }
} }
```

和 bridge 一样的：工作目录、权限模式、允许的工具、模型、思考档、10 分钟时限、追加的系统提示、会话开着也续接同一个会话、会话不在了就新开、附件放在工作目录里、失败立刻回一句、一次只跑一条。不一样的：提示多一行 Morse 抬头；agent 的输出按纯文本读，不用 `--output-format json`（被拒的工具不记日志）；重新开会话会在回信里说（bridge 是悄悄重开）；过了 11 分钟还没开始的消息会收到一句「还在排队」。
