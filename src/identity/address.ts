import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { stripAddressHost } from '../cluster/address.js';

/**
 * Identity v3 addresses (ADR-073, docs/specs/identity-v3.zh-CN.md §3.2): an address is
 * computed from its own Ed25519 public key, so anyone can check that a key belongs to an
 * address without asking the relay:
 *
 *   address = base30( SHA-256("morse-address-v1\n" ‖ 32-byte Ed25519 public key) mod 30^26 )
 *
 * The digest is read as a big-endian unsigned integer; digits are written most significant
 * first and padded on the left with the alphabet's first character to 26. 30^26 ≈ 2^127.6,
 * the strength of the Ed25519 key itself. Same algorithm in relay-cf/src/address.ts.
 */

export const ADDRESS_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export const ADDRESS_LENGTH = 26;
export const ADDRESS_CONTEXT = 'morse-address-v1\n';

const BASE = 30n;
const MODULUS = BASE ** BigInt(ADDRESS_LENGTH);

/** The raw 32-byte public key of an Ed25519 KeyObject (public or private). */
export function rawPublicKey(key: KeyObject): Buffer {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  if (pub.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
  const spki = pub.export({ type: 'spki', format: 'der' });
  return Buffer.from(spki.subarray(spki.length - 32));
}

/** The address of a raw 32-byte Ed25519 public key. */
export function addressFromPublicKey(pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error('an address is computed from a 32-byte Ed25519 public key');
  const digest = createHash('sha256').update(ADDRESS_CONTEXT).update(pub).digest();
  let n = BigInt(`0x${digest.toString('hex')}`) % MODULUS;
  let out = '';
  for (let i = 0; i < ADDRESS_LENGTH; i++) {
    out = ADDRESS_ALPHABET[Number(n % BASE)]! + out;
    n /= BASE;
  }
  return out;
}

/** The address of an Ed25519 KeyObject. */
export const addressOfKey = (key: KeyObject): string => addressFromPublicKey(rawPublicKey(key));

const SHAPE = new RegExp(`^[${ADDRESS_ALPHABET}]{${ADDRESS_LENGTH}}$`);

/** Exactly 26 characters of the alphabet (lowercase). */
export function isAddress(s: string): boolean {
  return SHAPE.test(s);
}

/**
 * Something a human pasted — any case, surrounding space, `morse.im/` (or, compatibility,
 * the retired `morse.talk/`), `https://`, a trailing slash — as an address; null when it is not one.
 */
export function normalizeAddress(input: string): string | null {
  const s = stripAddressHost(input.trim()).toLowerCase();
  return isAddress(s) ? s : null;
}

/**
 * A remark (the name YOU give a contact) may not look like an address: exactly 26
 * characters, all of the alphabet, in any case (spec §3.2) — so `<who>` in a command
 * can always be told apart.
 */
export function looksLikeAddress(s: string): boolean {
  return isAddress(s.trim().toLowerCase());
}

/** m4q8c2vxk7h3n9td5rwf6pj2ya → m4q8…2ya (how an address without a remark is shown). */
export function shortAddress(address: string): string {
  return address.length === ADDRESS_LENGTH ? `${address.slice(0, 4)}…${address.slice(-3)}` : address;
}

/** Verify a raw public key really is the key of `address`. */
export function keyMatchesAddress(pub: Uint8Array, address: string): boolean {
  try {
    return addressFromPublicKey(pub) === address;
  } catch {
    return false;
  }
}
