import { describe, expect, it } from 'vitest';
import { describeRelayStatus, formatDuration, formatRelativeTime, shortenHome } from '../src/format.js';

describe('formatRelativeTime: how long ago, coarsely', () => {
  const at = Date.parse('2026-06-01T12:00:00Z');
  const ago = (ms: number) => formatRelativeTime(at - ms, at);

  it('under a minute — or in the future — is "just now"', () => {
    expect([0, 1, 59_999, -3_600_000].map(ago)).toEqual(['just now', 'just now', 'just now', 'just now']);
  });

  it('then whole minutes, hours and days, always rounded down', () => {
    expect([60_000, 119_999, 59 * 60_000 + 59_999].map(ago)).toEqual(['1m ago', '1m ago', '59m ago']);
    expect([3_600_000, 23 * 3_600_000 + 3_599_999].map(ago)).toEqual(['1h ago', '23h ago']);
    expect([86_400_000, 36 * 3_600_000, 400 * 86_400_000].map(ago)).toEqual(['1d ago', '1d ago', '400d ago']);
  });

  it('measures from now by default', () => {
    expect(formatRelativeTime(Date.now() - 2 * 3_600_000 - 5000)).toBe('2h ago');
  });
});

describe('shortenHome', () => {
  it('writes a path under the home directory as ~/…, and the home itself as ~', () => {
    expect(shortenHome('/Users/alex/code/app', '/Users/alex')).toBe('~/code/app');
    expect(shortenHome('/Users/alex', '/Users/alex')).toBe('~');
  });
  it('leaves any other path alone', () => {
    expect(shortenHome('/opt/tool', '/Users/alex')).toBe('/opt/tool');
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
