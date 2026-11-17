import { normalizeAddress } from './address.js';
import { RateLimiter } from './protocol.js';

/**
 * Morse relay wire protocol v3 (ADR-073, docs/specs/identity-v3.zh-CN.md §10) — one
 * WebSocket per computer at /v3/ws/<primary address>, logging in every address the
 * computer hosts. Additive: the v2 protocol (protocol.ts, DeviceHub) is unchanged.
 *
 *   relay  → {type:"challenge", nonce, protocol:3}
 *   client → {type:"hello", v:3, addresses:[{address, key, sig, prekey?, caps?}]}
 *            sig = Ed25519(key, "morse-relay-login-v3\n<nonce>\n<address>"); the first entry
 *            must be the address in the URL (its hub holds the socket); no allowlist
 *            caps (ADR-081): what the client behind this address can do — up to 8 strings of
 *            1–16 [a-z0-9]; kept as given with the address record (replaced at every login; a
 *            login without caps clears them) and handed back by the `address` query. Anything
 *            else in there is dropped, never an error. `addr1` = it takes v3 envelopes that carry
 *            no device certificate and handles them by address. The relay never reads a cap.
 *          → {type:"welcome", v:3, addresses:[…], limits, protocols:[2,3]} | close 4001 / 4029
 *   client → {type:"send", rid, to, blob, from?, ref?, store?}  → {type:"sent", rid}       pushed to a live connection
 *                                                       → {type:"stored", rid, expiresAt}  recipient offline: kept ≤ 7 days
 *                                                       → {type:"offline", rid}            recipient offline and store:false
 *                                                       → {type:"error", rid, error}       incl. unknown address / mailbox full /
 *                                                          "rate limited (max N/min)" (per client IP, ip-limit.ts: wait, send again)
 *   client → {type:"address", rid, address}  → {type:"address", rid, address, key|null, prekey|null, online, caps:[…]}
 *   client → {type:"alias", rid, name}        → {type:"alias", rid, name, entries:[{name, address, agent, default?:true}]}
 *                                               | {type:"error", rid, error:"bad alias name"}
 *            a frozen v2 name (`alice`, `alice/air`) → the address(es) it meant; unknown = entries:[] (aliases.ts)
 *   client → {type:"prekey", rid, address, prekey} → {type:"prekey", rid, ok:true} | error   (a rotated prekey)
 *   client → {type:"ack", to, ids:[…]}        (no answer) the stored deliveries `ids` of `to` were taken: delete them
 *   client → {type:"signal", rid, to, blob, from?} → {type:"signaled"|"offline", rid} | error   (WebRTC, ADR-069)
 *   relay  → {type:"deliver", id, to, from, blob, ts, ref?, stored?:true}
 *   relay  → {type:"undeliverable", from, to, ref, ts}   (what `from` sent to `to` expired unread)
 *   relay  → {type:"signal", from, to, blob, ts}
 *
 * Close codes: 4000 replaced · 4001 login failed · 4002 bad frame · 4029 too many new addresses
 * from this network (ADR-073, spec §15.1 #2).
 */

export const PROTOCOLS = [2, 3] as const;
export const CLOSE_TOO_MANY_NEW = 4029;
export const MAX_ADDRESSES_PER_LOGIN = 32;
export const MAX_REF_LENGTH = 128;
export const DEFAULT_MAILBOX_TTL_SEC = 7 * 24 * 3600;
export const DEFAULT_MAILBOX_MAX_MESSAGES = 2000;
export const DEFAULT_MAILBOX_MAX_BYTES = 200 * 1024 * 1024;
export const DEFAULT_NEW_ADDRESSES_PER_IP_PER_HOUR = 100;
/** `send` frames one client IP may make per minute, over all its connections (ip-limit.ts). */
export const DEFAULT_SEND_RATE_PER_IP_PER_MINUTE = 600;
const HOUR_MS = 3600_000;

