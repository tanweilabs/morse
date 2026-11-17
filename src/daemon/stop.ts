import type { DaemonInfo } from './capabilities.js';
import { LOCAL_TOKEN_HEADER } from './local-api.js';

/**
 * Stopping the daemon without a signal (ADR-080). On Windows `process.kill(pid, 'SIGTERM')`
 * ends the process at once: no cleanup runs, the pid file stays, plugins are left running.
 * So `morse stop` there asks the daemon over its loopback console (`POST /api/shutdown`, with
 * the token the daemon wrote to daemon.json), waits for the process to go, and only then ends
 * the process tree — saying that it did. macOS / Linux keep the SIGTERM path in cli.ts.
 */

/** The header the daemon token travels in — the same for every route of the local API (ADR-087). */
export const SHUTDOWN_TOKEN_HEADER = LOCAL_TOKEN_HEADER;

export type ShutdownAnswer = { ok: true } | { ok: false; reason: string };

/** Ask the daemon on `port` to stop. Resolves once it has answered (it stops after answering). */
export async function requestShutdown(port: number, token: string, timeoutMs = 3000): Promise<ShutdownAnswer> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { [SHUTDOWN_TOKEN_HEADER]: token }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 202) return { ok: true };
    return { ok: false, reason: res.status === 404 ? 'the daemon has no stop endpoint (an older release)' : `the daemon refused the stop request (${res.status})` };
  } catch (e) {
    return { ok: false, reason: `the daemon did not answer on port ${port} (${e instanceof Error ? e.message : String(e)})` };
  }
}

export interface StopDeps {
  readPid: () => number | null;
  isAlive: (pid: number) => boolean;
  clearPid: () => void;
  readInfo: () => DaemonInfo | null;
  request?: (port: number, token: string) => Promise<ShutdownAnswer>;
  /** End the process and everything it started (Windows: taskkill /T /F). */
  killTree: (pid: number) => { ok: boolean; detail: string };
  sleep?: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** How long an orderly stop may take before the process is ended (default 5 s). */
  graceMs?: number;
}

export type StopOutcome = 'not-running' | 'stopped' | 'killed' | 'failed';

export async function stopWithoutSignals(deps: StopDeps): Promise<StopOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const grace = deps.graceMs ?? 5000;
  const pid = deps.readPid();
  if (pid === null) {
    // no `pgrep` here, and a process is never guessed at: another Morse home's daemon may be running
    deps.log('daemon not running (no pid file)');
    return 'not-running';
  }
  if (!deps.isAlive(pid)) {
    deps.log(`daemon pid ${pid} not alive — cleaning pid file`);
    deps.clearPid();
    return 'not-running';
  }
  const gone = async (): Promise<boolean> => {
    for (let waited = 0; waited < grace; waited += 100) {
      if (!deps.isAlive(pid)) return true;
      await sleep(100);
    }
    return !deps.isAlive(pid);
  };
  const info = deps.readInfo();
  let why: string;
  if (!info) why = 'it left no daemon.json (an older release)';
  else if (info.pid !== pid) why = "daemon.json is another process's";
  else if (info.port === null) why = 'it runs without a console (--no-web)';
  else if (!info.token) why = 'it has no stop token (an older release)';
  else {
    const answer = await (deps.request ?? requestShutdown)(info.port, info.token);
    if (answer.ok) {
      if (await gone()) {
        deps.log(`daemon stopped (pid ${pid})`);
        deps.clearPid();
        return 'stopped';
      }
      why = `it took the stop request but did not stop within ${Math.round(grace / 1000)} s`;
    } else why = answer.reason;
  }
  deps.log(`the daemon (pid ${pid}) cannot be stopped in an orderly way: ${why} — ending the process`);
  const killed = deps.killTree(pid);
  if (!killed.ok || !(await gone())) {
    deps.log(`✗ could not end the daemon (pid ${pid})${killed.detail ? `: ${killed.detail}` : ''} — end it from Task Manager (node.exe), then run this again`);
    return 'failed';
  }
  deps.log(`daemon killed (pid ${pid}) — it had no chance to clean up`);
  deps.clearPid();
  return 'killed';
}
