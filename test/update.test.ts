import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  keyIdOf,
  privateKeyFromText,
  rawPublicKey,
  signManifest,
  verifyManifest,
  verifyPackage,
  type ReleaseManifest,
} from '../src/update/manifest.js';
import { RELEASE_KEY_PLACEHOLDER } from '../src/update/release-key.js';
import {
  checkLatest,
  DEFAULT_TIMING,
  detectServiceManager,
  downloadAndInstall,
  firstDelay,
  describeRelease,
  globalPrefixOf,
  nextDelay,
  npmCommand,
  readInstalledRelease,
  readUpdateState,
  restartCommand,
  startAutoUpdater,
  timingFromEnv,
  transferBusy,
  updateSite,
  writeUpdateState,
  type CheckOutcome,
} from '../src/update/updater.js';

const tmp = mkdtempSync(join(tmpdir(), 'morse-update-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const keypair = (): { priv: KeyObject; pub: string } => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { priv: privateKey, pub: rawPublicKey(privateKey) };
};
const release = keypair();
const other = keypair();

const tgz = Buffer.from('pretend this is morse.tgz');
const manifestOf = (over: Partial<ReleaseManifest> = {}): ReleaseManifest => ({
  schema: 1,
  name: 'anytoany',
  version: '0.0.2',
  release: 20261021120000,
  file: 'morse.tgz',
  size: tgz.length,
  sha256: createHash('sha256').update(tgz).digest('hex'),
  builtAt: '2026-10-21T12:00:00.000Z',
  keyId: keyIdOf(release.pub),
  ...over,
});
const bytesOf = (m: unknown): Buffer => Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
const signed = (m: unknown, key: KeyObject = release.priv) => {
  const bytes = bytesOf(m);
  return { bytes, sig: signManifest(bytes, key) };
};

describe('release manifest verification (ADR-039)', () => {
  it('accepts a manifest signed by the pinned key that is newer', () => {
    const { bytes, sig } = signed(manifestOf());
    const v = verifyManifest(bytes, sig, { publicKey: release.pub, installedRelease: 20261020000000 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.release).toBe(20261021120000);
  });

  it('refuses a manifest signed by any other key', () => {
    const { bytes, sig } = signed(manifestOf(), other.priv);
    const v = verifyManifest(bytes, sig, { publicKey: release.pub, installedRelease: 0 });
    expect(v).toMatchObject({ ok: false, code: 'bad-signature' });
  });

  it('refuses a manifest changed after signing (one byte)', () => {
    const { bytes, sig } = signed(manifestOf());
    const tampered = Buffer.from(bytes.toString('utf8').replace('"0.0.2"', '"0.0.3"'));
    expect(verifyManifest(tampered, sig, { publicKey: release.pub, installedRelease: 0 })).toMatchObject({ ok: false, code: 'bad-signature' });
  });

  it('refuses garbage and empty signatures', () => {
    const { bytes } = signed(manifestOf());
    for (const sig of ['', 'not base64 at all!!', Buffer.alloc(64).toString('base64'), 'AAAA']) {
      expect(verifyManifest(bytes, sig, { publicKey: release.pub, installedRelease: 0 })).toMatchObject({ ok: false, code: 'bad-signature' });
    }
  });

  it('refuses downgrades and replays of the installed release', () => {
    const { bytes, sig } = signed(manifestOf({ release: 100 }));
    const older = verifyManifest(bytes, sig, { publicKey: release.pub, installedRelease: 200 });
    expect(older).toMatchObject({ ok: false, code: 'not-newer' });
    if (!older.ok) expect(older.manifest?.release).toBe(100);
    expect(verifyManifest(bytes, sig, { publicKey: release.pub, installedRelease: 100 })).toMatchObject({ ok: false, code: 'not-newer' });
  });

  it('refuses malformed manifests even when they are signed', () => {
    const cases: unknown[] = [
      'just a string',
      [],
      { ...manifestOf(), schema: 2 },
      { ...manifestOf(), name: 'evil-package' },
      { ...manifestOf(), release: -1 },
      { ...manifestOf(), release: 1.5 },
      { ...manifestOf(), file: '../../etc/passwd.tgz' },
      { ...manifestOf(), file: 'https://evil.example/x.tgz' },
      { ...manifestOf(), sha256: 'abc' },
      { ...manifestOf(), size: 0 },
      { ...manifestOf(), size: 10 ** 9 },
      { ...manifestOf(), version: 'latest' },
    ];
    for (const m of cases) {
      const { bytes, sig } = signed(m);
      expect(verifyManifest(bytes, sig, { publicKey: release.pub, installedRelease: 0 })).toMatchObject({ ok: false, code: 'malformed' });
    }
    const notJson = Buffer.from('{"schema": 1, oops');
    expect(verifyManifest(notJson, signManifest(notJson, release.priv), { publicKey: release.pub, installedRelease: 0 })).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('refuses everything while no key is pinned (the placeholder)', () => {
    const { bytes, sig } = signed(manifestOf());
    expect(verifyManifest(bytes, sig, { publicKey: RELEASE_KEY_PLACEHOLDER, installedRelease: 0 })).toMatchObject({ ok: false, code: 'no-key' });
    expect(verifyManifest(bytes, sig, { publicKey: 'short', installedRelease: 0 })).toMatchObject({ ok: false, code: 'no-key' });
  });

  it('checks the package against the signed size and sha256', () => {
    expect(verifyPackage(manifestOf(), tgz)).toEqual({ ok: true });
    const bad = Buffer.from(tgz);
    bad[0] = bad[0]! ^ 1;
    expect(verifyPackage(manifestOf(), bad)).toMatchObject({ ok: false, error: expect.stringContaining('sha256') });
    expect(verifyPackage(manifestOf(), Buffer.concat([tgz, Buffer.from('x')]))).toMatchObject({ ok: false, error: expect.stringContaining('bytes') });
  });

  it('reads the signing key as PEM, base64 PKCS#8 or base64 raw seed', () => {
    const pem = release.priv.export({ format: 'pem', type: 'pkcs8' }).toString();
    const der = release.priv.export({ format: 'der', type: 'pkcs8' });
    const seed = der.subarray(der.length - 32).toString('base64');
    for (const text of [pem, der.toString('base64'), `${der.toString('base64')}\n`, seed]) {
      expect(rawPublicKey(privateKeyFromText(text))).toBe(release.pub);
    }
    expect(() => privateKeyFromText('')).toThrow();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => privateKeyFromText(rsa)).toThrow(/not Ed25519/);
  });
});

/** A fake site: path → body (Buffer) or HTTP status. */
const fakeFetch = (files: Record<string, Buffer | string | number>) =>
  vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    const body = files[path];
    if (body === undefined || typeof body === 'number') return new Response('nope', { status: typeof body === 'number' ? body : 404 });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 });
  }) as unknown as typeof fetch;

