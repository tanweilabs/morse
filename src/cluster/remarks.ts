import { normalizeAddress } from '../identity/address.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';

/**
 * ADR-065: identity is the address only. Morse has no self-chosen nicknames: what a
 * contact is called is YOUR remark for that address (`morse contact add|set … --name`).
 * Wherever a sender is shown: "<your remark> (<address>)", or just the address.
 * Nicknames that older clients still send are accepted on the wire and ignored.
 */

/** Your remark for a handle, if you gave it one. */
export type RemarkLookup = (handle: string) => string | null | undefined;

/**
 * (ADR-083 review R3) Your remark for the sender of ONE message: the same peer address can be a contact of two of
 * your addresses, under two names — a message is labelled with the name of the contact of ITS pair (the
 * address of yours it belongs to, the peer), never with the one another address of yours gave them. An
 * old name (a handle) is looked up as before. With one address this is exactly the lookup from before.
 */
export function remarkLookupFor(mailbox: Pick<Mailbox, 'contacts' | 'addressOf'>, m: Pick<Message, 'contactId' | 'myAddress' | 'direction'>): RemarkLookup {
  return (h) => {
    const any = mailbox.contacts.byHandle(h);
    const address = normalizeAddress(h);
    if (!address) return any?.remark ?? null;
    const my = mailbox.addressOf(m);
    if (any && any.myAddress === my) return any.remark;
    const own = mailbox.contacts.byAddress(address, my);
    return own && own.id !== 'self' ? own.remark : null;
  };
}

/** One line for `morse name` (hidden, refused). */
export const NO_NICKNAMES =
  'Morse has no nicknames: you are your address, and others name you with their own remark — name your contacts with morse contact (morse contact set <address> --name <remark>).';

/**
 * "k7f3a9xq/mini" → "Bob (k7f3a9xq/mini)" when you gave k7f3a9xq the remark Bob;
 * anything else unchanged (just the address).
 */
export function withRemark(label: string, remarkOf?: RemarkLookup): string {
  const handle = label.trim().replace(/^@/, '').split('/')[0]?.toLowerCase() ?? '';
  const remark = handle && remarkOf ? remarkOf(handle) : null;
  // ADR-077: a remark that is just the handle (written by the migration for an unnamed contact) is not said twice
  return remark && remark !== handle ? `${remark} (${label})` : label;
}
