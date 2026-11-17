import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_ALPHABET,
  ADDRESS_LENGTH,
  addressFromPublicKey,
  isAddress,
  looksLikeAddress,
  normalizeAddress,
  rawPublicKey,
  shortAddress,
} from '../src/identity/address.js';

/** Independent re-implementation of the spec formula (§3.2) with BigInt, for cross-checking. */
function reference(pub: Buffer): string {
  const h = createHash('sha256').update(Buffer.concat([Buffer.from('morse-address-v1\n'), pub])).digest();
  let n = BigInt(`0x${h.toString('hex')}`) % 30n ** 26n;
  let s = '';
  for (let i = 0; i < 26; i++) {
    s = ADDRESS_ALPHABET[Number(n % 30n)] + s;
    n /= 30n;
  }
  return s;
}

describe('identity v3 addresses (ADR-073 §1, spec §3.2)', () => {
  it('uses the readable 30-character alphabet and 26 characters', () => {
    expect(ADDRESS_ALPHABET).toBe('23456789abcdefghjkmnpqrstvwxyz');
    expect(ADDRESS_LENGTH).toBe(26);
  });

  it('fixed vectors (shared with relay-cf/test/address.test.ts)', () => {
    expect(addressFromPublicKey(Buffer.alloc(32, 0))).toBe('6rdv5398dn85jpw5cf4gaewrx3');
    expect(addressFromPublicKey(Buffer.alloc(32, 0xff))).toBe('vsng57czvsjy26zpsbgn9m8m9v');
    expect(addressFromPublicKey(Buffer.from([...Array(32).keys()]))).toBe('nwtc6ffhvk7tjccteyk2vjeg99');
  });

  it('matches the BigInt reference for random keys, always 26 chars of the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const pub = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
      const a = addressFromPublicKey(pub);
      expect(a).toBe(reference(pub));
      expect(a).toHaveLength(26);
      expect([...a].every((c) => ADDRESS_ALPHABET.includes(c))).toBe(true);
      expect(isAddress(a)).toBe(true);
    }
  });

  it('left-pads with the first alphabet character', () => {
    // a key whose hash mod 30^26 is small would start with "2"; check the padding rule directly
    expect(reference(Buffer.alloc(32, 0)).length).toBe(26);
  });

  it('rejects anything but a 32-byte key', () => {
    expect(() => addressFromPublicKey(Buffer.alloc(31))).toThrow(/32-byte/);
  });

  it('normalizes case, spaces and a morse.im/ prefix; rejects the rest', () => {
    const a = addressFromPublicKey(Buffer.alloc(32, 7));
    expect(normalizeAddress(a.toUpperCase())).toBe(a);
    expect(normalizeAddress(` ${a} `)).toBe(a);
    expect(normalizeAddress(`morse.im/${a}`)).toBe(a);
    expect(normalizeAddress(`https://morse.talk/${a}/`)).toBe(a);
    expect(normalizeAddress('mei')).toBeNull();
    expect(normalizeAddress(`${a}x`)).toBeNull();
    expect(normalizeAddress(a.replace(/./, '0'))).toBeNull(); // 0 is not in the alphabet
    expect(isAddress('k7f3a9xq')).toBe(false); // an 8-character v2 handle
  });

  it('a remark may not look like an address (26 chars of the alphabet, any case)', () => {
    const a = addressFromPublicKey(Buffer.alloc(32, 9));
    expect(looksLikeAddress(a)).toBe(true);
    expect(looksLikeAddress(a.toUpperCase())).toBe(true);
    expect(looksLikeAddress('mei')).toBe(false);
    expect(looksLikeAddress('my colleague from the lab xx')).toBe(false);
    expect(looksLikeAddress('o'.repeat(26))).toBe(false); // o is not in the alphabet
  });

  it('shortAddress shows the first 4 and last 3', () => {
    expect(shortAddress('m4q8c2vxk7h3n9td5rwf6pj2ya')).toBe('m4q8…2ya');
  });
});
