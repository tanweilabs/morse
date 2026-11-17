import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { morseHome, dataDir } from '../home.js';
import { protectDataDir } from '../platform/acl.js';
import { deviceIdFromCert, type DeviceIdentity } from './identity.js';

/**
 * Morse end-to-end encryption for the relay (no home-grown primitives — all Node
 * `crypto` / OpenSSL):
 *
 * - Each device keeps, next to its Ed25519 identity (ADR-028), an X25519
 *   encryption key. Its public half is published as a KEY BUNDLE signed by the
 *   device's Ed25519 key: {cert, encPub, sig}. Anyone holding the paired device ID
 *   verifies sha256(cert) == ID and the signature — so the relay, which serves the
 *   bundles, cannot substitute its own key.
 * - Sealing: ephemeral X25519 ⨉ recipient X25519 → HKDF-SHA256 → AES-256-GCM key
 *   (fresh key per message). The header (version, from, to, ephemeral key, nonce) is
 *   GCM associated data, and the whole envelope is signed with the sender's Ed25519
 *   key; the sender's certificate travels with it so the recipient can check it
 *   against the pinned device ID.
 * The relay sees: sender ID, recipient ID, size, time. Never the content.
 */

const BUNDLE_CONTEXT = 'morse-enc-key-v1';
const ENVELOPE_CONTEXT = 'morse-envelope-v1';
const HKDF_INFO = Buffer.from('morse-v1 aes-256-gcm');

export interface EncKey {
  publicDer: Buffer; // X25519 SPKI DER
  privateKey: KeyObject;
}

export interface KeyBundle {
  id: string;
  cert: string; // base64 DER
  encPub: string; // base64 SPKI DER
  sig: string; // base64 Ed25519 over BUNDLE_CONTEXT\nid\nencPub
}

export interface SealedEnvelope {
  v: 1;
  from: string;
  to: string;
  cert: string; // sender certificate, base64 DER
  eph: string; // ephemeral X25519 SPKI DER, base64
  nonce: string; // 12 bytes, base64
  ct: string; // AES-256-GCM ciphertext || tag, base64
  sig: string; // Ed25519 over the canonical header + ct
}

const certDer = (identity: DeviceIdentity): Buffer => new X509Certificate(identity.certPem).raw;

/** This device's X25519 key, created on first use next to the identity (0600). */
export function loadOrCreateEncKey(home: string = morseHome()): EncKey {
  const dir = join(dataDir(home), 'identity');
  const path = join(dir, 'enc-key.pem');
  if (!existsSync(path)) {
    // under a lock, checked again inside it: two processes creating it at once must end up with ONE key
    withFileLock(path, () => {
      if (existsSync(path)) return;
      const { privateKey } = generateKeyPairSync('x25519');
      protectDataDir(dataDir(home)); // Windows: an ACL instead of the modes below (ADR-080)
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writeFileAtomic(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    });
  }
  const privateKey = createPrivateKey(readFileSync(path, 'utf8'));
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return { publicDer, privateKey };
}

const bundleMessage = (id: string, encPub: string): Buffer => Buffer.from(`${BUNDLE_CONTEXT}\n${id}\n${encPub}`);

/** Our signed key bundle, uploaded to the relay's directory at login. */
export function makeKeyBundle(identity: DeviceIdentity, enc: EncKey): KeyBundle {
  const encPub = enc.publicDer.toString('base64');
  const sig = sign(null, bundleMessage(identity.id, encPub), createPrivateKey(identity.keyPem)).toString('base64');
  return { id: identity.id, cert: certDer(identity).toString('base64'), encPub, sig };
}

/**
 * Check a bundle against the device ID we pinned at pairing. Throws on any
 * mismatch — a relay (or anyone) that swaps the key cannot produce a valid one.
 */
export function verifyKeyBundle(bundle: KeyBundle, expectedId: string): Buffer {
  const der = Buffer.from(bundle.cert, 'base64');
  if (deviceIdFromCert(der) !== expectedId || bundle.id !== expectedId) {
    throw new Error(`key bundle does not belong to ${expectedId}`);
  }
  const pub = new X509Certificate(der).publicKey;
  if (!verify(null, bundleMessage(expectedId, bundle.encPub), pub, Buffer.from(bundle.sig, 'base64'))) {
    throw new Error(`key bundle signature invalid for ${expectedId}`);
  }
  const encPub = Buffer.from(bundle.encPub, 'base64');
  const key = createPublicKey({ key: encPub, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('key bundle: not an X25519 key');
  return encPub;
}

const headerBytes = (e: Pick<SealedEnvelope, 'v' | 'from' | 'to' | 'eph' | 'nonce'>): Buffer =>
  Buffer.from(`${ENVELOPE_CONTEXT}\n${e.v}\n${e.from}\n${e.to}\n${e.eph}\n${e.nonce}`);

const signedBytes = (e: Omit<SealedEnvelope, 'sig'>): Buffer =>
  Buffer.concat([headerBytes(e), Buffer.from(`\n${e.cert}\n${e.ct}`)]);

function deriveKey(shared: Buffer, ephDer: Buffer, recipientDer: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephDer, recipientDer]), HKDF_INFO, 32));
}

