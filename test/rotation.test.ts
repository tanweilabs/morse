import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { keyIdOf, privateKeyFromText, rawPublicKey, signManifest, type ReleaseManifest } from '../src/update/manifest.js';
import { keychainServiceFor, ROTATION_SIGNATURE_CONTEXT } from '../src/update/release-key.js';
import {
  appendRotation,
  chainTip,
  currentTrustedKey,
  parseChain,
  readStoredKey,
  saveTrustedKey,
  walkChain,
  type ChainLink,
  type RotationChainFile,
} from '../src/update/rotation.js';
import { checkLatest, startAutoUpdater } from '../src/update/updater.js';

const tmp = mkdtempSync(join(tmpdir(), 'morse-rotation-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const tmpFile = (name: string) => join(tmp, `${n++}-${name}`);

const keypair = (): { priv: KeyObject; pub: string } => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { priv: privateKey, pub: rawPublicKey(privateKey) };
};
const A = keypair();
const B = keypair();
const C = keypair();
const X = keypair(); // never chained

const chainOf = (...steps: Array<[KeyObject, string]>): string => {
  let text: string | null = null;
  for (const [oldKey, newPub] of steps) text = appendRotation(text, oldKey, newPub, '2026-10-26T00:00:00.000Z').text;
  return text!;
};
const AB = chainOf([A.priv, B.pub]);
const ABC = chainOf([A.priv, B.pub], [B.priv, C.pub]);
const links = (text: string) => {
  const p = parseChain(text);
  if (!p.ok) throw new Error(p.error);
  return p.links;
};
/** A hand-made link (to build broken chains). */
const rawLink = (st: Record<string, unknown>, signer: KeyObject): ChainLink => {
  const statement = JSON.stringify(st);
  return { statement, signature: sign(null, Buffer.concat([Buffer.from(ROTATION_SIGNATURE_CONTEXT), Buffer.from(statement)]), signer).toString('base64') };
};
const stmt = (gen: number, oldPub: string, newPub: string) => ({
  schema: 1,
  type: 'morse-key-rotation',
  generation: gen,
  oldKeyId: keyIdOf(oldPub),
  oldPublicKey: oldPub,
  newKeyId: keyIdOf(newPub),
  newPublicKey: newPub,
  issuedAt: '2026-10-26T00:00:00.000Z',
});
const fileOf = (l: ChainLink[]): string => JSON.stringify({ schema: 1, links: l } satisfies RotationChainFile);

describe('rotation chain (ADR-041)', () => {
  it('a single rotation: signed by the old key, followed from it', () => {
    const l = links(AB);
    expect(l).toHaveLength(1);
    expect(l[0]!.parsed).toMatchObject({ generation: 1, oldPublicKey: A.pub, newPublicKey: B.pub, oldKeyId: keyIdOf(A.pub), newKeyId: keyIdOf(B.pub) });
    expect(walkChain({ publicKey: A.pub, generation: 0 }, l)).toEqual({ ok: true, key: { publicKey: B.pub, generation: 1 }, steps: 1 });
    expect(chainTip(l)).toMatchObject({ ok: true, genesis: A.pub, tip: { publicKey: B.pub, generation: 1 } });
  });

  it('a client two generations behind walks A → B → C; one already on B walks one step; one on C none', () => {
    const l = links(ABC);
    expect(walkChain({ publicKey: A.pub, generation: 0 }, l)).toMatchObject({ ok: true, key: { publicKey: C.pub, generation: 2 }, steps: 2 });
    expect(walkChain({ publicKey: B.pub, generation: 1 }, l)).toMatchObject({ ok: true, key: { publicKey: C.pub, generation: 2 }, steps: 1 });
    expect(walkChain({ publicKey: C.pub, generation: 2 }, l)).toMatchObject({ ok: true, key: { publicKey: C.pub }, steps: 0 });
  });

  it('refuses a broken link (does not continue from the previous new key)', () => {
    const broken = fileOf([rawLink(stmt(1, A.pub, B.pub), A.priv), rawLink(stmt(2, X.pub, C.pub), X.priv)]);
    expect(parseChain(broken)).toMatchObject({ ok: false, error: expect.stringContaining('does not continue') });
  });

  it('refuses a link signed by the wrong key (the new key, or a stranger)', () => {
    for (const signer of [B.priv, X.priv]) {
      const l = links(fileOf([rawLink(stmt(1, A.pub, B.pub), signer)]));
      expect(walkChain({ publicKey: A.pub, generation: 0 }, l)).toMatchObject({ ok: false, error: expect.stringContaining('not signed by the trusted key') });
    }
    // a valid A→B, then B→C signed by A (the old-old key)
    const l2 = links(fileOf([rawLink(stmt(1, A.pub, B.pub), A.priv), rawLink(stmt(2, B.pub, C.pub), A.priv)]));
    expect(walkChain({ publicKey: A.pub, generation: 0 }, l2)).toMatchObject({ ok: false });
  });

  it('a chain that does not start from the trusted key leads nowhere', () => {
    // someone's own chain X → C: a client on A must not follow it
    const l = links(fileOf([rawLink(stmt(1, X.pub, C.pub), X.priv)]));
    expect(walkChain({ publicKey: A.pub, generation: 0 }, l)).toMatchObject({ ok: false, error: expect.stringContaining('does not start from the trusted key') });
  });

  it('refuses generations that do not increase by exactly one (repeat, decrease, gap, zero)', () => {
    const cases = [
      [rawLink(stmt(1, A.pub, B.pub), A.priv), rawLink(stmt(1, B.pub, C.pub), B.priv)],
      [rawLink(stmt(2, A.pub, B.pub), A.priv), rawLink(stmt(1, B.pub, C.pub), B.priv)],
      [rawLink(stmt(1, A.pub, B.pub), A.priv), rawLink(stmt(3, B.pub, C.pub), B.priv)],
      [rawLink(stmt(0, A.pub, B.pub), A.priv)],
    ];
    for (const c of cases) expect(parseChain(fileOf(c)).ok).toBe(false);
  });

  it('refuses a rotation back to an earlier key (A → B → A)', () => {
    const back = fileOf([rawLink(stmt(1, A.pub, B.pub), A.priv), rawLink(stmt(2, B.pub, A.pub), B.priv)]);
    expect(parseChain(back)).toMatchObject({ ok: false, error: expect.stringContaining('rollback') });
  });

  it('refuses a tampered newPublicKey (statement changed after signing)', () => {
    const doc = JSON.parse(AB) as RotationChainFile;
    const st = JSON.parse(doc.links[0]!.statement) as Record<string, unknown>;
    st['newPublicKey'] = X.pub;
    st['newKeyId'] = keyIdOf(X.pub);
    doc.links[0]!.statement = JSON.stringify(st);
    const l = links(JSON.stringify(doc));
    expect(walkChain({ publicKey: A.pub, generation: 0 }, l)).toMatchObject({ ok: false, error: expect.stringContaining('not signed') });
    // and a keyId that does not match the key is malformed outright
    st['newKeyId'] = keyIdOf(B.pub);
    doc.links[0]!.statement = JSON.stringify(st);
    expect(parseChain(JSON.stringify(doc))).toMatchObject({ ok: false, error: expect.stringContaining('newKeyId') });
  });

  it('refuses malformed documents', () => {
    for (const bad of ['', 'nope', '[]', '{"schema":2,"links":[]}', '{"schema":1}', '{"schema":1,"links":[{"statement":1}]}', '{"schema":1,"links":[{"statement":"{","signature":""}]}']) {
      expect(parseChain(bad).ok).toBe(false);
    }
    expect(parseChain(fileOf([rawLink({ ...stmt(1, A.pub, B.pub), newPublicKey: 'short' }, A.priv)])).ok).toBe(false);
    expect(parseChain(fileOf([rawLink(stmt(1, A.pub, A.pub), A.priv)])).ok).toBe(false);
    expect(parseChain('x'.repeat(300 * 1024))).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
    expect(parseChain('{"schema":1,"links":[]}')).toEqual({ ok: true, links: [] });
  });

  it('appendRotation only extends a chain with its newest key', () => {
    expect(() => appendRotation(AB, A.priv, C.pub)).toThrow(/not the newest key/);
    expect(() => appendRotation(AB, B.priv, A.pub)).toThrow(/earlier key|rollback/);
    expect(() => appendRotation('nope', A.priv, B.pub)).toThrow();
    expect(chainTip([])).toMatchObject({ ok: false });
  });
});

describe('the trusted key on disk', () => {
  it('saves atomically (0600, no temp file left), survives a restart, never goes back', () => {
    const f = tmpFile('release-key.json');
    expect(currentTrustedKey({ publicKey: A.pub, generation: 0 }, f)).toEqual({ publicKey: A.pub, generation: 0, source: 'pinned' });
    expect(saveTrustedKey(f, { publicKey: B.pub, generation: 1 })).toBe(true);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(tmp).filter((x) => x.endsWith('.tmp'))).toEqual([]);
    // "restart": a fresh read from disk
    expect(readStoredKey(f)).toMatchObject({ schema: 1, publicKey: B.pub, keyId: keyIdOf(B.pub), generation: 1 });
    expect(currentTrustedKey({ publicKey: A.pub, generation: 0 }, f)).toEqual({ publicKey: B.pub, generation: 1, source: 'rotated' });
    // a lower or equal generation never replaces it
    expect(saveTrustedKey(f, { publicKey: A.pub, generation: 1 })).toBe(false);
    expect(saveTrustedKey(f, { publicKey: C.pub, generation: 2 })).toBe(true);
    expect(readStoredKey(f)?.publicKey).toBe(C.pub);
  });

  it('the pinned key wins ties and when the stored file is newer-looking garbage', () => {
    const f = tmpFile('release-key.json');
    saveTrustedKey(f, { publicKey: B.pub, generation: 1 });
    // a build that pins generation 1 itself: the pin wins
    expect(currentTrustedKey({ publicKey: C.pub, generation: 1 }, f)).toMatchObject({ publicKey: C.pub, source: 'pinned' });
    for (const junk of ['', '{', '{"schema":1,"publicKey":"x","keyId":"y","generation":5}', JSON.stringify({ schema: 1, publicKey: B.pub, keyId: 'wrong', generation: 3 }), JSON.stringify({ schema: 1, publicKey: B.pub, keyId: keyIdOf(B.pub), generation: 0 })]) {
      writeFileSync(f, junk);
      expect(currentTrustedKey({ publicKey: A.pub, generation: 0 }, f)).toMatchObject({ publicKey: A.pub, source: 'pinned' });
    }
    expect(currentTrustedKey({ publicKey: A.pub, generation: 0 })).toMatchObject({ source: 'pinned' });
  });
});

