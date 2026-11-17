import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { morseHome, dataDir } from '../home.js';
import { daemonLockState, type DaemonLockState } from '../platform/daemon-lock.js';

const pidFile = (): string => join(dataDir(), 'daemon.pid');

export function writePid(pid: number = process.pid): void {
  const path = pidFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid), 'utf8');
}

export function readPid(): number | null {
  try {
    const n = Number.parseInt(readFileSync(pidFile(), 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Remove the pid file. With ownPid, only if this process is the recorded owner. */
export function clearPid(ownPid?: number): void {
  try {
    if (ownPid !== undefined && readPid() !== ownPid) return;
    rmSync(pidFile());
  } catch {
    /* already gone */
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * (ADR-083 review N3) A pid file outlives its daemon after a crash or a reboot, and the system gives the
 * pid to another program sooner or later. A live pid alone therefore does not say "the Morse daemon is
 * running": before a command believes it — and refuses to work beside "an older daemon", says "already
 * running", or signals the process — the process has to read like a Morse daemon.
 */

/**
 * The command line of a live process, as one string. null where it cannot be read: Windows, no `ps`, a
 * sandbox that forbids it — or the process is gone.
 */
export function commandLineOf(pid: number): string | null {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (args.length) return args.join(' ');
    } catch {
      /* no /proc here, or no such process: ps says */
    }
  }
  try {
    const out = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Does a command line read like a Morse daemon's? `<node> <the morse entry> start …` — the entry being the
 * `morse` / `anyd` command, or the package's cli.js (cli.ts when run from a source tree). `start` anywhere
 * behind the entry counts: the test errs towards "a daemon", which is what a live pid meant before.
 */
export function looksLikeMorseDaemon(commandLine: string): boolean {
  const words = commandLine.split(/\s+/).filter(Boolean);
  const entry = words.findIndex((w) => /(^|[\\/])(morse|anyd|cli\.(js|mjs|cjs|ts))$/.test(w));
  return entry >= 0 && words.indexOf('start', entry + 1) > entry;
}

/**
 * Is the live process `pid` a Morse daemon?
 *   yes      its command line reads like one;
 *   no       it is another program: a pid file that names it is stale;
 *   unknown  the command line cannot be read here — nothing is concluded, and a caller goes by the pid
 *            file as it always did.
 *
 * Windows (ADR-080) has no command line to read, reuses pids fast, and kills the daemon without cleanup
 * at every logoff — "unknown" there would make a stale pid file look like a running (or an older) daemon.
 * So where the command line cannot be read, the daemon's lock answers (platform/daemon-lock.ts): held =
 * a daemon of this home is alive; free = none is, the pid is another program's; no lock file = unknown,
 * as before (macOS / Linux always, and a Windows daemon of a release before the lock).
 */
export function isMorseDaemon(pid: number, read: (pid: number) => string | null = commandLineOf, lock: () => DaemonLockState = () => daemonLockState(dataDir())): 'yes' | 'no' | 'unknown' {
  const line = read(pid);
  if (line === null) {
    const state = lock();
    return state === 'held' ? 'yes' : state === 'free' ? 'no' : 'unknown';
  }
  return looksLikeMorseDaemon(line) ? 'yes' : 'no';
}

/**
 * The pid of this home's running daemon, null when none is running — THE question for every command that
 * goes by the pid file. A file that names a process that is gone says "none" (and is left, as ever). A file
 * that names a live process that is not a Morse daemon is stale: it is removed, and the answer is "none" —
 * `morse start` can start, no command speaks of an older daemon, `morse stop` signals nobody. This
 * process's own pid (a daemon starting up) is returned unasked.
 */
export function runningDaemonPid(read: (pid: number) => string | null = commandLineOf): number | null {
  const pid = readPid();
  if (pid === null || !isAlive(pid)) return null;
  if (pid === process.pid) return pid;
  if (isMorseDaemon(pid, read) !== 'no') return pid;
  clearPid(pid); // (only while the file still names that pid: a daemon starting right now keeps its own)
  return null;
}
