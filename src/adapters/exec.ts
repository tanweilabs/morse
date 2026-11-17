import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import type { ExecFn } from './types.js';

const MAX_OUTPUT = 10 * 1024 * 1024;
/** After the process has exited: how long output still in its pipes is waited for when something else keeps them open. */
export const OUTPUT_GRACE_MS = 2000;

/**
 * ADR-089: who wants to know about the agent CLI processes started from within their call. The dispatch plugin
 * runs a delivery inside `spawnWatch.run(watcher, …)`:
 *   - `spawned`: the lease of the message is tied to the process that runs the turn — alive as long as the turn
 *     is, whatever happens to the plugin — and knows the turn's own time limit;
 *   - `ended`: how that process ended. `signal` = it was ended by a signal that was NOT ours (our own timeout
 *     kill is `timedOut`): the turn was cut off from outside — a restart, a service manager, the user — which is
 *     not a failure of the message.
 */
export interface SpawnWatcher {
  spawned(pid: number, info: { timeoutMs: number }): void;
  ended?(pid: number, how: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }): void;
}
export const spawnWatch = new AsyncLocalStorage<SpawnWatcher>();

/**
 * Default ExecFn: argv-style spawn (no shell — message text can never be
 * interpreted by a shell), stdin closed (agent CLIs must not wait for piped
 * input), resolving with exit code instead of rejecting.
 */
export const realExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    const watcher = spawnWatch.getStore();
    if (child.pid) watcher?.spawned(child.pid, { timeoutMs: opts.timeoutMs });
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number, extraErr = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + extraErr, code });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish(124, `\ntimeout after ${opts.timeoutMs}ms`);
    }, opts.timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on('error', (e) => finish(127, e.message));
    // (ADR-089 follow-up M3) How the process ended is known at its EXIT — `close` comes only when the output
    // pipes are closed too, and a child of the agent CLI that outlives it keeps them open: the plugin then went
    // on renewing the lease of a dead process until the time limit, and reported a timeout. So: `ended` is told
    // at the exit; what is still in the pipes is collected for a short while (normally `close` follows at
    // once), then the call answers with what it has.
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      if (child.pid) watcher?.ended?.(child.pid, { code, signal, timedOut });
      const grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code ?? 1);
      }, OUTPUT_GRACE_MS);
      grace.unref?.();
      child.once('close', () => clearTimeout(grace));
    });
    child.on('close', (code) => finish(exit?.code ?? code ?? 1));
  });
