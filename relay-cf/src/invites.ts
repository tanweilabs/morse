import { putDevice, allowEntry, type AllowKV } from './allowlist.js';
import { base32, sha256Hex, verifyJoin } from './crypto.js';
import { JOIN_MAX_SKEW_MS, RESERVED_HANDLES, normalizeAgent, normalizeHandle } from './protocol.js';

/**
 * Invites (ADR-032): the relay admin mints a code for a handle; a new device
 * redeems it with POST /v1/join and is added to that handle's allowlist — no
 * device ID copied around by hand.
 *
 * Storage (the InviteBook Durable Object — strongly consistent, so a one-use code
 * really is one use; Workers KV is eventually consistent and could be raced):
 *
 *   inv:<sha256(code)> → {id, handle, uses, expiresAt, createdAt, note?}
 *
 * Only the HASH of a code is stored: the code itself is shown once, at creation.
 * `id` (first 12 hex chars of the hash) names an invite in list / revoke.
 * A code is 32 base32 characters = 160 random bits; a used-up or expired invite is
 * deleted. Everything here is runtime-agnostic (WebCrypto only) and takes its
 * storage as a parameter so the tests can run it in Node.
 */

export interface InviteRecord {
  id: string;
  handle: string;
  /** Redemptions left. */
  uses: number;
  expiresAt: number;
  createdAt: number;
  note?: string;
}

/** The subset of DurableObjectStorage we use (a Map-backed fake in tests). */
export interface InviteStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export const INVITE_CODE_LENGTH = 32;
export const DEFAULT_INVITE_USES = 1;
export const MAX_INVITE_USES = 100;
export const DEFAULT_INVITE_TTL_SEC = 7 * 86_400;
export const MAX_INVITE_TTL_SEC = 90 * 86_400;

const PREFIX = 'inv:';

export interface Outcome {
  status: number;
  body: Record<string, unknown>;
}
const fail = (status: number, code: string, error: string): Outcome => ({ status, body: { error, code } });

/** Accept what a human pastes: any case, spaces or dashes. null = not a code. */
export function normalizeInviteCode(input: string): string | null {
  const c = input.trim().toLowerCase().replace(/[\s-]/g, '');
  return c.length === INVITE_CODE_LENGTH && /^[a-z2-7]+$/.test(c) ? c : null;
}

export function newInviteCode(): string {
  return base32(crypto.getRandomValues(new Uint8Array(20))).toLowerCase(); // 160 bits → 32 chars
}

const keyOf = async (code: string) => `${PREFIX}${await sha256Hex(code)}`;

export async function createInvite(
  store: InviteStorage,
  req: unknown,
  now = Date.now(),
  reserved: readonly string[] = RESERVED_HANDLES,
): Promise<Outcome> {
  const r = (req ?? {}) as { handle?: unknown; uses?: unknown; ttlSec?: unknown; note?: unknown };
  const handle = typeof r.handle === 'string' ? normalizeHandle(r.handle) : null;
  if (!handle) return fail(400, 'bad_handle', 'bad handle (2–32 of a-z 0-9 - _)');
  // a reserved name (admin, support, …) is never handed out, not even by mistake (ADR-036)
  if (reserved.includes(handle)) return fail(400, 'reserved_handle', `"${handle}" is a reserved name`);
  const uses = r.uses === undefined ? DEFAULT_INVITE_USES : Number(r.uses);
  if (!Number.isInteger(uses) || uses < 1 || uses > MAX_INVITE_USES) return fail(400, 'bad_uses', `uses must be 1–${MAX_INVITE_USES}`);
  const ttlSec = r.ttlSec === undefined ? DEFAULT_INVITE_TTL_SEC : Number(r.ttlSec);
  if (!Number.isFinite(ttlSec) || ttlSec < 1 || ttlSec > MAX_INVITE_TTL_SEC) return fail(400, 'bad_ttl', `ttl must be 1 s – ${MAX_INVITE_TTL_SEC / 86_400} days`);
  const note = typeof r.note === 'string' ? r.note.replace(/[\u0000-\u001f]/g, ' ').slice(0, 120) : '';

  const code = newInviteCode();
  const key = await keyOf(code);
  const record: InviteRecord = {
    id: key.slice(PREFIX.length, PREFIX.length + 12),
    handle,
    uses,
    expiresAt: now + Math.round(ttlSec * 1000),
    createdAt: now,
    ...(note ? { note } : {}),
  };
  await store.put(key, record);
  return { status: 200, body: { code, ...record } };
}

/** Live invites (expired ones are deleted on the way). Codes are never returned — only hashes are kept. */
export async function listInvites(store: InviteStorage, now = Date.now()): Promise<InviteRecord[]> {
  const all = await store.list<InviteRecord>({ prefix: PREFIX });
  const live: InviteRecord[] = [];
  for (const [key, inv] of all) {
    if (inv.expiresAt <= now || inv.uses <= 0) await store.delete(key);
    else live.push(inv);
  }
  return live.sort((a, b) => a.createdAt - b.createdAt);
}

export async function revokeInvite(store: InviteStorage, id: string): Promise<boolean> {
  const want = id.trim().toLowerCase();
  if (!/^[0-9a-f]{6,64}$/.test(want)) return false;
  for (const [key, inv] of await store.list<InviteRecord>({ prefix: PREFIX })) {
    if (inv.id === want || key.slice(PREFIX.length).startsWith(want)) return store.delete(key);
  }
  return false;
}

