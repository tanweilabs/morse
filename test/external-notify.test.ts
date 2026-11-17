import { afterEach, describe, expect, it, vi } from 'vitest';
import { startExternalInboxNotifier, type ExternalInboxNotifierOptions } from '../src/daemon/external-notify.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import type { ExternalSession } from '../src/registry/external.js';

// ADR-024: the dispatcher never claims a registered agent's mail, so no `delivered`
// event fires for it — and the app cannot wake itself. The daemon notifies the
// operator instead, once per new message.

const app: ExternalSession = {
  agent: 'notes-app',
  sessionId: 'notes-1',
  title: 'Notes assistant',
  cwd: '/w/notes',
  registeredAt: 1,
  lastSeenAt: 2,
};
const second: ExternalSession = { ...app, agent: 'sds', sessionId: 'sds-main', title: '闪电说助手' };
const sender = { agent: 'claude', sessionId: 'c1a0de00-0000-4000-8000-00000000000a' };

type Shown = [agent: string, title: string, sessionId: string, direction: string];

function harness(over: Partial<ExternalInboxNotifierOptions> & { registered?: () => ExternalSession[] } = {}) {
  const mailbox: Mailbox = createMailbox(createDb(':memory:'));
  const shown: Shown[] = [];
  const logged: string[] = [];
  const start = () =>
    startExternalInboxNotifier({
      mailbox,
      listRegistered: over.registered ?? (() => [app]),
      notifier: { sessionActivity: (...args: Shown) => void shown.push(args) } as ExternalInboxNotifierOptions['notifier'],
      autoStart: false,
      onNotify: (s, id) => logged.push(`${s.agent}/${id}`),
      ...over,
    });
  const mail = (to: ExternalSession | { agent: string; sessionId: string }, text = 'hello') =>
    mailbox.send({ from: sender, to: { agent: to.agent, sessionId: to.sessionId }, text });
  return { mailbox, shown, logged, start, mail };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startExternalInboxNotifier', () => {
  it('a new message for a registered session: one "received" notification and one log line, never repeated', () => {
    const h = harness();
    const n = h.start();
    const m = h.mail(app);
    n.tick();
    n.tick();
    expect(h.shown).toEqual([['notes-app', 'Notes assistant', 'notes-1', 'received']]);
    expect(h.logged).toEqual([`notes-app/${m.id}`]);
    n.stop();
  });

  it('every message counts: two new ones are two notifications, across sessions', () => {
    const h = harness({ registered: () => [app, second] });
    const n = h.start();
    h.mail(app, 'one');
    h.mail(second, 'two');
    h.mail(app, 'three');
    n.tick();
    expect(h.shown.map(([agent]) => agent).sort()).toEqual(['notes-app', 'notes-app', 'sds']);
    n.stop();
  });

  it('mail already waiting when it starts is not announced (a daemon restart replays nothing)', () => {
    const h = harness();
    h.mail(app, 'old 1');
    h.mail(app, 'old 2');
    const n = h.start();
    n.tick();
    expect(h.shown).toEqual([]);
    h.mail(app, 'new');
    n.tick();
    expect(h.shown).toHaveLength(1);
    n.stop();
  });

  it('only registered sessions count, and a session registered later is picked up', () => {
    let registered: ExternalSession[] = [];
    const h = harness({ registered: () => registered });
    const n = h.start();
    h.mail({ agent: 'claude', sessionId: 'someone-else' });
    h.mail(app);
    n.tick();
    expect(h.shown).toEqual([]);
    registered = [app];
    n.tick();
    expect(h.shown.map(([, , sid]) => sid)).toEqual(['notes-1']);
    n.stop();
  });

  it('a message fetched (no longer pending) before the tick is not announced', () => {
    const h = harness();
    const n = h.start();
    const m = h.mail(app);
    h.mailbox.claimById(m.id);
    h.mailbox.markDelivered(m.id);
    n.tick();
    expect(h.shown).toEqual([]);
    n.stop();
  });

  it('a failing mailbox or registry never throws out of start or tick', () => {
    const failing = harness({
      mailbox: {
        inbox: () => {
          throw new Error('database is locked');
        },
      },
    });
    expect(() => failing.start().tick()).not.toThrow();
    const noRegistry = harness({
      registered: () => {
        throw new Error('EACCES');
      },
    });
    expect(() => noRegistry.start().tick()).not.toThrow();
    expect(failing.shown).toEqual([]);
  });

  it('with the timer on it scans every intervalMs (5 s by default) until stopped; stop twice is fine', () => {
    vi.useFakeTimers();
    const h = harness({ autoStart: true });
    const n = h.start();
    h.mail(app);
    vi.advanceTimersByTime(4_999);
    expect(h.shown).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.shown).toHaveLength(1);
    n.stop();
    n.stop();
    h.mail(app);
    vi.advanceTimersByTime(60_000);
    expect(h.shown).toHaveLength(1);

    const fast = harness({ autoStart: undefined, intervalMs: 10 });
    const f = fast.start();
    fast.mail(app);
    vi.advanceTimersByTime(10);
    expect(fast.shown).toHaveLength(1);
    f.stop();
  });
});
