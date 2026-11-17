import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Mailbox } from '../mailbox/mailbox.js';
import { isPeerMessage } from '../peer-framing.js';

// The doorbell (ADR-027): waking a running Claude Code session through its own inbox.
//
// Since Claude Code 2.1.224 each running session — the desktop App's too — lists a
// local Unix socket in ~/.claude/sessions/<pid>.json. A JSON line written there
// starts a turn in an idle session (a busy one picks it up between tool calls),
// and that turn runs UserPromptSubmit — the hook through which Morse already
// hands a session its mail.
//
// So the line only says "mail is waiting"; the mail stays pending and arrives
// through the hook, framed as usual and answerable with `morse reply`. When a
// session holds the line (bypass mode without `crossSessionInbound: accept`) or
// the line is lost, the hook still delivers on the user's next prompt.
//
// The `<pid>.*.key` files beside the registry are never read: with one of those
// the line would pass as the session's own child and bypass its inbound rules.
// The line format follows the community capture (agents-can-communicate #130);
// it is not documented, so every step here fails soft. Checked against 2.1.296
// on 2026-10-13.

export interface InboxEntry {
  pid: number;
  sessionId: string;
  socketPath: string;
  status?: string;
  version?: string;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGISTRY_FILE = /^\d+\.json$/;

/** Signal 0 only asks whether the process exists. EPERM (someone else's process) counts as not ours. */
function processExists(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/** One registry file's text as an inbox, or null when it does not describe a usable one. */
function readRegistryEntry(text: string): InboxEntry | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  const pid = data['pid'];
  const sessionId = data['sessionId'];
  const socketPath = data['messagingSocketPath'];
  if (typeof pid !== 'number') return null;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  if (typeof socketPath !== 'string' || socketPath === '') return null;
  const entry: InboxEntry = { pid, sessionId, socketPath };
  if (typeof data['status'] === 'string') entry.status = data['status'];
  if (typeof data['version'] === 'string') entry.version = data['version'];
  return entry;
}

export interface InboxRegistryOptions {
  /** The session registry folder; default ~/.claude/sessions. */
  dir?: string;
  isAlive?: (pid: number) => boolean;
  ttlMs?: number;
  now?: () => number;
}

/**
 * A probe for the inboxes of Claude sessions running right now, keyed by session
 * id. The result is reused for `ttlMs` (2 s) so hot paths can call it freely.
 */
export function createClaudeInboxRegistry(options: InboxRegistryOptions = {}): () => Map<string, InboxEntry> {
  const dir = options.dir ?? join(homedir(), '.claude', 'sessions');
  const alive = options.isAlive ?? processExists;
  const ttlMs = options.ttlMs ?? 2_000;
  const clock = options.now ?? Date.now;

  const scan = (): Map<string, InboxEntry> => {
    const found = new Map<string, InboxEntry>();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return found; // no ~/.claude/sessions: Claude Code missing or older than the inbox
    }
    for (const name of names) {
      if (!REGISTRY_FILE.test(name)) continue;
      let text: string;
      try {
        text = readFileSync(join(dir, name), 'utf8');
      } catch {
        continue;
      }
      const entry = readRegistryEntry(text);
      // a session that crashed leaves its file: trust it only while the pid runs and the socket is there
      if (entry !== null && alive(entry.pid) && existsSync(entry.socketPath)) found.set(entry.sessionId, entry);
    }
    return found;
  };

  let last: Map<string, InboxEntry> | undefined;
  let lastAt = 0;
  return () => {
    const at = clock();
    if (last === undefined || at - lastAt >= ttlMs) {
      last = scan();
      lastAt = at;
    }
    return last;
  };
}

/** The line written to a session's inbox: that mail is waiting, never the mail itself. Ends with a newline. */
export function buildDoorbellFrame(input: { messageIds: string[]; fromLabel: string }): string {
  const count = input.messageIds.length;
  const one = count === 1;
  const text =
    `[Morse] Doorbell: ${count} new cross-agent message${one ? '' : 's'} for this session (from ${input.fromLabel}).\n` +
    `The Morse inbox hook attaches ${one ? 'it' : 'them'} to this turn — handle ${one ? 'it' : 'them'} there.\n` +
    'If nothing from Morse is attached, run: morse read --pull';
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      // the id keeps the prefix older releases used: it lands in files Claude Code reads (ADR-075)
      msg_id: `anytoany-${input.messageIds[0] ?? 'wake'}`,
      priority: 'next',
    }) + '\n'
  );
}

