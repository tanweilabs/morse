import { createPrivateKey, generateKeyPairSync, sign, verify, createPublicKey, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { morseHome, dataDir } from '../home.js';
import { protectDataDir } from '../platform/acl.js';
import { loadOrCreateIdentity, type DeviceIdentity } from '../cluster/identity.js';
import { addressFromPublicKey, isAddress, rawPublicKey } from './address.js';

/**
 * Address keys (ADR-073 §2, spec §3.1 / §12.2). Every address has an Ed25519 key and a
 * directory ~/.morse/addresses/<address>/ (0700) with its prekeys.
 *
 * The FIRST address of a computer is the existing device key (~/.morse/identity/key.pem):
 * whoever pinned this device before already holds the key behind its address, and an old
 * client's envelope to the device ID opens with the same key. That key is not copied — the
 * directory then has no key.pem. Any further address (one per extra agent) has its own
 * key.pem (0600) in its directory.
 */

export interface AddressKey {
  address: string;
  privateKey: KeyObject;
  /** Raw 32-byte Ed25519 public key. */
  publicKey: Buffer;
  /** ~/.morse/addresses/<address>/ */
  dir: string;
  /** 'device' = the device key (the computer's first address), 'own' = a key.pem of its own. */
  source: 'device' | 'own';
}

export const addressesDir = (home: string = morseHome()): string => join(dataDir(home), 'addresses');

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode is masked by umask
}

function keyFrom(privateKey: KeyObject, home: string, source: AddressKey['source']): AddressKey {
  const publicKey = rawPublicKey(privateKey);
  const address = addressFromPublicKey(publicKey);
  const dir = join(addressesDir(home), address);
  protectDataDir(dataDir(home)); // Windows: an ACL instead of the modes ensureDir sets (ADR-080); a no-op elsewhere and once done
  ensureDir(addressesDir(home));
  ensureDir(dir);
  ensureDir(join(dir, 'prekeys'));
  return { address, privateKey, publicKey, dir, source };
}

/** This computer's first address: the device key (created on first use, ADR-028). */
export function loadPrimaryAddress(home: string = morseHome(), identity: DeviceIdentity = loadOrCreateIdentity(home)): AddressKey {
  return keyFrom(createPrivateKey(identity.keyPem), home, 'device');
}

/**
 * This computer's first address when it has one — read only: nothing is created (a command that only
 * shows something must not make a key). null = no device key yet, or it cannot be read.
 */
export function primaryAddressIfPresent(home: string = morseHome()): string | null {
  try {
    const path = join(dataDir(home), 'identity', 'key.pem');
    if (!existsSync(path)) return null;
    return addressFromPublicKey(rawPublicKey(createPrivateKey(readFileSync(path, 'utf8'))));
  } catch {
    return null;
  }
}

/**
 * Does this computer hold the key of an address besides its first one? Read only: nothing is created.
 * (The first address is the device key — its directory here has no key.pem.) A directory that is there
 * and cannot be listed counts as "maybe": true.
 */
export function hasOtherAddressKeys(home: string = morseHome()): boolean {
  let names: string[];
  try {
    names = readdirSync(addressesDir(home));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  return names.some((name) => isAddress(name) && existsSync(join(addressesDir(home), name, 'key.pem')));
}

/** Store a key as an address of this computer (a new agent, or one restored from recovery words). */
export function saveAddressKey(privateKey: KeyObject, home: string = morseHome()): AddressKey {
  const device = loadPrimaryAddress(home);
  const k = keyFrom(privateKey, home, 'own');
  if (k.address === device.address) return device; // the device key needs no copy
  const path = join(k.dir, 'key.pem');
  if (!existsSync(path)) writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  chmodSync(path, 0o600);
  return k;
}

/** A fresh address with a key of its own. */
export function createAddressKey(home: string = morseHome()): AddressKey {
  return saveAddressKey(generateKeyPairSync('ed25519').privateKey, home);
}

/**
 * Every address this computer hosts: the device address first, then the ones with a key of
 * their own (sorted). A directory whose key.pem does not match its name is skipped.
 */
export function listAddressKeys(home: string = morseHome(), identity?: DeviceIdentity): AddressKey[] {
  const primary = loadPrimaryAddress(home, identity);
  const out: AddressKey[] = [primary];
  let names: string[] = [];
  try {
    names = readdirSync(addressesDir(home)).sort();
  } catch {
    /* none yet */
  }
  for (const name of names) {
    if (name === primary.address || !isAddress(name)) continue;
    const path = join(addressesDir(home), name, 'key.pem');
    if (!existsSync(path)) continue;
    try {
      const k = keyFrom(createPrivateKey(readFileSync(path, 'utf8')), home, 'own');
      if (k.address === name) out.push(k);
    } catch {
      /* unreadable key: not an address of ours */
    }
  }
  return out;
}

/** Ed25519 signature by an address key over `context` ‖ message (domain separation, §12.2). */
export function signAs(key: AddressKey, message: string | Uint8Array): Buffer {
  return sign(null, typeof message === 'string' ? Buffer.from(message) : Buffer.from(message), key.privateKey);
}

/** Verify a signature by a raw 32-byte Ed25519 public key. */
export function verifyBy(publicKey: Uint8Array, message: string | Uint8Array, sig: Uint8Array): boolean {
  try {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey)]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verify(null, typeof message === 'string' ? Buffer.from(message) : Buffer.from(message), key, Buffer.from(sig));
  } catch {
    return false;
  }
}
