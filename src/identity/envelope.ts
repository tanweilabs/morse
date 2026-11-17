import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { addressFromPublicKey, isAddress } from './address.js';
import { signAs, verifyBy, type AddressKey } from './address-key.js';
import type { Prekey, PrekeyRecord } from './prekeys.js';

/**
 * The v3 envelope (ADR-073 §5, spec §8.1 / §17.3): sign first, then seal the whole thing.
 *
 *   header = JSON {from, fromKey, to, ts, cert?}             (cert: P1 only — the sender's device
 *                                                              certificate, see ADR-073 §9)
 *   sig    = Ed25519(sender address key, "morse-envelope-v3\n" ‖ header ‖ "\n" ‖ body)
 *   inner  = u32(len header) ‖ header ‖ sig (64) ‖ body
 *   padded = u32(len inner) ‖ inner ‖ zeros  → 1 / 4 / 16 / 64 KB, then multiples of 64 KB
 *   outer  = {v: 3, to, enc, ct}   with HPKE (RFC 9180, Base mode, DHKEM(X25519, HKDF-SHA256),
 *            HKDF-SHA256, AES-256-GCM; info "morse-envelope-v3", aad = the recipient address)
 *            sealed to the recipient's current signed prekey
 *
 * Only `to` is visible outside: the sender is inside, under the encryption. The signature
 * covers the recipient address, so a recipient cannot re-wrap a signed envelope to a third
 * party as if the sender wrote to them. The recipient tries each prekey it still holds.
 */

export const ENVELOPE_V3_CONTEXT = 'morse-envelope-v3';
const INFO = new TextEncoder().encode(ENVELOPE_V3_CONTEXT);
const BUCKETS = [1024, 4096, 16384, 65536];
const STEP = 65536;
/** Reject envelopes older than this (the outbox waits at most 30 days) … */
export const MAX_AGE_MS = 31 * 24 * 3600_000;
/** … or dated further ahead than this. */
export const MAX_SKEW_MS = 10 * 60_000;

export interface EnvelopeV3 {
  v: 3;
  to: string;
  enc: string;
  ct: string;
}

export interface OpenedV3 {
  from: string;
  fromKey: Buffer;
  to: string;
  ts: number;
  body: Buffer;
  /** P1 bridge: the sender's device certificate (base64 DER), when it sent one. */
  cert?: string;
  /** Which of our prekeys opened it. */
  prekeyId: string;
}

/** None of our prekeys opens it (e.g. sealed to one already deleted): ask for a fresh prekey. */
export class PrekeyUnknownError extends Error {
  constructor() {
    super('none of our prekeys opens this envelope');
  }
}

let suite: CipherSuite | null = null;
const hpke = () => (suite ??= new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }));

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** The padded size for `n` bytes, never above `cap` unless `n` itself is. */
export function paddedSize(n: number, cap = Number.POSITIVE_INFINITY): number {
  const bucket = BUCKETS.find((b) => n <= b) ?? Math.ceil(n / STEP) * STEP;
  return Math.max(n, Math.min(bucket, cap));
}

/** The largest padded plaintext whose envelope JSON still fits `maxBlobBytes`. */
export function maxPaddedFor(maxBlobBytes: number): number {
  return Math.floor(((maxBlobBytes - 256) * 3) / 4) - 16;
}

const signedBytes = (header: Buffer, body: Buffer) => Buffer.concat([Buffer.from(`${ENVELOPE_V3_CONTEXT}\n`), header, Buffer.from('\n'), body]);

