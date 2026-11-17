import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deviceIdFromCert } from '../cluster/identity.js';
import { morseHome, dataDir } from '../home.js';
import { addressFromPublicKey, rawPublicKey } from './address.js';

/**
 * The v3 address behind a v2 device (spec §12.2, ADR-077): a computer's FIRST address is
 * computed from its device key, so anyone holding the device's certificate — pinned in
 * ~/.morse/peer-keys.json since ADR-028, or handed over by the relay directory — can compute
 * it locally. The certificate must hash to the device ID it is claimed for.
 */
export function addressOfCert(certB64: string, deviceId?: string): string | null {
  try {
    const der = Buffer.from(certB64, 'base64');
    if (deviceId !== undefined && deviceIdFromCert(der) !== deviceId) return null;
    return addressFromPublicKey(rawPublicKey(new X509Certificate(der).publicKey));
  } catch {
    return null;
  }
}

/** device ID → address, for every certificate pinned in ~/.morse/peer-keys.json (read-only). */
export function pinnedAddresses(home: string = morseHome()): Map<string, string> {
  const out = new Map<string, string>();
  let pins: Record<string, { cert?: unknown }> = {};
  try {
    pins = JSON.parse(readFileSync(join(dataDir(home), 'peer-keys.json'), 'utf8')) as typeof pins;
  } catch {
    return out;
  }
  for (const [id, b] of Object.entries(pins ?? {})) {
    const address = typeof b?.cert === 'string' ? addressOfCert(b.cert, id) : null;
    if (address) out.set(id, address);
  }
  return out;
}
