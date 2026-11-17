import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { morseHome } from '../home.js';
import { nameAsKept, sameName } from '../name-key.js';
import { addressesDir } from './address-key.js';
import { isAddress, looksLikeAddress } from './address.js';
import { agentAddressIndex } from './agent-addresses.js';

/**
 * ADR-088 — the NAME of one of my addresses is a local label, given the way a contact gets its remark
 * (`morse address set <which> --name <name>` ↔ `morse contact set <who> --name <remark>`).
 *
 * Until now the name you gave an address was also the agent name the relay directory keeps for it (the last
 * part of an old-style `morse.im/<old name>/<agent>` link): renaming it changed the directory, and whoever
 * still used the old link no longer reached you. Now:
 *
 *   ~/.morse/addresses/agents.json   directory name → address   (what the relay and the daemon go by; unchanged)
 *   ~/.morse/addresses/labels.json   address → your name for it; and the addresses that have NO name
 *
 * An address the file says nothing about is called what the directory calls it, as before. Naming writes
 * labels.json and nothing else — no request to anyone, the address and the directory name stay. The directory
 * name of an address that is called something else (or nothing) remains a hidden way to say it
 * (`--from <old name>`), so nothing that was written down before stops working.
 */

const FILE = 'labels.json';
const labelsPath = (home: string): string => join(addressesDir(home), FILE);
/** The verbs of `morse address`: a name may not be one of them (`rename` = the hidden alias of `set`). */
export const ADDRESS_VERBS: readonly string[] = ['add', 'set', 'rename', 'remove'];

interface LabelsFile {
  /** address → the name you gave it */
  labels: Record<string, string>;
  /** addresses with no name: created without one (`morse address add`), or the name was cleared (`set --name ""`) */
  unnamed: string[];
}

