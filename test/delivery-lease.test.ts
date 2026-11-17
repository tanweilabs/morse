import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/mailbox/db.js';
import { collectInbox } from '../src/hooks/prompt-hook.js';
import { POSSIBLE_REPEAT_LINE } from '../src/envelope.js';
import { createMailbox, LeaseLostError, LEASE_ORPHAN_MAX_MS, LEASE_TTL_MS, processStartTime, STRANDED_NOTE, type Mailbox, type Message } from '../src/mailbox/mailbox.js';

/**
 * ADR-089: a delivery belongs to its holder. The sequences an independent review found (a daemon restart
 * that lands during an agent's turn delivered the message TWICE), on an in-memory mailbox with a clock and
 * a process table of its own. Each ends with exactly ONE delivery — or with a repeat that is labelled.
 */

const A = { agent: 'claude', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' };
const B = { agent: 'codex', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' };

function world() {
  let t = 1_000_000;
  const alive = new Set<number>();
  const mailbox: Mailbox = createMailbox(createDb(':memory:'), { now: () => t, pidAlive: (pid) => alive.has(pid) });
  const send = (text = 'do the thing'): Message => mailbox.send({ from: A, to: B, text });
  /**
   * What the dispatch plugin does: the oldest due own-agent message for a session here, under a lease — and
   * (unless `start` is false) what it says right before it starts the agent: a turn is being started for it.
   */
  const claim = (pid: number, start = true) => {
    const c = mailbox.claimNextPending({ scope: 'local', pullOnlySessions: ['inbox'], lease: { pid } });
    if (c && start) mailbox.extendLease(c.id, c.lease!.holder, { started: true, ttlMs: c.lease!.expiresAt - t });
    return c;
  };
  return {
    mailbox,
    send,
    claim,
    alive,
    tick: (ms: number) => void (t += ms),
    now: () => t,
    status: (id: string) => mailbox.getMessage(id)!.status,
  };
}

describe('a lease: who holds a delivery, since when, until when', () => {
  it('claim with a lease returns the holder; nobody else can claim the row while the lease is live', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const c = w.claim(100)!;
    expect(c.id).toBe(m.id);
    expect(c.status).toBe('delivering');
    expect(c.lease).toEqual({ holder: expect.stringMatching(/^[0-9a-f-]{36}$/), pid: 100, since: w.now(), expiresAt: w.now() + LEASE_TTL_MS });
    expect(c.possibleRepeat).toBeUndefined();
    expect(w.claim(200)).toBeNull();
    expect(w.mailbox.claimById(m.id, { pid: 200 })).toBeNull();
    expect(w.mailbox.liveLeases().map((x) => x.id)).toEqual([m.id]);
  });

  it('live = not expired OR its process still running; dead = expired AND the process gone — only then can it be taken over', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const first = w.claim(100)!;
    // expired, but the process is still running (a long turn whose renewals were held up): not takeable
    w.tick(LEASE_TTL_MS + 1);
    expect(w.claim(200)).toBeNull();
    // the process is gone, and the lease is long expired: takeable — and it is said to be a possible repeat
    w.alive.delete(100);
    w.alive.add(200);
    const second = w.claim(200)!;
    expect(second.id).toBe(m.id);
    expect(second.lease!.holder).not.toBe(first.lease!.holder);
    expect(second.possibleRepeat).toBe(true);
    expect(second.attempts).toBe(0); // attempts count reported failures — an interrupted delivery is counted apart
  });

  it('a process that died does not free the row before the lease has expired (its holder may be about to report)', () => {
    const w = world();
    w.send();
    w.alive.add(100);
    w.claim(100);
    w.alive.delete(100);
    w.tick(LEASE_TTL_MS - 1000);
    expect(w.claim(200)).toBeNull();
    w.tick(2000);
    expect(w.claim(200)).not.toBeNull();
  });

  it('extend: the holder renews, and can tie the lease to another process (the agent CLI it started); anybody else cannot', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const c = w.claim(100)!;
    w.tick(30_000);
    expect(w.mailbox.extendLease(m.id, 'not-the-holder')).toBe(false);
    expect(w.mailbox.extendLease(m.id, c.lease!.holder, { pid: 4242 })).toBe(true);
    expect(w.mailbox.getMessage(m.id)!.lease).toMatchObject({ holder: c.lease!.holder, pid: 4242, expiresAt: w.now() + LEASE_TTL_MS });
    // the plugin dies; the turn (pid 4242) runs on as an orphan: however long it takes, nobody takes the row
    w.alive.delete(100);
    w.alive.add(4242);
    w.tick(20 * 60_000);
    expect(w.claim(200)).toBeNull();
    // it ends: now the row can be taken over
    w.alive.delete(4242);
    expect(w.claim(200)).toMatchObject({ id: m.id, possibleRepeat: true });
  });

  it('a pid that is "alive" for ever (reused by another program) does not hold a row for ever: two hours past expiry it is dead', () => {
    const w = world();
    w.send();
    w.alive.add(100);
    w.claim(100);
    w.tick(LEASE_TTL_MS + 2 * 3_600_000 - 1000);
    expect(w.claim(200)).toBeNull();
    w.tick(2000);
    expect(w.claim(200)).not.toBeNull();
  });
});