export interface V3Settings {
  mailboxTtlMs: number;
  mailboxMaxMessages: number;
  mailboxMaxBytes: number;
  /** 0 = no send bucket (the default, spec §8.4). */
  ratePerMinute: number;
  /** `send` frames per client IP per minute, shared by every connection from that IP; 0 = off. */
  ratePerIpPerMinute: number;
  newAddressesPerIpPerHour: number;
}

const int = (v: string | undefined, d: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function v3SettingsFromEnv(env: {
  MAILBOX_TTL_SEC?: string;
  MAILBOX_MAX_MESSAGES?: string;
  MAILBOX_MAX_BYTES?: string;
  V3_RATE_PER_MINUTE?: string;
  V3_RATE_PER_IP_PER_MINUTE?: string;
  NEW_ADDRESSES_PER_IP_PER_HOUR?: string;
}): V3Settings {
  return {
    mailboxTtlMs: Math.max(1, int(env.MAILBOX_TTL_SEC, DEFAULT_MAILBOX_TTL_SEC)) * 1000,
    mailboxMaxMessages: int(env.MAILBOX_MAX_MESSAGES, DEFAULT_MAILBOX_MAX_MESSAGES),
    mailboxMaxBytes: int(env.MAILBOX_MAX_BYTES, DEFAULT_MAILBOX_MAX_BYTES),
    ratePerMinute: int(env.V3_RATE_PER_MINUTE, 0),
    ratePerIpPerMinute: int(env.V3_RATE_PER_IP_PER_MINUTE, DEFAULT_SEND_RATE_PER_IP_PER_MINUTE),
    newAddressesPerIpPerHour: int(env.NEW_ADDRESSES_PER_IP_PER_HOUR, DEFAULT_NEW_ADDRESSES_PER_IP_PER_HOUR),
  };
}

export const MAX_CAPS = 8;
const CAP_SHAPE = /^[a-z0-9]{1,16}$/;

/**
 * ADR-081: the capability list of one hello entry (or of a stored record) — the well-formed
 * ones, each once, at most 8. Whatever else is in there (not an array, other types, other
 * characters, too long, too many) is dropped: a newer or a sloppy client still logs in.
 */
export function normalizeCaps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c !== 'string' || !CAP_SHAPE.test(c) || out.includes(c)) continue;
    out.push(c);
    if (out.length >= MAX_CAPS) break;
  }
  return out;
}

export interface HelloEntry {
  address: string;
  key: unknown;
  sig: unknown;
  prekey?: unknown;
  /** ADR-081: always an array ([] = the client said nothing). */
  caps: string[];
}

/** The address list of a hello: 1..32 distinct addresses, the first = the URL's. null = malformed. */
export function helloEntries(msg: Record<string, unknown>, primary: string): HelloEntry[] | null {
  if (msg['type'] !== 'hello' || msg['v'] !== 3 || !Array.isArray(msg['addresses'])) return null;
  const raw = msg['addresses'] as unknown[];
  if (raw.length === 0 || raw.length > MAX_ADDRESSES_PER_LOGIN) return null;
  const out: HelloEntry[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    const x = e as Record<string, unknown> | null;
    const address = normalizeAddress(x?.['address']);
    if (!x || !address || seen.has(address)) return null;
    seen.add(address);
    out.push({ address, key: x['key'], sig: x['sig'], ...(x['prekey'] !== undefined ? { prekey: x['prekey'] } : {}), caps: normalizeCaps(x['caps']) });
  }
  return out[0]!.address === primary ? out : null;
}

export type SendCheck = { ok: true; to: string; from: string; blob: string; ref?: string } | { ok: false; error: string };

