import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OLDER_DAEMON_LINE } from '../daemon/capabilities.js';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { dataDir } from '../home.js';
import { nodeUpgradeHint } from '../node-version.js';
import { keyIdOf, MAX_PACKAGE_BYTES, verifyManifest, verifyPackage, type ReleaseManifest, type VerifyCode } from './manifest.js';
import { DEFAULT_SITE, LAUNCHD_LABEL, ROTATION_CHAIN_PATH, SYSTEMD_UNIT } from './release-key.js';
import { currentTrustedKey, MAX_CHAIN_BYTES, parseChain, saveTrustedKey, walkChain, type TrustedKey } from './rotation.js';

/* ------------------------------------------------------------------ installed build */

export interface InstalledRelease {
  version: string;
  /** 0 = not a signed release (a git checkout / development build). */
  release: number;
  builtAt?: string;
  /** The package directory (where package.json is). */
  root: string;
}

/** dist/update/updater.js → the package root. */
export const packageRoot = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What is installed at `root` now (read from disk each time — after an update it is the new one). */
export function readInstalledRelease(root: string = packageRoot()): InstalledRelease {
  let version = '0.0.0';
  try {
    version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    /* keep the default */
  }
  try {
    // written by scripts/build-site.mjs into the packed copy only (never committed)
    const r = JSON.parse(readFileSync(join(root, 'dist', 'release.json'), 'utf8')) as { release?: unknown; version?: unknown; builtAt?: unknown };
    const release = typeof r.release === 'number' && Number.isSafeInteger(r.release) && r.release > 0 ? r.release : 0;
    return { version, release, ...(typeof r.builtAt === 'string' ? { builtAt: r.builtAt } : {}), root };
  } catch {
    return { version, release: 0, root };
  }
}

export const describeRelease = (r: { version: string; release: number }): string =>
  r.release ? `${r.version} (release ${r.release})` : `${r.version} (development build — no release number)`;

/**
 * The npm global prefix this package was installed into: <prefix>/lib/node_modules/<pkg>.
 * null = not an npm global install (a git checkout, `npm link`…) — never auto-installed over.
 */
export function globalPrefixOf(root: string): string | null {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return null;
  }
  const nm = dirname(real);
  const lib = dirname(nm);
  if (basename(nm) !== 'node_modules' || basename(lib) !== 'lib') return null;
  return dirname(lib);
}

/** npm that belongs to THIS node (the one running the daemon): npm-cli.js next to it, else `npm`. */
export function npmCommand(execPath: string = process.execPath, exists: (p: string) => boolean = existsSync): { cmd: string; args: string[] } {
  const binDir = dirname(execPath);
  for (const cli of [join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (exists(cli)) return { cmd: execPath, args: [cli] };
  }
  const sibling = join(binDir, 'npm');
  if (exists(sibling)) return { cmd: sibling, args: [] };
  return { cmd: 'npm', args: [] };
}

/** `npm install -g --prefix <the same prefix> <tgz>` with the same node/npm as the running install. */
export function npmInstaller(opts: { root?: string; execPath?: string; log?: (l: string) => void } = {}): (tgz: string) => Promise<void> {
  return async (tgz) => {
    const root = opts.root ?? packageRoot();
    const prefix = globalPrefixOf(root);
    if (!prefix) throw new Error(`morse at ${root} is not an npm global install — update it with install.sh`);
    const execPath = opts.execPath ?? process.execPath;
    const npm = npmCommand(execPath);
    const args = [...npm.args, 'install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', '--no-update-notifier', tgz];
    opts.log?.(`update: npm install -g --prefix ${prefix} (node ${execPath})`);
    // the node that runs us first on PATH: npm's lifecycle scripts (better-sqlite3) run `node`
    const env = { ...process.env, PATH: [dirname(execPath), process.env['PATH'] ?? ''].filter(Boolean).join(delimiter), npm_config_prefix: prefix };
    await new Promise<void>((resolve, reject) => {
      execFile(npm.cmd, args, { env, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve();
        const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-8).join(' | ');
        reject(new Error(`npm install -g failed: ${err.message.split('\n')[0]}${tail ? ` — ${tail}` : ''}`));
      });
    });
  };
}