describe('only the current holder\'s report counts (review N2)', () => {
  it('two holders: the earlier one acks late — refused, nothing changes; the current one acks — delivered once', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const h1 = w.claim(100)!.lease!.holder;
    w.alive.delete(100);
    w.tick(LEASE_TTL_MS + 1);
    w.alive.add(200);
    const h2 = w.claim(200)!.lease!.holder;
    // the earlier holder was not dead after all, and reports now
    expect(() => w.mailbox.markDelivered(m.id, { holder: h1 })).toThrow(LeaseLostError);
    expect(() => w.mailbox.markFailed(m.id, 'boom', { holder: h1 })).toThrow(LeaseLostError);
    expect(w.mailbox.release(m.id, h1)).toBe(false);
    expect(w.mailbox.toMailbox(m.id, 'gone', h1)).toBe(false);
    expect(w.mailbox.extendLease(m.id, h1)).toBe(false);
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivering', lease: { holder: h2 } });
    // the current holder's ack counts — and does not fail with "delivered -> delivered"
    expect(w.mailbox.markDelivered(m.id, { holder: h2 }).status).toBe('delivered');
    expect(w.mailbox.getMessage(m.id)!.lease).toBeUndefined();
    // a second report by anybody is refused
    expect(() => w.mailbox.markDelivered(m.id, { holder: h2 })).toThrow(LeaseLostError);
    expect(() => w.mailbox.markDelivered(m.id, { holder: h1 })).toThrow(LeaseLostError);
  });

  it('a row held under a lease is not acked, failed or handed back by a caller that names no holder', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    w.claim(100);
    expect(() => w.mailbox.markDelivered(m.id)).toThrow(LeaseLostError);
    expect(() => w.mailbox.markFailed(m.id, 'x')).toThrow(LeaseLostError);
    expect(w.mailbox.release(m.id)).toBe(false);
    expect(w.status(m.id)).toBe('delivering');
  });

  it('the holder hands it back (release): pending again, no lease, not a repeat; nack: failed, retried after the backoff as before', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const h = w.claim(100)!.lease!.holder;
    expect(w.mailbox.release(m.id, h)).toBe(true);
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'pending', attempts: 0 });
    const again = w.claim(100)!;
    expect(again.possibleRepeat).toBeUndefined();
    expect(w.mailbox.markFailed(m.id, 'agent CLI not found', { holder: again.lease!.holder })).toMatchObject({ status: 'failed', attempts: 1 });
    expect(w.claim(100)).toBeNull(); // backoff
    w.tick(30_001);
    expect(w.claim(100)).toMatchObject({ id: m.id });
  });
});

