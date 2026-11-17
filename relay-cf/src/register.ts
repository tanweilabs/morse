import { allowEntry, devicesOfHandle, putDevice, removeDevice, type AllowKV } from './allowlist.js';
import { sha256Hex, verifyJoin, verifyPairCode, verifyRegister } from './crypto.js';
import type { AgentRegistrar, InviteStorage, Outcome } from './invites.js';
import { registerJoinAgent, redeemInvite } from './invites.js';
import { JOIN_MAX_SKEW_MS, RESERVED_HANDLES, normalizeAgent, normalizeHandle } from './protocol.js';

export { RESERVED_HANDLES };

/**
 * Open registration and adding your own computers (ADR-036). No accounts: a device's
 * private key is its identity, and a handle is "whatever devices the relay lists
 * under it".
 *
 *  - `POST /v1/register` — a device that belongs to nobody gets a NEW, RANDOM handle
 *    (8 characters of 23456789abcdefghjkmnpqrstvwxyz — no 0/1/i/l/o/u, ≈ 6.6·10^11
 *    values: not guessable, easy to read out) and becomes its first device. Readable
 *    handles (mei, kai) are NOT self-service: only an admin invite gives one.
 *  - `POST /v1/pair-code` — a device already under a handle gets a one-time pairing
 *    code (10 characters, shown as `abcde-fghjk`, valid 10 minutes, one live code per
 *    handle, burned after 5 wrong guesses). Only its SHA-256 is stored.
 *  - `POST /v1/join {handle, code}` — a new computer joins that handle with the code.
 *
 * Storage: the InviteBook Durable Object (the single, strongly consistent "join
 * book" — every write that decides who owns a handle runs there, serialised by
 * blockConcurrencyWhile, so two registrations can never get the same handle and a
 * pairing code is used once). Keys (next to the invites' `inv:`):
 *
 *   handle:<handle>   → {handle, createdAt, via, releasedAt?}   a handle handed out here
 *   pair:<handle>     → {hash, expiresAt, by, attempts}          the live pairing code
 *   ip:<sha256(ip)>   → {n, resetAt}                              new handles per IP per hour
 *   used:<sha256(sig)> → expiry                                    pairing-code requests already served
 *
 * Handles that existed before (in Workers KV only, e.g. mei) are still "in use":
 * the random draw also checks the KV `@handle` index. Runtime-agnostic (WebCrypto
 * only); storage and KV are parameters so the tests run it in Node.
 */

/** Characters of random handles and pairing codes: no 0 / 1 / i / l / o / u. */
export const ID_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export const RANDOM_HANDLE_LENGTH = 8;
export const PAIR_CODE_LENGTH = 10;
export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const PAIR_MAX_ATTEMPTS = 5;
export const DEFAULT_REGISTER_PER_IP_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

export interface RegisterSettings {
  /** OPEN_REGISTRATION (default on; "0" / "false" / "off" closes POST /v1/register). */
  open: boolean;
  /** REGISTER_PER_IP_PER_HOUR: new handles one IP may get per hour. */
  perIpPerHour: number;
  /** RESERVED_HANDLES plus the built-in list. */
  reserved: string[];
}

export function registerSettingsFromEnv(env: { OPEN_REGISTRATION?: string; REGISTER_PER_IP_PER_HOUR?: string; RESERVED_HANDLES?: string }): RegisterSettings {
  const open = !/^(0|false|off|no|closed)$/i.test((env.OPEN_REGISTRATION ?? '').trim());
  const perIp = Number.parseInt(env.REGISTER_PER_IP_PER_HOUR ?? '', 10);
  const extra = (env.RESERVED_HANDLES ?? '')
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return { open, perIpPerHour: Number.isFinite(perIp) && perIp >= 0 ? perIp : DEFAULT_REGISTER_PER_IP_PER_HOUR, reserved: [...new Set([...RESERVED_HANDLES, ...extra])] };
}

export const isReservedHandle = (handle: string, reserved: readonly string[] = RESERVED_HANDLES): boolean => reserved.includes(handle.toLowerCase());

export type RandomBytes = (n: number) => Uint8Array;
const systemRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Uniform over ID_ALPHABET (rejection sampling: 240 = 8 × 30, bytes ≥ 240 are skipped). */
export function randomId(length: number, rand: RandomBytes = systemRandom): string {
  let out = '';
  while (out.length < length) {
    for (const b of rand(length * 2)) {
      if (b < 240 && out.length < length) out += ID_ALPHABET[b % ID_ALPHABET.length];
    }
  }
  return out;
}

export const isRandomHandle = (h: string): boolean => h.length === RANDOM_HANDLE_LENGTH && [...h].every((c) => ID_ALPHABET.includes(c));