/* ------------------------------------------------------------------ restart */

export type ServiceManager = { kind: 'launchd'; target: string } | { kind: 'systemd'; unit: string };
/** Always this one on macOS — not whatever `launchctl` the daemon's PATH finds (ADR-045). */
const LAUNCHCTL = '/bin/launchctl';
type RunText = (cmd: string, args: string[]) => Promise<string>;

const runText: RunText = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/**
 * Is process `pid` the daemon of the service manager install.sh set up? Only when
 * launchd's / systemd's own record says that job's main pid IS this pid — so a second
 * daemon (another HOME, a test run) never restarts the real one.
 */
export async function detectServiceManager(
  pid: number,
  opts: { platform?: NodeJS.Platform; uid?: number; run?: RunText } = {},
): Promise<ServiceManager | null> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runText;
  try {
    if (platform === 'darwin') {
      const uid = opts.uid ?? process.getuid?.() ?? 0;
      const target = `gui/${uid}/${LAUNCHD_LABEL}`;
      const m = /^\s*pid = (\d+)\s*$/m.exec(await run(LAUNCHCTL, ['print', target]));
      return m && Number(m[1]) === pid ? { kind: 'launchd', target } : null;
    }
    if (platform === 'linux') {
      const out = (await run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', SYSTEMD_UNIT])).trim();
      return Number(out) === pid ? { kind: 'systemd', unit: SYSTEMD_UNIT } : null;
    }
  } catch {
    /* no launchctl / systemctl, or no such job */
  }
  return null;
}

/**
 * (ADR-089) Is the service manager's job for the daemon set up on this computer at all — whether or not it is
 * running right now? For `morse stop --restart` when no daemon runs: then the job is simply started. Never
 * asked from an isolated home (a test, a second home): the job belongs to the default home.
 */
export async function detectServiceJob(opts: { platform?: NodeJS.Platform; uid?: number; run?: RunText } = {}): Promise<ServiceManager | null> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runText;
  try {
    if (platform === 'darwin') {
      const target = `gui/${opts.uid ?? process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`;
      await run(LAUNCHCTL, ['print', target]);
      return { kind: 'launchd', target };
    }
    if (platform === 'linux') {
      await run('systemctl', ['--user', 'cat', SYSTEMD_UNIT]);
      return { kind: 'systemd', unit: SYSTEMD_UNIT };
    }
  } catch {
    /* no such job */
  }
  return null;
}

/**
 * (ADR-089 follow-up M5) The file the service manager loaded the job from — launchd: `path = …` of
 * `launchctl print`; systemd: the unit's FragmentPath. null: it does not say.
 */