/* ------------------------------------------------------------------ the client end to end */

const tgz = Buffer.from('pretend this is morse.tgz');
const manifest = (release: number, signer: string): ReleaseManifest => ({
  schema: 1,
  name: 'anytoany',
  version: '0.0.2',
  release,
  file: 'morse.tgz',
  size: tgz.length,
  sha256: createHash('sha256').update(tgz).digest('hex'),
  builtAt: '2026-10-26T12:00:00.000Z',
  keyId: keyIdOf(signer),
});
const SITE = 'https://site.test';
const site = (release: number, signer: { priv: KeyObject; pub: string }, chain?: string) => {
  const bytes = Buffer.from(`${JSON.stringify(manifest(release, signer.pub), null, 2)}\n`);
  const files: Record<string, Buffer | string> = { '/version.json': bytes, '/version.json.sig': signManifest(bytes, signer.priv), '/morse.tgz': tgz };
  if (chain) files['/keys/rotations.json'] = chain;
  return vi.fn(async (url: string | URL | Request) => {
    const body = files[new URL(String(url)).pathname];
    return body === undefined ? new Response('nope', { status: 404 }) : new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 });
  }) as unknown as typeof fetch;
};
const check = (f: typeof fetch, file: string, pinned = A.pub, gen = 0, installed = 100) =>
  checkLatest({ site: SITE, publicKey: pinned, keyGeneration: gen, keyStateFile: file, installedRelease: () => installed, fetch: f });

