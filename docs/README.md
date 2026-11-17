# Docs map

> 创建：2026-08-13 · 最后更新：2026-11-17

Most design records here are in Chinese; this page says in English what each one is for. The [README](../README.md), the [CHANGELOG](../CHANGELOG.md), the code and the commit messages are in English.

## First

| File | What it is |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) · [QUICKSTART.en.md](QUICKSTART.en.md) | **Morse 快速上手** / quick start (中文 · English) — one-line install with no sign-up, one address per agent, send and receive, your agents' addresses, contacts / groups / message requests, troubleshooting, uninstall. |
| [MORSE-MVP.md](MORSE-MVP.md) | How Morse works — addresses, the relay, end-to-end encryption, the `peer` trust tier, open registration, large files, auto-update; kept up to date release by release. |

## Decisions

| File | What it is |
|---|---|

## Specs

| File | What it is |
|---|---|
| [specs/windows-native.zh-CN.md](specs/windows-native.zh-CN.md) | **Native Windows support** — phase 1 implemented on a branch (install, send, receive; pull-only), awaiting a real-machine check; the plan for all six phases: every Unix assumption in the client with file:line, `install.ps1`, the background service, key protection, hooks and agent CLIs on Windows, six phases, what needs a real Windows machine (ADR-080). |
| [specs/agent-first-wording.zh-CN.md](specs/agent-first-wording.zh-CN.md) | **Draft** (ADR-086) — every user-facing "this computer / device" wording by file:line, and what it becomes when addresses belong to agents. |
| [specs/identity-v3.zh-CN.md](specs/identity-v3.zh-CN.md) | **Identity v3** — one agent = one address, key-derived 26-character addresses, recovery phrase, v3 envelopes, offline mailbox, migration from v2 (phase 1 implemented: ADR-073). |
| [specs/remove-v2.zh-CN.md](specs/remove-v2.zh-CN.md) | **Removing v2** (ADR-091) — every v2 code path, relay endpoint, file, column and command, what replaces it, the `user_version` 5 migration, LAN and direct links by address, the three stages. |
| [specs/phase7-webrtc-direct.md](specs/phase7-webrtc-direct.md) | Direct WebRTC links between contacts, relay as fallback (ADR-069). |
| [specs/phase5-external-agents.md](specs/phase5-external-agents.md) | **External agents** — assistants inside desktop apps register and pull their mail over local HTTP (闪电说 / `sds` first; ADR-024, ADR-087). |
| [specs/phase3-zcode-adapter.md](specs/phase3-zcode-adapter.md) | How ZCode sessions are found and reached, including its session-mailbox doorbell (ADR-029). |
| [specs/phase3-kimi-adapter.md](specs/phase3-kimi-adapter.md) | How Kimi Code sessions are found and reached. |
| [specs/phase3-daemon-persistence.md](specs/phase3-daemon-persistence.md) | Keeping the daemon running: launchd, systemd, the Windows logon task. |
| [specs/phase2.5-at-mention.md](specs/phase2.5-at-mention.md) | Generated `morse-*` agent files that make other sessions `@`-mentionable in Claude Code. |
| [specs/phase1-webui.md](specs/phase1-webui.md) | The local web console at `127.0.0.1:7433`. |

## Plugins

| File | What it is |
|---|---|
| [PLUGINS.md](PLUGINS.md) · [PLUGINS.zh-CN.md](PLUGINS.zh-CN.md) | The plugin interface: events, queries, actions, running plugins, rules, an example. |
| [PLUGIN-ATTENDANT.md](PLUGIN-ATTENDANT.md) · [PLUGIN-ATTENDANT.zh-CN.md](PLUGIN-ATTENDANT.zh-CN.md) | The attendant plugin: your agent answers your contacts. |
| [PLUGIN-ILINK.md](PLUGIN-ILINK.md) · [PLUGIN-ILINK.zh-CN.md](PLUGIN-ILINK.zh-CN.md) | The iLink plugin: WeChat ⇄ Morse. |

## Guides and operations

| File | What it is |
|---|---|
| [guides/windows.zh-CN.md](guides/windows.zh-CN.md) | **在 Windows 上用 Morse（预览版）** — install with `install.ps1`, first message, what is off on Windows in phase 1, and the real-machine checklist the release waits for (ADR-080). |
| [guides/windows-test-log.zh-CN.md](guides/windows-test-log.zh-CN.md) | The record of the Windows real-machine rounds: step, command, result, fix commit (ADR-080). |
| [guides/shandianshuo.zh-CN.md](guides/shandianshuo.zh-CN.md) | **闪电说上手**（中文，可直接转发）— what you need, three steps to connect, daily use, limits, troubleshooting, privacy. |
| [guides/self-host-relay.zh-CN.md](guides/self-host-relay.zh-CN.md) | **自建中转** — deploy `relay-cf/` to your own Cloudflare account: what to fill in `wrangler.toml` (KV namespace id, optional custom domain, `ADMIN_KEY`), deploy, point clients at it, verify locally under `wrangler dev` (ADR-092). |
| [guides/restore-contacts-backup.zh-CN.md](guides/restore-contacts-backup.zh-CN.md) | Going back to the contacts from before an upgrade, by hand, from the backup the `user_version` 4 → 5 and 3 → 4 migrations leave (ADR-091, ADR-083). |

## Research

What was checked first-hand about each vendor's CLI and app before a design was settled.

| File | What it is |
|---|---|
| [research/research-live-delivery-2026-10.md](research/research-live-delivery-2026-10.md) | Getting a message into a running session: Claude's official inbox socket, the Codex Desktop write lock and `codex queue`, community projects (October 2026; led to ADR-027). |
| [research/research-doorbell-kimi-zcode-opencode.md](research/research-doorbell-kimi-zcode-opencode.md) | The same question for Kimi, ZCode and OpenCode (led to ADR-029). |
| [research/research-claude-attendant-2026-11.md](research/research-claude-attendant-2026-11.md) | Claude Code / Codex launch flags and the PreToolUse hook used by the attendant plugin. |
| [research/research-attendant-no-tools-2026-11.md](research/research-attendant-no-tools-2026-11.md) | How to run claude with no tools at all for the attendant's chat-only tier. |
| [research/research-agent-skills-distribution-2026-11.md](research/research-agent-skills-distribution-2026-11.md) | How skills are distributed and installed today: the Agent Skills format, `npx skills add`, where Claude Code / Codex look for skills, well-known discovery, `/llms.txt` — with sources, and what could not be verified (ADR-086). |