describe('the review\'s sequences — a restart during a turn', () => {
  it('1. restart mid-turn, the old holder finishes late: its ack counts, the new plugin never gets the row — ONE delivery', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100); // the plugin of the run before, still finishing its turn
    const h = w.claim(100)!.lease!.holder;
    // the daemon restarts: its start-up recovery, then the new plugin's own
    expect(w.mailbox.recoverStale()).toBe(0);
    expect(w.mailbox.recoverStale(true)).toBe(0);
    expect(w.status(m.id)).toBe('delivering');
    w.alive.add(200);
    // the new plugin looks for work again and again while the turn runs on — far beyond the old 30 s
    for (let i = 0; i < 20; i++) {
      w.tick(15_000);
      w.mailbox.extendLease(m.id, h); // the old holder is alive and renews
      expect(w.claim(200)).toBeNull();
    }
    expect(w.mailbox.markDelivered(m.id, { holder: h }).status).toBe('delivered');
    expect(w.claim(200)).toBeNull();
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivered', attempts: 0 });
  });

  it('2. the old plugin is gone, its turn too (the job was killed): after the lease has run out the new plugin takes it — ONE repeat, labelled', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    w.claim(100);
    w.alive.delete(100); // killed with the daemon
    w.mailbox.recoverStale();
    w.alive.add(200);
    expect(w.claim(200)).toBeNull(); // not "30 seconds later": the lease is not out yet
    w.tick(LEASE_TTL_MS + 1);
    const again = w.claim(200)!;
    expect(again).toMatchObject({ id: m.id, possibleRepeat: true });
    expect(w.mailbox.markDelivered(m.id, { holder: again.lease!.holder }).status).toBe('delivered');
    expect(w.claim(200)).toBeNull();
  });

  it('3. a prompt typed into the same session right after the restart does not get the message while its holder\'s turn may still be running', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const h = w.claim(100)!.lease!.holder;
    w.mailbox.recoverStale();
    // the prompt hook's pulls for this session: new mail, dead letters, set-aside ones, dead leases
    const pull = () => [
      ...w.mailbox.inbox({ toSession: B.sessionId, take: true, pendingOnly: true }),
      ...w.mailbox.inbox({ toSession: B.sessionId, take: true, undeliveredOnly: true }),
      ...w.mailbox.inbox({ toSession: B.sessionId, take: true, strandedOnly: true }),
      ...w.mailbox.inbox({ toSession: B.sessionId, take: true, deadLeaseOnly: true }),
    ];
    expect(pull()).toEqual([]);
    w.tick(LEASE_TTL_MS + 1); // expired, but the holder's process is still there
    expect(pull()).toEqual([]);
    expect(w.status(m.id)).toBe('delivering');
    // …and a take that names no status at all never marks a live-leased row either
    expect(w.mailbox.inbox({ toSession: B.sessionId, take: true })).toEqual([]);
    expect(w.status(m.id)).toBe('delivering');
    expect(w.mailbox.markDelivered(m.id, { holder: h }).status).toBe('delivered');
  });

  it('3b. once the holder is really gone, the session that asks gets the message — labelled as a possible repeat — and it is taken', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const h = w.claim(100)!.lease!.holder;
    w.alive.delete(100);
    w.tick(LEASE_TTL_MS + 1);
    const got = w.mailbox.inbox({ toSession: B.sessionId, take: true, deadLeaseOnly: true });
    expect(got.map((x) => [x.id, x.possibleRepeat])).toEqual([[m.id, true]]);
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivered' });
    expect(w.mailbox.getMessage(m.id)!.lease).toBeUndefined();
    // the dispatch plugin does not get it any more, and the gone holder's late ack is refused
    w.alive.add(200);
    expect(w.claim(200)).toBeNull();
    expect(() => w.mailbox.markDelivered(m.id, { holder: h })).toThrow(LeaseLostError);
  });

  it('4. the daemon AND the plugin crash: the row is not stuck — recovered by the next claim once the lease is dead', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    w.claim(100);
    w.alive.clear(); // everything died; nobody ran any recovery
    w.tick(LEASE_TTL_MS + 1);
    w.alive.add(300);
    expect(w.claim(300)).toMatchObject({ id: m.id, possibleRepeat: true, attempts: 0 });
  });

  it('a message whose every delivery is interrupted is not redelivered for ever: after three it is dead, with the reason', () => {
    const w = world();
    const m = w.send();
    for (const pid of [100, 200, 300]) {
      w.alive.add(pid);
      expect(w.claim(pid)).not.toBeNull();
      w.alive.delete(pid);
      w.tick(LEASE_TTL_MS + 1);
    }
    w.alive.add(400);
    expect(w.claim(400)).toBeNull();
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'dead', lastError: expect.stringContaining('interrupted') });
  });
});

