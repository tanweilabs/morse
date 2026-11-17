import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { RELEASE_KEY_PLACEHOLDER, RELEASE_SIGNATURE_CONTEXT } from './release-key.js';

/**
 * The signed release manifest (ADR-039) — what https://morse.im/version.json holds.
 * version.json.sig is base64 Ed25519 over RELEASE_SIGNATURE_CONTEXT + the exact bytes
 * of version.json; a client verifies the bytes BEFORE it parses them.
 */
export interface ReleaseManifest {
  schema: 1;
  /** npm package name (always "anytoany" — see PACKAGE_NAME). */
  name: string;
  /** package.json version — display only; `release` decides what is newer. */
  version: string;
  /** Strictly increasing release number (UTC build time YYYYMMDDHHMMSS). */
  release: number;
  /** The package next to version.json on the site (a bare file name). */
  file: string;
  size: number;
  sha256: string;
  builtAt: string;
  /** First 16 hex of SHA-256 of the raw public key that signed it (diagnostics). */
  keyId?: string;
}

/**
 * Compatibility: the npm package keeps the old project name (ADR-075). Installed clients
 * refuse a signed version.json whose `name` is anything else, and `npm install -g` of a
 * package under another name cannot replace the `morse` bin this one owns (EEXIST) — so
 * existing installs could not update themselves across a rename.
 */
export const PACKAGE_NAME = 'anytoany';
/** A morse.tgz is ~1 MB; refuse anything absurd before downloading it. */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** base64 raw 32-byte Ed25519 public key → KeyObject (throws on anything else). */
export function publicKeyFromRaw(rawB64: string): KeyObject {
  const raw = Buffer.from(rawB64.trim(), 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== rawB64.trim()) throw new Error('not a base64 Ed25519 public key (32 bytes)');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** KeyObject (public or private Ed25519) → base64 raw 32-byte public key. */
export function rawPublicKey(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  if (pub.asymmetricKeyType !== 'ed25519') throw new Error(`not an Ed25519 key (${pub.asymmetricKeyType ?? 'unknown'})`);
  const der = pub.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

export const keyIdOf = (rawB64: string): string => createHash('sha256').update(Buffer.from(rawB64, 'base64')).digest('hex').slice(0, 16);

/**
 * The signing key as stored in the Keychain or a key file: PEM (PKCS#8), base64 of the
 * PKCS#8 DER, or base64 of the raw 32-byte seed.
 */
export function privateKeyFromText(text: string): KeyObject {
  const t = text.trim();
  if (!t) throw new Error('empty signing key');
  let key: KeyObject;
  if (t.includes('-----BEGIN')) key = createPrivateKey(t);
  else {
    const der = Buffer.from(t.replace(/\s+/g, ''), 'base64');
    if (der.length === 32) key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, der]), format: 'der', type: 'pkcs8' });
    else key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the signing key is ${key.asymmetricKeyType ?? 'unknown'}, not Ed25519`);
  return key;
}

const signedBytes = (manifestBytes: Buffer): Buffer => Buffer.concat([Buffer.from(RELEASE_SIGNATURE_CONTEXT, 'utf8'), manifestBytes]);

/** base64 detached signature over the exact manifest bytes (the release machine's side). */
export function signManifest(manifestBytes: Buffer, privateKey: KeyObject): string {
  return sign(null, signedBytes(manifestBytes), privateKey).toString('base64');
}

export type VerifyCode = 'no-key' | 'bad-signature' | 'malformed' | 'not-newer';
export type ManifestCheck =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; code: VerifyCode; error: string; /** set for 'not-newer': the authentic, but not newer, release */ manifest?: ReleaseManifest };

/** Field checks on an already-authenticated manifest. null = fine. */
export function manifestProblem(m: unknown): string | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'not a JSON object';
  const x = m as Record<string, unknown>;
  if (x['schema'] !== 1) return `unknown schema ${JSON.stringify(x['schema'])}`;
  if (x['name'] !== PACKAGE_NAME) return `package name ${JSON.stringify(x['name'])} is not "${PACKAGE_NAME}"`;
  if (typeof x['version'] !== 'string' || !/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(x['version'])) return 'bad version';
  if (typeof x['release'] !== 'number' || !Number.isSafeInteger(x['release']) || x['release'] <= 0) return 'bad release number';
  if (typeof x['file'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.tgz$/.test(x['file'])) return 'bad file name';
  if (typeof x['size'] !== 'number' || !Number.isSafeInteger(x['size']) || x['size'] <= 0 || x['size'] > MAX_PACKAGE_BYTES) return 'bad size';
  if (typeof x['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(x['sha256'])) return 'bad sha256';
  if (typeof x['builtAt'] !== 'string') return 'bad builtAt';
  return null;
}

/**
 * Authenticate a downloaded version.json against the pinned key, then check its fields,
 * then that it is strictly newer than what is installed (no downgrades, no replays).
 * installedRelease 0 = unknown (a development build): any signed release is newer.
 */
export function verifyManifest(
  manifestBytes: Buffer,
  signatureB64: string,
  opts: { publicKey: string; installedRelease: number },
): ManifestCheck {
  if (!opts.publicKey || opts.publicKey === RELEASE_KEY_PLACEHOLDER) {
    return { ok: false, code: 'no-key', error: 'this build has no release key pinned — updates are disabled (reinstall with install.sh)' };
  }
  let key: KeyObject;
  try {
    key = publicKeyFromRaw(opts.publicKey);
  } catch (e) {
    return { ok: false, code: 'no-key', error: `pinned release key unusable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const sig = Buffer.from(signatureB64.trim(), 'base64');
  let good = false;
  try {
    good = sig.length === 64 && verify(null, signedBytes(manifestBytes), key, sig);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, code: 'bad-signature', error: 'version.json signature does not verify against the trusted release key — refused' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return { ok: false, code: 'malformed', error: 'signed version.json is not JSON' };
  }
  const problem = manifestProblem(parsed);
  if (problem) return { ok: false, code: 'malformed', error: `signed version.json: ${problem}` };
  const manifest = parsed as ReleaseManifest;
  if (!(manifest.release > opts.installedRelease)) {
    return { ok: false, code: 'not-newer', error: `release ${manifest.release} is not newer than the installed ${opts.installedRelease}`, manifest };
  }
  return { ok: true, manifest };
}

/** The downloaded package must be exactly the one the signed manifest names. */
export function verifyPackage(manifest: Pick<ReleaseManifest, 'size' | 'sha256'>, tgz: Buffer): { ok: true } | { ok: false; error: string } {
  if (tgz.length !== manifest.size) return { ok: false, error: `package is ${tgz.length} bytes, the signed manifest says ${manifest.size} — refused` };
  const sha = createHash('sha256').update(tgz).digest('hex');
  if (sha !== manifest.sha256) return { ok: false, error: `package sha256 ${sha.slice(0, 16)}… does not match the signed manifest (${manifest.sha256.slice(0, 16)}…) — refused` };
  return { ok: true };
}
