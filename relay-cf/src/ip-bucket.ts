import { DurableObject } from 'cloudflare:workers';
import type { Env } from './hub.js';
import { TokenBucket } from './ip-limit.js';

/**
 * IpBucket — ONE Durable Object per client IP (`idFromName(sendIpHash(ip))`: a hash, the
 * object never learns the IP) holding the tokens that IP's connections share for v3 `send`
 * frames (ip-limit.ts). Only AddressHubs call it, once per lease, not once per message.
 *
 *   POST /lease {want, rate}  → {granted}    0 ≤ granted ≤ want; 0 = over the limit
 *
 * `rate` (tokens a minute, burst = the same) comes from the caller's settings, so nothing
 * is parsed here; a different rate starts a new bucket. The bucket is kept in memory only —
 * no storage, no alarm: an object that was evicted comes back full.
 */
export class IpBucket extends DurableObject<Env> {
  private bucket: TokenBucket | null = null;

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/lease' || request.method !== 'POST') return new Response('not found', { status: 404 });
    let b: { want?: unknown; rate?: unknown } = {};
    try {
      b = ((await request.json()) as typeof b) ?? {};
    } catch {
      /* answered below */
    }
    const { want, rate } = b;
    if (typeof want !== 'number' || typeof rate !== 'number' || !(want > 0) || !(rate > 0)) return new Response('POST /lease {want, rate}', { status: 400 });
    const now = Date.now();
    if (this.bucket?.rate !== rate) this.bucket = new TokenBucket(rate, now);
    return Response.json({ granted: this.bucket.grant(want, now) });
  }
}

export const ipBucket = (env: Pick<Env, 'IP_BUCKET'>, name: string): DurableObjectStub<IpBucket> => env.IP_BUCKET.get(env.IP_BUCKET.idFromName(name));
