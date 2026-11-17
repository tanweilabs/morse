import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { addressFromPublicKey, rawPublicKey } from '../src/identity/address.js';
import { addressesDir, createAddressKey, listAddressKeys, loadPrimaryAddress, saveAddressKey, signAs, verifyBy } from '../src/identity/address-key.js';
import { keyFromWords, wordsOfKey } from '../src/identity/phrase.js';
import { ensurePrekeys, PREKEY_JITTER_MS, PREKEY_KEEP_MS, PREKEY_ROTATE_MS, prekeyMessage, verifyPrekey, x25519PrivateKey } from '../src/identity/prekeys.js';

const homes: string[] = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-idkeys-'));
  homes.push(h);
  return h;
};
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const mode = (p: string) => statSync(p).mode & 0o777;

describe('address keys (ADR-073 §2, spec §3.1 / §12.2)', () => {
  it('the first address IS the device key: same key as the certificate, no copy of the private key', () => {
    const h = home();
    const id = loadOrCreateIdentity(h);
    const a = loadPrimaryAddress(h);
    expect(a.source).toBe('device');
    const certKey = rawPublicKey(new X509Certificate(id.certPem).publicKey);
    expect(a.address).toBe(addressFromPublicKey(certKey));
    expect(existsSync(join(a.dir, 'key.pem'))).toBe(false);
    expect(mode(addressesDir(h))).toBe(0o700);
    expect(mode(a.dir)).toBe(0o700);
    expect(loadPrimaryAddress(h).address).toBe(a.address); // stable
  });

  it('further addresses get their own key.pem (0600); list = device first, then the others', () => {
    const h = home();
    const p = loadPrimaryAddress(h);
    const b = createAddressKey(h);
    const c = createAddressKey(h);
    expect(b.source).toBe('own');
    expect(mode(join(b.dir, 'key.pem'))).toBe(0o600);
    const list = listAddressKeys(h).map((k) => k.address);
    expect(list[0]).toBe(p.address);
    expect(new Set(list)).toEqual(new Set([p.address, b.address, c.address]));
    // a stray directory and a key filed under the wrong name are not addresses of ours
    mkdirSync(join(addressesDir(h), 'not-an-address'));
    const wrong = join(addressesDir(h), '2'.repeat(26));
    mkdirSync(wrong);
    writeFileSync(join(wrong, 'key.pem'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    expect(listAddressKeys(h)).toHaveLength(3);
  });

  it('a key restored from recovery words comes back as the same address; the device key is never copied', () => {
    const h = home();
    const b = createAddressKey(h);
    const words = wordsOfKey(b.privateKey);
    const h2 = home();
    const back = saveAddressKey(keyFromWords(words), h2);
    expect(back.address).toBe(b.address);
    const dev = loadPrimaryAddress(h2);
    expect(saveAddressKey(createPrivateKey(loadOrCreateIdentity(h2).keyPem), h2)).toMatchObject({ address: dev.address, source: 'device' });
    expect(existsSync(join(dev.dir, 'key.pem'))).toBe(false);
  });

  it('signAs / verifyBy', () => {
    const k = loadPrimaryAddress(home());
    const sig = signAs(k, 'morse-test\nhello');
    expect(verifyBy(k.publicKey, 'morse-test\nhello', sig)).toBe(true);
    expect(verifyBy(k.publicKey, 'morse-test\nhellO', sig)).toBe(false);
    expect(verifyBy(Buffer.alloc(5), 'x', sig)).toBe(false);
  });
});

describe('signed prekeys (ADR-073 §4, spec §17.3)', () => {
  it('creates a signed X25519 prekey; the record verifies only for its address', () => {
    const k = loadPrimaryAddress(home());
    const s = ensurePrekeys(k, 1_000);
    expect(s.rotated).toBe(true);
    expect(verifyPrekey(s.current, k.address, k.publicKey)).toBe(true);
    const other = createAddressKey(home());
    expect(verifyPrekey(s.current, other.address, other.publicKey)).toBe(false);
    expect(verifyPrekey(s.current, other.address, k.publicKey)).toBe(false);
    expect(verifyPrekey({ ...s.current, key: Buffer.alloc(32, 1).toString('base64') }, k.address, k.publicKey)).toBe(false);
    expect(verifyPrekey({ ...s.current, createdAt: 2 }, k.address, k.publicKey)).toBe(false);
    expect(verifyPrekey(null, k.address, k.publicKey)).toBe(false);
    expect(prekeyMessage(k.address, s.current)).toContain('morse-prekey-v1\n');
    // the private half belongs to the published key, file 0600
    const priv = x25519PrivateKey(s.keys[0]!.priv);
    const pubRaw = createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(-32);
    expect(Buffer.from(pubRaw).toString('base64')).toBe(s.current.key);
    expect(mode(join(k.dir, 'prekeys', `${s.current.id}.json`))).toBe(0o600);
    // the key works for ECDH
    const eph = generateKeyPairSync('x25519');
    expect(diffieHellman({ privateKey: priv, publicKey: eph.publicKey })).toHaveLength(32);
  });

  it('keeps the same prekey for 7 days, then rotates; an old private key is kept 8 more days, then deleted', () => {
    const k = loadPrimaryAddress(home());
    const t0 = 1_000_000;
    const a = ensurePrekeys(k, t0);
    expect(ensurePrekeys(k, t0 + PREKEY_ROTATE_MS - 1)).toMatchObject({ rotated: false, current: { id: a.current.id } });
    const b = ensurePrekeys(k, t0 + PREKEY_ROTATE_MS);
    expect(b.rotated).toBe(true);
    expect(b.current.id).not.toBe(a.current.id);
    expect(b.keys.map((p) => p.id)).toEqual([b.current.id, a.current.id]);
    expect(b.keys[1]!.retiredAt).toBe(t0 + PREKEY_ROTATE_MS);
    // one more week: b is replaced too, a (retired 8 days minus 1 ms ago) is still kept
    const c = ensurePrekeys(k, t0 + PREKEY_ROTATE_MS + PREKEY_KEEP_MS - 1);
    expect(c.keys.map((p) => p.id)).toEqual([c.current.id, b.current.id, a.current.id]);
    const d = ensurePrekeys(k, t0 + PREKEY_ROTATE_MS + PREKEY_KEEP_MS);
    expect(d.keys.map((p) => p.id)).toEqual([c.current.id, b.current.id]);
    expect(readdirSync(join(k.dir, 'prekeys')).sort()).toEqual([`${b.current.id}.json`, `${c.current.id}.json`].sort());
  });

  it('after two weeks switched off: the first check makes a new one and keeps the old for in-flight mail', () => {
    const k = loadPrimaryAddress(home());
    const a = ensurePrekeys(k, 0);
    const later = ensurePrekeys(k, 14 * 24 * 3600_000);
    expect(later.rotated).toBe(true);
    expect(later.keys.map((p) => p.id)).toEqual([later.current.id, a.current.id]);
  });

  it('ignores an unreadable prekey file', () => {
    const k = loadPrimaryAddress(home());
    writeFileSync(join(k.dir, 'prekeys', 'junk.json'), '{');
    expect(ensurePrekeys(k, 5).keys).toHaveLength(1);
  });
  it('prekeys of two addresses do not line up in time (ADR-083): each new one is dated a random stretch back and rotates on its own', () => {
    // two addresses of ONE computer: its own key and a second address made on it
    const h = home();
    const key = () => loadPrimaryAddress(home());
    const [a, b] = [loadPrimaryAddress(h), createAddressKey(h)];
    const now = Date.now();
    const pa = ensurePrekeys(a).current;
    const pb = ensurePrekeys(b).current;
    for (const p of [pa, pb]) {
      expect(p.createdAt).toBeLessThanOrEqual(Date.now());
      expect(p.createdAt).toBeGreaterThan(now - PREKEY_JITTER_MS - 1000);
    }
    // same daemon start, yet not the 1 ms apart they used to be (a collision within a minute: 1 in ~4000)
    expect(Math.abs(pa.createdAt - pb.createdAt)).toBeGreaterThan(60_000);
    expect(verifyPrekey(pa, a.address, a.publicKey)).toBe(true);
    // a caller that passes the time gets exactly that time; an explicit jitter is honoured and brings rotation forward
    const c = key();
    expect(ensurePrekeys(c, 5_000_000_000).current.createdAt).toBe(5_000_000_000);
    const d = key();
    const first = ensurePrekeys(d, 9_000_000_000, { jitterMs: 1000 }).current;
    expect(first.createdAt).toBe(8_999_999_000);
    expect(ensurePrekeys(d, 9_000_000_000 + PREKEY_ROTATE_MS - 1001).rotated).toBe(false);
    expect(ensurePrekeys(d, 9_000_000_000 + PREKEY_ROTATE_MS - 1000).rotated).toBe(true);
  });
});
