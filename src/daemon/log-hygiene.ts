import { copyFileSync, existsSync, fstatSync, ftruncateSync, renameSync, statSync } from 'node:fs';
import { formatDuration } from '../format.js';

/**
 * ADR-046: keep daemon.log readable and bounded. One unreachable peer produced ~4000
 * identical "lan failed" / "waiting …" lines a day and the log grew to 12 MB.
 */

export interface RepeatFilter {
  /** The line to log now (with a repeat count when lines were held back), or null to drop it. */
  pass(key: string, line: string): string | null;
  /** Forget every key that starts with `prefix` (the target recovered: log its next failure at once). */
  forget(prefix: string): void;
}

/**
 * Identical failures (same key) are logged the first time, then again after 1 min, 2, 4, …
 * at most every `maxIntervalMs`, each time with how many were held back. A key that has
 * been quiet for twice its interval starts over.
 */
export function createRepeatFilter(opts: { firstIntervalMs?: number; maxIntervalMs?: number; now?: () => number; maxKeys?: number } = {}): RepeatFilter {
  const first = opts.firstIntervalMs ?? 60_000;
  const max = opts.maxIntervalMs ?? 60 * 60_000;
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 1000;
  const seen = new Map<string, { next: number; interval: number; held: number; last: number; shownAt: number }>();
  return {
    pass(key, line) {
      const t = now();
      const e = seen.get(key);
      if (!e || t - e.last > 2 * e.interval) {
        if (seen.size >= maxKeys) seen.clear();
        seen.set(key, { next: t + first, interval: first, held: 0, last: t, shownAt: t });
        return line;
      }
      e.last = t;
      if (t < e.next) {
        e.held++;
        return null;
      }
      const out = e.held ? `${line} [same as ${e.held} line(s) held back in the last ${formatDuration(t - e.shownAt)}]` : line;
      e.interval = Math.min(e.interval * 2, max);
      e.next = t + e.interval;
      e.held = 0;
      e.shownAt = t;
      return out;
    },
    forget(prefix) {
      for (const k of seen.keys()) if (k.startsWith(prefix)) seen.delete(k);
    },
  };
}

/**
 * Size-based rotation of the log a service manager writes our stdout / stderr to
 * (launchd StandardOutPath; `morse start >>file`). We do not own that file descriptor, so
 * this copies the file to `<path>.1` (older ones shift to .2 … .keep) and truncates it in
 * place — the descriptor opened with O_APPEND then writes from the start again. Only when
 * `fd` really is `path` (same inode): a terminal, a pipe or journald is left alone.
 * Returns true when it rotated.
 */
export function rotateLogIfLarge(o: { path: string; fds?: number[]; maxBytes?: number; keep?: number }): boolean {
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
  const keep = Math.max(1, o.keep ?? 3);
  let target: ReturnType<typeof statSync>;
  try {
    if (!existsSync(o.path)) return false;
    target = statSync(o.path);
  } catch {
    return false;
  }
  const fds = (o.fds ?? [1, 2]).filter((fd) => {
    try {
      const s = fstatSync(fd);
      return s.isFile() && s.ino === target.ino && s.dev === target.dev;
    } catch {
      return false;
    }
  });
  if (!fds.length || target.size < maxBytes) return false;
  try {
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${o.path}.${i}`)) renameSync(`${o.path}.${i}`, `${o.path}.${i + 1}`);
    copyFileSync(o.path, `${o.path}.1`);
    ftruncateSync(fds[0]!, 0);
    return true;
  } catch {
    return false; // full disk, permissions: try again next time
  }
}
