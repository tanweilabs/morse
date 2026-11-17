import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { morseHome, dataDir } from '../home.js';
import { bareHandle } from './address.js';

/**
 * Morse handles this device refuses to pair back automatically (ADR-032):
 * `morse pair remove <handle>` adds the person here, so their next message does
 * not quietly re-pair them; an explicit `morse pair add morse.im/<handle>` (or
 * sending to them) removes them again. ~/.morse/morse-blocked.json
 */

const file = (home: string) => join(dataDir(home), 'morse-blocked.json');
/** Bare handle. Compatibility: an entry stored or typed as `morse.im/x` — or `morse.talk/x`, the retired domain (ADR-075) — still means `x`. */
const norm = (h: string) => bareHandle(h);

export function blockedHandles(home: string = morseHome()): string[] {
  try {
    const v = JSON.parse(readFileSync(file(home), 'utf8')) as { handles?: unknown };
    return Array.isArray(v.handles) ? [...new Set(v.handles.filter((h): h is string => typeof h === 'string').map(norm).filter(Boolean))] : [];
  } catch {
    return [];
  }
}

export function isBlocked(handle: string, home: string = morseHome()): boolean {
  return blockedHandles(home).includes(norm(handle));
}

function write(handles: string[], home: string): void {
  writeFileAtomic(file(home), `${JSON.stringify({ handles }, null, 2)}\n`, { mode: 0o600 });
}

// Several morse processes change this file (the daemon, every CLI call): the read and the
// write happen under one lock, or two of them at once would each drop the other's change.

export function blockHandle(handle: string, home: string = morseHome()): void {
  const h = norm(handle);
  withFileLock(file(home), () => {
    const all = blockedHandles(home);
    if (!all.includes(h)) write([...all, h], home);
  });
}

/** true = it was blocked. */
export function unblockHandle(handle: string, home: string = morseHome()): boolean {
  const h = norm(handle);
  if (!blockedHandles(home).includes(h)) return false; // nothing to change: no lock needed
  return withFileLock(file(home), () => {
    const all = blockedHandles(home);
    if (!all.includes(h)) return false;
    write(all.filter((x) => x !== h), home);
    return true;
  });
}
