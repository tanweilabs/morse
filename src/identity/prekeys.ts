import { createPrivateKey, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyMatchesAddress } from './address.js';
import { signAs, verifyBy, type AddressKey } from './address-key.js';

/**
 * Signed prekeys (ADR-073 §4, spec §17.3 step 1 — Signal's X3DH signed prekey, no one-time
 * prekeys). Each address publishes ONE X25519 key signed by its address key; envelopes are
 * sealed to it. A new one every 7 days; a replaced key's private half stays 8 more days (the
 * offline mailbox keeps envelopes up to 7) and is then deleted — so a computer broken into at
 * time T exposes about two weeks of captured traffic, not all of it.
 *
 *   record = {id, key: base64 raw X25519 public key, createdAt, sig}
 *   sig    = Ed25519(address key, "morse-prekey-v1\n<address>\n<id>\n<key>\n<createdAt>")
 *
 * Private halves: ~/.morse/addresses/<address>/prekeys/<id>.json (0600).
 */

export const PREKEY_CONTEXT = 'morse-prekey-v1';
export const PREKEY_ROTATE_MS = 7 * 24 * 3600_000;
export const PREKEY_KEEP_MS = 8 * 24 * 3600_000;
/** ADR-083: a new prekey is dated up to this far into the past (so it is replaced after 4–7 days, never later than 7). */
export const PREKEY_JITTER_MS = 3 * 24 * 3600_000;

export interface PrekeyRecord {
  id: string;
  key: string;
  createdAt: number;
  sig: string;
}

export interface Prekey extends PrekeyRecord {
  /** Raw 32-byte X25519 private key. */
  priv: Buffer;
  /** When a newer prekey replaced it (undefined = current). */
  retiredAt?: number;
}

interface PrekeyFile extends PrekeyRecord {
  priv: string;
  retiredAt?: number;
}

export const prekeyMessage = (address: string, r: Pick<PrekeyRecord, 'id' | 'key' | 'createdAt'>): string =>
  `${PREKEY_CONTEXT}\n${address}\n${r.id}\n${r.key}\n${r.createdAt}`;

/** Does `record` carry a valid signature by `addressKey` (raw), and is that the key of `address`? */
export function verifyPrekey(record: unknown, address: string, addressKey: Uint8Array): record is PrekeyRecord {
  const r = record as Partial<PrekeyRecord> | null;
  if (!r || typeof r.id !== 'string' || typeof r.key !== 'string' || typeof r.createdAt !== 'number' || typeof r.sig !== 'string') return false;
  if (!keyMatchesAddress(addressKey, address)) return false;
  if (Buffer.from(r.key, 'base64').length !== 32) return false;
  return verifyBy(addressKey, prekeyMessage(address, r as PrekeyRecord), Buffer.from(r.sig, 'base64'));
}

const dirOf = (key: AddressKey) => join(key.dir, 'prekeys');

function readAll(key: AddressKey): Prekey[] {
  let names: string[] = [];
  try {
    names = readdirSync(dirOf(key)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Prekey[] = [];
  for (const n of names) {
    try {
      const f = JSON.parse(readFileSync(join(dirOf(key), n), 'utf8')) as PrekeyFile;
      out.push({ id: f.id, key: f.key, createdAt: f.createdAt, sig: f.sig, priv: Buffer.from(f.priv, 'base64'), ...(f.retiredAt ? { retiredAt: f.retiredAt } : {}) });
    } catch {
      /* unreadable: ignore */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function write(key: AddressKey, p: Prekey): void {
  const path = join(dirOf(key), `${p.id}.json`);
  const f: PrekeyFile = { id: p.id, key: p.key, createdAt: p.createdAt, sig: p.sig, priv: p.priv.toString('base64'), ...(p.retiredAt ? { retiredAt: p.retiredAt } : {}) };
  writeFileSync(path, `${JSON.stringify(f)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function fresh(key: AddressKey, now: number): Prekey {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const r = { id: randomBytes(8).toString('hex'), key: Buffer.from(spki.subarray(spki.length - 32)).toString('base64'), createdAt: now };
  return { ...r, sig: signAs(key, prekeyMessage(key.address, r)).toString('base64'), priv: Buffer.from(pkcs8.subarray(pkcs8.length - 32)) };
}

export interface PrekeyState {
  /** What the relay publishes for this address. */
  current: PrekeyRecord;
  /** Every private prekey still kept (current first) — what an envelope may be sealed to. */
  keys: Prekey[];
  /** true = this call made a new one (publish it). */
  rotated: boolean;
}

/**
 * Make sure the address has a current prekey no older than 7 days; retire the old one and
 * delete those retired more than 8 days ago. Runs at start and then periodically.
 *
 * (ADR-083 review R4) WHEN a prekey is replaced is something anyone can watch on the relay, so the daemon
 * does not replace the prekeys of all its addresses in one go (src/identity/prekey-schedule.ts):
 *   `rotate: false`  only make sure there IS a current prekey (a daemon start: an existing one is kept even
 *                    when it is due — it is replaced at this address's own moment);
 *   `force: true`    replace the current one now although it is not due.
 */
export function ensurePrekeys(key: AddressKey, at?: number, opts: { jitterMs?: number; rotate?: boolean; force?: boolean } = {}): PrekeyState {
  const now = at ?? Date.now();
  // ADR-083: the published `createdAt` of two addresses of one computer must not line up (they are made
  // in the same daemon start and would rotate in the same tick — anyone who looks both up could link
  // them). Each new prekey is dated a random stretch into the past, so it also rotates at its own time.
  // Deterministic when a caller passes the time (tests, tools).
  const jitter = opts.jitterMs ?? (at === undefined ? randomInt(0, PREKEY_JITTER_MS) : 0);
  let all = readAll(key);
  let rotated = false;
  const current = all.find((p) => !p.retiredAt);
  if (!current || (opts.rotate !== false && (opts.force || now - current.createdAt >= PREKEY_ROTATE_MS))) {
    for (const p of all) {
      if (!p.retiredAt) {
        p.retiredAt = now;
        write(key, p);
      }
    }
    const p = fresh(key, now - jitter);
    write(key, p);
    rotated = true;
    all = [p, ...all];
  }
  const kept: Prekey[] = [];
  for (const p of all) {
    if (p.retiredAt && now - p.retiredAt >= PREKEY_KEEP_MS) rmSync(join(dirOf(key), `${p.id}.json`), { force: true });
    else kept.push(p);
  }
  const cur = kept.find((p) => !p.retiredAt)!;
  return { current: { id: cur.id, key: cur.key, createdAt: cur.createdAt, sig: cur.sig }, keys: [cur, ...kept.filter((p) => p !== cur)], rotated };
}

/** A raw X25519 private key as a Node KeyObject (for tests and tooling). */
export function x25519PrivateKey(raw: Buffer) {
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
}
