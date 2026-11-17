import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { morseHome, dataDir } from '../home.js';
import { protectDataDir } from '../platform/acl.js';

/**
 * The key this computer holds (ADR-028), kept under ~/.morse/identity/ as key.pem + cert.pem.
 *
 * The private key is Ed25519. Next to it sits a self-signed X.509 certificate for that key, and the
 * device ID is a fingerprint of the certificate (base32 of its SHA-256). Handing out the ID reveals
 * nothing; presenting a certificate that hashes to it needs the private key.
 *
 * Node's crypto can generate the key pair but cannot issue a certificate, so the certificate is
 * assembled here as raw DER. Its layout never varies (no extensions, CN "anytoany" as both subject
 * and issuer, open-ended validity), which keeps the encoder to a handful of tag/length helpers.
 */

export interface DeviceIdentity {
  /** The device ID in its printed form: 52 base32 characters in dash-separated groups of seven. */
  id: string;
  certPem: string;
  keyPem: string;
}

/** Characters per group in a printed device ID, and so also the length of the short form. */
const GROUP = 7;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** A bare ID: the 256-bit fingerprint in base32, the last character padded with zero bits. */
const BARE_ID = /^[A-Z2-7]{52}$/;

// ---- DER building blocks -------------------------------------------------------------------------

/** Tag + definite length + content. */
function element(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  let length: Buffer;
  if (body.length < 0x80) {
    length = Buffer.of(body.length);
  } else {
    const digits: number[] = [];
    for (let rest = body.length; rest > 0; rest = Math.floor(rest / 256)) digits.push(rest % 256);
    length = Buffer.of(0x80 + digits.length, ...digits.reverse());
  }
  return Buffer.concat([Buffer.of(tag), length, body]);
}

const SEQUENCE = 0x30;
const SET = 0x31;

/**
 * A non-negative INTEGER in its one canonical DER form. Strict decoders (OpenSSL 3 under Node 20)
 * refuse superfluous leading zero bytes, so they are dropped first; a single zero is put back only
 * when the top bit of what remains is set, since that bit would otherwise read as a minus sign.
 */
export function derInteger(bytes: Buffer): Buffer {
  let first = bytes.findIndex((b) => b !== 0);
  if (first === -1) first = Math.max(0, bytes.length - 1);
  const magnitude = bytes.subarray(first);
  const needsPad = magnitude.length > 0 && magnitude[0]! >= 0x80;
  return element(0x02, needsPad ? Buffer.of(0) : Buffer.alloc(0), magnitude);
}

/** AlgorithmIdentifier for Ed25519 (OID 1.3.101.112, no parameters). */
const ED25519_ALGORITHM = element(SEQUENCE, Buffer.from('06032b6570', 'hex'));
/** OID 2.5.4.3, commonName. */
const COMMON_NAME_OID = Buffer.from('0603550403', 'hex');
/**
 * Compatibility: what the certificate names as its subject and issuer. It is part of the hashed
 * bytes and visible to whoever reads the certificate; new identities keep the form older releases
 * wrote (ADR-075).
 */
const CERT_NAME = 'anytoany';
/** Distinguished name with one attribute: CN as a UTF8String. */
const DISTINGUISHED_NAME = element(SEQUENCE, element(SET, element(SEQUENCE, COMMON_NAME_OID, element(0x0c, Buffer.from(CERT_NAME, 'utf8')))));
/** GeneralizedTime 99991231235959Z: RFC 5280's way of saying the certificate never expires. */
const NEVER_EXPIRES = element(0x18, Buffer.from('99991231235959Z', 'ascii'));

/** UTCTime, YYMMDDHHMMSSZ. */
function utcTime(at: Date): Buffer {
  const digits = at.toISOString().slice(2, 19).replace(/[-T:]/g, '');
  return element(0x17, Buffer.from(`${digits}Z`, 'ascii'));
}

const ONE_DAY_MS = 86_400_000;

