import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { liveClaudeInboxes } from './claude-inbox.js';

// Which local sessions are open right now, so the dispatcher leaves them alone.
//
// Claude (ADR-023). Resuming a Claude session with `claude -p --resume` while a
// person has it open does land the turn in the transcript, but the process still
// exits non-zero (a post-turn hook gives up on the large transcript, or a bare
// exit 1 when two processes share the session). Seen 2026-09-05: Morse took that
// for a failure, retried three times — three duplicate turns in the session the
// operator was using — then dead-lettered a message that had arrived. An open
// session gets its mail through its own hook / `morse monitor`, so the message
// simply stays pending, as for a monitored session (monitor.ts).
//
// Open sessions show up in `ps` as `--resume=<uuid>`. Morse's own deliveries
// pass `--resume <uuid>` with a space, so they never match.

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** How long one probe result is reused, so the dispatcher can ask on every message. */
const REUSE_MS = 2_000;

/** Session ids of interactively open Claude processes, read from `ps -o command` output. */
export function parseLiveClaudeSessions(psOutput: string): Set<string> {
  const pattern = new RegExp(`--resume=(${UUID_SOURCE})`, 'g');
  return new Set(Array.from(psOutput.matchAll(pattern), (m) => m[1] as string));
}

/** Wrap `probe` so its answer is reused for `ttlMs` after each fresh call. */
function reused(probe: () => Set<string>, ttlMs: number): (now: () => number) => Set<string> {
  let value: Set<string> | undefined;
  let takenAt = 0;
  return (now) => {
    const at = now();
    if (value === undefined || at - takenAt >= ttlMs) {
      value = probe();
      takenAt = at;
    }
    return value;
  };
}

/** Asks `ps`; when it is missing, refused or slow, nothing counts as open and delivery goes ahead as usual. */
function claudeProcessesNow(): Set<string> {
  try {
    return parseLiveClaudeSessions(execFileSync('ps', ['-axww', '-o', 'command'], { encoding: 'utf8', timeout: 4_000 }));
  } catch {
    return new Set();
  }
}

const claudeProbe = reused(claudeProcessesNow, REUSE_MS);

/** Claude session ids open in an interactive process right now (briefly cached, synchronous, best-effort). */
export function liveClaudeSessions(now: () => number = Date.now): Set<string> {
  return claudeProbe(now);
}

// Codex (ADR-026). A thread that Codex Desktop has open rejects `codex exec resume`
// with "thread-store conflict: thread <id> already has an active writer". Per
// codex-rs/rollout/src/writer_lock.rs a writer flock()s
// <CODEX_HOME>/thread-writer-locks/<thread id>.lock and removes the file when
// done; a writer that crashed can leave the file without holding it. So a thread
// counts as open when its lock file exists and `lsof` (read-only) shows some
// process holding it. We never take the flock ourselves — even briefly, that
// could stop the user's Codex Desktop from opening the thread.

const LOCK_FILE = new RegExp(`(${UUID_SOURCE})\\.lock$`);

/** Thread ids whose lock file appears as an open file (`n…` lines) in `lsof -F n` output. */
export function parseCodexLockHolders(lsofOutput: string): Set<string> {
  const held = new Set<string>();
  for (const line of lsofOutput.split('\n')) {
    const id = line.startsWith('n') ? LOCK_FILE.exec(line)?.[1] : undefined;
    if (id) held.add(id);
  }
  return held;
}

export interface CodexLivenessOptions {
  /** Folder of writer lock files; default ~/.codex/thread-writer-locks. */
  lockDir?: string;
  /** Who holds these lock files, as `lsof -F n` would print it. */
  holders?: (paths: string[]) => string;
  ttlMs?: number;
}

/** `lsof -F n` for these files. Exit status 1 just means none is open, so only stdout matters. */
function runLsof(paths: string[]): string {
  return spawnSync('lsof', ['-F', 'n', '--', ...paths], { encoding: 'utf8', timeout: 4_000 }).stdout ?? '';
}

/** A cached probe for the Codex threads that have a live writer right now. */
export function createCodexLiveness(options: CodexLivenessOptions = {}): (now?: () => number) => Set<string> {
  const lockDir = options.lockDir ?? join(homedir(), '.codex', 'thread-writer-locks');
  const lsof = options.holders ?? runLsof;
  const probe = (): Set<string> => {
    try {
      const locks = readdirSync(lockDir).flatMap((name) => (LOCK_FILE.test(name) ? [join(lockDir, name)] : []));
      // usually no thread is open: then a directory listing is all it costs
      return locks.length === 0 ? new Set() : parseCodexLockHolders(lsof(locks));
    } catch {
      // no Codex home, no lsof, or not permitted: nothing counts as open
      return new Set();
    }
  };
  const cached = reused(probe, options.ttlMs ?? REUSE_MS);
  return (now = Date.now) => cached(now);
}

/** Codex thread ids held by a writer right now (usually Codex Desktop's app-server). */
export const liveCodexThreads = createCodexLiveness();

/**
 * Must the dispatcher stay out of this local session because a running process
 * picks up its mail itself? Claude only: a session with a live inbox (ADR-027 —
 * the one signal that sees desktop-App sessions, which have no `--resume=` on
 * their command line) or one found by the `ps` scan (ADR-023). Open Codex threads
 * are not skipped: the codex adapter queues into Codex Desktop instead (ADR-027).
 */
export function isSessionLive(sessionId: string, now: () => number = Date.now): boolean {
  return liveClaudeInboxes().has(sessionId) || liveClaudeSessions(now).has(sessionId);
}