describe('checking the site across a key rotation', () => {
  it('normal path: signed by the trusted key, no chain needed', async () => {
    const f = site(200, A);
    const file = tmpFile('k.json');
    expect(await check(f, file)).toMatchObject({ kind: 'available', manifest: { release: 200 } });
    expect(vi.mocked(f).mock.calls.map((c) => new URL(String(c[0])).pathname)).not.toContain('/keys/rotations.json');
    expect(existsSync(file)).toBe(false);
  });

  it('valid single rotation: follows A → B, verifies the release with B, stores B', async () => {
    const file = tmpFile('k.json');
    const c = await check(site(200, B, AB), file);
    expect(c).toMatchObject({ kind: 'available', manifest: { release: 200 }, rotated: { from: 0, to: 1, keyId: keyIdOf(B.pub) } });
    expect(readStoredKey(file)).toMatchObject({ publicKey: B.pub, generation: 1 });
    // next check (after a restart): B is trusted directly
    const f2 = site(300, B, AB);
    expect(await check(f2, file)).toMatchObject({ kind: 'available', manifest: { release: 300 } });
    expect(await check(f2, file)).not.toHaveProperty('rotated');
  });

  it('multi-step: a client two generations behind walks A → B → C', async () => {
    const file = tmpFile('k.json');
    expect(await check(site(200, C, ABC), file)).toMatchObject({ kind: 'available', rotated: { from: 0, to: 2 } });
    expect(readStoredKey(file)).toMatchObject({ publicKey: C.pub, generation: 2 });
    // a build that pins B (generation 1) also walks one step
    const file2 = tmpFile('k.json');
    expect(await check(site(200, C, ABC), file2, B.pub, 1)).toMatchObject({ kind: 'available', rotated: { from: 1, to: 2 } });
  });

  it('a rotation is followed even when the release is not newer (stored, up to date)', async () => {
    const file = tmpFile('k.json');
    expect(await check(site(100, B, AB), file)).toMatchObject({ kind: 'up-to-date', rotated: { to: 1 } });
    expect(readStoredKey(file)?.generation).toBe(1);
  });

  it('release signed by an unchained key: refused, nothing stored', async () => {
    const file = tmpFile('k.json');
    expect(await check(site(200, X), file)).toMatchObject({ kind: 'error', code: 'bad-signature', error: expect.stringContaining('no key rotation chain') });
    expect(await check(site(200, X, AB), file)).toMatchObject({ kind: 'error', code: 'bad-signature', error: expect.stringContaining('newest chained key') });
    expect(existsSync(file)).toBe(false);
  });

  it('release signed by a middle key of the chain (not the newest) is refused', async () => {
    const file = tmpFile('k.json');
    expect(await check(site(200, B, ABC), file)).toMatchObject({ kind: 'error', code: 'bad-signature' });
    expect(existsSync(file)).toBe(false);
  });

  it('rollback: after following A → B, a release signed by A again is refused', async () => {
    const file = tmpFile('k.json');
    await check(site(200, B, AB), file);
    const c = await check(site(300, A, AB), file);
    expect(c).toMatchObject({ kind: 'error', code: 'bad-signature', error: expect.stringContaining('no newer key') });
    // and a forged chain served next to it does not help
    const forged = fileOf([rawLink(stmt(1, A.pub, B.pub), A.priv), rawLink(stmt(2, B.pub, X.pub), X.priv)]);
    expect(await check(site(300, X, forged), file)).toMatchObject({ kind: 'error', code: 'bad-rotation' });
    expect(readStoredKey(file)).toMatchObject({ publicKey: B.pub, generation: 1 });
  });

  it('broken, wrongly signed, tampered or malformed chains: refused, nothing stored', async () => {
    const file = tmpFile('k.json');
    const doc = JSON.parse(AB) as RotationChainFile;
    const st = JSON.parse(doc.links[0]!.statement) as Record<string, unknown>;
    st['newPublicKey'] = X.pub;
    st['newKeyId'] = keyIdOf(X.pub);
    doc.links[0]!.statement = JSON.stringify(st);
    const chains = [
      JSON.stringify(doc), // tampered newPublicKey
      fileOf([rawLink(stmt(1, A.pub, X.pub), X.priv)]), // signed by the new key itself
      fileOf([rawLink(stmt(1, A.pub, B.pub), A.priv), rawLink(stmt(3, B.pub, X.pub), B.priv)]), // gap
      'not json',
    ];
    for (const chain of chains) {
      const c = await check(site(200, X, chain), file);
      expect(c).toMatchObject({ kind: 'error', code: 'bad-rotation' });
    }
    expect(existsSync(file)).toBe(false);
  });

  it('a store that cannot be written does not block an authentic release', async () => {
    const dirAsFile = tmpFile('dir');
    writeFileSync(dirAsFile, 'x');
    const c = await check(site(200, B, AB), join(dirAsFile, 'k.json'));
    expect(c).toMatchObject({ kind: 'available', rotated: { to: 1, saveError: expect.any(String) } });
  });

  it('the auto-updater logs a followed rotation', async () => {
    const log: string[] = [];
    const u = startAutoUpdater({
      enabled: () => true,
      busy: () => null,
      check: async () => ({ kind: 'up-to-date', latest: null, detail: 'up to date', rotated: { from: 0, to: 1, keyId: 'abcd' } }),
      install: async () => ({ ok: true }),
      restart: async () => 'manual',
      log: (l) => log.push(l),
      stateFile: tmpFile('update.json'),
      setTimer: () => ({}),
      clearTimer: () => undefined,
    });
    await u.tick();
    u.stop();
    expect(log.join('\n')).toContain('release key rotated: generation 0 → 1 (key abcd)');
  });
});

describe('Keychain item names', () => {
  it('generation 0 keeps the ADR-039 name; later generations get their own item', () => {
    expect(keychainServiceFor(0)).toBe('morse-release-signing');
    expect(keychainServiceFor(2)).toBe('morse-release-signing-gen2');
  });
});
