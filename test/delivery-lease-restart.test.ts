import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { realExec, spawnWatch } from '../src/adapters/exec.js';
import type { DeliveryAdapter, DeliveryResult, SessionInfo } from '../src/adapters/types.js';
import { POSSIBLE_REPEAT_LINE, REPLY_MARKER } from '../src/envelope.js';
import { collectInbox } from '../src/hooks/prompt-hook.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, LEASE_TTL_MS, type Mailbox } from '../src/mailbox/mailbox.js';
import { createLocalClient } from '../src/plugin/local-client.js';
import { PLUGIN_STOP_GRACE_MS, startPluginManager } from '../src/plugin/manager.js';
import { createDispatcher, dispatchStep, type DispatchDeps, type DispatchEvent } from '../src/plugins/dispatch/deliver.js';
import { drainTurns, STOP_DRAIN_MS } from '../src/plugins/dispatch/drain.js';
import { createSelfInboxRunner, parseSelfInbox } from '../src/plugins/dispatch/self-inbox.js';
import { createDispatchState, type DispatchState } from '../src/plugins/dispatch/state.js';
import { createDeliveryWait, DELIVERY_WAIT_CAP_MS, updateWaitingLine } from '../src/update/delivery-wait.js';
import { restartGracefully, startAutoUpdater, type CheckOutcome, type ReleaseManifest } from '../src/update/updater.js';

/**
 * ADR-089, one level up from test/delivery-lease.test.ts: the dispatch plugin, the prompt hook, the updater
 * and the `morse plugin …` commands, in the sequences an independent review found. A daemon restart that
 * lands in the middle of an agent's turn used to deliver the message twice; every sequence here ends with
 * exactly ONE turn — or with a second one that is told it may be a repeat.
 */

const repo = resolve(__dirname, '..');
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});
const freshHome = (): string => {
  const h = mkdtempSync(join(tmpdir(), 'morse-lease-'));
  homes.push(h);
  return h;
};

const FROM = { agent: 'claude', sessionId: 'aaaaaaaa-0000-4000-8000-00000000000a' };
const SID = 'dddd0000-0000-4000-8000-00000000000d';
const session: SessionInfo = { agent: 'codex', sessionId: SID, title: 'work', cwd: '/w', lastActiveAt: 1 };
/** A second session of the same agent (listed in the test world's directory too). */
const OTHER_SID = 'eeee0000-0000-4000-8000-0000000000ee';
const otherSession: SessionInfo = { agent: 'codex', sessionId: OTHER_SID, title: 'other', cwd: '/o', lastActiveAt: 1 };

/** The time limit of an agent turn in the test world (what the adapter gives its CLI). */
const TURN_LIMIT_MS = 2 * 3_600_000;

/** One agent turn the test ends by hand: the envelope it was given, the "process" that runs it. */
interface Turn {
  envelope: string;
  pid: number;
  /** The agent CLI ends and the adapter answers `r`; `how`: the way the process ended (default: by itself, code 0 / 1). */
  finish: (r?: DeliveryResult, how?: { code: number | null; signal: NodeJS.Signals | null; timedOut?: boolean }) => void;
}

