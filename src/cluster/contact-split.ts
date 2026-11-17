import { addressOfCert } from '../identity/device-address.js';
import type { ContactStore, SplitEntry } from '../mailbox/contacts.js';
import { defaultAgentName, normalizeAgentName } from './agents.js';
import type { AgentLocation, AliasEntry, HandleDevice } from './relay-client.js';
import type { TrustStore } from './trust.js';

/**
 * The online half of the identity v3 phase 2 migration (ADR-077, spec §12.3 steps 2–3),
 * run by the daemon after it logged in to the relay — and again later while anything is
 * left to do. For every contact by old handle still marked `split = pending`:
 *
 *   1. ask the relay which agents live under that handle and at which address — the frozen
 *      alias table (v3 `alias`), else the v2 directory (the default agent, plus every agent
 *      name seen here; a device's address is computed from its certificate);
 *   2. put the default agent's address on the contact, and make one contact per other agent
 *      that is on ANOTHER address (ContactStore.applySplit — one transaction per contact).
 *
 * Then: every other computer under YOUR OWN handle that is paired here as `owner` becomes a
 * contact in group `self`, named after its agent.
 *
 * The relay's answers are NOT trusted (ADR-077 D): an entry only counts when its address is the
 * address of a device certificate this computer holds for a device it trusts under that very
 * handle (pinned in peer-keys.json, or the relay's key bundle for a device ID in the trust
 * list — the ID is the certificate's fingerprint). Every entry is checked on its own; what the
 * relay adds beyond that is only the agent NAME of such a device and which one is the default.
 * So a wrong or malicious answer cannot attach a stranger's address to a contact, and an
 * address recorded for one contact is never moved to another (ContactStore.applySplit).
 *
 * Nothing is decided when the relay cannot be asked: the contact stays pending and works
 * exactly as before (routing still goes by its handle). Every step is safe to repeat. The v2
 * fallback is bounded: at most MAX_AGENT_NAMES names per contact, MAX_RUN_MS per run.
 */

/** Agent names of one contact tried against the v2 directory (most recently seen first). */
export const MAX_AGENT_NAMES = 8;
/** One run stops asking after this long; what is left stays pending for the next run. */
export const MAX_RUN_MS = 60_000;

export interface SplitDeps {
  contacts: ContactStore;
  selfHandle: () => string | null;
  selfDeviceId: string;
  trust: Pick<TrustStore, 'get' | 'list'>;
  /** The VERIFIED address of a trusted device: from its pinned certificate (null = not pinned here). */
  pinned: (deviceId: string) => string | null;
  /** The v3 `alias` query; absent or rejecting = the relay has no alias table. */
  lookupAlias?: (name: string) => Promise<AliasEntry[]>;
  resolveAgent: (handle: string, agent?: string) => Promise<AgentLocation | null>;
  lookupHandle: (handle: string) => Promise<HandleDevice[]>;
  log?: (line: string) => void;
  now?: () => number;
  maxRunMs?: number;
}

export interface SplitOutcome {
  /** Contacts checked with the relay in this run. */
  done: number;
  /** Contacts created for other agents of a handle. */
  created: string[];
  /** Contacts still waiting (the relay could not be asked). */
  pending: number;
  /** Own computers that became (or were completed as) `self` contacts in this run. */
  ownDevices: number;
}

/** The address of the certificate in a relay key bundle — only when it hashes to that device ID. */
const addressOf = (d: HandleDevice | undefined | null): string | null => (d?.bundle?.cert ? addressOfCert(d.bundle.cert, d.id) : null);

