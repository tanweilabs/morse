import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Morse's own state lives in ~/.morse (ADR-035); ~/.anytoany is the old name (compatibility: see dataDir). */
export const DATA_DIR_NAME = '.morse';
export const LEGACY_DATA_DIR_NAME = '.anytoany';

/**
 * The base directory that holds the data directory (normally your home). MORSE_HOME
 * overrides it — used to isolate daemon instances (tests, single-machine LAN sims):
 * state goes to $MORSE_HOME/.morse. Agent session scanning intentionally ignores this
 * and always uses the real home.
 *
 * Compatibility: ANYTOANY_HOME (the name before ADR-035) is still honoured — service
 * files, scripts and hook commands of older installs set it. MORSE_HOME wins.
 */
export function morseHome(): string {
  return process.env['MORSE_HOME'] || process.env['ANYTOANY_HOME'] || homedir();
}

/** True when MORSE_HOME / ANYTOANY_HOME points somewhere other than the real home. */
export function isIsolatedHome(): boolean {
  const h = process.env['MORSE_HOME'] || process.env['ANYTOANY_HOME'];
  return Boolean(h && h !== homedir());
}

/**
 * The data directory: <home>/.morse — except while <home>/.anytoany is still a REAL
 * directory (an older install not migrated yet, or the move failed): then that one, so
 * state is never split across two directories and an un-migrated device keeps its
 * identity and mailbox. After the move ~/.anytoany is a symlink to ~/.morse (lstat: not
 * a directory). Compatibility with installs from before ADR-035.
 */
export function dataDir(home: string = morseHome()): string {
  const legacy = join(home, LEGACY_DATA_DIR_NAME);
  try {
    if (lstatSync(legacy).isDirectory()) return legacy;
  } catch {
    /* no legacy directory */
  }
  return join(home, DATA_DIR_NAME);
}