export interface JoinRequest {
  code: string;
  /** base64 DER of the device certificate (its fingerprint is the device ID). */
  cert: string;
  /** ms since epoch, signed — must be within JOIN_MAX_SKEW_MS of the relay. */
  ts: number;
  /** base64 Ed25519 over JOIN_CONTEXT\n<ts>\n<normalised code>[\n<agent>]. */
  sig: string;
  /** Optional device label for the directory ("mac-mini"). */
  name?: string;
  /** Agent to register on this device (ADR-033), e.g. "mini" → morse.im/<handle>/mini. */
  agent?: string;
}

/** Registers an agent in a handle's AgentBook (a DO stub in the Worker, a fake in tests). */
export interface AgentRegistrar {
  register(handle: string, agent: string, device: string, dryRun: boolean): Promise<Outcome>;
}

/** Register the join's agent; a failure here does not undo the join — it is reported. */
export async function registerJoinAgent(agents: AgentRegistrar | undefined, handle: string, agent: string | null, id: string): Promise<Record<string, unknown>> {
  if (!agent || !agents) return {};
  try {
    const r = await agents.register(handle, agent, id, false);
    return r.status === 200 ? { agent } : { agentError: String(r.body['error'] ?? `HTTP ${r.status}`), agentErrorCode: r.body['code'] };
  } catch (e) {
    return { agentError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Redeem an invite. Run it serialised (the InviteBook does, via
 * blockConcurrencyWhile) so two devices can never split one remaining use.
 *
 *  - bad shape 400 · clock off 400 · bad signature 401 · unknown / used / expired code 404
 *  - device already on the allowlist under THIS handle → 200 {already:true}, the invite is NOT used
 *  - device already under ANOTHER handle → 409 (an admin moves devices, an invite does not)
 *  - otherwise: one use is taken, the device is added under the invite's handle → 200
 *  - with `agent` (ADR-033): a name another device of the handle already hosts → 409
 *    agent_taken BEFORE the use is taken; after joining, the agent is registered on
 *    this device (a late failure comes back as agentError, the join stands)
 */
export async function redeemInvite(store: InviteStorage, kv: AllowKV, req: unknown, now = Date.now(), agents?: AgentRegistrar): Promise<Outcome> {
  const r = (req ?? {}) as Partial<Record<keyof JoinRequest, unknown>>;
  if (typeof r.code !== 'string' || typeof r.cert !== 'string' || typeof r.sig !== 'string' || typeof r.ts !== 'number') {
    return fail(400, 'bad_request', 'expected {code, cert, ts, sig, name?, agent?}');
  }
  const agent = r.agent === undefined || r.agent === '' ? null : typeof r.agent === 'string' ? normalizeAgent(r.agent) : null;
  if (r.agent !== undefined && r.agent !== '' && !agent) return fail(400, 'bad_agent', `"${String(r.agent)}" is not a valid agent name (1–32 of a-z 0-9 -)`);
  const code = normalizeInviteCode(r.code);
  if (!code) return fail(404, 'invite_invalid', 'invite code is invalid, used up, or expired');
  if (Math.abs(now - r.ts) > JOIN_MAX_SKEW_MS) return fail(400, 'clock_skew', 'this computer’s clock is more than 10 minutes off — fix the time and retry');
  const id = await verifyJoin(r.cert, r.ts, code, r.sig, agent ?? undefined);
  if (!id) return fail(401, 'bad_signature', 'device signature invalid');

  const key = await keyOf(code);
  const invite = await store.get<InviteRecord>(key);
  if (!invite || invite.expiresAt <= now || invite.uses <= 0) {
    if (invite) await store.delete(key);
    return fail(404, 'invite_invalid', 'invite code is invalid, used up, or expired');
  }
  const existing = await allowEntry(kv, id);
  if (existing?.handle === invite.handle) {
    return { status: 200, body: { id, handle: invite.handle, name: existing.name ?? '', already: true, ...(await registerJoinAgent(agents, invite.handle, agent, id)) } };
  }
  if (existing?.handle) {
    return fail(409, 'device_taken', `this device already belongs to morse.im/${existing.handle} — ask the relay admin to move it`);
  }
  if (agent && agents) {
    // a taken agent name refuses the join BEFORE the invite is spent: pick another name, same code
    const check = await agents.register(invite.handle, agent, id, true);
    if (check.status !== 200) return check;
  }

  const name = typeof r.name === 'string' ? r.name.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : '';
  // take the use first (storage), then write the allowlist (KV); refund if KV fails
  if (invite.uses > 1) await store.put(key, { ...invite, uses: invite.uses - 1 });
  else await store.delete(key);
  try {
    await putDevice(kv, id, { handle: invite.handle, name, addedAt: new Date(now).toISOString(), via: `invite:${invite.id}` });
  } catch (e) {
    await store.put(key, invite);
    return fail(503, 'allowlist_unavailable', `could not write the allowlist (${e instanceof Error ? e.message : String(e)}) — retry`);
  }
  return { status: 200, body: { id, handle: invite.handle, name, ...(await registerJoinAgent(agents, invite.handle, agent, id)) } };
}