function world() {
  let t = 1_000_000;
  const alive = new Set<number>();
  const mailbox: Mailbox = createMailbox(createDb(':memory:'), { now: () => t, pidAlive: (pid) => alive.has(pid) });
  const turns: Turn[] = [];
  let nextPid = 5000;
  /** One turn per session across plugin runs, as the lock files do: a lock whose process is gone is stale. */
  const lanes = new Map<string, number>();
  const state = (pid: number) =>
    ({
      dedicated: () => null,
      allDedicated: () => ({}),
      lock: (lane: string) => {
        const owner = lanes.get(lane);
        if (owner !== undefined && alive.has(owner)) return null;
        lanes.set(lane, pid);
        return () => void (lanes.get(lane) === pid && lanes.delete(lane));
      },
    }) as unknown as DispatchState;
  /** A plugin run: its own process, its own adapter — every turn it starts is recorded in `turns`. */
  const plugin = (pid: number, daemon?: number) => {
    alive.add(pid);
    const events: DispatchEvent[] = [];
    const adapter: DeliveryAdapter = {
      agent: 'codex',
      listSessions: async () => [session, otherSession],
      deliver: (_target, envelope) =>
        new Promise<DeliveryResult>((done) => {
          const child = nextPid++;
          alive.add(child);
          // what src/adapters/exec.ts does when the agent CLI is started, and when it has ended
          const watcher = spawnWatch.getStore();
          watcher?.spawned(child, { timeoutMs: TURN_LIMIT_MS });
          turns.push({
            envelope,
            pid: child,
            finish: (r = { ok: true, output: '' }, how) => {
              alive.delete(child);
              watcher?.ended?.(child, { code: r.ok ? 0 : 1, signal: null, timedOut: false, ...how });
              done(r);
            },
          });
        }),
    };
    const deps: DispatchDeps = {
      core: createLocalClient(mailbox),
      adapters: new Map([['codex', adapter]]),
      directory: async () => [session, otherSession],
      state: state(pid),
      pid,
      ...(daemon ? { daemonAlive: () => alive.has(daemon) } : {}),
      onEvent: (e) => events.push(e),
    };
    return { deps, events, dispatcher: createDispatcher(deps), kinds: (id?: string) => events.filter((e) => !id || e.messageId === id).map((e) => e.kind) };
  };
  return {
    mailbox,
    alive,
    turns,
    plugin,
    send: (text = 'deploy the staging site') => mailbox.send({ from: FROM, to: { agent: 'codex', sessionId: SID }, text }),
    tick: (ms: number) => void (t += ms),
    /** Another process holds the lane of a session (a turn running there that is not this test's). */
    holdLane: (lane: string, pid: number) => void (alive.add(pid), lanes.set(lane, pid)),
    status: (id: string) => mailbox.getMessage(id)!.status,
    replies: () => mailbox.inbox({ all: true }).filter((m) => m.from.sessionId === SID),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('a daemon restart in the middle of an agent turn (ADR-089)', () => {
  it('the old holder is still running its turn: nobody else gets the message — not after 30 s, not after 30 min — and its late ack is the one delivery', async () => {
    const w = world();
    const m = w.send();
    const old = w.plugin(100);
    old.dispatcher.kick();
    await until(() => w.turns.length === 1);
    // the lease follows the agent CLI's process from the moment it is started
    await until(() => w.mailbox.getMessage(m.id)!.lease?.pid === w.turns[0]!.pid);

    // the daemon restarts: its own recovery, then a new plugin with its recovery
    expect(w.mailbox.recoverStale()).toBe(0);
    const fresh = w.plugin(200);
    expect(await fresh.deps.core.recover()).toBe(0);
    expect(w.status(m.id)).toBe('delivering');
    for (const wait of [31_000, 5 * 60_000, 30 * 60_000]) {
      w.tick(wait); // (the lease expired long ago on paper — its process is still running)
      expect(await dispatchStep(fresh.deps)).toBe(false);
    }
    expect(w.turns).toHaveLength(1);

    // the old plugin is killed; its turn goes on as an orphan: still nobody takes the message
    w.alive.delete(100);
    w.tick(10 * 60_000);
    expect(await dispatchStep(fresh.deps)).toBe(false);

    w.alive.add(100); // (…or it was not killed and reports itself)
    w.turns[0]!.finish({ ok: true, output: '' });
    await old.dispatcher.idle();
    expect(w.status(m.id)).toBe('delivered');
    expect(old.kinds()).toEqual(['delivered']);
    expect(await dispatchStep(fresh.deps)).toBe(false);
    expect(w.turns).toHaveLength(1);
    expect(w.turns[0]!.envelope).not.toContain(POSSIBLE_REPEAT_LINE);
  });

  it('the old plugin and its turn are gone: taken over only once the lease has really expired — and the second turn is told it may be a repeat', async () => {
    const w = world();
    const m = w.send();
    const old = w.plugin(100);
    old.dispatcher.kick();
    await until(() => w.turns.length === 1);
    await until(() => w.mailbox.getMessage(m.id)!.lease?.pid === w.turns[0]!.pid);
    // SIGKILL: the plugin and the agent CLI are gone, nothing was reported
    w.alive.delete(100);
    w.alive.delete(w.turns[0]!.pid);

    const fresh = w.plugin(200);
    expect(await fresh.deps.core.recover()).toBe(0);
    w.tick(31_000); // the old fixed timer: not any more
    expect(await dispatchStep(fresh.deps)).toBe(false);
    w.tick(LEASE_TTL_MS);
    fresh.dispatcher.kick();
    await until(() => w.turns.length === 2);
    expect(w.turns[1]!.envelope).toContain(POSSIBLE_REPEAT_LINE);
    expect(w.turns[1]!.envelope).toContain('deploy the staging site');
    w.turns[1]!.finish();
    await fresh.dispatcher.idle();
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivered', possibleRepeat: true });
  });

  it('a prompt typed right after the restart does not carry the message into the session while its turn is still running', async () => {
    const w = world();
    const home = freshHome();
    const m = w.send();
    const old = w.plugin(100);
    old.dispatcher.kick();
    await until(() => w.turns.length === 1);
    w.mailbox.recoverStale();
    expect(collectInbox(w.mailbox, SID, { home })).toBeNull();
    w.tick(LEASE_TTL_MS * 3);
    expect(collectInbox(w.mailbox, SID, { home })).toBeNull();
    expect(w.status(m.id)).toBe('delivering');
    w.turns[0]!.finish();
    await old.dispatcher.idle();
    expect(w.status(m.id)).toBe('delivered');
    expect(w.turns).toHaveLength(1);
  });

  it('the holder is gone and the session asks (prompt hook, `morse message --pull`): it gets the message, labelled — and a late report from the old holder changes nothing', async () => {
    const w = world();
    const home = freshHome();
    const m = w.send();
    const old = w.plugin(100);
    old.dispatcher.kick();
    await until(() => w.turns.length === 1);
    const orphan = w.turns[0]!;
    w.alive.delete(orphan.pid); // the agent CLI was killed with the daemon; the plugin hangs on
    w.tick(LEASE_TTL_MS + 1);
    const text = collectInbox(w.mailbox, SID, { home })!;
    expect(text).toContain(POSSIBLE_REPEAT_LINE);
    expect(text).toContain('deploy the staging site');
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivered', processedBy: 'pull' });
    expect(collectInbox(w.mailbox, SID, { home })).toBeNull(); // once
    // the old holder reports after all — with an answer: refused, and the answer is not filed
    orphan.finish({ ok: true, output: `working…\n${REPLY_MARKER} DONE deployed` });
    await old.dispatcher.idle();
    expect(old.kinds()).toEqual(['superseded']);
    expect(w.replies()).toHaveLength(0);
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivered', processedBy: 'pull' });
  });

  it('two holders: the one that was taken over reports late — its ack does not count, its answer is not filed; the current holder delivers once', async () => {
    const w = world();
    const m = w.send();
    const old = w.plugin(100);
    old.dispatcher.kick();
    await until(() => w.turns.length === 1);
    const first = w.turns[0]!;
    // the first plugin's agent process is gone and its renewals stopped (a hung plugin), the lease runs out
    w.alive.delete(first.pid);
    w.alive.delete(100);
    w.tick(LEASE_TTL_MS + 1);
    const fresh = w.plugin(200);
    fresh.dispatcher.kick();
    await until(() => w.turns.length === 2);
    expect(w.turns[1]!.envelope).toContain(POSSIBLE_REPEAT_LINE);
    const holder = w.mailbox.getMessage(m.id)!.lease!.holder;

    first.finish({ ok: true, output: `${REPLY_MARKER} DONE first answer` });
    await old.dispatcher.idle();
    expect(old.kinds()).toEqual(['superseded']);
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivering', lease: { holder } }); // untouched
    expect(w.replies()).toHaveLength(0);

    w.turns[1]!.finish({ ok: true, output: `${REPLY_MARKER} DONE second answer` });
    await fresh.dispatcher.idle();
    expect(w.status(m.id)).toBe('delivered');
    expect(fresh.kinds()).toEqual(expect.arrayContaining(['delivered', 'reply-filed']));
    expect(w.replies().map((r) => r.parts[0]!.text)).toEqual(['DONE second answer']); // one answer, the current holder's
    expect(w.turns).toHaveLength(2);
  });

  it('the daemon AND the plugin crash: the message is not stuck — the next plugin takes it over once the lease is dead, labelled', async () => {
    const w = world();
    const m = w.send();
    const old = w.plugin(100);
    old.dispatcher.kick();
    await until(() => w.turns.length === 1);
    w.alive.clear(); // power cut
    // a new daemon, a new plugin
    expect(w.mailbox.recoverStale()).toBe(0);
    const fresh = w.plugin(200);
    expect(await fresh.deps.core.recover()).toBe(0);
    expect(await dispatchStep(fresh.deps)).toBe(false); // the lease has not run out yet
    expect(w.mailbox.liveLeases()).toHaveLength(1);
    w.tick(LEASE_TTL_MS + 1);
    expect(w.mailbox.liveLeases()).toHaveLength(0);
    fresh.dispatcher.kick();
    await until(() => w.turns.length === 2);
    expect(w.turns[1]!.envelope).toContain(POSSIBLE_REPEAT_LINE);
    w.turns[1]!.finish();
    await fresh.dispatcher.idle();
    expect(w.status(m.id)).toBe('delivered');
  });

  it('a failed turn is a retry as before — not a repeat: the lease is given up with the report', async () => {
    const w = world();
    const m = w.send();
    const p = w.plugin(100);
    p.dispatcher.kick();
    await until(() => w.turns.length === 1);
    w.turns[0]!.finish({ ok: false, error: 'the agent CLI exited 1' });
    await until(() => w.status(m.id) === 'failed');
    expect(w.mailbox.getMessage(m.id)!.lease).toBeUndefined();
    w.tick(31_000);
    p.dispatcher.kick();
    await until(() => w.turns.length === 2);
    expect(w.turns[1]!.envelope).not.toContain(POSSIBLE_REPEAT_LINE);
    w.turns[1]!.finish();
    await p.dispatcher.idle();
    expect(w.status(m.id)).toBe('delivered');
  });
});

describe('review F3: a first delivery never carries the repeat line', () => {
  it('the daemon is killed: its plugin claims nothing more — the turn it is running finishes and is acked, the next message waits for the new plugin and is delivered once, unlabelled', async () => {
    const w = world();
    const first = w.send('first');
    w.alive.add(9); // the daemon
    const old = w.plugin(100, 9);
    old.dispatcher.kick();
    await until(() => w.turns.length === 1);
    w.alive.delete(9); // SIGKILL — nobody tells the plugin
    const next = w.mailbox.send({ from: FROM, to: { agent: 'codex', sessionId: OTHER_SID }, text: 'the next message, for another session' });
    old.dispatcher.kick(); // its timer fires, its event stream reports the new message
    await settle();
    expect(w.status(next.id)).toBe('pending'); // NOT claimed by the plugin of the daemon that is gone
    w.turns[0]!.finish(); // (the finished turn's own "anything else due?" claims nothing either)
    await old.dispatcher.stop();
    expect(w.status(first.id)).toBe('delivered');
    expect(w.status(next.id)).toBe('pending');
    // the new daemon's plugin
    w.alive.add(10);
    const fresh = w.plugin(200, 10);
    fresh.dispatcher.kick();
    await until(() => w.turns.length === 2);
    expect(w.turns[1]!.envelope).toContain('the next message');
    expect(w.turns[1]!.envelope).not.toContain(POSSIBLE_REPEAT_LINE);
    w.turns[1]!.finish();
    await fresh.dispatcher.idle();
    expect(w.mailbox.getMessage(next.id)).toMatchObject({ status: 'delivered' });
    expect(w.mailbox.getMessage(next.id)!.possibleRepeat).toBeUndefined();
  });

  it('a plugin that dies between the claim and the start of the agent: the message is delivered later as a FIRST delivery', async () => {
    const w = world();
    const m = w.send();
    // (what the plugin does up to the claim — and no further)
    w.alive.add(100);
    const claimed = await createLocalClient(w.mailbox).claimNext({ lease: { pid: 100 } });
    expect(claimed!.id).toBe(m.id);
    w.alive.delete(100);
    w.tick(LEASE_TTL_MS + 1);
    const fresh = w.plugin(200);
    fresh.dispatcher.kick();
    await until(() => w.turns.length === 1);
    expect(w.turns[0]!.envelope).not.toContain(POSSIBLE_REPEAT_LINE);
    // …and the dispatch plugin says `started` before the agent runs: from here on a takeover IS a repeat
    expect(w.mailbox.getMessage(m.id)!.lease!.started).toBe(true);
    w.turns[0]!.finish();
    await fresh.dispatcher.idle();
    expect(w.mailbox.getMessage(m.id)!.possibleRepeat).toBeUndefined();
  });

  it('a claim that lost its lease before the agent was started starts no turn at all', async () => {
    const w = world();
    const m = w.send();
    const p = w.plugin(100);
    // between this plugin's claim and its `started` the row is taken from it (as a takeover would)
    const core = p.deps.core;
    p.deps.core = { ...core, extend: async (id, holder, o) => (o?.started ? false : core.extend(id, holder, o)) };
    p.dispatcher.kick();
    await until(() => p.kinds().includes('superseded'));
    expect(w.turns).toHaveLength(0);
    expect(w.status(m.id)).toBe('delivering'); // untouched: not ours to report on
  });
});

describe('review N1: a turn that was cut off is not a failed delivery', () => {
  it('the agent CLI is ended by a signal while the plugin lives: nothing is nacked — the next delivery is a labelled takeover that counts as one interruption', async () => {
    const w = world();
    const m = w.send();
    const p = w.plugin(100);
    p.dispatcher.kick();
    await until(() => w.turns.length === 1);
    // launchd / systemd / the user ends the agent in the middle of its turn: the adapter reports "exited 143"
    w.turns[0]!.finish({ ok: false, error: 'claude -p --resume exited 143' }, { code: null, signal: 'SIGTERM' });
    await until(() => p.kinds().includes('interrupted'));
    expect(p.kinds()).not.toContain('failed');
    // the same plugin takes it over at once (the lease was given up, its process is gone), and says so to the agent
    await until(() => w.turns.length === 2);
    expect(w.turns[1]!.envelope).toContain(POSSIBLE_REPEAT_LINE);
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivering', attempts: 0, possibleRepeat: true }); // not a failed attempt
    w.turns[1]!.finish();
    await p.dispatcher.idle();
    expect(w.status(m.id)).toBe('delivered');
  });

  it('an exit code of 128 + signal counts the same (a CLI that catches the signal and exits 143) — and three such turns in a row end it, not one', async () => {
    const w = world();
    const m = w.send();
    const p = w.plugin(100);
    p.dispatcher.kick();
    for (let i = 0; i < 3; i++) {
      await until(() => w.turns.length === i + 1);
      expect(w.status(m.id)).toBe('delivering'); // (a `plain` message used to be dead after the first)
      w.turns[i]!.finish({ ok: false, error: 'claude -p --resume exited 143' }, { code: 143, signal: null });
    }
    await until(() => w.status(m.id) === 'dead');
    expect(w.mailbox.getMessage(m.id)).toMatchObject({ possibleRepeat: true, lastError: expect.stringMatching(/deliveries in a row were interrupted/) });
    expect(w.turns).toHaveLength(3);
  });

  it('a turn that fails while the plugin is being stopped, or after its daemon is gone, is kept as interrupted; the next plugin delivers it with the label', async () => {
    for (const how of ['stopping', 'daemon-gone'] as const) {
      const w = world();
      const m = w.send();
      w.alive.add(9);
      const old = w.plugin(100, 9);
      let stopping = false;
      old.deps.stopping = () => stopping;
      old.dispatcher.kick();
      await until(() => w.turns.length === 1);
      if (how === 'stopping') stopping = true;
      else w.alive.delete(9);
      w.turns[0]!.finish({ ok: false, error: 'the agent CLI exited 1' }); // (no signal seen: it died with the stop)
      await until(() => old.kinds().includes('interrupted'));
      expect(w.mailbox.getMessage(m.id), how).toMatchObject({ status: 'delivering', attempts: 0 });
      w.alive.delete(100);
      w.alive.add(10);
      const fresh = w.plugin(200, 10);
      fresh.dispatcher.kick();
      await until(() => w.turns.length === 2);
      expect(w.turns[1]!.envelope, how).toContain(POSSIBLE_REPEAT_LINE);
      w.turns[1]!.finish();
      await fresh.dispatcher.idle();
    }
  });

  it('what is NOT an interruption stays what it was: an ordinary failure, our own time limit, a failure that is final', async () => {
    const cases: Array<[DeliveryResult, { code: number | null; signal: NodeJS.Signals | null; timedOut?: boolean } | undefined, string]> = [
      [{ ok: false, error: 'the agent CLI exited 1' }, undefined, 'failed'],
      [{ ok: false, retry: false, error: 'claude did not finish within 600 s' }, { code: null, signal: 'SIGKILL', timedOut: true }, 'dead'],
    ];
    for (const [result, how, status] of cases) {
      const w = world();
      const m = w.send();
      const p = w.plugin(100);
      p.dispatcher.kick();
      await until(() => w.turns.length === 1);
      w.turns[0]!.finish(result, how);
      await until(() => w.status(m.id) === status);
      expect(p.kinds()).toEqual(['failed']);
      await p.dispatcher.stop();
    }
    // final (the session does not exist …) is reported as such even while the plugin is stopping
    const w = world();
    const m = w.send();
    const p = w.plugin(100);
    p.deps.stopping = () => true;
    const step = dispatchStep(p.deps);
    await until(() => w.turns.length === 1);
    w.turns[0]!.finish({ ok: false, retry: false, error: 'claude: no conversation found with session id …' });
    await step;
    expect(p.kinds()).toEqual(['failed']);
    expect(w.status(m.id)).toBe('dead');
  });
});

describe('review N2: a claim is always handed back', () => {
  it('the hand-back itself fails (the `morse` command answered rubbish): said, not thrown — the pass goes on, and the claim frees itself', async () => {
    const w = world();
    const live = w.send('for a session where another turn is running');
    w.holdLane(SID, 77); // (so this plugin claims it, cannot get the lane, and hands it back)
    const other = w.mailbox.send({ from: FROM, to: { agent: 'codex', sessionId: OTHER_SID }, text: 'for another session' });
    const logs: string[] = [];
    const p = w.plugin(100);
    p.deps.log = (l) => logs.push(l);
    const core = p.deps.core;
    p.deps.core = { ...core, release: async () => Promise.reject(new Error('morse plugin nack: Unexpected token')) };
    p.dispatcher.kick();
    await until(() => w.turns.length === 1); // the pass went on to the other session
    expect(w.turns[0]!.envelope).toContain('for another session');
    expect(logs.join('\n')).toMatch(/could not hand .{8} back: morse plugin nack: Unexpected token — it frees itself/);
    w.turns[0]!.finish();
    await until(() => w.status(other.id) === 'delivered');
    // the claim that could not be handed back: held by the (living) plugin, never started, never renewed
    expect(w.status(live.id)).toBe('delivering');
    w.tick(2 * LEASE_TTL_MS + 2);
    expect(w.mailbox.liveLeases()).toEqual([]);
    const text = collectInbox(w.mailbox, SID, { home: freshHome() })!; // its session gets it — as a first delivery
    expect(text).toContain('for a session where another turn is running');
    expect(text).not.toContain(POSSIBLE_REPEAT_LINE);
    await p.dispatcher.stop();
  });
});

describe('review F5: a turn left behind holds its session', () => {
  it('after an orderly stop with a long turn, the new plugin does not start the next message for the SAME session while that turn still runs', async () => {
    const w = world();
    const first = w.send('first');
    const old = w.plugin(100);
    old.dispatcher.kick();
    await until(() => w.turns.length === 1);
    await until(() => w.mailbox.getMessage(first.id)!.lease?.pid === w.turns[0]!.pid);
    expect(await drainTurns([old.dispatcher], 30)).toBe(1); // the plugin leaves; the lane lock goes with it
    w.alive.delete(100);
    const second = w.send('second, same session');
    const fresh = w.plugin(200);
    for (const wait of [1000, 60_000, 10 * 60_000]) {
      w.tick(wait);
      expect(await dispatchStep(fresh.deps)).toBe(false);
    }
    expect(w.turns).toHaveLength(1); // never two turns in one session
    expect(w.status(second.id)).toBe('pending');
    // the old turn ends by itself (nobody reports): its message is taken over, labelled — then the second one
    w.alive.delete(w.turns[0]!.pid);
    fresh.dispatcher.kick();
    await until(() => w.turns.length === 2);
    expect(w.turns[1]!.envelope).toContain('first');
    expect(w.turns[1]!.envelope).toContain(POSSIBLE_REPEAT_LINE);
    w.turns[1]!.finish();
    await until(() => w.turns.length === 3);
    expect(w.turns[2]!.envelope).toContain('second, same session');
    expect(w.turns[2]!.envelope).not.toContain(POSSIBLE_REPEAT_LINE);
    w.turns[2]!.finish();
    await fresh.dispatcher.idle();
    w.turns[0]!.finish();
  });
});

describe('review F1: a plugin is told to stop once', () => {
  it('stop() called twice (as the daemon\'s shutdown did) and reconcile() on every tick send ONE SIGTERM — the plugin gets its time', async () => {
    const dir = freshHome();
    const seen = join(dir, 'signals.log');
    const script = `
      const fs = require('fs');
      fs.appendFileSync(${JSON.stringify(seen)}, 'up\\n');
      process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(seen)}, 'SIGTERM\\n'); setTimeout(() => process.exit(0), 700); });
      setInterval(() => undefined, 1000);`;
    const logs: string[] = [];
    let enabled = true;
    const mgr = startPluginManager({ specs: () => [{ name: 'slow', argv: [process.execPath, '-e', script], enabled, builtin: false }], log: (l) => logs.push(l), intervalMs: 40, stopGraceMs: 5000 });
    await until(() => { try { return readFileSync(seen, 'utf8').includes('up'); } catch { return false; } }, 10_000);
    const t0 = Date.now();
    const a = mgr.stop();
    const b = mgr.stop();
    await Promise.all([a, b]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600); // it was waited for
    expect(readFileSync(seen, 'utf8')).toBe('up\nSIGTERM\n');

    // disabled while running: reconcile asks once, however many ticks pass before it is gone
    const seen2 = join(dir, 'signals2.log');
    const mgr2 = startPluginManager({ specs: () => [{ name: 'slow', argv: [process.execPath, '-e', script.split(seen).join(seen2)], enabled, builtin: false }], log: (l) => logs.push(l), intervalMs: 40, stopGraceMs: 5000 });
    await until(() => { try { return readFileSync(seen2, 'utf8').includes('up'); } catch { return false; } }, 10_000);
    enabled = false;
    await until(() => mgr2.status()[0]!.pid === null, 10_000);
    expect(readFileSync(seen2, 'utf8')).toBe('up\nSIGTERM\n');
    expect(logs.filter((l) => l.includes('disabled — stopping'))).toHaveLength(1);
    await mgr2.stop();
  }, 30_000);
});

describe('the lease is kept alive by the plugin while the turn runs (ADR-089)', () => {
  it('renewed every third of its life — a turn many lease-lives long is never taken over, even when no process can be checked', async () => {
    // real clock; no process counts as running: only the renewals keep the lease alive
    const mailbox = createMailbox(createDb(':memory:'), { pidAlive: () => false });
    const long: SessionInfo = { ...session, sessionId: 'ffff0000-0000-4000-8000-00000000000f' };
    const m = mailbox.send({ from: FROM, to: { agent: 'codex', sessionId: long.sessionId }, text: 'a long job' });
    let finish!: (r: DeliveryResult) => void;
    const adapter: DeliveryAdapter = { agent: 'codex', listSessions: async () => [long], deliver: () => new Promise<DeliveryResult>((done) => (finish = done)) };
    const deps: DispatchDeps = { core: createLocalClient(mailbox), adapters: new Map([['codex', adapter]]), directory: async () => [long], leaseTtlMs: 150 };
    const d = createDispatcher(deps);
    d.kick();
    await until(() => mailbox.getMessage(m.id)!.status === 'delivering');
    const first = mailbox.getMessage(m.id)!.lease!;
    const other = createLocalClient(mailbox);
    const end = Date.now() + 900; // six lease-lives
    while (Date.now() < end) {
      expect(await other.claimNext({ lease: { pid: 1 } })).toBeNull();
      await new Promise((r) => setTimeout(r, 25));
    }
    const now = mailbox.getMessage(m.id)!.lease!;
    expect(now.holder).toBe(first.holder);
    expect(now.expiresAt).toBeGreaterThan(first.expiresAt);
    finish({ ok: true, output: '' });
    await d.idle();
    expect(mailbox.getMessage(m.id)!.status).toBe('delivered');
  });
});

describe('where the lease gets its process from, and the other ways a message reaches an agent (ADR-089)', () => {
  it('an agent CLI started through the default exec reports its pid to the delivery it runs in — and to nobody else', async () => {
    const seen: number[] = [];
    const ends: unknown[] = [];
    const watcher = { spawned: (pid: number, info: { timeoutMs: number }) => void seen.push(pid, info.timeoutMs), ended: (_pid: number, how: unknown) => void ends.push(how) };
    const r = await spawnWatch.run(watcher, () => realExec(process.execPath, ['-e', 'console.log(process.pid)'], { timeoutMs: 20_000 }));
    expect(seen).toEqual([Number(r.stdout.trim()), 20_000]); // the pid, and the turn's own time limit
    expect(ends).toEqual([{ code: 0, signal: null, timedOut: false }]);
    // (review N1) ended by a signal that was not ours — and, told apart from it, by our own time limit
    await spawnWatch.run(watcher, () => realExec(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000)'], { timeoutMs: 20_000 }));
    expect(ends[1]).toEqual({ code: null, signal: 'SIGTERM', timedOut: false });
    await spawnWatch.run(watcher, () => realExec(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }));
    await until(() => ends.length === 3);
    expect(ends[2]).toMatchObject({ signal: 'SIGKILL', timedOut: true });
    seen.length = 1;
    await realExec(process.execPath, ['-e', ''], { timeoutMs: 20_000 }); // outside a delivery: nothing to tell
    expect(seen).toHaveLength(1);
  });

  it('a message that was taken over and then handed back (its session is open) is still labelled when the session pulls it', async () => {
    const w = world();
    const home = freshHome();
    const m = w.send();
    w.alive.add(100);
    const first = w.mailbox.claimNextPending({ scope: 'local', lease: { pid: 100 } })!;
    w.mailbox.extendLease(first.id, first.lease!.holder, { started: true }); // (a turn was started for it)
    w.alive.delete(100);
    w.tick(LEASE_TTL_MS + 1);
    w.alive.add(200);
    const again = w.mailbox.claimNextPending({ scope: 'local', lease: { pid: 200 } })!;
    expect(again.possibleRepeat).toBe(true);
    expect(w.mailbox.release(m.id, again.lease!.holder)).toBe(true); // the session is live: left for its own pull
    const text = collectInbox(w.mailbox, SID, { home })!;
    expect(text).toContain(POSSIBLE_REPEAT_LINE);
    expect(w.status(m.id)).toBe('delivered');
  });

  it('a message nobody held is never labelled: an ordinary pull says nothing about repeats', () => {
    const w = world();
    w.send();
    const text = collectInbox(w.mailbox, SID, { home: freshHome() })!;
    expect(text).toContain('deploy the staging site');
    expect(text).not.toContain('Possible repeat');
  });

  // (ADR-091 follow-up) removed: "own inbox mail (ADR-061, not claimed)…" — mail from your other computers is never yours now (it never reaches this runner).
});

describe('stopping the dispatch plugin (ADR-089)', () => {
  it('nothing new is claimed; a running turn finishes and reports within the drain; the daemon waits longer than the plugin drains', async () => {
    expect(PLUGIN_STOP_GRACE_MS).toBeGreaterThan(STOP_DRAIN_MS + 2500); // the drain + the `morse` commands in flight
    const w = world();
    const a = w.send('first');
    const p = w.plugin(100);
    p.dispatcher.kick();
    await until(() => w.turns.length === 1);
    const b = w.mailbox.send({ from: FROM, to: { agent: 'codex', sessionId: 'eeee0000-0000-4000-8000-00000000000e' }, text: 'second, for another session' });
    const logs: string[] = [];
    const drained = drainTurns([p.dispatcher], 2000, (l) => logs.push(l));
    p.dispatcher.kick(); // (the interval timer firing once more)
    await settle();
    expect(w.status(b.id)).toBe('pending');
    expect(w.turns).toHaveLength(1);
    w.turns[0]!.finish();
    expect(await drained).toBe(0);
    expect(w.status(a.id)).toBe('delivered');
    expect(logs.join('\n')).toMatch(/waiting up to 2 s for 1 running turn/);
  });

  it('a turn longer than the drain keeps its lease: the plugin leaves, the message stays held by the turn', async () => {
    const w = world();
    const m = w.send();
    const p = w.plugin(100);
    p.dispatcher.kick();
    await until(() => w.turns.length === 1);
    await until(() => w.mailbox.getMessage(m.id)!.lease?.pid === w.turns[0]!.pid);
    expect(await drainTurns([p.dispatcher], 50)).toBe(1);
    w.alive.delete(100); // the plugin exits
    w.tick(LEASE_TTL_MS * 4);
    const fresh = w.plugin(200);
    expect(await dispatchStep(fresh.deps)).toBe(false); // the orphan turn still runs
    expect(w.mailbox.liveLeases()).toHaveLength(1);
    w.alive.delete(w.turns[0]!.pid); // it ends; nobody is left to report
    fresh.dispatcher.kick();
    await until(() => w.turns.length === 2);
    expect(w.turns[1]!.envelope).toContain(POSSIBLE_REPEAT_LINE);
    w.turns[1]!.finish();
    await fresh.dispatcher.idle();
    w.turns[0]!.finish();
  });
});

describe('an update waits for running turns, bounded (ADR-089)', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('no delivery under way: no wait at all', async () => {
    const log: string[] = [];
    const wait = createDeliveryWait({ live: () => 0, log: (l) => log.push(l), ...clock() });
    expect(await wait('install')).toEqual({ waitedMs: 0, left: 0 });
    expect(log).toEqual([]);
  });

  it('waits until the running turns have finished, then goes on', async () => {
    const c = clock();
    const log: string[] = [];
    const wait = createDeliveryWait({ live: () => (c.now() < 90_000 ? 2 : 0), log: (l) => log.push(l), ...c });
    const r = await wait('install');
    expect(r.left).toBe(0);
    expect(r.waitedMs).toBeGreaterThanOrEqual(90_000);
    expect(r.waitedMs).toBeLessThan(95_000);
    expect(log[0]).toMatch(/2 agent turn\(s\) running — waiting for a quiet moment before the install \(at most 10 min\)/);
    expect(log[1]).toMatch(/no agent turn running any more/);
  });

  it('the cap: after 10 minutes (2 before the restart) it goes on anyway, and says what happens to a turn it cuts', async () => {
    const c = clock();
    const log: string[] = [];
    const wait = createDeliveryWait({ live: () => 1, log: (l) => log.push(l), ...c });
    expect(await wait('install')).toEqual({ waitedMs: DELIVERY_WAIT_CAP_MS.install, left: 1 });
    expect(DELIVERY_WAIT_CAP_MS.install).toBe(10 * 60_000);
    expect(log[1]).toMatch(/1 agent turn\(s\) still running after 10 min — going on with the install; a turn the restart cuts is delivered again, marked as a possible repeat/);
    const before = c.now();
    expect((await wait('restart')).left).toBe(1);
    expect(c.now() - before).toBe(DELIVERY_WAIT_CAP_MS.restart);
  });

  it('a mailbox that cannot be read never holds an update back', async () => {
    const wait = createDeliveryWait({
      live: () => {
        throw new Error('database is locked');
      },
      log: () => undefined,
      ...clock(),
    });
    expect(await wait('install')).toEqual({ waitedMs: 0, left: 0 });
  });

  it('counts what the mailbox says is held under a live lease', () => {
    const w = world();
    w.send();
    w.alive.add(100);
    w.mailbox.claimNextPending({ scope: 'local', lease: { pid: 100 } });
    expect(w.mailbox.liveLeases()).toHaveLength(1);
    w.alive.delete(100);
    w.tick(LEASE_TTL_MS + 1);
    expect(w.mailbox.liveLeases()).toHaveLength(0);
  });

  it('the updater asks before it installs and again before it restarts; a failing wait never stops the update', async () => {
    const manifest = { schema: 1, name: 'anytoany', version: '0.0.2', release: 20261021120000, file: 'morse.tgz', size: 1, sha256: 'x' } as unknown as ReleaseManifest;
    const order: string[] = [];
    const make = (quiet: (b: 'install' | 'restart') => Promise<unknown>) =>
      startAutoUpdater({
        enabled: () => true,
        busy: () => null,
        quiet,
        check: async () => ({ kind: 'available', manifest }) as CheckOutcome,
        install: vi.fn(async () => {
          order.push('install');
          return { ok: true as const };
        }),
        restart: vi.fn(async () => {
          order.push('restart');
          return 'manual' as const;
        }),
        log: () => undefined,
        stateFile: join(freshHome(), 'update.json'),
        setTimer: () => ({}),
        clearTimer: () => undefined,
      });
    const u = make(async (b) => void order.push(`quiet:${b}`));
    expect(await u.tick()).toBe('installed');
    expect(order).toEqual(['quiet:install', 'install', 'quiet:restart', 'restart']);
    u.stop();
    order.length = 0;
    const v = make(async () => {
      throw new Error('boom');
    });
    expect(await v.tick()).toBe('installed');
    expect(order).toEqual(['install', 'restart']);
    v.stop();
  });
});

describe('review F2: an update restarts the daemon without cutting what it is doing', () => {
  const launchd = { kind: 'launchd' as const, target: 'gui/501/talk.morse.daemon' };
  const harness = (stopsAfterMs: number | null) => {
    let t = 0;
    const calls: string[] = [];
    const signals: string[] = [];
    return {
      calls,
      signals,
      opts: {
        kill: (_pid: number, s: NodeJS.Signals) => void signals.push(s),
        alive: () => stopsAfterMs === null || t < stopsAfterMs,
        sleep: async (ms: number) => void (t += ms),
        run: async (cmd: string, args: string[]) => (calls.push([cmd, ...args].join(' ')), ''),
      },
      waited: () => t,
    };
  };

  it('from outside (`morse update`): SIGTERM straight to the daemon, wait for its orderly stop, then `kickstart` WITHOUT -k (launchd gives a job only 5 s after -k)', async () => {
    const h = harness(12_000); // the daemon needs 12 s: a turn was finishing
    expect(await restartGracefully(launchd, 4242, h.opts)).toBe('graceful');
    expect(h.signals).toEqual(['SIGTERM']);
    expect(h.waited()).toBeGreaterThanOrEqual(12_000);
    expect(h.calls).toEqual(['/bin/launchctl kickstart gui/501/talk.morse.daemon']);
    const sd = harness(3000);
    expect(await restartGracefully({ kind: 'systemd', unit: 'morse.service' }, 4242, sd.opts)).toBe('graceful');
    expect(sd.calls).toEqual(['systemctl --user --no-block restart morse.service']);
  });

  it('a daemon that does not stop in time is restarted the hard way, as before — and that is said', async () => {
    const h = harness(null);
    expect(await restartGracefully(launchd, 4242, { ...h.opts, waitMs: 25_000 })).toBe('forced');
    expect(h.waited()).toBe(25_000);
    expect(h.calls).toEqual(['/bin/launchctl kickstart -k gui/501/talk.morse.daemon']);
  });

  it('the service definitions the installer writes give the daemon time to stop: ExitTimeOut 30 (launchd), KillMode=mixed + TimeoutStopSec=30 (systemd)', () => {
    const sh = readFileSync(join(repo, 'site', 'install.sh'), 'utf8');
    expect(sh).toContain('<key>ExitTimeOut</key><integer>30</integer>');
    expect(sh).toMatch(/Restart=always\nRestartSec=10\nKillMode=mixed\nTimeoutStopSec=30\n/);
    expect(readFileSync(join(repo, 'scripts', 'install-daemon-launchd.sh'), 'utf8')).toContain('<key>ExitTimeOut</key><integer>30</integer>');
    expect(30_000).toBeGreaterThan(PLUGIN_STOP_GRACE_MS + 5000);
  });
});

describe('`morse status` says when an update is holding back for a turn', () => {
  it('the wait tells who shows it when it begins (with its deadline) and when it is over', async () => {
    let t = 0;
    const told: unknown[] = [];
    const wait = createDeliveryWait({ live: () => (t < 30_000 ? 1 : 0), log: () => undefined, now: () => t, sleep: async (ms) => void (t += ms), onWait: (w) => told.push(w) });
    await wait('install');
    expect(told).toEqual([{ before: 'install', since: 0, until: DELIVERY_WAIT_CAP_MS.install }, null]);
  });

  it('one line while it waits; nothing before, after, or once the deadline has passed', () => {
    expect(updateWaitingLine(undefined, 1000)).toBeNull();
    expect(updateWaitingLine({ before: 'install', since: 0, until: 600_000 }, 60_000)).toBe('  update ready — waiting for a message being handled before the install, up to 9 more min (then it goes ahead anyway)');
    expect(updateWaitingLine({ before: 'restart', since: 0, until: 120_000 }, 119_000)).toMatch(/before the restart, up to 1 more min/);
    expect(updateWaitingLine({ before: 'install', since: 0, until: 600_000 }, 600_001)).toBeNull();
  });
});

describe('`morse plugin claim | ack | nack | extend` — the commands an external plugin uses (ADR-051, ADR-052, ADR-089)', () => {
  const MORSE_CMD = [process.execPath, '--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(repo, 'src/cli.ts')];
  const newHome = () => {
    const home = freshHome();
    mkdirSync(join(home, '.morse'), { recursive: true });
    writeFileSync(join(home, '.morse', 'config.json'), JSON.stringify({ relay: { url: 'ws://127.0.0.1:9', handle: 'me', agent: 'mini', agents: ['mini'] } }));
    const ctx = homeContactContext(home);
    return { home, mailbox: createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx }) };
  };
  const cli = (home: string, ...args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string; json: () => Record<string, unknown> }>((done) => {
      const p = spawn(MORSE_CMD[0]!, [...MORSE_CMD.slice(1), ...args], { env: { ...process.env, MORSE_HOME: home, HOME: home } });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('close', (code) => done({ code, out, err, json: () => JSON.parse(out) as Record<string, unknown> }));
    });
  const own = (mb: Mailbox, text: string) => mb.send({ from: FROM, to: { agent: 'codex', sessionId: SID }, text });

  it('without --lease nothing changed: no holder in the answer, ack and nack need none, a restart sets the message aside and a late ack of the holder is still taken', async () => {
    const { home, mailbox } = newHome();
    const a = own(mailbox, 'one');
    const claimed = (await cli(home, 'plugin', 'claim', '--next', '--json')).json()['message'] as Record<string, unknown>;
    expect(claimed).toMatchObject({ id: a.id, text: 'one' });
    expect(claimed).not.toHaveProperty('lease');
    expect(claimed).not.toHaveProperty('possibleRepeat');
    const ack = await cli(home, 'plugin', 'ack', a.id, '--json');
    expect(ack.code, ack.err).toBe(0);
    expect(mailbox.getMessage(a.id)!.status).toBe('delivered');

    // the weaker guarantee: held without a lease, a restart sets it aside; the holder's late ack is still taken
    const b = own(mailbox, 'two');
    expect(((await cli(home, 'plugin', 'claim', b.id, '--json')).json()['message'] as { id: string }).id).toBe(b.id);
    expect((await cli(home, 'plugin', 'claim', '--recover', '--json')).json()).toEqual({ recovered: 1 });
    expect(mailbox.getMessage(b.id)!.status).toBe('failed');
    expect((await cli(home, 'plugin', 'ack', b.id, '--json')).code).toBe(0);
    expect(mailbox.getMessage(b.id)!.status).toBe('delivered');

    const c = own(mailbox, 'three');
    await cli(home, 'plugin', 'claim', c.id, '--json');
    const nack = await cli(home, 'plugin', 'nack', c.id, '--error', 'no luck', '--json');
    expect(nack.code, nack.err).toBe(0);
    expect(mailbox.getMessage(c.id)).toMatchObject({ status: 'failed', lastError: 'no luck' });
  }, 60_000);

  it('with --lease: the answer names the holder; only that holder acks; extend renews; a stranger is refused and nothing changes', async () => {
    const { home, mailbox } = newHome();
    const a = own(mailbox, 'held');
    const r = await cli(home, 'plugin', 'claim', '--next', '--lease', '--pid', String(process.pid), '--ttl', '60', '--json');
    expect(r.code, r.err).toBe(0);
    const claimed = r.json()['message'] as { id: string; lease: { holder: string; expiresAt: number } };
    expect(claimed.id).toBe(a.id);
    expect(claimed.lease.holder).toMatch(/^[0-9a-f-]{36}$/);
    expect(mailbox.getMessage(a.id)!.lease).toMatchObject({ holder: claimed.lease.holder, pid: process.pid });

    // recovery at a plugin's start leaves a leased message alone; nobody else can claim it
    expect((await cli(home, 'plugin', 'claim', '--recover', '--json')).json()).toEqual({ recovered: 0 });
    expect((await cli(home, 'plugin', 'claim', a.id, '--lease', '--json')).json()['message']).toBeNull();

    const ext = await cli(home, 'plugin', 'extend', a.id, '--holder', claimed.lease.holder, '--ttl', '600', '--json');
    expect(ext.code, ext.err).toBe(0);
    expect(ext.json()).toMatchObject({ ok: true });
    expect(mailbox.getMessage(a.id)!.lease!.expiresAt).toBeGreaterThan(claimed.lease.expiresAt + 400_000);
    // `--started`: said before the agent is started — only then is a later takeover a possible repeat (review F3)
    expect(mailbox.getMessage(a.id)!.lease!.started).toBeUndefined();
    expect((await cli(home, 'plugin', 'extend', a.id, '--holder', claimed.lease.holder, '--started', '--ttl', '600', '--json')).json()).toMatchObject({ ok: true });
    expect(mailbox.getMessage(a.id)!.lease!.started).toBe(true);

    // not the holder: with no holder at all (an old-style ack) and with a wrong one
    for (const args of [[], ['--holder', '00000000-0000-4000-8000-000000000000']]) {
      const bad = await cli(home, 'plugin', 'ack', a.id, ...args, '--json');
      expect(bad.code).not.toBe(0);
      expect(bad.json()).toMatchObject({ reason: 'lease-lost' });
    }
    const lost = await cli(home, 'plugin', 'extend', a.id, '--holder', '00000000-0000-4000-8000-000000000000', '--json');
    expect(lost.code).toBe(3);
    expect(lost.json()).toMatchObject({ ok: false, reason: 'lease-lost' });
    expect(mailbox.getMessage(a.id)!.status).toBe('delivering');

    const ok = await cli(home, 'plugin', 'ack', a.id, '--holder', claimed.lease.holder, '--json');
    expect(ok.code, ok.err).toBe(0);
    expect(mailbox.getMessage(a.id)).toMatchObject({ status: 'delivered' });
    expect(mailbox.getMessage(a.id)!.lease).toBeUndefined();
  }, 60_000);
});
