import { describe, expect, it } from 'vitest';
import { MAX_SIGNAL_BYTES, SIGNAL_RATE_PER_MINUTE, checkSignal, signalFrame } from '../src/signal.js';
import { RateLimiter, parseFrame } from '../src/protocol.js';

/**
 * Server side (ADR-069): the relay forwards WebRTC signaling between logged-in devices
 * and stores nothing. relay-cf/src/signal.ts holds the checks the DeviceHub runs; the
 * real Worker is covered by relay-cf/test/direct-wrangler.test.ts (wrangler dev).
 */
const ID = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHH';

describe('checkSignal', () => {
  it('accepts a signal to a device id in any spelling, normalised', () => {
    const r = checkSignal({ type: 'signal', to: ID.toLowerCase().replace(/-/g, ''), blob: '{"v":1}' });
    expect(r).toEqual({ ok: true, to: ID, blob: '{"v":1}' });
  });

  it('refuses a bad recipient, an empty or non-string blob', () => {
    expect(checkSignal({ type: 'signal', to: 'nope', blob: 'x' })).toEqual({ ok: false, error: 'bad recipient id' });
    expect(checkSignal({ type: 'signal', to: ID, blob: '' })).toEqual({ ok: false, error: 'empty signal' });
    expect(checkSignal({ type: 'signal', to: ID, blob: 42 })).toEqual({ ok: false, error: 'empty signal' });
  });

  it(`refuses a signal over ${MAX_SIGNAL_BYTES} bytes`, () => {
    const r = checkSignal({ type: 'signal', to: ID, blob: 'x'.repeat(MAX_SIGNAL_BYTES + 1) });
    expect(r).toEqual({ ok: false, error: `signal too large (max ${MAX_SIGNAL_BYTES} bytes)` });
    expect(checkSignal({ type: 'signal', to: ID, blob: 'x'.repeat(MAX_SIGNAL_BYTES) }).ok).toBe(true);
  });

  it('counts bytes, not characters (multi-byte text)', () => {
    const r = checkSignal({ type: 'signal', to: ID, blob: '你'.repeat(Math.floor(MAX_SIGNAL_BYTES / 3) + 1) });
    expect(r.ok).toBe(false);
  });

  it('rate-limits with its own bucket when one is given', () => {
    const limiter = new RateLimiter(2, 0);
    const msg = { type: 'signal', to: ID, blob: 'x' };
    expect(checkSignal(msg, limiter, 0).ok).toBe(true);
    expect(checkSignal(msg, limiter, 0).ok).toBe(true);
    expect(checkSignal(msg, limiter, 0)).toEqual({ ok: false, error: 'rate limited (max 2 signals/min)' });
    expect(checkSignal(msg, limiter, 60_000).ok).toBe(true);
    expect(SIGNAL_RATE_PER_MINUTE).toBe(240);
  });
});

describe('signalFrame', () => {
  it('is the push the recipient gets: type, from, fromHandle when known, blob, ts', () => {
    expect(parseFrame(signalFrame({ from: ID, fromHandle: 'bob', blob: 'b' }, 7))).toEqual({ type: 'signal', from: ID, fromHandle: 'bob', blob: 'b', ts: 7 });
    expect(parseFrame(signalFrame({ from: ID, blob: 'b' }, 7))).toEqual({ type: 'signal', from: ID, blob: 'b', ts: 7 });
  });
});
