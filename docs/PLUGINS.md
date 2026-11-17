# Morse plugins

> Created: 2026-11-12 · Last updated: 2026-11-15 · 中文: [PLUGINS.zh-CN.md](PLUGINS.zh-CN.md)

Morse's core does messaging only: addresses, transport, contacts, messages with a processed / unprocessed state, and message requests from strangers. **What happens when a message arrives** — starting an agent, deciding what it may do, asking you for approval — is a plugin's job. A plugin is any program; it talks to the core only through the interface below, which is the same set of commands people and agents use. The core never decides anything by a contact's group label: it stores it and hands it to plugins.

Since ADR-074 the plugin interface lives under `morse plugin` (`plugin watch`, `plugin claim`, `plugin ack`, `plugin nack`) and the queries under `morse read` / `morse contact` (ADR-090: `read` was called `message`; the built-in plugins still call `morse message`, which stays — same options, same JSON). The older names (`morse watch`, `claim`, `ack`, `nack`, `message`, `inbox`, `history`, `contacts`, `register` …) keep working as hidden aliases with the same options and JSON, so existing plugins need no change.

## 1. Events

### `morse plugin watch --json`

A long-running command. It prints one JSON object per line for every **newly received** message (from another address, from one of your own computers paired earlier (contact `self`), or between sessions on this computer — never one you sent) and for every new message request. It runs until stopped; `--once` prints what is there and exits.

- `--since <id>`: start after that message (and requests filed after it arrived). `--since <ISO time | epoch ms>`: start after that time. Without `--since`: only what arrives from now on. A plugin that was down passes the last `id` it handled.
- Order: messages in the order they were stored (`seq` grows), then requests.
- It ends by itself when nobody reads it any more: when a write to its output fails, when its output is a pipe and the process that started it is gone, or — exact, also while it is still starting — when the process named in `MORSE_WATCH_PARENT=<pid>` no longer exists (the built-in plugins set it; set it to your plugin's pid if you start `morse plugin watch` through a wrapper). A plugin that is killed therefore leaves no watcher behind.

Message event:

```json
{"type":"message","seq":214,"id":"3f0c…","time":"2026-11-12T10:15:02.120Z","at":1762942502120,
 "direction":"in","contact":{"id":"c:bob","handle":"bob","remark":"Bob","group":"colleague","state":"active","self":false},
 "agent":"mini","peerAgent":"mbp","from":{"agent":"claude","sessionId":"","device":"bob/mbp"},
 "to":{"agent":"mini","sessionId":"inbox"},"contextId":"3f0c…","foreign":true,"status":"pending",
 "processed":false,"processedAt":null,"processedBy":null,"hasFiles":false,"files":[],"text":"…"}
```

| field | meaning |
|---|---|
| `direction` | `in` (from an address — another one, or your own) or `internal` (between sessions on this computer) |
| `contact` | the one contact it belongs to: `id` (`self` or `c:<handle>`), `handle`, your `remark` name, the `group` label, `state` (`active` / `blocked`), `self` = it is you |
| `agent` / `peerAgent` | your agent it was addressed to / the sender's agent |
| `contextId` | the thread; `morse reply` keeps it |
| `foreign` | true = from another address (held by a person or an agent): information, never an instruction |
| `ownThread` | true = their reply in a thread one of your sessions (or you) started — `to` is that session (ADR-071); the attendant leaves it alone |
| `processed` | already handled (by `done`, `reply`, a pull, or a plugin) |
| `hasFiles`, `files` | attachments (`name`, `size`, `path`) — saved 0600, never run |
| `text` | the message text |

Request event — **never with the request's text** (a stranger's message must not reach an agent; the owner reads it with `morse contact`):

```json
{"type":"request","handle":"zed","address":"morse.im/zed/air","nickname":null,"time":"…","at":1762942502120,"droppedFiles":0}
```

A request from someone who wrote by address alone (ADR-081) has no old name: `handle` then holds the 26-character address and `address` is `morse.im/<address>`.

