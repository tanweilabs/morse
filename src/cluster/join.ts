import { createPrivateKey, sign, X509Certificate } from 'node:crypto';
import WebSocket from 'ws';
import { morseHome, dataDir } from '../home.js';
import { updateMachineConfig } from '../machine-config.js';
import { DEFAULT_SITE_URL, fetchRelay, stripAddressHost } from './address.js';
import { AgentError, agentRequest, applyToLocal, normalizeAgentName, saveLocalAgents } from './agents.js';
import { getDeviceName } from './device.js';
import { loadOrCreateIdentity, type DeviceIdentity } from './identity.js';
import { looksLikeAddress } from '../identity/address.js';
import { relaySocketUrl, signChallenge } from './relay-client.js';
import { join } from 'node:path';

/**
 * Joining a Morse relay — with no code at all (open registration: a new random
 * handle, ADR-036), with a pairing code from one of your own computers (ADR-036),
 * or with an admin invite code (ADR-032, the way to a readable handle) — plus the
 * admin side that mints invites.
 *
 *   new person:      morse join                         → morse.im/k7f3a9xq
 *   second computer: morse agent add (on the first)    → morse join k7f3a9xq --code abcde-fghjk
 *
 *   admin:       morse invite create <readable-name> [--uses N] [--ttl 7d]   (MORSE_ADMIN_KEY)
 *   new device:  morse join <code>   — or the one-liner from morse.im/install.sh
 *
 * `join` signs JOIN_CONTEXT\n<ts>\n<code> with this device's key and POSTs it with
 * the certificate to <relay>/v1/join; the relay checks the signature (so a device
 * can only enrol ITSELF), takes one use of the invite, and allowlists the device
 * under the invite's handle. Then the relay URL and handle go into
 * ~/.morse/config.json. Re-running is harmless: a device that is already a
 * member is detected first and the invite is not spent.
 */

export const JOIN_CONTEXT = 'morse-relay-join-v1';
export { DEFAULT_RELAY_URL, DEFAULT_SITE_URL } from './address.js';
export const ADMIN_KEY_ENV = 'MORSE_ADMIN_KEY';

/** Accept what a human pastes: any case, spaces or dashes. null = not a code. */
export function normalizeInviteCode(input: string): string | null {
  const c = input.trim().toLowerCase().replace(/[\s-]/g, '');
  return c.length === 32 && /^[a-z2-7]+$/.test(c) ? c : null;
}

export const REGISTER_CONTEXT = 'morse-relay-register-v1';
export const PAIR_CONTEXT = 'morse-relay-pair-v1';
export const PROFILE_CONTEXT = 'morse-relay-profile-v1';
/** Random handles and pairing codes use these characters (no 0 / 1 / i / l / o / u). */
export const ID_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export const PAIR_CODE_LENGTH = 10;

/** A pairing code as typed: any case, spaces or dashes. null = not one. */
export function normalizePairCode(input: string): string | null {
  const c = input.trim().toLowerCase().replace(/[\s-]/g, '');
  return c.length === PAIR_CODE_LENGTH && [...c].every((ch) => ID_ALPHABET.includes(ch)) ? c : null;
}

/** `k7f3a9xq`, `@k7f3a9xq`, `morse.im/k7f3a9xq` (any host in front — also the retired morse.talk) → `k7f3a9xq`. null = not a handle. */
export function parseHandle(input: string): string | null {
  const s = stripAddressHost(input).toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(s) ? s : null;
}

/** Looks like a relay-assigned random handle (8 of ID_ALPHABET)? */
export const isRandomHandle = (h: string): boolean => h.length === 8 && [...h].every((c) => ID_ALPHABET.includes(c));

export type JoinPlan =
  | { kind: 'register' }
  | { kind: 'invite'; code: string }
  | { kind: 'pair'; handle: string; code: string }
  | { kind: 'refused'; reason: 'readable_name' | 'needs_code' | 'needs_handle' | 'bad_argument'; message: string };

/**
 * What `morse join [arg] [--code <pairing code>]` means (ADR-036):
 *   (nothing)                     → open registration: a new random handle
 *   <32-character invite code>    → admin invite (ADR-032)
 *   <handle> --code <code>        → add this computer to that handle
 *   <readable name>               → refused: readable names are not self-service yet
 */
