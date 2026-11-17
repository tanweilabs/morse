import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { sign, verify, type KeyObject } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dataDir } from '../home.js';
import { keyIdOf, publicKeyFromRaw, rawPublicKey } from './manifest.js';
import { ROTATION_SIGNATURE_CONTEXT } from './release-key.js';

/**
 * Release-signing-key rotation (ADR-041).
 *
 * A rotation statement says "the release key of generation N is <newPublicKey>"; it is
 * signed by the key of generation N−1 (Ed25519 over ROTATION_SIGNATURE_CONTEXT + the
 * exact statement bytes). The site publishes every statement ever made, in order, as one
 * chain file (keys/rotations.json), so a client several rotations behind walks from the
 * key it trusts to the newest one — each link verified with the key before it. A key
 * that is not reached that way is never trusted.
 */

export interface RotationStatement {
  schema: 1;
  type: 'morse-key-rotation';
  /** Generation of the NEW key (the first rotation makes generation 1). */
  generation: number;
  oldKeyId: string;
  oldPublicKey: string;
  newKeyId: string;
  newPublicKey: string;
  issuedAt: string;
}

/** One link as published: the statement's exact text (what was signed) + base64 signature. */
export interface ChainLink {
  statement: string;
  signature: string;
}

export interface RotationChainFile {
  schema: 1;
  links: ChainLink[];
}

export interface ParsedLink extends ChainLink {
  parsed: RotationStatement;
}

export interface TrustedKey {
  publicKey: string;
  generation: number;
}

/** No sane chain is this long; refuse before verifying anything. */
export const MAX_CHAIN_LINKS = 256;
export const MAX_CHAIN_BYTES = 256 * 1024;

const isKey = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    publicKeyFromRaw(v);
    return true;
  } catch {
    return false;
  }
};

const rotationBytes = (statement: string): Buffer => Buffer.concat([Buffer.from(ROTATION_SIGNATURE_CONTEXT, 'utf8'), Buffer.from(statement, 'utf8')]);

/** Field checks of one statement (not its signature). null = fine. */
export function statementProblem(s: unknown): string | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not a JSON object';
  const x = s as Record<string, unknown>;
  if (x['schema'] !== 1) return `unknown schema ${JSON.stringify(x['schema'])}`;
  if (x['type'] !== 'morse-key-rotation') return 'not a morse-key-rotation statement';
  if (typeof x['generation'] !== 'number' || !Number.isSafeInteger(x['generation']) || x['generation'] < 1) return 'bad generation';
  if (!isKey(x['oldPublicKey'])) return 'bad oldPublicKey';
  if (!isKey(x['newPublicKey'])) return 'bad newPublicKey';
  if (x['oldKeyId'] !== keyIdOf(x['oldPublicKey'])) return 'oldKeyId does not match oldPublicKey';
  if (x['newKeyId'] !== keyIdOf(x['newPublicKey'])) return 'newKeyId does not match newPublicKey';
  if (x['oldPublicKey'] === x['newPublicKey']) return 'new key equals old key';
  if (typeof x['issuedAt'] !== 'string') return 'bad issuedAt';
  return null;
}

/**
 * Parse a chain file and check its SHAPE: generations exactly 1, 2, …, N in order (no gaps,
 * no repeats, never decreasing), each link continues from the previous link's new key, and
 * no key ever comes back. Signatures are checked by walkChain, from a trusted key.
 */