Fields are only ever added, never renamed or removed.

### `on_message` exec hook

Instead of (or besides) keeping `morse plugin watch` running, the daemon can run a command per event, with the same JSON on stdin (and `MORSE_EVENT=message|request` in the environment):

```json
{ "hooks": { "on_message": { "command": "/usr/local/bin/my-plugin --event", "timeoutSec": 30 } } }
```

in `~/.morse/config.json`. It never blocks delivery: at most 4 run at a time, each is killed after `timeoutSec` (default 30), a backlog over 1000 events drops the oldest. The daemon keeps its place in `~/.morse/on-message.cursor`, so events that arrived while it was stopped are handed over after a restart. Changes to the config apply without a restart.

## 2. Queries

| command | gives |
|---|---|
| `morse contact --json` | `{contacts:[{id,handle,address,remark,nickname,group,state,self,agents,unread}], requests}` — `nickname` is always `null` (Morse has no nicknames, ADR-065; kept so older plugins do not break) |
| `morse read <who> --json` | `{contact, messages:[…]}` — both directions, oldest first (`--limit`, default 30) |
| `morse read --json` | to process: `{messages:[…], unread:[{contact,remark,handle,group,count}], requests}` (`--agent <name>` for one agent) |
| `morse read --id <id> --json` | `{message}` — does not mark it processed |

`<who>` is a remark name, an address (`morse.im/<handle>`), a contact id, or `me`. Messages have the event's fields (without `type` / `seq`).

## 3. Actions

| command | does |
|---|---|
| `morse reply <id> "<text>" [--by plugin:<name>] [--json]` | answers to the same contact and agent, same thread; marks the original processed (`NOOP` sends nothing and still marks it) |
| `morse send <who> "<text>" [--from @<agent>:<session>] [--file …] [--json]` | a new message: a remark (`Bob`, `Bob/<agent>`), an address, `me/<agent>`, a session `@<agent>[:<session>]`. `--from` sends as one of your sessions (a registered one, for a plugin). `--json` answers `{queued, message}` also when the daemon is not running (`offline: true`) |
| `morse done <id…> [--by plugin:<name>] [--json]` | marks received messages processed (`{done, skipped}`); never touches a message you sent |