describe('a plugin that asks for no lease keeps today\'s semantics (the weaker guarantee)', () => {
  it('claim without a lease: no holder; ack / nack / release without one work as before', () => {
    const w = world();
    const a = w.send('one');
    const b = w.send('two');
    const c = w.mailbox.claimNextPending({ scope: 'local' })!;
    expect(c.id).toBe(a.id);
    expect(c.lease).toBeUndefined();
    expect(w.mailbox.markDelivered(a.id).status).toBe('delivered');
    expect(w.mailbox.claimById(b.id)).toMatchObject({ id: b.id });
    expect(w.mailbox.release(b.id)).toBe(true);
    expect(w.status(b.id)).toBe('pending');
  });

  it('a restart sets its row aside as before (recoverStale), its late ack is still accepted — and a redelivery is labelled', () => {
    const w = world();
    const m = w.send();
    w.mailbox.claimNextPending({ scope: 'local' });
    expect(w.mailbox.recoverStale(true)).toBe(1);
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'failed', lastError: STRANDED_NOTE });
    // (a) the old holder reports after all: accepted, as before
    expect(w.mailbox.markDelivered(m.id).status).toBe('delivered');

    const n = w.send('another');
    w.mailbox.claimNextPending({ scope: 'local' });
    w.mailbox.recoverStale(true);
    // (b) nobody reports: after the 30 s backoff it is claimed again — and marked as a possible repeat
    expect(w.mailbox.claimNextPending({ scope: 'local' })).toBeNull();
    w.tick(30_001);
    expect(w.mailbox.claimNextPending({ scope: 'local' })).toMatchObject({ id: n.id, possibleRepeat: true });
  });

  it('a leased row is never set aside by a recovery, whoever runs it', () => {
    const w = world();
    const legacy = w.send('legacy');
    w.mailbox.claimNextPending({ scope: 'local' });
    const leased = w.send('leased');
    w.alive.add(100);
    w.claim(100);
    expect(w.mailbox.recoverStale()).toBe(1);
    expect(w.status(legacy.id)).toBe('failed');
    expect(w.status(leased.id)).toBe('delivering');
  });
});

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'morse-lease-unit-'));
  tmpDirs.push(d);
  return d;
};

describe('review F3: only a turn that was really started makes a takeover a possible repeat', () => {
  it('a claim whose holder died before it started an agent is handed out again as if nothing had happened — no label, not counted, however often', () => {
    const w = world();
    const m = w.send();
    for (let i = 0; i < 6; i++) {
      const pid = 100 + i;
      w.alive.add(pid);
      const c = w.claim(pid, false)!; // claimed, the holder dies before `started`
      expect(c.id).toBe(m.id);
      expect(c.possibleRepeat).toBeUndefined();
      expect(c.lease!.started).toBeUndefined();
      w.alive.delete(pid);
      w.tick(LEASE_TTL_MS + 1);
    }
    expect(w.status(m.id)).toBe('delivering'); // never dead: no turn ever ran
    // …and the session's own pull takes it without a label either
    const got = w.mailbox.inbox({ toSession: B.sessionId, take: true, deadLeaseOnly: true });
    expect(got.map((x) => [x.id, x.possibleRepeat])).toEqual([[m.id, undefined]]);
  });

  it('`started` is said once, by the holder only, and is what the next takeover goes by', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const c = w.claim(100, false)!;
    expect(w.mailbox.extendLease(m.id, 'not-the-holder', { started: true })).toBe(false);
    expect(w.mailbox.getMessage(m.id)!.lease!.started).toBeUndefined();
    expect(w.mailbox.extendLease(m.id, c.lease!.holder, { started: true })).toBe(true);
    expect(w.mailbox.getMessage(m.id)!.lease!.started).toBe(true);
    w.alive.delete(100);
    w.tick(LEASE_TTL_MS + 1);
    w.alive.add(200);
    const again = w.claim(200, false)!;
    expect(again.possibleRepeat).toBe(true);
    expect(again.lease!.started).toBeUndefined(); // a new claim: nothing started for it yet
  });
});

