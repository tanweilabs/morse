import { readFileSync } from 'node:fs';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { join } from 'node:path';
import { localAgents } from '../cluster/agents.js';
import type { DeviceIdentity } from '../cluster/identity.js';
import { morseHome } from '../home.js';
import { addressesDir, createAddressKey, listAddressKeys, loadPrimaryAddress, type AddressKey } from './address-key.js';
import { isAddress } from './address.js';

/**
 * One agent = one address (ADR-077, spec §12.3 step 1). The agents this computer hosts
 * (`relay.agents` in config.json — names that never leave this computer in v3) each have an
 * address: the FIRST agent the device key's (spec §12.2), every agent added later a key of
 * its own under ~/.morse/addresses/<address>/key.pem. Which agent has which address is kept
 * in ~/.morse/addresses/agents.json:
 *
 *   { "v": 1, "agents": { "mini": "<address>", "codex": "<address>" } }
 *
 * Written atomically (temp file + rename). Removing an agent only drops its entry — the key
 * directory stays (nothing is deleted), it is just no longer logged in.
 */

const FILE = 'agents.json';
const indexPath = (home: string) => join(addressesDir(home), FILE);

/**
 * agent name → address, as recorded. No file = {}. A file that cannot be read as this index
 * THROWS: carrying on would give every agent a fresh key (a new address) behind the owner's back.
 */
export function agentAddressIndex(home: string = morseHome()): Record<string, string> {
  const path = indexPath(home);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`cannot read ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  const damaged = (why: string) => new Error(`${path} is damaged (${why}) — it holds the names of your addresses here. Fix it or move it away (the keys in ${addressesDir(home)} are untouched); nothing was changed.`);
  let v: { agents?: unknown };
  try {
    v = JSON.parse(text) as { agents?: unknown };
  } catch {
    throw damaged('not JSON');
  }
  if (!v || typeof v !== 'object' || !v.agents || typeof v.agents !== 'object' || Array.isArray(v.agents)) throw damaged('no "agents" object');
  const out: Record<string, string> = {};
  for (const [agent, address] of Object.entries(v.agents as Record<string, unknown>)) {
    if (typeof address !== 'string' || !isAddress(address)) throw damaged(`"${agent}" has no valid address`);
    out[agent] = address;
  }
  return out;
}

function writeIndex(agents: Record<string, string>, home: string): void {
  const path = indexPath(home);
  writeFileAtomic(path, `${JSON.stringify({ v: 1, agents }, null, 2)}\n`, { mode: 0o600 });
}

export interface AgentAddress {
  agent: string;
  key: AddressKey;
  /** true = the device key's address (this computer's first). */
  primary: boolean;
}

/**
 * Every hosted agent with its address key, the computer's own agent first — giving any agent
 * that has none yet its address (the device key's when nobody has it, else a new key).
 * Idempotent; safe to call from the daemon and the CLI. No agents registered = [].
 */
export function ensureAgentAddresses(home: string = morseHome(), identity?: DeviceIdentity): AgentAddress[] {
  const { primary, agents } = localAgents(home);
  if (!agents.length) return [];
  const device = loadPrimaryAddress(home, identity);
  // the daemon and `morse agent add` may both get here: one of them at a time, or an agent gets two keys
  return withFileLock(indexPath(home), () => ensureLocked(home, identity, device, primary, agents));
}

function ensureLocked(home: string, identity: DeviceIdentity | undefined, device: AddressKey, primary: string | null, agents: string[]): AgentAddress[] {
  const keys = new Map(listAddressKeys(home, identity).map((k) => [k.address, k]));
  const before = agentAddressIndex(home); // throws on a damaged file: never re-key silently
  const next: Record<string, string> = {};
  const out: AgentAddress[] = [];
  const ordered = primary ? [primary, ...agents.filter((a) => a !== primary)] : agents;
  // agents that already have a (still present) key keep it — whoever holds the device address first
  for (const a of ordered) if (before[a] && keys.has(before[a]!) && !Object.values(next).includes(before[a]!)) next[a] = before[a]!;
  for (const a of ordered) {
    if (next[a]) continue;
    if (!Object.values(next).includes(device.address)) next[a] = device.address;
    else {
      const k = createAddressKey(home);
      keys.set(k.address, k);
      next[a] = k.address;
    }
  }
  for (const a of ordered) out.push({ agent: a, key: keys.get(next[a]!)!, primary: next[a] === device.address });
  if (JSON.stringify(before) !== JSON.stringify(next)) writeIndex(next, home);
  return out.sort((x, y) => Number(y.primary) - Number(x.primary));
}

/** `morse agent rename`: the address follows the agent to its new name. */
export function renameAgentAddress(from: string, to: string, home: string = morseHome()): void {
  withFileLock(indexPath(home), () => {
    const index = agentAddressIndex(home);
    if (!index[from] || index[to]) return;
    writeIndex(Object.fromEntries(Object.entries(index).map(([a, addr]) => [a === from ? to : a, addr])), home);
  });
}

/** The agent an address of this computer belongs to. */
export function agentOfAddress(address: string, home: string = morseHome()): string | null {
  return Object.entries(agentAddressIndex(home)).find(([, a]) => a === address)?.[0] ?? null;
}