/** Encrypt to the recipient's (verified) X25519 key and sign as this device. */
export function seal(opts: {
  identity: DeviceIdentity;
  recipientId: string;
  recipientEncPub: Buffer;
  plaintext: Buffer;
}): SealedEnvelope {
  const eph = generateKeyPairSync('x25519');
  const ephDer = eph.publicKey.export({ type: 'spki', format: 'der' });
  const recipientKey = createPublicKey({ key: opts.recipientEncPub, format: 'der', type: 'spki' });
  const key = deriveKey(diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey }), ephDer, opts.recipientEncPub);
  const nonce = randomBytes(12);
  const head = { v: 1 as const, from: opts.identity.id, to: opts.recipientId, eph: ephDer.toString('base64'), nonce: nonce.toString('base64') };
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(headerBytes(head));
  const ct = Buffer.concat([cipher.update(opts.plaintext), cipher.final(), cipher.getAuthTag()]);
  const unsigned = { ...head, cert: certDer(opts.identity).toString('base64'), ct: ct.toString('base64') };
  const sig = sign(null, signedBytes(unsigned), createPrivateKey(opts.identity.keyPem)).toString('base64');
  return { ...unsigned, sig };
}

/**
 * Verify and decrypt an envelope addressed to us. Returns the sender's device ID
 * (proven by its certificate + signature) — the caller decides whether it trusts it.
 */
export function open(envelope: SealedEnvelope, self: { id: string; enc: EncKey }): { fromId: string; plaintext: Buffer } {
  if (envelope?.v !== 1) throw new Error('unsupported envelope version');
  if (envelope.to !== self.id) throw new Error('envelope is not addressed to this device');
  const der = Buffer.from(envelope.cert, 'base64');
  if (deviceIdFromCert(der) !== envelope.from) throw new Error('sender certificate does not match sender ID');
  const { sig, ...unsigned } = envelope;
  if (!verify(null, signedBytes(unsigned), new X509Certificate(der).publicKey, Buffer.from(sig, 'base64'))) {
    throw new Error('envelope signature invalid');
  }
  const ephDer = Buffer.from(envelope.eph, 'base64');
  const ephKey = createPublicKey({ key: ephDer, format: 'der', type: 'spki' });
  const key = deriveKey(diffieHellman({ privateKey: self.enc.privateKey, publicKey: ephKey }), ephDer, self.enc.publicDer);
  const raw = Buffer.from(envelope.ct, 'base64');
  if (raw.length < 16) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAAD(headerBytes(envelope));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plaintext = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  return { fromId: envelope.from, plaintext };
}