function readLabels(home: string): LabelsFile {
  const path = labelsPath(home);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { labels: {}, unnamed: [] };
    throw new Error(`cannot read ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  const damaged = (why: string) => new Error(`${path} is damaged (${why}) — it holds the names you gave your addresses here. Fix it or move it away (the addresses themselves are untouched); nothing was changed.`);
  let v: { labels?: unknown; unnamed?: unknown };
  try {
    v = JSON.parse(text) as { labels?: unknown; unnamed?: unknown };
  } catch {
    throw damaged('not JSON');
  }
  if (!v || typeof v !== 'object' || !v.labels || typeof v.labels !== 'object' || Array.isArray(v.labels)) throw damaged('no "labels" object');
  const labels: Record<string, string> = {};
  for (const [address, name] of Object.entries(v.labels as Record<string, unknown>)) {
    if (!isAddress(address) || typeof name !== 'string' || !name || name.trim() !== name) throw damaged(`"${address}" has no valid name`);
    labels[address] = name;
  }
  if (v.unnamed !== undefined && (!Array.isArray(v.unnamed) || v.unnamed.some((a) => typeof a !== 'string' || !isAddress(a)))) throw damaged('"unnamed" is not a list of addresses');
  return { labels, unnamed: ((v.unnamed as string[] | undefined) ?? []).filter((a) => labels[a] === undefined) };
}
const writeLabels = (f: LabelsFile, home: string): void =>
  writeFileAtomic(labelsPath(home), `${JSON.stringify({ v: 1, labels: f.labels, ...(f.unnamed.length ? { unnamed: f.unnamed } : {}) }, null, 2)}\n`, { mode: 0o600 });

/** address → the name you gave it. Only addresses you named are here. Throws when the file is damaged. */
export const addressLabels = (home: string = morseHome()): Record<string, string> => readLabels(home).labels;

export interface HomeNames {
  /** current name → address: what `morse address` lists and every command shows. An address with no name is not here. */
  byName: Record<string, string>;
  /** old name → address: the directory name of an address that is called something else now — accepted, never listed. */
  old: Record<string, string>;
  /** directory name → address (agents.json): what the relay and the daemon go by. */
  directory: Record<string, string>;
  /** every address of this home (named or not). */
  addresses: string[];
  /** address → the name YOU gave it (labels.json) — the others are called what the directory calls them. */
  given: Record<string, string>;
}

/** The names of this home's addresses. Throws when agents.json or labels.json cannot be read. */
export function namesOfHome(home: string = morseHome()): HomeNames {
  const directory = agentAddressIndex(home);
  const { labels, unnamed } = readLabels(home);
  const byName: Record<string, string> = {};
  const old: Record<string, string> = {};
  const given: Record<string, string> = {};
  for (const [dir, address] of Object.entries(directory)) {
    const label = labels[address];
    if (label !== undefined) {
      byName[label] = address;
      given[address] = label;
      if (label !== dir) old[dir] = address;
    } else if (unnamed.includes(address)) old[dir] = address;
    else byName[dir] = address;
  }
  return { byName, old, directory, addresses: [...new Set(Object.values(directory))], given };
}

const lookup = (m: Record<string, string>, said: string): string | undefined => Object.entries(m).find(([n]) => sameName(n, said))?.[1];

/** The address `said` names (any case): by its current name, else by an old one. */
export const addressNamed = (names: Pick<HomeNames, 'byName'> & { old?: Record<string, string> }, said: string): string | undefined =>
  lookup(names.byName, said) ?? (names.old ? lookup(names.old, said) : undefined);

/** The current name of an address of this home — null when it has none (or is none of them). */
export function nameOfAddress(address: string, home: string = morseHome()): string | null {
  return Object.entries(namesOfHome(home).byName).find(([, a]) => a === address)?.[0] ?? null;
}

/**
 * The names that are in play for "is this name taken on my side" (ADR-088 §7): everything `--from <that>` means
 * one of my addresses by, except what nobody chose and nothing shows. With several addresses: every name shown.
 * With one address — whose name is shown nowhere — only a name you gave it yourself. And always the hidden
 * names: the directory's name of an address that is called something else now, or nothing (`address-5`, the
 * install-time name of an address whose name was cleared) — `--from` still takes them.
 */
export const namesInUse = (names: HomeNames): string[] => [...new Set([...(names.addresses.length > 1 ? Object.keys(names.byName) : Object.values(names.given)), ...Object.keys(names.old)])];

/**
 * May this be the name of an address? The rules a contact's remark has (`checkRemark`): not a command word, not
 * something that looks like an address — and, because `--from @…` / `--from a:b` is how a session is written,
 * no leading @ and no colon. Returns it trimmed; throws the one line that says why not.
 */
export function checkAddressName(name: string): string {
  const n = nameAsKept(name);
  if (!n) throw new Error('give a name (to clear one: morse address set <which> --name "")');
  if (ADDRESS_VERBS.includes(n.toLowerCase())) throw new Error(`"${n}" is a command word — pick another name`);
  if (looksLikeAddress(n) || looksLikeAddress(n.replace(/^morse\.im\//i, ''))) throw new Error(`the name "${n}" looks like an address (26 characters of the address alphabet) — pick another name`);
  if (n.startsWith('@') || n.includes(':')) throw new Error(`the name "${n}" looks like a session (@… or a colon) — pick another name`);
  return n;
}

/** `name` checked for `address`: a valid name that no OTHER address of this home has, now or as its old name. */
export function checkAddressLabel(address: string, name: string, names: HomeNames): string {
  const n = checkAddressName(name);
  if (!names.addresses.includes(address)) throw new Error(`${address} is not one of your addresses here — morse address lists them`);
  const taken = addressNamed(names, n);
  if (taken && taken !== address) throw new Error(`the name "${n}" is already used for another address`);
  return n;
}

/**
 * Name an address of this home (ADR-088 §1) — '' clears the name (the address is then shown by itself). A local
 * label: nothing else changes. `from` / `to`: what it was and is called (null = no name).
 */
export function setAddressLabel(address: string, name: string, home: string = morseHome()): { from: string | null; to: string | null } {
  return withFileLock(labelsPath(home), () => {
    const names = namesOfHome(home);
    const from = Object.entries(names.byName).find(([, a]) => a === address)?.[0] ?? null;
    const file = readLabels(home);
    if (!nameAsKept(name)) {
      if (!names.addresses.includes(address)) throw new Error(`${address} is not one of your addresses here — morse address lists them`);
      delete file.labels[address];
      if (!file.unnamed.includes(address)) file.unnamed.push(address);
      if (from !== null) writeLabels(file, home);
      return { from, to: null };
    }
    const to = checkAddressLabel(address, name, names);
    // nothing changes: nothing is written (`set X --name X`, the hidden `rename pro pro`)
    if (from === to) return { from, to };
    const dir = Object.entries(names.directory).find(([, a]) => a === address)![0];
    // called what the directory calls it: that needs no label
    if (to === dir) delete file.labels[address];
    else file.labels[address] = to;
    file.unnamed = file.unnamed.filter((a) => a !== address);
    writeLabels(file, home);
    return { from, to };
  });
}

/** An address is gone from this home (`morse address remove`): so is what was said about its name. */
export function dropAddressLabel(address: string, home: string = morseHome()): void {
  withFileLock(labelsPath(home), () => {
    const file = readLabels(home);
    if (file.labels[address] === undefined && !file.unnamed.includes(address)) return;
    delete file.labels[address];
    file.unnamed = file.unnamed.filter((a) => a !== address);
    writeLabels(file, home);
  });
}
