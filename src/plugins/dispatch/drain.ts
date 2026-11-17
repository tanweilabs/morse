/**
 * ADR-089: stopping the dispatch plugin without cutting a turn in two. `stop()` of a runner means "start
 * nothing new" and resolves when what is running has finished and reported; here that is bounded.
 */

/** SIGTERM from the daemon: a running turn gets this long to finish (the daemon waits a little longer). */
export const STOP_DRAIN_MS = 10_000;
/** The daemon is gone (`morse plugin watch` ended) and this plugin is not: turns finish, within this. */
export const WATCH_GONE_DRAIN_MS = 30 * 60_000;

export interface Drainable {
  stop(): Promise<void>;
  running(): string[];
}

/** Stop the runners; wait at most `ms` for their turns. Returns how many turns are still running then. */
export async function drainTurns(runners: Drainable[], ms: number, log: (line: string) => void = () => undefined): Promise<number> {
  const done = Promise.all(runners.map((r) => r.stop()));
  const count = () => runners.reduce((n, r) => n + r.running().length, 0);
  const n = count();
  if (n) log(`stopping: waiting up to ${Math.round(ms / 1000)} s for ${n} running turn(s) to finish`);
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([done, new Promise((r) => (timer = setTimeout(r, ms)))]);
  if (timer) clearTimeout(timer);
  return count();
}