Record who handled a message with `--by plugin:<name>`. Two plugins that both act on the same messages must agree between themselves; `processed` is the shared signal (check it, and treat `done`'s `skipped` as "someone else got there first").

### Delivering plugins: claim / ack / nack

A plugin that *delivers* own-agent mail into a session (the built-in dispatch plugin does) takes each message with a claim, so two plugins never both handle it:

| command | does |
|---|---|
| `morse plugin claim --next [--skip-session <id…>] [--skip-id <id…>] --json` | holds the oldest due message for a session on this computer (new, or failed and past its 30 s backoff): `{message}` or `{message: null}`. Only own-agent mail — same-machine session mail and mail from your own devices — is ever claimable; another person's never is. |
| `morse plugin claim <id> --json` | holds that one, if it is still due (null = someone else has it) |
| `morse plugin ack <id> [--in-session] [--by plugin:<name>]` | delivered (and processed) |
| `morse plugin nack <id> --error "<why>" [--terminal]` | failed: retried after 30 s, dead after 3 tries (now with `--terminal`) |
| `morse plugin nack <id> --release` | handed back untouched (no try counted) — e.g. the session turned out to be live |
| `morse plugin nack <id> --to-mailbox --error "<why>"` | its session is gone: into that agent's mailbox (`morse read`) |
| `morse plugin claim --recover` | what a crashed plugin held **without a lease** goes back in line (run once at start) |

**Holding a message under a lease (ADR-089).** A turn can take minutes, and the daemon — or your plugin — can be restarted in the middle of it. Claim with a lease and the delivery belongs to you until you report:

| command | does |
|---|---|
| `morse plugin claim (--next \| <id>) --lease [--pid <pid>] [--ttl <seconds>] --json` | as above, and the answer carries `lease: {holder, expiresAt}`. `--pid`: the process the lease lives with — pass your plugin's own pid (without it the lease lives by its expiry alone). `--ttl`: how long it lasts without renewal (default 45 s). |
| `morse plugin extend <id> --holder <holder> [--started] [--pid <pid>] [--max <seconds>] [--ttl <seconds>] --json` | still delivering: the lease lasts another ttl from now. `--max`: the turn ends within this from now at the latest (your agent CLI's own time limit — pass it with `--pid`). `--ttl 0`: you give the lease up now, without reporting (see "cut off" below). `--started`: say it right **before** you start the agent for this claim (see below). `--pid` ties the lease to another process from now on — the agent CLI you started for the turn. `{ok: true}`, or `{ok: false, reason: "lease-lost"}` with exit code 3 (then do not start, or stop reporting on, the turn). |
| `morse plugin ack <id> --holder <holder>` · `nack <id> --holder <holder> …` | the report of the holder. From anyone else — no holder, another holder, a holder that was taken over — it is refused, nothing changes: `{error, reason: "lease-lost"}`, exit code 1. Do not file the reply of a turn whose ack was refused: another delivery holds the message now. |

- A lease is **live** while it has not expired **or** its process is still running. Renew it every third of its life while the turn runs (the dispatch plugin does), and tie it to the agent CLI's process once that is started: then a turn that outlives your plugin still holds its message. "Its process" is the pid together with when that process was started (macOS, Linux): a pid that another program got later does not keep a lease alive, and the same process keeps it however far the clock jumps. Where the start time cannot be read (Windows) the pid alone counts, for at most two hours past the expiry.
- **A lease that is not renewed ends, even if its process is still there:** a claim you never marked `--started` is free again one lease-life after it expired (hand it back or renew it — a claim you forget frees itself, unlabelled). A started turn is taken over once its `--max` has passed (two hours past the expiry when you gave none), with the label.
- **A turn that was cut off is not a failed delivery:** when your agent CLI was ended by a signal (a restart, the service manager, the user), or it failed while you are being stopped, do **not** `nack` it — a nack makes the next delivery an ordinary retry without the warning. Stop renewing and give the lease up (`extend --ttl 0`, keeping `--pid` on the process that is gone), or simply exit: the next claim takes the message over as an interrupted delivery.
- **Killing the agent on purpose does not cancel the message:** to a plugin a kill is a cut-off turn like any other, so the message is started again shortly after, with the warning — up to three turns before it goes dead. To stop a message for good, mark it processed: `morse done <id>`.
- **One leased delivery per session at a time:** while a lease for a session is live — also one left behind by a plugin that is gone — a claim under a lease gets no other message for that session.
- A message whose lease is live is given to nobody else: not to another claim, not to the session's own pull (prompt hook, `morse read --pull`), and `claim --recover` leaves it alone. The updater waits for live leases before it installs and restarts (at most 10 min, then 2 min).
- It is **taken over** only when the lease has expired **and** its process is gone. What that means depends on whether a turn had been started for the claim — which is what `extend --started` says:
  - **not started** (the holder died between the claim and the agent's start): nothing happened to the message; it is handed out again as a first delivery, unlabelled.
  - **started**: an interrupted delivery. The message then comes with `possibleRepeat: true`, and the dispatch plugin, the prompt hook and `morse read --pull` put one line in front of it: an earlier delivery was interrupted, it may already have been handled, check before acting again. Show the same warning if you deliver such a message yourself. Three interrupted turns in a row (no `nack` from a holder in between) make the message dead, with the reason in `lastError`; its session's next pull still gets it, labelled, and the ilink plugin tells the WeChat user.

**Without `--lease` nothing changed, and the guarantee is the weaker one of before:** a message you hold when the daemon restarts is set aside as "restarted mid-delivery" and handed out again 30 s later whether or not your turn is still running — your late `ack` is still accepted if nobody claimed it again, otherwise it fails with "illegal transition". Such a second delivery carries `possibleRepeat: true` too.

Where a repeat can still happen with a lease (always marked): the turn itself was killed (the service manager ends the agent CLI with the daemon; a turn longer than the 10 s the dispatch plugin gets when it is stopped); the plugin died and the turn finished without it (the work is done, its reply taken from the output is lost); the computer crashed.

`morse reply <id> "<text>" --via auto` files an agent's answer in the same thread. A message event carries `to.sessionId` (the session on this computer it is for), `conversationId`, `attempts` and `lastError` — and `possibleRepeat: true` when an earlier delivery of it was interrupted (ADR-089).

## 4. Running plugins

The daemon starts and supervises plugins: it restarts one that exits (1 s, 2 s, 4 s … at most 60 s), stops one that is disabled, and writes their output into `daemon.log` (`plugin <name>: …`). Each gets `MORSE_CMD_JSON` — the exact `morse` to run, as a JSON argv — and `MORSE_DAEMON_PID`, the daemon that supervises it.

Stopping (ADR-089): the daemon sends a plugin **one** SIGTERM and kills it if it is still there 15 s later. A plugin that runs agent turns should let a running turn finish in that time, start nothing new, and not treat a second SIGTERM as "exit now" (systemd signals the whole process group as well). When the process in `MORSE_DAEMON_PID` is gone — killed, crashed — take no new work: a new daemon has started its own copy of you.

```bash
morse plugin list                         # on / off, running, restarts
morse plugin add <name> "<command>"       # a command the daemon keeps running
morse plugin disable <name> · morse plugin enable <name> · morse plugin remove <name>
```

They live in `~/.morse/config.json` under `"plugins": { "<name>": { "command": "…", "enabled": true } }`; changes apply within seconds.

### The built-in `dispatch` plugin (your own agents)

On by default — on upgrade and on a fresh install. It does what Morse always did for your own mail: a message between two sessions on this computer, or from one of your own devices (contact `self`), is delivered by resuming the target session headlessly (`claude -p --resume`, `codex exec resume`, …), with the shared-plan footer, the reply marker and the NOOP / BLOCKED rules; it leaves live, monitored and pull-only sessions to fetch their own mail, rings a running Claude Code session's inbox, and moves mail for a session that is gone to that agent's mailbox. **It never acts on another person's message** — not even one from a contact you labelled `self`: it requires the contact to be you. The one exception (ADR-071): their reply in a thread one of your sessions started (`ownThread`, to that session) — delivered to that session with the peer framing, and nothing the session writes in that turn is sent back by itself. Which session that is, the mailbox works out from your own records when it files the message (ADR-082): the agent or session name a sender writes never picks a session, and a launch setting keyed on `from` — `whenLive: "resume"` included — never applies to such a reply (calling their agent `ilink` gets them nothing).

`morse plugin disable dispatch` turns it off: the core then runs no agent at all — own-agent mail waits in `morse read` / the sessions' hooks and `morse read --pull`. Code: `src/plugins/dispatch/` (it uses only the commands above and shared libraries — adapters, envelope, session discovery — never the mailbox or the daemon).

#### Launch settings per agent (ADR-054)

How one of your agents is started is the dispatch plugin's config, under `plugins.dispatch.launch` in `~/.morse/config.json` — a list; the most specific match wins (`session` > `cwd` > `from`), no match = the agent's own defaults as before:

```json
{ "plugins": { "dispatch": { "launch": [
  { "agent": "claude", "session": "<session id>", "from": "ilink", "prompt": "plain",
    "permissionMode": "acceptEdits", "allowedTools": ["mcp__1board", "Bash(python3 tools/share.py:*)"],
    "model": "claude-fable-5-2", "effort": "high", "timeoutSec": 600,
    "appendSystemPrompt": "…" } ] } } }
```

| key | meaning |
|---|---|
| `agent` (required) | the target's agent — only `claude` takes launch settings today |
| `session` / `cwd` / `from` | match: the target session id / the target session's directory / the sender's agent name |
| `permissionMode` | `default`, `acceptEdits`, `plan` or `dontAsk`. **Bypass-style modes are refused in code** (the profile is ignored, and the adapter refuses them again) |
| `allowedTools` | tool names (`mcp__1board`, `WebSearch`) or one fixed command prefix `Bash(<command>:*)`; a bare `Bash` is refused |
| `model`, `effort`, `timeoutSec` | `--model`, `--effort`, the time limit (a timeout under launch settings is final, not retried — the turn already ran) |
| `appendSystemPrompt` | `--append-system-prompt` (snapshot off, so a resumed session sees it too) |
| `prompt: "plain"` | only with `from`: the message is **you, in person**, through that channel plugin (e.g. `ilink`): handed over as is under one header line — no agent-to-agent envelope, no shared plan — and the agent's whole answer is the reply |

The directory a resumed session runs in is the one it was started in (Claude resumes only from its own project directory) — to run an agent in directory X, start that session in X once and target it, or give the profile a dedicated session (below).

More keys (ADR-055, ADR-056):

| key | meaning |
|---|---|
| `whenLive` | `"wait"` (default) or `"resume"` — see *Live sessions* below |
| `name` | a name for the profile (lowercase letters, digits, dashes); required with `dedicated` |
| `dedicated: true` (+ `name`, `cwd`) | the profile **owns a session of its own** — see *A dedicated session* below. No `session` with it |
| `resetNotice` | with `dedicated`: the line the first reply after a fresh start begins with (default: an English sentence saying earlier context is gone) |

##### Live sessions: `whenLive` (ADR-055)

"Live" is what the plugin can see: the session is open in an interactive `claude --resume=<id>` process (`ps`), or a running Claude Code / desktop session registered its Morse inbox, or `morse read --wait` follows it. It does **not** see a session opened some other way (`claude --continue`, a plain `claude` in that directory that was later switched to it) and it does not see another headless run (a second dispatcher, a cron job, the old bridge).

- `"wait"` (default, and what every agent-to-agent message gets): a live or monitored session is left alone — the message waits until it is closed and the open session can pick it up itself.
- `"resume"`: run the turn anyway, while the session is open. Use it for a channel profile (you on WeChat) where an answer now matters more than a tidy transcript — the standalone weixin-bridge always did this.

**The risk of `"resume"`.** Two Claude processes then write one session: the open one and the headless turn. Each keeps its own copy of the conversation in memory and appends to the same transcript (`~/.claude/projects/…/<id>.jsonl`). The open window does not see the WeChat turn until it is reloaded, and its next turn continues from its own last message — so the transcript branches, and whichever process writes last decides what the next resume sees: a WeChat exchange or a few turns typed on the computer can drop out of the context. If both run tools at once, they edit the same working tree. A turn into a busy session can also end non-zero although it ran (ADR-023); with `prompt: "plain"` that is not retried (no duplicate turn), you get the failure line instead. Keep `"resume"` for a session you do not normally work in — a dedicated one is the natural fit — and close it on the computer before typing in it there. A Claude Code session whose inbox is live is never rung for a message a `"resume"` profile runs, so it does not also pull it.

**One turn per session.** Whatever `whenLive` says, the plugin never runs two turns for the same session at once: a message whose session is busy waits for the turn before it (by arrival), also across processes (a lock file per session in `~/.morse/plugins/dispatch/locks/`). Different sessions run side by side — up to 4 at a time (`MORSE_DISPATCH_CONCURRENCY`) — so a 10-minute WeChat turn no longer holds up mail between your other sessions.

##### A dedicated session (ADR-056)

```json
{ "agent": "claude", "name": "wechat", "dedicated": true, "cwd": "/Users/you/work", "from": "ilink", "prompt": "plain", "whenLive": "resume", "…": "…" }
```

- Its Morse address is **`@dispatch:<name>`** (registered by the plugin, refreshed every 6 h). A channel plugin sends there instead of naming a session id — the iLink plugin with `"target": "@claude", "profile": "wechat"`. Mail to the session's current id directly gets the same settings and shares its one-turn lane.
- **Created on first use** in `cwd` (`claude -p --session-id <new id> …`), its id kept in the plugin's own state, `~/.morse/plugins/dispatch/state.json` (0600) — nothing in the mailbox.
- **Recreated when it is gone**: if the session cannot be resumed ("No conversation found" — deleted, or its files moved), a new one is started in `cwd` for that same message, and the reply begins with `resetNotice` — once. A first start is not a reset and says nothing.
- `morse plugin dispatch session` lists them; `morse plugin dispatch session <name> --set <session id>` continues an existing conversation (what `morse plugin ilink import` does with the bridge's session); `--clear` forgets it (the next message starts a new one).
- A message to `@dispatch:<name>` from a sender other than the profile's `from` gets the profile's launch settings with the ordinary agent envelope.

##### Failures for you in person

With `prompt: "plain"` a failed turn is final at once — no 30-second retries (the turn may have half run; you would rather know now): the message goes dead with the reason, and the channel plugin tells you once (the iLink plugin within a few seconds: "处理出错了…" / "处理超时了…"). An agent-to-agent message keeps the usual three tries.

#### Your own mail to an agent's inbox (ADR-061)

A message **from you** through another of your agent addresses (contact `self` — e.g. `morse send me "…"` typed on `me/air`) addressed to one of your agents but to no particular session lands in that agent's inbox. The dispatch plugin answers it in a **dedicated session per (my agent, sending agent)**, `self-<agent>-<peer agent>` (e.g. `self-mini-air`): created on first use, continued after, recreated and said once when it is gone, one turn at a time — the machinery of *A dedicated session* above. What you type through that agent address is handed over as you in person (the whole answer is the reply); a session of that agent gets the agent envelope. The answer goes back with `morse reply` in the same thread and the message is processed (`NOOP`: processed, nothing sent). A failed turn is retried after 30 s, at most 3 tries, then it stays in `morse read`. Backlog is never answered: mail that arrived before the loop first ran (recorded as `selfInboxSince` in `state.json`) or is older than `maxAgeMin` stays unprocessed in `morse read`, one log line each. Never another person's mail (not even a contact labelled `self`), never a request, never mail to a specific session or between sessions on this computer.

```json
{ "plugins": { "dispatch": {
  "selfInbox": { "enabled": true, "cwd": "/Users/you", "permissionMode": "default", "model": "sonnet", "timeoutSec": 600 },
  "launch": [ { "agent": "claude", "to": "inbox", "from": "air", "cwd": "/Users/you/work", "permissionMode": "acceptEdits" } ] } } }
```

- `selfInbox` — the default for every sending agent: `enabled` (default `true`; `false` = your inbox mail waits as before), `cwd` (default: your home directory — it is your own mail), `permissionMode` (default **`default`**, passed explicitly: your own Claude allow rules apply, anything that would ask is refused because nobody answers headless, and a bypass default in your Claude settings does not apply; use `acceptEdits` to let it edit files), `allowedTools`, `model`, `effort`, `timeoutSec`, `appendSystemPrompt`, `resetNotice`, `maxAgeMin` (default 60: older mail is never answered). Bypass-style modes are refused; a bad `selfInbox` switches the feature off with a log line.
- A `launch` entry with **`"to": "inbox"`** (optionally `from` = the sending agent's name, like `air`) wins over `selfInbox` — the one with `from` over one without. It takes the usual fields; no `session` / `dedicated` / `name` (the plugin keeps one session per sending agent), and it never matches a delivery to a session.
- `morse plugin dispatch session` lists these sessions next to the profiles' (`self-…`).

### The built-in `ilink` plugin (WeChat — off by default)

Protocol conversion between WeChat (Tencent's iLink bot API) and Morse: the WeChat side is **you**. A message you write to the bot becomes Morse mail from your own registered session `@ilink:wechat` (`ilink-wechat`, pull-only) to the agent you set as `plugins.ilink.target` (+ `profile`: a dedicated session of the dispatch plugin, `@dispatch:<profile>`); that agent's answer and anything your own agents send to `@ilink` go back to WeChat. Other people's Morse mail never does (with `notify_others`: one line, who and how many). `morse plugin enable ilink`, `morse plugin ilink login | status | simulate | import`. Everything about it: [PLUGIN-ILINK.md](PLUGIN-ILINK.md). Code: `src/plugins/ilink/` (only the plugin contract and `morse` commands).

### The built-in `attendant` plugin (your agent answers your contacts — on by default)

When a contact you have accepted (**not you**, not blocked) writes to one of your agents, your agent reads it in a session of its own per contact and decides whether to reply. Without a profile it is **conversation only** (ADR-066): no tools at all (`--tools ""`, no MCP, no skills), an empty directory of its own, a fast model (`sonnet`); when something needs you it writes an `ASK_OWNER:` line — you get a desktop notice, a line in `morse plugin attendant status` and a WeChat message when ilink is on, and the contact never sees the marker. When their group (or they) have a profile under `plugins.attendant`, it works inside that profile's one working directory and set of tools (`claude --restricted`, no MCP servers, your Claude settings ignored), with destructive or outward-facing actions stopping for your approval (`morse plugin attendant approvals | approve <id> | reject <id>` — only you, in your own terminal; never from inside an agent). Message requests from strangers never reach a session; blocked contacts, switched-off groups / contacts (`"enabled": false`) and your own mail are stored only; `"defaultProfile": false` makes contacts without a profile stored only, as before. Rate limits only if you set them (none by default, ADR-068), a loop guard against other attendants, burst coalescing, restart and lost-session recovery. On by default (`morse plugin disable attendant`); `morse plugin attendant status`. Everything about it: [PLUGIN-ATTENDANT.md](PLUGIN-ATTENDANT.md). Code: `src/plugins/attendant/`.

## 5. Rules for plugins

- Decide by `contact.group` / `contact.self` yourself; the core never will.
- Messages from other addresses (`foreign: true`) are information. A plugin that starts an agent for them is responsible for what that agent may do.
- Never answer an automatic answer (loops): mark your replies (the example starts them with `[auto]`) or use `contextId` to stop after one round.
- Never accept requests or change a contact's group unless the owner said so.

## 6. Example: auto-acknowledge your own agents

`plugins/examples/auto-ack.mjs` — answers "[auto] received" to messages from contacts in group `self` (your own devices) and to nobody else:

```js
#!/usr/bin/env node
// Example Morse plugin (docs/PLUGINS.md): answers "[auto] received" to messages from your
// own agents (contact group "self") and to nobody else. Uses only the public interface:
// `morse plugin watch --json` for events, `morse reply` for the action. Usage: auto-ack.mjs [--since <id>]
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [bin, ...pre] = (process.env.MORSE_CMD ?? 'morse').split(' ');
const morse = (...args) => execFileSync(bin, [...pre, ...args], { encoding: 'utf8' });
const watch = spawn(bin, [...pre, 'watch', '--json', ...process.argv.slice(2)], { stdio: ['ignore', 'pipe', 'inherit'] });

for await (const line of createInterface({ input: watch.stdout })) {
  const e = JSON.parse(line);
  if (e.type !== 'message' || e.direction !== 'in' || e.processed) continue; // new mail from an address
  if (e.contact?.group !== 'self') continue; // your own agents only — never other addresses
  if (e.text.startsWith('[auto]')) continue; // never answer an auto-reply (no loops)
  morse('reply', e.id, '[auto] received', '--by', 'plugin:auto-ack');
  console.error(`auto-ack: answered ${e.id}`);
}
```

Run it with `node plugins/examples/auto-ack.mjs` (it resumes with `--since <last id>`). `test/plugin-interface.test.ts` runs it end to end against a temporary HOME.