const SITE = 'https://site.test';
const siteWith = (m: unknown, key: KeyObject = release.priv, pkg: Buffer = tgz) => {
  const { bytes, sig } = signed(m, key);
  return fakeFetch({ '/version.json': bytes, '/version.json.sig': sig, '/morse.tgz': pkg });
};

describe('checking the site', () => {
  it('reports a newer signed release as available', async () => {
    const c = await checkLatest({ site: SITE, publicKey: release.pub, installedRelease: () => 1, fetch: siteWith(manifestOf()) });
    expect(c).toMatchObject({ kind: 'available', manifest: { release: 20261021120000 } });
  });

  it('is up to date on the same release, and ignores an older one', async () => {
    const same = await checkLatest({ site: SITE, publicKey: release.pub, installedRelease: () => 20261021120000, fetch: siteWith(manifestOf()) });
    expect(same).toMatchObject({ kind: 'up-to-date', detail: 'up to date' });
    const older = await checkLatest({ site: SITE, publicKey: release.pub, installedRelease: () => 20261022000000, fetch: siteWith(manifestOf()) });
    expect(older).toMatchObject({ kind: 'up-to-date', detail: expect.stringContaining('no downgrades') });
  });

  it('turns a wrongly signed manifest and network trouble into errors', async () => {
    const bad = await checkLatest({ site: SITE, publicKey: release.pub, installedRelease: () => 1, fetch: siteWith(manifestOf(), other.priv) });
    expect(bad).toMatchObject({ kind: 'error', code: 'bad-signature' });
    const noSig = await checkLatest({ site: SITE, publicKey: release.pub, installedRelease: () => 1, fetch: fakeFetch({ '/version.json': bytesOf(manifestOf()) }) });
    expect(noSig).toMatchObject({ kind: 'error', code: 'network' });
    const down = await checkLatest({ site: SITE, publicKey: release.pub, installedRelease: () => 1, fetch: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch });
    expect(down).toMatchObject({ kind: 'error', code: 'network', error: expect.stringContaining('ECONNREFUSED') });
  });

  it('downloads, checks the sha256 and only then installs', async () => {
    const install = vi.fn(async (p: string) => {
      expect(readFileSync(p)).toEqual(tgz);
    });
    const r = await downloadAndInstall({ site: SITE, publicKey: release.pub, installedRelease: () => 1, fetch: siteWith(manifestOf()), install, tmpRoot: tmp }, manifestOf());
    expect(r).toEqual({ ok: true });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('never installs a tampered package', async () => {
    const install = vi.fn(async () => undefined);
    const evil = Buffer.from('pretend this is evil.tgz!');
    const r = await downloadAndInstall({ site: SITE, publicKey: release.pub, installedRelease: () => 1, fetch: siteWith(manifestOf(), release.priv, evil), install, tmpRoot: tmp }, manifestOf());
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('refused') });
    expect(install).not.toHaveBeenCalled();
  });

  it('defers instead of installing when a transfer started meanwhile', async () => {
    const install = vi.fn(async () => undefined);
    const r = await downloadAndInstall(
      { site: SITE, publicKey: release.pub, installedRelease: () => 1, fetch: siteWith(manifestOf()), install, tmpRoot: tmp, busy: () => 'file transfer in progress (1 incoming)' },
      manifestOf(),
    );
    expect(r).toMatchObject({ ok: false, deferred: true });
    expect(install).not.toHaveBeenCalled();
  });

  it('reports a failing npm install', async () => {
    const r = await downloadAndInstall(
      { site: SITE, publicKey: release.pub, installedRelease: () => 1, fetch: siteWith(manifestOf()), tmpRoot: tmp, install: async () => Promise.reject(new Error('EACCES')) },
      manifestOf(),
    );
    expect(r).toMatchObject({ ok: false, error: 'EACCES' });
  });
});

