import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { morseHome, dataDir } from '../home.js';

/**
 * Who this device trusts (ADR-028). Syncthing-style: a list of device IDs added by
 * hand on both sides. Revoking one device = removing one entry — no shared secret
 * to rotate across the cluster.
 *
 * Tiers:
 * - `owner` — the operator's own devices, whose messages carry the operator's
 *   authority (ADR-016).
 * - `peer` (Morse) — someone ELSE's device / agent. Its messages are delivered as
 *   peer messages: clearly labelled, never carrying the operator's authority,
 *   pull-only (no headless resume, so no owner escalation applies), and it may
 *   not read this device's session directory.
 */

export type TrustTier = 'owner' | 'peer';

export interface TrustedDevice {
  id: string;
  name: string;
  tier: TrustTier;
  addedAt: number;
}

export interface TrustStore {
  list(): TrustedDevice[];
  get(id: string): TrustedDevice | undefined;
  byName(name: string): TrustedDevice | undefined;
  /** Add (or rename / re-tier) a device. Tier defaults to owner. */
  add(device: { id: string; name: string; tier?: TrustTier }): TrustedDevice;
  /** Remove by device ID or name. false = nothing matched. */
  remove(idOrName: string): boolean;
}

const FILE = 'trusted-devices.json';

function isTrustedDevice(v: unknown): v is TrustedDevice {
  const d = v as Partial<TrustedDevice>;
  return typeof d?.id === 'string' && typeof d.name === 'string' && (d.tier === 'owner' || d.tier === 'peer');
}

/** Re-reads the file when its mtime changes, so `anyd pair add` applies to a running daemon. */
export function createTrustStore(home: string = morseHome()): TrustStore {
  const dir = dataDir(home);
  const path = join(dir, FILE);
  let cache: { mtimeMs: number; devices: TrustedDevice[] } | null = null;

  const read = (): TrustedDevice[] => {
    if (!existsSync(path)) return [];
    const mtimeMs = statSync(path).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.devices;
    let devices: TrustedDevice[] = [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { devices?: unknown[] };
      devices = (parsed.devices ?? []).filter(isTrustedDevice);
    } catch {
      devices = []; // corrupt file: trust nobody rather than crash the daemon
    }
    cache = { mtimeMs, devices };
    return devices;
  };

  const write = (devices: TrustedDevice[]): void => {
    writeFileAtomic(path, `${JSON.stringify({ devices }, null, 2)}\n`, { mode: 0o600 });
    cache = null;
  };

  /**
   * Change the list: read what is on disk NOW (not the cache) and write, under the file's
   * lock — the daemon and CLI calls change it at the same time, and without the lock two
   * of them would each drop the other's device.
   */
  const change = <T>(fn: () => T): T =>
    withFileLock(path, () => {
      cache = null;
      return fn();
    });

  const byName = (name: string) => read().find((d) => d.name.toLowerCase() === name.toLowerCase());

  return {
    list: read,
    get: (id) => read().find((d) => d.id === id),
    byName,
    add({ id, name, tier = 'owner' }) {
      return change(() => {
        const existing = read().find((d) => d.id === id);
        const entry: TrustedDevice = existing
          ? { ...existing, name, tier }
          : { id, name, tier, addedAt: Date.now() };
        write([...read().filter((d) => d.id !== id), entry]);
        return entry;
      });
    },
    remove(idOrName) {
      return change(() => {
        const target = read().find((d) => d.id === idOrName) ?? byName(idOrName);
        if (!target) return false;
        write(read().filter((d) => d.id !== target.id));
        return true;
      });
    },
  };
}
