import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { renameWithRetry } from './platform/rename.js';

/**
 * Small JSON files under ~/.morse (blocklist, trusted devices, config, pinned keys …) are
 * changed by read-modify-write, and several `morse` processes run at once (the daemon,
 * every CLI call, plugins). Without a lock two writers each read the old file and the
 * second write drops the first one's change; without an atomic write a reader can see a
 * half-written (truncated) file and take it for "empty".
 *
 * - withFileLock(path, fn): run fn while holding `<path>.lock` — an advisory lock every
 *   writer of that file takes. Synchronous (the stores are), re-entrant in one process,
 *   and a lock left behind by a process that died is taken over.
 * - writeFileAtomic(path, data): temp file in the same directory, then rename — readers
 *   see the old file or the new one, never a partial one. Readers need no lock.
 */

/**
 * A lock older than this is stale even if its pid is alive (the pid was reused by another
 * program, or the holder hangs): a writer holds the lock for well under a millisecond.
 */
const STALE_MS = 10_000;

const held = new Set<string>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => {
  Atomics.wait(sleeper, 0, 0, ms);
};

const pidAlive = (pid: number): boolean => {
  try {
    return pid > 0 && (process.kill(pid, 0), true);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

let seq = 0;
const unique = (): string => `${process.pid}.${Date.now().toString(36)}.${(seq++).toString(36)}`;

/** Is the lock at `lock` left behind (holder gone, or far older than any write takes)? Returns what was read. */
function staleLock(lock: string): string | null {
  let text: string;
  let age: number;
  try {
    text = readFileSync(lock, 'utf8');
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return null; // released meanwhile — just try again
  }
  const pid = Number(text.trim().split(/\s+/)[0]);
  // an empty lock is one being written right now (created, pid not in yet) — unless it stays that way
  if (!text.trim()) return age > 1000 ? text : null;
  return !pidAlive(pid) || age > STALE_MS ? text : null;
}

/** Remove a stale lock; the rename makes sure only one waiter removes it, and only the lock it judged. */
function removeStale(lock: string, seen: string): void {
  const aside = `${lock}.${unique()}.stale`;
  try {
    if (readFileSync(lock, 'utf8') !== seen) return; // somebody else already replaced it
    renameWithRetry(lock, aside); // Windows: retried while another process has the lock file open (ADR-080)
    rmSync(aside, { force: true });
  } catch {
    /* gone meanwhile */
  }
}

/**
 * Run `fn` while holding the lock of `path` (the file `<path>.lock` beside it). Every
 * process that changes `path` by read-modify-write must do the read AND the write inside
 * the same call. `fn` must be synchronous and short.
 */
export function withFileLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  if (held.has(lock)) return fn(); // re-entrant: this process already holds it
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid} ${unique()}\n`;
  let wait = 1;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeFileSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const stale = staleLock(lock);
    if (stale !== null) {
      removeStale(lock, stale);
      continue;
    }
    // held by a live process right now: wait a little (a held lock is never older than STALE_MS, so this ends)
    sleepSync(wait + Math.random() * wait);
    wait = Math.min(wait * 2, 20);
  }
  held.add(lock);
  try {
    return fn();
  } finally {
    held.delete(lock);
    try {
      // only our own lock: if it was taken over (we were stalled past STALE_MS), leave the new holder's alone
      if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true });
    } catch {
      /* already gone */
    }
  }
}

/**
 * Write `data` to `path` atomically: a temp file in the same directory, then rename.
 * `mode`: permission bits of the file; left out, an existing file keeps its mode and a
 * new one gets the process default (as writeFileSync would).
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  let path = file;
  try {
    path = realpathSync(file); // a symlinked file (dotfiles) stays a symlink: replace what it points to
  } catch {
    /* a new file */
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  let mode = opts.mode;
  if (mode === undefined) {
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      /* a new file: the default mode */
    }
  }
  const tmp = join(dir, `.${basename(path)}.${unique()}.tmp`);
  try {
    writeFileSync(tmp, data, mode !== undefined ? { mode } : {});
    if (mode !== undefined) chmodSync(tmp, mode); // writeFileSync's mode is masked by umask
    renameWithRetry(tmp, path); // Windows: retried while a reader / the virus scanner has the target open (ADR-080)
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
