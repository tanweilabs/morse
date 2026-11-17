---
name: reload
description: Show the recent cross-agent (Morse) exchange in THIS session — what other agent sessions sent and replied — without restarting the app. Use when the user types /reload, $reload, says "reload", "刷新", "拉一下消息", "看看发生了啥", "有没有漏的", or otherwise wants to see cross-agent activity they can't see in this app. Needed in Codex / Kimi / Z Code, whose interactive UI does not reliably show messages delivered in headless turns (a known Codex bug, openai/codex#28259).
---

# reload — bring the cross-agent exchange into view

Why this exists: Codex, Kimi and Z Code hand cross-agent messages to your session in a **headless turn**, and their app often does not redraw afterwards, so the operator never sees them (for Codex this is a known bug, [openai/codex#28259](https://github.com/openai/codex/issues/28259)). Nothing is lost — every message is in the mailbox on disk. What you do here is copy that exchange into the conversation the operator can actually read.

## The operator wants to see what went on

Triggers: `/reload`, `$reload`, "reload", "刷新", "拉一下消息", "看看发生了啥", "有没有漏的", or plain `morse read --pull` reported nothing new but they clearly want to review.

**Step 1 — get the recap:**
```bash
morse read --pull --history
```

It shows the latest exchange with other sessions **in full**: what was sent and what came back, oldest first, failed and `dead` messages included. It only reads — it does not move any "seen" marker and does not mark anything handled. `--limit N` changes how many messages it goes back.

**Step 2 — put the output where the operator can see it.** This is the step that usually goes wrong. In Codex, Kimi and Z Code the output of a command you run is folded away, out of the operator's sight; a summary, or "see the output above", leaves them with an empty screen and reload looks broken. Therefore:

- Copy the **whole** output, word for word, into your reply as a fenced code block. You may add one short line after it at most (for example, which messages are `dead` or were never delivered).
- Do not answer those messages again and do not redo their work: they were handled when they arrived. The recap is for reading only.

## Messages you still have to act on

That is a separate job. To pick up messages nobody has handled yet, so that you can do the work, run `morse read --pull` (plain). Pending messages are injected in full — act on each per the Morse protocol (`morse reply <id> …` or the `<<<ANYTOANY_REPLY>>> DONE/BLOCKED` verdict). An "Activity digest" is FYI only — do not re-run it.

Run `morse read --pull --quiet` **proactively** (silent when nothing new) at the start of a turn while working with a peer, right after messaging a peer, or when the operator asks about another agent.

## Good to know

- The older `morse pull` still works the same.
- Works with the `morse` daemon down — it reads the mailbox on disk. That's the point: it's a disk pull, minus the restart.
- Auto-detects your session by the current directory. If it can't (you changed dirs, or several sessions share the dir), pass it: `morse read --pull --history --session "@<agent>:<fragment>"` (find yourself in `morse list`).
