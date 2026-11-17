import { isAddress } from './address.js';
import { ALIAS_PREFIX } from './allowlist.js';

/**
 * The frozen old-alias table (identity v3 P2 — docs/specs/identity-v3.zh-CN.md §7, §10.2,
 * §12.3 step 4). The v2 names — a readable name or an 8-character random handle
 * (`alice`), and `alice/air` (handle/agent) — stop being identities in v3, but the links
 * people already handed out (`morse.im/alice`, `morse.im/alice/air`) must keep resolving.
 * So each one is frozen as an alias of the v3 address of the agent it used to mean:
 *
 *   alias:<handle>  →  {"v":1, "handle":"alice", "default":"mini" | null,
 *                       "agents":{"mini":"<26-char address>", "air":"<address>"}}
 *
 * one record per handle, in the ALLOWLIST KV namespace. The table is built ONCE by the
 * relay admin from the relay's own data (KV allowlist + AgentBook + device certificates;
 * the address of a computer's agents is computed from its device key) with
 * scripts/aliases-export.mjs — which also verifies it — and loaded with
 * `wrangler kv bulk put`. The Worker only ever READS these keys: there is no route, frame
 * or admin call that writes one, so an alias cannot be re-pointed through the relay's API.
 *
 * Queries (same answer on both):
 *
 *   WS (v3 connection)  {type:"alias", rid, name} → {type:"alias", rid, name, entries:[…]}
 *                                                 | {type:"error", rid, error:"bad alias name"}
 *   HTTP                GET /v3/alias/<handle>[/<agent>] → {name, entries}   (404 when empty)
 *
 *   entries = [{name, address, agent, default?:true}]
 *   · `handle/agent` → 0 or 1 entry, named `handle/agent` (default:true when it is the
 *     handle's default agent);
 *   · bare `handle`  → every agent of the handle: the default agent first, under the bare
 *     name (`{name:"alice", agent:"mini", default:true}`), then the rest by agent name as
 *     `alice/<agent>`. A handle without a default has no default:true entry;
 *   · a name nobody had → `entries: []` (not an error).
 *
 * Two agents hosted by the same computer have the same address (the device key's).
 * Runtime-agnostic: pure functions, and a KV read that tests replace with a Map.
 */

export interface AliasRecord {
  v: 1;
  handle: string;
  /** The agent the bare handle meant; null when the handle had none. Always a key of `agents`. */
  default: string | null;
  /** agent name → v3 address. */
  agents: Record<string, string>;
}

export interface AliasEntry {
  name: string;
  address: string;
  agent: string;
  default?: true;
}

export interface AliasName {
  handle: string;
  agent?: string;
}

export interface AliasAnswer {
  /** The normalized name that was asked for: `handle` or `handle/agent`. */
  name: string;
  entries: AliasEntry[];
}

/** The only KV call the lookup makes. */
export interface AliasKV {
  get(key: string, type: 'json'): Promise<unknown>;
}

// the v2 name rules (protocol.ts normalizeHandle / normalizeAgent), frozen with the table
const HANDLE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const AGENT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// `https://morse.im/`, `morse.im/`, `morse.talk/`, any `<host>.<tld>/` — as the client's stripAddressHost
const HOST_PREFIX = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+\/|[a-z0-9.-]+\.[a-z]{2,}\/)/;
const MAX_INPUT = 256;

export const aliasKey = (handle: string): string => ALIAS_PREFIX + handle;

/**
 * An old name as typed or pasted — any case, a leading `@`, a `morse.im/` / `morse.talk/` /
 * `https://…/` prefix, trailing slashes — as {handle, agent?}; null when it is not one.
 */
export function normalizeAliasName(input: unknown): AliasName | null {
  if (typeof input !== 'string' || input.length > MAX_INPUT) return null;
  const s = input.trim().toLowerCase().replace(/^@/, '').replace(HOST_PREFIX, '').replace(/^@/, '').replace(/\/+$/, '');
  const parts = s.split('/');
  const [handle, agent] = parts;
  if (parts.length > 2 || !handle || !HANDLE.test(handle)) return null;
  if (agent === undefined) return { handle };
  return AGENT.test(agent) ? { handle, agent } : null;
}

export const aliasNameString = (n: AliasName): string => (n.agent ? `${n.handle}/${n.agent}` : n.handle);

/**
 * A stored record, checked strictly: version 1, a valid handle, valid agent names, every
 * address a well-formed (lowercase, 26-character) address, and a default that is one of
 * the agents. Anything else is null — a damaged record answers nothing, never a guess.
 */
export function parseAliasRecord(x: unknown): AliasRecord | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (r['v'] !== 1 || typeof r['handle'] !== 'string' || !HANDLE.test(r['handle'])) return null;
  const raw = r['agents'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const agents: Record<string, string> = {};
  for (const [agent, address] of Object.entries(raw as Record<string, unknown>)) {
    if (!AGENT.test(agent) || !isAddress(address)) return null;
    agents[agent] = address;
  }
  const def = r['default'];
  if (def !== null && (typeof def !== 'string' || !Object.hasOwn(agents, def))) return null;
  return { v: 1, handle: r['handle'], default: def, agents };
}

/** What a query for `handle` (no agent) or `handle/agent` answers from that handle's record. */
export function entriesFor(record: AliasRecord, agent?: string): AliasEntry[] {
  const { handle, agents } = record;
  const entry = (a: string, name: string): AliasEntry => ({ name, address: agents[a]!, agent: a, ...(a === record.default ? { default: true as const } : {}) });
  if (agent !== undefined) return Object.hasOwn(agents, agent) ? [entry(agent, `${handle}/${agent}`)] : [];
  const rest = Object.keys(agents)
    .filter((a) => a !== record.default)
    .sort()
    .map((a) => entry(a, `${handle}/${a}`));
  return record.default !== null ? [entry(record.default, handle), ...rest] : rest;
}

/**
 * Resolve an old name against the table. null = not a name at all ("bad alias name");
 * otherwise the normalized name and its entries — empty when nobody had that name, and
 * also when its record cannot be read or is malformed.
 */
export async function lookupAlias(kv: AliasKV, input: unknown): Promise<AliasAnswer | null> {
  const name = normalizeAliasName(input);
  if (!name) return null;
  let record: AliasRecord | null = null;
  try {
    record = parseAliasRecord(await kv.get(aliasKey(name.handle), 'json'));
  } catch {
    record = null;
  }
  // a record filed under another handle's key is not this handle's
  if (record && record.handle !== name.handle) record = null;
  return { name: aliasNameString(name), entries: record ? entriesFor(record, name.agent) : [] };
}
