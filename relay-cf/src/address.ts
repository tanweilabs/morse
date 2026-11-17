import { b64decode, verifyEd25519 } from './crypto.js';

/**
 * Identity v3 addresses on the relay (ADR-073) — the same algorithm as the client's
 * src/identity/address.ts, WebCrypto only:
 *
 *   address = base30( SHA-256("morse-address-v1\n" ‖ 32-byte Ed25519 public key) mod 30^26 )
 *
 * The relay checks that a login key IS the address it logs in as, and that a published
 * prekey is signed by it. It never needs a certificate (v3 has none).
 */

export const ADDRESS_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export const ADDRESS_LENGTH = 26;
export const LOGIN_V3_CONTEXT = 'morse-relay-login-v3';
export const PREKEY_CONTEXT = 'morse-prekey-v1';

const MODULUS = 30n ** 26n;
const SHAPE = new RegExp(`^[${ADDRESS_ALPHABET}]{${ADDRESS_LENGTH}}$`);
const utf8 = (s: string) => new TextEncoder().encode(s);

export async function addressFromPublicKey(pub: Uint8Array): Promise<string> {
  if (pub.length !== 32) throw new Error('an address is computed from a 32-byte Ed25519 public key');
  const ctx = utf8('morse-address-v1\n');
  const buf = new Uint8Array(ctx.length + 32);
  buf.set(ctx);
  buf.set(pub, ctx.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let n = BigInt(`0x${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`) % MODULUS;
  let out = '';
  for (let i = 0; i < ADDRESS_LENGTH; i++) {
    out = ADDRESS_ALPHABET[Number(n % 30n)]! + out;
    n /= 30n;
  }
  return out;
}

export const isAddress = (s: unknown): s is string => typeof s === 'string' && SHAPE.test(s);

/** Lowercase, trimmed; null when not an address. */
export function normalizeAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  return SHAPE.test(s) ? s : null;
}

/** The raw 32-byte key (base64) when it really is the key of `address`; else null. */
export async function keyOfAddress(address: string, keyB64: unknown): Promise<Uint8Array | null> {
  if (typeof keyB64 !== 'string') return null;
  try {
    const key = b64decode(keyB64);
    return key.length === 32 && (await addressFromPublicKey(key)) === address ? key : null;
  } catch {
    return null;
  }
}

/** One address logging in: `sig` over LOGIN_V3_CONTEXT\n<nonce>\n<address> with its key. */
export async function verifyAddressLogin(address: string, keyB64: unknown, nonce: string, sigB64: unknown): Promise<Uint8Array | null> {
  const key = await keyOfAddress(address, keyB64);
  if (!key || typeof sigB64 !== 'string') return null;
  try {
    return (await verifyEd25519(key, utf8(`${LOGIN_V3_CONTEXT}\n${nonce}\n${address}`), b64decode(sigB64))) ? key : null;
  } catch {
    return null;
  }
}

export interface PrekeyRecord {
  id: string;
  key: string;
  createdAt: number;
  sig: string;
}

/** A signed prekey (spec §17.3): the address key signed PREKEY_CONTEXT\n<address>\n<id>\n<key>\n<createdAt>. */
export async function verifyPrekey(address: string, addressKey: Uint8Array, p: unknown): Promise<PrekeyRecord | null> {
  const r = p as Partial<PrekeyRecord> | null;
  if (!r || typeof r.id !== 'string' || r.id.length > 64 || typeof r.key !== 'string' || typeof r.createdAt !== 'number' || typeof r.sig !== 'string') return null;
  try {
    if (b64decode(r.key).length !== 32) return null;
    const ok = await verifyEd25519(addressKey, utf8(`${PREKEY_CONTEXT}\n${address}\n${r.id}\n${r.key}\n${r.createdAt}`), b64decode(r.sig));
    return ok ? { id: r.id, key: r.key, createdAt: r.createdAt, sig: r.sig } : null;
  } catch {
    return null;
  }
}
