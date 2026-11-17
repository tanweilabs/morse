# The iLink plugin: WeChat ⇄ Morse

> Created: 2026-11-13 · Last updated: 2026-11-15 (commands under `morse plugin ilink`, ADR-074) · 中文: [PLUGIN-ILINK.zh-CN.md](PLUGIN-ILINK.zh-CN.md) · ADR-053 … ADR-057

## What it is

WeChat and Morse are two networks with two protocols. `morse-plugin-ilink` converts between them, like mail handed from one post office to another. It speaks **iLink**, Tencent's bot API behind the WeChat "ClawBot" — the plugin is named after the protocol, not the brand, and is the template for later protocol plugins (Telegram, email).

**The WeChat side is you.** Not an agent, not a new person: the one WeChat account that scanned the binding QR code is the owner of this Morse install speaking from his phone.

- A message you send to the bot → a Morse message **from you** (your own registered session `@ilink:wechat`, id `ilink-wechat`) **to the agent you chose** (`plugins.ilink.target` — best: a dedicated session of the dispatch plugin, `"target": "@claude", "profile": "wechat"`). Text as is; images, files, videos and voice clips are downloaded, decrypted and saved (0600), and the message names them by **absolute path** (Morse file attachments only travel between devices, and the agent reads files by path anyway).
- That agent's answer (same thread), and **anything one of your own agents sends to `@ilink`**, goes back to WeChat: text in pieces of at most 1800 characters, files requested with a line `[[send-file: /abs/path]]`. Then it is marked processed (`plugin:ilink`).
- **Other people's Morse mail is never forwarded.** Not even when it is addressed to `morse.im/<you>/ilink`, not even when you labelled them `self`. With `"notify_others": true` you get one line — who, how many — and never the content; the messages stay in `morse read` for you.

The agent that answers is run by the **dispatch plugin**, not by this one; how it is started (model, effort, permissions, time limit, extra system prompt) is the dispatch plugin's per-agent launch config (ADR-054, [PLUGINS.md](PLUGINS.md#launch-settings-per-agent-adr-054)).

### The Morse-side identity

| | |
|---|---|
| address | `@ilink:wechat` on this computer (agent `ilink`, session `ilink-wechat`), registered with `morse connect` — a **pull-only** session, so the dispatch plugin never tries to resume it |
| who it is | you: mail between it and your sessions is `internal`, contact `self` — it carries your authority, exactly like a message you type |
| what it accepts | mail from your own sessions on this computer and from your own devices (contact `self`, group `self`); nothing from anyone else |
| conversation | every WeChat message is one Morse message with its own `contextId` (the reply keeps it, so the answer finds its WeChat thread and its `context_token`); all of them are in **one Morse conversation** with the target, and the target is **one Claude session** that is resumed every time — so the agent sees one ongoing chat. (One `contextId` for everything would trip Morse's loop protection after 12 messages.) With a dedicated profile that session is the profile's own: created on first use, recreated (and you are told once) if it disappears |

## Enable it

```bash
morse plugin ilink login                 # QR code in ~/.morse/plugins/ilink/qr.png; scan it with WeChat
#   --qr <path.png>  write it elsewhere · --no-wait  only make the code · --force  bind again
#   or reuse an existing weixin-bridge binding, no scan:  morse plugin ilink import --from <bridge dir>
```

`~/.morse/config.json` (merge into what is there):

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
        "appendSystemPrompt": "<the output of: morse plugin ilink instructions>" } ] }
} }
```

```bash
morse plugin enable ilink         # the daemon starts and supervises it
morse plugin ilink status                # bound? running? target, profile, last poll, last error, warnings
morse plugin ilink simulate "hello"      # a fake inbound text, no WeChat: prints what would be sent back
morse plugin ilink instructions          # the [[send-file]] guidance to put in appendSystemPrompt
morse plugin dispatch session            # the dedicated session(s): address, session id, directory
```

| setting | |
|---|---|
| `target` (required) | who answers. With `profile`: just the agent (`@claude`) — the profile's dedicated session answers, Morse address `@dispatch:<profile>`. Without: a session of yours on this computer, `@claude:<session id>` (or `@<agent>:<title>`). Never another device or person |
| `profile` | the name of a dispatch launch profile with `"dedicated": true` ([PLUGINS.md](PLUGINS.md#a-dedicated-session-adr-056)) |
| `sendRoot` | `[[send-file]]` paths must be inside it. Unset = no files go out |
| `mediaDir` | where received attachments are saved. **Default: `<the profile's cwd>/wechat-media`** (created 0700 with a `.gitignore` of `*`, so nothing in it is ever committed), or `~/.morse/plugins/ilink/media` when the launch config names no directory. It must be inside the agent's working directory: a headless Claude cannot approve reading a file outside it — `morse plugin ilink status` warns when it is not |
| `notify_others` | `false` (default): other people's Morse mail is ignored here. `true`: a one-line notice per person |
| `port` | the daemon's port (7433) |
| `replyTimeoutSec`, `maxMediaBytes`, `mediaTimeoutSec`, `mediaKeepDays` | typing indicator limit and the "still queued" notice (660), attachment cap (50 MB), download limit (120 s), media kept (30 days) |

What you get back in WeChat besides answers — each **at most once per message**: `处理出错了，请稍后再试。` (the run failed — with `prompt: "plain"` there is one try, so this comes within seconds), `处理超时了，请稍后再试。` (it hit `timeoutSec`), `（没有文字回复）` (it ran and said nothing), `这条消息还在排队……` (not started after `replyTimeoutSec` — the dispatch plugin is not running, or the session is live and the profile waits; the answer still comes later), and, with a hard-coded session that disappeared, that it went to the agent's mailbox.

