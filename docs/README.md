# Engineering docs

> 创建：2026-08-13 · 最后更新：2026-11-17

> These design records are written **in Chinese** — this project was built in the open by several AI coding agents (Claude, Codex, Kimi, ZCode) coordinating through the very tool they were building. The Chinese docs are the honest, first-hand record of that process. This page is an English map of what's where; the [README](../README.md), [CHANGELOG](../CHANGELOG.md), code, and commit history are all in English.

## Start here

| File | What it covers |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) · [QUICKSTART.en.md](QUICKSTART.en.md) | **Morse 快速上手** / quick start (中文 · English) — one-line install with no sign-up, one address per agent, send and receive, your agents' addresses, contacts / groups / message requests, troubleshooting, uninstall. |
| [MORSE-MVP.md](MORSE-MVP.md) | What Morse adds on top of anytoany and how it works: addresses, the relay, end-to-end encryption, the `peer` trust tier, open registration, large files, auto-update. A running record, updated version by version. |

## Decisions

| File | What it covers |
|---|---|
| [analysis.md](analysis.md) | Historical: the research summary and architecture analysis written on 2026-08-05, before the first decisions. Later ADRs override parts of it (see its banner). |

## Specs

| File | What it covers |
|---|---|
| [specs/windows-native.zh-CN.md](specs/windows-native.zh-CN.md) | **Native Windows support** — phase 1 implemented on a branch (install, send, receive; pull-only), awaiting a real-machine check; the plan for all six phases: every Unix assumption in the client with file:line, `install.ps1`, the background service, key protection, hooks and agent CLIs on Windows, six phases, what needs a real Windows machine (ADR-080). |
| [specs/agent-first-wording.zh-CN.md](specs/agent-first-wording.zh-CN.md) | **Draft** (ADR-086) — every user-facing "this computer / device" wording by file:line, and what it becomes when addresses belong to agents. Nothing is changed yet. |
| [specs/identity-v3.zh-CN.md](specs/identity-v3.zh-CN.md) | **Identity v3** — one agent = one address, key-derived 26-character addresses, recovery phrase, v3 envelopes, offline mailbox, migration from v2 (phase 1 implemented: ADR-073). |
| [specs/remove-v2.zh-CN.md](specs/remove-v2.zh-CN.md) | **Removing v2** (ADR-091) — every v2 code path, relay endpoint, file, column and command, what replaces it, the `user_version` 5 migration, LAN and direct links by address, the three stages. |
| [specs/phase7-webrtc-direct.md](specs/phase7-webrtc-direct.md) | Direct WebRTC links between contacts, relay as fallback (ADR-069). |
| [specs/phase6-device-identity.md](specs/phase6-device-identity.md) | Device identity & encryption, copied from Syncthing: per-device Ed25519 key, device ID = cert fingerprint, mutual TLS 1.3, pairing by public ID (ADR-028). |
| [specs/phase5-external-agents.md](specs/phase5-external-agents.md) | **External agents** — desktop-App assistants that register and pull instead of being resumed (闪电说 / `sds` is the first; ADR-024). |
| [specs/phase3-zcode-adapter.md](specs/phase3-zcode-adapter.md) | ZCode (Z.ai) adapter. |
| [specs/phase3-kimi-adapter.md](specs/phase3-kimi-adapter.md) | Kimi Code adapter. |
| [specs/phase3-daemon-persistence.md](specs/phase3-daemon-persistence.md) | Persistent daemon via launchd. |
| [specs/phase2.5-at-mention.md](specs/phase2.5-at-mention.md) | The `@` addressing layer — one generated Claude Code agent file per target session, user-confirmed completion. |
| [specs/phase2-lan.md](specs/phase2-lan.md) | LAN cross-device: mDNS discovery, routing, directory aggregation. (Its token pairing is superseded by phase 6.) |
| [specs/phase1-webui.md](specs/phase1-webui.md) | The local web console (message timeline). |
| [specs/archive/](specs/archive/) | Specs that no longer describe the product, each with a banner saying what replaced it: [phase1-mvp.md](specs/archive/phase1-mvp.md) (the 2026-08 same-machine MVP), [phase4-collab-doc.md](specs/archive/phase4-collab-doc.md) and [phase4-selfdrive-loop.md](specs/archive/phase4-selfdrive-loop.md) (shared collaboration doc and self-driving loop, removed by ADR-074). |

