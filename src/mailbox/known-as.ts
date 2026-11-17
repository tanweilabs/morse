import { hasAddressHost, stripAddressHost } from '../cluster/address.js';
import { normalizeAddress } from '../identity/address.js';
import { SELF_CONTACT, type Contact, type ContactStore } from './contacts.js';

/**
 * The contact a `morse send` target is, and which of MY addresses it belongs to — the sender of mail
 * to it when no address is named. One rule for the daemon (which applies it) and the command (which
 * has to know it before it posts, ADR-081 review N1):
 *
 *   - only a target that is a PERSON: a bare address, `morse.im/…`, or an old name a computer is
 *     paired under (`knowsHandle`) — never a session target, never a bare word that may be a session;
 *   - `known`: a 26-character address, or '' = this computer's first address;
 *   - null = not a contact yet, yourself — or (ADR-083) an address that is a contact of more than one
 *     of my addresses: `contactsOfTarget` says which, and nothing is guessed.
 *
 * (ADR-083) What was "the address the contact knows me by" (`known_as`, learnt from the first mail) is
 * now the row itself: a contact belongs to one address of mine, from the moment it is made.
 */
export function contactKnownAs(contacts: ContactStore, target: string, knowsHandle: (handle: string) => boolean): { contact: Contact; known: string } | null {
  const all = contactsOfTarget(contacts, target, knowsHandle);
  const contact = all?.length === 1 ? all[0]! : null;
  return contact ? { contact, known: contact.myAddress } : null;
}

/**
 * (ADR-083) Every contact a person target could mean — for a peer ADDRESS one per address of mine it
 * is a contact of. null = the target is not a person (a session, a bare word); [] = nobody yet.
 */
export function contactsOfTarget(contacts: ContactStore, target: string, knowsHandle: (handle: string) => boolean): Contact[] | null {
  const t = target.trim();
  const bare = stripAddressHost(t);
  if (!bare || t.startsWith('@') || bare.includes(':')) return null;
  const handle = (bare.split('/')[0] ?? '').toLowerCase();
  const address = normalizeAddress(t);
  if (!address && !hasAddressHost(t) && !(handle && knowsHandle(handle))) return null;
  return contacts.findAll(address ?? bare).filter((c) => c.id !== SELF_CONTACT);
}
