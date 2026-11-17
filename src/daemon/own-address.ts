import { addressNamed, namesOfHome } from '../identity/address-labels.js';

/** What the transport says about an address of this home: the address, and the name the relay directory has for it. */
export type TransportOwnAddress = (from: string) => { address: string; name: string | null } | null;

export interface OwnAddress {
  address: string;
  /** The name `morse address` shows for it now; null = it has none (ADR-088). */
  name: string | null;
  /** The name the relay directory has for it: what a message row keeps (it never changes when you rename). */
  directory: string | null;
}

/**
 * (ADR-088 §1) "Which of my addresses is `from`" for the daemon's local API, by the names of THIS home: the name
 * you gave an address, the name the directory has for it (still accepted), or the address. The transport goes by
 * the directory's names and knows nothing of yours — so the name is translated here, and what is said back is the
 * name the address has now. Names that cannot be read: the transport's own.
 */
export function ownAddressByName(transport: TransportOwnAddress, home?: string): (from: string) => OwnAddress | null {
  return (from) => {
    let names: { byName: Record<string, string>; old: Record<string, string>; addresses: string[] } = { byName: {}, old: {}, addresses: [] };
    try {
      names = namesOfHome(home);
    } catch {
      /* unreadable: the transport's own names */
    }
    const own = transport(addressNamed(names, from) ?? from);
    if (!own) return null;
    // an address of this home is called what `morse address` calls it — nothing, when it has no name
    const known = names.addresses.includes(own.address);
    return { address: own.address, name: Object.entries(names.byName).find(([, a]) => a === own.address)?.[0] ?? (known ? null : own.name), directory: own.name };
  };
}