describe('review F4: when a message is given up, and what its session is told', () => {
  it('three interrupted turns IN A ROW make it dead — a holder that reports in between (a failed turn) starts the count again', () => {
    const w = world();
    const m = w.send();
    const interrupt = (pid: number) => {
      w.alive.add(pid);
      const c = w.claim(pid);
      w.alive.delete(pid);
      w.tick(LEASE_TTL_MS + 1);
      return c;
    };
    expect(interrupt(100)).not.toBeNull();
    expect(interrupt(200)).not.toBeNull();
    // the third turn runs to its end and REPORTS a failure: not an interruption
    w.alive.add(300);
    const third = w.claim(300)!;
    expect(third.possibleRepeat).toBe(true);
    w.mailbox.markFailed(m.id, 'the agent CLI exited 1', { holder: third.lease!.holder });
    w.tick(31_000);
    // two more interrupted turns are still not three in a row
    expect(interrupt(400)).not.toBeNull();
    expect(interrupt(500)).not.toBeNull();
    w.alive.add(600);
    expect(w.claim(600)).toMatchObject({ id: m.id, possibleRepeat: true });
    expect(w.status(m.id)).toBe('delivering');
  });

  it('the dead message reaches its session through the prompt hook WITH the repeat line (up to three turns ran), and `morse message` data shows why it is dead', () => {
    const w = world();
    const m = w.send('ship the release notes');
    for (const pid of [100, 200, 300]) {
      w.alive.add(pid);
      w.claim(pid);
      w.alive.delete(pid);
      w.tick(LEASE_TTL_MS + 1);
    }
    w.alive.add(400);
    expect(w.claim(400)).toBeNull();
    const dead = w.mailbox.getMessage(m.id)!;
    expect(dead).toMatchObject({ status: 'dead', possibleRepeat: true, lastError: expect.stringMatching(/3 deliveries in a row were interrupted/) });
    expect(w.mailbox.inbox({ all: true }).find((x) => x.id === m.id)).toMatchObject({ status: 'dead' }); // (what `morse message --all` lists)
    const text = collectInbox(w.mailbox, B.sessionId, { home: tmp() })!;
    expect(text).toContain(POSSIBLE_REPEAT_LINE);
    expect(text).toContain('ship the release notes');
    expect(w.status(m.id)).toBe('delivered');
  });

  it('a message that dead-lettered for an ordinary reason (three reported failures) carries no repeat line', () => {
    const w = world();
    const m = w.send('ordinary');
    w.alive.add(100);
    for (let i = 0; i < 3; i++) {
      const c = w.claim(100)!;
      w.mailbox.markFailed(m.id, 'the agent CLI exited 1', { holder: c.lease!.holder });
      w.tick(31_000);
    }
    expect(w.status(m.id)).toBe('dead');
    const text = collectInbox(w.mailbox, B.sessionId, { home: tmp() })!;
    expect(text).toContain('ordinary');
    expect(text).not.toContain('Possible repeat');
  });
});

describe('review F5: one delivery per session at a time — a turn left behind holds its session', () => {
  it('while a leased delivery for a session is live, no other message for THAT session is claimable under a lease; other sessions are', () => {
    const w = world();
    const first = w.send('first');
    const second = w.send('second, same session');
    const other = w.mailbox.send({ from: A, to: { agent: 'codex', sessionId: 'cccccccc-0000-4000-8000-000000000003' }, text: 'another session' });
    w.alive.add(100);
    expect(w.claim(100)!.id).toBe(first.id);
    // the plugin is gone; the agent CLI it started (pid 555) goes on
    w.mailbox.extendLease(first.id, w.mailbox.getMessage(first.id)!.lease!.holder, { pid: 555 });
    w.alive.add(555);
    w.alive.delete(100);
    w.tick(10 * 60_000);
    w.alive.add(200);
    expect(w.claim(200)!.id).toBe(other.id); // passes over `second`
    expect(w.claim(200)).toBeNull();
    expect(w.mailbox.claimById(second.id, { pid: 200 })).toBeNull();
    expect(w.status(second.id)).toBe('pending');
    // the turn ends: its session is free again — the interrupted one first (labelled), then the next
    w.alive.delete(555);
    expect(w.claim(200)).toMatchObject({ id: first.id, possibleRepeat: true });
    expect(w.claim(200)).toBeNull(); // (`first` is being delivered again: the session is busy)
    w.mailbox.markDelivered(first.id, { holder: w.mailbox.getMessage(first.id)!.lease!.holder });
    expect(w.claim(200)!.id).toBe(second.id);
  });

  it('a claim without a lease is as before: the session rule is the leased claims\' own', () => {
    const w = world();
    w.send('first');
    const second = w.send('second');
    w.alive.add(100);
    w.claim(100);
    expect(w.mailbox.claimNextPending({ scope: 'local' })?.id).toBe(second.id);
  });
});