export async function completeContactSplit(deps: SplitDeps): Promise<SplitOutcome> {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.maxRunMs ?? MAX_RUN_MS);
  const out: SplitOutcome = { done: 0, created: [], pending: 0, ownDevices: 0 };
  let aliases = Boolean(deps.lookupAlias);
  let throttled = false;
  const alias = async (name: string): Promise<AliasEntry[] | null> => {
    if (!aliases || !deps.lookupAlias) return null;
    try {
      return await deps.lookupAlias(name);
    } catch (e) {
      // the relay's limit on alias lookups: stop asking in this run — the rest stays pending
      if (/rate limited/.test(e instanceof Error ? e.message : String(e))) {
        throttled = true;
        throw e;
      }
      aliases = false; // an older relay, or the v3 connection is down: the v2 directory instead
      return null;
    }
  };

  for (const c of deps.contacts.pendingSplits()) {
    if (throttled || now() > deadline) {
      out.pending++;
      continue;
    }
    const handle = c.handle!;
    // what THIS computer knows: the devices it trusts under that handle, and their certificates' addresses
    const trusted = deps.trust.list().filter((d) => d.tier === 'peer' && d.name.toLowerCase() === handle);
    const verified = new Map<string, string>(); // address → device ID
    for (const d of trusted) {
      const a = deps.pinned(d.id);
      if (a) verified.set(a, d.id);
    }
    let entries: SplitEntry[] | null | undefined;
    try {
      if (trusted.some((d) => !deps.pinned(d.id))) {
        // a trusted device whose certificate is not pinned yet: the relay's key bundle, checked against its ID
        for (const d of await deps.lookupHandle(handle)) {
          const a = trusted.some((t) => t.id === d.id) ? addressOf(d) : null;
          if (a) verified.set(a, d.id);
        }
      }
      const ours = (e: { agent: string; address: string; default?: boolean }): SplitEntry[] =>
        verified.has(e.address) ? [{ agent: e.agent, address: e.address, ...(e.default ? { default: true } : {}), deviceId: verified.get(e.address)! }] : [];
      const fromAlias = await alias(handle);
      if (fromAlias?.length) {
        entries = fromAlias.flatMap(ours);
        const ignored = fromAlias.length - entries.length;
        if (ignored && verified.size) log(`morse: contact ${handle}: ${ignored} address(es) the relay lists under that name are not devices paired here — ignored`);
      } else {
        const def = await deps.resolveAgent(handle);
        if (!def) entries = null; // the relay knows no agent by that handle: nothing to split
        else {
          const a = addressOf(def.device);
          entries = a ? ours({ agent: def.agent, address: a, default: true }) : [];
          const covered = new Set(entries.map((e) => e.address));
          for (const name of c.agents.slice(0, MAX_AGENT_NAMES)) {
            if (covered.size >= verified.size || now() > deadline) break; // every device of theirs has its name
            const agent = normalizeAgentName(name);
            if (!agent || agent === def.agent) continue;
            const loc = await deps.resolveAgent(handle, agent);
            const address = loc ? addressOf(loc.device) : null;
            if (!loc || !address || covered.has(address)) continue;
            const e = ours({ agent: loc.agent, address });
            if (e.length) covered.add(address);
            entries.push(...e);
          }
        }
      }
    } catch {
      entries = undefined; // the relay did not answer: next time
    }
    if (entries === undefined) {
      out.pending++;
      continue;
    }
    try {
      const created = deps.contacts.applySplit(c.id, entries);
      out.done++;
      out.created.push(...created);
      if (created.length) log(`morse: contact morse.im/${handle} — ${created.length} more agent(s) of theirs became contacts of their own: ${created.map((id) => id.replace(/^c:/, '')).join(', ')} (same group; rename with morse contact set)`);
    } catch (e) {
      out.pending++;
      log(`morse: contact morse.im/${handle} could not be split by address yet: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // your own other computers → contacts in group self (owner decision 2026-11-14)
  const me = deps.selfHandle()?.toLowerCase();
  if (me && !throttled && now() <= deadline) {
    try {
      const found = await deps.lookupHandle(me);
      // only devices this computer already trusts as its owner's; the address is the certificate's, checked against the ID
      const mine = found.filter((d) => d.id !== deps.selfDeviceId && deps.trust.get(d.id)?.tier === 'owner');
      if (mine.length) {
        const byAddress = new Map<string, string>();
        for (const e of (await alias(me)) ?? []) if (!byAddress.has(e.address)) byAddress.set(e.address, e.agent);
        const seen = deps.contacts.self().agents;
        for (const d of mine) {
          const address = deps.pinned(d.id) ?? addressOf(d);
          if (!address) continue;
          let agent = byAddress.get(address) ?? null;
          if (!agent) {
            // no alias table: the agent names we know of, checked against the v2 directory
            for (const guess of [...new Set([defaultAgentName(d.name), ...seen])].slice(0, MAX_AGENT_NAMES)) {
              const name = normalizeAgentName(guess);
              if (!name || now() > deadline) continue;
              try {
                if ((await deps.resolveAgent(me, name))?.device.id === d.id) {
                  agent = name;
                  break;
                }
              } catch {
                break;
              }
            }
          }
          const before = deps.contacts.ownDevice(address);
          const c = deps.contacts.ensureOwnDevice({ deviceId: d.id, address, ...(agent ? { handle: me, agent } : {}), name: agent ?? defaultAgentName(d.name) });
          if (c && c.origin === 'own-device' && (!before || before.handle !== c.handle || before.remark !== c.remark)) {
            out.ownDevices++;
            if (!before) log(`morse: your computer ${c.remark ?? d.name} (${address.slice(0, 7)}) is now a contact in group self — same trust as before (morse contact)`);
          }
        }
      }
    } catch {
      /* the directory did not answer: on the next login */
    }
  }
  return out;
}
