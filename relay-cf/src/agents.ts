import { normalizeAgent, normalizeNickname } from './protocol.js';

/**
 * The agent directory of ONE person (ADR-033): morse.im/<handle>/<agent> → the
 * single device that hosts that agent. A message to an agent goes to that device
 * only — no fan-out. `morse.im/<handle>` with no agent means the person's
 * DEFAULT agent: the first one registered, changeable with `morse agent default`.
 *
 * Storage (the AgentBook Durable Object for that handle, `idFromName(handle)` —
 * strongly consistent and serialised, so "a name is unique within a handle" and
 * "rename is atomic" hold even when two devices race):
 *
 *   agent:<name> → {agent, device, addedAt}
 *   default      → <name>
 *   profile      → {nickname, updatedAt, by}      display nickname (ADR-036), not unique
 *
 * Runtime-agnostic (no Workers APIs): takes its storage as a parameter so the tests
 * run it in Node against a Map. `isMember(device)` answers "is this device still on
 * the allowlist under this handle?" — a name held by a device that has since been
 * removed may be taken over (otherwise a wiped computer would lock its name forever).
 */

export interface AgentRecord {
  agent: string;
  device: string;
  addedAt: number;
}

/** The subset of DurableObjectStorage used here (a Map-backed fake in tests). */
export interface AgentStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

/** Most agents one person may register (all devices together). */
export const MAX_AGENTS_PER_HANDLE = 64;

const PREFIX = 'agent:';
const DEFAULT_KEY = 'default';
const fail = (status: number, code: string, error: string): Outcome => ({ status, body: { error, code } });
const badName = (raw: unknown) =>
  fail(400, 'bad_agent', `"${String(raw)}" is not a valid agent name (1–32 of a-z 0-9 -, not "user" or "inbox")`);

async function all(store: AgentStorage): Promise<AgentRecord[]> {
  return [...(await store.list<AgentRecord>({ prefix: PREFIX })).values()].sort((a, b) => a.addedAt - b.addedAt || a.agent.localeCompare(b.agent));
}

async function defaultName(store: AgentStorage): Promise<string | null> {
  return (await store.get<string>(DEFAULT_KEY)) ?? null;
}

/** After a removal: the default moves to the earliest remaining agent (or is cleared). */
async function repairDefault(store: AgentStorage): Promise<string | null> {
  const current = await defaultName(store);
  if (current && (await store.get<AgentRecord>(PREFIX + current))) return current;
  const first = (await all(store))[0];
  if (first) {
    await store.put(DEFAULT_KEY, first.agent);
    return first.agent;
  }
  await store.delete(DEFAULT_KEY);
  return null;
}

/**
 * Register `agent` on `device`. Idempotent for the device that already hosts it.
 * 409 agent_taken when another (still allowlisted) device of the person hosts it.
 * dryRun: only check (used by a join before it spends the invite).
 */
export async function registerAgent(
  store: AgentStorage,
  req: { agent: unknown; device: string },
  isMember: (device: string) => Promise<boolean>,
  opts: { now?: number; dryRun?: boolean } = {},
): Promise<Outcome> {
  const agent = typeof req.agent === 'string' ? normalizeAgent(req.agent) : null;
  if (!agent) return badName(req.agent);
  const existing = await store.get<AgentRecord>(PREFIX + agent);
  if (existing?.device === req.device) {
    return { status: 200, body: { agent, device: req.device, default: await defaultName(store), already: true } };
  }
  if (existing && (await isMember(existing.device))) {
    return fail(409, 'agent_taken', `the name "${agent}" is already used by another device of this person`);
  }
  const records = await all(store);
  if (!existing && records.length >= MAX_AGENTS_PER_HANDLE) {
    return fail(409, 'too_many_agents', `at most ${MAX_AGENTS_PER_HANDLE} agents per person`);
  }
  if (opts.dryRun) return { status: 200, body: { agent, device: req.device, available: true } };
  // Agents are listed in the order they were registered (and the default falls to the earliest):
  // a registration in the same millisecond as the one before it must still come after it —
  // on equal times the list would fall back to the names' alphabetical order.
  const latest = records.reduce((t, r) => Math.max(t, r.addedAt), 0);
  const addedAt = Math.max(opts.now ?? Date.now(), latest + 1);
  await store.put(PREFIX + agent, { agent, device: req.device, addedAt } satisfies AgentRecord);
  // the person's first agent becomes the default (also if the default pointed at a name that is gone)
  const current = await defaultName(store);
  if (!current || !(await store.get<AgentRecord>(PREFIX + current))) await store.put(DEFAULT_KEY, agent);
  return { status: 200, body: { agent, device: req.device, default: await defaultName(store), ...(existing ? { tookOver: existing.device } : {}) } };
}