export async function serviceJobFile(sm: ServiceManager, run: RunText = runText): Promise<string | null> {
  try {
    if (sm.kind === 'launchd') return /^\s*path = (.+?)\s*$/m.exec(await run(LAUNCHCTL, ['print', sm.target]))?.[1] ?? null;
    return (await run('systemctl', ['--user', 'show', '-p', 'FragmentPath', '--value', sm.unit])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * (ADR-089 follow-up M5) Is that job THIS home's? `launchctl` and `systemctl --user` go by the user, a Morse
 * home goes by HOME: a command run with another HOME (a test, a second home that has a service file of its own)
 * must never start, stop or restart the job of the user's real home. True only when the file the manager
 * loaded the job from IS this home's service file (`file`: service-file.ts `serviceFilePath()`).
 */
export async function jobIsThisHomes(sm: ServiceManager, file: string | null, opts: { run?: RunText; real?: (p: string) => string } = {}): Promise<boolean> {
  if (!file) return false;
  const loaded = await serviceJobFile(sm, opts.run ?? runText);
  if (!loaded) return false;
  const real = opts.real ?? ((p: string) => realpathSync(p));
  try {
    return real(loaded) === real(file);
  } catch {
    return false; // one of them does not exist: not ours to touch
  }
}

/**
 * (ADR-089 follow-up M1) `morse start` on a computer where launchd / systemd runs the daemon. A daemon started
 * by hand next to the service manager's job is not restarted by an update, and the job's own start then fails
 * every few seconds with "already running" — so the start is handed to the service manager. NOT when this
 * process is the job itself (the service manager ran `morse start`: handing over would loop) — told by the
 * manager's own record of the job's pid and by what it puts in the job's environment — and not when there is
 * no job, or the job is another home's.
 */
export type HandedStart = { handled: false } | { handled: true; how: 'already-running'; pid: number } | { handled: true; how: 'started' | 'failed'; job: ServiceManager; command: [string, string[]]; error?: string };
export async function startThroughServiceManager(o: {
  env: NodeJS.ProcessEnv;
  pid: number;
  /** The job whose main process is `pid`, if any (detectServiceManager). */
  jobOf: (pid: number) => Promise<ServiceManager | null>;
  /** The daemon's job, loaded or not running (detectServiceJob). */
  job: () => Promise<ServiceManager | null>;
  /** Is that job this home's (jobIsThisHomes)? */
  ours: (sm: ServiceManager) => Promise<boolean>;
  /** The pid of this home's running daemon, if any. */
  running: () => number | null;
  run: (cmd: [string, string[]]) => Promise<unknown>;
}): Promise<HandedStart> {
  if (o.env['XPC_SERVICE_NAME'] === LAUNCHD_LABEL || o.env['SYSTEMD_EXEC_PID'] === String(o.pid)) return { handled: false };
  if (await o.jobOf(o.pid)) return { handled: false };
  const job = await o.job();
  if (!job || !(await o.ours(job))) return { handled: false };
  const pid = o.running();
  if (pid !== null) return { handled: true, how: 'already-running', pid };
  const command = startCommand(job);
  try {
    await o.run(command);
    return { handled: true, how: 'started', job, command };
  } catch (e) {
    return { handled: true, how: 'failed', job, command, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Start a job that is not running (no -k: nothing is killed). */
export const startCommand = (sm: ServiceManager): [string, string[]] => (sm.kind === 'launchd' ? [LAUNCHCTL, ['kickstart', sm.target]] : ['systemctl', ['--user', '--no-block', 'start', sm.unit]]);
export const runServiceCommand = (cmd: [string, string[]], run: RunText = runText): Promise<string> => run(cmd[0], cmd[1]);

export const restartCommand = (sm: ServiceManager): [string, string[]] =>
  sm.kind === 'launchd' ? [LAUNCHCTL, ['kickstart', '-k', sm.target]] : ['systemctl', ['--user', '--no-block', 'restart', sm.unit]];

/**
 * (ADR-089 review F2) Restart a daemon run by a service manager WITHOUT cutting what it is doing — for a
 * caller that is not the daemon (`morse update`). `launchctl kickstart -k` sends SIGTERM and, after the job's
 * exit timeout — 5 s by default on macOS, measured — SIGKILL: less than the daemon needs to let a running
 * agent turn finish (15 s). So: SIGTERM straight to the daemon (no service manager, no exit timeout), wait
 * until it has stopped in its own orderly way, then have the manager start it again (launchd: `kickstart`
 * without -k — its KeepAlive may already have; systemd: `restart`). A daemon that has not stopped within
 * `waitMs` is restarted the hard way, as before.
 */
export async function restartGracefully(
  sm: ServiceManager,
  pid: number,
  opts: { kill?: (pid: number, signal: NodeJS.Signals) => void; alive?: (pid: number) => boolean; run?: RunText; sleep?: (ms: number) => Promise<void>; waitMs?: number } = {},
): Promise<'graceful' | 'forced'> {
  const kill = opts.kill ?? ((p, s) => void process.kill(p, s));
  const alive =
    opts.alive ??
    ((p: number) => {
      try {
        return process.kill(p, 0), true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    });
  const run = opts.run ?? runText;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    kill(pid, 'SIGTERM');
  } catch {
    /* gone already */
  }
  for (let waited = 0; alive(pid) && waited < (opts.waitMs ?? 25_000); waited += 200) await sleep(200);
  const stopped = !alive(pid);
  const [cmd, args] = stopped && sm.kind === 'launchd' ? [LAUNCHCTL, ['kickstart', sm.target]] : restartCommand(sm);
  await run(cmd, args).catch(() => undefined); // (launchd's KeepAlive / systemd's Restart= start it anyway)
  return stopped ? 'graceful' : 'forced';
}

/** Fire the restart detached: the service manager kills this process as part of it. */
export function spawnRestart(sm: ServiceManager): void {
  const [cmd, args] = restartCommand(sm);
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    /* reported by the caller's log line; the next start picks up the new code anyway */
  });
  child.unref();
}

/* ------------------------------------------------------------------ site, state */

/** MORSE_SITE (as install.sh) > update.site in config.json > https://morse.im (ADR-040). */
export function updateSite(cfg: { update?: { site?: unknown } } = {}, env: NodeJS.ProcessEnv = process.env): string {
  const pick = [env['MORSE_SITE'], cfg.update?.site].find((s): s is string => typeof s === 'string' && /^https?:\/\/[^\s]+$/.test(s.trim()));
  return (pick ?? DEFAULT_SITE).trim().replace(/\/+$/, '');
}

export type UpdateResult = 'up-to-date' | 'available' | 'installed' | 'deferred' | 'error' | 'off';

export interface UpdateState {
  lastCheckAt?: number;
  result?: UpdateResult;
  detail?: string;
  latest?: { version: string; release: number };
  failures?: number;
  nextCheckAt?: number;
  /** The last update this computer installed by itself. */
  installed?: { version: string; release: number; at: number };
  /** Release whose `morse setup` (skill + hooks) runs at the next daemon start. */
  pendingSetup?: number;
  /** (ADR-089) An update is holding back for agent turns that are running: before what, and until when at the latest. */
  waiting?: { before: 'install' | 'restart'; since: number; until: number };
}

export const updateStateFile = (): string => join(dataDir(), 'update.json');

export function readUpdateState(file: string = updateStateFile()): UpdateState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return s && typeof s === 'object' && !Array.isArray(s) ? (s as UpdateState) : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the state file; an undefined value removes that key. */
export type UpdatePatch = { [K in keyof UpdateState]?: UpdateState[K] | undefined };

export function writeUpdateState(patch: UpdatePatch, file: string = updateStateFile()): UpdateState {
  const merge = (): UpdatePatch => {
    const next = { ...readUpdateState(file), ...patch } as UpdatePatch;
    for (const k of Object.keys(next) as Array<keyof UpdateState>) if (next[k] === undefined) delete next[k];
    return next;
  };
  try {
    // under the file's lock: the daemon's updater and `morse update` both merge into it
    return withFileLock(file, () => {
      const next = merge();
      writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      return next as UpdateState;
    });
  } catch {
    /* status display only — never fatal */
    return merge() as UpdateState;
  }
}

/* ------------------------------------------------------------------ check + install */

/** Set when this check followed the site's key-rotation chain to a newer release key (ADR-041). */
export interface KeyRotation {
  from: number;
  to: number;
  keyId: string;
  /** The new key could not be stored (the chain is walked again next time). */
  saveError?: string;
}

export type CheckOutcome =
  | { kind: 'up-to-date'; latest: ReleaseManifest | null; detail: string; rotated?: KeyRotation }
  | { kind: 'available'; manifest: ReleaseManifest; rotated?: KeyRotation }
  | { kind: 'error'; code: VerifyCode | 'network' | 'bad-rotation'; error: string };

export interface FetchDeps {
  site: string;
  /** The release key pinned into this build (RELEASE_PUBLIC_KEY). */
  publicKey: string;
  /** Its generation in the rotation chain (RELEASE_KEY_GENERATION, default 0). */
  keyGeneration?: number;
  /** Where the newest followed key is stored (~/.morse/release-key.json); none = not stored. */
  keyStateFile?: string;
  /** Read from disk each time (an update already installed counts). */
  installedRelease: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

async function getBytes(f: typeof fetch, url: string, timeoutMs: number, max: number): Promise<Buffer> {
  const res = await f(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > max) throw new Error(`${url}: ${len} bytes is too large`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`${url}: ${buf.length} bytes is too large`);
  return buf;
}

/**
 * Fetch version.json + version.json.sig and authenticate them against the trusted key
 * (the pinned key, or a newer one this computer already followed). Signed by another
 * key → fetch the site's rotation chain and follow it ONLY if every link from the
 * trusted key on verifies; then the release must verify with the newest key, which is
 * stored (ADR-041).
 */
export async function checkLatest(deps: FetchDeps): Promise<CheckOutcome> {
  const f = deps.fetch ?? fetch;
  const t = deps.timeoutMs ?? 30_000;
  let bytes: Buffer;
  let sig: string;
  // one site only (ADR-075: no fallback to another domain); the signature check below decides either way
  const from = deps.site;
  try {
    [bytes, sig] = await Promise.all([
      getBytes(f, `${from}/version.json`, t, 64 * 1024),
      getBytes(f, `${from}/version.json.sig`, t, 4 * 1024).then((b) => b.toString('utf8')),
    ]);
  } catch (e) {
    return { kind: 'error', code: 'network', error: `could not fetch the release manifest: ${e instanceof Error ? e.message : String(e)}` };
  }
  const installed = deps.installedRelease();
  const pinned: TrustedKey = { publicKey: deps.publicKey, generation: deps.keyGeneration ?? 0 };
  const trusted = currentTrustedKey(pinned, deps.keyStateFile);
  let v = verifyManifest(bytes, sig, { publicKey: trusted.publicKey, installedRelease: installed });
  let rotated: KeyRotation | undefined;
  if (!v.ok && v.code === 'bad-signature') {
    // maybe the release key was rotated: follow the chain, never anything else
    let chainBytes: Buffer;
    try {
      chainBytes = await getBytes(f, `${from}/${ROTATION_CHAIN_PATH}`, t, MAX_CHAIN_BYTES);
    } catch {
      return { kind: 'error', code: 'bad-signature', error: `${v.error} (key ${keyIdOf(trusted.publicKey)}, generation ${trusted.generation}; the site has no key rotation chain)` };
    }
    const chain = parseChain(chainBytes);
    if (!chain.ok) return { kind: 'error', code: 'bad-rotation', error: `${v.error}; ${chain.error}` };
    const walk = walkChain(trusted, chain.links);
    if (!walk.ok) return { kind: 'error', code: 'bad-rotation', error: `${v.error}; ${walk.error}` };
    if (walk.steps === 0) {
      return { kind: 'error', code: 'bad-signature', error: `${v.error} (key ${keyIdOf(trusted.publicKey)}, generation ${trusted.generation}; the rotation chain has no newer key)` };
    }
    const v2 = verifyManifest(bytes, sig, { publicKey: walk.key.publicKey, installedRelease: installed });
    if (!v2.ok && v2.code === 'bad-signature') {
      return {
        kind: 'error',
        code: 'bad-signature',
        error: `version.json is signed neither by the trusted key (generation ${trusted.generation}) nor by the newest chained key ${keyIdOf(walk.key.publicKey)} (generation ${walk.key.generation}) — refused`,
      };
    }
    // the chain is authentic and the release is signed by its newest key: follow it
    rotated = { from: trusted.generation, to: walk.key.generation, keyId: keyIdOf(walk.key.publicKey) };
    if (deps.keyStateFile) {
      try {
        saveTrustedKey(deps.keyStateFile, walk.key);
      } catch (e) {
        rotated.saveError = e instanceof Error ? e.message : String(e);
      }
    }
    v = v2;
  }
  const extra = rotated ? { rotated } : {};
  if (v.ok) return { kind: 'available', manifest: v.manifest, ...extra };
  if (v.code === 'not-newer') {
    const m = v.manifest ?? null;
    const detail = m && m.release < installed ? `site offers older release ${m.release} — ignored (no downgrades)` : 'up to date';
    return { kind: 'up-to-date', latest: m, detail, ...extra };
  }
  return { kind: 'error', code: v.code, error: v.error };
}

/** One log line for a followed rotation. */
export const describeRotation = (r: KeyRotation): string =>
  `release key rotated: generation ${r.from} → ${r.to} (key ${r.keyId}) — every link of the rotation chain verified${r.saveError ? `; could not store it: ${r.saveError}` : ''}`;

/** Download the package the signed manifest names, check size + SHA-256, then install it. */
export async function downloadAndInstall(
  deps: FetchDeps & { install: (tgzPath: string) => Promise<void>; tmpRoot?: string; busy?: () => string | null },
  manifest: ReleaseManifest,
): Promise<{ ok: true } | { ok: false; error: string; deferred?: boolean }> {
  const f = deps.fetch ?? fetch;
  let tgz: Buffer;
  try {
    tgz = await getBytes(f, `${deps.site}/${manifest.file}`, 5 * 60_000, MAX_PACKAGE_BYTES);
  } catch (e) {
    return { ok: false, error: `download failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const p = verifyPackage(manifest, tgz);
  if (!p.ok) return p;
  const busy = deps.busy?.();
  if (busy) return { ok: false, deferred: true, error: busy };
  const dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'morse-update-'));
  try {
    const file = join(dir, `morse-${manifest.release}.tgz`);
    writeFileSync(file, tgz, { mode: 0o600 });
    await deps.install(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ deferral */

/**
 * A chunked file transfer in progress (ADR-038) blocks an update — the restart would
 * cut it (it would resume, but there is no hurry). Incoming entries with no progress for
 * `staleMs` do not count: they may never finish and must not block updates for a day.
 */
export function transferBusy(
  outgoing: Array<{ state: string }>,
  incoming: Array<{ updatedAt: number }>,
  now: number = Date.now(),
  staleMs = 5 * 60_000,
): string | null {
  const out = outgoing.filter((t) => t.state === 'sending').length;
  const inc = incoming.filter((t) => now - t.updatedAt < staleMs).length;
  if (!out && !inc) return null;
  return `file transfer in progress (${[out ? `${out} outgoing` : '', inc ? `${inc} incoming` : ''].filter(Boolean).join(', ')})`;
}

/* ------------------------------------------------------------------ scheduler */

export interface UpdateTiming {
  /** First check: a random moment between these after the daemon starts. */
  firstMinMs: number;
  firstMaxMs: number;
  /** Then every intervalMs (+ up to jitterMs). */
  intervalMs: number;
  jitterMs: number;
  /** After a failure: retryBaseMs × 2^(failures−1), at most intervalMs. */
  retryBaseMs: number;
  /** A transfer is in progress: look again after deferMs. */
  deferMs: number;
  /** update.auto is false: look at the setting again after offRecheckMs (no network). */
  offRecheckMs: number;
}

export const DEFAULT_TIMING: UpdateTiming = {
  firstMinMs: 60_000,
  firstMaxMs: 10 * 60_000,
  intervalMs: 6 * 3600_000,
  jitterMs: 10 * 60_000,
  retryBaseMs: 15 * 60_000,
  deferMs: 10 * 60_000,
  offRecheckMs: 10 * 60_000,
};

/** Test / ops overrides: MORSE_UPDATE_FIRST_CHECK_MS, MORSE_UPDATE_INTERVAL_MS, MORSE_UPDATE_RETRY_MS. */
export function timingFromEnv(env: NodeJS.ProcessEnv = process.env, base: UpdateTiming = DEFAULT_TIMING): UpdateTiming {
  const n = (k: string): number | null => {
    const v = Number(env[k]);
    return env[k] !== undefined && Number.isFinite(v) && v >= 0 ? v : null;
  };
  const t = { ...base };
  const first = n('MORSE_UPDATE_FIRST_CHECK_MS');
  if (first !== null) {
    t.firstMinMs = first;
    t.firstMaxMs = first;
  }
  const interval = n('MORSE_UPDATE_INTERVAL_MS');
  if (interval !== null && interval > 0) {
    t.intervalMs = interval;
    t.jitterMs = Math.min(t.jitterMs, Math.floor(interval / 10));
    t.deferMs = Math.min(t.deferMs, interval);
    t.offRecheckMs = Math.min(t.offRecheckMs, interval);
  }
  const retry = n('MORSE_UPDATE_RETRY_MS');
  if (retry !== null && retry > 0) t.retryBaseMs = retry;
  return t;
}

export const firstDelay = (t: UpdateTiming, random: () => number = Math.random): number =>
  Math.round(t.firstMinMs + random() * Math.max(0, t.firstMaxMs - t.firstMinMs));

/** When to look next, after a check that ended in `result` (failures = consecutive failures so far). */
export function nextDelay(result: UpdateResult, failures: number, t: UpdateTiming, random: () => number = Math.random): number {
  const jitter = Math.round(random() * t.jitterMs);
  switch (result) {
    case 'error':
      return Math.min(t.intervalMs, t.retryBaseMs * 2 ** Math.max(0, failures - 1)) + jitter;
    case 'deferred':
      return t.deferMs;
    case 'off':
      return t.offRecheckMs;
    default:
      return t.intervalMs + jitter;
  }
}

export interface AutoUpdaterOptions {
  /** update.auto in config.json (read every time — no restart needed to switch it). */
  enabled: () => boolean;
  /** A chunked transfer in progress → defer (reason), else null. */
  busy: () => string | null;
  /**
   * ADR-089: wait (bounded, by the callee) for a moment when no agent turn is being delivered — called before
   * the install and again before the restart. Never a reason to skip the update.
   */
  quiet?: (before: 'install' | 'restart') => Promise<unknown>;
  check: () => Promise<CheckOutcome>;
  install: (m: ReleaseManifest) => Promise<{ ok: true } | { ok: false; error: string; deferred?: boolean }>;
  /** After a successful install: restart through launchd / systemd, or 'manual' when not run by one. */
  restart: () => Promise<'restarted' | 'manual'>;
  log: (line: string) => void;
  timing?: UpdateTiming;
  random?: () => number;
  now?: () => number;
  stateFile?: string;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (h: unknown) => void;
  /** A scheduled check that has not finished after this long counts as failed (default 45 min). */
  tickTimeoutMs?: number;
  /** The Node.js running this daemon (default: process.versions.node) — for the ADR-084 hint. */
  nodeVersion?: string;
}

export interface AutoUpdater {
  /** One check (+ install). Never throws. */
  tick(): Promise<UpdateResult>;
  stop(): void;
}

export function startAutoUpdater(o: AutoUpdaterOptions): AutoUpdater {
  const t = o.timing ?? DEFAULT_TIMING;
  const random = o.random ?? Math.random;
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const save = (p: UpdatePatch) => writeUpdateState(p, o.stateFile);
  let failures = 0;
  let timer: unknown = null;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<UpdateResult> => {
    if (running) return 'deferred';
    running = true;
    try {
      if (!o.enabled()) {
        save({ result: 'off', detail: 'update.auto is false in config.json' });
        return 'off';
      }
      const c = await o.check();
      const at = now();
      if (c.kind !== 'error' && c.rotated) o.log(`update: ${describeRotation(c.rotated)}`);
      if (c.kind === 'error') {
        failures++;
        o.log(`update: check failed (${failures} in a row): ${c.error}`);
        save({ lastCheckAt: at, result: 'error', detail: c.error, failures });
        return 'error';
      }
      if (c.kind === 'up-to-date') {
        failures = 0;
        o.log(`update: ${c.detail}${c.latest ? ` (site: ${c.latest.version} release ${c.latest.release})` : ''}`);
        save({ lastCheckAt: at, result: 'up-to-date', detail: c.detail, failures: 0, ...(c.latest ? { latest: { version: c.latest.version, release: c.latest.release } } : {}) });
        return 'up-to-date';
      }
      const m = c.manifest;
      const latest = { version: m.version, release: m.release };
      o.log(`update: release ${m.release} (${m.version}) is available — signature verified`);
      const busy = o.busy();
      if (busy) {
        o.log(`update: deferred — ${busy}`);
        save({ lastCheckAt: at, result: 'deferred', detail: busy, latest });
        return 'deferred';
      }
      // (ADR-089) the restart that follows stops the dispatch plugin: wait for the turns that are running
      await o.quiet?.('install')?.catch(() => undefined);
      o.log(`update: downloading ${m.file} (${m.size} bytes) …`);
      const r = await o.install(m);
      if (!r.ok) {
        if (r.deferred) {
          o.log(`update: deferred — ${r.error}`);
          save({ lastCheckAt: at, result: 'deferred', detail: r.error, latest });
          return 'deferred';
        }
        failures++;
        o.log(`update: install failed (${failures} in a row): ${r.error}`);
        save({ lastCheckAt: at, result: 'error', detail: r.error, failures, latest });
        return 'error';
      }
      failures = 0;
      save({ lastCheckAt: at, result: 'installed', detail: `installed release ${m.release}`, failures: 0, latest, installed: { ...latest, at: now() }, pendingSetup: m.release });
      o.log(`update: installed release ${m.release} (${m.version}) — sha256 and signature verified`);
      // ADR-084: a hint only on Node < 22 — the update itself is never refused
      const nodeHint = nodeUpgradeHint(o.nodeVersion);
      if (nodeHint) o.log(`update: node ${nodeHint}`);
      let how: 'restarted' | 'manual' = 'manual';
      // (ADR-089) …and a turn that began while this was installing
      await o.quiet?.('restart')?.catch(() => undefined);
      try {
        how = await o.restart();
      } catch (e) {
        o.log(`update: restart failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      o.log(how === 'restarted' ? 'update: restarting the daemon through its service manager …' : 'update: update installed, restart to apply (morse stop --restart)');
      // (ADR-083) nobody restarts it for the user: until they do, this daemon is older than the installed commands —
      // said with the very line every command then says
      if (how !== 'restarted') o.log(`update: ${OLDER_DAEMON_LINE}`);
      return 'installed';
    } catch (e) {
      failures++;
      const msg = e instanceof Error ? e.message : String(e);
      o.log(`update: unexpected error (${failures} in a row): ${msg}`);
      save({ lastCheckAt: now(), result: 'error', detail: msg, failures });
      return 'error';
    } finally {
      running = false;
    }
  };

  // ADR-043: the next check is always armed — even when this one hangs (a fetch or npm
  // that never returns): after tickTimeoutMs it counts as failed and the loop goes on.
  const tickTimeout = o.tickTimeoutMs ?? 45 * 60_000;
  const timedTick = (): Promise<UpdateResult> =>
    new Promise<UpdateResult>((resolve) => {
      let settled = false;
      const h = setTimer(() => {
        if (settled) return;
        settled = true;
        failures++;
        running = false; // the hung one may never come back: do not let it block every later check
        o.log(`update: check did not finish within ${Math.round(tickTimeout / 60_000)} min — given up, will try again`);
        save({ lastCheckAt: now(), result: 'error', detail: 'check timed out', failures });
        resolve('error');
      }, tickTimeout);
      h.unref?.();
      tick().then(
        (r) => {
          if (settled) return;
          settled = true;
          clearTimer(h);
          resolve(r);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimer(h);
          resolve('error');
        },
      );
    });
  const schedule = (ms: number) => {
    if (stopped) return;
    const h = setTimer(() => {
      void timedTick()
        .catch(() => 'error' as const)
        .then((r) => schedule(nextDelay(r, failures, t, random)));
    }, ms);
    h.unref?.();
    timer = h;
    save({ nextCheckAt: now() + ms });
  };
  schedule(firstDelay(t, random));

  return {
    tick,
    stop: () => {
      stopped = true;
      if (timer) clearTimer(timer);
    },
  };
}