describe('review F6: several processes, one row', () => {
  it('six processes claim the same message at the same moment: one gets it, five get null — nobody an error', async () => {
    const repo = resolve(__dirname, '..');
    for (const lease of ['', 'lease']) {
      const dbPath = join(tmp(), 'mailbox.db');
      const mb = createMailbox(createDb(dbPath, { ctx: {} }));
      const m = mb.send({ from: A, to: B, text: 'race' });
      const at = String(Date.now() + 2500);
      const results = await Promise.all(
        Array.from(
          { length: 6 },
          () =>
            new Promise<{ claimed?: unknown; error?: string }>((done) => {
              const p = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/claim-child.ts', dbPath, m.id, at, lease], { cwd: repo });
              let out = '';
              let err = '';
              p.stdout.on('data', (d) => (out += String(d)));
              p.stderr.on('data', (d) => (err += String(d)));
              p.on('close', () => done(out ? (JSON.parse(out) as { claimed?: unknown; error?: string }) : { error: `no output: ${err}` }));
            }),
        ),
      );
      expect(results.filter((r) => r.error), JSON.stringify(results)).toEqual([]);
      expect(results.filter((r) => r.claimed).length, JSON.stringify(results)).toBe(1);
      expect(mb.getMessage(m.id)!.status).toBe('delivering');
    }
  }, 90_000);

  it('a report is checked and written in one step: the UPDATE itself names the holder', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const c = w.claim(100)!;
    for (const holder of [undefined, 'someone-else']) {
      expect(() => w.mailbox.markDelivered(m.id, holder ? { holder } : {})).toThrow(LeaseLostError);
      expect(() => w.mailbox.markFailed(m.id, 'x', holder ? { holder } : {})).toThrow(LeaseLostError);
      expect(w.mailbox.release(m.id, holder)).toBe(false);
      expect(w.mailbox.toMailbox(m.id, 'x', holder)).toBe(false);
    }
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivering', attempts: 0, lease: { holder: c.lease!.holder } });
    expect(w.mailbox.markDelivered(m.id, { holder: c.lease!.holder }).status).toBe('delivered');
  });
});