## Safety properties (kept from weixin-bridge)

- Credentials only go to https hosts under `weixin.qq.com` / `wechat.com`; attachments only come from / go to the WeChat CDN host. State in `~/.morse/plugins/ilink/` is 0700, every file 0600.
- Only the bound WeChat user's messages are accepted; files and text go only to that user.
- The log (`ilink.log`) never holds a credential (fields that look like one are dropped) and holds message text only as length + first 20 characters.
- Files out: a regular file inside `sendRoot` (or a received attachment in `mediaDir`, or an attachment of your own Morse mail), real path checked so links cannot escape, no hidden component, nothing from the plugin's state or `~/.morse`, no credential-looking name (`*.pem`, `*.key`, `id_rsa*`, secret / token / password …), not empty, under the size cap, at most 5 per message. A refusal is one line in WeChat.
- One poller per binding: `run` holds `run.pid`; `import` refuses while the bridge (or the plugin) runs.

## Limits

- **Only the bound account, private chat only.** One binding per WeChat account; binding again replaces it.
- **You must have written to the bot first**, and WeChat reportedly only lets a bot answer within about **24 hours** of your last message. A message your agent sends on its own (a reminder, a report) may therefore not go out. A failed send is **reported back into Morse**, never dropped silently: the message is retried (30 s backoff, 3 tries) and then marked failed with the reason (`morse read --id <id>`, `morse read --all`); a half-sent message is never sent twice.
- iLink is an **unofficial, community-documented protocol**; Tencent may change or close it. When the binding expires (`stale-token`) the plugin stops polling and claiming, `morse plugin ilink status` says so, Morse mail waits, and `morse plugin ilink login --force` binds again.
- The answering session is resumed by the dispatch plugin, with its rules. With `"whenLive": "resume"` it answers even while the session is open in Claude Code on the computer (as the bridge did); two Claude processes then write one transcript, so one side's latest turns can drop out of the other's context — read the risk in [PLUGINS.md](PLUGINS.md#live-sessions-whenlive-adr-055) and keep that session for WeChat. With `"wait"` (default) the message waits until the session is closed. Either way two WeChat messages are never run at the same time: the second waits for the first.
- A dedicated session that is gone is started afresh in the profile's directory, and the first reply says so once (`resetNotice`). A hard-coded `@claude:<id>` target that is gone still goes to the agent's mailbox, and WeChat says so.

## Cutover from the standalone weixin-bridge

You do these yourself — the plugin never touches the bridge, its launchd service or its files:

1. Update Morse (`dist/` is in the repository) and restart the Morse daemon the way you run it (`morse stop`, then start it again) so it runs the new dispatch plugin; check `morse plugin list` (dispatch on).
2. Put the config below into `~/.morse/config.json` (merge it with what is there). Fill in `appendSystemPrompt` (step 5). `ilink` stays off for now.
3. Stop the bridge and keep it stopped: `launchctl bootout gui/$(id -u)/com.example.weixin-bridge`, then move its plist out of `~/Library/LaunchAgents/` (or `launchctl disable gui/$(id -u)/com.example.weixin-bridge`) so it does not come back at login. Two pollers on one binding break it.
4. Reuse the binding and the conversation — **no new scan**: `morse plugin ilink import --from ~/code/weixin-bridge`. It copies `state/account.json` (credentials, bound user) and `state/inbox.json` (long-poll cursor, seen ids, anything still queued) into `~/.morse/plugins/ilink/` (0600) and, because `plugins.ilink.profile` is set, makes the profile's dedicated session continue the bridge's Claude session (`morse plugin dispatch session wechat` shows it). It refuses while the bridge still runs.
5. `appendSystemPrompt` = the output of `morse plugin ilink instructions`, a blank line, and the bridge's `WXB_EXTRA_INSTRUCTIONS` with the outbox path changed from `code/weixin-bridge/state/outbox/` to `wechat-media/outbox/` (inside the working directory and git-ignored). In JSON, line breaks are `\n`.
6. `morse plugin enable ilink`, then `morse plugin ilink status` (bound, running, target `@dispatch:wechat`, no warnings) and write to the bot from WeChat.
7. Back out: `morse plugin disable ilink`, put the plist back and start the bridge again (its own cursor is older, so WeChat may hand it a few recent messages again). The Claude session is the same one, so the bridge's `state/session.json` still fits, unless the plugin had to start a new one.

### The bridge's `run.sh`, as config

Ready to copy — `/Users/you/work` as the working directory, `acceptEdits`, the two allowed tool entries, model `claude-fable-5-2`, effort `high`, 600 s, answering while the session is open, its own session. No credentials: those come from `morse plugin ilink import`.

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
        "appendSystemPrompt": "<morse plugin ilink instructions>\n\n<WXB_EXTRA_INSTRUCTIONS, outbox → wechat-media/outbox/>" } ] }
} }
```

What is the same as the bridge: working directory, permission mode, the allowed tools, model, effort, 10-minute limit, the extra system prompt, resuming one session even while it is open, a fresh session when it is gone, media inside the working directory, one immediate failure line, one message at a time. What differs: the prompt has one Morse header line; the agent's output is read as text, not `--output-format json` (denied tools are not logged); a fresh start is announced in the reply (the bridge started over silently); a message that has not started after 11 minutes gets a "still queued" line.
