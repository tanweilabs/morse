import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { BIP39_EN } from './bip39-en.js';
import { BIP39_ZH } from './bip39-zh.js';

/**
 * Recovery words (ADR-073 §3, spec §3.3): the 32-byte Ed25519 private-key seed of an
 * address, spelled as 24 BIP-39 words — the BIP-39 word list and checksum, but the seed
 * itself is encoded AS IS (no PBKDF2 / wallet derivation), so a migrated device key can be
 * backed up too. English by default, `zh` = the BIP-39 Simplified Chinese list; both spell
 * the same key. Not a wallet phrase — never type it into a wallet.
 */

export type PhraseLang = 'en' | 'zh';
const LISTS: Record<PhraseLang, readonly string[]> = { en: BIP39_EN, zh: BIP39_ZH };
const INDEX: Record<PhraseLang, Map<string, number>> = {
  en: new Map(BIP39_EN.map((w, i) => [w, i])),
  zh: new Map(BIP39_ZH.map((w, i) => [w, i])),
};

/** PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** 32-byte seed → 24 words (256 bits + 8 checksum bits, 11 bits a word). */
export function wordsFromSeed(seed: Uint8Array, lang: PhraseLang = 'en'): string[] {
  if (seed.length !== 32) throw new Error('recovery words encode a 32-byte key seed');
  const check = createHash('sha256').update(seed).digest()[0]!;
  let bits = '';
  for (const b of seed) bits += b.toString(2).padStart(8, '0');
  bits += check.toString(2).padStart(8, '0');
  const list = LISTS[lang];
  const out: string[] = [];
  for (let i = 0; i < 24; i++) out.push(list[Number.parseInt(bits.slice(i * 11, i * 11 + 11), 2)]!);
  return out;
}

/** Split what a person typed: words separated by spaces, or Chinese characters run together. */
function splitWords(input: string): string[] {
  const text = input.normalize('NFKC').trim().toLowerCase();
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 1 && [...text].length === 24) return [...text];
  return parts;
}

/** 24 words (English or Chinese) → the 32-byte seed. Throws on a typo or a bad checksum. */
export function seedFromWords(input: string | string[]): Buffer {
  const words = Array.isArray(input) ? input.map((w) => w.normalize('NFKC').trim().toLowerCase()) : splitWords(input);
  if (words.length !== 24) throw new Error(`recovery words are 24 words (got ${words.length})`);
  const lang: PhraseLang = INDEX.en.has(words[0]!) ? 'en' : 'zh';
  let bits = '';
  for (const w of words) {
    const i = INDEX[lang].get(w);
    if (i === undefined) throw new Error(`"${w}" is not a recovery word`);
    bits += i.toString(2).padStart(11, '0');
  }
  const seed = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) seed[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const check = Number.parseInt(bits.slice(256), 2);
  if (createHash('sha256').update(seed).digest()[0] !== check) throw new Error('recovery words do not check out (checksum) — a word is wrong or out of order');
  return seed;
}

/** The 32-byte seed of an Ed25519 private key. */
export function seedOfKey(key: KeyObject): Buffer {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 private key');
  const der = key.export({ type: 'pkcs8', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32));
}

/** An Ed25519 private key from its 32-byte seed. */
export function keyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
}

export const wordsOfKey = (key: KeyObject, lang: PhraseLang = 'en'): string[] => wordsFromSeed(seedOfKey(key), lang);
export const keyFromWords = (input: string | string[]): KeyObject => keyFromSeed(seedFromWords(input));