/** Accept what a human types: any case, spaces or dashes. null = not a pairing code. */
export function normalizePairCode(input: string): string | null {
  const c = input.trim().toLowerCase().replace(/[\s-]/g, '');
  return c.length === PAIR_CODE_LENGTH && [...c].every((ch) => ID_ALPHABET.includes(ch)) ? c : null;
}

export const formatPairCode = (c: string): string => `${c.slice(0, 5)}-${c.slice(5)}`;

export interface HandleClaim {
  handle: string;
  createdAt: number;
  /** "register" · "invite:<id>" */
  via: string;
  /** Set when an admin released the handle; a released random handle is never handed out again. */
  releasedAt?: number;
}
interface PairRecord {
  hash: string;
  expiresAt: number;
  /** The device that asked for the code. */
  by: string;
  attempts: number;
}
interface IpCounter {
  n: number;
  resetAt: number;
}
const CLAIM = 'handle:';
const PAIR = 'pair:';
const IP = 'ip:';
const IP_PRUNED = 'ip-pruned-at';
const USED = 'used:';

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Outcome => ({ status, body: { error, code, ...extra } });
const cleanName = (n: unknown): string => (typeof n === 'string' ? n.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : '');

/** Is this handle taken (or not available) — handed out here, already in the KV directory, or reserved? */
export async function handleInUse(store: InviteStorage, kv: AllowKV, handle: string, reserved: readonly string[] = RESERVED_HANDLES): Promise<boolean> {
  if (isReservedHandle(handle, reserved)) return true;
  if (await store.get<HandleClaim>(CLAIM + handle)) return true;
  return (await devicesOfHandle(kv, handle)).length > 0;
}

/** Record that a handle now exists (an invite created it). A released claim is replaced. */
export async function claimHandle(store: InviteStorage, handle: string, via: string, now = Date.now()): Promise<void> {
  const prev = await store.get<HandleClaim>(CLAIM + handle);
  if (!prev || prev.releasedAt) await store.put(CLAIM + handle, { handle, createdAt: now, via } satisfies HandleClaim);
}

export async function handleClaim(store: InviteStorage, handle: string): Promise<HandleClaim | null> {
  return (await store.get<HandleClaim>(CLAIM + handle)) ?? null;
}

const ipKey = async (ip: string | null | undefined) => `${IP}${(await sha256Hex(`morse-register-ip\n${ip || 'unknown'}`)).slice(0, 32)}`;

/** Forget per-IP counters whose hour is over (at most once an hour). */
async function pruneIpCounters(store: InviteStorage, now: number): Promise<void> {
  const last = (await store.get<number>(IP_PRUNED)) ?? 0;
  if (now - last < HOUR_MS) return;
  for (const [key, c] of await store.list<IpCounter>({ prefix: IP })) if (c.resetAt <= now) await store.delete(key);
  await store.put(IP_PRUNED, now);
}

export interface RegisterOptions {
  now?: number;
  /** CF-Connecting-IP of the request (null in tests / when absent: one shared bucket). */
  ip?: string | null;
  settings?: RegisterSettings;
  agents?: AgentRegistrar;
  rand?: RandomBytes;
}

/**
 * Open registration: give this device a fresh random handle. Run serialised (the
 * InviteBook does). 400 bad shape / clock · 401 bad signature · 403 closed ·
 * 429 too many from this IP · 200 {already:true} when the device already has a
 * handle (one device, one handle — nothing new is created, the IP is not charged).
 */
