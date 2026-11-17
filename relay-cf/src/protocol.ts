/**
 * Morse relay wire protocol v2 (JSON over WebSocket) — shared by relay-cf/ (this
 * Worker) and relay/ (the Node self-host build). The relay FORWARDS; it never
 * stores a message. Delivery guarantees live in the sender's own outbox.
 *
 *   relay  → {type:"challenge", nonce}
 *   client → {type:"hello", cert, sig, bundle, passive?} → {type:"welcome", id, handle, nickname?, limits} | close 4001/4003
 *            (passive: a lookup-only connection, e.g. `anyd pair add <handle>`; never "online")
 *   client → {type:"send", rid, to, blob}            → {type:"sent", rid}        recipient had a live socket, blob pushed
 *                                                    → {type:"offline", rid}     no live socket — keep it in your outbox
 *                                                    → {type:"error", rid, error}
 *   client → {type:"bundle", rid, id}                → {type:"bundle", rid, bundle|null}
 *   client → {type:"handle", rid, handle}            → {type:"handle", rid, handle, nickname?, devices:[{id, name, bundle|null}]}
 *            (directory: a person's handle → their allowlisted devices — for pairing / pair-back)
 *   client → {type:"agent", rid, handle, agent?}     → {type:"agent", rid, handle, nickname?, agent|null, device:{id, name, bundle|null}|null}
 *            (agent directory, ADR-033: morse.im/<handle>/<agent> → the ONE device hosting it;
 *            no agent = the person's default agent. device null = no such agent)
 *   client → {type:"signal", rid, to, blob}          → {type:"signaled", rid} | {type:"offline", rid} | {type:"error", rid, error}
 *            (ADR-069: WebRTC signaling — blob is an end-to-end sealed offer / answer / candidate;
 *            forwarded between logged-in, non-passive devices, never stored, ≤ 64 KiB, own rate;
 *            see signal.ts. An older client ignores the pushed frame below)
 *   relay  → {type:"signal", from, fromHandle?, blob, ts}
 *   relay  → {type:"nickname", handle, nickname|null}   (ADR-036: another computer of your handle changed it)
 *   relay  → {type:"deliver", id, from, fromHandle?, blob, ts}
 *            (one push per forwarded envelope; nothing to ack. fromHandle = the sender's
 *            handle per the allowlist — lets an unpaired recipient pair back, see ADR-032)
 *
 *   HTTP POST /v1/join {code, cert, ts, sig, name?, agent?}  → 200 {id, handle, name, already?, agent?, agentError?}
 *            redeem an invite: sig = Ed25519 over JOIN_CONTEXT\n<ts>\n<code>[\n<agent>] with the
 *            device key; the relay adds the device to the invite's handle (ADR-032) and
 *            registers <agent> on it (ADR-033; 409 agent_taken — invite not spent — if
 *            another device of the handle already hosts that name)
 *   HTTP POST /v1/join {handle, code:<pairing code>, cert, ts, sig, name?, agent?}  (ADR-036)
 *            join an EXISTING handle with a one-time pairing code from one of its devices
 *            (same signature as an invite join, over the normalised pairing code)
 *   HTTP POST /v1/register {cert, ts, sig, name?, agent?}  → 200 {id, handle, name, agent?, already?}
 *            open registration (ADR-036): the relay assigns a new random handle (8 chars of
 *            23456789abcdefghjkmnpqrstvwxyz) to this device; sig over REGISTER_CONTEXT\n<ts>[\n<agent>].
 *            429 rate_limited (new addresses per IP per hour), 403 registration_closed
 *   HTTP POST /v1/pair-code {cert, ts, sig}  → 200 {handle, code, expiresAt}   sig over PAIR_CONTEXT\n<ts>;
 *            a device of a handle gets a one-time, 10-minute code for adding another computer
 *   HTTP POST /v1/profile {nickname, cert, ts, sig}  → 200 {handle, nickname}   sig over
 *            PROFILE_CONTEXT\n<ts>\n<nickname>; display only ('' clears it)
 *   HTTP POST /v1/agents {op, agent?, to?, cert, ts, sig}  → 200 {…} | 400/401/403/404/409
 *            op = add | remove | default | rename | list; sig = Ed25519 over
 *            AGENT_CONTEXT\n<ts>\n<op>\n<agent>\n<to> (empty strings when absent). The
 *            handle is the signing device's own (from the allowlist) — a device can only
 *            manage its own person's agents, and only add / remove / rename the ones it hosts.
 *
 * Close codes: 4000 replaced by a newer connection of the same device · 4001 login
 * failed/timed out · 4002 bad frame · 4003 device not on the allowlist.
 */

