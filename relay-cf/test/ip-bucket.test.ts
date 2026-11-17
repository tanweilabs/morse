import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IP_FAIL_OPEN_MS, IP_LEASE_SIZE, IP_LEASE_TTL_MS, IP_REFUSED_BACKOFF_MS, LeaseHolder, TokenBucket, ipRateLimitedError, sendIpHash } from '../src/ip-limit.js';
import { DEFAULT_SEND_RATE_PER_IP_PER_MINUTE, checkV3Send, ipHash, v3SettingsFromEnv } from '../src/v3.js';

/**
 * The per-client-IP limit on v3 `send` frames (ip-limit.ts) — the pure parts: the bucket one
 * IP's connections share, the lease a connection holds of it, the setting, the hashed name.
 * The wiring (AddressHub ⇄ IpBucket under workerd) is in v3-ip-limit-wrangler.test.ts.
 */

const T0 = 1_700_000_000_000;

describe('TokenBucket — one IP, all its connections', () => {
  it('starts full: a burst of `rate`, then nothing', () => {
    const b = new TokenBucket(30, T0);
    expect(b.grant(20, T0)).toBe(20);
    expect(b.grant(20, T0)).toBe(10); // never more than is there
    expect(b.grant(20, T0)).toBe(0);
    expect(b.grant(1, T0)).toBe(0);
  });

  it('refills at `rate` a minute, whole tokens only, never above `rate`', () => {
    const b = new TokenBucket(60, T0); // one a second
    expect(b.grant(60, T0)).toBe(60);
    expect(b.grant(20, T0 + 999)).toBe(0); // 0.999 of a token is not a token
    expect(b.grant(20, T0 + 1000)).toBe(1);
    expect(b.grant(20, T0 + 6000)).toBe(5);
    expect(b.grant(20, T0 + 6500)).toBe(0);
    expect(b.grant(20, T0 + 7000)).toBe(1); // the half second before was not lost
    expect(b.grant(1000, T0 + 3_600_000)).toBe(60); // an hour idle is still one burst
  });

  it('over any stretch it hands out at most burst + rate × time', () => {
    const b = new TokenBucket(600, T0);
    let total = 0;
    for (let t = 0; t <= 120_000; t += 137) total += b.grant(IP_LEASE_SIZE, T0 + t);
    expect(total).toBeLessThanOrEqual(600 + 600 * 2);
    expect(total).toBeGreaterThan(600 + 600 * 2 - IP_LEASE_SIZE);
  });

  it('a nonsense request gets nothing and costs nothing; time going backwards adds nothing', () => {
    const b = new TokenBucket(30, T0);
    expect(b.grant(0, T0)).toBe(0);
    expect(b.grant(-5, T0)).toBe(0);
    expect(b.grant(Number.NaN, T0)).toBe(0);
    expect(b.grant(2.9, T0)).toBe(2);
    expect(b.grant(28, T0)).toBe(28);
    expect(b.grant(5, T0 - 60_000)).toBe(0);
    expect(b.rate).toBe(30);
  });
});

