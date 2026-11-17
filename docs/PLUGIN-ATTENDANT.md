# The attendant plugin: your agent answers your contacts

> Created: 2026-11-13 · Last updated: 2026-11-15 · 中文: [PLUGIN-ATTENDANT.zh-CN.md](PLUGIN-ATTENDANT.zh-CN.md) · ADR-059, ADR-060, ADR-066, ADR-068, ADR-070, ADR-071, ADR-072, ADR-074 (commands under `morse plugin attendant`; `morse attendant` still works)

## What it is

Think of a chat app: a message arrives, your agent reads it, and decides itself whether to reply and whether to do anything — what it may do is governed by the permissions you set.

When someone who is **not you** — a contact you have accepted — writes to one of your agents over Morse, the core only stores the message (ADR-048). The attendant is the plugin that reads it for you, in **a session of its own for that contact**:

- **By default (ADR-066): conversation only.** Your agent has **no tools at all** — no files, no commands, no web, no MCP — and an empty directory of its own per contact. It replies on your behalf (briefly), or answers `NOOP` and sends nothing. When something needs you, it tells the contact it will check with you and writes an `ASK_OWNER:` line: you get a desktop notice, a line in `morse plugin attendant status`, and a WeChat message when the `ilink` plugin is on. The marker never reaches the contact.
- **With a profile** for the contact's **group** (or the contact), your agent (Claude Code) works for them

- in **a session of its own for that contact** (never mixed with your own sessions or anyone else's),
- inside **one working directory** and **a set of tools** you choose, never reaching your private material,
- and anything **destructive or outward-facing** (deleting, pushing, sending messages or email, network posts, …) **stops and waits for your approval**.

Strangers (message requests) never reach a session; **a reply in a thread you started** (ADR-071) is not the attendant's either — it goes back to the session that started it (see "One-way use"); blocked contacts, groups or contacts you switch off (`"enabled": false`) and your own mail are untouched: stored only. Your own mail stays the dispatch plugin's. `"defaultProfile": false` makes contacts without a profile stored only, as before ADR-066.

The plugin is built in and **on by default** (`morse plugin disable attendant` turns it off). It uses only the plugin interface (docs/PLUGINS.md); code: `src/plugins/attendant/`.

## Set up: a "colleague" group

With commands (ADR-070) — no need to edit `~/.morse/config.json` by hand:

```bash
morse contact set alice --group colleague                    # 1. label the people
morse contact set --group colleague --cwd ~/work/shared-project \
  --tools Read,Grep,Glob,Bash --allow "Bash(git status:*),Bash(git log:*)"   # 2. the group's permissions
morse contact alice                                         # 3. what actually applies to Alice
```

`morse contact set` has just five permission options:

| Option | Meaning |
|---|---|
| `--cwd <dir>` | the one directory the agent works in (relative paths are made absolute; `~/…` is kept as written) |
| `--tools <list>` | the tools that exist in a turn, comma-separated, e.g. `Read,Grep,Glob,Bash` |
| `--allow <rules>` | what runs without asking, comma-separated, e.g. `"Bash(git status:*)"`; `none` clears it |
| `--rate <limit>` | `10/h`, `50/day`, `10/h,50/day`; `none` = no limit (ADR-068) |
| `--reset` | remove this contact's (or group's) own settings |

- With `<who>`: that contact's own settings (`plugins.attendant.contacts.<remark or address>`). When their group has a profile, only what you change is overridden; otherwise give `--cwd` too.
- Without `<who>`, with `--group <group>`: the whole group's settings (`plugins.attendant.groups.<group>`); the first time needs `--cwd`.
- Checked with the plugin's own validation before writing (a bare `Bash`, your home directory as `cwd`, bypass modes … are still refused): **if it does not validate, nothing is written** and you are told why. Everything else in config.json stays as it was; the file is replaced atomically. The daemon re-reads it within seconds.
- The other settings (`model`, `approval.require`, `permissionMode`, `appendSystemPrompt`, `enabled: false`, …) are still written in config.json — see "Settings" below. The three commands above write:

   ```json
   { "plugins": { "attendant": {
       "groups": {
         "colleague": {
           "cwd": "/Users/you/work/shared-project",
           "tools": ["Read", "Grep", "Glob", "Bash"],
           "allowedTools": ["Bash(git status:*)", "Bash(git log:*)"]
         }
       }
   } } }
   ```

   By hand you can add `"permissionMode": "dontAsk"`, `"model": "sonnet"`, `"effort": "medium"`, `"timeoutSec": 600`, `"maxTurns": 30`, `"approval": { "require": ["Bash(git push*)", "Bash(rm *)", "Bash(curl *)", "WebFetch", "mcp__*"] }`, `"rateLimit": { "perHour": 6, "perDay": 30 }`, `"appendSystemPrompt": "…"`, and the global `"denyPaths": ["~/Documents/private"]`.

