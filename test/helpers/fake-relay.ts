import { createHash, createPublicKey, randomBytes, randomInt, randomUUID, verify, X509Certificate } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * An in-memory fake of the Morse relay for client tests — never a real server.
 *
 * It speaks the relay wire protocol the client uses (see src/cluster/relay-client.ts
 * and src/cluster/join.ts) with the same answers, error codes and close codes, but
 * keeps everything in Maps and simplifies whatever the client cannot observe:
 *
 *   WebSocket   challenge → hello → welcome {id, handle, nickname?, limits}
 *               send → deliver / offline / sent / error · bundle · handle · agent
 *               signal → signal push / signaled / offline / error (ADR-069; off = an old relay)
 *               v3 (ADR-073, `v3: true`): /v3/ws/<address> — multi-address hello, send →
 *               sent / stored (offline mailbox) / offline (store:false) / error, address lookup
 *               (with the address's `caps`, ADR-081 — `caps: false` = a relay from before them),
 *               prekey, ack, signal by address, deliver {stored}, undeliverable on expiry;
 *               the v2 welcome and /healthz then announce protocols [2, 3]
 *               nickname push when another computer of the handle changes it (the
 *               nickname field appears only for handles that set one through /v1/profile,
 *               so a test can also state it from the sender's side alone)
 *   HTTP        POST /v1/agents     signed agent-directory ops (add/remove/default/rename/list)
 *               POST /v1/register   open registration: a new random handle
 *               POST /v1/pair-code  a member device gets a one-time pairing code
 *               POST /v1/join       an invite code, or {handle, code} with a pairing code
 *               POST /v1/profile    the handle's display nickname
 *               /admin/invites      create / list / revoke (Bearer adminKey)
 *               GET  /healthz
 *
 * Signatures are checked (Ed25519 over the same context strings as the client signs),
 * so a client that signs the wrong bytes fails here too. Like the real relay, the fake
 * FORWARDS envelopes and never keeps one: `dump()` returns everything it holds so a
 * test can assert that no message text is in there.
 */

export interface AllowlistEntry {
  id: string;
  /** The person this device belongs to (morse.im/<handle>). */
  handle?: string;
  name?: string;
}

export interface FakeRelayConfig {
  port?: number;
  host?: string;
  allowlist?: Array<string | AllowlistEntry>;
  maxBlobBytes?: number;
  /** Sends per device per minute (token bucket, burst = the same number). */
  ratePerMinute?: number;
  /** Open registration (POST /v1/register). false = the endpoint is missing, like an old relay. */
  register?: boolean;
  /** ADR-069: forward `signal` frames (WebRTC signaling). false = an old relay ("unknown request"). */
  signal?: boolean;
  /** Bearer key for /admin/*; unset = no admin API. */
  adminKey?: string;
  /** ADR-073: speak protocol v3 too (AddressHub, offline mailbox). Default off = a relay before v3. */
  v3?: boolean;
  /** ADR-077: answer the v3 `alias` query (old v2 names → addresses, computed from this relay's own
   *  directory and the device certificates). Default off = a relay without the alias table. */
  aliases?: boolean;
  /** ADR-081: keep the `caps` of each address a hello carries and hand them back with the `address`
   *  answer (default). false = a relay deployed before caps: it stores none and its answer has no `caps`. */
  caps?: boolean;
  /** v3 offline mailbox lifetime (default 7 days). */
  mailboxTtlMs?: number;
  /** relay-cf's V3_RATE_PER_IP_PER_MINUTE: v3 `send` frames a minute, shared by EVERY v3 connection (to the
   *  fake they all come from one IP). Default: no limit. Refused with the relay's "rate limited (max N/min)". */
  v3RatePerIpPerMinute?: number;
  log?: (line: string) => void;
}

export interface InviteInfo {
  id: string;
  handle: string;
  uses: number;
  expiresAt: number;
  createdAt: number;
  note?: string;
}

export interface FakeRelay {
  port: number;
  /** ws://127.0.0.1:<port> */
  url: string;
  /** Devices with a live (non-passive) socket. */
  online(): string[];
  /** ADR-069: how many `signal` frames it forwarded. */
  signals(): number;
  /** (tests) how many frames it has received on any connection, v2 or v3 — a lookup, a send, an ack, a login: anything a client asked. */
  frames(): number;
  /** ADR-073: v3 addresses with a live connection. */
  onlineAddresses(): string[];
  /** ADR-073: envelopes waiting in an address's offline mailbox. */
  mailbox(address: string): Array<{ id: string; from: string; ref?: string; blob: string; ts: number }>;
  /** ADR-073: v3 sends it handled, by outcome. */
  v3Sends(): { sent: number; stored: number; offline: number };
  /** (ADR-091) every v3 send, in order: who sent what to whom (the sealed blob), and what became of it. */
  v3SentLog(): Array<{ from: string; to: string; blob: string; r: 'sent' | 'stored' | 'offline' }>;
  /** ADR-073: run the mailbox expiry now (tests), as if `now` were the time. */
  expireMailbox(now?: number): void;
  /** ADR-081 (tests): every v3 `send` it took, in order — who the relay saw as sender and recipient, the sealed
   *  envelope, and what became of it. (Only the fake keeps this; a test opens the envelopes with the recipient's keys.) */
  v3Log(): Array<{ from: string; to: string; blob: string; r: 'sent' | 'stored' | 'offline' }>;
  /** (tests) every v2 `send` it forwarded to a live device, in order — from which device to which. */
  v2Sends(): Array<{ from: string; to: string }>;
  /** ADR-081 (tests): overwrite what the relay answers for an address — a relay that lies or is out of date
   *  (`key`: another key; `caps`: other capabilities; `prekey: null`: none). Stays until the address logs in again. */
  tamper(address: string, patch: { key?: string; caps?: string[]; prekey?: null }): void;
  /** Everything the relay keeps, as JSON (key bundles, directory, invites…). */
  dump(): string;
  /** Put a device on the allowlist (what an admin or a join does). */
  allow(entry: AllowlistEntry): void;
  entry(id: string): AllowlistEntry | null;
  devicesOf(handle: string): string[];
  nickname(handle: string): string | null;
  /** Mint an admin invite directly (the code is only ever returned here). */
  createInvite(req: { handle: string; uses?: number; ttlSec?: number; note?: string }): InviteInfo & { code: string };
  close(): Promise<void>;
}

const LOGIN_CONTEXT = 'morse-relay-login-v1';
const AGENT_CONTEXT = 'morse-relay-agent-v1';
const JOIN_CONTEXT = 'morse-relay-join-v1';
const REGISTER_CONTEXT = 'morse-relay-register-v1';
const PAIR_CONTEXT = 'morse-relay-pair-v1';
const PROFILE_CONTEXT = 'morse-relay-profile-v1';
const BUNDLE_CONTEXT = 'morse-enc-key-v1';
const AGENT_OPS = ['add', 'remove', 'default', 'rename', 'list'];
const MAX_SKEW_MS = 10 * 60_000;
const HELLO_TIMEOUT_MS = 10_000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ID_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
const PAIR_CODE_TTL_MS = 10 * 60_000;
const PAIR_MAX_ATTEMPTS = 5;
const RESERVED_HANDLES = ['admin', 'administrator', 'root', 'morse', 'support', 'help', 'system', 'relay', 'api', 'www', 'mail', 'security', 'official', 'team', 'user', 'inbox', 'null', 'undefined'];

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const groupId = (bare: string): string => bare.match(/.{1,7}/g)?.join('-') ?? bare;
const deviceIdFromCert = (der: Buffer): string => groupId(base32(createHash('sha256').update(der).digest()));
const normalizeId = (input: string): string => groupId(input.toUpperCase().replace(/[\s-]/g, ''));
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function normalizeHandle(input: string): string | null {
  const h = input.trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(h) ? h : null;
}

function normalizeAgent(input: string): string | null {
  const a = input.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(a)) return null;
  return a === 'user' || a === 'inbox' ? null : a;
}

function normalizeNickname(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const clean = input
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].slice(0, 32).join('').trim();
}

