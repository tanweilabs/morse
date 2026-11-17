import { describe, expect, it } from 'vitest';
import { describeRelayStatus, formatDuration, formatRelativeTime, shortenHome } from '../src/format.js';

describe('formatRelativeTime', () => {
  const now = 1_000_000_000_000;
  it('formats sub-minute as just now', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
  });
  it('formats minutes', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });
  it('formats hours', () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
  it('formats days', () => {
    expect(formatRelativeTime(now - 49 * 3_600_000, now)).toBe('2d ago');
  });
  it('clamps future timestamps', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now');
  });
});

describe('shortenHome', () => {
  it('replaces home prefix with ~', () => {
    expect(shortenHome('/home/u/proj', '/home/u')).toBe('~/proj');
  });
  it('leaves other paths alone', () => {
    expect(shortenHome('/tmp/x', '/home/u')).toBe('/tmp/x');
  });
});

describe('describeRelayStatus (ADR-043)', () => {
  const now = Date.parse('2026-11-10T13:25:00Z');
  it('connected: since when', () => {
    expect(describeRelayStatus({ url: 'wss://relay.morse.im', connected: true, state: { lastConnectedAt: now - 3 * 3600_000, disconnectedSince: null, lastAttemptAt: now - 3 * 3600_000, failures: 0, lastError: null } }, now)).toBe(
      'relay: connected to wss://relay.morse.im since 2026-11-10T10:25:00.000Z (3h ago)',
    );
  });
  it('disconnected: for how long, last connected, why', () => {
    const line = describeRelayStatus(
      {
        url: 'wss://relay.morse.talk',
        connected: false,
        state: { lastConnectedAt: Date.parse('2026-11-02T02:37:35Z'), disconnectedSince: Date.parse('2026-11-02T02:39:45Z'), lastAttemptAt: now - 10_000, failures: 4, lastError: 'no login within 20 s' },
      },
      now,
    );
    expect(line).toBe(
      'relay: NOT connected to wss://relay.morse.talk — for 8d 10h · last connected 2026-11-02T02:37:35.000Z (8d ago) · 4 failed attempt(s) in a row · last attempt just now · last error: no login within 20 s',
    );
  });
  it('not configured', () => {
    expect(describeRelayStatus(null)).toBe('relay: not configured on this daemon');
  });
  it('durations', () => {
    expect([45_000, 12 * 60_000, 3 * 3600_000 + 5 * 60_000, 8 * 86400_000 + 10 * 3600_000].map(formatDuration)).toEqual(['45s', '12m', '3h 05m', '8d 10h']);
  });
});
