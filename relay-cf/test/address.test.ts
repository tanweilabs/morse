import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addressFromPublicKey, keyOfAddress, normalizeAddress, verifyAddressLogin, verifyPrekey } from '../src/address.js';
import { RateLimiter } from '../src/protocol.js';
import { ALIAS_RATE_PER_MINUTE, MAX_CAPS, chargeAliasLookups, chargeNewAddresses, checkV3Send, helloEntries, normalizeCaps, v3SettingsFromEnv, type CounterStore } from '../src/v3.js';
import { addressFromPublicKey as clientAddress, rawPublicKey } from '../../src/identity/address.js';
import { loadPrimaryAddress, signAs } from '../../src/identity/address-key.js';
import { ensurePrekeys } from '../../src/identity/prekeys.js';

/** The Worker's WebCrypto address code must agree byte for byte with the client's (ADR-073). */

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const key = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-cf3-'));
  homes.push(h);
  return loadPrimaryAddress(h);
};

describe('relay-cf v3 addresses (WebCrypto)', () => {
  it('same fixed vectors as the client (test/identity-address.test.ts)', async () => {
    expect(await addressFromPublicKey(new Uint8Array(32))).toBe('6rdv5398dn85jpw5cf4gaewrx3');
    expect(await addressFromPublicKey(new Uint8Array(32).fill(0xff))).toBe('vsng57czvsjy26zpsbgn9m8m9v');
    expect(await addressFromPublicKey(Uint8Array.from([...Array(32).keys()]))).toBe('nwtc6ffhvk7tjccteyk2vjeg99');
    await expect(addressFromPublicKey(new Uint8Array(3))).rejects.toThrow(/32-byte/);
  });

  it('agrees with the client for random keys', async () => {
    for (let i = 0; i < 50; i++) {
      const pub = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
      expect(await addressFromPublicKey(pub)).toBe(clientAddress(pub));
    }
  });

  it('normalizeAddress / keyOfAddress', async () => {
    const k = key();
    expect(normalizeAddress(` ${k.address.toUpperCase()} `)).toBe(k.address);
    expect(normalizeAddress('k7f3a9xq')).toBeNull();
    expect(normalizeAddress(5)).toBeNull();
    expect(await keyOfAddress(k.address, k.publicKey.toString('base64'))).not.toBeNull();
    expect(await keyOfAddress(k.address, key().publicKey.toString('base64'))).toBeNull();
    expect(await keyOfAddress(k.address, 7)).toBeNull();
    expect(await keyOfAddress(k.address, '!!!')).toBeNull();
  });

  it('a login signature by the address key verifies; anything else does not', async () => {
    const k = key();
    const sig = signAs(k, `morse-relay-login-v3\nN0NCE\n${k.address}`).toString('base64');
    const pub = k.publicKey.toString('base64');
    expect(await verifyAddressLogin(k.address, pub, 'N0NCE', sig)).not.toBeNull();
    expect(await verifyAddressLogin(k.address, pub, 'other', sig)).toBeNull();
    expect(await verifyAddressLogin(key().address, pub, 'N0NCE', sig)).toBeNull();
    expect(await verifyAddressLogin(k.address, pub, 'N0NCE', 5)).toBeNull();
  });

  it('a prekey signed by the client verifies at the relay', async () => {
    const k = key();
    const p = ensurePrekeys(k).current;
    expect(await verifyPrekey(k.address, k.publicKey, p)).toEqual(p);
    expect(await verifyPrekey(k.address, k.publicKey, { ...p, createdAt: 1 })).toBeNull();
    expect(await verifyPrekey(k.address, k.publicKey, { ...p, key: 'AAAA' })).toBeNull();
    expect(await verifyPrekey(k.address, k.publicKey, null)).toBeNull();
  });
});