export const LOGIN_CONTEXT = 'morse-relay-login-v1';
export const JOIN_CONTEXT = 'morse-relay-join-v1';
export const AGENT_CONTEXT = 'morse-relay-agent-v1';
/** Open registration (ADR-036): POST /v1/register — the relay hands out a random handle. */
export const REGISTER_CONTEXT = 'morse-relay-register-v1';
/** A member device asks for a one-time pairing code for its handle (POST /v1/pair-code). */
export const PAIR_CONTEXT = 'morse-relay-pair-v1';
/** A member device sets its handle's display nickname (POST /v1/profile). */
export const PROFILE_CONTEXT = 'morse-relay-profile-v1';
export const AGENT_OPS = ['add', 'remove', 'default', 'rename', 'list'] as const;
export type AgentOp = (typeof AGENT_OPS)[number];
/** Names that mean something else on the client (the person's inbox). */
export const RESERVED_AGENT_NAMES = ['user', 'inbox'];
/**
 * Handles nobody gets — not by registration, not by an admin invite by mistake.
 * Extend with the RESERVED_HANDLES var (comma separated) in wrangler.toml (see register.ts).
 */
export const RESERVED_HANDLES: readonly string[] = [
  'admin', 'administrator', 'root', 'morse', 'support', 'help', 'system', 'relay', 'api', 'www',
  'mail', 'security', 'official', 'team', 'user', 'inbox', 'null', 'undefined',
  'abuse', 'postmaster', 'hostmaster', 'webmaster', 'noreply', 'no-reply', 'staff', 'moderator',
  'anonymous', 'everyone', 'all', 'install', 'download', 'docs', 'status', 'login', 'signup', 'register', 'join',
];

/** How far a join request's timestamp may be from the relay's clock. */
export const JOIN_MAX_SKEW_MS = 10 * 60_000;
export const BUNDLE_CONTEXT = 'morse-enc-key-v1';
export const HELLO_TIMEOUT_MS = 10_000;

export const CLOSE_REPLACED = 4000;
export const CLOSE_LOGIN_FAILED = 4001;
export const CLOSE_BAD_FRAME = 4002;
export const CLOSE_NOT_ALLOWED = 4003;

export interface KeyBundle {
  id: string;
  cert: string; // base64 DER
  encPub: string; // base64 SPKI DER (X25519)
  sig: string; // base64 Ed25519 over BUNDLE_CONTEXT\nid\nencPub
}

export interface Limits {
  maxBlobBytes: number;
  ratePerMinute: number;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ID_LENGTH = 52;

/** Accept any case/spacing a human (or URL) gives; null when it is not a device ID. */
export function normalizeId(input: string): string | null {
  const bare = input.toUpperCase().replace(/[\s-]/g, '');
  if (bare.length !== ID_LENGTH || ![...bare].every((c) => BASE32.includes(c))) return null;
  return bare.match(/.{1,7}/g)?.join('-') ?? bare;
}

/** A person's handle (morse.im/<handle>): lowercase letters, digits, '-' / '_', 2–32 chars. */
export function normalizeHandle(input: string): string | null {
  const h = input.trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(h) ? h : null;
}

/**
 * An agent name (morse.im/<handle>/<agent>): lowercase letters, digits and '-',
 * 1–32 chars, no leading / trailing '-'. Unique within one handle.
 */
export function normalizeAgent(input: string): string | null {
  const a = input.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(a)) return null;
  return RESERVED_AGENT_NAMES.includes(a) ? null : a;
}

/** The exact bytes a device signs to manage agents (POST /v1/agents). */
export function agentOpMessage(ts: number, op: string, agent = '', to = ''): string {
  return `${AGENT_CONTEXT}\n${ts}\n${op}\n${agent}\n${to}`;
}

/** The exact bytes a device signs to register (POST /v1/register); the agent is optional. */
export function registerMessage(ts: number, agent?: string): string {
  return `${REGISTER_CONTEXT}\n${ts}${agent ? `\n${agent}` : ''}`;
}

/** The exact bytes a member device signs to get a pairing code (POST /v1/pair-code). */
export function pairCodeMessage(ts: number): string {
  return `${PAIR_CONTEXT}\n${ts}`;
}

/** The exact bytes a member device signs to set its handle's nickname (POST /v1/profile). */
export function profileMessage(ts: number, nickname: string): string {
  return `${PROFILE_CONTEXT}\n${ts}\n${nickname}`;
}

/**
 * A display nickname (ADR-036): any text, trimmed, inner whitespace collapsed,
 * control and bidi-override characters removed, at most 32 characters. Not unique,
 * never used for addressing. '' = no nickname. null = not a string.
 */
export function normalizeNickname(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const clean = input
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].slice(0, 32).join('').trim();
}

/** The exact bytes a device signs to join (POST /v1/join); the agent is optional. */
export function joinMessage(ts: number, code: string, agent?: string): string {
  return `${JOIN_CONTEXT}\n${ts}\n${code}${agent ? `\n${agent}` : ''}`;
}

export function parseFrame(raw: string | ArrayBuffer): Record<string, unknown> | null {
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function isKeyBundleShape(b: unknown): b is KeyBundle {
  const x = b as Partial<KeyBundle> | null;
  return Boolean(x && typeof x.id === 'string' && typeof x.cert === 'string' && typeof x.encPub === 'string' && typeof x.sig === 'string');
}

/** Token bucket: `rate` sends per minute, burst = rate. */
export class RateLimiter {
  private tokens: number;
  private at: number;
  constructor(readonly rate: number, now = Date.now()) {
    this.tokens = rate;
    this.at = now;
  }
  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.at) / 60_000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