export function planJoin(arg?: string, pairCode?: string): JoinPlan {
  const a = arg?.trim() ?? '';
  if (pairCode !== undefined) {
    const handle = a ? parseHandle(a) : null;
    if (!handle) {
      return { kind: 'refused', reason: 'needs_handle', message: 'with --code, name the address this computer should join: morse join <your address, e.g. k7f3a9xq> --code <pairing code>' };
    }
    return { kind: 'pair', handle, code: pairCode };
  }
  if (!a) return { kind: 'register' };
  const invite = normalizeInviteCode(a);
  if (invite) return { kind: 'invite', code: invite };
  const handle = parseHandle(a);
  if (handle && isRandomHandle(handle)) {
    return {
      kind: 'refused',
      reason: 'needs_code',
      message: `to add an agent on this computer to morse.im/${handle}: on a computer that is already morse.im/${handle} run \`morse agent add\`, then here: morse join ${handle} --code <pairing code>`,
    };
  }
  if (handle) {
    return {
      kind: 'refused',
      reason: 'readable_name',
      message: `readable names like "${handle}" are not open yet — ask the Morse admin for an invite code. Run \`morse join\` with nothing after it to get your own random address. If "${handle}" is already yours, run \`morse agent add\` on a computer that has it and then: morse join ${handle} --code <pairing code>`,
    };
  }
  return { kind: 'refused', reason: 'bad_argument', message: `"${a}" is neither an invite code nor a Morse address — run \`morse join\` with nothing after it to get your own address` };
}

/** ws(s)://host[/base] → http(s)://host[/base] (the relay's HTTP side). */
export function relayHttpBase(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`not a relay URL: ${url}`);
  return u.toString().replace(/\/+$/, '');
}

/** "7d" / "12h" / "30m" / "90s" / "3600" (seconds) → seconds. null = not a duration. */
export function parseDuration(input: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhdw]?)\s*$/i.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }[m[2]!.toLowerCase() as '' | 's' | 'm' | 'h' | 'd' | 'w'];
  const sec = Math.round(n * unit);
  return sec > 0 ? sec : null;
}

/** Signs JOIN_CONTEXT\n<ts>\n<code>[\n<agent>] — the agent to register is part of what is signed. */
export function signJoin(identity: DeviceIdentity, ts: number, code: string, agent?: string): string {
  return sign(null, Buffer.from(`${JOIN_CONTEXT}\n${ts}\n${code}${agent ? `\n${agent}` : ''}`), createPrivateKey(identity.keyPem)).toString('base64');
}

/** Signs REGISTER_CONTEXT\n<ts>[\n<agent>] (open registration, ADR-036). */
export function signRegister(identity: DeviceIdentity, ts: number, agent?: string): string {
  return sign(null, Buffer.from(`${REGISTER_CONTEXT}\n${ts}${agent ? `\n${agent}` : ''}`), createPrivateKey(identity.keyPem)).toString('base64');
}

/** Signs PAIR_CONTEXT\n<ts> (a member device asks for a pairing code). */
export function signPairCode(identity: DeviceIdentity, ts: number): string {
  return sign(null, Buffer.from(`${PAIR_CONTEXT}\n${ts}`), createPrivateKey(identity.keyPem)).toString('base64');
}

/** Signs PROFILE_CONTEXT\n<ts>\n<nickname> — the relay protocol still has it; the client never sends it (ADR-065). */
export function signProfile(identity: DeviceIdentity, ts: number, nickname: string): string {
  return sign(null, Buffer.from(`${PROFILE_CONTEXT}\n${ts}\n${nickname}`), createPrivateKey(identity.keyPem)).toString('base64');
}

/** One signed request from a MEMBER device (pairing code). Throws JoinError. */
async function memberRequest<T>(url: string, path: string, body: Record<string, unknown>, identity: DeviceIdentity, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  try {
    res = await fetchRelay(url, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, cert: new X509Certificate(identity.certPem).raw.toString('base64') }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new JoinError(`cannot reach the relay at ${relayHttpBase(url)}: ${e instanceof Error ? e.message : String(e)}`, 'unreachable');
  }
  const text = await res.text();
  let parsed: (T & { error?: string; code?: string }) | null = null;
  try {
    parsed = JSON.parse(text) as T & { error?: string; code?: string };
  } catch {
    /* not JSON */
  }
  if (!parsed && res.status === 404) throw new JoinError('this relay is too old for that (it needs the ADR-036 relay)', 'unsupported');
  if (!res.ok || !parsed) {
    const code = parsed?.code ?? `http_${res.status}`;
    throw new JoinError(code === 'not_member' ? 'this computer has not joined Morse yet — run: morse join' : (parsed?.error ?? `relay answered HTTP ${res.status}`), code);
  }
  return parsed;
}

