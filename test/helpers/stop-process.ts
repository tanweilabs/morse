import type { ChildProcess } from 'node:child_process';

/**
 * Stop a process a test started and WAIT until it is gone — before the test removes the
 * temp home that process (and what it started) reads and writes. `child.kill()` alone
 * only sends the signal: the process, the `morse` commands it has in flight and its
 * `morse plugin watch` are still running when the test's cleanup removes the directory,
 * and one of them re-creates a file in it (rmSync then fails with ENOTEMPTY).
 *
 * Waits for 'close', not 'exit': 'close' comes once the stdio pipes are closed too, i.e.
 * when every process that inherited them (a plugin's `morse plugin watch`) has ended.
 * A process that does not stop within `graceMs` is killed (SIGKILL).
 */
export function stopProcess(child: ChildProcess | null | undefined, opts: { signal?: NodeJS.Signals; graceMs?: number } = {}): Promise<void> {
  if (!child || child.pid === undefined) return Promise.resolve();
  const exited = child.exitCode !== null || child.signalCode !== null;
  const closed = exited && [child.stdin, child.stdout, child.stderr].every((s) => !s || s.destroyed);
  if (closed) return Promise.resolve();
  return new Promise((resolve) => {
    const timers: NodeJS.Timeout[] = [];
    const done = () => {
      for (const t of timers) clearTimeout(t);
      resolve();
    };
    child.once('close', done);
    // whatever still holds the pipes after a SIGKILL is not waited for for ever
    const giveUp = () => timers.push(setTimeout(done, 2000));
    if (exited) return giveUp();
    timers.push(
      setTimeout(() => {
        child.kill('SIGKILL');
        giveUp();
      }, opts.graceMs ?? 5000),
    );
    child.kill(opts.signal ?? 'SIGTERM');
  });
}
