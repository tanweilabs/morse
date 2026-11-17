import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { agentRequest } from '../src/cluster/agents.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { startMorse, type Morse } from '../src/cluster/morse.js';
import { loadPrimaryAddress, type AddressKey } from '../src/identity/address-key.js';
import { ensureAgentAddresses } from '../src/identity/agent-addresses.js';
import { atSlot, nextSlot, PREKEY_SLOT_MS, PREKEY_SLOT_TOLERANCE_MS, PREKEY_TWIN_MS, rotationPhase, sinceSlot, startRotationSchedule, twinsOf, type RotationClock } from '../src/identity/prekey-schedule.js';
import { ensurePrekeys, PREKEY_ROTATE_MS } from '../src/identity/prekeys.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

/**
 * (ADR-083 review R4) WHEN the prekey of each address of one computer is replaced — the moment anyone can
 * watch on the relay — is a property of the ADDRESS, not of the computer: each address has its own secret
 * phase within the hour, and its prekey changes only at a moment of that grid. Never at a daemon start,
 * never when a timer fires late (the computer slept), never while the relay is away (the new one would go
 * out with the next login, together with every other address's).
 *
 * Every test runs on an injected clock: nothing here waits for real time to pass.
 */

const HOUR = PREKEY_SLOT_MS;
const DAY = 24 * HOUR;