describe('review F7: a pid is a process only together with when it was started', () => {
  /** A mailbox whose process table has pids AND start times. */
  const withStarts = () => {
    let t = 1_000_000;
    const procs = new Map<number, string>();
    const mailbox = createMailbox(createDb(':memory:'), { now: () => t, pidAlive: (pid) => procs.has(pid), pidStart: (pid) => procs.get(pid) ?? null });
    return { mailbox, procs, tick: (ms: number) => void (t += ms), jump: (to: number) => void (t = to), now: () => t };
  };
  const claimStarted = (mb: Mailbox, pid: number) => {
    const c = mb.claimNextPending({ scope: 'local', lease: { pid } })!;
    mb.extendLease(c.id, c.lease!.holder, { started: true });
    return c;
  };

  it('the pid was given to another program: the lease is dead as soon as it has expired — not two hours later', () => {
    const w = withStarts();
    const m = w.mailbox.send({ from: A, to: B, text: 'x' });
    w.procs.set(100, 'Sat Nov 15 03:00:00 2026');
    claimStarted(w.mailbox, 100);
    w.procs.set(100, 'Sat Nov 15 03:05:00 2026'); // the holder died; another program got pid 100
    w.procs.set(200, 'Sat Nov 15 03:06:00 2026');
    expect(w.mailbox.claimNextPending({ scope: 'local', lease: { pid: 200 } })).toBeNull(); // not expired yet
    expect(w.mailbox.liveLeases()).toHaveLength(1);
    w.tick(LEASE_TTL_MS + 1);
    expect(w.mailbox.liveLeases()).toHaveLength(0); // (an update no longer waits for it)
    expect(w.mailbox.claimNextPending({ scope: 'local', lease: { pid: 200 } })).toMatchObject({ id: m.id, possibleRepeat: true });
  });

  it('the same process, still running: its lease is live for as long as its turn may take — a pid given to nobody else is not "gone" two hours on (and after the turn\'s own limit it is taken over, labelled: review N2)', () => {
    const w = withStarts();
    const m = w.mailbox.send({ from: A, to: B, text: 'x' });
    w.procs.set(100, 'Sat Nov 15 03:00:00 2026');
    const c = claimStarted(w.mailbox, 100);
    // the holder says how long the turn may take at most: 9 hours (a long job)
    w.mailbox.extendLease(m.id, c.lease!.holder, { maxMs: 9 * 3_600_000 });
    w.procs.set(200, 'Sat Nov 15 03:06:00 2026');
    w.jump(w.now() + 8 * 3_600_000); // eight hours later, nothing renewed (the laptop slept through most of it)
    expect(w.mailbox.claimNextPending({ scope: 'local', lease: { pid: 200 } })).toBeNull();
    expect(w.mailbox.liveLeases().map((x) => x.id)).toEqual([m.id]);
    // past the turn's own limit the process proves nothing any more
    w.jump(w.now() + 2 * 3_600_000);
    expect(w.mailbox.liveLeases()).toEqual([]);
    expect(w.mailbox.claimNextPending({ scope: 'local', lease: { pid: 200 } })).toMatchObject({ id: m.id, possibleRepeat: true });
    expect(() => w.mailbox.markDelivered(m.id, { holder: c.lease!.holder })).toThrow(LeaseLostError);
  });

  it('rebinding to the agent CLI records ITS start time', () => {
    const w = withStarts();
    w.mailbox.send({ from: A, to: B, text: 'x' });
    w.procs.set(100, 'plugin-start');
    const c = claimStarted(w.mailbox, 100);
    w.procs.set(555, 'agent-start');
    w.mailbox.extendLease(c.id, c.lease!.holder, { pid: 555 });
    w.procs.delete(100);
    w.procs.set(555, 'another-program'); // the agent CLI is gone, its pid reused
    w.tick(LEASE_TTL_MS + 1);
    expect(w.mailbox.liveLeases()).toHaveLength(0);
  });

  it('where the start time cannot be read (Windows, a sandbox) the pid alone counts, and then not for ever — as before', () => {
    const w = world(); // (pidStart: none)
    const m = w.send();
    w.alive.add(100);
    w.claim(100);
    w.tick(LEASE_ORPHAN_MAX_MS - 60_000);
    expect(w.mailbox.liveLeases()).toHaveLength(1);
    w.tick(LEASE_TTL_MS + 120_000);
    expect(w.mailbox.liveLeases()).toHaveLength(0);
    w.alive.add(200);
    expect(w.claim(200)?.id).toBe(m.id);
  });

  it('processStartTime: the same text every time for a running process, null for one that is not', () => {
    if (process.platform === 'win32') return expect(processStartTime(process.pid)).toBeNull();
    const a = processStartTime(process.pid);
    expect(a).toEqual(expect.any(String));
    expect(processStartTime(process.pid)).toBe(a);
    expect(processStartTime(process.ppid)).not.toBeNull();
    expect(processStartTime(2 ** 22 + 12345)).toBeNull(); // (no such pid)
    // a real mailbox records it with the pid
    const mb = createMailbox(createDb(':memory:'));
    mb.send({ from: A, to: B, text: 'x' });
    const c = mb.claimNextPending({ scope: 'local', lease: { pid: process.pid, ttlMs: 1 } })!;
    expect(c.lease!.pid).toBe(process.pid);
    expect(mb.liveLeases()).toHaveLength(1);
  });
});

describe('review N2: a lease whose process stays alive still ends', () => {
  it('never started and not renewed: free one more lease-life after it expired, although its process is running — handed out unlabelled', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100); // the plugin: alive the whole time, but it failed between the claim and its report
    w.claim(100, false);
    w.alive.add(200);
    w.tick(LEASE_TTL_MS + 1); // expired — its process is there: not yet
    expect(w.claim(200, false)).toBeNull();
    w.tick(LEASE_TTL_MS); // 2 × TTL without a renewal
    const again = w.claim(200, false)!;
    expect(again.id).toBe(m.id);
    expect(again.possibleRepeat).toBeUndefined();
    expect(w.mailbox.liveLeases().map((x) => x.lease!.pid)).toEqual([200]);
  });

  it('…and a later message for that session is not held up by it either', () => {
    const w = world();
    w.send('first');
    const second = w.send('second');
    w.alive.add(100);
    w.claim(100, false);
    w.tick(2 * LEASE_TTL_MS + 2);
    w.alive.add(200);
    expect(w.claim(200, false)).not.toBeNull(); // `first`, taken back
    w.mailbox.markDelivered(w.mailbox.liveLeases()[0]!.id, { holder: w.mailbox.liveLeases()[0]!.lease!.holder });
    expect(w.claim(200, false)!.id).toBe(second.id);
  });

  it('a never-started claim that IS renewed stays its holder\'s', () => {
    const w = world();
    const m = w.send();
    w.alive.add(100);
    const c = w.claim(100, false)!;
    w.alive.add(200);
    for (let i = 0; i < 10; i++) {
      w.tick(LEASE_TTL_MS - 1000);
      expect(w.mailbox.extendLease(m.id, c.lease!.holder)).toBe(true);
      expect(w.claim(200, false)).toBeNull();
    }
  });

  it('a started turn has a ceiling: its own time limit when the holder said one, else two hours past the expiry — then it is taken over WITH the label', () => {
    for (const limit of [10 * 60_000, undefined]) {
      const w = world();
      const m = w.send();
      w.alive.add(100);
      const c = w.claim(100)!;
      if (limit) w.mailbox.extendLease(m.id, c.lease!.holder, { maxMs: limit });
      w.alive.add(200);
      const until = limit ?? LEASE_TTL_MS + LEASE_ORPHAN_MAX_MS;
      w.tick(until - 5000);
      expect(w.claim(200), String(limit)).toBeNull();
      w.tick(10_000);
      expect(w.claim(200), String(limit)).toMatchObject({ id: m.id, possibleRepeat: true });
    }
  });
});