describe('relay-cf v3 frames', () => {
  const a = '6rdv5398dn85jpw5cf4gaewrx3';
  const b = 'vsng57czvsjy26zpsbgn9m8m9v';
  it('helloEntries: v3, 1..32 distinct addresses, the first is the URL one', () => {
    const e = (address: string) => ({ address, key: 'k', sig: 's' });
    expect(helloEntries({ type: 'hello', v: 3, addresses: [e(a), e(b)] }, a)?.map((x) => x.address)).toEqual([a, b]);
    expect(helloEntries({ type: 'hello', v: 3, addresses: [e(b), e(a)] }, a)).toBeNull();
    expect(helloEntries({ type: 'hello', v: 3, addresses: [e(a), e(a)] }, a)).toBeNull();
    expect(helloEntries({ type: 'hello', v: 3, addresses: [] }, a)).toBeNull();
    expect(helloEntries({ type: 'hello', addresses: [e(a)] }, a)).toBeNull();
    expect(helloEntries({ type: 'hello', v: 3, addresses: [e('nope')] }, a)).toBeNull();
    expect(helloEntries({ type: 'hello', v: 3, addresses: Array.from({ length: 33 }, () => e(a)) }, a)).toBeNull();
  });

  it('caps (ADR-081): well-formed ones are kept (each once, at most 8), anything else is dropped — never an error; a hello entry always carries an array', () => {
    expect(normalizeCaps(['addr1'])).toEqual(['addr1']);
    expect(normalizeCaps(['addr1', 'x2', 'addr1', 'a'.repeat(16)])).toEqual(['addr1', 'x2', 'a'.repeat(16)]);
    // wrong shape: upper case, other characters, empty, 17 characters, not a string
    expect(normalizeCaps(['Addr1', 'addr-1', 'addr 1', '', 'a'.repeat(17), 7, null, undefined, {}, ['addr1'], 'ok'])).toEqual(['ok']);
    // not a list at all
    for (const bad of [undefined, null, 'addr1', 1, true, { 0: 'addr1' }]) expect(normalizeCaps(bad)).toEqual([]);
    // more than 8: the first 8 well-formed ones
    const many = Array.from({ length: 20 }, (_, i) => `c${i}`);
    expect(MAX_CAPS).toBe(8);
    expect(normalizeCaps(many)).toEqual(many.slice(0, 8));
    expect(normalizeCaps(['BAD', ...many])).toEqual(many.slice(0, 8));

    const e = (address: string, caps?: unknown) => ({ address, key: 'k', sig: 's', ...(caps !== undefined ? { caps } : {}) });
    // an old-style hello (no caps) is what it always was — its entries just say "none"
    expect(helloEntries({ type: 'hello', v: 3, addresses: [e(a), e(b)] }, a)).toEqual([
      { address: a, key: 'k', sig: 's', caps: [] },
      { address: b, key: 'k', sig: 's', caps: [] },
    ]);
    // per address; a malformed caps field never fails the login
    expect(helloEntries({ type: 'hello', v: 3, addresses: [e(a, ['addr1']), e(b, 'addr1')] }, a)?.map((x) => x.caps)).toEqual([['addr1'], []]);
    expect(helloEntries({ type: 'hello', v: 3, addresses: [e(a, ['addr1', 'NOPE', 3, 'next9']), e(b, { addr1: true })] }, a)?.map((x) => x.caps)).toEqual([['addr1', 'next9'], []]);
    expect(helloEntries({ type: 'hello', v: 3, addresses: [e(a, many)] }, a)?.[0]?.caps).toHaveLength(8);
  });

  it('checkV3Send', () => {
    expect(checkV3Send({ to: b, blob: 'x' }, [a], 10)).toEqual({ ok: true, to: b, from: a, blob: 'x' });
    expect(checkV3Send({ to: b, blob: 'x', from: b, ref: 'm1' }, [a, b], 10)).toEqual({ ok: true, to: b, from: b, blob: 'x', ref: 'm1' });
    expect(checkV3Send({ to: 'x', blob: 'x' }, [a], 10)).toMatchObject({ ok: false, error: 'bad recipient address' });
    expect(checkV3Send({ to: b, blob: 'x', from: b }, [a], 10)).toMatchObject({ ok: false });
    expect(checkV3Send({ to: b, blob: '' }, [a], 10)).toMatchObject({ ok: false, error: 'empty blob' });
    expect(checkV3Send({ to: b, blob: 'x'.repeat(11) }, [a], 10)).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) });
    expect(checkV3Send({ to: b, blob: 'x', ref: 'r'.repeat(200) }, [a], 10)).toMatchObject({ ok: false, error: 'bad ref' });
    const lim = new RateLimiter(1, 0);
    expect(checkV3Send({ to: b, blob: 'x' }, [a], 10, lim, 0).ok).toBe(true);
    expect(checkV3Send({ to: b, blob: 'x' }, [a], 10, lim, 0)).toMatchObject({ ok: false, error: expect.stringMatching(/rate limited/) });
  });

  it('settings: 7-day mailbox, no send bucket, 100 new addresses per IP per hour by default', () => {
    expect(v3SettingsFromEnv({})).toEqual({ mailboxTtlMs: 7 * 86400_000, mailboxMaxMessages: 2000, mailboxMaxBytes: 200 * 1024 * 1024, ratePerMinute: 0, ratePerIpPerMinute: 600, newAddressesPerIpPerHour: 100 });
    expect(v3SettingsFromEnv({ MAILBOX_TTL_SEC: '3', V3_RATE_PER_MINUTE: '1000', NEW_ADDRESSES_PER_IP_PER_HOUR: 'x' })).toMatchObject({ mailboxTtlMs: 3000, ratePerMinute: 1000, newAddressesPerIpPerHour: 100 });
  });

  it('chargeNewAddresses: a fixed one-hour window per IP; 0 = no limit', async () => {
    const m = new Map<string, unknown>();
    const store: CounterStore = {
      get: async <T>(k: string) => m.get(k) as T | undefined,
      put: async (k, v) => void m.set(k, v),
      delete: async (k) => m.delete(k),
      list: async <T>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]>),
    };
    expect(await chargeNewAddresses(store, '1.2.3.4', 2, 3, 0)).toEqual({ ok: true });
    expect(await chargeNewAddresses(store, '1.2.3.4', 2, 3, 10)).toMatchObject({ ok: false, retryAfterSec: 3600 });
    expect(await chargeNewAddresses(store, '1.2.3.4', 1, 3, 10)).toEqual({ ok: true });
    expect(await chargeNewAddresses(store, '5.6.7.8', 3, 3, 10)).toEqual({ ok: true });
    expect(await chargeNewAddresses(store, '1.2.3.4', 1, 3, 3600_000)).toEqual({ ok: true }); // next hour
    expect(await chargeNewAddresses(store, '1.2.3.4', 99, 0, 0)).toEqual({ ok: true });
    expect([...m.keys()].some((k) => k.includes('1.2.3.4'))).toBe(false); // only hashes
  });

  it('alias lookups are bounded too (ADR-077): per IP per hour over HTTP, a counter of their own; per connection per minute over the socket', async () => {
    const m = new Map<string, unknown>();
    const store: CounterStore = {
      get: async <T>(k: string) => m.get(k) as T | undefined,
      put: async (k, v) => void m.set(k, v),
      delete: async (k) => m.delete(k),
      list: async <T>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix)) as Array<[string, T]>),
    };
    expect(await chargeAliasLookups(store, '1.2.3.4', 2, 0)).toEqual({ ok: true });
    expect(await chargeAliasLookups(store, '1.2.3.4', 2, 1)).toEqual({ ok: true });
    expect(await chargeAliasLookups(store, '1.2.3.4', 2, 2)).toMatchObject({ ok: false, retryAfterSec: 3600 });
    expect(await chargeAliasLookups(store, '9.9.9.9', 2, 2)).toEqual({ ok: true }); // another network
    expect(await chargeAliasLookups(store, '1.2.3.4', 2, 3600_000)).toEqual({ ok: true }); // next hour
    // not the new-address counter: publishing addresses is unaffected by lookups
    expect(await chargeNewAddresses(store, '1.2.3.4', 1, 1, 5)).toEqual({ ok: true });
    expect([...m.keys()].every((k) => k.startsWith('ipa:') || k.startsWith('ip3:'))).toBe(true);
    const lim = new RateLimiter(ALIAS_RATE_PER_MINUTE, 0);
    for (let i = 0; i < ALIAS_RATE_PER_MINUTE; i++) expect(lim.take(0)).toBe(true);
    expect(lim.take(0)).toBe(false);
  });
});