describe('deferral during file transfers', () => {
  const now = 1_000_000_000;
  it('is busy while an outgoing transfer is sending, not while it waits in the outbox', () => {
    expect(transferBusy([{ state: 'sending' }], [], now)).toMatch(/1 outgoing/);
    expect(transferBusy([{ state: 'waiting' }, { state: 'done' }, { state: 'failed' }], [], now)).toBeNull();
  });
  it('is busy while chunks keep arriving, not for an abandoned incoming transfer', () => {
    expect(transferBusy([], [{ updatedAt: now - 30_000 }], now)).toMatch(/1 incoming/);
    expect(transferBusy([], [{ updatedAt: now - 3600_000 }], now)).toBeNull();
    expect(transferBusy([{ state: 'sending' }], [{ updatedAt: now }], now)).toMatch(/1 outgoing, 1 incoming/);
  });
});

describe('schedule and back-off', () => {
  const t = DEFAULT_TIMING;
  it('first check 1–10 min after start, then every 6 h (+ jitter)', () => {
    expect(firstDelay(t, () => 0)).toBe(60_000);
    expect(firstDelay(t, () => 1)).toBe(600_000);
    expect(nextDelay('up-to-date', 0, t, () => 0)).toBe(6 * 3600_000);
    expect(nextDelay('installed', 0, t, () => 1)).toBe(6 * 3600_000 + 600_000);
  });
  it('backs off exponentially after failures, never beyond the interval', () => {
    const d = [1, 2, 3, 4, 5, 10].map((f) => nextDelay('error', f, t, () => 0));
    expect(d).toEqual([15 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000, 240 * 60_000, 6 * 3600_000]);
  });
  it('looks again soon after a deferral or while switched off', () => {
    expect(nextDelay('deferred', 3, t, () => 1)).toBe(10 * 60_000);
    expect(nextDelay('off', 0, t, () => 1)).toBe(10 * 60_000);
  });
  it('takes test timings from the environment', () => {
    const e = timingFromEnv({ MORSE_UPDATE_FIRST_CHECK_MS: '500', MORSE_UPDATE_INTERVAL_MS: '2000', MORSE_UPDATE_RETRY_MS: '100' });
    expect(e).toMatchObject({ firstMinMs: 500, firstMaxMs: 500, intervalMs: 2000, jitterMs: 200, retryBaseMs: 100, deferMs: 2000 });
    expect(timingFromEnv({ MORSE_UPDATE_INTERVAL_MS: 'nonsense' })).toEqual(DEFAULT_TIMING);
  });
});

