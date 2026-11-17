import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { morseHome, dataDir } from '../home.js';

/**
 * The trust list (ADR-028): which device IDs this computer accepts, each with the name it is shown
 * under and a tier. It lives in ~/.morse/trusted-devices.json as `{"devices": [...]}`. Dropping a
 * device is deleting its row; there is no shared secret to roll.
 *
 * - `owner`: a computer of the operator's own (ADR-016).
 * - `peer`: a device of someone else. What it sends is labelled as theirs, is never treated as the
 *   operator speaking, is only pulled (never resumed into a session) and it cannot list this
 *   computer's sessions.
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
  /** Case-insensitive lookup by the name the device is listed under. */
  byName(name: string): TrustedDevice | undefined;
  /** Insert a device, or rename / re-tier the one with that ID (moved to the end). Tier defaults to owner. */
  add(device: { id: string; name: string; tier?: TrustTier }): TrustedDevice;
  /** Remove the device with that ID, else the one with that name. false when neither exists. */
  remove(idOrName: string): boolean;
}

const TRUST_FILE = 'trusted-devices.json';

/** A row is kept only with a string id, a string name and a known tier. */
function validRow(row: unknown): row is TrustedDevice {
  if (typeof row !== 'object' || row === null) return false;
  const { id, name, tier } = row as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string' && (tier === 'owner' || tier === 'peer');
}

/** Parse the file; an unreadable or malformed file trusts no one (rather than taking the daemon down). */
function parseRows(path: string): TrustedDevice[] {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { devices?: unknown } | null;
    const rows = doc?.devices;
    return Array.isArray(rows) ? rows.filter(validRow) : [];
  } catch {
    return [];
  }
}

/**
 * The trust list of `home`. Reads are cached per file mtime, so a change made by another process
 * (a CLI command while the daemon runs) is seen on the next call.
 */
export function createTrustStore(home: string = morseHome()): TrustStore {
  const file = join(dataDir(home), TRUST_FILE);
  let snapshot: { mtimeMs: number; rows: TrustedDevice[] } | undefined;

  function rows(): TrustedDevice[] {
    if (!existsSync(file)) return [];
    const { mtimeMs } = statSync(file);
    if (snapshot?.mtimeMs !== mtimeMs) snapshot = { mtimeMs, rows: parseRows(file) };
    return snapshot.rows;
  }

  /**
   * Read-modify-write under the file's lock, starting from what is on disk right now: the daemon and
   * a CLI command may both edit the list, and neither may lose the other's row.
   */
  function edit<T>(change: (current: TrustedDevice[]) => { next?: TrustedDevice[]; result: T }): T {
    return withFileLock(file, () => {
      snapshot = undefined;
      const { next, result } = change(rows());
      if (next) {
        writeFileAtomic(file, `${JSON.stringify({ devices: next }, null, 2)}\n`, { mode: 0o600 });
        snapshot = undefined;
      }
      return result;
    });
  }

  const findById = (id: string) => rows().find((row) => row.id === id);
  const findByName = (name: string) => {
    const wanted = name.toLowerCase();
    return rows().find((row) => row.name.toLowerCase() === wanted);
  };

  return {
    list: rows,
    get: findById,
    byName: findByName,
    add({ id, name, tier = 'owner' }) {
      return edit((current) => {
        const before = current.find((row) => row.id === id);
        // an existing row keeps its other fields (addedAt first of all); only name and tier change
        const row: TrustedDevice = before ? { ...before, name, tier } : { id, name, tier, addedAt: Date.now() };
        return { next: [...current.filter((r) => r.id !== id), row], result: row };
      });
    },
    remove(idOrName) {
      return edit((current) => {
        const victim = current.find((row) => row.id === idOrName) ?? findByName(idOrName);
        if (!victim) return { result: false };
        return { next: current.filter((row) => row.id !== victim.id), result: true };
      });
    },
  };
}
