import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ExecFn } from './types.js';

/** Per stream, output past this many characters is no longer kept. */
const KEEP_AT_MOST = 10 * 1024 * 1024;
/** After the process has exited: how long output still in its pipes is waited for when something else keeps them open. */
export const OUTPUT_GRACE_MS = 2000;
/** Exit codes we report for things the child itself never exited with. */
const TIMED_OUT = 124;
const COULD_NOT_START = 127;

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

type ExecResult = Awaited<ReturnType<ExecFn>>;
type Child = ChildProcessByStdio<null, Readable, Readable>;

/**
 * One child process from spawn to answer. The answer is given exactly once, by whichever
 * comes first: the time limit, a failure to start, the pipes closing after the exit, or —
 * when a grandchild keeps the pipes open — the grace period after the exit.
 */
class TrackedRun {
  private out = '';
  private err = '';
  private answered = false;
  private killedForTime = false;
  /** Set at the child's exit; until then undefined. */
  private exitCode: number | null | undefined;
  private readonly limit: NodeJS.Timeout;

  constructor(
    private readonly child: Child,
    private readonly timeoutMs: number,
    private readonly watcher: SpawnWatcher | undefined,
    private readonly resolve: (result: ExecResult) => void,
  ) {
    const pid = child.pid;
    if (pid) watcher?.spawned(pid, { timeoutMs });
    this.limit = setTimeout(() => this.onTimeLimit(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.out.length < KEEP_AT_MOST) this.out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.err.length < KEEP_AT_MOST) this.err += chunk.toString();
    });
    child.on('error', (e) => this.answer(COULD_NOT_START, e.message));
    child.on('exit', (code, signal) => this.onExit(code, signal));
    // after an exit, the exit's own code is the one to report (a close code can be null)
    child.on('close', (code) => this.answer(this.exitCode ?? code ?? 1));
  }

  private onTimeLimit(): void {
    this.killedForTime = true;
    this.child.kill('SIGKILL');
    this.answer(TIMED_OUT, `\ntimeout after ${this.timeoutMs}ms`);
  }

  /**
   * (ADR-089 follow-up M3) The watcher hears about the end at the EXIT, not at `close`: a
   * process the CLI started and left running can hold the pipes, and `close` would then only
   * come at the time limit — the lease of a dead turn kept alive, and a false timeout. What is
   * still buffered gets a short grace period (normally `close` follows at once).
   */
  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    const pid = this.child.pid;
    if (pid) this.watcher?.ended?.(pid, { code, signal, timedOut: this.killedForTime });
    const grace = setTimeout(() => {
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.answer(code ?? 1);
    }, OUTPUT_GRACE_MS);
    grace.unref?.();
    this.child.once('close', () => clearTimeout(grace));
  }

  private answer(code: number, stderrNote = ''): void {
    if (this.answered) return;
    this.answered = true;
    clearTimeout(this.limit);
    this.resolve({ stdout: this.out, stderr: this.err + stderrNote, code });
  }
}

/**
 * The real ExecFn. Arguments go to the program as an argv array — no shell, so message text
 * can never be read as shell syntax — and stdin is closed, so a CLI that looks for piped
 * input sees end-of-file instead of waiting. It never rejects: every outcome is an exit code
 * (124 for our time limit, 127 when the program could not be started).
 */
export const realExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    new TrackedRun(child, opts.timeoutMs, spawnWatch.getStore(), resolve);
  });
