import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BIP39_EN } from '../src/identity/bip39-en.js';
import { BIP39_ZH } from '../src/identity/bip39-zh.js';
import { addressOfKey } from '../src/identity/address.js';
import { keyFromSeed, keyFromWords, seedFromWords, seedOfKey, wordsFromSeed, wordsOfKey } from '../src/identity/phrase.js';

const listHash = (l: readonly string[]) => createHash('sha256').update(`${l.join('\n')}\n`).digest('hex');

describe('recovery words: BIP-39 encoding of the 32-byte key seed (ADR-073 §3, spec §3.3)', () => {
  it('the word lists are the official BIP-39 files', () => {
    expect(BIP39_EN).toHaveLength(2048);
    expect(BIP39_ZH).toHaveLength(2048);
    expect(listHash(BIP39_EN)).toBe('2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
    expect(listHash(BIP39_ZH)).toBe('5c5942792bd8340cb8b27cd592f1015edf56a8c5b26276ee18a482428e7c5726');
  });

  it('official BIP-39 test vectors (256-bit entropy → 24 words)', () => {
    const cases: Array<[string, string]> = [
      ['00'.repeat(32), `${'abandon '.repeat(23)}art`],
      ['7f'.repeat(32), 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'],
      ['80'.repeat(32), 'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless'],
      ['ff'.repeat(32), `${'zoo '.repeat(23)}vote`],
      ['68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c', 'hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length'],
    ];
    for (const [hex, words] of cases) {
      expect(wordsFromSeed(Buffer.from(hex, 'hex')).join(' ')).toBe(words);
      expect(seedFromWords(words).toString('hex')).toBe(hex);
    }
  });

  it('English and Chinese spell the same key; Chinese works with or without spaces', () => {
    const seed = Buffer.from('68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c', 'hex');
    const zh = wordsFromSeed(seed, 'zh');
    expect(zh).toHaveLength(24);
    expect(seedFromWords(zh.join(' ')).equals(seed)).toBe(true);
    expect(seedFromWords(zh.join('')).equals(seed)).toBe(true);
    expect(seedFromWords(` ${wordsFromSeed(seed).join('  ').toUpperCase()} `).equals(seed)).toBe(true);
  });

  it('round-trips an Ed25519 key — same address after restoring', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const words = wordsOfKey(privateKey);
    expect(words).toHaveLength(24);
    const back = keyFromWords(words.join(' '));
    expect(addressOfKey(back)).toBe(addressOfKey(privateKey));
    expect(seedOfKey(back).equals(seedOfKey(privateKey))).toBe(true);
    expect(addressOfKey(keyFromSeed(seedOfKey(privateKey)))).toBe(addressOfKey(privateKey));
  });

  it('rejects a wrong word, a wrong count and a bad checksum', () => {
    expect(() => seedFromWords(`${'abandon '.repeat(23)}notaword`)).toThrow(/not a recovery word/);
    expect(() => seedFromWords('abandon abandon abandon')).toThrow(/24 words/);
    expect(() => seedFromWords(`${'abandon '.repeat(23)}abandon`)).toThrow(/checksum/);
    expect(() => seedFromWords(`abandon ${'的 '.repeat(23)}`)).toThrow();
    expect(() => wordsFromSeed(Buffer.alloc(16))).toThrow(/32-byte/);
  });
});