export interface PairCode {
  handle: string;
  /** Formatted for reading out: abcde-fghjk. */
  code: string;
  expiresAt: number;
}

/** `morse agent add` (no name; `morse device add` is an alias): a one-time, 10-minute code that lets another computer join this handle. */
export async function requestPairCode(opts: { url: string; home?: string; timeoutMs?: number }): Promise<PairCode> {
  const identity = loadOrCreateIdentity(opts.home ?? morseHome());
  const ts = Date.now();
  return memberRequest<PairCode>(opts.url, '/v1/pair-code', { ts, sig: signPairCode(identity, ts) }, identity, opts.timeoutMs);
}

/** The copy-paste lines for the computer being added. */
export function pairCommands(handle: string, code: string, site: string = DEFAULT_SITE_URL): { morse: string; install: string } {
  return { morse: `morse join ${handle} --code ${code}`, install: `curl -fsSL ${site.replace(/\/+$/, '')}/install.sh | bash -s -- ${handle} --code ${code}` };
}

/**
 * Is this device already on the relay's allowlist? Logs in passively (never
 * "online") and reads the handle from the welcome. 'not-member' on close 4003;
 * throws when the relay cannot be reached.
 */
export function probeMembership(url: string, identity: DeviceIdentity, timeoutMs = 8000): Promise<{ handle: string | null } | 'not-member'> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relaySocketUrl(url, identity.id));
    const certB64 = new X509Certificate(identity.certPem).raw.toString('base64');
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
    const timer = setTimeout(() => done(() => reject(new Error(`relay ${url} did not answer within ${timeoutMs / 1000}s`))), timeoutMs);
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg['type'] === 'challenge') {
        ws.send(JSON.stringify({ type: 'hello', cert: certB64, sig: signChallenge(identity, String(msg['nonce'])), passive: true }));
      } else if (msg['type'] === 'welcome') {
        done(() => resolve({ handle: typeof msg['handle'] === 'string' ? msg['handle'] : null }));
      }
    });
    ws.on('close', (code) => done(() => (code === 4003 ? resolve('not-member') : reject(new Error(`relay ${url} closed the connection (${code})`)))));
    ws.on('error', (e) => done(() => reject(new Error(`cannot reach relay ${url}: ${e.message}`))));
  });
}

export interface JoinResult {
  id: string;
  handle: string;
  /** true = this device was already a member; no invite was used. */
  already: boolean;
  /** The agent registered on this device (morse.im/<handle>/<agent>), when one was asked for. */
  agent?: string;
}

export class JoinError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Remember the relay and who we are on it (~/.morse/config.json). */
export function saveRelayMembership(url: string, handle: string | null, home: string = morseHome()): void {
  // (ADR-081, ADR-081 review F3) an old name never has the shape of an address — whatever the relay answered
  if (handle && looksLikeAddress(handle)) throw new Error(`the relay ${url} answered with the name "${handle}", which has the shape of an address — not saved (an old name is never 26 characters of the address alphabet)`);
  updateMachineConfig(
    (cfg) => {
      const prev = (cfg['relay'] && typeof cfg['relay'] === 'object' ? cfg['relay'] : {}) as Record<string, unknown>;
      cfg['relay'] = { ...prev, url, ...(handle ? { handle } : {}) };
    },
    join(dataDir(home), 'config.json'),
  );
}

/** Options shared by every way of joining (invite, open registration, pairing code). */
interface EnrolOptions {
  url: string;
  home?: string;
  name?: string;
  /** Agent to register on this device (ADR-033), e.g. "mini". Omit to register none. */
  agent?: string;
  /** Skip the membership probe (tests). */
  probe?: boolean;
  timeoutMs?: number;
}

function agentOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const agent = normalizeAgentName(raw) ?? undefined;
  if (!agent) throw new JoinError(`"${raw}" is not a valid agent name (1–32 of a-z 0-9 -, e.g. mini, air, pro)`, 'bad_agent');
  return agent;
}

/**
 * Is this device already a member? Then nothing is joined, registered or spent:
 * the handle is saved and (with an agent) the agent is registered by a signed
 * request. null = not a member (or the relay could not be probed — the HTTP call
 * that follows reports that properly).
 */
