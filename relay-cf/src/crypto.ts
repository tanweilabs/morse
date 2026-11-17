import { BUNDLE_CONTEXT, LOGIN_CONTEXT, agentOpMessage, isKeyBundleShape, joinMessage, pairCodeMessage, profileMessage, registerMessage, type KeyBundle } from './protocol.js';

/**
 * WebCrypto-only verification of anytoany device identities (ADR-028), so it runs
 * in a Worker with no Node APIs: device ID = SHA-256 of the certificate DER (base32,
 * groups of 7), and the Ed25519 public key is read straight out of the certificate's
 * SubjectPublicKeyInfo with a 40-line DER walker. Signatures are checked with
 * `crypto.subtle` (Ed25519). The certificate is otherwise untrusted self-signed
 * material — its only job is to bind a key to a fingerprint.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// SubjectPublicKeyInfo AlgorithmIdentifier for Ed25519: SEQUENCE { OID 1.3.101.112 }
const ED25519_ALG = [0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70];

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Same derivation as anytoany's identity.ts. */
export async function deviceIdFromCert(der: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  const bare = base32(digest);
  return bare.match(/.{1,7}/g)?.join('-') ?? bare;
}

interface Tlv {
  tag: number;
  start: number; // first byte of the value
  end: number; // one past the last byte of the value
  next: number; // offset of the following element
}

function readTlv(buf: Uint8Array, off: number): Tlv {
  const tag = buf[off];
  let len = buf[off + 1];
  if (tag === undefined || len === undefined) throw new Error('DER: truncated');
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER: bad length');
    len = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[p++];
      if (b === undefined) throw new Error('DER: truncated');
      len = (len << 8) | b;
    }
  }
  if (p + len > buf.length) throw new Error('DER: truncated');
  return { tag, start: p, end: p + len, next: p + len };
}

/**
 * The raw 32-byte Ed25519 public key inside a certificate:
 * Certificate ::= SEQ { tbsCertificate SEQ { [0] version, serial, sigAlg, issuer,
 * validity, subject, spki SEQ { alg, BIT STRING }, ... }, ... }
 */
export function ed25519PublicKeyFromCert(der: Uint8Array): Uint8Array {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error('DER: not a certificate');
  const tbs = readTlv(der, cert.start);
  if (tbs.tag !== 0x30) throw new Error('DER: no tbsCertificate');
  let p = tbs.start;
  let field = readTlv(der, p);
  if (field.tag === 0xa0) {
    p = field.next; // optional [0] version
    field = readTlv(der, p);
  }
  // serial, signature algorithm, issuer, validity, subject
  for (let i = 0; i < 5; i++) {
    p = field.next;
    field = readTlv(der, p);
  }
  // now at SubjectPublicKeyInfo
  const spki = field;
  if (spki.tag !== 0x30) throw new Error('DER: no SubjectPublicKeyInfo');
  const alg = readTlv(der, spki.start);
  const algBytes = der.subarray(alg.start - 2, alg.end);
  if (algBytes.length !== ED25519_ALG.length || !ED25519_ALG.every((b, i) => algBytes[i] === b)) {
    throw new Error('certificate key is not Ed25519');
  }
  const bits = readTlv(der, alg.next);
  if (bits.tag !== 0x03 || bits.end - bits.start !== 33 || der[bits.start] !== 0) throw new Error('DER: bad Ed25519 BIT STRING');
  return der.slice(bits.start + 1, bits.end);
}

export async function verifyEd25519(publicKeyRaw: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKeyRaw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch {
    return false;
  }
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Check a login: the certificate's fingerprint IS the device ID, and the challenge
 * signature verifies under the certificate's key. Returns the device ID, or null.
 */
export async function verifyLogin(certB64: string, nonce: string, sigB64: string): Promise<string | null> {
  try {
    const der = b64decode(certB64);
    const id = await deviceIdFromCert(der);
    const pub = ed25519PublicKeyFromCert(der);
    const ok = await verifyEd25519(pub, utf8(`${LOGIN_CONTEXT}\n${nonce}`), b64decode(sigB64));
    return ok ? id : null;
  } catch {
    return null;
  }
}

/**
 * Check an invite redemption: same as a login, but the device signs
 * JOIN_CONTEXT\n<ts>\n<code> (no relay challenge — one HTTP round trip; the
 * timestamp window and the one-shot invite stand in for the nonce).
 */
export async function verifyJoin(certB64: string, ts: number, code: string, sigB64: string, agent?: string): Promise<string | null> {
  return verifySigned(certB64, joinMessage(ts, code, agent), sigB64);
}

/** Check an agent-directory request (POST /v1/agents, ADR-033): signed like a join. */
export async function verifyAgentOp(certB64: string, ts: number, op: string, agent: string, to: string, sigB64: string): Promise<string | null> {
  return verifySigned(certB64, agentOpMessage(ts, op, agent, to), sigB64);
}

/** Check an open registration (POST /v1/register, ADR-036). */
export async function verifyRegister(certB64: string, ts: number, sigB64: string, agent?: string): Promise<string | null> {
  return verifySigned(certB64, registerMessage(ts, agent), sigB64);
}

/** Check a pairing-code request (POST /v1/pair-code, ADR-036). */
export async function verifyPairCode(certB64: string, ts: number, sigB64: string): Promise<string | null> {
  return verifySigned(certB64, pairCodeMessage(ts), sigB64);
}

/** Check a nickname change (POST /v1/profile, ADR-036). */
export async function verifyProfile(certB64: string, ts: number, nickname: string, sigB64: string): Promise<string | null> {
  return verifySigned(certB64, profileMessage(ts, nickname), sigB64);
}

/** The device ID whose certificate key signed `message`, or null. */
async function verifySigned(certB64: string, message: string, sigB64: string): Promise<string | null> {
  try {
    const der = b64decode(certB64);
    const id = await deviceIdFromCert(der);
    const pub = ed25519PublicKeyFromCert(der);
    const ok = await verifyEd25519(pub, utf8(message), b64decode(sigB64));
    return ok ? id : null;
  } catch {
    return null;
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A key bundle is valid for `id` when its cert hashes to `id` and the cert's key signed encPub. */
export async function verifyBundle(id: string, bundle: unknown): Promise<KeyBundle | null> {
  if (!isKeyBundleShape(bundle) || bundle.id !== id) return null;
  try {
    const der = b64decode(bundle.cert);
    if ((await deviceIdFromCert(der)) !== id) return null;
    const pub = ed25519PublicKeyFromCert(der);
    const ok = await verifyEd25519(pub, utf8(`${BUNDLE_CONTEXT}\n${id}\n${bundle.encPub}`), b64decode(bundle.sig));
    return ok ? { id: bundle.id, cert: bundle.cert, encPub: bundle.encPub, sig: bundle.sig } : null;
  } catch {
    return null;
  }
}

export function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