describe('LeaseHolder — what one connection holds', () => {
  it('asks for a lease first; one lease = IP_LEASE_SIZE sends, then it asks again', () => {
    expect(IP_LEASE_SIZE).toBe(20);
    expect(IP_LEASE_TTL_MS).toBe(30_000);
    const l = new LeaseHolder();
    expect(l.take(T0)).toBe('need-lease');
    l.fill(20, T0);
    for (let i = 0; i < 20; i++) expect(l.take(T0 + i)).toBe('ok');
    expect(l.take(T0 + 20)).toBe('need-lease');
    l.fill(7, T0 + 20); // the bucket had only 7 left
    for (let i = 0; i < 7; i++) expect(l.take(T0 + 21)).toBe('ok');
    expect(l.take(T0 + 21)).toBe('need-lease');
  });

  it('an expired lease is dropped: its unused tokens are never usable later', () => {
    const l = new LeaseHolder();
    l.fill(20, T0);
    expect(l.take(T0 + IP_LEASE_TTL_MS - 1)).toBe('ok');
    expect(l.take(T0 + IP_LEASE_TTL_MS)).toBe('need-lease'); // 19 left, all gone
    expect(l.take(T0 + IP_LEASE_TTL_MS + 1)).toBe('need-lease');
    l.fill(2, T0 + IP_LEASE_TTL_MS + 1);
    expect(l.take(T0 + IP_LEASE_TTL_MS + 2)).toBe('ok');
    expect(l.take(T0 + IP_LEASE_TTL_MS + 2)).toBe('ok');
    expect(l.take(T0 + IP_LEASE_TTL_MS + 2)).toBe('need-lease'); // 2, not 2 + the old 19
  });

  it('a grant of 0 = refused, and the bucket is not asked again for IP_REFUSED_BACKOFF_MS', () => {
    const l = new LeaseHolder();
    expect(l.take(T0)).toBe('need-lease');
    l.fill(0, T0);
    for (let i = 0; i < 500; i++) expect(l.take(T0 + i)).toBe('refused'); // a flood of sends: no call
    expect(l.take(T0 + IP_REFUSED_BACKOFF_MS - 1)).toBe('refused');
    expect(l.take(T0 + IP_REFUSED_BACKOFF_MS)).toBe('need-lease');
    l.fill(0, T0 + IP_REFUSED_BACKOFF_MS);
    expect(l.take(T0 + IP_REFUSED_BACKOFF_MS + 1)).toBe('refused');
    l.fill(1, T0 + 2 * IP_REFUSED_BACKOFF_MS); // tokens came back
    expect(l.take(T0 + 2 * IP_REFUSED_BACKOFF_MS)).toBe('ok');
  });

  it('never holds more than one lease, whatever the answer says', () => {
    const l = new LeaseHolder();
    l.fill(10_000, T0);
    let ok = 0;
    while (l.take(T0) === 'ok') ok++;
    expect(ok).toBe(IP_LEASE_SIZE);
    l.fill(-3, T0);
    expect(l.take(T0)).toBe('refused');
    const m = new LeaseHolder();
    m.fill(Number.NaN, T0);
    expect(m.take(T0)).toBe('refused');
    const n = new LeaseHolder();
    n.fill(2.7, T0);
    expect([n.take(T0), n.take(T0), n.take(T0)]).toEqual(['ok', 'ok', 'need-lease']);
  });

  it('fail open: the bucket cannot be reached → sends go through, and it is not asked for IP_FAIL_OPEN_MS', () => {
    const l = new LeaseHolder();
    expect(l.take(T0)).toBe('need-lease');
    l.failOpen(T0);
    for (let i = 0; i < 100; i++) expect(l.take(T0 + i)).toBe('ok');
    expect(l.take(T0 + IP_FAIL_OPEN_MS - 1)).toBe('ok');
    expect(l.take(T0 + IP_FAIL_OPEN_MS)).toBe('need-lease'); // then it tries the bucket again
    // even when it had just been refused
    const r = new LeaseHolder();
    r.fill(0, T0);
    r.failOpen(T0 + 1);
    expect(r.take(T0 + 2)).toBe('ok');
  });

  it('two connections on one bucket: the second gets what the first left', () => {
    const bucket = new TokenBucket(30, T0);
    const send = (l: LeaseHolder, now: number): boolean => {
      for (;;) {
        const t = l.take(now);
        if (t !== 'need-lease') return t === 'ok';
        l.fill(bucket.grant(IP_LEASE_SIZE, now), now);
      }
    };
    const a = new LeaseHolder();
    const b = new LeaseHolder();
    const count = (l: LeaseHolder, n: number, now: number) => Array.from({ length: n }, () => send(l, now)).filter(Boolean).length;
    expect(count(a, 20, T0)).toBe(20);
    expect(count(b, 20, T0 + 1)).toBe(10);
    expect(count(a, 5, T0 + 2)).toBe(0);
    // two seconds later one token is back (30 a minute), for whoever asks first after its backoff
    expect(count(b, 3, T0 + 2100)).toBe(1);
    expect(count(a, 3, T0 + 2200)).toBe(0);
  });
});

describe('the setting and the refusal', () => {
  it('V3_RATE_PER_IP_PER_MINUTE: default 600, "0" = off, garbage = the default', () => {
    expect(DEFAULT_SEND_RATE_PER_IP_PER_MINUTE).toBe(600);
    expect(v3SettingsFromEnv({}).ratePerIpPerMinute).toBe(600);
    expect(v3SettingsFromEnv({ V3_RATE_PER_IP_PER_MINUTE: '0' }).ratePerIpPerMinute).toBe(0);
    expect(v3SettingsFromEnv({ V3_RATE_PER_IP_PER_MINUTE: '30' }).ratePerIpPerMinute).toBe(30);
    for (const junk of ['', 'abc', '-1', 'NaN']) expect(v3SettingsFromEnv({ V3_RATE_PER_IP_PER_MINUTE: junk }).ratePerIpPerMinute).toBe(600);
    // the per-connection bucket is still its own, off by default
    expect(v3SettingsFromEnv({}).ratePerMinute).toBe(0);
    expect(v3SettingsFromEnv({ V3_RATE_PER_MINUTE: '5', V3_RATE_PER_IP_PER_MINUTE: '0' })).toMatchObject({ ratePerMinute: 5, ratePerIpPerMinute: 0 });
  });

  it('the refusal has the text shape clients already wait on — the per-connection one', () => {
    expect(ipRateLimitedError(600)).toBe('rate limited (max 600/min)');
    expect(ipRateLimitedError(30)).toMatch(/rate limited/);
    const a = 'a'.repeat(26);
    const limiter = { rate: 600, take: () => false } as unknown as NonNullable<Parameters<typeof checkV3Send>[3]>;
    expect(checkV3Send({ to: a, blob: 'x' }, [a], 100, limiter)).toEqual({ ok: false, error: ipRateLimitedError(600) });
  });
});

describe('sendIpHash — the name of an IP bucket', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

  it('stable, 32 hex characters, never the IP', async () => {
    const h = await sendIpHash('203.0.113.7');
    expect(h).toBe(await sendIpHash('203.0.113.7'));
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain('203');
    expect(h).toBe(sha('morse-v3-send-ip\n203.0.113.7'));
    expect(await sendIpHash('203.0.113.8')).not.toBe(h);
    expect(await sendIpHash('2001:db8::1')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('no IP (local wrangler dev, a missing header) hashes like "unknown"', async () => {
    const u = await sendIpHash('unknown');
    expect(await sendIpHash('')).toBe(u);
    expect(await sendIpHash(null)).toBe(u);
    expect(await sendIpHash(undefined)).toBe(u);
  });

  it('domain-separated from the new-address counter: the same IP gives unrelated names', async () => {
    const ip = '203.0.113.7';
    expect(await ipHash(ip)).toBe(sha(`morse-new-address-ip\n${ip}`)); // what it always was
    expect(await sendIpHash(ip)).not.toBe(await ipHash(ip));
    expect(await sendIpHash('')).not.toBe(await ipHash(''));
  });
});
