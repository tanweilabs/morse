import { join } from 'node:path';
import { morseHome, dataDir } from '../home.js';
import { readMachineConfig } from '../machine-config.js';
import { localAgents } from '../cluster/agents.js';
import { blockedHandles, isBlocked } from '../cluster/blocklist.js';
import { createTrustStore } from '../cluster/trust.js';
import { hasOtherAddressKeys, primaryAddressIfPresent } from '../identity/address-key.js';
import { agentAddressIndex } from '../identity/agent-addresses.js';
import { pinnedAddresses } from '../identity/device-address.js';
import type { ContactContext } from './contacts.js';

/** Who we are, read from a Morse home (~/.morse): own handle, device tiers, blocks (ADR-049). */
export function homeContactContext(home: string = morseHome()): ContactContext {
  const trust = createTrustStore(home);
  const config = () => readMachineConfig(join(dataDir(home), 'config.json'));
  /** (ADR-083) the device key's address — it never changes, so it is read once it exists */
  let first: string | null = null;
  return {
    firstAddress: () => {
      if (!first) {
        try {
          first = primaryAddressIfPresent(home);
        } catch {
          first = null;
        }
      }
      return first;
    },
    // (ADR-083 review R2) which address each agent of this computer has, as recorded on disk (read only; throws
    // when unreadable). (review N1) A computer that holds no key but the device's has ONE address, whatever
    // became of that record: there is no other address to name, so nothing is asked of a damaged file — as
    // before ADR-083, when such a computer went on working with its first address.
    ownAddresses: () => {
      try {
        return Object.values(agentAddressIndex(home));
      } catch (e) {
        if (!hasOtherAddressKeys(home)) return [];
        throw e;
      }
    },
    selfHandle: () => {
      const h = config().relay?.handle;
      return typeof h === 'string' && h ? h.toLowerCase() : null;
    },
    deviceTier: (name) => trust.list().find((d) => d.name.toLowerCase() === name.toLowerCase())?.tier,
    primaryAgent: () => localAgents(home).primary,
    isBlocked: (h) => isBlocked(h, home),
    blockedHandles: () => blockedHandles(home),
    peerNames: () => [...new Set(trust.list().filter((d) => d.tier === 'peer').map((d) => d.name.toLowerCase()))],
    // (ADR-091) any device whose certificate is pinned here (a stranger the relay confirmed included)
    pinnedAddress: (id) => pinnedAddresses(home).get(id) ?? null,
    // ADR-077: the trust list with the address of each device whose certificate is pinned here
    devices: () => {
      const pins = pinnedAddresses(home);
      return trust.list().map((d) => ({ id: d.id, name: d.name, tier: d.tier, address: pins.get(d.id) ?? null }));
    },
  };
}
