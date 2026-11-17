import { statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, morseHome } from '../home.js';
import { pinnedAddresses } from '../identity/device-address.js';
import type { ContactStore } from '../mailbox/contacts.js';
import type { TrustStore, TrustedDevice } from './trust.js';

/**
 * ADR-077 (B): one of your own computers that you moved out of contact group `self` is no
 * longer an owner — on EVERY path. Instead of asking at each place that reads a device's tier
 * (relay mail, the LAN API's messages and session directory, direct links, the session ids we
 * send along), the trust store itself is wrapped: an owner entry whose contact (made by the
 * migration) is in another group is handed out as `peer`. The file trusted-devices.json is
 * never rewritten for this, so moving the contact back to `self` restores it at once, and the
 * v2 code that re-upgrades "devices under my own handle" cannot undo a demotion.
 *
 * It only ever LOWERS: a group label makes nobody an owner.
 */
export function effectiveTrust(base: TrustStore, demoted: (id: string) => boolean): TrustStore {
  const lower = <T extends TrustedDevice | undefined>(d: T): T => (d && d.tier === 'owner' && demoted(d.id) ? ({ ...d, tier: 'peer' } as T) : d);
  return {
    list: () => base.list().map((d) => lower(d)),
    get: (id) => lower(base.get(id)),
    byName: (name) => lower(base.byName(name)),
    add: (d) => lower(base.add(d)),
    remove: (idOrName) => base.remove(idOrName),
  };
}

/** device ID → its address, from the certificates pinned in ~/.morse/peer-keys.json (re-read when the file changes). */
export function pinnedAddressLookup(home: string = morseHome()): (deviceId: string) => string | null {
  const path = join(dataDir(home), 'peer-keys.json');
  let cache: { mtimeMs: number; map: Map<string, string> } | null = null;
  return (deviceId) => {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      /* no pins yet */
    }
    if (!cache || cache.mtimeMs !== mtimeMs) cache = { mtimeMs, map: mtimeMs < 0 ? new Map() : pinnedAddresses(home) };
    return cache.map.get(deviceId) ?? null;
  };
}

/**
 * Is this device one of your own computers that you moved out of group `self`? Looked up by
 * device ID (ContactStore.isLowered: the contact's group, or the lowered state kept after the
 * contact was removed — N1). Unknown device = no. FAILS CLOSED (N5a): when the lookup cannot be
 * made (database busy …) the device reads as lowered for that call — an owner entry is handed
 * out as `peer` rather than trusted on a guess; `onError` is told once.
 */
export function demotedDevices(contacts: () => Pick<ContactStore, 'isLowered'> | null, onError?: (message: string) => void): (deviceId: string) => boolean {
  let told = false;
  return (deviceId) => {
    try {
      const store = contacts();
      return store ? store.isLowered(deviceId) : false;
    } catch (e) {
      if (!told) {
        told = true;
        onError?.(`morse: could not check whether your own computers are still in group self (${e instanceof Error ? e.message : String(e)}) — treating them as ordinary contacts until the check works again`);
      }
      return true;
    }
  };
}