describe('the auto-updater', () => {
  const available: CheckOutcome = { kind: 'available', manifest: manifestOf() };
  const make = (over: Partial<Parameters<typeof startAutoUpdater>[0]> = {}) => {
    const stateFile = join(mkdtempSync(join(tmp, 's-')), 'update.json');
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const log: string[] = [];
    const deps = {
      enabled: () => true,
      busy: () => null,
      check: vi.fn(async () => available),
      install: vi.fn(async () => ({ ok: true as const })),
      restart: vi.fn(async () => 'manual' as const),
      log: (l: string) => log.push(l),
      stateFile,
      random: () => 0,
      setTimer: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return {};
      },
      clearTimer: () => undefined,
      ...over,
    };
    const u = startAutoUpdater(deps);
    return { u, deps, timers, log, state: () => readUpdateState(stateFile) };
  };

  it('schedules the first check and does nothing when switched off (update.auto false)', async () => {
    const { u, deps, timers, state } = make({ enabled: () => false });
    expect(timers[0]?.ms).toBe(60_000);
    expect(await u.tick()).toBe('off');
    expect(deps.check).not.toHaveBeenCalled();
    expect(state().result).toBe('off');
  });

  it('installs a verified release, then restarts (or says to)', async () => {
    const { u, deps, log, state } = make();
    expect(await u.tick()).toBe('installed');
    expect(deps.install).toHaveBeenCalledTimes(1);
    expect(deps.restart).toHaveBeenCalledTimes(1);
    expect(log.join('\n')).toContain('update installed, restart to apply');
    expect(state()).toMatchObject({ result: 'installed', pendingSetup: 20261021120000, installed: { release: 20261021120000 } });
  });

  it('(ADR-083) nobody restarts the daemon for the user: the log says, with the line every command then says, that the running daemon is older — not when a service manager restarts it', async () => {
    const LINE = 'the running Morse daemon is older than this version — restart it: morse stop --restart';
    const byHand = make();
    expect(await byHand.u.tick()).toBe('installed');
    expect(byHand.log.slice(-2)).toEqual(['update: update installed, restart to apply (morse stop --restart)', `update: ${LINE}`]);
    // the restart itself failed: the same two lines, after the reason
    const failed = make({ restart: vi.fn(async () => Promise.reject(new Error('launchctl said no'))) });
    expect(await failed.u.tick()).toBe('installed');
    expect(failed.log.slice(-3)).toEqual(['update: restart failed: launchctl said no', 'update: update installed, restart to apply (morse stop --restart)', `update: ${LINE}`]);
    // restarted through launchd / systemd: nothing for the user to do, nothing said about it
    const restarted = make({ restart: vi.fn(async () => 'restarted' as const) });
    expect(await restarted.u.tick()).toBe('installed');
    expect(restarted.log.at(-1)).toBe('update: restarting the daemon through its service manager …');
    expect(restarted.log.join('\n')).not.toContain('older than this version');
    // (an update that was not installed says nothing of it either)
    const none = make({ check: vi.fn(async () => ({ kind: 'up-to-date', detail: 'up to date' }) as CheckOutcome) });
    await none.u.tick();
    expect(none.log.join('\n')).not.toContain('older than this version');
  });

  it('ADR-084: on Node < 22 the update is still installed — the log only gains one hint line', async () => {
    const old = make({ nodeVersion: '20.19.0' });
    expect(await old.u.tick()).toBe('installed');
    expect(old.deps.install).toHaveBeenCalledTimes(1);
    expect(old.deps.restart).toHaveBeenCalledTimes(1);
    expect(old.state()).toMatchObject({ result: 'installed', installed: { release: 20261021120000 } });
    const hints = old.log.filter((l) => l.includes('Node.js 22+ is recommended'));
    expect(hints).toEqual(['update: node v20.19.0 — Node.js 22+ is recommended: on older Node.js every update has to compile the database module from source']);
    expect(old.log.indexOf(hints[0]!)).toBeGreaterThan(old.log.findIndex((l) => l.startsWith('update: installed release')));

    for (const nodeVersion of ['22.0.0', '24.14.1']) {
      const cur = make({ nodeVersion });
      expect(await cur.u.tick()).toBe('installed');
      expect(cur.log.join('\n')).not.toContain('Node.js 22+');
    }
  });

  it('defers while a file transfer is in progress — no download, no install', async () => {
    const { u, deps, state, log } = make({ busy: () => 'file transfer in progress (1 outgoing)' });
    expect(await u.tick()).toBe('deferred');
    expect(deps.install).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ result: 'deferred', latest: { release: 20261021120000 } });
    expect(log.join('\n')).toContain('deferred');
  });

  it('counts failures, keeps running, and resets after a good check', async () => {
    let outcome: CheckOutcome = { kind: 'error', code: 'bad-signature', error: 'signature does not verify' };
    const { u, state } = make({ check: vi.fn(async () => outcome) });
    expect(await u.tick()).toBe('error');
    expect(await u.tick()).toBe('error');
    expect(state()).toMatchObject({ result: 'error', failures: 2 });
    outcome = { kind: 'up-to-date', latest: null, detail: 'up to date' };
    expect(await u.tick()).toBe('up-to-date');
    expect(state()).toMatchObject({ result: 'up-to-date', failures: 0 });
  });

  it('survives a throwing check and a failing install', async () => {
    const thrower = make({ check: vi.fn(async () => Promise.reject(new Error('boom'))) });
    expect(await thrower.u.tick()).toBe('error');
    const failing = make({ install: vi.fn(async () => ({ ok: false as const, error: 'npm install -g failed' })) });
    expect(await failing.u.tick()).toBe('error');
    expect(failing.deps.restart).not.toHaveBeenCalled();
    const restartThrows = make({ restart: vi.fn(async () => Promise.reject(new Error('no launchctl'))) });
    expect(await restartThrows.u.tick()).toBe('installed');
  });

  it('reschedules after each check: interval on success, back-off on failure', async () => {
    const { timers: all } = make({ check: vi.fn(async () => ({ kind: 'error' as const, code: 'network' as const, error: 'down' })) });
    // each check also arms its own 45-min watchdog (ADR-043) — leave those out here
    const timers = () => all.filter((x) => x.ms !== 45 * 60_000);
    timers()[0]!.fn();
    await vi.waitFor(() => expect(timers().length).toBe(2));
    expect(timers()[1]!.ms).toBe(15 * 60_000);
    timers()[1]!.fn();
    await vi.waitFor(() => expect(timers().length).toBe(3));
    expect(timers()[2]!.ms).toBe(30 * 60_000);
  });

  it('a check that never finishes counts as failed after its timeout, and the next one is still armed (ADR-043)', async () => {
    const { timers, log, state } = make({ check: vi.fn(() => new Promise<CheckOutcome>(() => undefined)), tickTimeoutMs: 1234 });
    timers[0]!.fn();
    const watchdog = timers.find((x) => x.ms === 1234);
    expect(watchdog).toBeDefined();
    watchdog!.fn();
    await vi.waitFor(() => expect(timers.filter((x) => x.ms === 15 * 60_000)).toHaveLength(1));
    expect(log.join('\n')).toMatch(/did not finish within/);
    expect(state()).toMatchObject({ result: 'error', failures: 1 });
    // and the hung one does not block the next check
    const next = timers.filter((x) => x.ms === 15 * 60_000)[0]!;
    next.fn();
    await vi.waitFor(() => expect(timers.filter((x) => x.ms === 1234)).toHaveLength(2));
  });
});