export async function registerDevice(store: InviteStorage, kv: AllowKV, req: unknown, opts: RegisterOptions = {}): Promise<Outcome> {
  const now = opts.now ?? Date.now();
  const settings = opts.settings ?? registerSettingsFromEnv({});
  if (!settings.open) return fail(403, 'registration_closed', 'this relay does not hand out new addresses right now — ask its admin for an invite code');
  const r = (req ?? {}) as Record<string, unknown>;
  if (typeof r['cert'] !== 'string' || typeof r['sig'] !== 'string' || typeof r['ts'] !== 'number') return fail(400, 'bad_request', 'expected {cert, ts, sig, name?, agent?}');
  const agent = r['agent'] === undefined || r['agent'] === '' ? null : typeof r['agent'] === 'string' ? normalizeAgent(r['agent']) : null;
  if (r['agent'] !== undefined && r['agent'] !== '' && !agent) return fail(400, 'bad_agent', `"${String(r['agent'])}" is not a valid agent name (1–32 of a-z 0-9 -)`);
  if (Math.abs(now - r['ts']) > JOIN_MAX_SKEW_MS) return fail(400, 'clock_skew', 'this computer’s clock is more than 10 minutes off — fix the time and retry');
  const id = await verifyRegister(r['cert'], r['ts'], r['sig'], agent ?? undefined);
  if (!id) return fail(401, 'bad_signature', 'device signature invalid');

  const existing = await allowEntry(kv, id);
  if (existing?.handle) {
    return { status: 200, body: { id, handle: existing.handle, name: existing.name ?? '', already: true, ...(await registerJoinAgent(opts.agents, existing.handle, agent, id)) } };
  }

  const key = await ipKey(opts.ip);
  const counter = await store.get<IpCounter>(key);
  const live = counter && counter.resetAt > now ? counter : null;
  if (live && live.n >= settings.perIpPerHour) {
    return fail(429, 'rate_limited', `too many new Morse addresses from this network in the last hour (max ${settings.perIpPerHour}) — try again later`, {
      retryAfterSec: Math.ceil((live.resetAt - now) / 1000),
    });
  }

  let handle: string | null = null;
  for (let i = 0; i < 16 && !handle; i++) {
    const h = randomId(RANDOM_HANDLE_LENGTH, opts.rand);
    if (!(await handleInUse(store, kv, h, settings.reserved))) handle = h;
  }
  if (!handle) return fail(503, 'no_handle', 'could not find a free address — retry');

  const name = cleanName(r['name']);
  await store.put(CLAIM + handle, { handle, createdAt: now, via: 'register' } satisfies HandleClaim);
  try {
    await putDevice(kv, id, { handle, name, addedAt: new Date(now).toISOString(), via: 'register' });
  } catch (e) {
    await store.delete(CLAIM + handle);
    return fail(503, 'allowlist_unavailable', `could not write the allowlist (${e instanceof Error ? e.message : String(e)}) — retry`);
  }
  await store.put(key, live ? { n: live.n + 1, resetAt: live.resetAt } : ({ n: 1, resetAt: now + HOUR_MS } satisfies IpCounter));
  await pruneIpCounters(store, now);
  return { status: 200, body: { id, handle, name, ...(await registerJoinAgent(opts.agents, handle, agent, id)) } };
}

/**
 * A device of a handle asks for a pairing code to add another computer. One live
 * code per handle: a new one replaces the previous. 403 when the device has no handle.
 */
export async function createPairCode(store: InviteStorage, kv: AllowKV, req: unknown, opts: { now?: number; rand?: RandomBytes } = {}): Promise<Outcome> {
  const now = opts.now ?? Date.now();
  const r = (req ?? {}) as Record<string, unknown>;
  if (typeof r['cert'] !== 'string' || typeof r['sig'] !== 'string' || typeof r['ts'] !== 'number') return fail(400, 'bad_request', 'expected {cert, ts, sig}');
  if (Math.abs(now - r['ts']) > JOIN_MAX_SKEW_MS) return fail(400, 'clock_skew', 'this computer’s clock is more than 10 minutes off — fix the time and retry');
  const id = await verifyPairCode(r['cert'], r['ts'], r['sig']);
  if (!id) return fail(401, 'bad_signature', 'device signature invalid');
  // a signed request is good for one code: a replay (within the ±10 min window) gets nothing
  const usedKey = `${USED}${(await sha256Hex(r['sig'])).slice(0, 32)}`;
  if (await store.get<number>(usedKey)) return fail(409, 'replayed', 'this request was already used — run morse agent add again');
  for (const [k, until] of await store.list<number>({ prefix: USED })) if (until <= now) await store.delete(k);
  await store.put(usedKey, now + 2 * JOIN_MAX_SKEW_MS);
  const handle = (await allowEntry(kv, id))?.handle;
  if (!handle) return fail(403, 'not_member', 'this computer has not joined Morse yet (morse join)');
  const code = randomId(PAIR_CODE_LENGTH, opts.rand);
  const expiresAt = now + PAIR_CODE_TTL_MS;
  await store.put(PAIR + handle, { hash: await sha256Hex(code), expiresAt, by: id, attempts: 0 } satisfies PairRecord);
  return { status: 200, body: { handle, code: formatPairCode(code), expiresAt } };
}

const pairInvalid = (handle: string) =>
  fail(404, 'pair_invalid', `pairing code is wrong, used or expired — on a computer already in morse.im/${handle}, run \`morse agent add\` for a new one`);

/**
 * Join an existing handle with a pairing code. Serialised like an invite. The code
 * is used only when the device is actually added (already a member, or its agent
 * name taken → the code stays valid). A device that belongs to another handle → 409.
 */
