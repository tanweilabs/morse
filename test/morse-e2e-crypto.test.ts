import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOrCreateEncKey, makeKeyBundle, open, seal, verifyKeyBundle } from '../src/cluster/e2e.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';

const homes: string[] = [];
const device = () => {
  const home = mkdtempSync(join(tmpdir(), 'morse-e2e-'));
  homes.push(home);
  return { home, identity: loadOrCreateIdentity(home), enc: loadOrCreateEncKey(home) };
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe('Morse end-to-end encryption', () => {
  const alice = device();
  const bob = device();
  const mallory = device();

  it('stores the X25519 key 0600 and reuses it', () => {
    expect(statSync(join(alice.home, '.morse', 'identity', 'enc-key.pem')).mode & 0o777).toBe(0o600);
    expect(loadOrCreateEncKey(alice.home).publicDer.equals(alice.enc.publicDer)).toBe(true);
  });

  it('key bundle verifies against the pinned device ID', () => {
    const b = makeKeyBundle(bob.identity, bob.enc);
    expect(verifyKeyBundle(b, bob.identity.id).equals(bob.enc.publicDer)).toBe(true);
  });

  it('a relay that swaps in its own key is caught', () => {
    const real = makeKeyBundle(bob.identity, bob.enc);
    const fake = makeKeyBundle(mallory.identity, mallory.enc);
    // relay serves mallory's key under bob's ID
    expect(() => verifyKeyBundle({ ...real, encPub: fake.encPub }, bob.identity.id)).toThrow(/signature/);
    expect(() => verifyKeyBundle({ ...fake, id: bob.identity.id }, bob.identity.id)).toThrow(/does not belong/);
    const other = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(() => verifyKeyBundle({ ...real, encPub: other }, bob.identity.id)).toThrow();
  });

  it('seal → open round-trips and proves the sender', () => {
    const env = seal({ identity: alice.identity, recipientId: bob.identity.id, recipientEncPub: bob.enc.publicDer, plaintext: Buffer.from('hello 世界') });
    expect(JSON.stringify(env)).not.toContain('hello');
    const out = open(env, { id: bob.identity.id, enc: bob.enc });
    expect(out.fromId).toBe(alice.identity.id);
    expect(out.plaintext.toString()).toBe('hello 世界');
    expect(new X509Certificate(Buffer.from(env.cert, 'base64')).publicKey.asymmetricKeyType).toBe('ed25519');
  });

  it('rejects tampering, wrong recipient and forged senders', () => {
    const env = seal({ identity: alice.identity, recipientId: bob.identity.id, recipientEncPub: bob.enc.publicDer, plaintext: Buffer.from('secret') });
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] = ct[0]! ^ 1;
    expect(() => open({ ...env, ct: ct.toString('base64') }, { id: bob.identity.id, enc: bob.enc })).toThrow(/signature/);
    expect(() => open(env, { id: mallory.identity.id, enc: mallory.enc })).toThrow(/not addressed/);
    // mallory claims to be alice
    expect(() => open({ ...env, cert: makeKeyBundle(mallory.identity, mallory.enc).cert }, { id: bob.identity.id, enc: bob.enc })).toThrow(/certificate/);
    // mallory re-signs alice's header with her own cert → sender ID no longer alice
    const forged = seal({ identity: mallory.identity, recipientId: bob.identity.id, recipientEncPub: bob.enc.publicDer, plaintext: Buffer.from('x') });
    expect(() => open({ ...forged, from: alice.identity.id }, { id: bob.identity.id, enc: bob.enc })).toThrow();
    // a different device's key cannot decrypt even if it relabels the envelope
    expect(() => open({ ...env, to: mallory.identity.id }, { id: mallory.identity.id, enc: mallory.enc })).toThrow();
  });
});
