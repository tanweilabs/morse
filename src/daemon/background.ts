import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * `morse start --background` (ADR-080): the daemon puts itself in the background. On macOS /
 * Linux launchd / systemd do that and own the log file; Windows has neither — a scheduled
 * task runs this at logon and it must not leave a console window open. The daemon is started
 * detached (its own session; on Windows no console at all), with stdout and stderr appended to
 * the log file, exactly as a service manager would hand it over — so the log rotation, which
 * expects fd 1 to BE the log file, works unchanged.
 */
export interface BackgroundOptions {
  /** The whole command: node, its flags, cli.js, `start`, the daemon's options. */
  argv: string[];
  logFile: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function startInBackground(o: BackgroundOptions): ChildProcess {
  mkdirSync(dirname(o.logFile), { recursive: true });
  const fd = openSync(o.logFile, 'a', 0o600);
  try {
    const child = spawn(o.argv[0]!, o.argv.slice(1), {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      cwd: o.cwd,
      ...(o.env ? { env: o.env } : {}),
    });
    child.unref();
    return child;
  } finally {
    closeSync(fd); // the child has its own copy
  }
}

export interface WaitOptions {
  child: { pid?: number | undefined; exitCode: number | null };
  readPid: () => number | null;
  timeoutMs?: number;
  intervalMs?: number;
  /** After the pid file names the child: still there this much later = not a crash at startup. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Did the daemon come up? 'up' = its pid file names the child and the child is still running
 * a moment later; 'exited' = the child ended first (see the log); 'timeout' = neither yet.
 */
export async function waitUntilUp(o: WaitOptions): Promise<'up' | 'exited' | 'timeout'> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = o.intervalMs ?? 200;
  let left = o.timeoutMs ?? 20_000;
  for (;;) {
    if (o.child.exitCode !== null) return 'exited';
    if (o.child.pid !== undefined && o.readPid() === o.child.pid) break;
    if (left <= 0) return 'timeout';
    await sleep(interval);
    left -= interval;
  }
  for (let settle = o.settleMs ?? 1500; settle > 0; settle -= interval) {
    await sleep(Math.min(interval, settle));
    if (o.child.exitCode !== null) return 'exited';
  }
  return 'up';
}

/** The last lines of a log file, for "the daemon did not start". */
export function tailOf(file: string, lines = 15): string[] {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines);
  } catch {
    return [];
  }
}