/** A clock that only moves when the test moves it, with its own timers. */
class TestClock implements RotationClock {
  private queue: Array<{ id: number; at: number; fn: () => void }> = [];
  private ids = 0;
  constructor(public t: number) {}
  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.ids;
    this.queue.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimer = (h: unknown): void => {
    this.queue = this.queue.filter((x) => x.id !== h);
  };
  /** Time passes: every timer fires at its own moment, in order, up to `to`. */
  advanceTo(to: number): void {
    for (;;) {
      const next = this.queue.filter((x) => x.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.queue = this.queue.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = to;
  }
  /** The computer slept until `to`: the clock jumps there and every timer that was due fires NOW, all at once. */
  wakeAt(to: number): void {
    this.t = to;
    const due = this.queue.filter((x) => x.at <= to).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((x) => x.at > to);
    for (const d of due) d.fn();
  }
  /** A timer fires `lateMs` after it was due (a busy process), the clock showing that. */
  fireLate(lateMs: number): void {
    const next = [...this.queue].sort((a, b) => a.at - b.at)[0]!;
    this.queue = this.queue.filter((x) => x !== next);
    this.t = next.at + lateMs;
    next.fn();
  }
  pending(): number {
    return this.queue.length;
  }
}

const homes: string[] = [];
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** A home with one address per agent name (the first is the device key's). */
const homeWith = (agents: string[]) => {
  const home = mkdtempSync(join(tmpdir(), 'morse-rotation-'));
  homes.push(home);
  const identity = loadOrCreateIdentity(home);
  updateMachineConfig((cfg) => {
    cfg['relay'] = { handle: 'rothandle', agent: agents[0], agents };
  }, join(home, '.morse', 'config.json'));
  const first = loadPrimaryAddress(home, identity);
  const keys = agents.map((a) => (a === agents[0] ? first : ensureAgentAddresses(home).find((x) => x.agent === a)!.key));
  return { home, identity, keys };
};

const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('each address has its own secret phase (ADR-083 review R4)', () => {
  it('is stable, lies within the period, differs between addresses — and comes from the private key, not from the address', () => {
    const { keys } = homeWith(['p1', 'p2', 'p3']);
    const phases = keys.map((k) => rotationPhase(k));
    for (const p of phases) expect(p >= 0 && p < HOUR && Number.isInteger(p)).toBe(true);
    expect(keys.map((k) => rotationPhase(k))).toEqual(phases); // the same every time it is asked
    expect(new Set(phases).size).toBe(3);
    // another period: another grid, still stable
    expect(rotationPhase(keys[0]!, 60_000)).toBe(rotationPhase(keys[0]!, 60_000));
    expect(rotationPhase(keys[0]!, 60_000)).toBeLessThan(60_000);
    // the same ADDRESS with another private key gives another phase: knowing the address is not enough
    const forged: AddressKey = { ...keys[0]!, privateKey: keys[1]!.privateKey };
    expect(rotationPhase(forged)).not.toBe(phases[0]);
    // a home made again from scratch has other keys, so other phases; the same home read again has the same
    const again = homeWith(['p1', 'p2', 'p3']);
    expect(again.keys.map((k) => rotationPhase(k))).not.toEqual(phases);
  });

  it('nextSlot / sinceSlot / atSlot describe one grid: t ≡ phase (mod period)', () => {
    const phase = 1_234_567;
    const now = 1_800_000_000_000;
    const next = nextSlot(now, phase);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(HOUR);
    expect(next % HOUR).toBe(phase);
    expect(nextSlot(next, phase)).toBe(next + HOUR); // strictly after
    expect(sinceSlot(next, phase)).toBe(0);
    expect(sinceSlot(next + 5000, phase)).toBe(5000);
    expect(atSlot(next, phase)).toBe(true);
    expect(atSlot(next + PREKEY_SLOT_TOLERANCE_MS, phase)).toBe(true);
    expect(atSlot(next + PREKEY_SLOT_TOLERANCE_MS + 1, phase)).toBe(false);
    expect(atSlot(next - 500, phase)).toBe(true); // a timer a hair early
    expect(atSlot(next - 5000, phase)).toBe(false);
    expect(atSlot(next + HOUR / 2, phase)).toBe(false);
  });

  it('twinsOf: of prekeys dated together, all but the first must be replaced; prekeys dated apart are left alone', () => {
    const t = 1_800_000_000_000;
    expect(twinsOf([{ address: 'a', createdAt: t }, { address: 'b', createdAt: t + 1 }, { address: 'c', createdAt: t + 2 }])).toEqual(['b', 'c']);
    expect(twinsOf([{ address: 'a', createdAt: t }, { address: 'b', createdAt: t + DAY }, { address: 'c', createdAt: t + DAY + PREKEY_TWIN_MS }])).toEqual(['c']);
    expect(twinsOf([{ address: 'a', createdAt: t }, { address: 'b', createdAt: t + PREKEY_TWIN_MS + 1 }])).toEqual([]);
    expect(twinsOf([{ address: 'a', createdAt: t }])).toEqual([]);
  });
});

describe('the schedule calls each address at its own moments, and only then (ADR-083 review R4)', () => {
  it('three addresses over five hours: each is called once an hour at t ≡ its phase, never two in the same instant', () => {
    const { keys } = homeWith(['s1', 's2', 's3']);
    const clock = new TestClock(1_800_000_000_000);
    const calls: Array<{ address: string; at: number }> = [];
    const schedule = startRotationSchedule({ keys, clock, onSlot: (k, now) => calls.push({ address: k.address, at: now }) });
    cleanup.push(() => schedule.stop());
    expect(calls).toEqual([]); // starting calls nobody
    expect(schedule.next().map((n) => n.address).sort()).toEqual(keys.map((k) => k.address).sort());
    for (const n of schedule.next()) expect(n.at % HOUR).toBe(rotationPhase(keys.find((k) => k.address === n.address)!));
    clock.advanceTo(clock.t + 5 * HOUR);
    for (const k of keys) {
      const mine = calls.filter((c) => c.address === k.address);
      expect(mine).toHaveLength(5);
      for (const c of mine) expect(c.at % HOUR).toBe(rotationPhase(k));
      expect(mine.map((c) => c.at - mine[0]!.at)).toEqual([0, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]);
    }
    expect(new Set(calls.map((c) => c.at)).size).toBe(calls.length);
    schedule.stop();
    expect(clock.pending()).toBe(0);
    const n = calls.length;
    clock.advanceTo(clock.t + 3 * HOUR);
    expect(calls).toHaveLength(n); // stopped: nothing fires
  });

  it('a start does not move the grid: the same addresses started again an odd while later are called at the same minute and second of the hour', () => {
    const { keys } = homeWith(['g1', 'g2']);
    const first = new TestClock(1_800_000_000_000);
    const a = startRotationSchedule({ keys, clock: first, onSlot: () => undefined });
    const before = Object.fromEntries(a.next().map((n) => [n.address, n.at % HOUR]));
    a.stop();
    const later = new TestClock(1_800_000_000_000 + 17 * DAY + 1_234_567);
    const b = startRotationSchedule({ keys, clock: later, onSlot: () => undefined });
    cleanup.push(() => b.stop());
    expect(Object.fromEntries(b.next().map((n) => [n.address, n.at % HOUR]))).toEqual(before);
  });

  it('the computer slept through several moments: at wake-up every timer fires at once — nobody is called; each address is called at its next own moment', () => {
    const { keys } = homeWith(['w1', 'w2', 'w3']);
    const start = 1_800_000_000_000;
    const clock = new TestClock(start);
    const calls: Array<{ address: string; at: number }> = [];
    const schedule = startRotationSchedule({ keys, clock, onSlot: (k, now) => calls.push({ address: k.address, at: now }) });
    cleanup.push(() => schedule.stop());
    // a wake-up moment that is nobody's (more than the tolerance after, and well before, every address's moment)
    const phases = keys.map((k) => rotationPhase(k));
    let wake = start + 7 * HOUR;
    while (phases.some((p) => atSlot(wake, p) || HOUR - sinceSlot(wake, p) < 2000)) wake += 1000;
    clock.wakeAt(wake);
    expect(calls).toEqual([]); // three timers fired in the same instant: none acted
    expect(clock.pending()).toBe(3); // each waits for its own next moment
    clock.advanceTo(wake + HOUR);
    expect(calls.map((c) => c.address).sort()).toEqual(keys.map((k) => k.address).sort());
    for (const c of calls) expect(c.at % HOUR).toBe(rotationPhase(keys.find((k) => k.address === c.address)!));
    expect(new Set(calls.map((c) => c.at)).size).toBe(3);
  });

  it('a timer that is a little late (a busy process) still counts; one later than the tolerance does not', () => {
    const { keys } = homeWith(['t1']);
    const clock = new TestClock(1_800_000_000_000);
    const calls: number[] = [];
    const schedule = startRotationSchedule({ keys, clock, onSlot: (_k, now) => calls.push(now) });
    cleanup.push(() => schedule.stop());
    clock.fireLate(PREKEY_SLOT_TOLERANCE_MS - 1);
    expect(calls).toHaveLength(1);
    clock.fireLate(PREKEY_SLOT_TOLERANCE_MS + 1);
    expect(calls).toHaveLength(1);
    clock.fireLate(0);
    expect(calls).toHaveLength(2);
    expect(clock.pending()).toBe(1);
  });
});

describe('ensurePrekeys: a start replaces nothing, a twin is replaced though it is not due (ADR-083 review R4)', () => {
  it('`rotate: false` keeps a prekey that is due and makes one only where there is none; `force` replaces one that is not due', () => {
    const { keys } = homeWith(['e1', 'e2']);
    const t = 1_800_000_000_000;
    const made = ensurePrekeys(keys[0]!, t, { rotate: false });
    expect(made.rotated).toBe(true); // none yet: made
    const kept = ensurePrekeys(keys[0]!, t + PREKEY_ROTATE_MS + DAY, { rotate: false });
    expect([kept.rotated, kept.current.id]).toEqual([false, made.current.id]);
    const due = ensurePrekeys(keys[0]!, t + PREKEY_ROTATE_MS + DAY);
    expect(due.rotated).toBe(true);
    expect(due.keys.map((k) => k.id)).toEqual([due.current.id, made.current.id]); // the old one is kept to open late mail
    const young = ensurePrekeys(keys[1]!, t);
    expect(ensurePrekeys(keys[1]!, t + 1000).rotated).toBe(false);
    const forced = ensurePrekeys(keys[1]!, t + 1000, { force: true });
    expect([forced.rotated, forced.current.id !== young.current.id, forced.current.createdAt]).toEqual([true, true, t + 1000]);
    expect(ensurePrekeys(keys[1]!, t + 2000, { force: true, rotate: false }).rotated).toBe(false); // a start never replaces
  });
});

// --- the daemon ------------------------------------------------------------------------------------------------

interface Daemon {
  morse: Morse;
  logs: string[];
  stop(): void;
}

describe('the daemon: what the relay answers for each address changes at that address\'s own moment (ADR-083 review R4)', () => {
  let relay: FakeRelay;
  const relayAt = async (port: number, id: string) => {
    relay = await startFakeRelay({ port, host: '127.0.0.1', v3: true, allowlist: [{ id, handle: 'rothandle' }], log: () => undefined });
    return relay;
  };
  const daemon = async (h: ReturnType<typeof homeWith>, clock: TestClock, url: string): Promise<Daemon> => {
    const ctx = homeContactContext(h.home);
    const db = createDb(':memory:', { ctx });
    const logs: string[] = [];
    const morse = startMorse({ url, home: h.home, mailbox: createMailbox(db, { ctx }), connectWaitMs: 1000, log: (l) => logs.push(l), prekeyClock: clock });
    let stopped = false;
    const d: Daemon = {
      morse,
      logs,
      stop: () => {
        if (stopped) return;
        stopped = true;
        morse.stop();
        db.close();
      },
    };
    cleanup.push(() => d.stop());
    await until(() => Boolean(morse.v3Client?.()?.connected()) && h.keys.every((k) => relay.onlineAddresses().includes(k.address)), 'every address to be online');
    return d;
  };
  /** What anyone who asks the relay is told: the id and date of each address's prekey. */
  const published = async (d: Daemon, keys: AddressKey[]) => Promise.all(keys.map(async (k) => (await d.morse.v3Client!()!.lookupAddress!(k.address)).prekey?.id ?? null));
  const onDisk = (keys: AddressKey[], at: number) => keys.map((k) => ensurePrekeys(k, at, { rotate: false }).current.id);
  const setup = async (agents: string[]) => {
    const h = homeWith(agents);
    await relayAt(0, h.identity.id);
    cleanup.push(() => relay.close());
    await agentRequest({ url: relay.url, op: 'add', agent: agents[0]!, home: h.home });
    return h;
  };

  it('prekeys of two addresses that are both due when the daemon starts: nothing changes at the start; each is replaced and published at its own moment, the other untouched', async () => {
    const h = await setup(['d1', 'd2']);
    const [A, B] = h.keys as [AddressKey, AddressKey];
    const start = Date.now();
    // both made long ago, a day apart (not twins): both are due before the daemon starts
    const old = [ensurePrekeys(A, start - 9 * DAY).current.id, ensurePrekeys(B, start - 8 * DAY).current.id];
    const clock = new TestClock(start);
    const d = await daemon(h, clock, relay.url);
    expect(await published(d, [A, B])).toEqual(old); // the start replaced nobody's prekey: the old ones logged in
    expect(onDisk([A, B], clock.t)).toEqual(old);

    const slots = Object.fromEntries(d.morse.prekeySlots!().map((s) => [s.address, s.at]));
    expect(slots[A.address]! % HOUR).toBe(rotationPhase(A));
    expect(slots[B.address]! % HOUR).toBe(rotationPhase(B));
    expect(slots[A.address]).not.toBe(slots[B.address]);
    for (const at of Object.values(slots)) expect(at > start && at <= start + HOUR).toBe(true);

    const [firstKey, secondKey] = slots[A.address]! < slots[B.address]! ? [A, B] : [B, A];
    const idx = (k: AddressKey) => (k === A ? 0 : 1);
    // the first address's moment comes: its prekey is replaced and published — the other one's is not
    clock.advanceTo(slots[firstKey.address]!);
    await until(async () => (await published(d, [firstKey]))[0] !== old[idx(firstKey)], "the first one's new prekey on the relay");
    expect((await published(d, [secondKey]))[0]).toBe(old[idx(secondKey)]);
    expect(ensurePrekeys(firstKey, clock.t, { rotate: false }).current.createdAt).toBe(slots[firstKey.address]); // made AT its moment
    // …and a second before the other's moment still nothing
    clock.advanceTo(slots[secondKey.address]! - 1000);
    expect(onDisk([secondKey], clock.t)).toEqual([old[idx(secondKey)]]);
    clock.advanceTo(slots[secondKey.address]!);
    await until(async () => (await published(d, [secondKey]))[0] !== old[idx(secondKey)], "the second one's new prekey on the relay");
    expect(ensurePrekeys(secondKey, clock.t, { rotate: false }).current.createdAt).toBe(slots[secondKey.address]);

    // from then on: nothing for (almost) a week; each is replaced again at a moment of its OWN grid
    const now = await published(d, [A, B]);
    clock.advanceTo(start + 6 * DAY);
    expect(await published(d, [A, B])).toEqual(now);
    clock.advanceTo(start + 8 * DAY);
    await until(async () => (await published(d, [A, B])).every((id, i) => id !== now[i]), 'both to be replaced a week later');
    const again = [A, B].map((k) => ensurePrekeys(k, clock.t, { rotate: false }).current.createdAt);
    expect(again[0]! % HOUR).toBe(rotationPhase(A));
    expect(again[1]! % HOUR).toBe(rotationPhase(B));
    expect(again[0]).toBe(slots[A.address]! + PREKEY_ROTATE_MS); // exactly a week after the last, at the same minute and second
    expect(again[1]).toBe(slots[B.address]! + PREKEY_ROTATE_MS);

    // a restart moves nothing: the same grid, and no prekey replaced by starting
    const ids = await published(d, [A, B]);
    d.stop();
    await until(() => relay.onlineAddresses().length === 0, 'the daemon to be gone');
    clock.t += 12_345;
    const d2 = await daemon(h, clock, relay.url);
    expect(await published(d2, [A, B])).toEqual(ids);
    for (const s of d2.morse.prekeySlots!()) expect(s.at % HOUR).toBe(rotationPhase(s.address === A.address ? A : B));
  }, 60_000);

  it('prekeys the release before dated a millisecond apart (and one made another day): the twin of the first address is replaced at its own next moment though it is not due — the first address and the third keep theirs', async () => {
    const h = await setup(['u1', 'u2', 'u3']);
    const [A, B, C] = h.keys as [AddressKey, AddressKey, AddressKey];
    const start = Date.now();
    const made = start - 1 * DAY;
    const old = [ensurePrekeys(A, made).current, ensurePrekeys(B, made + 1).current, ensurePrekeys(C, start - 3 * DAY).current];
    expect(old[1]!.createdAt - old[0]!.createdAt).toBe(1); // what anyone could read off the relay before
    const clock = new TestClock(start);
    const d = await daemon(h, clock, relay.url);
    expect(await published(d, [A, B, C])).toEqual(old.map((p) => p.id)); // not at the start
    const slotB = d.morse.prekeySlots!().find((s) => s.address === B.address)!.at;
    clock.advanceTo(slotB - 1);
    expect(onDisk([B], clock.t)).toEqual([old[1]!.id]);
    clock.advanceTo(start + HOUR + 1); // every address has had one moment
    await until(async () => (await published(d, [B]))[0] !== old[1]!.id, "the twin's new prekey on the relay");
    const fresh = ensurePrekeys(B, clock.t, { rotate: false }).current;
    expect(fresh.createdAt).toBe(slotB);
    expect((await published(d, [A, C]))).toEqual([old[0]!.id, old[2]!.id]);
    // once is enough: at its next moments B is left alone until it is due
    clock.advanceTo(start + 5 * HOUR);
    expect(onDisk([A, B, C], clock.t)).toEqual([old[0]!.id, fresh.id, old[2]!.id]);
  }, 60_000);

  it('while the relay is away nothing is replaced (it would be published with the next login, for every address at once); after the login each address waits for its own moment', async () => {
    const h = await setup(['r1', 'r2']);
    const [A, B] = h.keys as [AddressKey, AddressKey];
    const start = Date.now();
    const old = [ensurePrekeys(A, start - 9 * DAY).current.id, ensurePrekeys(B, start - 8 * DAY).current.id];
    const clock = new TestClock(start);
    const d = await daemon(h, clock, relay.url);
    const port = relay.port;
    await relay.close();
    await until(() => !d.morse.v3Client!()!.connected(), 'the daemon to notice the relay is gone');
    clock.advanceTo(start + 3 * HOUR); // three moments of each address pass
    expect(onDisk([A, B], clock.t)).toEqual(old);
    // the relay is back: the login publishes what there was — the OLD prekeys, for both
    await relayAt(port, h.identity.id);
    cleanup.push(() => relay.close());
    await until(() => Boolean(d.morse.v3Client!()!.connected()) && [A, B].every((k) => relay.onlineAddresses().includes(k.address)), 'the daemon to log in again', 30_000);
    expect(await published(d, [A, B])).toEqual(old);
    expect(onDisk([A, B], clock.t)).toEqual(old);
    // …and then each at its own moment
    const slots = Object.fromEntries(d.morse.prekeySlots!().map((s) => [s.address, s.at]));
    const [firstKey, secondKey] = slots[A.address]! < slots[B.address]! ? [A, B] : [B, A];
    clock.advanceTo(slots[firstKey.address]!);
    await until(async () => (await published(d, [firstKey]))[0] !== old[firstKey === A ? 0 : 1], 'the first to be replaced');
    expect((await published(d, [secondKey]))[0]).toBe(old[secondKey === A ? 0 : 1]);
    clock.advanceTo(slots[secondKey.address]!);
    await until(async () => (await published(d, [secondKey]))[0] !== old[secondKey === A ? 0 : 1], 'the second to be replaced');
  }, 90_000);

  it('the computer slept for a day with both prekeys due: at wake-up neither is replaced; each follows at its own moment', async () => {
    const h = await setup(['z1', 'z2']);
    const [A, B] = h.keys as [AddressKey, AddressKey];
    const start = Date.now();
    const old = [ensurePrekeys(A, start - 6 * DAY - 23 * HOUR).current.id, ensurePrekeys(B, start - 6 * DAY - 22 * HOUR).current.id];
    const clock = new TestClock(start);
    const d = await daemon(h, clock, relay.url);
    let wake = start + DAY;
    while ([A, B].some((k) => atSlot(wake, rotationPhase(k)) || HOUR - sinceSlot(wake, rotationPhase(k)) < 2000)) wake += 1000;
    clock.wakeAt(wake);
    expect(onDisk([A, B], clock.t)).toEqual(old); // both timers fired in the same instant — and did nothing
    expect(await published(d, [A, B])).toEqual(old);
    clock.advanceTo(wake + HOUR);
    await until(async () => (await published(d, [A, B])).every((id, i) => id !== old[i]), 'both to be replaced within the hour');
    const at = [A, B].map((k) => ensurePrekeys(k, clock.t, { rotate: false }).current.createdAt);
    expect(at[0]! % HOUR).toBe(rotationPhase(A));
    expect(at[1]! % HOUR).toBe(rotationPhase(B));
    expect(at[0]).not.toBe(at[1]);
  }, 60_000);
});