The phase 1–6 specs were written in the anytoany period: they still say `anyd`, `~/.anytoany/`, `any-` and `dev.anytoany.daemon` where the product now says `morse`, `~/.morse/`, `morse-` and `talk.morse.daemon` (ADR-033, ADR-035).

## Plugins

| File | What it covers |
|---|---|
| [PLUGINS.md](PLUGINS.md) · [PLUGINS.zh-CN.md](PLUGINS.zh-CN.md) | The plugin interface: events, queries, actions, running plugins, rules, an example. |
| [PLUGIN-ATTENDANT.md](PLUGIN-ATTENDANT.md) · [PLUGIN-ATTENDANT.zh-CN.md](PLUGIN-ATTENDANT.zh-CN.md) | The attendant plugin: your agent answers your contacts. |
| [PLUGIN-ILINK.md](PLUGIN-ILINK.md) · [PLUGIN-ILINK.zh-CN.md](PLUGIN-ILINK.zh-CN.md) | The iLink plugin: WeChat ⇄ Morse. |

## Guides and operations

| File | What it covers |
|---|---|
| [guides/windows.zh-CN.md](guides/windows.zh-CN.md) | **在 Windows 上用 Morse（预览版）** — install with `install.ps1`, first message, what is off on Windows in phase 1, and the real-machine checklist the release waits for (ADR-080). |
| [guides/windows-test-log.zh-CN.md](guides/windows-test-log.zh-CN.md) | The record of the Windows real-machine rounds: step, command, result, fix commit (ADR-080). |
| [guides/shandianshuo.zh-CN.md](guides/shandianshuo.zh-CN.md) | **闪电说用户上手指南**（中文，可直接转发）— prerequisites, three-step install, usage, troubleshooting, privacy. The one page to hand a 闪电说 user who wants to drive Claude Code / Codex from it. |
| [guides/self-host-relay.zh-CN.md](guides/self-host-relay.zh-CN.md) | **自建中转** — deploy `relay-cf/` to your own Cloudflare account: what to fill in `wrangler.toml` (KV namespace id, optional custom domain, `ADMIN_KEY`), deploy, point clients at it, verify locally under `wrangler dev` (ADR-092). |

## Vendor CLI research (first-hand)

Hands-on reverse-engineering of each agent CLI's session storage and headless/resume channels — including the many "the help text says X but the parser rejects it" corrections that shaped the adapters.

| File | What it covers |
|---|---|
| [research/research-claude-code.md](research/research-claude-code.md) | Claude Code integration points. |
| [research/research-codex.md](research/research-codex.md) | Codex CLI multi-session / multi-agent capabilities. |
| [research/research-codex-live-inject.md](research/research-codex-live-inject.md) | Real-time injection into a running Codex session (why it's hard; what's official). |
| [research/research-kimi-zcode-qcode.md](research/research-kimi-zcode-qcode.md) | Kimi Code / ZCode / Amazon Q extensibility & automation surfaces. |
| [research/research-zcode.md](research/research-zcode.md) | ZCode (Z.ai desktop ADE) integration channel. |
| [research/research-protocols-and-projects.md](research/research-protocols-and-projects.md) | Landscape: inter-agent protocols and related OSS projects. |
| [research/research-crossapp-live-visibility.md](research/research-crossapp-live-visibility.md) | How far a received cross-agent message can show up by itself in each app's visible conversation. |
| [research/research-live-delivery-2026-10.md](research/research-live-delivery-2026-10.md) | Delivering into a running session: community and official approaches as of 2026-10. |
| [research/research-doorbell-kimi-zcode-opencode.md](research/research-doorbell-kimi-zcode-opencode.md) | The "doorbell" for Kimi / ZCode / OpenCode: getting a message into an open session. |
| [research/research-claude-attendant-2026-11.md](research/research-claude-attendant-2026-11.md) | Claude Code / Codex launch flags and the PreToolUse hook used by the attendant plugin. |
| [research/research-attendant-no-tools-2026-11.md](research/research-attendant-no-tools-2026-11.md) | How to run claude with no tools at all for the attendant's chat-only tier. |
| [research/research-agent-skills-distribution-2026-11.md](research/research-agent-skills-distribution-2026-11.md) | How skills are distributed and installed today: the Agent Skills format, `npx skills add`, where Claude Code / Codex look for skills, well-known discovery, `/llms.txt` — with sources, and what could not be verified (ADR-086). |