/** Remove an agent — only the device hosting it may. The default moves on if needed. */
export async function removeAgent(store: AgentStorage, req: { agent: unknown; device?: string }): Promise<Outcome> {
  const agent = typeof req.agent === 'string' ? normalizeAgent(req.agent) : null;
  if (!agent) return badName(req.agent);
  const existing = await store.get<AgentRecord>(PREFIX + agent);
  if (!existing) return fail(404, 'no_agent', `no agent called "${agent}"`);
  if (req.device && existing.device !== req.device) return fail(403, 'not_your_agent', `"${agent}" is hosted on another device — remove it there`);
  await store.delete(PREFIX + agent);
  return { status: 200, body: { agent, removed: true, default: await repairDefault(store) } };
}

/**
 * Rename an agent hosted by `device`, atomically: the new name appears, the old one
 * is gone (no forwarding), and the default follows. 409 when the new name is taken.
 */
export async function renameAgent(
  store: AgentStorage,
  req: { agent: unknown; to: unknown; device: string },
  isMember: (device: string) => Promise<boolean>,
): Promise<Outcome> {
  const from = typeof req.agent === 'string' ? normalizeAgent(req.agent) : null;
  if (!from) return badName(req.agent);
  const to = typeof req.to === 'string' ? normalizeAgent(req.to) : null;
  if (!to) return badName(req.to);
  const existing = await store.get<AgentRecord>(PREFIX + from);
  if (!existing) return fail(404, 'no_agent', `no agent called "${from}"`);
  if (existing.device !== req.device) return fail(403, 'not_your_agent', `"${from}" is hosted on another device — rename it there`);
  if (from === to) return { status: 200, body: { agent: to, from, default: await defaultName(store), already: true } };
  const taken = await store.get<AgentRecord>(PREFIX + to);
  if (taken && (taken.device === req.device || (await isMember(taken.device)))) {
    return fail(409, 'agent_taken', `the name "${to}" is already used${taken.device === req.device ? ' on this device' : ' by another device of this person'}`);
  }
  const wasDefault = (await defaultName(store)) === from;
  // no await on anything but storage between these writes: a Durable Object
  // coalesces them into one atomic batch (and the AgentBook runs this serialised)
  await store.put(PREFIX + to, { ...existing, agent: to } satisfies AgentRecord);
  await store.delete(PREFIX + from);
  if (wasDefault) await store.put(DEFAULT_KEY, to);
  return { status: 200, body: { agent: to, from, default: await repairDefault(store) } };
}

/** Make `agent` the person's default (what morse.im/<handle> reaches). Any device of the person may. */
export async function setDefaultAgent(store: AgentStorage, req: { agent: unknown }): Promise<Outcome> {
  const agent = typeof req.agent === 'string' ? normalizeAgent(req.agent) : null;
  if (!agent) return badName(req.agent);
  if (!(await store.get<AgentRecord>(PREFIX + agent))) return fail(404, 'no_agent', `no agent called "${agent}"`);
  await store.put(DEFAULT_KEY, agent);
  return { status: 200, body: { agent, default: agent } };
}

/** Which device hosts `agent` (undefined / '' = the default agent). null = none. */
export async function resolveAgent(store: AgentStorage, agent?: string | null): Promise<AgentRecord | null> {
  const name = agent ? normalizeAgent(agent) : await defaultName(store);
  if (!name) return null;
  return (await store.get<AgentRecord>(PREFIX + name)) ?? null;
}

export async function listAgents(store: AgentStorage): Promise<{ default: string | null; agents: AgentRecord[] }> {
  return { default: await defaultName(store), agents: await all(store) };
}

/** A device left the allowlist (admin removal): its agents go with it. */
export async function dropDevice(store: AgentStorage, device: string): Promise<string[]> {
  const gone: string[] = [];
  for (const r of await all(store)) {
    if (r.device === device) {
      await store.delete(PREFIX + r.agent);
      gone.push(r.agent);
    }
  }
  if (gone.length) await repairDefault(store);
  return gone;
}

// --- profile: the handle's display nickname (ADR-036) ----------------------------

const PROFILE_KEY = 'profile';

export interface Profile {
  nickname: string;
  updatedAt: number;
  /** The device that set it. */
  by: string;
}

export async function getNickname(store: AgentStorage): Promise<string | null> {
  return (await store.get<Profile>(PROFILE_KEY))?.nickname || null;
}

/** Set (or with '' clear) the nickname. Any device of the person may (the caller checked membership). */
export async function setNickname(store: AgentStorage, req: { nickname: unknown; device: string }, now = Date.now()): Promise<Outcome> {
  const nickname = normalizeNickname(req.nickname);
  if (nickname === null) return fail(400, 'bad_nickname', 'nickname must be text (up to 32 characters)');
  if (!nickname) await store.delete(PROFILE_KEY);
  else await store.put(PROFILE_KEY, { nickname, updatedAt: now, by: req.device } satisfies Profile);
  return { status: 200, body: { nickname: nickname || null } };
}

/** Admin released the handle: forget every agent, the default and the nickname. */
export async function resetBook(store: AgentStorage): Promise<string[]> {
  const gone = (await all(store)).map((r) => r.agent);
  for (const a of gone) await store.delete(PREFIX + a);
  await store.delete(DEFAULT_KEY);
  await store.delete(PROFILE_KEY);
  return gone;
}
