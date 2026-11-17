import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { dataDir, morseHome } from '../home.js';

// Monitor heartbeats.
//
// A live agent session can follow its own mail with a blocking `morse message --wait`,
// which prints each message inside the session's current turn (so it shows up in the
// live UI, unlike a headless resume — Codex #28259). While that loop runs it refreshes
// a small file `<data>/monitors/<session>` holding the last-seen epoch millis. The
// dispatch plugin consults it and skips resume-delivery to a session that is watching
// for itself, leaving the message pending for the loop to pick up.

/** How long a heartbeat counts as "still monitoring". */
const STALE_AFTER_MS = 10_000;

interface HomeOpt {
  home?: string;
}
interface ClockOpt extends HomeOpt {
  now?: () => number;
}

/** Map a session id onto a single safe file name inside the monitors folder. */
function heartbeatFile(home: string, sessionId: string): string {
  const name = sessionId.replace(/[^\w.-]/g, '_');
  return path.join(dataDir(home), 'monitors', name);
}

/** Record that `sessionId` is monitoring right now. Call on every poll. */
export function heartbeat(sessionId: string, opts: ClockOpt = {}): void {
  const file = heartbeatFile(opts.home ?? morseHome(), sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${(opts.now ?? Date.now)()}`, 'utf8');
}

/** Drop the heartbeat when the monitor loop exits. Never throws. */
export function clearMonitor(sessionId: string, opts: HomeOpt = {}): void {
  try {
    rmSync(heartbeatFile(opts.home ?? morseHome(), sessionId), { force: true });
  } catch {
    // nothing to clean up
  }
}

/** True while `sessionId` has a heartbeat younger than `freshMs`. */
export function isMonitored(sessionId: string, opts: ClockOpt & { freshMs?: number } = {}): boolean {
  let raw: string;
  try {
    raw = readFileSync(heartbeatFile(opts.home ?? morseHome(), sessionId), 'utf8');
  } catch {
    return false;
  }
  const seenAt = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seenAt)) return false;
  const age = (opts.now ?? Date.now)() - seenAt;
  return age <= (opts.freshMs ?? STALE_AFTER_MS);
}
