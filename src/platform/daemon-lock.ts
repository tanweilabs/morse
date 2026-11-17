import { closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { isWindows, type Platform } from './platform.js';

/**
 * "Is the Morse daemon of this home alive?" on Windows (ADR-080, for the checks of ADR-083).
 *
 * macOS / Linux read the process's command line (`ps`) to tell a daemon from another program
 * that got a stale pid file's pid. Windows has no cheap way to read one, pids are reused fast
 * there, and every logoff kills the daemon without cleanup — so a stale pid file is the normal
 * state at the next logon. Instead the daemon keeps `daemon.lock` open in EXCLUSIVE sharing mode
 * for as long as it lives: nobody else can open the file meanwhile (EBUSY), and Windows releases
 * it the moment the process is gone, however it died. No process is started to find out.
 *
 * Checked on a real Windows 11 (2026-11-15): held -> a second open fails with EBUSY; holder
 * killed -> the open succeeds; no file -> ENOENT.
 */

/** libuv's UV_FS_O_EXLOCK ("exclusive sharing mode", Windows only); Node does not export it in fs.constants. */
const UV_FS_O_EXLOCK = 0x10000000;
export const DAEMON_LOCK = 'daemon.lock';

type Open = (path: string, flags: number | string, mode?: number) => number;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => {
  Atomics.wait(sleeper, 0, 0, ms);
};

/**
 * The daemon takes the lock when it starts and never lets go. Returns the descriptor (keep it:
 * closing it releases the lock), 'busy' when another process holds it — a daemon of this home
 * is running — and null where there is no lock (not Windows).
 */
export function holdDaemonLock(dataDir: string, deps: { platform?: Platform; open?: Open; sleep?: (ms: number) => void; waitMs?: number } = {}): number | 'busy' | null {
  if (!isWindows(deps.platform)) return null;
  const open = deps.open ?? (openSync as Open);
  const sleep = deps.sleep ?? sleepSync;
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, DAEMON_LOCK);
  // a command that is just looking has the file open for an instant: wait that out, not a daemon
  for (let waited = 0; ; waited += 50) {
    try {
      return open(path, constants.O_RDWR | constants.O_CREAT | UV_FS_O_EXLOCK, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e;
      if (waited >= (deps.waitMs ?? 1500)) return 'busy';
    }
    sleep(50);
  }
}

/**
 * held  a live daemon has the lock;
 * free  the lock file is there and nobody holds it: no daemon of this release is alive;
 * none  nothing can be said — not Windows, or no daemon of a release with the lock ever ran here.
 */
export type DaemonLockState = 'held' | 'free' | 'none';

export function daemonLockState(dataDir: string, deps: { platform?: Platform; open?: Open; close?: (fd: number) => void } = {}): DaemonLockState {
  if (!isWindows(deps.platform)) return 'none';
  try {
    (deps.close ?? closeSync)((deps.open ?? (openSync as Open))(join(dataDir, DAEMON_LOCK), 'r'));
    return 'free';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EBUSY' ? 'held' : 'none';
  }
}