describe('restart through the service manager', () => {
  it('only when launchd says its talk.morse.daemon job IS this process', async () => {
    const out = 'gui/501/talk.morse.daemon = {\n\tstate = running\n\tpid = 4242\n}';
    const run = vi.fn(async () => out);
    expect(await detectServiceManager(4242, { platform: 'darwin', uid: 501, run })).toEqual({ kind: 'launchd', target: 'gui/501/talk.morse.daemon' });
    expect(await detectServiceManager(999, { platform: 'darwin', uid: 501, run })).toBeNull();
    expect(await detectServiceManager(4242, { platform: 'darwin', uid: 501, run: async () => Promise.reject(new Error('no such job')) })).toBeNull();
  });
  it('only when systemd says morse.service MainPID is this process', async () => {
    expect(await detectServiceManager(77, { platform: 'linux', run: async () => '77\n' })).toEqual({ kind: 'systemd', unit: 'morse.service' });
    expect(await detectServiceManager(77, { platform: 'linux', run: async () => '0\n' })).toBeNull();
    expect(await detectServiceManager(77, { platform: 'win32' })).toBeNull();
  });
  it('kickstart -k / systemctl restart', () => {
    expect(restartCommand({ kind: 'launchd', target: 'gui/501/talk.morse.daemon' })).toEqual(['/bin/launchctl', ['kickstart', '-k', 'gui/501/talk.morse.daemon']]); // absolute (ADR-045): never some other launchctl on PATH
    expect(restartCommand({ kind: 'systemd', unit: 'morse.service' })).toEqual(['systemctl', ['--user', '--no-block', 'restart', 'morse.service']]);
  });
});

