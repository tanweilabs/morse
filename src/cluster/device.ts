import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { morseHome, dataDir } from '../home.js';

/** ~/.morse/device-name: one line, the name this computer goes by. */
const nameFile = (home: string): string => join(dataDir(home), 'device-name');

/**
 * This computer's name. A name stored in ~/.morse/device-name wins; without one, the first label
 * of the host name (lower case) is used — and stored, because macOS renames hosts on its own (a
 * LAN name clash adds "-2") and the name must not change under the user.
 */
export function getDeviceName(home: string = morseHome()): string {
  const file = nameFile(home);
  const stored = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  if (stored) return stored;
  const [firstLabel = 'device'] = hostname().split('.');
  const derived = firstLabel.toLowerCase();
  setDeviceName(derived, home);
  return derived;
}

/** Store the name (trimmed) for later calls of getDeviceName. */
export function setDeviceName(name: string, home: string = morseHome()): void {
  mkdirSync(dataDir(home), { recursive: true });
  writeFileSync(nameFile(home), `${name.trim()}\n`, 'utf8');
}