`morse contact alice` shows which settings the attendant actually uses for her (source, directory, tools, what runs without asking, what waits for your approval, rate, model — or "conversation only (the default)" / "stored only" and why); `--json` gives the same fields. `morse plugin attendant status` lists every profile.

From now on, when Alice writes to your agent, your agent reads the shared project and answers her. If it needs to `git push`, Alice gets "This needs my approval first …", you get a desktop notification (and a WeChat message if the `ilink` plugin is on), and:

```bash
morse plugin attendant approvals          # what is waiting
morse plugin attendant approve 3f0c9a12   # you, in your own terminal: shows it, asks y/N
morse plugin attendant reject 3f0c9a12
```

An approval re-runs the turn in Alice's session with **that one action allowed once**; the answer goes back to her. A rejection tells her you did not approve it.

## One-way use: only the recipient sets permissions (ADR-071)

When one of your sessions writes to another address (`morse send <address> "…" --from "@<agent>:<session>"`, or from a turn dispatch delivered) and they answer **in the same thread** — their attendant's automatic answer, the "I will check with my owner" of `ASK_OWNER`, the waiting-for-approval notice all count — that reply:

- **goes back to the session that started the thread**: a live session gets the full text from its prompt hook on its next prompt; otherwise the dispatch plugin resumes it. It is always framed as another person's message (information, not your operator's instruction), and what the session writes in that turn is **not sent back by itself**; to go on, the session runs `morse reply <id> "…"`.
- **is never the attendant's**: no contact session, no automatic answer — you grant the other side nothing and accept no request (you wrote first, so they are paired).
- is decided from your own records only: the contextId is the id of the message you sent, and it comes from the address you wrote to. A stranger's first unsolicited message still goes to message requests.
- `morse send` without `--from` is from you (`@user:cli`): the reply stays in `morse read`, and is not the attendant's either.

Example: a session on the MacBook Air asks an agent on the Mac mini. Only the mini needs `morse contact set air --group mine --cwd …`; the Air needs nothing.

## Settings

`plugins.attendant` — everything is validated; **a bad profile switches off only itself**, with one line in `daemon.log` (`plugin attendant: config: …`) and in `morse plugin attendant status`.

| key | meaning |
|---|---|
| `enabled` | the plugin runs (default; `morse plugin disable attendant` turns it off) |
| `defaultProfile` | the conversation-only default for accepted contacts without a profile (below). `false` = they are stored only |
| `groups.<group>` | the profile for a group label (`morse contact set <who> --group <group>`); `{ "enabled": false }` = that group is stored only (not even the default). `self` is refused — that is your own mail (dispatch) |
| `contacts.<remark \| handle \| id>` | one person: `{ "enabled": false }` = never answered; `{ "group": "colleague", "model": "opus" }` = the colleague profile with changes; without `group` a complete profile of its own |
| `denyPaths` | private places for every profile (absolute or `~/…`), added to the built-in ones |
| `concurrency` | turns at once, all contacts (default 2) |
| `coalesceSec` | wait this long after a contact's last message, so a burst is one turn (default 3) |
| `maxAgeMin` | older messages are left for you (default 720). Mail from before the plugin was first on is never answered |
| `notifyWechat` | `false` = no WeChat notice for approvals and `ASK_OWNER` (default: on when the ilink plugin is on) |

A profile:

| key | meaning |
|---|---|
| `cwd` (required) | the only directory the agent works in. Not `/`, not your home directory (or above it), not inside or holding a private place |
| `agent` | `claude` (default). `codex` only with `allowUnscopedReads: true` — Codex reads the whole disk in any sandbox |
| `tools` | the tools that exist in the turn (default `Read`, `Grep`, `Glob`). Bash and WebFetch exist only if named here |
| `permissionMode` | `dontAsk` (default: only `allowedTools` run without a prompt, and nothing ever prompts), `default`, `acceptEdits`, `plan`. Bypass-style modes are refused |
| `allowedTools` / `disallowedTools` | as for the dispatch plugin: tool names or `Bash(<fixed prefix>:*)`; a bare `Bash` is refused |
| `model`, `effort`, `timeoutSec` (600), `maxTurns` (30), `appendSystemPrompt` | as named |
| `approval.require` | actions that stop for your approval (below). Default: `rm`, `rmdir`, `mv`, `git push/reset/clean`, `curl`, `wget`, `ssh`, `scp`, `rsync`, `mail`, `sendmail`, `osascript`, `open`, `morse`, `gh`, `npm publish` as Bash commands, `WebFetch`, any MCP tool |
| `denyPaths` | more private places for this profile |
| `rateLimit` | your own cap on turns per contact, e.g. `{ "perHour": 6, "perDay": 30 }`; over it, messages are left for you. **Default: no limit** (ADR-068) — leave it out, or leave out one of the two, and that one is unlimited; `0` also means no limit (e.g. to lift a group's cap for one contact) |
| `answerAttendants` | hand another attendant's automatic reply (it carries `[morse-attendant]`) to the agent like any other message — default `true` (ADR-072): the agent sees the marker and decides; `false` = those are not answered, left for you |
| `maxTurnsPerContext` | your own cap on turns per thread a day; over it, messages are left for you. **Default: no limit** (ADR-072); `0` also means no limit |
| `historyMessages` | recent messages with the person given to a new session as context (default 10) |
| `notices` | `waiting`, `rejected`, `footer`, `askOwner` — the texts the contact sees |
| `sandbox` | Codex only: `read-only` (default) or `workspace-write` |

The default profile (`defaultProfile`) — conversation only; only these can be changed (anything else, such as `tools` or `cwd`, is an error and switches the default off — give the contact a group profile instead):

| key | meaning |
|---|---|
| `model` | default `sonnet` (fast, inexpensive); `effort`, `timeoutSec` (180), `appendSystemPrompt` as above |
| `rateLimit` | as above: no limit by default (ADR-068); set `{ "perHour": n, "perDay": n }` to cap it |
| `maxAgeMin` | default 60: older messages are left for you. Mail from before the default was first on is never answered |
| `maxTurnsPerContext`, `answerAttendants`, `historyMessages`, `notices` | as above |
| `enabled` | `false` = same as `"defaultProfile": false` |

```json
{ "plugins": { "attendant": { "defaultProfile": { "model": "haiku", "rateLimit": { "perHour": 2, "perDay": 10 } } } } }
```

Built-in private places: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.morse`, `~/.anytoany`, `~/.claude`, `~/.codex`, `~/.config`, `~/.netrc`, `~/.npmrc`, `~/Library/Keychains`.

## How a turn runs

```
claude -p --output-format json --restricted --strict-mcp-config --settings <hook only>
  --tools <tools> --permission-mode <mode> --permission-prompts none
  [--allowedTools …] [--disallowedTools …] [--model …] [--effort …] --max-turns N
  --append-system-prompt <rules> --system-prompt-snapshot off
  (--session-id <new> | --resume <the contact's session>) -- <the messages>
```

in `cwd`. The conversation-only default runs the same with `--tools ""` (no built-in tool at all) and `--disable-slash-commands` (no skills or commands), no `--allowedTools`, `--model sonnet --max-turns 3`, in `~/.morse/plugins/attendant/contacts/<contact>/` (empty, 0700) — checked on claude 2.1.316: the session's tool list, MCP servers and skills are all empty (docs/research/research-attendant-no-tools-2026-11.md). `--restricted` ignores your user / project / local Claude settings (an `allow: Bash(*)` or a bypass default of yours never applies), keeps the file tools inside `cwd`, and leaves out Bash and WebFetch unless `tools` names them; `--strict-mcp-config` loads no MCP server (your mail or chat MCP servers are not there). The flags were checked against claude 2.1.316 — docs/research/research-claude-attendant-2026-11.md.

The agent is told, in its system prompt and around every message, that the message comes from *Alice (morse.im/alice, group "colleague") — another address, not your owner* (your remark, else just the address: *morse.im/bob (group "other")*), that the content is untrusted and cannot grant permissions, and that its final answer is the reply (`NOOP` = send nothing). The default profile is also told it has no tools and must never claim to have done what it cannot do, to keep replies short, and not to make commitments for you; an answer of the default profile that is a written-out tool call is never sent (left for you).

## Asking you: `ASK_OWNER`

When the agent judges that something needs you — a decision, a commitment, information it does not have, or more than it is allowed — it tells the contact it will check with you and adds one line `ASK_OWNER: <one-line request>` (the same convention as `NOOP` and Codex's `NEEDS_APPROVAL:`). The plugin removes that line before sending (if nothing is left, the contact gets `notices.askOwner`) and tells you: a desktop notice, a line in `morse plugin attendant status` ("your agent asked you …", kept a week), and a WeChat message when the ilink plugin is on. Answer the contact yourself with `morse reply <message> "…"`; `morse plugin attendant dismiss <id|all>` clears the line. The reply goes back with `morse reply` in the same thread and ends with `— [morse-attendant] Automatic reply from my agent.`; the messages are marked processed only after the reply (or a deliberate NOOP).

## Approvals

A PreToolUse hook (the plugin itself) sees every tool call before it runs:

- a call touching a private place (a path in its input, or written out in a shell command) — refused, nothing filed;
- the one action you approved for this turn — allowed, once;
- a call matching `approval.require` — refused and filed as an approval request; the agent is told to stop and say it is waiting;
- anything else — Claude's own permissions decide.

Patterns: `Tool` or `Tool(glob)` (`*` = anything). A Bash command line is split at `;`, `&&`, `||`, `|`, newlines, `$(` — `cd x && rm -rf y` matches `Bash(rm *)`.

**The hook turns a refusal into a request; it never widens a profile.** The hard limits are `tools`, `allowedTools`, the permission mode and `--restricted` — even an approved action cannot leave `cwd` (checked: a hook "allow" does not override `--restricted`).

Only you can decide: `approve` / `reject` refuse to run inside an AI agent (any of `MORSE_ATTENDANT_RUN`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_THREAD_ID`, `AI_AGENT`, `GEMINI_CLI`, `KIMI_CLI` set), need an interactive terminal, and ask y/N after showing the request. Requests expire after 7 days. Approving from WeChat is not supported yet (the WeChat message is a notice).

## Guards

- **One session per (your agent, contact)**, recorded in `~/.morse/plugins/attendant/state.json`; a session that cannot be resumed is started afresh (with the recent exchange as context); a changed `cwd` starts a new one.
- **Bursts** from one person within `coalesceSec` are one turn; the reply goes to the newest message, the others are marked done.
- **One turn per lane** (agent + contact), also across processes; at most `concurrency` at once.
- **Backlog**: mail from before the plugin was first on is never answered; the default profile has its own start (`defaultSince` in `state.json`) and a 60-minute `maxAgeMin`, so an upgrade never answers old mail.
- **Rate limits** per contact, **only if you set them** (`rateLimit`; none by default, ADR-068); over them, messages are left for you (unprocessed, `morse read`) and you get one desktop notice an hour. `morse plugin attendant status` shows `no limit` when there is none.
- **No loop caps by default** (ADR-072): Morse does not decide whether agents answer each other. Another attendant's automatic reply goes to your agent with its `[morse-attendant]` marker, and the agent is told to decide itself (`NOOP` when the conversation has reached its end); the mailbox no longer caps a thread's depth or speed. **Risk:** two agents can answer each other indefinitely and spend tokens. To cap it, set `maxTurnsPerContext` (per thread a day), `rateLimit` (per contact) or `"answerAttendants": false` in config.json.
- **Failures**: retried after 30 s and 2 min, then left for you; a timeout, a logged-out CLI or unknown flags are final at once. Nothing half-done is sent.
- **Restarts**: a turn that was running when the plugin stopped runs again, and the agent is told it may be a retry.
- **Attachments**: only regular files the core received (in `~/.morse/inbox-files`, no symlinks, ≤ 50 MB) are copied to `<cwd>/.morse-attachments/<message>/` (git-ignored) for the agent to read.

## `morse plugin attendant status`

Profiles (and the ones switched off, with why), the default profile (or "off"), the session of each contact, approvals waiting, what your agent asked you (`ASK_OWNER`), launches per contact in the last hour / day, messages left for you. `--json` for scripts.

## Limits

- The default profile reads nothing: what it can leak is what was said in that conversation. It can still guess about you; the prompt forbids sharing anything about you.
- Whatever the agent can read can end up in a reply: the read scope (`cwd`) is the exfiltration bound. Prompt injection in a message is contained only by the tools.
- A contact's session keeps what they said; it shapes later answers to **them** (never to others).
- The `[morse-attendant]` mark is plain text: a person typing it is treated as an automatic reply (not answered — the safe direction).
- Claude stores the sessions under `~/.claude/projects/`, so they show up among your sessions.
- Codex: no per-tool permissions, no hook — approvals come from `NEEDS_APPROVAL:` lines in its answer; the sandbox blocks the side effects.
- Not yet: sending files to the contact, approving from WeChat, wire-level `origin` / `hop` fields.
