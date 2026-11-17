import { describe, expect, it } from 'vitest';
import { dispatchOnce } from '../src/daemon/dispatcher.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, DEFAULT_WAIT_MAX_MS, DEFAULT_WAIT_RETRY_MS } from '../src/mailbox/mailbox.js';

/**
 * Morse outbox (ADR-030 revised): the relay stores nothing, so a message to a
 * person who is not reachable stays HERE and is retried until their device is
 * back — not "3 tries then dead" like a local delivery failure.
 */

const A = { agent: 'claude', sessionId: 'a-1' };
const BOB = { agent: 'user', sessionId: 'inbox', device: 'bob' };

describe('mailbox: waiting messages', () => {
  it('markFailed({waiting}) keeps the message retryable past 3 attempts, on the wait interval', () => {
    let t = 1_000_000;
    const mailbox = createMailbox(createDb(':memory:'), { now: () => t, waitRetryMs: 10_000 });
    const m = mailbox.send({ from: A, to: BOB, text: 'hi' });
    for (let i = 1; i <= 6; i++) {
      const claimed = mailbox.claimNextPending();
      expect(claimed?.id, `attempt ${i}`).toBe(m.id);
      const failed = mailbox.markFailed(m.id, 'bob is offline', { waiting: true });
      expect(failed.status).toBe('failed');
      expect(failed.waiting).toBe(true);
      expect(failed.attempts).toBe(i);
      expect(mailbox.claimNextPending()).toBeNull(); // not before the interval
      t += 9_999;
      expect(mailbox.claimNextPending()).toBeNull();
      t += 1;
    }
    expect(mailbox.inbox({ all: true })[0]?.lastError).toBe('bob is offline');
  });

  it('a non-waiting failure still dead-letters after 3 attempts', () => {
    let t = 1_000_000;
    const mailbox = createMailbox(createDb(':memory:'), { now: () => t });
    const m = mailbox.send({ from: A, to: BOB, text: 'hi' });
    for (let i = 0; i < 3; i++) {
      mailbox.claimNextPending();
      mailbox.markFailed(m.id, 'boom');
      t += 60_000;
    }
    expect(mailbox.getMessage(m.id)?.status).toBe('dead');
    expect(mailbox.getMessage(m.id)?.waiting).toBeUndefined();
  });

  it('gives up (dead) once the message is older than the max wait', () => {
    let t = 1_000_000;
    const mailbox = createMailbox(createDb(':memory:'), { now: () => t, waitRetryMs: 1000, waitMaxMs: 100_000 });
    const m = mailbox.send({ from: A, to: BOB, text: 'hi' });
    mailbox.claimNextPending();
    mailbox.markFailed(m.id, 'bob is offline', { waiting: true });
    t += 99_000;
    expect(mailbox.claimNextPending()?.id).toBe(m.id);
    mailbox.markFailed(m.id, 'bob is offline', { waiting: true });
    t += 2_000; // now past 100 s since creation
    expect(mailbox.claimNextPending()).toBeNull();
    const dead = mailbox.getMessage(m.id)!;
    expect(dead.status).toBe('dead');
    expect(dead.waiting).toBeUndefined();
    expect(dead.lastError).toMatch(/gave up: recipient unreachable for 0 days — bob is offline/);
    // manual retry clears the wait and goes again
    expect(mailbox.retry(m.id).status).toBe('pending');
    expect(mailbox.claimNextPending()?.id).toBe(m.id);
  });

  it('delivered clears waiting; defaults are 30 s / 30 days', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const m = mailbox.send({ from: A, to: BOB, text: 'hi' });
    mailbox.claimNextPending();
    mailbox.markFailed(m.id, 'offline', { waiting: true });
    mailbox.retry(m.id);
    mailbox.claimNextPending();
    expect(mailbox.markDelivered(m.id).waiting).toBeUndefined();
    expect(DEFAULT_WAIT_RETRY_MS).toBe(30_000);
    expect(DEFAULT_WAIT_MAX_MS).toBe(30 * 24 * 3600 * 1000);
  });

  it('forgetSeen re-opens inbound dedupe after a failed filing', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    expect(mailbox.firstSeen('dev', 'm1')).toBe(true);
    expect(mailbox.firstSeen('dev', 'm1')).toBe(false);
    mailbox.forgetSeen('dev', 'm1');
    expect(mailbox.firstSeen('dev', 'm1')).toBe(true);
  });
});

describe('dispatcher: relay says waiting', () => {
  it('parks the message as waiting (not dead) and emits a waiting event', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const m = mailbox.send({ from: A, to: { agent: 'codex', sessionId: 'b-1', device: 'bob' }, text: 'work' });
    const events: string[] = [];
    let calls = 0;
    const run = () =>
      dispatchOnce({
        mailbox,
        adapters: new Map(),
        directory: async () => [],
        selfDevice: 'mini',
        relay: async () => (++calls === 1 ? { ok: false, waiting: true, error: '@bob is offline' } : { ok: true }),
        onEvent: (e) => events.push(e.kind),
      });
    expect(await run()).toBe(true);
    expect(mailbox.getMessage(m.id)).toMatchObject({ status: 'failed', waiting: true, lastError: '@bob is offline' });
    expect(events).toEqual(['waiting']);
    expect(await run()).toBe(false); // nothing claimable until the retry interval passes
    mailbox.retry(m.id);
    expect(await run()).toBe(true);
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
    expect(events).toEqual(['waiting', 'delivered']);
  });
});