describe('the installed package', () => {
  it('finds the npm global prefix it was installed into (through symlinks), or none', () => {
    const prefix = join(tmp, 'prefix');
    const pkg = join(prefix, 'lib', 'node_modules', 'anytoany');
    mkdirSync(pkg, { recursive: true });
    symlinkSync(pkg, join(tmp, 'linked'));
    expect(globalPrefixOf(pkg)).toBe(globalPrefixOf(join(tmp, 'linked')));
    expect(globalPrefixOf(pkg)?.endsWith('prefix')).toBe(true);
    expect(globalPrefixOf(join(tmp, 'nowhere'))).toBeNull();
    expect(globalPrefixOf(tmp)).toBeNull();
  });

  it('uses the npm that belongs to the running node', () => {
    const cli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
    expect(npmCommand('/opt/node/bin/node', (p) => p === cli)).toEqual({ cmd: '/opt/node/bin/node', args: [cli] });
    expect(npmCommand('/opt/node/bin/node', (p) => p === '/opt/node/bin/npm')).toEqual({ cmd: '/opt/node/bin/npm', args: [] });
    expect(npmCommand('/opt/node/bin/node', () => false)).toEqual({ cmd: 'npm', args: [] });
  });

  it('reads dist/release.json (release 0 = development build)', () => {
    const root = join(tmp, 'pkg');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    expect(readInstalledRelease(root)).toEqual({ version: '1.2.3', release: 0, root });
    writeFileSync(join(root, 'dist', 'release.json'), JSON.stringify({ release: 20261021120000, builtAt: 'x' }));
    expect(readInstalledRelease(root)).toEqual({ version: '1.2.3', release: 20261021120000, builtAt: 'x', root });
    writeFileSync(join(root, 'dist', 'release.json'), JSON.stringify({ release: 'soon' }));
    expect(readInstalledRelease(root).release).toBe(0);
  });

  it('describeRelease — what `morse --version` prints (ADR-075): the package version and, when it is known, the release stamp', () => {
    const root = join(tmp, 'pkg-version');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'anytoany', version: '0.0.1' }));
    expect(describeRelease(readInstalledRelease(root))).toBe('0.0.1 (development build — no release number)');
    writeFileSync(join(root, 'dist', 'release.json'), JSON.stringify({ release: 20261114132813, version: '0.0.1', builtAt: '2026-11-14T13:28:13.000Z' }));
    expect(describeRelease(readInstalledRelease(root))).toBe('0.0.1 (release 20261114132813)');
  });

  it('site: MORSE_SITE, then update.site, then morse.im (ADR-040)', () => {
    expect(updateSite({}, {})).toBe('https://morse.im');
    expect(updateSite({ update: { site: 'http://127.0.0.1:9/' } }, {})).toBe('http://127.0.0.1:9');
    expect(updateSite({ update: { site: 'http://a.test' } }, { MORSE_SITE: 'https://b.test' })).toBe('https://b.test');
    expect(updateSite({ update: { site: 'javascript:alert(1)' } }, {})).toBe('https://morse.im');
  });

  it('state file: merge, and undefined removes a key', () => {
    const f = join(tmp, 'state', 'update.json');
    writeUpdateState({ result: 'installed', pendingSetup: 5 }, f);
    writeUpdateState({ pendingSetup: undefined, failures: 0 }, f);
    expect(readUpdateState(f)).toEqual({ result: 'installed', failures: 0 });
    expect(readUpdateState(join(tmp, 'missing.json'))).toEqual({});
  });
});
