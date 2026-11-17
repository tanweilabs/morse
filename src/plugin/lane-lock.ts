import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One turn per lane, also across processes (ADR-055): a lock file per lane holding the
 * pid that runs a turn for it now. A lock left behind by a process that died is taken
 * over. Shared by the plugins that run agents (dispatch: a lane = a session; attendant:
 * a lane = one of your agents with one contact).
 */

export const pidAlive = (pid: number): boolean => {
  try {
    return pid > 0 && (process.kill(pid, 0), true);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const safe = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, '_');

/** Hold `lane` under `dir` (created 0700); null = a live process holds it now. */
export function takeLaneLock(dir: string, lane: string): (() => void) | null {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${safe(lane)}.lock`);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid = 0;
      try {
        pid = Number(readFileSync(path, 'utf8'));
      } catch {
        /* vanished meanwhile */
      }
      if (pid && pidAlive(pid)) return null; // a live process runs a turn for this lane
      rmSync(path, { force: true }); // left behind by a process that died — take it
    }
  }
  return null;
}