/** Send `frame` to the inbox socket at `socketPath`. Resolves with the outcome; never rejects. */
export function ringInbox(socketPath: string, frame: string, timeoutMs: number = 3_000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let open = true;
    const socket = connect(socketPath);
    const finish = (outcome: { ok: boolean; error?: string }): void => {
      if (!open) return; // the first outcome wins; later errors or the timer change nothing
      open = false;
      clearTimeout(deadline);
      socket.destroy();
      resolve(outcome);
    };
    const deadline = setTimeout(() => finish({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    socket.on('error', (err) => finish({ ok: false, error: err.message }));
    socket.once('connect', () => socket.end(frame, () => finish({ ok: true })));
  });
}

/**
 * Can ringing wake a session under these Claude settings? Observed 2026-10-13: when
 * the user default is bypassPermissions and crossSessionInbound is not set, every
 * session holds the line (`peer_message_hold`, cause `no-mode-asserted`) and the
 * desktop App cannot show the approval — ringing only leaves held notices. Then we
 * do not ring, and the hook delivers on the next prompt. `accept` always rings,
 * `refuse`/`hold` never do; otherwise it depends on the default mode.
 */
export function doorbellUseful(settings: { crossSessionInbound?: unknown; permissions?: { defaultMode?: unknown } } | null): boolean {
  switch (settings?.crossSessionInbound) {
    case 'accept':
      return true;
    case 'refuse':
    case 'hold':
      return false;
    default:
      return settings?.permissions?.defaultMode !== 'bypassPermissions';
  }
}

export interface DoorbellEvent {
  kind: 'rung' | 'ring-failed';
  sessionId: string;
  messageIds: string[];
  detail?: string;
}

export interface DoorbellOptions {
  mailbox: Mailbox;
  inboxes: () => Map<string, InboxEntry>;
  ring?: (socketPath: string, frame: string) => Promise<{ ok: boolean; error?: string }>;
  onEvent?: (event: DoorbellEvent) => void;
  /** Checked at every tick; returning false skips it (see doorbellUseful). */
  enabled?: () => boolean;
}

/**
 * A ringing loop: each `tick()` rings every running local Claude session that has
 * new pending mail, once for all of it. Each message is rung for at most once,
 * whether the ring worked or not — the hook catches what a ring misses, and a
 * broken socket must not be rung again and again.
 */
export function createDoorbell(opts: DoorbellOptions): { tick(): Promise<void> } {
  const send = opts.ring ?? ringInbox;
  const done = new Set<string>();

  async function tick(): Promise<void> {
    if (opts.enabled?.() === false) return;
    const live = opts.inboxes();
    if (live.size === 0) return;

    // session id -> the new mail for it, and who sent the first of it
    const batches = new Map<string, { ids: string[]; fromLabel: string }>();
    for (const m of opts.mailbox.inbox({ pendingOnly: true })) {
      const target = m.to;
      const ringable = target.agent === 'claude' && !target.device && live.has(target.sessionId);
      // ADR-048: mail from another person never rings anyone's session
      if (!ringable || isPeerMessage(m) || done.has(m.id)) continue;
      const batch = batches.get(target.sessionId);
      if (batch) batch.ids.push(m.id);
      else batches.set(target.sessionId, { ids: [m.id], fromLabel: `@${m.from.agent}:${m.from.sessionId.slice(0, 8)}` });
    }

    for (const [sessionId, batch] of batches) {
      const inbox = live.get(sessionId);
      if (!inbox) continue;
      batch.ids.forEach((id) => done.add(id));
      const outcome = await send(inbox.socketPath, buildDoorbellFrame({ messageIds: batch.ids, fromLabel: batch.fromLabel }));
      const event: DoorbellEvent = outcome.ok
        ? { kind: 'rung', sessionId, messageIds: batch.ids }
        : { kind: 'ring-failed', sessionId, messageIds: batch.ids, detail: outcome.error ?? 'unknown error' };
      opts.onEvent?.(event);
    }
  }

  return { tick };
}

/** The daemon's one registry, shared by the liveness check and the doorbell. */
export const liveClaudeInboxes = createClaudeInboxRegistry();
