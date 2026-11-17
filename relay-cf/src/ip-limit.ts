import { ipHash } from './v3.js';

/**
 * The per-client-IP limit on v3 `send` frames, shared by every connection from that IP
 * (`V3_RATE_PER_IP_PER_MINUTE`, default 600, 0 = off). The pure half; the Durable Object
 * that holds one IP's bucket is ip-bucket.ts, the connection side is in address-hub.ts.
 *
 * A connection lives in the AddressHub of its primary address, so two connections from one
 * IP are two different objects: what they share has to live in a third one (IpBucket, one
 * per hashed IP). Asking it for every message would cost one more Durable Object round trip
 * per send, so a connection LEASES tokens in batches instead:
 *
 *   bucket (IpBucket)   a token bucket in memory: R tokens a minute, at most R at once
 *   lease  (AddressHub) up to IP_LEASE_SIZE tokens taken from the bucket in one call; a send
 *                       spends one. Only an empty or expired lease asks the bucket again:
 *                       one round trip per IP_LEASE_SIZE sends, not per send
 *
 * A lease is good for IP_LEASE_TTL_MS; what is left of it then is dropped, never used
 * later, so a token cannot outlive the minute it was counted in. The bucket grants
 * min(IP_LEASE_SIZE, what it has); a grant of 0 means "over the limit": that send is
 * refused, and the connection does not ask again for IP_REFUSED_BACKOFF_MS (a flood of
 * refused sends must not become a flood of calls). The price of leasing: tokens a
 * connection holds and does not use are lost to the others until the lease expires (at
 * most IP_LEASE_SIZE − 1 per connection).
 *
 * Nothing here is stored and nothing knows the IP: the bucket's name is `sendIpHash(ip)`.
 */

export const IP_LEASE_SIZE = 20;
export const IP_LEASE_TTL_MS = 30_000;
/** After a grant of 0: refuse without asking the bucket for this long. */
export const IP_REFUSED_BACKOFF_MS = 1_000;
/** After the bucket could not be reached: let sends through without asking for this long. */
export const IP_FAIL_OPEN_MS = 10_000;

const SEND_IP_DOMAIN = 'morse-v3-send-ip';

/** The name of an IP's bucket: a hash, domain-separated from the other per-IP counters. */
export const sendIpHash = (ip: string | null | undefined): Promise<string> => ipHash(ip, SEND_IP_DOMAIN);

/** The error a refused `send` is answered with — the shape clients match (/rate limited/) and wait on. */
export const ipRateLimitedError = (ratePerMinute: number): string => `rate limited (max ${ratePerMinute}/min)`;

/** One IP's tokens: `rate` a minute, never more than `rate` at once; starts full. */
export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(readonly rate: number, now: number) {
    this.tokens = rate;
    this.at = now;
  }
  /** Hand out up to `want` whole tokens — fewer when fewer are there, 0 when none. */
  grant(want: number, now: number): number {
    if (now > this.at) {
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.at) / 60_000) * this.rate);
      this.at = now;
    }
    const n = Math.max(0, Math.min(Number.isFinite(want) ? Math.floor(want) : 0, Math.floor(this.tokens)));
    this.tokens -= n;
    return n;
  }
}

/** What one connection holds of its IP's tokens. */
export class LeaseHolder {
  private tokens = 0;
  private expiresAt = 0;
  private refusedUntil = 0;
  private openUntil = 0;

  /**
   * One send. `ok` = go ahead (a token of the lease was spent); `need-lease` = ask the bucket,
   * `fill` (or `failOpen`), then take again; `refused` = over the limit, answer "rate limited".
   */
  take(now: number): 'ok' | 'need-lease' | 'refused' {
    if (now < this.openUntil) return 'ok';
    if (this.tokens > 0 && now < this.expiresAt) {
      this.tokens--;
      return 'ok';
    }
    this.tokens = 0; // an expired lease: what was left of it is gone
    return now < this.refusedUntil ? 'refused' : 'need-lease';
  }

  /** The bucket's answer to a lease request made at `now`. */
  fill(granted: number, now: number): void {
    this.tokens = Math.max(0, Math.min(IP_LEASE_SIZE, Number.isFinite(granted) ? Math.floor(granted) : 0));
    this.expiresAt = now + IP_LEASE_TTL_MS;
    if (this.tokens === 0) this.refusedUntil = now + IP_REFUSED_BACKOFF_MS;
  }

  /** The bucket could not be asked: a limiter that is down must not stop mail. */
  failOpen(now: number): void {
    this.tokens = 0;
    this.openUntil = now + IP_FAIL_OPEN_MS;
  }
}
