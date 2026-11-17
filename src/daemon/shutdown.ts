/**
 * The daemon's orderly stop (SIGTERM / SIGINT, `POST /api/shutdown`, an update's restart), as one object —
 * so that what must hold whatever goes wrong inside can be tested (ADR-089, reviews F1 and N5):
 *
 *   - it runs ONCE: a second request while plugins finish their turns starts nothing again;
 *   - a HARD DEADLINE is armed before anything else: if the orderly path has not finished by then — a step
 *     threw, a plugin never came back — the process exits non-zero and the service manager starts it again
 *     (without it a daemon whose shutdown broke half-way ignored every later signal and was never restarted);
 *   - a step that throws does not stop the others;
 *   - once everything has stopped, a further request just ends the process (the service manager's own
 *     restart signal after an update).
 */

export interface ShutdownOptions {
  /** What is stopped at once, in order — each on its own: one that throws is logged, the rest still run. */
  steps: Array<() => void>;
  /** What is waited for (plugins letting a running turn finish). */
  wait: () => Promise<unknown>;
  /** After everything has stopped: true = it takes it from here (an update's restart); otherwise the process exits 0. */
  after?: () => boolean;
  exit: (code: number) => void;
  log?: (line: string) => void;
  /** The orderly path has this long (default 30 s: the plugins' 15 s and a margin). */
  deadlineMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export const SHUTDOWN_DEADLINE_MS = 30_000;

export function createShutdown(o: ShutdownOptions): { request: () => void; state: () => 'running' | 'stopping' | 'stopped' } {
  let state: 'running' | 'stopping' | 'stopped' = 'running';
  const log = o.log ?? (() => undefined);
  return {
    state: () => state,
    request() {
      if (state === 'stopped') return o.exit(0);
      if (state === 'stopping') return;
      state = 'stopping';
      const deadline = o.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
      (o.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
        if (state === 'stopped') return;
        log(`the orderly stop did not finish within ${Math.round(deadline / 1000)} s — exiting now`);
        o.exit(1);
      }, deadline);
      for (const step of o.steps) {
        try {
          step();
        } catch (e) {
          log(`stopping: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      let waited: Promise<unknown>;
      try {
        waited = o.wait();
      } catch (e) {
        waited = Promise.reject(e);
      }
      void Promise.resolve(waited)
        .catch((e: unknown) => log(`stopping: ${e instanceof Error ? e.message : String(e)}`))
        .then(() => {
          state = 'stopped';
          let handled = false;
          try {
            handled = o.after?.() === true;
          } catch (e) {
            log(`stopping: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (!handled) o.exit(0);
        });
    },
  };
}
