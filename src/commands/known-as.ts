import { runByPlugin } from '../address-env.js';
import { createTrustStore } from '../cluster/trust.js';
import { normalizeAddress, shortAddress } from '../identity/address.js';
import { primaryAddressIfPresent } from '../identity/address-key.js';
import { addressNamed, namesOfHome } from '../identity/address-labels.js';
import type { Contact } from '../mailbox/contacts.js';
import { contactKnownAs } from '../mailbox/known-as.js';
import type { Mailbox } from '../mailbox/mailbox.js';

/**
 * (ADR-081 review N2) For the commands: this computer's addresses by name, read only (nothing is created), and how
 * "which of your addresses a contact knows you by" is shown.
 */

export interface OwnAddressNames {
  /** This computer's first address (the device key's); null = no key yet. */
  first: string | null;
  /** name → address (`morse address`): the name you gave it, else the one the directory has (ADR-088). */
  byName: Record<string, string>;
  /** (ADR-088) old name → address: the directory name of an address that is called something else now — still accepted, never shown. */
  old?: Record<string, string>;
  /** (ADR-088) every address here, named or not (absent = the ones in byName). */
  addresses?: string[];
  /** Why the names could not be read (a damaged agents.json). */
  error?: string;
}

export function ownAddressNames(home?: string): OwnAddressNames {
  const first = primaryAddressIfPresent(home);
  try {
    const names = namesOfHome(home);
    return { first, byName: names.byName, old: names.old, addresses: names.addresses };
  } catch (e) {
    return { first, byName: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Every address here — also one that has no name. */
export const allMine = (own: OwnAddressNames): string[] => own.addresses ?? Object.values(own.byName);

const nameOf = (own: OwnAddressNames, address: string): string | null => Object.entries(own.byName).find(([, a]) => a === address)?.[0] ?? null;

export interface KnownAs {
  /** The address of yours the contact knows you by. */
  address: string;
  /** Its local name; null = this computer no longer has that address (or it has no name). */
  name: string | null;
  /** It is this computer's first address (what mail goes out from anyway). */
  first: boolean;
  /** This computer still has it. */
  held: boolean;
}

/** `known` as the store keeps it ('' = the first address) → the address and its name here. null = cannot be told. */
export function describeKnownAs(known: string | null, own: OwnAddressNames): KnownAs | null {
  if (known === null) return null;
  const address = known || own.first;
  if (!address) return null;
  const name = nameOf(own, address);
  return { address, name, first: address === own.first, held: address === own.first || name !== null };
}

/** `<name> (morse.im/<address>)` — or just the address when this computer no longer has it. */
export const knownAsLabel = (k: KnownAs): string => (k.name ? `${k.name} (morse.im/${k.address})` : `morse.im/${k.address}`);

/** The `morse contact <who>` line. */
export const knownAsLine = (k: KnownAs): string =>
  k.held ? `knows you as: ${knownAsLabel(k)}` : `knows you as: morse.im/${k.address} — an address that is no longer here: mail to them is not sent unless you name one (morse send … --from <name>)`;

/**
 * Which address of yours a contact knows you by (for `morse contact <who>`) — (ADR-083) the address the
 * contact BELONGS to: the row says it, nothing is learnt from the mail any more.
 */
export function knownAsOfContact(_mailbox: Mailbox, c: Contact, own: OwnAddressNames = ownAddressNames()): KnownAs | null {
  return describeKnownAs(c.myAddress, own);
}

/** The same for a `morse send` target — with how the contact is called in a note. null = no contact, or more than one (never a guess). */
export function knownAsOf(mailbox: Mailbox, target: string, own: OwnAddressNames = ownAddressNames()): (KnownAs & { who: string; label: string }) | null {
  let paired: string[] = [];
  try {
    paired = createTrustStore().list().map((d) => d.name.toLowerCase());
  } catch {
    /* no trust list: only address and morse.im/… targets count */
  }
  const hit = contactKnownAs(mailbox.contacts, target, (h) => paired.includes(h));
  const k = hit ? describeKnownAs(hit.known, own) : null;
  if (!hit || !k) return null;
  const c = hit.contact;
  return { ...k, who: c.remark ?? (c.handle ? `morse.im/${c.handle}${c.agent ? `/${c.agent}` : ''}` : `morse.im/${c.address ?? c.id}`), label: knownAsLabel(k) };
}

// --- (ADR-083) "which of my addresses": names, the --from option, the one-line refusals -----------------

/** Does this computer have more than one address? With one, no command says or asks which. */
export const severalAddresses = (own: OwnAddressNames): boolean => new Set([...(own.first ? [own.first] : []), ...allMine(own)]).size > 1;

/** How an address of mine is called: its local name (`morse address`), else the address. `key`: '' = the first. */
export const nameOfMine = (key: string, own: OwnAddressNames): string => {
  const address = key || own.first;
  return address ? (nameOf(own, address) ?? `morse.im/${address}`) : 'your first address';
};

/**
 * (ADR-088) My side of the `agent → agent` column of a message row. A row keeps the name the relay directory has
 * for my address (it never changes); with several addresses, an address that is called something else now is
 * shown by that name — the one `via <name>` says — and one with no name by its short form. With one address,
 * and for anything that is not such a name (a session's agent), what the row has.
 */
export const shownAgentOfMine = (stored: string, key: string, own: OwnAddressNames): string => {
  if (!severalAddresses(own)) return stored;
  const address = key || own.first;
  if (!address || own.old?.[stored] !== address) return stored;
  return nameOf(own, address) ?? shortAddress(address);
};

/** JSON: the address of mine something belongs to (`myAddress`); null = the first address is not known here. */
export const myAddressView = (key: string, own: OwnAddressNames): { name: string | null; address: string } | null => {
  const address = key || own.first;
  return address ? { name: nameOf(own, address), address } : null;
};

/** `--from <name|address>` → the key of that address of mine ('' = the first), or why not. */
export function mineFrom(from: string, own: OwnAddressNames): { key: string; address: string; name: string } | { error: string } {
  if (own.error) return { error: own.error };
  // (a name, the address, or the address as `morse address` prints it: morse.im/<address>, any case)
  const bare = normalizeAddress(from);
  const address = addressNamed(own, from) ?? (bare && allMine(own).includes(bare) ? bare : undefined);
  if (!address) return { error: `"${from}" is not one of your addresses here — morse address lists them` };
  // (an address with no name is said by itself)
  return { key: address === own.first ? '' : address, address, name: nameOf(own, address) ?? `morse.im/${address}` };
}

/** The ONE line for a peer address that is a contact / has a request at more than one of my addresses. */
export const ambiguousLine = (what: 'contact' | 'request' | 'either', address: string, mine: string[], own: OwnAddressNames): string =>
  `morse.im/${address} ${what === 'contact' ? 'is a contact of' : what === 'request' ? 'has a message request at' : 'is a contact of, or has a message request at,'} ${mine.length} of your addresses (${mine.map((m) => nameOfMine(m, own)).join(', ')}) — say which one: --from <name>`;

let selectedByEnv = false;
/** This command's `--from` was not written on it: MORSE_ADDRESS supplied it (said by the command line's entry hook). */
export const fromCameFromEnv = (set?: boolean): boolean => {
  if (set !== undefined) selectedByEnv = set;
  return selectedByEnv;
};

/**
 * (ADR-088 §4) How to reach a contact that belongs to ANOTHER address of mine than the one named: by the address
 * it belongs to — never by making it a contact of the one named (that shows them a second address of mine).
 * `owners`: the keys ('' = the first) of the addresses it is a contact of.
 */
export function ofAnotherAddressLine(raw: string, owners: string[], named: string, own: OwnAddressNames, fromEnv: boolean = selectedByEnv): string {
  const arg = (key: string): string => {
    const n = nameOfMine(key, own).replace(/^morse\.im\//, '');
    return /\s/.test(n) ? JSON.stringify(n) : n;
  };
  const usable = owners.filter((k) => nameOfMine(k, own) !== 'your first address');
  const from = usable.length ? `--from ${arg(usable[0]!)}` : null;
  const how = fromEnv ? `${from ? `add ${from}, or ` : ''}unset MORSE_ADDRESS` : `${from ? `${from}, or ` : ''}leave --from out`;
  return `"${raw}" is a contact of your address ${owners.map((k) => nameOfMine(k, own)).join(', ')}, not of ${nameOfMine(named, own)} — ${how}`;
}

/**
 * (ADR-088 §4) MORSE_ADDRESS=<name|address>: the address of mine this process acts as when a command names none —
 * the default of every `--from`. null = not set (the first address for sending, every address for listing: as it
 * always was). `error`: it names none of the addresses here.
 */
export function addressFromEnv(own: OwnAddressNames = ownAddressNames(), env: NodeJS.ProcessEnv = process.env): { key: string; address: string; name: string } | { error: string } | null {
  // a command a plugin runs works for the whole home: no selector applies to it (src/address-env.ts)
  if (runByPlugin(env)) return null;
  const said = env['MORSE_ADDRESS']?.trim();
  if (!said) return null;
  const hit = mineFrom(said, own);
  return 'error' in hit ? { error: own.error ?? `MORSE_ADDRESS="${said}" is not one of your addresses here — morse address lists them` } : hit;
}