const randomId = (length: number): string => Array.from({ length }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');
const normalizePairCode = (input: string): string | null => {
  const c = input.trim().toLowerCase().replace(/[\s-]/g, '');
  return c.length === 10 && [...c].every((ch) => ID_ALPHABET.includes(ch)) ? c : null;
};
const normalizeInviteCode = (input: string): string | null => {
  const c = input.trim().toLowerCase().replace(/[\s-]/g, '');
  return c.length === 32 && /^[a-z2-7]+$/.test(c) ? c : null;
};
const cleanName = (n: unknown): string => (typeof n === 'string' ? n.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : '');

/** Verify an Ed25519 signature by the certificate's key; the device ID on success, else null. */
function signedBy(certB64: unknown, message: string, sigB64: unknown): string | null {
  if (typeof certB64 !== 'string' || typeof sigB64 !== 'string') return null;
  try {
    const der = Buffer.from(certB64, 'base64');
    return verify(null, Buffer.from(message), new X509Certificate(der).publicKey, Buffer.from(sigB64, 'base64')) ? deviceIdFromCert(der) : null;
  } catch {
    return null;
  }
}

interface AgentRow {
  agent: string;
  device: string;
  addedAt: number;
}
interface Invite extends InviteInfo {
  hash: string;
}
interface PairRecord {
  hash: string;
  expiresAt: number;
  by: string;
  attempts: number;
}
type Out = { status: number; body: Record<string, unknown> };
const fail = (status: number, code: string, error: string): Out => ({ status, body: { error, code } });

export function startFakeRelay(config: FakeRelayConfig = {}): Promise<FakeRelay> {
  const log = config.log ?? (() => undefined);
  const maxBlob = config.maxBlobBytes ?? 2 * 1024 * 1024;
  const rate = config.ratePerMinute ?? 120;
  const limits = { maxBlobBytes: maxBlob, ratePerMinute: rate };

  // --- state (all in memory) -----------------------------------------------------
  const allowed = new Map<string, AllowlistEntry>();
  const bundles = new Map<string, unknown>();
  const agents = new Map<string, Map<string, AgentRow>>(); // handle → agent → row
  const defaults = new Map<string, string>();
  const nicknames = new Map<string, string>();
  /** Handles that ever set a nickname here: only those get the nickname field (null = cleared). */
  const profiled = new Set<string>();
  const invites = new Map<string, Invite>(); // sha256(code) → invite
  const pairCodes = new Map<string, PairRecord>(); // handle → live pairing code
  const claimed = new Set<string>(); // handles handed out by registration / invites
  const usedPairRequests = new Set<string>();

  const allow = (raw: string | AllowlistEntry) => {
    const e = typeof raw === 'string' ? { id: raw } : raw;
    const id = normalizeId(e.id);
    const handle = e.handle ? normalizeHandle(e.handle) : null;
    allowed.set(id, { ...e, id, ...(handle ? { handle } : {}) });
  };
  for (const e of config.allowlist ?? []) allow(e);
  const devicesOf = (handle: string) => [...allowed.values()].filter((e) => e.handle === handle).map((e) => e.id);
  const isMember = (device: string, handle: string) => allowed.get(device)?.handle === handle;
  const handleInUse = (h: string) => RESERVED_HANDLES.includes(h) || claimed.has(h) || devicesOf(h).length > 0;

  // --- agent directory -----------------------------------------------------------
  const book = (handle: string) => agents.get(handle) ?? (agents.set(handle, new Map()), agents.get(handle)!);
  const agentsOf = (handle: string) => [...book(handle).values()].sort((a, b) => a.addedAt - b.addedAt || a.agent.localeCompare(b.agent));
  const repairDefault = (handle: string): string | null => {
    const cur = defaults.get(handle);
    if (cur && book(handle).has(cur)) return cur;
    const first = agentsOf(handle)[0];
    if (first) defaults.set(handle, first.agent);
    else defaults.delete(handle);
    return first?.agent ?? null;
  };
  const defaultOf = (handle: string) => defaults.get(handle) ?? null;

  /** Register `agent` on `device` under `handle` (dryRun: only check it would work). */
  const registerAgent = (handle: string, rawAgent: string, device: string, dryRun = false): Out => {
    const agent = normalizeAgent(rawAgent);
    if (!agent) return fail(400, 'bad_agent', `"${rawAgent}" is not a valid agent name (1–32 of a-z 0-9 -, not "user" or "inbox")`);
    const existing = book(handle).get(agent);
    if (existing?.device === device) return { status: 200, body: { handle, agent, device, default: defaultOf(handle), already: true } };
    if (existing && isMember(existing.device, handle)) return fail(409, 'agent_taken', `the name "${agent}" is already used by another device of this person`);
    if (dryRun) return { status: 200, body: { handle, agent, available: true } };
    // as the relay: registration order, also within one millisecond
    const latest = agentsOf(handle).reduce((t, r) => Math.max(t, r.addedAt), 0);
    book(handle).set(agent, { agent, device, addedAt: Math.max(Date.now(), latest + 1) });
    if (!defaultOf(handle) || !book(handle).has(defaultOf(handle)!)) defaults.set(handle, agent);
    return { status: 200, body: { handle, agent, device, default: defaultOf(handle), ...(existing ? { tookOver: existing.device } : {}) } };
  };

  const agentOp = (handle: string, device: string, op: string, rawAgent: string, rawTo: string): Out => {
    if (op === 'list') return { status: 200, body: { handle, device, default: defaultOf(handle), agents: agentsOf(handle).map((r) => ({ agent: r.agent, device: r.device, addedAt: r.addedAt })) } };
    if (op === 'add') return registerAgent(handle, rawAgent, device);
    const agent = normalizeAgent(rawAgent);
    if (!agent) return fail(400, 'bad_agent', `"${rawAgent}" is not a valid agent name (1–32 of a-z 0-9 -, not "user" or "inbox")`);
    const existing = book(handle).get(agent);
    switch (op) {
      case 'remove': {
        if (!existing) return fail(404, 'no_agent', `no agent called "${agent}"`);
        if (existing.device !== device) return fail(403, 'not_your_agent', `"${agent}" is hosted on another device — remove it there`);
        book(handle).delete(agent);
        return { status: 200, body: { handle, agent, removed: true, default: repairDefault(handle) } };
      }
      case 'default': {
        if (!existing) return fail(404, 'no_agent', `no agent called "${agent}"`);
        defaults.set(handle, agent);
        return { status: 200, body: { handle, agent, default: agent } };
      }
      case 'rename': {
        const to = normalizeAgent(rawTo);
        if (!to) return fail(400, 'bad_agent', `"${rawTo}" is not a valid agent name (1–32 of a-z 0-9 -, not "user" or "inbox")`);
        if (!existing) return fail(404, 'no_agent', `no agent called "${agent}"`);
        if (existing.device !== device) return fail(403, 'not_your_agent', `"${agent}" is hosted on another device — rename it there`);
        if (to === agent) return { status: 200, body: { handle, agent: to, from: agent, default: defaultOf(handle), already: true } };
        const taken = book(handle).get(to);
        if (taken && (taken.device === device || isMember(taken.device, handle))) return fail(409, 'agent_taken', `the name "${to}" is already used`);
        const wasDefault = defaultOf(handle) === agent;
        book(handle).delete(agent);
        book(handle).set(to, { ...existing, agent: to });
        if (wasDefault) defaults.set(handle, to);
        return { status: 200, body: { handle, agent: to, from: agent, default: repairDefault(handle) } };
      }
      default:
        return fail(400, 'bad_op', 'unknown op');
    }
  };

  /** Register the join's agent; a failure does not undo the join — it is reported. */
  const joinAgent = (handle: string, agent: string | null, id: string): Record<string, unknown> => {
    if (!agent) return {};
    const r = registerAgent(handle, agent, id);
    return r.status === 200 ? { agent } : { agentError: String(r.body['error']), agentErrorCode: r.body['code'] };
  };
  const agentField = (r: Record<string, unknown>): { agent: string | null; bad: Out | null } => {
    if (r['agent'] === undefined || r['agent'] === '') return { agent: null, bad: null };
    const agent = typeof r['agent'] === 'string' ? normalizeAgent(r['agent']) : null;
    return agent ? { agent, bad: null } : { agent: null, bad: fail(400, 'bad_agent', `"${String(r['agent'])}" is not a valid agent name (1–32 of a-z 0-9 -)`) };
  };
  const skewed = (ts: unknown) => typeof ts !== 'number' || Math.abs(Date.now() - ts) > MAX_SKEW_MS;
  const clockSkew = () => fail(400, 'clock_skew', 'this computer’s clock is more than 10 minutes off — fix the time and retry');

  // --- HTTP endpoints --------------------------------------------------------------
  const agentsEndpoint = (b: Record<string, unknown>): Out => {
    const op = b['op'];
    const agent = typeof b['agent'] === 'string' ? b['agent'] : '';
    const to = typeof b['to'] === 'string' ? b['to'] : '';
    if (typeof op !== 'string' || !AGENT_OPS.includes(op) || typeof b['ts'] !== 'number') return fail(400, 'bad_request', `expected {op: ${AGENT_OPS.join('|')}, agent?, to?, cert, ts, sig}`);
    if (skewed(b['ts'])) return fail(400, 'clock_skew', 'clock is more than 10 minutes off');
    const device = signedBy(b['cert'], `${AGENT_CONTEXT}\n${b['ts']}\n${op}\n${agent}\n${to}`, b['sig']);
    if (!device) return fail(401, 'bad_signature', 'device signature invalid');
    const handle = allowed.get(device)?.handle;
    if (!handle) return fail(403, 'not_member', 'this device has no handle on this relay');
    return agentOp(handle, device, op, agent, to);
  };

  const registerEndpoint = (r: Record<string, unknown>, ip: string): Out => {
    if (typeof r['ts'] !== 'number') return fail(400, 'bad_request', 'expected {cert, ts, sig, name?, agent?}');
    const { agent, bad } = agentField(r);
    if (bad) return bad;
    if (skewed(r['ts'])) return clockSkew();
    const id = signedBy(r['cert'], `${REGISTER_CONTEXT}\n${r['ts']}${agent ? `\n${agent}` : ''}`, r['sig']);
    if (!id) return fail(401, 'bad_signature', 'device signature invalid');
    const existing = allowed.get(id);
    if (existing?.handle) return { status: 200, body: { id, handle: existing.handle, name: existing.name ?? '', already: true, ...joinAgent(existing.handle, agent, id) } };
    let handle = randomId(8);
    while (handleInUse(handle)) handle = randomId(8);
    claimed.add(handle);
    const name = cleanName(r['name']);
    allow({ id, handle, name });
    log(`fake-relay: registered ${handle} from ${ip}`);
    return { status: 200, body: { id, handle, name, ...joinAgent(handle, agent, id) } };
  };

  const pairCodeEndpoint = (r: Record<string, unknown>): Out => {
    if (typeof r['ts'] !== 'number') return fail(400, 'bad_request', 'expected {cert, ts, sig}');
    if (skewed(r['ts'])) return clockSkew();
    const id = signedBy(r['cert'], `${PAIR_CONTEXT}\n${r['ts']}`, r['sig']);
    if (!id) return fail(401, 'bad_signature', 'device signature invalid');
    const used = sha256(String(r['sig']));
    if (usedPairRequests.has(used)) return fail(409, 'replayed', 'this request was already used — run morse agent add again');
    usedPairRequests.add(used);
    const handle = allowed.get(id)?.handle;
    if (!handle) return fail(403, 'not_member', 'this computer has not joined Morse yet (morse join)');
    const code = randomId(10);
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    pairCodes.set(handle, { hash: sha256(code), expiresAt, by: id, attempts: 0 });
    return { status: 200, body: { handle, code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt } };
  };

  const pairInvalid = (handle: string) =>
    fail(404, 'pair_invalid', `pairing code is wrong, used or expired — on a computer already in morse.im/${handle}, run \`morse agent add\` for a new one`);

  const pairJoin = (r: Record<string, unknown>): Out => {
    if (typeof r['handle'] !== 'string' || typeof r['code'] !== 'string' || typeof r['ts'] !== 'number') return fail(400, 'bad_request', 'expected {handle, code, cert, ts, sig, name?, agent?}');
    const handle = normalizeHandle(r['handle']);
    if (!handle) return fail(400, 'bad_handle', `"${r['handle']}" is not a Morse address`);
    const { agent, bad } = agentField(r);
    if (bad) return bad;
    const code = normalizePairCode(r['code']);
    if (!code) return pairInvalid(handle);
    if (skewed(r['ts'])) return clockSkew();
    const id = signedBy(r['cert'], `${JOIN_CONTEXT}\n${r['ts']}\n${code}${agent ? `\n${agent}` : ''}`, r['sig']);
    if (!id) return fail(401, 'bad_signature', 'device signature invalid');
    const rec = pairCodes.get(handle);
    if (!rec || rec.expiresAt <= Date.now()) {
      pairCodes.delete(handle);
      return pairInvalid(handle);
    }
    if (sha256(code) !== rec.hash) {
      if (rec.attempts + 1 >= PAIR_MAX_ATTEMPTS) pairCodes.delete(handle);
      else rec.attempts += 1;
      return pairInvalid(handle);
    }
    const existing = allowed.get(id);
    if (existing?.handle === handle) return { status: 200, body: { id, handle, name: existing.name ?? '', already: true, ...joinAgent(handle, agent, id) } };
    if (existing?.handle) return fail(409, 'device_taken', `this computer already is morse.im/${existing.handle} — one computer belongs to one address (ask the relay admin to move it)`);
    if (agent) {
      const check = registerAgent(handle, agent, id, true);
      if (check.status !== 200) return check;
    }
    pairCodes.delete(handle);
    const name = cleanName(r['name']);
    allow({ id, handle, name });
    return { status: 200, body: { id, handle, name, ...joinAgent(handle, agent, id) } };
  };

  const inviteJoin = (r: Record<string, unknown>): Out => {
    if (typeof r['code'] !== 'string' || typeof r['ts'] !== 'number') return fail(400, 'bad_request', 'expected {code, cert, ts, sig, name?, agent?}');
    const { agent, bad } = agentField(r);
    if (bad) return bad;
    const invalid = fail(404, 'invite_invalid', 'invite code is invalid, used up, or expired');
    const code = normalizeInviteCode(r['code']);
    if (!code) return invalid;
    if (skewed(r['ts'])) return clockSkew();
    const id = signedBy(r['cert'], `${JOIN_CONTEXT}\n${r['ts']}\n${code}${agent ? `\n${agent}` : ''}`, r['sig']);
    if (!id) return fail(401, 'bad_signature', 'device signature invalid');
    const invite = invites.get(sha256(code));
    if (!invite || invite.expiresAt <= Date.now() || invite.uses <= 0) {
      invites.delete(sha256(code));
      return invalid;
    }
    const existing = allowed.get(id);
    if (existing?.handle === invite.handle) return { status: 200, body: { id, handle: invite.handle, name: existing.name ?? '', already: true, ...joinAgent(invite.handle, agent, id) } };
    if (existing?.handle) return fail(409, 'device_taken', `this device already belongs to morse.im/${existing.handle} — ask the relay admin to move it`);
    if (agent) {
      const check = registerAgent(invite.handle, agent, id, true);
      if (check.status !== 200) return check;
    }
    invite.uses -= 1;
    if (invite.uses <= 0) invites.delete(invite.hash);
    claimed.add(invite.handle);
    const name = cleanName(r['name']);
    allow({ id, handle: invite.handle, name });
    return { status: 200, body: { id, handle: invite.handle, name, ...joinAgent(invite.handle, agent, id) } };
  };

  const createInvite = (req: { handle?: unknown; uses?: unknown; ttlSec?: unknown; note?: unknown }): Out => {
    const handle = typeof req.handle === 'string' ? normalizeHandle(req.handle) : null;
    if (!handle) return fail(400, 'bad_handle', 'bad handle (2–32 of a-z 0-9 - _)');
    if (RESERVED_HANDLES.includes(handle)) return fail(400, 'reserved_handle', `"${handle}" is a reserved name`);
    const uses = req.uses === undefined ? 1 : Number(req.uses);
    if (!Number.isInteger(uses) || uses < 1 || uses > 100) return fail(400, 'bad_uses', 'uses must be 1–100');
    const ttlSec = req.ttlSec === undefined ? 7 * 86_400 : Number(req.ttlSec);
    if (!Number.isFinite(ttlSec) || ttlSec < 1 || ttlSec > 90 * 86_400) return fail(400, 'bad_ttl', 'ttl must be 1 s – 90 days');
    const code = base32(randomBytes(20)).toLowerCase();
    const hash = sha256(code);
    const now = Date.now();
    const note = typeof req.note === 'string' ? req.note.replace(/[\u0000-\u001f]/g, ' ').slice(0, 120) : '';
    const invite: Invite = { id: hash.slice(0, 12), handle, uses, expiresAt: now + ttlSec * 1000, createdAt: now, ...(note ? { note } : {}), hash };
    invites.set(hash, invite);
    const { hash: _hash, ...info } = invite;
    return { status: 200, body: { code, ...info } };
  };
  const liveInvites = (): InviteInfo[] =>
    [...invites.values()]
      .filter((i) => i.expiresAt > Date.now() && i.uses > 0)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ hash: _hash, ...info }) => info);

  /** Live sockets per device (non-passive, logged in). */
  const sockets = new Map<string, WebSocket>();
  /** ADR-069: signal frames forwarded so far (tests assert signaling happened). */
  let signals = 0;
  let frames = 0;
  const handleOf = new WeakMap<WebSocket, string>();

  const profileEndpoint = (r: Record<string, unknown>): Out => {
    if (typeof r['ts'] !== 'number' || typeof r['nickname'] !== 'string') return fail(400, 'bad_request', 'expected {nickname, cert, ts, sig}');
    if (skewed(r['ts'])) return clockSkew();
    const id = signedBy(r['cert'], `${PROFILE_CONTEXT}\n${r['ts']}\n${r['nickname']}`, r['sig']);
    const handle = id ? allowed.get(id)?.handle : undefined;
    if (!id || !handle) return fail(403, 'not_member', 'this device has not joined (morse join)');
    const nickname = normalizeNickname(r['nickname']) || null;
    profiled.add(handle);
    if (nickname) nicknames.set(handle, nickname);
    else nicknames.delete(handle);
    // tell the handle's other live computers
    for (const [device, ws] of sockets) {
      if (device !== id && handleOf.get(ws) === handle && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'nickname', handle, nickname }));
    }
    return { status: 200, body: { handle, nickname } };
  };

  const adminEndpoint = (req: IncomingMessage, path: string, body: Record<string, unknown> | null): Out | null => {
    if (!config.adminKey) return null;
    if (req.headers.authorization !== `Bearer ${config.adminKey}`) return { status: 401, body: { error: 'unauthorized' } };
    if (path === '/admin/invites' && req.method === 'POST') return createInvite(body ?? {});
    if (path === '/admin/invites' && req.method === 'GET') return { status: 200, body: { invites: liveInvites() } };
    const m = /^\/admin\/invites\/(.+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      const want = decodeURIComponent(m[1]!).toLowerCase();
      const hit = [...invites.values()].find((i) => i.id === want);
      if (hit) invites.delete(hit.hash);
      return { status: 200, body: { removed: Boolean(hit) } };
    }
    return null;
  };

  const http: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString();
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0]!.replace(/\/+$/, '') || '/';
      const send = (out: Out) => {
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      };
      if (path === '/healthz') return send({ status: 200, body: { ok: true, limits, ...(config.v3 ? { protocols: [2, 3] } : {}) } });
      let body: Record<string, unknown> | null = null;
      if (raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return send(fail(400, 'bad_request', 'expected JSON'));
        }
      }
      const b = body ?? {};
      let out: Out | null = null;
      if (req.method === 'POST' && path === '/v1/agents') out = agentsEndpoint(b);
      else if (req.method === 'POST' && path === '/v1/register' && config.register !== false) out = registerEndpoint(b, req.socket.remoteAddress ?? '?');
      else if (req.method === 'POST' && path === '/v1/pair-code') out = pairCodeEndpoint(b);
      else if (req.method === 'POST' && path === '/v1/join') out = b['handle'] !== undefined ? pairJoin(b) : inviteJoin(b);
      else if (req.method === 'POST' && path === '/v1/profile') out = profileEndpoint(b);
      else if (path.startsWith('/admin/')) out = adminEndpoint(req, path, body);
      if (out) return send(out);
      res.writeHead(404);
      res.end('not found');
    });
  });

  // --- WebSocket -------------------------------------------------------------------
  const buckets = new Map<string, { tokens: number; at: number }>();
  const takeToken = (id: string, perMinute: number = rate): boolean => {
    const rate = perMinute;
    const now = Date.now();
    const b = buckets.get(id) ?? { tokens: rate, at: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 60_000) * rate);
    b.at = now;
    buckets.set(id, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const validBundle = (id: string, b: unknown): boolean => {
    const bundle = b as { id?: string; cert?: string; encPub?: string; sig?: string } | null;
    if (!bundle || bundle.id !== id || typeof bundle.encPub !== 'string') return false;
    return signedBy(bundle.cert, `${BUNDLE_CONTEXT}\n${id}\n${bundle.encPub}`, bundle.sig) === id;
  };
  const deviceInfo = (id: string) => ({ id, name: allowed.get(id)?.name ?? '', bundle: bundles.get(id) ?? null });
  const nicknameField = (handle: string) => (profiled.has(handle) ? { nickname: nicknames.get(handle) ?? null } : {});


  // --- v3 (ADR-073): addresses, one connection for several, offline mailbox ----------------
  const ADDR_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
  const addressOf = (pub: Buffer): string => {
    let n = BigInt(`0x${createHash('sha256').update('morse-address-v1\n').update(pub).digest('hex')}`) % 30n ** 26n;
    let out = '';
    for (let i = 0; i < 26; i++) {
      out = ADDR_ALPHABET[Number(n % 30n)]! + out;
      n /= 30n;
    }
    return out;
  };
  const normAddr = (x: unknown): string | null => (typeof x === 'string' && /^[23456789abcdefghjkmnpqrstvwxyz]{26}$/.test(x.trim().toLowerCase()) ? x.trim().toLowerCase() : null);
  const edKey = (raw: Buffer) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  const verifyRaw = (raw: Buffer, msg: string, sigB64: unknown) => {
    try {
      return typeof sigB64 === 'string' && verify(null, Buffer.from(msg), edKey(raw), Buffer.from(sigB64, 'base64'));
    } catch {
      return false;
    }
  };
  interface V3Prekey { id: string; key: string; createdAt: number; sig: string }
  const goodPrekey = (address: string, raw: Buffer, p: unknown): p is V3Prekey => {
    const r = p as Partial<V3Prekey> | null;
    return Boolean(r && typeof r.id === 'string' && typeof r.key === 'string' && typeof r.createdAt === 'number' && verifyRaw(raw, `morse-prekey-v1\n${address}\n${r.id}\n${r.key}\n${r.createdAt}`, r.sig));
  };
  const v3Records = new Map<string, { key: string; prekeys: V3Prekey[]; caps: string[] }>();
  /** ADR-081: as relay-cf's normalizeCaps — well-formed ones, each once, at most 8; the rest dropped. */
  const goodCaps = (raw: unknown): string[] => {
    if (config.caps === false || !Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const c of raw) if (typeof c === 'string' && /^[a-z0-9]{1,16}$/.test(c) && !out.includes(c) && out.length < 8) out.push(c);
    return out;
  };
  const v3Host = new Map<string, WebSocket>();
  const v3Mail = new Map<string, Array<{ id: string; from: string; ref?: string; blob: string; ts: number }>>();
  const v3Notices = new Map<string, string[]>();
  const v3Count = { sent: 0, stored: 0, offline: 0 };
  const v3Sent: Array<{ from: string; to: string; blob: string; r: 'sent' | 'stored' | 'offline' }> = [];
  const v2Sent: Array<{ from: string; to: string }> = [];
  const mailboxTtl = config.mailboxTtlMs ?? 7 * 24 * 3600_000;
  const liveV3 = (address: string): WebSocket | null => {
    const ws = v3Host.get(address);
    return ws && ws.readyState === WebSocket.OPEN ? ws : null;
  };
  const flushV3 = (address: string) => {
    const ws = liveV3(address);
    if (!ws) return;
    for (const m of v3Mail.get(address) ?? []) ws.send(JSON.stringify({ type: 'deliver', id: m.id, to: address, from: m.from, blob: m.blob, ts: m.ts, ...(m.ref ? { ref: m.ref } : {}), stored: true }));
    for (const n of v3Notices.get(address) ?? []) ws.send(n);
    v3Notices.delete(address);
  };
  const expireMailbox = (now = Date.now()) => {
    for (const [to, list] of v3Mail) {
      const keep = list.filter((m) => m.ts > now - mailboxTtl);
      for (const m of list.filter((x) => !keep.includes(x))) {
        if (!m.ref) continue;
        const frame = JSON.stringify({ type: 'undeliverable', from: m.from, to, ref: m.ref, ts: now });
        const ws = liveV3(m.from);
        if (ws) ws.send(frame);
        else v3Notices.set(m.from, [...(v3Notices.get(m.from) ?? []), frame]);
      }
      v3Mail.set(to, keep);
    }
  };
  const expiry = setInterval(() => expireMailbox(), Math.min(mailboxTtl, 60_000));
  expiry.unref?.();

  const v3Connection = (ws: WebSocket, req: IncomingMessage) => {
    const primary = normAddr(decodeURIComponent(/\/v3\/ws\/([^/?]+)/.exec(req.url ?? '')?.[1] ?? ''));
    const nonce = randomBytes(32).toString('base64');
    let mine: string[] | null = null;
    const helloTimer = setTimeout(() => {
      if (!mine) ws.close(4001, 'login timeout');
    }, HELLO_TIMEOUT_MS);
    ws.send(JSON.stringify({ type: 'challenge', nonce, protocol: 3 }));
    const reply = (rid: unknown, body: Record<string, unknown>) =>
      ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ ...body, ...(typeof rid === 'string' ? { rid } : {}) }));
    ws.on('message', (raw) => {
      frames++;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return void ws.close(4002, 'bad frame');
      }
      const rid = msg['rid'];
      if (msg['type'] === 'ping') return void reply(undefined, { type: 'pong' });
      if (!mine) {
        const list = Array.isArray(msg['addresses']) ? (msg['addresses'] as Array<Record<string, unknown>>) : [];
        if (msg['type'] !== 'hello' || msg['v'] !== 3 || !list.length || normAddr(list[0]?.['address']) !== primary) return void ws.close(4001, 'login required');
        const ok: Array<{ address: string; key: string; prekey: V3Prekey | null; caps: string[] }> = [];
        for (const e of list) {
          const address = normAddr(e['address']);
          const keyB64 = typeof e['key'] === 'string' ? e['key'] : '';
          const raw = Buffer.from(keyB64, 'base64');
          if (!address || raw.length !== 32 || addressOf(raw) !== address || !verifyRaw(raw, `morse-relay-login-v3\n${nonce}\n${address}`, e['sig'])) return void ws.close(4001, 'login failed');
          ok.push({ address, key: keyB64, prekey: goodPrekey(address, raw, e['prekey']) ? (e['prekey'] as V3Prekey) : null, caps: goodCaps(e['caps']) });
        }
        clearTimeout(helloTimer);
        mine = ok.map((o) => o.address);
        for (const o of ok) {
          const prev = v3Records.get(o.address);
          // caps are replaced at every login: what THIS client can do (an older one logging in again publishes none)
          v3Records.set(o.address, { key: o.key, prekeys: o.prekey ? [o.prekey, ...(prev?.prekeys ?? []).filter((p) => p.id !== o.prekey!.id)].slice(0, 2) : (prev?.prekeys ?? []), caps: o.caps });
          const old = v3Host.get(o.address);
          if (old && old !== ws && o.address === primary) old.close(4000, 'replaced by a newer connection');
          v3Host.set(o.address, ws);
        }
        ws.send(JSON.stringify({ type: 'welcome', v: 3, addresses: mine, limits, protocols: [2, 3] }));
        for (const a of mine) flushV3(a);
        return;
      }
      switch (msg['type']) {
        case 'send':
        case 'signal': {
          const isSignal = msg['type'] === 'signal';
          const to = normAddr(msg['to']);
          const from = msg['from'] === undefined ? mine[0]! : normAddr(msg['from']);
          const blob = msg['blob'];
          if (!to) return void reply(rid, { type: 'error', error: 'bad recipient address' });
          if (!from || !mine.includes(from)) return void reply(rid, { type: 'error', error: 'not logged in as that sender address' });
          if (typeof blob !== 'string' || !blob) return void reply(rid, { type: 'error', error: 'empty blob' });
          if (Buffer.byteLength(blob) > (isSignal ? 65_536 : maxBlob)) return void reply(rid, { type: 'error', error: `envelope too large (max ${maxBlob} bytes)` });
          const target = liveV3(to);
          if (isSignal) {
            if (config.signal === false) return void reply(rid, { type: 'error', error: 'unknown request' });
            if (!target) return void reply(rid, { type: 'offline' });
            signals++;
            target.send(JSON.stringify({ type: 'signal', from, to, blob, ts: Date.now() }));
            return void reply(rid, { type: 'signaled' });
          }
          if (config.v3RatePerIpPerMinute && !takeToken('v3 sends of this ip', config.v3RatePerIpPerMinute)) return void reply(rid, { type: 'error', error: `rate limited (max ${config.v3RatePerIpPerMinute}/min)` });
          if (!v3Records.has(to)) return void reply(rid, { type: 'error', error: 'unknown address — nobody has logged in with it yet' });
          const ref = typeof msg['ref'] === 'string' ? msg['ref'] : undefined;
          if (target) {
            v3Count.sent++;
            v3Sent.push({ from, to, blob, r: 'sent' });
            target.send(JSON.stringify({ type: 'deliver', id: randomUUID(), to, from, blob, ts: Date.now(), ...(ref ? { ref } : {}) }));
            return void reply(rid, { type: 'sent' });
          }
          if (msg['store'] === false) {
            v3Count.offline++;
            v3Sent.push({ from, to, blob, r: 'offline' });
            return void reply(rid, { type: 'offline' });
          }
          v3Count.stored++;
          v3Sent.push({ from, to, blob, r: 'stored' });
          v3Mail.set(to, [...(v3Mail.get(to) ?? []), { id: randomUUID(), from, ...(ref ? { ref } : {}), blob, ts: Date.now() }]);
          return void reply(rid, { type: 'stored', expiresAt: Date.now() + mailboxTtl });
        }
        case 'address': {
          const a = normAddr(msg['address']);
          if (!a) return void reply(rid, { type: 'error', error: 'bad address' });
          const rec = v3Records.get(a);
          return void reply(rid, { type: 'address', address: a, key: rec?.key ?? null, prekey: rec?.prekeys[0] ?? null, online: Boolean(liveV3(a)), ...(config.caps === false ? {} : { caps: rec?.caps ?? [] }) });
        }
        case 'alias': {
          if (!config.aliases) return void reply(rid, { type: 'error', error: 'unknown request' });
          const raw = String(msg['name'] ?? '').trim().toLowerCase().replace(/^@/, '').replace(/^(?:[a-z]+:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\//, '').replace(/\/+$/, '');
          const m = /^([a-z0-9][a-z0-9_-]{1,31})(?:\/([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?))?$/.exec(raw);
          if (!m) return void reply(rid, { type: 'error', error: 'bad alias name' });
          const handle = m[1]!;
          const def = repairDefault(handle);
          const all = agentsOf(handle).flatMap((row) => {
            const cert = (bundles.get(row.device) as { cert?: unknown } | undefined)?.cert;
            if (typeof cert !== 'string' || !isMember(row.device, handle)) return [];
            const spki = new X509Certificate(Buffer.from(cert, 'base64')).publicKey.export({ type: 'spki', format: 'der' });
            return [{ agent: row.agent, address: addressOf(Buffer.from(spki.subarray(spki.length - 32))) }];
          });
          const entry = (a: { agent: string; address: string }, bare: boolean) => ({ name: bare ? handle : `${handle}/${a.agent}`, address: a.address, agent: a.agent, ...(a.agent === def ? { default: true } : {}) });
          const entries = m[2]
            ? all.filter((a) => a.agent === m[2]).map((a) => entry(a, false))
            : [...all.filter((a) => a.agent === def).map((a) => entry(a, true)), ...all.filter((a) => a.agent !== def).sort((a, b) => a.agent.localeCompare(b.agent)).map((a) => entry(a, false))];
          return void reply(rid, { type: 'alias', name: raw, entries });
        }
        case 'prekey': {
          const a = normAddr(msg['address']);
          const rec = a ? v3Records.get(a) : undefined;
          if (!a || !rec || !mine.includes(a) || !goodPrekey(a, Buffer.from(rec.key, 'base64'), msg['prekey'])) return void reply(rid, { type: 'error', error: 'bad prekey signature' });
          const p = msg['prekey'] as V3Prekey;
          rec.prekeys = [p, ...rec.prekeys.filter((x) => x.id !== p.id)].slice(0, 2);
          return void reply(rid, { type: 'prekey', ok: true });
        }
        case 'ack': {
          const to = normAddr(msg['to']) ?? mine[0]!;
          const ids = Array.isArray(msg['ids']) ? (msg['ids'] as unknown[]) : [];
          if (mine.includes(to)) v3Mail.set(to, (v3Mail.get(to) ?? []).filter((m) => !ids.includes(m.id)));
          return;
        }
        default:
          return void reply(rid, { type: 'error', error: 'unknown request' });
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      for (const a of mine ?? []) if (v3Host.get(a) === ws) v3Host.delete(a);
    });
    ws.on('error', () => undefined);
  };

  const wss = new WebSocketServer({ server: http, maxPayload: maxBlob + 64 * 1024 });
  wss.on('connection', (ws, req) => {
    if (/\/v3\/ws\//.test(req.url ?? '')) {
      if (!config.v3) return void ws.close(1008, 'no v3 here');
      return v3Connection(ws, req);
    }
    const nonce = randomBytes(32).toString('base64');
    let self: { id: string; passive: boolean; handle?: string } | null = null;
    const claimedId = /\/v1\/ws\/([^/?]+)/.exec(req.url ?? '')?.[1];
    const helloTimer = setTimeout(() => {
      if (!self) ws.close(4001, 'login timeout');
    }, HELLO_TIMEOUT_MS);
    ws.send(JSON.stringify({ type: 'challenge', nonce }));
    const reply = (rid: unknown, body: Record<string, unknown>) =>
      ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ ...body, ...(typeof rid === 'string' ? { rid } : {}) }));

    ws.on('message', (raw) => {
      frames++;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        ws.close(4002, 'bad frame');
        return;
      }
      const rid = msg['rid'];
      if (msg['type'] === 'ping') return void reply(undefined, { type: 'pong' });

      if (!self) {
        if (msg['type'] !== 'hello') return void ws.close(4001, 'login required');
        const id = signedBy(msg['cert'], `${LOGIN_CONTEXT}\n${nonce}`, msg['sig']);
        if (!id || (claimedId && normalizeId(decodeURIComponent(claimedId)) !== id)) return void ws.close(4001, 'login failed');
        const entry = allowed.get(id);
        if (!entry) {
          reply(undefined, { type: 'error', error: 'device not on the relay allowlist' });
          return void ws.close(4003, 'not allowed');
        }
        clearTimeout(helloTimer);
        self = { id, passive: msg['passive'] === true, ...(entry.handle ? { handle: entry.handle } : {}) };
        if (validBundle(id, msg['bundle'])) bundles.set(id, msg['bundle']);
        if (!self.passive) {
          const previous = sockets.get(id);
          if (previous && previous !== ws) previous.close(4000, 'replaced by a newer connection');
          sockets.set(id, ws);
          if (entry.handle) handleOf.set(ws, entry.handle);
        }
        const nick = entry.handle && !self.passive ? nicknameField(entry.handle) : {};
        ws.send(JSON.stringify({ type: 'welcome', id, handle: entry.handle ?? null, ...nick, limits, ...(config.v3 ? { protocols: [2, 3] } : {}) }));
        return;
      }

      switch (msg['type']) {
        case 'signal': {
          if (config.signal === false) return void reply(rid, { type: 'error', error: 'unknown request' });
          if (self.passive) return void reply(rid, { type: 'error', error: 'a lookup connection cannot signal' });
          const to = typeof msg['to'] === 'string' ? normalizeId(msg['to']) : '';
          const blob = msg['blob'];
          if (!allowed.has(to)) return void reply(rid, { type: 'error', error: 'recipient not on the relay allowlist' });
          if (typeof blob !== 'string' || !blob) return void reply(rid, { type: 'error', error: 'empty signal' });
          if (Buffer.byteLength(blob) > 65_536) return void reply(rid, { type: 'error', error: 'signal too large (max 65536 bytes)' });
          const target = sockets.get(to);
          if (!target || target.readyState !== WebSocket.OPEN) return void reply(rid, { type: 'offline' });
          signals++;
          target.send(JSON.stringify({ type: 'signal', from: self.id, ...(self.handle ? { fromHandle: self.handle } : {}), blob, ts: Date.now() }));
          return void reply(rid, { type: 'signaled' });
        }
        case 'send': {
          const to = typeof msg['to'] === 'string' ? normalizeId(msg['to']) : '';
          const blob = msg['blob'];
          if (!allowed.has(to)) return void reply(rid, { type: 'error', error: 'recipient not on the relay allowlist' });
          if (typeof blob !== 'string' || !blob) return void reply(rid, { type: 'error', error: 'empty blob' });
          if (Buffer.byteLength(blob) > maxBlob) return void reply(rid, { type: 'error', error: `envelope too large (max ${maxBlob} bytes)` });
          if (!takeToken(self.id)) return void reply(rid, { type: 'error', error: `rate limited (max ${rate}/min)` });
          const target = sockets.get(to);
          if (!target || target.readyState !== WebSocket.OPEN) return void reply(rid, { type: 'offline' });
          // forwarded, never stored
          v2Sent.push({ from: self.id, to });
          target.send(JSON.stringify({ type: 'deliver', id: randomUUID(), from: self.id, ...(self.handle ? { fromHandle: self.handle } : {}), blob, ts: Date.now() }));
          return void reply(rid, { type: 'sent' });
        }
        case 'bundle': {
          const id = typeof msg['id'] === 'string' ? normalizeId(msg['id']) : '';
          return void reply(rid, { type: 'bundle', bundle: allowed.has(id) ? (bundles.get(id) ?? null) : null });
        }
        case 'handle': {
          const handle = typeof msg['handle'] === 'string' ? normalizeHandle(msg['handle']) : null;
          if (!handle) return void reply(rid, { type: 'error', error: 'bad handle' });
          const ids = devicesOf(handle);
          return void reply(rid, { type: 'handle', handle, ...(ids.length ? nicknameField(handle) : {}), devices: ids.map(deviceInfo) });
        }
        case 'agent': {
          const handle = typeof msg['handle'] === 'string' ? normalizeHandle(msg['handle']) : null;
          if (!handle) return void reply(rid, { type: 'error', error: 'bad handle' });
          const raw = typeof msg['agent'] === 'string' && msg['agent'] ? msg['agent'] : null;
          const agent = raw ? normalizeAgent(raw) : null;
          if (raw && !agent) return void reply(rid, { type: 'error', error: 'bad agent name' });
          const name = agent ?? defaultOf(handle);
          const rec = name ? book(handle).get(name) : undefined;
          if (!rec || !isMember(rec.device, handle)) return void reply(rid, { type: 'agent', handle, agent: agent ?? rec?.agent ?? null, device: null });
          return void reply(rid, { type: 'agent', handle, ...nicknameField(handle), agent: rec.agent, device: deviceInfo(rec.device) });
        }
        default:
          reply(rid, { type: 'error', error: 'unknown request' });
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (self && !self.passive && sockets.get(self.id) === ws) sockets.delete(self.id);
    });
    ws.on('error', () => undefined);
  });

  return new Promise((resolve) => {
    http.listen(config.port ?? 0, config.host ?? '127.0.0.1', () => {
      const port = (http.address() as AddressInfo).port;
      resolve({
        port,
        url: `ws://127.0.0.1:${port}`,
        online: () => [...sockets.keys()],
        signals: () => signals,
        frames: () => frames,
        onlineAddresses: () => [...v3Host.keys()].filter((a) => liveV3(a)),
        mailbox: (address) => [...(v3Mail.get(address) ?? [])],
        v3Sends: () => ({ ...v3Count }),
        v3SentLog: () => [...v3Sent],
        expireMailbox,
        v3Log: () => [...v3Sent],
        v2Sends: () => [...v2Sent],
        tamper: (address, patch) => {
          const rec = v3Records.get(address);
          if (!rec) return;
          if (patch.key !== undefined) rec.key = patch.key;
          if (patch.caps !== undefined) rec.caps = patch.caps;
          if (patch.prekey === null) rec.prekeys = [];
        },
        dump: () =>
          JSON.stringify({
            allowed: [...allowed.values()],
            bundles: [...bundles],
            agents: [...agents].map(([h, m]) => [h, [...m.values()]]),
            defaults: [...defaults],
            nicknames: [...nicknames],
            invites: liveInvites(),
            v3: { records: [...v3Records], mailbox: [...v3Mail] },
          }),
        allow,
        entry: (id) => allowed.get(normalizeId(id)) ?? null,
        devicesOf,
        nickname: (handle) => nicknames.get(handle) ?? null,
        createInvite: (r) => {
          const out = createInvite(r);
          if (out.status !== 200) throw new Error(String(out.body['error']));
          return out.body as unknown as InviteInfo & { code: string };
        },
        close: () =>
          new Promise<void>((done) => {
            clearInterval(expiry);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            http.close(() => done());
          }),
      });
    });
  });
}