export async function redeemPairCode(store: InviteStorage, kv: AllowKV, req: unknown, now = Date.now(), agents?: AgentRegistrar): Promise<Outcome> {
  const r = (req ?? {}) as Record<string, unknown>;
  if (typeof r['handle'] !== 'string' || typeof r['code'] !== 'string' || typeof r['cert'] !== 'string' || typeof r['sig'] !== 'string' || typeof r['ts'] !== 'number') {
    return fail(400, 'bad_request', 'expected {handle, code, cert, ts, sig, name?, agent?}');
  }
  const handle = normalizeHandle(r['handle']);
  if (!handle) return fail(400, 'bad_handle', `"${r['handle']}" is not a Morse address`);
  const agent = r['agent'] === undefined || r['agent'] === '' ? null : typeof r['agent'] === 'string' ? normalizeAgent(r['agent']) : null;
  if (r['agent'] !== undefined && r['agent'] !== '' && !agent) return fail(400, 'bad_agent', `"${String(r['agent'])}" is not a valid agent name (1–32 of a-z 0-9 -)`);
  const code = normalizePairCode(r['code']);
  if (!code) return pairInvalid(handle);
  if (Math.abs(now - r['ts']) > JOIN_MAX_SKEW_MS) return fail(400, 'clock_skew', 'this computer’s clock is more than 10 minutes off — fix the time and retry');
  const id = await verifyJoin(r['cert'], r['ts'], code, r['sig'], agent ?? undefined);
  if (!id) return fail(401, 'bad_signature', 'device signature invalid');

  const rec = await store.get<PairRecord>(PAIR + handle);
  if (!rec || rec.expiresAt <= now) {
    if (rec) await store.delete(PAIR + handle);
    return pairInvalid(handle);
  }
  if ((await sha256Hex(code)) !== rec.hash) {
    // a wrong guess: after PAIR_MAX_ATTEMPTS the code is burned
    if (rec.attempts + 1 >= PAIR_MAX_ATTEMPTS) await store.delete(PAIR + handle);
    else await store.put(PAIR + handle, { ...rec, attempts: rec.attempts + 1 });
    return pairInvalid(handle);
  }
  const existing = await allowEntry(kv, id);
  if (existing?.handle === handle) {
    return { status: 200, body: { id, handle, name: existing.name ?? '', already: true, ...(await registerJoinAgent(agents, handle, agent, id)) } };
  }
  if (existing?.handle) {
    return fail(409, 'device_taken', `this computer already is morse.im/${existing.handle} — one computer belongs to one address (ask the relay admin to move it)`);
  }
  if (agent && agents) {
    const check = await agents.register(handle, agent, id, true);
    if (check.status !== 200) return check;
  }
  const name = cleanName(r['name']);
  await store.delete(PAIR + handle);
  try {
    await putDevice(kv, id, { handle, name, addedAt: new Date(now).toISOString(), via: `pair:${rec.by.slice(0, 7)}` });
  } catch (e) {
    await store.put(PAIR + handle, rec);
    return fail(503, 'allowlist_unavailable', `could not write the allowlist (${e instanceof Error ? e.message : String(e)}) — retry`);
  }
  return { status: 200, body: { id, handle, name, ...(await registerJoinAgent(agents, handle, agent, id)) } };
}

/** POST /v1/join: `handle` present = a pairing code for that handle, otherwise an admin invite (ADR-032). */
export async function redeemJoin(store: InviteStorage, kv: AllowKV, req: unknown, now = Date.now(), agents?: AgentRegistrar): Promise<Outcome> {
  const r = (req ?? {}) as Record<string, unknown>;
  if (r['handle'] !== undefined) return redeemPairCode(store, kv, req, now, agents);
  const out = await redeemInvite(store, kv, req, now, agents);
  // an invite may create a handle: record it, so the random draw never hands it out
  if (out.status === 200 && !out.body['already'] && typeof out.body['handle'] === 'string') await claimHandle(store, out.body['handle'], 'invite', now);
  return out;
}

/**
 * Admin: release a handle (all of its devices lost, ADR-036). Its devices leave the
 * allowlist, a pending pairing code is dropped, and the claim is kept as a tombstone
 * so a random handle is never handed to someone else. The caller clears the
 * handle's AgentBook (agents, default, nickname) and disconnects the devices.
 */
export async function releaseHandle(store: InviteStorage, kv: AllowKV, handle: string, now = Date.now()): Promise<{ handle: string; devices: string[] }> {
  const devices = await devicesOfHandle(kv, handle);
  for (const id of devices) {
    if ((await allowEntry(kv, id))?.handle === handle) await removeDevice(kv, id);
  }
  await kv.delete(`@${handle}`);
  await store.delete(PAIR + handle);
  const prev = await store.get<HandleClaim>(CLAIM + handle);
  await store.put(CLAIM + handle, { handle, createdAt: prev?.createdAt ?? now, via: prev?.via ?? 'kv', releasedAt: now } satisfies HandleClaim);
  return { handle, devices };
}