describe('review N3: the write lock is never held across a process lookup', () => {
  it('the start time of a lease\'s process is read before the claim\'s transaction — never inside it', () => {
    let t = 1_000_000;
    const procs = new Map<number, string>();
    const db = createDb(':memory:');
    const inTransaction: boolean[] = [];
    const mailbox = createMailbox(db, {
      now: () => t,
      pidAlive: (pid) => procs.has(pid),
      pidStart: (pid) => {
        inTransaction.push(db.inTransaction);
        return procs.get(pid) ?? null;
      },
    });
    const a = mailbox.send({ from: A, to: B, text: 'held by a process that is gone, pid reused' });
    const b = mailbox.send({ from: A, to: { agent: 'codex', sessionId: 'cccccccc-0000-4000-8000-000000000003' }, text: 'held by a live orphan' });
    procs.set(100, 's100');
    procs.set(101, 's101');
    for (const pid of [100, 101]) {
      const c = mailbox.claimNextPending({ scope: 'local', lease: { pid } })!;
      mailbox.extendLease(c.id, c.lease!.holder, { started: true });
    }
    procs.set(100, 'another-program'); // pid 100 was reused; 101 is the same process
    procs.set(200, 's200');
    t += LEASE_TTL_MS + 1;
    inTransaction.length = 0;
    // every way a claim looks at expired leases: the takeover check and the busy-session check
    expect(mailbox.claimNextPending({ scope: 'local', lease: { pid: 200 } })).toMatchObject({ id: a.id, possibleRepeat: true });
    expect(mailbox.claimById(b.id, { pid: 200 })).toBeNull();
    expect(mailbox.claimNextPending({ scope: 'local', lease: { pid: 200 } })).toBeNull();
    expect(mailbox.claimNextPending({ scope: 'local' })).toBeNull();
    expect(inTransaction.length).toBeGreaterThan(0);
    expect(inTransaction.every((x) => x === false)).toBe(true);
  });

  it('a lease that expires between the lookup and the transaction is simply not decided in that round', () => {
    // (the lookup saw it unexpired and did not ask about its process: inside the transaction it counts as live)
    let t = 1_000_000;
    let onLook: () => void = () => undefined;
    const procs = new Map<number, string>([[100, 's100']]);
    const mailbox = createMailbox(createDb(':memory:'), {
      now: () => {
        onLook();
        return t;
      },
      pidAlive: (pid) => procs.has(pid),
      pidStart: (pid) => procs.get(pid) ?? null,
    });
    const m = mailbox.send({ from: A, to: B, text: 'x' });
    const c = mailbox.claimNextPending({ scope: 'local', lease: { pid: 100 } })!;
    mailbox.extendLease(m.id, c.lease!.holder, { started: true });
    procs.set(100, 'another-program');
    procs.set(200, 's200');
    t = c.lease!.expiresAt - 1;
    // the clock passes the expiry right after the lookup read it
    let reads = 0;
    onLook = () => {
      if (++reads === 2) t += 10;
    };
    expect(mailbox.claimNextPending({ scope: 'local', lease: { pid: 200 } })).toBeNull();
    onLook = () => undefined;
    expect(mailbox.claimNextPending({ scope: 'local', lease: { pid: 200 } })).toMatchObject({ id: m.id, possibleRepeat: true });
  });
});
