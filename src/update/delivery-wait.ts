/**
 * ADR-089: an update restarts the daemon, and the restart stops the dispatch plugin — in the middle of an
 * agent turn if one is running. So the updater waits for a moment when no delivery is under way: before it
 * installs, and once more before it restarts. Bounded: after the cap it goes on anyway — a turn the restart
 * cuts keeps its lease while its process runs and is delivered again afterwards, marked as a possible repeat.
 */

export type WaitPoint = 'install' | 'restart';

/** How long the updater waits for running turns: before installing, and (a turn that began meanwhile) before restarting. */
export const DELIVERY_WAIT_CAP_MS: Record<WaitPoint, number> = { install: 10 * 60_000, restart: 2 * 60_000 };

export interface DeliveryWaitOptions {
  /** How many deliveries are under way right now (messages held under a live lease). */
  live: () => number;
  log: (line: string) => void;
  /** Told when a wait begins (with its deadline) and when it is over (null) — `morse status` shows it. */
  onWait?: (w: { before: WaitPoint; since: number; until: number } | null) => void;
  capMs?: Partial<Record<WaitPoint, number>>;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createDeliveryWait(o: DeliveryWaitOptions): (before: WaitPoint) => Promise<{ waitedMs: number; left: number }> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const poll = o.pollMs ?? 2000;
  const live = (): number => {
    try {
      return o.live();
    } catch {
      return 0; // the mailbox cannot be read: never a reason to hold an update back
    }
  };
  return async (before) => {
    const cap = o.capMs?.[before] ?? DELIVERY_WAIT_CAP_MS[before];
    const start = now();
    let n = live();
    if (!n) return { waitedMs: 0, left: 0 };
    const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;
    o.log(`update: ${n} agent turn(s) running — waiting for a quiet moment before the ${before} (at most ${mins(cap)})`);
    const tell = (w: Parameters<NonNullable<DeliveryWaitOptions['onWait']>>[0]) => {
      try {
        o.onWait?.(w);
      } catch {
        /* showing it is best effort */
      }
    };
    tell({ before, since: start, until: start + cap });
    try {
      while (n && now() - start < cap) {
        await sleep(Math.min(poll, Math.max(1, cap - (now() - start))));
        n = live();
      }
    } finally {
      tell(null);
    }
    const waitedMs = now() - start;
    o.log(
      n
        ? `update: ${n} agent turn(s) still running after ${mins(waitedMs)} — going on with the ${before}; a turn the restart cuts is delivered again, marked as a possible repeat`
        : `update: no agent turn running any more (waited ${Math.round(waitedMs / 1000)} s) — going on with the ${before}`,
    );
    return { waitedMs, left: n };
  };
}

/** The line `morse status` prints while an update holds back for a running turn (null: it does not). */
export function updateWaitingLine(waiting: { before: WaitPoint; since: number; until: number } | undefined, now: number = Date.now()): string | null {
  if (!waiting || waiting.until <= now) return null;
  const left = Math.max(1, Math.ceil((waiting.until - now) / 60_000));
  return `  update ready — waiting for a message being handled before the ${waiting.before}, up to ${left} more min (then it goes ahead anyway)`;
}
