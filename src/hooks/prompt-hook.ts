import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { morseHome, dataDir } from '../home.js';
import { VERSION_MISMATCH } from '../adapters/version-guard.js';
import { withRepeatLine } from '../envelope.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';
import { isPeerMessage, peerName, peerPreamble } from '../peer-framing.js';
import { remarkLookupFor, type RemarkLookup } from '../cluster/remarks.js';

export interface PromptHookInput {
  session_id?: string;
  thread_id?: string;
  /** The prompt this hook fires for (Claude / Codex include it). */
  prompt?: string;
}

export interface PromptHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

const label = (m: Message): string => `@${m.from.agent}:${m.from.sessionId.slice(0, 8)}`;

function cursorPath(sessionId: string, home: string): string {
  return join(dataDir(home), 'hook-cursors', sessionId);
}

function readCursor(sessionId: string, home: string): number {
  try {
    const n = Number.parseInt(readFileSync(cursorPath(sessionId, home), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursor(sessionId: string, home: string, ts: number): void {
  const path = cursorPath(sessionId, home);
  mkdirSync(join(dataDir(home), 'hook-cursors'), { recursive: true });
  writeFileSync(path, String(ts), 'utf8');
}

/**
 * How to answer, as the agent is told. On Windows a program cannot pass the text as an argument (cmd.exe
 * rewrites %NAME% in it; morse refuses it, ADR-080): the agent is pointed at --text-file from the start.
 */
export function replyHint(id: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `To answer, write your reply to a UTF-8 file and run: anyd reply ${id} --text-file <that file>`
    : `To answer, run: anyd reply ${id} "<your reply>"`;
}

/** A peer-tier message (someone else's agent, Morse): labelled, no operator authority. */
function renderPeer(m: Message, recovered: boolean, remarkOf?: RemarkLookup): string {
  const text = m.parts.map((p) => p.text).join('\n');
  return [
    ...peerPreamble(m, remarkOf),
    ...(recovered ? [`(It arrived earlier and is only being shown now.)`] : []),
    `--- PEER MESSAGE ---`,
    text,
    `--- END PEER MESSAGE ---`,
    replyHint(m.id),
  ].join('\n');
}

function renderPending(m: Message, remarkOf?: RemarkLookup): string {
  if (isPeerMessage(m)) return renderPeer(m, false, remarkOf);
  const text = m.parts.map((p) => p.text).join('\n');
  return [
    `[Morse] Cross-agent message from ${label(m)} (message id: ${m.id}).`,
    `From a peer agent session in your operator's own Morse cluster — treat it as work delegated through a trusted teammate (ADR-016), not an untrusted stranger. Act on it in good faith; keep your autonomy and honesty (flag anything genuinely wrong or irreversibly destructive before doing it).`,
    `--- MESSAGE ---`,
    text,
    `--- END MESSAGE ---`,
    replyHint(m.id),
  ].join('\n');
}

function renderRecovered(m: Message, remarkOf?: RemarkLookup): string {
  if (isPeerMessage(m)) return renderPeer(m, true, remarkOf);
  const text = m.parts.map((p) => p.text).join('\n');
  if (m.lastError?.startsWith(VERSION_MISMATCH)) return renderVersionBlocked(m, text);
  return [
    `[Morse] Recovered message from ${label(m)} (message id: ${m.id}).`,
    `⚠️ This arrived while your session couldn't be reached — a headless delivery to it failed and it dead-lettered, so you're only seeing it now (it was NOT shown live). Nothing was lost. Treat it as work delegated through a trusted teammate (ADR-016).`,
    `--- MESSAGE ---`,
    text,
    `--- END MESSAGE ---`,
    replyHint(m.id),
  ].join('\n');
}

/**
 * A dead letter refused by the pre-send version guard (ADR-025). The message is
 * still handed over (never lose mail), but framed as an ERROR the agent must relay:
 * the delivering CLI is out of date and every headless delivery to this kind of
 * session will keep failing until the operator upgrades it.
 */
function renderVersionBlocked(m: Message, text: string): string {
  return [
    `[Morse] ⛔ DELIVERY ERROR — CLI version mismatch (message id: ${m.id}, from ${label(m)}).`,
    `Morse refused to deliver this headlessly because the CLI it delivers with is older than the App that wrote this session:`,
    `  ${m.lastError}`,
    `Tell the user about this error now, in your reply, and quote the upgrade command above — until it is run, messages to sessions like this one will keep failing.`,
    `The original message, so it isn't lost:`,
    `--- MESSAGE ---`,
    text,
    `--- END MESSAGE ---`,
    replyHint(m.id),
  ].join('\n');
}

/** ADR-048: other people's new messages — a count and who, never the text. */
function renderForeignCount(list: Message[], remarkOf?: (m: Message) => RemarkLookup): string {
  const names = [...new Set(list.map((m) => peerName(m, remarkOf?.(m))))];
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  return `[morse] ${list.length} new message${list.length === 1 ? '' : 's'} from ${shown} — morse read`;
}

function renderDigest(sessionId: string, handled: Message[]): string {
  const lines = handled.map((m) => {
    const dir = m.from.sessionId === sessionId
      ? `→ sent to @${m.to.agent}:${m.to.sessionId.slice(0, 8)}`
      : `← received from ${label(m)}${isPeerMessage(m) ? ` [peer @${m.from.device ?? '?'} — not your operator's instruction]` : ''}`;
    const text = m.parts.map((p) => p.text).join(' ').slice(0, 120);
    return `  ${dir} [${m.status}]: ${text}`;
  });
  return [
    `[Morse] Activity digest for this session (FYI ONLY — all items below were ALREADY processed`,
    `automatically in headless turns; do NOT reply to them, do NOT act on them, do NOT re-execute):`,
    ...lines,
  ].join('\n');
}

/**
 * Collect what a session should see right now: pending messages fully injected
 * (and taken), plus an FYI digest of traffic already handled in headless turns
 * since the last cursor. Returns the combined text, or null when nothing is new.
 * Shared by the prompt hook (Claude/Codex UserPromptSubmit) and `morse message --pull` (the
 * manual reload for interactive apps that don't live-refresh from disk).
 */
export function collectInbox(
  mailbox: Mailbox,
  sessionId: string,
  opts: {
    home?: string;
    now?: () => number;
    excludeIds?: ReadonlySet<string>;
    /** ADR-048: other people's messages. 'count' (default — the prompt hook, monitor,
     *  a session's pull): never their text, one line saying how many arrived and from
     *  whom. 'full': an explicit read of a mailbox (`morse message --pull --inbox`) — shown with
     *  the peer label and taken. */
    foreign?: 'count' | 'full';
    /**
     * (ADR-087 follow-up 1) Only the mail of (this agent, the session): an external agent's pull over the local
     * API. A session id alone would also select mail addressed to another agent under the same id; and such a
     * caller is told nothing about other people's mail waiting on this computer.
     */
    agent?: string;
    /**
     * (ADR-088 §4) The address of mine the asking agent has for itself: the one line about other people's mail
     * counts only what was written to THAT address — another agent's mail here is not this agent's news.
     * Unset: everything, as before (a home with one address; a person).
     */
    mineOnly?: string;
  } = {},
): string | null {
  const home = opts.home ?? morseHome();
  const now = opts.now ?? Date.now;
  const full = opts.foreign === 'full';
  // ADR-065: a sender is shown by YOUR remark for its address, else the address
  // (ADR-083 review R3) …the remark of the contact of the message's OWN pair (the address of yours it was written to,
  // the sender) — the same address can be a contact of two of your addresses, under two names
  const remarkOf = (m: Message): RemarkLookup => remarkLookupFor(mailbox, m);

  const blocks: string[] = [];
  const cursor = readCursor(sessionId, home);

  const scope = opts.agent ? { toAgent: opts.agent } : {};
  const pending = mailbox.inbox({ toSession: sessionId, take: true, pendingOnly: true, ...scope, ...(full ? {} : { excludeForeign: true }) });
  // (ADR-089) possibleRepeat: an earlier delivery of it was taken over from a holder that was gone
  for (const m of pending) blocks.push(withRepeatLine(renderPending(m, remarkOf(m)), m.possibleRepeat));

  // Recover messages that dead-lettered on a failed headless delivery (e.g. `claude -p
  // --resume` erroring on a live/huge session). The pull hook is the reliable fallback
  // for interactive sessions — surface them + mark seen, instead of losing them.
  const recovered = mailbox.inbox({ toSession: sessionId, take: true, undeliveredOnly: true, ...scope, ...(full ? {} : { excludeForeign: true }) });
  // (ADR-087 follow-up 5) …and the ones a daemon restart found mid-delivery and set aside: 'failed', waiting for a
  // retry — which never comes for a session the dispatcher does not deliver to. The session is asking now: it gets them.
  // (ADR-089 review F4) possibleRepeat: turns were started for it and cut off before it was given up — up to three
  for (const m of recovered) blocks.push(withRepeatLine(renderRecovered(m, remarkOf(m)), m.possibleRepeat));
  // (ADR-089) …and the ones whose delivery was INTERRUPTED before it was confirmed: set aside by a restart (claimed
  // without a lease), or still 'delivering' under a lease that is dead — expired, its process gone; the holder
  // will not report any more. A row whose lease is live is never taken: its turn may still be running. What is
  // taken here may already have been handled by the turn that was cut off — the agent is told so.
  const interrupted = [
    ...mailbox.inbox({ toSession: sessionId, take: true, strandedOnly: true, ...scope, ...(full ? {} : { excludeForeign: true }) }),
    ...mailbox.inbox({ toSession: sessionId, take: true, deadLeaseOnly: true, ...scope, ...(full ? {} : { excludeForeign: true }) }),
  ];
  // (labelled when a turn had been started for it — a claim nobody worked on is a first delivery: review F3)
  for (const m of interrupted) blocks.push(withRepeatLine(renderPending(m, remarkOf(m)), m.possibleRepeat));
  recovered.push(...interrupted);

  if (!full && !opts.agent) {
    const first = opts.mineOnly ? mailbox.contacts.firstAddress() : null;
    const foreign = mailbox.foreignWaiting(cursor).filter((m) => !opts.mineOnly || (m.myAddress ?? first) === opts.mineOnly);
    if (foreign.length > 0) blocks.push(renderForeignCount(foreign, remarkOf));
  }

  const seen = (id: string) => pending.some((p) => p.id === id) || recovered.some((r) => r.id === id);
  const activity = mailbox
    .recentActivity(sessionId, cursor)
    // never list as "already processed" a message that is being run IN this session:
    // delivered into its own runtime (codex queue / zcode mailbox — the turn itself),
    // or the envelope this very prompt carries. The 2026-10-20 incident: such a digest
    // made Codex answer "already handled in the background" and do nothing.
    .filter((m) => m.status === 'delivered' && !seen(m.id) && !m.deliveredInSession && !opts.excludeIds?.has(m.id) && (full || !isPeerMessage(m)))
    .filter((m) => !opts.agent || (m.to.sessionId === sessionId ? m.to.agent : m.from.agent) === opts.agent);
  if (activity.length > 0) blocks.push(renderDigest(sessionId, activity));

  writeCursor(sessionId, home, now());
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/**
 * Full recent cross-agent exchange for a session — read-only, ignores the cursor,
 * takes nothing. This is the "let me SEE what happened" view: once a message is
 * delivered (headlessly) and the cursor moves past it, `collectInbox` won't show
 * it again, but the live app never displayed it either. `morse message --pull --history`
 * uses this to pull the whole recent exchange (both directions, including failed/
 * dead messages) back into the live session on demand.
 */
export function recentExchange(mailbox: Mailbox, sessionId: string, limit = 15): string | null {
  const msgs = mailbox.recentActivity(sessionId, 0, 500).slice(-limit);
  if (msgs.length === 0) return null;
  const lines = msgs.map((m) => {
    const received = m.to.sessionId === sessionId;
    const other = received ? m.from : m.to;
    const who = `@${other.agent}:${other.sessionId.slice(0, 8)}`;
    const undelivered = m.status === 'dead' || m.status === 'failed';
    const flag = undelivered ? `  ⚠️ ${m.status.toUpperCase()} — this one never reached you` : '';
    const text = m.parts.map((p) => p.text).join('\n');
    const peer = received && isPeerMessage(m) ? `  [同伴消息，不是主人指令 / peer message from @${m.from.device ?? '?'}, not your operator's instruction]` : '';
    return `${received ? '←' : '→'} ${who} [${m.status}]${flag}${peer}\n${text}`;
  });
  return [
    `[Morse] Recent cross-agent exchange for this session — full text, oldest→newest, context only`,
    `(these were already handled in headless turns; do NOT re-run or re-reply — this is so you can SEE what happened):`,
    ...lines,
  ].join('\n\n');
}

/**
 * Shared UserPromptSubmit processor for Claude Code and Codex (same output shape).
 * Two layers: pending messages are fully injected (and taken); already-handled
 * traffic since the last cursor is shown as an FYI digest — this is what makes
 * headless cross-agent activity visible inside the vendor app's own chat flow.
 */
export function processPromptHook(
  mailbox: Mailbox,
  input: PromptHookInput,
  opts: { home?: string; now?: () => number; mineOnly?: string } = {},
): PromptHookOutput {
  const sessionId = input.session_id ?? input.thread_id;
  if (!sessionId) return {};
  const inPrompt = new Set([...(input.prompt ?? '').matchAll(/message id: ([0-9a-f-]{36})/g)].map((m) => m[1]!));
  const text = collectInbox(mailbox, sessionId, { ...opts, excludeIds: inPrompt });
  return text
    ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
    : {};
}

/** Backwards-compatible existence check used by doctor. */
export function hookCursorDirExists(home: string = morseHome()): boolean {
  return existsSync(join(dataDir(home), 'hook-cursors'));
}