export function parseChain(text: string | Buffer): { ok: true; links: ParsedLink[] } | { ok: false; error: string } {
  const raw = typeof text === 'string' ? text : text.toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_CHAIN_BYTES) return { ok: false, error: 'rotation chain is too large' };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'rotation chain is not JSON' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'rotation chain is not a JSON object' };
  const d = doc as Record<string, unknown>;
  if (d['schema'] !== 1) return { ok: false, error: `rotation chain: unknown schema ${JSON.stringify(d['schema'])}` };
  const links = d['links'];
  if (!Array.isArray(links)) return { ok: false, error: 'rotation chain: no links array' };
  if (links.length > MAX_CHAIN_LINKS) return { ok: false, error: 'rotation chain: too many links' };
  const out: ParsedLink[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < links.length; i++) {
    const l = links[i] as Record<string, unknown> | null;
    const at = `rotation chain link ${i + 1}`;
    if (!l || typeof l !== 'object' || typeof l['statement'] !== 'string' || typeof l['signature'] !== 'string') return { ok: false, error: `${at}: needs statement and signature strings` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(l['statement']);
    } catch {
      return { ok: false, error: `${at}: statement is not JSON` };
    }
    const problem = statementProblem(parsed);
    if (problem) return { ok: false, error: `${at}: ${problem}` };
    const s = parsed as RotationStatement;
    if (s.generation !== i + 1) return { ok: false, error: `${at}: generation ${s.generation}, expected ${i + 1} (generations must be 1, 2, 3, … with no gaps)` };
    if (i === 0) seen.add(s.oldPublicKey);
    else if (s.oldPublicKey !== out[i - 1]!.parsed.newPublicKey) return { ok: false, error: `${at}: does not continue from link ${i} (its old key is not the previous new key)` };
    if (seen.has(s.newPublicKey)) return { ok: false, error: `${at}: rotates back to an earlier key (rollback) — refused` };
    seen.add(s.newPublicKey);
    out.push({ statement: l['statement'], signature: l['signature'], parsed: s });
  }
  return { ok: true, links: out };
}

/** Does `link` carry a valid signature by `publicKey`? */
export function linkSignedBy(link: ChainLink, publicKey: string): boolean {
  try {
    const sig = Buffer.from(link.signature.trim(), 'base64');
    return sig.length === 64 && verify(null, rotationBytes(link.statement), publicKeyFromRaw(publicKey), sig);
  } catch {
    return false;
  }
}

/**
 * Walk the chain from a trusted key to the newest key: every link after the trusted
 * generation must name the current key as its old key AND be signed by it. Returns the
 * newest key reached (the trusted key itself when the chain has nothing newer).
 */
export function walkChain(
  trusted: TrustedKey,
  links: ParsedLink[],
): { ok: true; key: TrustedKey; steps: number } | { ok: false; error: string } {
  let cur = trusted;
  for (let g = trusted.generation + 1; g <= links.length; g++) {
    const link = links[g - 1]!;
    if (link.parsed.oldPublicKey !== cur.publicKey) {
      return { ok: false, error: `rotation to generation ${g} does not start from the trusted key ${keyIdOf(cur.publicKey)} (generation ${cur.generation}) — refused` };
    }
    if (!linkSignedBy(link, cur.publicKey)) {
      return { ok: false, error: `rotation to generation ${g} is not signed by the trusted key ${keyIdOf(cur.publicKey)} (generation ${cur.generation}) — refused` };
    }
    cur = { publicKey: link.parsed.newPublicKey, generation: g };
  }
  return { ok: true, key: cur, steps: cur.generation - trusted.generation };
}

/** The whole chain checked from its first key (the release machine's self-check). */
export function chainTip(links: ParsedLink[]): { ok: true; genesis: string; tip: TrustedKey } | { ok: false; error: string } {
  if (!links.length) return { ok: false, error: 'empty rotation chain' };
  const genesis = links[0]!.parsed.oldPublicKey;
  const w = walkChain({ publicKey: genesis, generation: 0 }, links);
  return w.ok ? { ok: true, genesis, tip: w.key } : w;
}

/**
 * Append one rotation (release machine side): a statement for generation links+1, signed
 * by `oldKey`, which must be the chain's current newest key (or start a chain).
 */