async function ifAlreadyMember(opts: EnrolOptions, identity: DeviceIdentity, home: string, agent: string | undefined): Promise<JoinResult | null> {
  if (opts.probe === false) return null;
  let member: { handle: string | null } | 'not-member' | null = null;
  try {
    member = await probeMembership(opts.url, identity, opts.timeoutMs);
  } catch {
    /* relay unreachable over WebSocket */
  }
  if (!member || member === 'not-member' || !member.handle) return null;
  saveRelayMembership(opts.url, member.handle, home);
  if (!agent) return { id: identity.id, handle: member.handle, already: true };
  try {
    const r = await agentRequest({ url: opts.url, op: 'add', agent, home, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
    applyToLocal('add', r, home);
  } catch (e) {
    if (e instanceof AgentError) throw new JoinError(agentTakenHint(e.message, e.code, member.handle), e.code);
    throw e;
  }
  return { id: identity.id, handle: member.handle, already: true, agent };
}

/** POST one signed enrolment (/v1/join or /v1/register) and save what the relay says. */
async function enrol(opts: EnrolOptions, path: '/v1/join' | '/v1/register', body: Record<string, unknown>, identity: DeviceIdentity, home: string, agent: string | undefined): Promise<JoinResult> {
  let res: Response;
  try {
    res = await fetchRelay(opts.url, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        cert: new X509Certificate(identity.certPem).raw.toString('base64'),
        name: opts.name ?? getDeviceName(home),
        ...(agent ? { agent } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new JoinError(`cannot reach the relay at ${relayHttpBase(opts.url)}: ${e instanceof Error ? e.message : String(e)}`, 'unreachable');
  }
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON: an older relay, or something else answering */
  }
  const b = (parsed ?? {}) as {
    id?: string;
    handle?: string;
    already?: boolean;
    agent?: string;
    agentError?: string;
    agentErrorCode?: string;
    error?: string;
    code?: string;
    retryAfterSec?: number;
  };
  if (!res.ok || typeof b.handle !== 'string') {
    if (!parsed && res.status === 404 && path === '/v1/register') {
      throw new JoinError('this relay does not hand out new addresses (no open registration) — ask its admin for an invite code: morse join <invite code>', 'no_registration');
    }
    if (!parsed && res.status === 404) throw new JoinError('this relay is too old for that (pairing codes need the ADR-036 relay)', 'unsupported');
    const msg = b.error ?? `relay answered HTTP ${res.status}`;
    throw new JoinError(b.code === 'agent_taken' ? agentTakenHint(msg, b.code, typeof body['handle'] === 'string' ? body['handle'] : null) : msg, b.code ?? `http_${res.status}`);
  }
  saveRelayMembership(opts.url, b.handle, home);
  if (b.agentError) {
    // joined, but the agent could not be registered (e.g. its name was taken a moment ago)
    throw new JoinError(`joined morse.im/${b.handle}, but ${agentTakenHint(b.agentError, b.agentErrorCode ?? '', b.handle)}`, b.agentErrorCode ?? 'agent_failed');
  }
  if (b.agent) saveLocalAgents({ primary: b.agent, agents: [b.agent] }, home);
  return { id: b.id ?? identity.id, handle: b.handle, already: b.already === true, ...(b.agent ? { agent: b.agent } : {}) };
}

/** Join with an admin invite code (ADR-032) — the way to a readable handle. */
export async function joinRelay(opts: EnrolOptions & { code: string }): Promise<JoinResult> {
  const code = normalizeInviteCode(opts.code);
  if (!code) throw new JoinError('that does not look like an invite code (32 letters/digits)', 'invite_invalid');
  const agent = agentOf(opts.agent);
  const home = opts.home ?? morseHome();
  const identity = loadOrCreateIdentity(home);
  const already = await ifAlreadyMember(opts, identity, home, agent);
  if (already) return already;
  const ts = Date.now();
  return enrol(opts, '/v1/join', { code, ts, sig: signJoin(identity, ts, code, agent) }, identity, home, agent);
}

/**
 * Open registration (ADR-036): no code — the relay gives this device a new random
 * handle (e.g. k7f3a9xq) and it becomes that handle's first device. A device that
 * already has a handle keeps it (nothing new is created).
 */
export async function registerRelay(opts: EnrolOptions): Promise<JoinResult> {
  const agent = agentOf(opts.agent);
  const home = opts.home ?? morseHome();
  const identity = loadOrCreateIdentity(home);
  const already = await ifAlreadyMember(opts, identity, home, agent);
  if (already) return already;
  const ts = Date.now();
  return enrol(opts, '/v1/register', { ts, sig: signRegister(identity, ts, agent) }, identity, home, agent);
}

/**
 * Add this computer to an existing handle with a pairing code from one of its
 * devices (`morse agent add` there, ADR-036 / ADR-067). A computer that already belongs to
 * another handle is refused (one computer, one address).
 */
export async function joinWithPairCode(opts: EnrolOptions & { handle: string; code: string }): Promise<JoinResult> {
  const handle = parseHandle(opts.handle);
  if (!handle) throw new JoinError(`"${opts.handle}" is not a Morse address (e.g. k7f3a9xq or morse.im/k7f3a9xq)`, 'bad_handle');
  const code = normalizePairCode(opts.code);
  if (!code) throw new JoinError(`that does not look like a pairing code (${PAIR_CODE_LENGTH} letters/digits, e.g. abcde-fghjk) — run \`morse agent add\` on a computer that is already morse.im/${handle}`, 'pair_invalid');
  const agent = agentOf(opts.agent);
  const home = opts.home ?? morseHome();
  const identity = loadOrCreateIdentity(home);
  if (opts.probe !== false) {
    let member: { handle: string | null } | 'not-member' | null = null;
    try {
      member = await probeMembership(opts.url, identity, opts.timeoutMs);
    } catch {
      /* unreachable over WebSocket — the HTTP join reports it */
    }
    if (member && member !== 'not-member' && member.handle && member.handle !== handle) {
      saveRelayMembership(opts.url, member.handle, home);
      throw new JoinError(`this computer already is morse.im/${member.handle} — one computer belongs to one address`, 'device_taken');
    }
    if (member && member !== 'not-member' && member.handle === handle) return (await ifAlreadyMember(opts, identity, home, agent))!;
  }
  const ts = Date.now();
  return enrol(opts, '/v1/join', { handle, code, ts, sig: signJoin(identity, ts, code, agent) }, identity, home, agent);
}

function agentTakenHint(message: string, code: string, handle: string | null): string {
  if (code !== 'agent_taken') return message;
  return `${message}${handle ? ` (on morse.im/${handle})` : ''} — choose another name: --agent <name>, or after joining: morse agent add <name>`;
}

// --- admin ----------------------------------------------------------------------

export interface InviteInfo {
  id: string;
  handle: string;
  uses: number;
  expiresAt: number;
  createdAt: number;
  note?: string;
}

async function admin<T>(url: string, key: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetchRelay(url, path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`cannot reach the relay at ${relayHttpBase(url)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* plain-text error */
  }
  if (res.status === 401) throw new Error(`the relay rejected the admin key (${ADMIN_KEY_ENV})`);
  if (res.status === 404 && !parsed) throw new Error('the relay has no admin API (its ADMIN_KEY secret is not set) or is too old for invites');
  if (!res.ok) throw new Error((parsed as { error?: string } | null)?.error ?? `relay answered HTTP ${res.status}: ${text.slice(0, 200)}`);
  return parsed as T;
}

export function adminKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[ADMIN_KEY_ENV]?.trim();
  if (!key) throw new Error(`set ${ADMIN_KEY_ENV} to the relay's ADMIN_KEY first (it is read from the environment and never saved)`);
  return key;
}

export const createInvite = (url: string, key: string, req: { handle: string; uses?: number; ttlSec?: number; note?: string }) =>
  admin<InviteInfo & { code: string; existingDevices?: number }>(url, key, 'POST', '/admin/invites', req);

export const listInvites = (url: string, key: string) => admin<{ invites: InviteInfo[] }>(url, key, 'GET', '/admin/invites').then((r) => r.invites);

export const revokeInvite = (url: string, key: string, id: string) =>
  admin<{ removed: boolean }>(url, key, 'DELETE', `/admin/invites/${encodeURIComponent(id)}`).then((r) => r.removed);

/** The copy-paste line for the person being invited. */
export function installCommand(code: string, site: string = DEFAULT_SITE_URL): string {
  return `curl -fsSL ${site.replace(/\/+$/, '')}/install.sh | bash -s -- ${code}`;
}
