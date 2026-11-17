import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deviceIdFromCert, ed25519PublicKeyFromCert, verifyBundle, verifyLogin, b64decode } from '../src/crypto.js';
import { normalizeHandle, normalizeId, parseFrame, RateLimiter } from '../src/protocol.js';
import { loadOrCreateEncKey, makeKeyBundle } from '../../src/cluster/e2e.js';
import { loadOrCreateIdentity } from '../../src/cluster/identity.js';
import { signChallenge } from '../../src/cluster/relay-client.js';

/**
 * The Cloudflare Worker's WebCrypto-only identity checks must agree byte for byte
 * with the Node implementation the daemons use (identity.ts / X509Certificate).
 * The Worker itself is exercised end to end by scripts/morse-e2e-cf.sh.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-cf-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const certB64 = (pem: string) => new X509Certificate(pem).raw.toString('base64');

describe('relay-cf crypto (WebCrypto, no Node APIs)', () => {
  it('derives the same device ID as identity.ts and extracts the same Ed25519 key as X509Certificate', async () => {
    for (let i = 0; i < 5; i++) {
      const id = loadOrCreateIdentity(freshHome());
      const der = b64decode(certB64(id.certPem));
      expect(await deviceIdFromCert(der)).toBe(id.id);
      const raw = new X509Certificate(id.certPem).publicKey.export({ format: 'jwk' }) as { x: string };
      expect(Buffer.from(ed25519PublicKeyFromCert(der)).toString('base64url')).toBe(raw.x);
    }
  });

  it('verifyLogin: accepts the daemon\'s challenge signature, rejects a wrong key, garbage, or a tampered nonce', async () => {
    const me = loadOrCreateIdentity(freshHome());
    const other = loadOrCreateIdentity(freshHome());
    const nonce = 'c2VydmVyLW5vbmNl';
    expect(await verifyLogin(certB64(me.certPem), nonce, signChallenge(me, nonce))).toBe(me.id);
    expect(await verifyLogin(certB64(me.certPem), nonce, signChallenge(other, nonce))).toBeNull();
    expect(await verifyLogin(certB64(me.certPem), 'other-nonce', signChallenge(me, nonce))).toBeNull();
    expect(await verifyLogin('bm90IGEgY2VydA==', nonce, signChallenge(me, nonce))).toBeNull();
    expect(await verifyLogin(certB64(me.certPem), nonce, 'bm90IGEgc2ln')).toBeNull();
  });

  it('verifyBundle: a bundle is valid only for its own device ID, with the device\'s own signature', async () => {
    const home = freshHome();
    const me = loadOrCreateIdentity(home);
    const bundle = makeKeyBundle(me, loadOrCreateEncKey(home));
    expect(await verifyBundle(me.id, bundle)).toEqual(bundle);
    const other = loadOrCreateIdentity(freshHome());
    expect(await verifyBundle(other.id, bundle)).toBeNull();
    expect(await verifyBundle(me.id, { ...bundle, encPub: Buffer.from('swapped-by-the-relay').toString('base64') })).toBeNull();
    expect(await verifyBundle(me.id, { ...bundle, id: other.id })).toBeNull();
    expect(await verifyBundle(me.id, null)).toBeNull();
    expect(await verifyBundle(me.id, 'junk')).toBeNull();
  });

  it('rejects a certificate whose key is not Ed25519', () => {
    // RSA-looking SPKI algorithm id (1.2.840.113549.1.1.1) in an otherwise well-formed shell
    const alg = Buffer.from('300d06092a864886f70d0101010500', 'hex');
    const tbs = Buffer.concat([Buffer.from('30', 'hex'), Buffer.from([2 + alg.length + 2 + 1 + 2 + 2 + 2]), Buffer.from('020101', 'hex'), alg, Buffer.from('3000', 'hex'), Buffer.from('3000', 'hex'), Buffer.from('3000', 'hex'), Buffer.from('30', 'hex'), Buffer.from([alg.length + 3]), alg, Buffer.from('030100', 'hex')]);
    const cert = Buffer.concat([Buffer.from('30', 'hex'), Buffer.from([tbs.length]), tbs]);
    expect(() => ed25519PublicKeyFromCert(new Uint8Array(cert))).toThrow(/not Ed25519|DER/);
    expect(() => ed25519PublicKeyFromCert(new Uint8Array([0x30, 0x05, 0x02]))).toThrow(/DER/);
  });
});

describe('relay-cf protocol helpers', () => {
  it('normalises device IDs and handles', () => {
    const id = loadOrCreateIdentity(freshHome()).id;
    expect(normalizeId(id.toLowerCase().replace(/-/g, ' '))).toBe(id);
    expect(normalizeId('short')).toBeNull();
    expect(normalizeHandle(' @Mei ')).toBe('mei');
    expect(normalizeHandle('gong_zhen-2')).toBe('gong_zhen-2');
    expect(normalizeHandle('x')).toBeNull();
    expect(normalizeHandle('has space')).toBeNull();
    expect(normalizeHandle('a'.repeat(33))).toBeNull();
  });

  it('parses frames defensively and rate-limits per device', () => {
    expect(parseFrame('{"type":"send"}')).toEqual({ type: 'send' });
    expect(parseFrame('[1]')).toBeNull();
    expect(parseFrame('nope')).toBeNull();
    expect(parseFrame(new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer)).toEqual({ a: 1 });
    let t = 0;
    const rl = new RateLimiter(2, t);
    expect(rl.take(t)).toBe(true);
    expect(rl.take(t)).toBe(true);
    expect(rl.take(t)).toBe(false);
    t += 30_000; // half a minute refills one token at 2/min
    expect(rl.take(t)).toBe(true);
    expect(rl.take(t)).toBe(false);
  });
});
