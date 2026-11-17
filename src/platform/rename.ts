import { renameSync } from 'node:fs';
import type { Platform } from './platform.js';

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => {
  Atomics.wait(sleeper, 0, 0, ms);
};

/** What Windows answers when the target of a rename is open in another process right now. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface RenameRetryOptions {
  platform?: Platform;
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
  /** Give up after waiting about this long in total (default 2 s). */
  totalMs?: number;
}

/**
 * rename(from, to). On Windows a rename over a file that another process has open — a second
 * `morse` reading it, the virus scanner, the search indexer — fails with EPERM / EBUSY / EACCES
 * for a moment; it is retried (5 ms, doubling, about two seconds in all), as graceful-fs does.
 * On macOS / Linux those codes are real permission errors: nothing is retried.
 */
export function renameWithRetry(from: string, to: string, opts: RenameRetryOptions = {}): void {
  const rename = opts.rename ?? renameSync;
  if ((opts.platform ?? process.platform) !== 'win32') return rename(from, to);
  const sleep = opts.sleep ?? sleepSync;
  const total = opts.totalMs ?? 2000;
  let wait = 5;
  let waited = 0;
  for (;;) {
    try {
      return rename(from, to);
    } catch (e) {
      if (!BUSY.has((e as NodeJS.ErrnoException).code ?? '') || waited >= total) throw e;
    }
    sleep(wait);
    waited += wait;
    wait = Math.min(wait * 2, 250);
  }
}