/** The DER certificate for `privateKey`, self-signed. */
function issueCertificate(privateKey: KeyObject, publicKey: KeyObject, serial: Buffer, issuedAt: Date): Buffer {
  // valid from a day before issue, so a peer whose clock runs a little behind still accepts it
  const validity = element(SEQUENCE, utcTime(new Date(issuedAt.getTime() - ONE_DAY_MS)), NEVER_EXPIRES);
  const toBeSigned = element(
    SEQUENCE,
    element(0xa0, derInteger(Buffer.of(2))), // explicit [0]: version 3
    derInteger(serial),
    ED25519_ALGORITHM,
    DISTINGUISHED_NAME, // issuer
    validity,
    DISTINGUISHED_NAME, // subject
    publicKey.export({ format: 'der', type: 'spki' }),
  );
  const signatureBits = element(0x03, Buffer.of(0), sign(null, toBeSigned, privateKey)); // 0 unused bits
  return element(SEQUENCE, toBeSigned, ED25519_ALGORITHM, signatureBits);
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/[\s\S]{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`, ''].join('\n');
}

/** A new Ed25519 key with its self-signed certificate, both as PEM. */
export function createSelfSignedIdentity(now: Date = new Date()): { certPem: string; keyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // 16 random bytes; the first is forced into 0x01..0x7f so the INTEGER is positive and exactly 16 bytes long
  const serial = randomBytes(16);
  serial.writeUInt8((serial.readUInt8(0) & 0x7e) | 0x01, 0);
  return {
    certPem: pem('CERTIFICATE', issueCertificate(privateKey, publicKey, serial, now)),
    keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

// ---- device IDs ---------------------------------------------------------------------------------

/** RFC 4648 base32 without padding characters; a final partial group is filled with zero bits. */
function toBase32(bytes: Buffer): string {
  if (bytes.length === 0) return '';
  const bitCount = bytes.length * 8;
  const chars = Math.ceil(bitCount / 5);
  let n = BigInt(`0x${bytes.toString('hex')}`) << BigInt(chars * 5 - bitCount);
  const out: string[] = [];
  for (let i = 0; i < chars; i++) {
    out.push(BASE32_ALPHABET[Number(n & 31n)]!);
    n >>= 5n;
  }
  return out.reverse().join('');
}

/** Insert the dashes: a bare 52-character ID becomes XXXXXXX-XXXXXXX-…-XXX. */
export function formatDeviceId(bare: string): string {
  const groups: string[] = [];
  for (let at = 0; at < bare.length; at += GROUP) groups.push(bare.slice(at, at + GROUP));
  return groups.length ? groups.join('-') : bare;
}

/** The device ID that a DER certificate stands for. */
export function deviceIdFromCert(der: Buffer): string {
  return formatDeviceId(toBase32(createHash('sha256').update(der).digest()));
}

/** Read a device ID as people paste it (lower case, spaces, dashes in odd places); null when it is not one. */
export function normalizeDeviceId(input: string): string | null {
  const bare = input.replace(/[\s-]+/g, '').toUpperCase();
  return BARE_ID.test(bare) ? formatDeviceId(bare) : null;
}

/** The first group of an ID — enough to tell devices apart in a listing. */
export const shortDeviceId = (id: string): string => id.slice(0, GROUP);

// ---- this computer's identity -------------------------------------------------------------------

/** This computer's identity, generated the first time it is asked for. */
export function loadOrCreateIdentity(home: string = morseHome()): DeviceIdentity {
  const dir = join(dataDir(home), 'identity');
  const files = { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') };
  const complete = () => existsSync(files.cert) && existsSync(files.key);
  if (!complete()) {
    // Two morse processes may start on an empty home together. Generating under the lock, and looking
    // again once it is held, stops them pairing one process's key with the other's certificate.
    withFileLock(dir, () => {
      if (complete()) return;
      const fresh = createSelfSignedIdentity();
      // Windows gets an ACL in place of the POSIX modes below — and an error rather than a key others could read (ADR-080)
      protectDataDir(dataDir(home));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700); // the umask may have narrowed mkdir's mode; set it outright
      writeFileAtomic(files.key, fresh.keyPem, { mode: 0o600 });
      writeFileAtomic(files.cert, fresh.certPem, { mode: 0o644 });
    });
  }
  const certPem = readFileSync(files.cert, 'utf8');
  const keyPem = readFileSync(files.key, 'utf8');
  return { id: deviceIdFromCert(new X509Certificate(certPem).raw), certPem, keyPem };
}