/** Seal `body` from `from` to `to` (whose prekey the caller verified). */
export async function sealV3(opts: {
  from: AddressKey;
  to: string;
  prekey: Pick<PrekeyRecord, 'key'>;
  body: Uint8Array;
  cert?: string;
  ts?: number;
  /** The relay's cap, so padding never pushes a message over it. */
  maxBlobBytes?: number;
}): Promise<EnvelopeV3> {
  if (!isAddress(opts.to)) throw new Error(`not an address: ${opts.to}`);
  const body = Buffer.from(opts.body);
  const header = Buffer.from(
    JSON.stringify({ from: opts.from.address, fromKey: opts.from.publicKey.toString('base64'), to: opts.to, ts: opts.ts ?? Date.now(), ...(opts.cert ? { cert: opts.cert } : {}) }),
  );
  const sig = signAs(opts.from, signedBytes(header, body));
  const inner = Buffer.concat([u32(header.length), header, sig, body]);
  const need = 4 + inner.length;
  const size = paddedSize(need, opts.maxBlobBytes ? maxPaddedFor(opts.maxBlobBytes) : undefined);
  const padded = Buffer.concat([u32(inner.length), inner, Buffer.alloc(size - need)]);
  const s = hpke();
  const pk = await s.kem.deserializePublicKey(Buffer.from(opts.prekey.key, 'base64'));
  const { ct, enc } = await s.seal({ recipientPublicKey: pk, info: INFO }, padded, Buffer.from(opts.to));
  return { v: 3, to: opts.to, enc: Buffer.from(enc).toString('base64'), ct: Buffer.from(ct).toString('base64') };
}

export function isEnvelopeV3(x: unknown): x is EnvelopeV3 {
  const e = x as Partial<EnvelopeV3> | null;
  return Boolean(e && e.v === 3 && typeof e.to === 'string' && typeof e.enc === 'string' && typeof e.ct === 'string');
}

/**
 * Open an envelope addressed to `self` with any prekey it still holds; verify the sender's
 * signature, that its key is its address, that it was meant for us, and its age.
 */
export async function openV3(env: EnvelopeV3, self: { address: string; keys: Array<Pick<Prekey, 'id' | 'priv'>> }, now: number = Date.now()): Promise<OpenedV3> {
  if (!isEnvelopeV3(env)) throw new Error('not a v3 envelope');
  if (env.to !== self.address) throw new Error('envelope is not addressed to this address');
  const s = hpke();
  const enc = Buffer.from(env.enc, 'base64');
  const ct = Buffer.from(env.ct, 'base64');
  let padded: Buffer | null = null;
  let prekeyId = '';
  for (const k of self.keys) {
    try {
      const sk = await s.kem.deserializePrivateKey(k.priv);
      padded = Buffer.from(await s.open({ recipientKey: sk, enc, info: INFO }, ct, Buffer.from(self.address)));
      prekeyId = k.id;
      break;
    } catch {
      /* not this one */
    }
  }
  if (!padded) throw new PrekeyUnknownError();
  const innerLen = padded.readUInt32BE(0);
  if (innerLen + 4 > padded.length) throw new Error('envelope: bad length');
  const inner = padded.subarray(4, 4 + innerLen);
  const headerLen = inner.readUInt32BE(0);
  if (4 + headerLen + 64 > inner.length) throw new Error('envelope: bad header length');
  const header = inner.subarray(4, 4 + headerLen);
  const sig = inner.subarray(4 + headerLen, 4 + headerLen + 64);
  const body = Buffer.from(inner.subarray(4 + headerLen + 64));
  let h: { from?: unknown; fromKey?: unknown; to?: unknown; ts?: unknown; cert?: unknown };
  try {
    h = JSON.parse(header.toString('utf8')) as typeof h;
  } catch {
    throw new Error('envelope: bad header');
  }
  if (typeof h.from !== 'string' || typeof h.fromKey !== 'string' || typeof h.to !== 'string' || typeof h.ts !== 'number') throw new Error('envelope: bad header');
  const fromKey = Buffer.from(h.fromKey, 'base64');
  if (fromKey.length !== 32 || addressFromPublicKey(fromKey) !== h.from) throw new Error('envelope: sender key does not match the sender address');
  if (!verifyBy(fromKey, signedBytes(header, body), sig)) throw new Error('envelope signature invalid');
  if (h.to !== self.address) throw new Error('envelope was signed for another address');
  if (h.ts < now - MAX_AGE_MS) throw new Error('envelope is older than 31 days');
  if (h.ts > now + MAX_SKEW_MS) throw new Error("envelope is dated in the future (check this computer's clock)");
  return { from: h.from, fromKey, to: h.to, ts: h.ts, body, ...(typeof h.cert === 'string' ? { cert: h.cert } : {}), prekeyId };
}