/** Validate a client's `send` (also `signal`, with its own cap) from a connection logged in as `addresses`. */
export function checkV3Send(msg: Record<string, unknown>, addresses: readonly string[], maxBytes: number, limiter?: RateLimiter | null, now = Date.now()): SendCheck {
  const to = normalizeAddress(msg['to']);
  if (!to) return { ok: false, error: 'bad recipient address' };
  const from = msg['from'] === undefined ? addresses[0] : normalizeAddress(msg['from']);
  if (!from || !addresses.includes(from)) return { ok: false, error: 'not logged in as that sender address' };
  const blob = msg['blob'];
  if (typeof blob !== 'string' || !blob) return { ok: false, error: 'empty blob' };
  if (new TextEncoder().encode(blob).length > maxBytes) return { ok: false, error: `envelope too large (max ${maxBytes} bytes)` };
  const ref = msg['ref'];
  if (ref !== undefined && (typeof ref !== 'string' || ref.length > MAX_REF_LENGTH)) return { ok: false, error: 'bad ref' };
  if (limiter && !limiter.take(now)) return { ok: false, error: `rate limited (max ${limiter.rate}/min)` };
  return { ok: true, to, from, blob, ...(typeof ref === 'string' && ref ? { ref } : {}) };
}

export const deliverFrame = (d: { id: string; to: string; from: string; blob: string; ts: number; ref?: string | null; stored?: boolean }): string =>
  JSON.stringify({ type: 'deliver', id: d.id, to: d.to, from: d.from, blob: d.blob, ts: d.ts, ...(d.ref ? { ref: d.ref } : {}), ...(d.stored ? { stored: true } : {}) });

export const undeliverableFrame = (n: { from: string; to: string; ref: string; ts: number }): string =>
  JSON.stringify({ type: 'undeliverable', from: n.from, to: n.to, ref: n.ref, ts: n.ts });

/** Minimal storage for the per-IP new-address counter (the InviteBook's). */
export interface CounterStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string }): Promise<Map<string, T>>;
}

interface Counter {
  n: number;
  resetAt: number;
}
const IP3 = 'ip3:';

/**
 * What stands for a client IP wherever the relay keys something by it: a hash, never the IP.
 * `domain` keeps the uses apart (the same IP gives unrelated values for different purposes).
 */
export async function ipHash(ip: string | null | undefined, domain = 'morse-new-address-ip'): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}\n${ip || 'unknown'}`)));
  return [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Spec §15.1 #2 (owner 2026-11-14): new addresses first published from one IP, per hour
 * (fixed window from the first). Charges `n` when within the limit; never consulted for
 * sending. 0 = no limit.
 */
export async function chargeNewAddresses(store: CounterStore, ip: string | null | undefined, n: number, perHour: number, now = Date.now(), prefix: string = IP3): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  if (n <= 0 || perHour <= 0) return { ok: true };
  const key = prefix + (await ipHash(ip));
  const c = await store.get<Counter>(key);
  const live = c && c.resetAt > now ? c : null;
  if ((live?.n ?? 0) + n > perHour) return { ok: false, retryAfterSec: Math.ceil(((live?.resetAt ?? now + HOUR_MS) - now) / 1000) };
  await store.put(key, { n: (live?.n ?? 0) + n, resetAt: live?.resetAt ?? now + HOUR_MS } satisfies Counter);
  // forget finished windows now and then
  if (Math.random() < 0.05) for (const [k, v] of await store.list<Counter>({ prefix })) if (v.resetAt <= now) await store.delete(k);
  return { ok: true };
}

/** ADR-077: alias lookups over HTTP (GET /v3/alias/…) one IP may make per hour — the same fixed-window counter. */
export const DEFAULT_ALIAS_LOOKUPS_PER_IP_PER_HOUR = 600;
/** ADR-077: alias queries one v3 connection may make per minute (token bucket, like signals). */
export const ALIAS_RATE_PER_MINUTE = 240;
const IPA = 'ipa:';
export const chargeAliasLookups = (store: CounterStore, ip: string | null | undefined, perHour: number, now = Date.now()) => chargeNewAddresses(store, ip, 1, perHour, now, IPA);

export { RateLimiter };
