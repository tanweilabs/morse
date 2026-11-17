import { createHash, createHmac } from 'node:crypto';
import type { AddressKey } from './address-key.js';

/**
 * (ADR-083 review R4) WHEN each address of this computer replaces its signed prekey.
 *
 * Anyone can ask the relay for an address's current prekey, so anyone can watch the moment its id
 * changes. One timer for the whole daemon (an hourly tick that looked at every address) made that moment
 * a property of the COMPUTER: the prekeys of two of its addresses always changed at the same minute and
 * second past the hour (the daemon's start), and — after a start or a wake-up with several of them due —
 * in the very same instant. Whoever knew two addresses could link them by that alone.
 *
 * So every address has its own grid of moments: wall-clock times `t` with `t ≡ phase (mod period)`, where
 * `phase` is derived from a secret only that address has — an HMAC of the address under a key derived
 * from its own private key. It is stable (a restart, a sleep, an upgrade do not move it), different for
 * every address, and cannot be computed from the address. A prekey is replaced ONLY at a moment of its
 * address's grid:
 *
 *   - never at a daemon start (the prekey that is there is logged in, even when it is due);
 *   - never when a timer fires late (the computer slept, the process was stopped): the next moment of
 *     the grid is waited for instead — so two addresses that both became due while the lid was closed do
 *     not change in the same instant when it opens;
 *   - never while the relay is not connected (the new prekey would be published with the next login —
 *     one moment for every address that waited).
 *
 * The only prekey made outside the grid is the FIRST one of an address (it cannot log in without one).
 */

/** How far apart the moments of one address's grid are. */
export const PREKEY_SLOT_MS = 3600_000;
/** A timer that fires this long after its moment still counts as "at the moment" (a busy process); later = missed. */
export const PREKEY_SLOT_TOLERANCE_MS = 30_000;
/** Timers may fire a hair early: this close before a moment is "at the moment" too. */
const EARLY_MS = 1000;
/**
 * Two current prekeys of one computer dated this close together were made in one go (the release before
 * ADR-083 dated them a millisecond apart, and replaced them in the same tick ever since): one of the two
 * is replaced at its next moment, due or not — see `twinsOf`.
 */
export const PREKEY_TWIN_MS = 10 * 60_000;

/** The secret phase of an address: where in every `periodMs` its moments lie (0 … periodMs − 1). */
export function rotationPhase(key: AddressKey, periodMs: number = PREKEY_SLOT_MS): number {
  const secret = createHash('sha256')
    .update('morse-prekey-phase-key-v1\n')
    .update(key.privateKey.export({ type: 'pkcs8', format: 'der' }))
    .digest();
  const mac = createHmac('sha256', secret).update(`morse-prekey-phase-v1\n${key.address}`).digest();
  return mac.readUIntBE(0, 6) % periodMs;
}

/** The first moment of the grid strictly after `now`. */
export const nextSlot = (now: number, phase: number, periodMs: number = PREKEY_SLOT_MS): number => phase + (Math.floor((now - phase) / periodMs) + 1) * periodMs;

/** How long ago the last moment of the grid was (0 … periodMs − 1). */
export const sinceSlot = (now: number, phase: number, periodMs: number = PREKEY_SLOT_MS): number => (((now - phase) % periodMs) + periodMs) % periodMs;

/** Is `now` a moment of the grid (give or take what a timer is late or early by)? */
export const atSlot = (now: number, phase: number, periodMs: number = PREKEY_SLOT_MS, toleranceMs: number = PREKEY_SLOT_TOLERANCE_MS): boolean => {
  const since = sinceSlot(now, phase, periodMs);
  return since <= toleranceMs || periodMs - since <= EARLY_MS;
};

/**
 * Which of these addresses must replace its prekey although it is not due: every one whose current
 * prekey is dated within `PREKEY_TWIN_MS` of that of an address EARLIER in the list (the first of a group
 * keeps its own — one of two is enough to take the pair apart). The published `createdAt` of the
 * replacement is dated a random stretch back (ensurePrekeys), so the two no longer line up.
 */
export function twinsOf(list: Array<{ address: string; createdAt: number }>, withinMs: number = PREKEY_TWIN_MS): string[] {
  const out: string[] = [];
  list.forEach((x, i) => {
    if (list.slice(0, i).some((y) => Math.abs(y.createdAt - x.createdAt) <= withinMs)) out.push(x.address);
  });
  return out;
}

/** The clock and timers the schedule runs on (tests inject their own). */
export interface RotationClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: RotationClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface RotationSchedule {
  /** The moment each address is next looked at (tests, `morse status`-style diagnostics). */
  next(): Array<{ address: string; at: number }>;
  stop(): void;
}

/**
 * Call `onSlot(key)` at every moment of each address's own grid — and only then: a timer that fires
 * outside the tolerance (late after a sleep) calls nothing and waits for the next moment.
 */
export function startRotationSchedule(opts: {
  keys: AddressKey[];
  onSlot: (key: AddressKey, now: number) => void;
  clock?: RotationClock;
  periodMs?: number;
  toleranceMs?: number;
}): RotationSchedule {
  const clock = opts.clock ?? systemClock;
  const period = opts.periodMs ?? PREKEY_SLOT_MS;
  const tolerance = opts.toleranceMs ?? PREKEY_SLOT_TOLERANCE_MS;
  const timers = new Map<string, { handle: unknown; at: number }>();
  let stopped = false;
  const arm = (key: AddressKey, phase: number, after: number) => {
    if (stopped) return;
    const at = nextSlot(after, phase, period);
    const handle = clock.setTimer(() => {
      const now = clock.now();
      // (re-armed first: whatever `onSlot` does, the next moment stands; `+ EARLY_MS`: a timer that fired a hair
      // early must not arm the very moment it is serving)
      arm(key, phase, now + EARLY_MS);
      if (!atSlot(now, phase, period, tolerance)) return; // missed (the computer slept): not now — at the next moment
      try {
        opts.onSlot(key, now);
      } catch {
        /* the caller logs its own failures; the schedule goes on */
      }
    }, Math.max(0, at - clock.now()));
    timers.set(key.address, { handle, at });
  };
  for (const key of opts.keys) arm(key, rotationPhase(key, period), clock.now());
  return {
    next: () => [...timers.entries()].map(([address, t]) => ({ address, at: t.at })),
    stop: () => {
      stopped = true;
      for (const t of timers.values()) clock.clearTimer(t.handle);
      timers.clear();
    },
  };
}