export function appendRotation(
  chainText: string | null,
  oldKey: KeyObject,
  newPublicKey: string,
  issuedAt: string = new Date().toISOString(),
): { text: string; statement: RotationStatement } {
  const parsed: ReturnType<typeof parseChain> = chainText ? parseChain(chainText) : { ok: true, links: [] };
  if (!parsed.ok) throw new Error(parsed.error);
  const oldPublicKey = rawPublicKey(oldKey);
  if (parsed.links.length) {
    const t = chainTip(parsed.links);
    if (!t.ok) throw new Error(t.error);
    if (t.tip.publicKey !== oldPublicKey) throw new Error(`the signing key ${keyIdOf(oldPublicKey)} is not the newest key of the chain (${keyIdOf(t.tip.publicKey)})`);
  }
  publicKeyFromRaw(newPublicKey);
  const statement: RotationStatement = {
    schema: 1,
    type: 'morse-key-rotation',
    generation: parsed.links.length + 1,
    oldKeyId: keyIdOf(oldPublicKey),
    oldPublicKey,
    newKeyId: keyIdOf(newPublicKey),
    newPublicKey,
    issuedAt,
  };
  const text = JSON.stringify(statement);
  const signature = sign(null, rotationBytes(text), oldKey).toString('base64');
  const links: ChainLink[] = [...parsed.links.map(({ statement: s, signature: g }) => ({ statement: s, signature: g })), { statement: text, signature }];
  const doc: RotationChainFile = { schema: 1, links };
  const out = `${JSON.stringify(doc, null, 2)}\n`;
  const check = parseChain(out);
  if (!check.ok) throw new Error(`appended chain does not parse: ${check.error}`);
  const tip = chainTip(check.links);
  if (!tip.ok || tip.tip.publicKey !== newPublicKey) throw new Error(`appended chain does not verify: ${tip.ok ? 'wrong tip' : tip.error}`);
  return { text: out, statement };
}

/* ------------------------------------------------------------------ the client's trusted key */

/** ~/.morse/release-key.json: the newest key this computer followed (ADR-041). */
export const trustedKeyFile = (): string => join(dataDir(), 'release-key.json');

export interface StoredTrustedKey extends TrustedKey {
  schema: 1;
  keyId: string;
  acceptedAt: string;
}

/** The stored key, or null when there is none / it is unreadable / malformed (then the pinned key rules). */
export function readStoredKey(file: string): StoredTrustedKey | null {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (s['schema'] !== 1 || !isKey(s['publicKey'])) return null;
    if (s['keyId'] !== keyIdOf(s['publicKey'] as string)) return null;
    const g = s['generation'];
    if (typeof g !== 'number' || !Number.isSafeInteger(g) || g < 1) return null;
    return s as unknown as StoredTrustedKey;
  } catch {
    return null;
  }
}

/**
 * The key this client trusts now: the stored key when its generation is newer than the
 * build's pinned key, else the pinned key (a build always trusts at least its own pin;
 * on a tie the pin wins).
 */
export function currentTrustedKey(pinned: TrustedKey, file?: string): TrustedKey & { source: 'pinned' | 'rotated' } {
  const stored = file ? readStoredKey(file) : null;
  if (stored && stored.generation > pinned.generation) return { publicKey: stored.publicKey, generation: stored.generation, source: 'rotated' };
  return { ...pinned, source: 'pinned' };
}

/**
 * Persist a newly followed key atomically (temp file + fsync + rename, 0600): a crash
 * leaves either the old file or the new one, never half of one. Never lowers the
 * generation already stored. Returns false when nothing was written.
 */
export function saveTrustedKey(file: string, key: TrustedKey, now: Date = new Date()): boolean {
  const stored = readStoredKey(file);
  if (stored && stored.generation >= key.generation) return false;
  publicKeyFromRaw(key.publicKey);
  const doc: StoredTrustedKey = { schema: 1, publicKey: key.publicKey, keyId: keyIdOf(key.publicKey), generation: key.generation, acceptedAt: now.toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    const dfd = openSync(dirname(file), 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* directory fsync is best effort (not supported everywhere) */
  }
  return true;
}
