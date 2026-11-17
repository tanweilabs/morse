#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { existsSync, fstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { Command, Option } from 'commander';
import type { SessionInfo } from './adapters/types.js';
import { cachedSessionDirectory, deliveryAdapters, sessionOrExit } from './cli/sessions.js';
import { describeDirectStatus, describeRelayStatus, formatRelativeTime, type DirectStatusView, type RelayStatusView } from './format.js';
import { changesContactsOrSends, OLDER_DAEMON_LINE, olderDaemonRunning } from './daemon/capabilities.js';
import { MigrationRefusedV5, upgradeLineV5 } from './mailbox/migrate-v5.js';
import { repairLineV5 } from './mailbox/repair-v5.js';
import { createDb, mailboxVersion } from './mailbox/db.js';
import { BackupError } from './mailbox/migrate-v3.js';
import { MigrationRefusedV4, SCHEMA_VERSION_V4 } from './mailbox/migrate-v4.js';
import { homeContactContext } from './mailbox/home-context.js';
import { createMailbox, type Message, type MessageFile, type SessionRef } from './mailbox/mailbox.js';
import { DEFAULT_RELAY_URL, DEFAULT_SITE_URL } from './cluster/address.js';
import { loadOrCreateIdentity } from './cluster/identity.js';
import { maxAttachmentBytes, stageOutboxFiles } from './cluster/morse.js';
import { chunkSizeFor, fileLimitsFrom, formatBytes, listIncoming } from './cluster/chunks.js';
import { createTrustStore } from './cluster/trust.js';
import { migrateLegacyDomains, readMachineConfig } from './machine-config.js';
import { dataDir, isIsolatedHome } from './home.js';
import { isPeerMessage, peerTag } from './peer-framing.js';
import { isWindows, offLine, offReason, platformOff, WINDOWS_INSTALL_COMMAND } from './platform/platform.js';
import { NO_NICKNAMES, remarkLookupFor, withRemark, type RemarkLookup } from './cluster/remarks.js';
import { RELEASE_KEY_GENERATION, RELEASE_KEY_PLACEHOLDER, RELEASE_PUBLIC_KEY } from './update/release-key.js';
import { keyIdOf } from './update/manifest.js';
import { currentTrustedKey, trustedKeyFile } from './update/rotation.js';
import {
  checkLatest,
  describeRelease,
  describeRotation,
  detectServiceManager,
  downloadAndInstall,
  npmInstaller,
  readInstalledRelease,
  readUpdateState,
  detectServiceJob,
  jobIsThisHomes,
  restartCommand,
  restartGracefully,
  runServiceCommand,
  startCommand,
  startThroughServiceManager,
  spawnRestart,
  startAutoUpdater,
  timingFromEnv,
  transferBusy,
  updateSite,
  writeUpdateState,
  type AutoUpdater,
  type ServiceManager,
} from './update/updater.js';
import { nodeStatusLine } from './node-version.js';

/**
 * Who started this process — read before anything else runs. `morse plugin watch` ends when that process is gone
 * (its parent changes); read later — after the first event was printed — the reader could already have been
 * killed in between, the new parent taken for the old one, and the watch would have polled for ever.
 */
const STARTED_BY = process.ppid;
/** The package's version — the same in every release (a release is told by its stamp, ADR-039). */
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * ADR-039: the daemon's auto-updater. Off for a development build (no release number:
 * a git checkout must never npm-install itself over a global morse) and while
 * update.auto is false. Runs `morse setup` once after a self-installed update.
 */
async function startDaemonUpdater(
  busy: () => string | null,
  quiet?: (before: 'install' | 'restart') => Promise<unknown>,
  orderlyRestart?: (sm: ServiceManager) => void,
): Promise<AutoUpdater | null> {
  const stamp = (l: string) => console.log(`[${new Date().toISOString()}] ${l}`);
  const running = readInstalledRelease();
  stamp(`update: running ${describeRelease(running)}`);
  // (ADR-089 review N1) a computer installed before the installer wrote them: our own launchd plist / systemd unit
  // gets the stop timeouts added in place — never from an isolated home (the service belongs to the default one),
  // and nothing is restarted for it
  if (!isIsolatedHome()) {
    const { ensureServiceFileTimeouts } = await import('./update/service-file.js');
    const childProcess = await import('node:child_process');
    const r = ensureServiceFileTimeouts({
      reload: () => void childProcess.spawn('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref(),
    });
    if (r.outcome === 'patched') stamp(`service: added the stop timeouts to ${r.file} (ADR-089) — ${process.platform === 'darwin' ? 'launchd uses them from the next time it loads the job (login)' : 'systemd was told to re-read its unit files'}; nothing was restarted`);
    else if (r.outcome === 'error') stamp(`service: could not add the stop timeouts to ${r.file}: ${r.detail}`);
  }
  const st = readUpdateState();
  if (running.release > 0 && st.pendingSetup === running.release) {
    // first start after an auto-update: refresh the skill + hooks, as install.sh does —
    // never from an isolated instance (MORSE_HOME set): setup writes into the real ~/.claude
    try {
      if (isIsolatedHome()) throw new Error('isolated MORSE_HOME — run morse setup yourself');
      const { runSetup } = await import('./setup.js');
      await runSetup({ withHook: true });
      stamp(`update: morse setup done for release ${running.release}`);
    } catch (e) {
      stamp(`update: morse setup after the update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    writeUpdateState({ pendingSetup: undefined });
  }
  if (platformOff('update')) {
    // ADR-080: a running daemon cannot npm-install over its own loaded native modules on Windows (phase 3)
    stamp(`update: auto-update off on Windows in this release (ADR-080) — to update, run the installer again: ${WINDOWS_INSTALL_COMMAND}`);
    return null;
  }
  if (!running.release) {
    stamp('update: auto-update off (development build — install from the site to get updates)');
    return null;
  }
  if (RELEASE_PUBLIC_KEY === RELEASE_KEY_PLACEHOLDER) {
    stamp('update: auto-update off (this build has no release key pinned)');
    return null;
  }
  const site = () => updateSite(readMachineConfig());
  const deps = () => ({ site: site(), ...releaseKeyDeps(), installedRelease: () => readInstalledRelease().release });
  const timing = timingFromEnv();
  const dur = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);
  stamp(`update: auto-update ${readMachineConfig().update?.auto === false ? 'off (update.auto: false)' : 'on'} — ${site()}/version.json, first check in ${dur(timing.firstMinMs)}–${dur(timing.firstMaxMs)}, then every ${dur(timing.intervalMs)}`);
  return startAutoUpdater({
    enabled: () => readMachineConfig().update?.auto !== false,
    busy,
    ...(quiet ? { quiet } : {}),
    check: () => checkLatest(deps()),
    install: (m) => downloadAndInstall({ ...deps(), busy, install: npmInstaller({ log: stamp }) }, m),
    restart: async () => {
      const sm = await ofThisHome(await detectServiceManager(process.pid));
      if (!sm) return 'manual';
      // (ADR-089 review F2) the daemon stops in its own orderly way FIRST — plugins get their time to let a turn
      // finish — and only then is the service manager asked to restart it: `launchctl kickstart -k` gives a
      // job 5 s between SIGTERM and SIGKILL by default, less than that takes
      if (orderlyRestart) {
        stamp(`update: stopping in an orderly way, then: ${restartCommand(sm).flat().join(' ')}`);
        orderlyRestart(sm);
      } else {
        stamp(`update: ${restartCommand(sm).flat().join(' ')}`);
        spawnRestart(sm);
      }
      return 'restarted';
    },
    log: stamp,
    timing,
  });
}

/** The pinned release key + where the newest followed key is stored (ADR-039, ADR-041). */
const releaseKeyDeps = () => ({ publicKey: RELEASE_PUBLIC_KEY, keyGeneration: RELEASE_KEY_GENERATION, keyStateFile: trustedKeyFile() });

/** Morse outbox policy from ~/.morse/config.json (retry an unreachable person every N s, up to M days). */
const outboxOptions = () => {
  const o = readMachineConfig().outbox ?? {};
  return {
    ...(o.retryIntervalSec && o.retryIntervalSec > 0 ? { waitRetryMs: o.retryIntervalSec * 1000 } : {}),
    ...(o.maxWaitDays && o.maxWaitDays > 0 ? { waitMaxMs: o.maxWaitDays * 86_400_000 } : {}),
  };
};
const openMailbox = () => {
  const max = readMachineConfig().morse?.maxRequests;
  const ctx = homeContactContext();
  try {
    return openMailboxWith(ctx, max);
  } catch (e) {
    // ADR-077, ADR-083: the contact upgrade could not take its backup, or could not be done safely (which
    // addresses this computer has cannot be read) — one clear line, nothing was changed
    // (ADR-091 follow-up) …and the v5 upgrade the same way (BackupErrorV5 is a MigrationRefusedV5)
    if (e instanceof BackupError || e instanceof MigrationRefusedV4 || e instanceof MigrationRefusedV5) {
      console.error(`error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
};
const openMailboxWith = (ctx: ReturnType<typeof homeContactContext>, max: unknown) => {
  const db = createDb(undefined, {
    ctx,
    // ADR-049: said once, on the open that migrated the database
    onMigrate: (r) =>
      console.error(
        `morse: mailbox upgraded to v${r.to} — ${r.rows} message(s) sorted into contacts (${Object.entries(r.byDirection).map(([k, v]) => `${k} ${v}`).join(', ')}), ${r.unprocessed} to process${r.backup ? `; backup: ${r.backup}` : ''}`,
      ),
    // ADR-077: said once, on the open that moved the contacts to one per address
    onMigrateV3: (r) => {
      if (r.backup)
        console.error(
          `morse: contacts upgraded to one per address${r.ownDevices ? ` — ${r.ownDevices} of your own computer(s) are now contacts in group self` : ''}${r.pending ? `; ${r.pending} contact(s) are checked with the relay when the daemon is next online` : ''}; nothing was deleted, backup: ${r.backup}`,
        );
    },
    // (ADR-091) said once, on the open that made every contact a contact by address (v2 removed)
    onMigrateV5: (r) => {
      if (r.backup) console.error(upgradeLineV5(r));
    },
    // (ADR-091 follow-up) said once, when what the v5 upgrade got wrong was put right
    onRepairV5: (r) => {
      const line = repairLineV5(r);
      if (line) console.error(line);
    },
    // (ADR-083) said once, on the open that gave each of your addresses its own contacts and message requests
    onMigrateV4: (r) => {
      if (r.backup)
        console.error(
          // (ADR-083 review R2: a block from before the upgrade was the whole computer's — it is kept at every address)
          `morse: contacts and message requests are now kept per address of yours${r.elsewhere ? ` — ${r.elsewhere} contact(s) belong to an address other than your first` : ''}; people you had blocked stay blocked at all your addresses; nothing was deleted, backup: ${r.backup}`,
        );
    },
  });
  return createMailbox(db, { ctx, ...outboxOptions(), ...(typeof max === 'number' && max >= 1 ? { maxRequests: Math.floor(max) } : {}) });
};

/** Tell the running daemon a message request was accepted, so it notifies that person (ADR-037). */
async function tellDaemonAccepted(handle: string, port: number | undefined, /** (ADR-083) the address of mine that accepted ('' = the first) */ myAddress?: string): Promise<number | null> {
  try {
    const { localApi } = await import('./daemon/local-api.js');
    // (ADR-087) only this home's daemon is told — with this home's token; the device ID stays as a second check
    const res = await localApi('/api/morse/accepted', {
      port,
      json: { handle, deviceId: loadOrCreateIdentity().id, ...(myAddress !== undefined ? { myAddress } : {}) },
      timeoutMs: 15_000,
    });
    if (!res.ok) return null;
    return ((await res.json()) as { told?: number }).told ?? 0;
  } catch {
    return null; // no daemon running for this home
  }
}

/** `@[device/]agent`: who a message is from or for. */
const atOf = (end: { agent: string; device?: string }): string => `@${end.device ? `${end.device}/` : ''}${end.agent}`;

/** A message's text for a one-line listing: JSON-quoted, cut after 120 characters. */
function textPreview(m: Message): string {
  const body = m.parts.map((p) => p.text).join('\n');
  return JSON.stringify(body.length <= 120 ? body : `${body.slice(0, 120)}…`);
}

/** One message of a listing: id, state, who to whom, the text; then a peer warning and its files. */
function printMessage(m: Message, remarkOf?: RemarkLookup, /** (ADR-083) `  via <name>`: which of my addresses, when this computer has several */ suffix = ''): void {
  // a Morse sender shows YOUR remark for its address first: <remark> (@k7f3a9xq/mini/claude) — never a nickname (ADR-065)
  const from = m.from.device ? withRemark(atOf(m.from), remarkOf) : atOf(m.from);
  const receipt = m.receiptAt ? '  ✓ receipt' : '';
  const status = m.request
    ? 'request pending (in their message requests — they have not accepted you yet)'
    : m.waiting
    ? `${m.status} (waiting: ${m.lastError ?? 'recipient unreachable'})`
    : (m.status === 'failed' || m.status === 'dead') && m.lastError
      ? `${m.status} (${m.lastError})`
      : m.status;
  console.log(`[${m.id.slice(0, 8)}] ${status}${receipt}  ${from} → ${atOf(m.to)}:${m.to.sessionId.slice(0, 8)}  ${textPreview(m)}${suffix}`);
  if (isPeerMessage(m)) console.log(`    ⚠ ${peerTag(m, remarkOf)}`);
  // ADR-038: attachments — name, size, where the file is (inbox: saved 0600, never opened or run)
  for (const f of m.parts.flatMap((p) => p.files ?? [])) console.log(`    file: ${f.name}  ${formatBytes(f.size)}  ${f.path}`);
}

/** `morse send --file`: follow a chunked message until it is delivered (or parked in the outbox). */
async function followTransfer(port: number | undefined, id: string, chunks: number): Promise<void> {
  const tty = process.stdout.isTTY;
  let last = '';
  let lastPrinted = -1;
  const started = Date.now();
  const line = (text: string, final = false) => {
    if (tty) process.stdout.write(`\r\x1b[K${text}${final ? '\n' : ''}`);
    else if (final || text !== last) console.log(text);
    last = text;
  };
  for (;;) {
    let body: { message?: Message; transfer?: { state: string; acked: number; total: number; sent: number; via: string | null; error?: string } | null };
    try {
      const { localApi } = await import('./daemon/local-api.js');
      const res = await localApi(`/api/morse/transfer/${encodeURIComponent(id)}`, { port, timeoutMs: 5000 });
      body = (await res.json()) as typeof body;
    } catch {
      line('lost the daemon — the message stays in the outbox (morse read --all)', true);
      return;
    }
    const m = body.message;
    const t = body.transfer;
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (m?.receiptAt) {
      line(`delivered: ${t ? `${t.total}/${t.total}` : `${chunks}/${chunks}`} chunks${t?.via ? ` via ${t.via}` : ''}, checked by the recipient (${secs} s)`, true);
      return;
    }
    if (m?.request) {
      line('request pending: they have not accepted you yet — the files go once they do', true);
      return;
    }
    if (m && (m.status === 'dead' || (m.status === 'failed' && !m.waiting))) {
      line(`failed: ${m.lastError ?? t?.error ?? 'unknown error'}`, true);
      process.exitCode = 1;
      return;
    }
    if (t && t.state === 'waiting' && m?.waiting) {
      line(`not reachable right now (${t.acked}/${t.total} chunks there): ${t.error ?? m.lastError ?? ''} — kept in the outbox, it resumes by itself (morse read --all)`, true);
      return;
    }
    if (t && t.state === 'failed') {
      line(`failed: ${t.error ?? 'unknown error'}`, true);
      process.exitCode = 1;
      return;
    }
    const acked = t?.acked ?? 0;
    const total = t?.total ?? chunks;
    const pct = total ? Math.floor((acked / total) * 100) : 0;
    // not a TTY: a line every 10 % (and on changes of state)
    if (tty || Math.floor(pct / 10) !== lastPrinted || !t) {
      lastPrinted = Math.floor(pct / 10);
      line(t ? `sending: ${acked}/${total} chunks confirmed (${pct} %, ${t.sent} sent${t.via ? `, via ${t.via}` : ''}, ${secs} s)` : `waiting to start (${total} chunks)…`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** How to run this very `morse` (for plugins): node + its flags (tsx in development) + this file. */
const selfArgv = (): string[] => [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url)];
/** The built-in dispatch plugin next to this file (dist/plugins/dispatch/main.js, or .ts under tsx). */
const builtinPluginArgv = (name: string): string[] => {
  const ts = import.meta.url.endsWith('.ts');
  return [process.execPath, ...(ts ? process.execArgv : []), fileURLToPath(new URL(`./plugins/${name}/main.${ts ? 'ts' : 'js'}`, import.meta.url))];
};
const builtinDispatchArgv = (): string[] => builtinPluginArgv('dispatch');
/** ADR-053: the built-in iLink (WeChat) plugin — off unless `morse plugin enable ilink`. */
/** ADR-059 / ADR-066: the built-in attendant (your agent answers your contacts) — on unless disabled. */
const builtinPlugins = () => ({ dispatch: builtinDispatchArgv(), ilink: [...builtinPluginArgv('ilink'), 'run'], attendant: [...builtinPluginArgv('attendant'), 'run'] });

/** The environment checks: `morse status --check` (and the old `morse doctor`). */
async function runChecks(): Promise<void> {
  const { runDoctor } = await import('./doctor.js');
  process.exitCode = (await runDoctor()) ? 0 : 1;
}

/**
 * `morse start --background` (ADR-080): the daemon in the background, its output appended to
 * daemon.log — what a service manager does on macOS / Linux and nothing does on Windows.
 */
/**
 * (ADR-089 follow-up M5) A service-manager job counts only when it is THIS home's: `launchctl` and
 * `systemctl --user` go by the user, a Morse home by HOME — the job must have been loaded from this home's own
 * service file. Asked before every start, stop or restart through the service manager.
 */
async function ofThisHome(sm: ServiceManager | null): Promise<ServiceManager | null> {
  if (!sm || isIsolatedHome()) return null;
  const { serviceFilePath } = await import('./update/service-file.js');
  return (await jobIsThisHomes(sm, serviceFilePath())) ? sm : null;
}

/**
 * (ADR-089 follow-up M1) `morse start` where launchd / systemd runs the daemon: the start goes to the service
 * manager (src/update/updater.ts `startThroughServiceManager`). true = handled: the caller returns.
 */
async function handStartToServiceManager(): Promise<boolean> {
  const { runningDaemonPid } = await import('./daemon/pidfile.js');
  const r = await startThroughServiceManager({
    env: process.env,
    pid: process.pid,
    jobOf: (pid) => detectServiceManager(pid),
    job: () => detectServiceJob(),
    ours: async (sm) => (await ofThisHome(sm)) !== null,
    running: () => runningDaemonPid(),
    run: (cmd) => runServiceCommand(cmd),
  });
  if (!r.handled) return false;
  if (r.how === 'already-running') console.log(`daemon already running (pid ${r.pid})`);
  else if (r.how === 'started') console.log(`daemon: ${r.job.kind} runs it — started through ${r.job.kind} (${r.command.flat().join(' ')}); log: ${join(dataDir(), 'daemon.log')}. Restart: morse stop --restart`);
  else {
    console.error(`✗ ${r.job.kind} could not start the daemon (${r.command.flat().join(' ')}): ${r.error}`);
    process.exitCode = 1;
  }
  return true;
}

/**
 * `morse stop --restart` (ADR-089): restart a daemon that launchd / systemd runs WITHOUT cutting the message
 * it is handling — the daemon is asked to stop directly and has its own time for that; only then does the
 * service manager start it again. `by-hand`: no service manager runs this daemon — the caller stops it and
 * says that nobody starts it again.
 */
async function restartThroughServiceManager(): Promise<'restarted' | 'started' | 'by-hand' | 'not-running'> {
  const { runningDaemonPid } = await import('./daemon/pidfile.js');
  const pid = runningDaemonPid();
  if (pid !== null) {
    const sm = await ofThisHome(await detectServiceManager(pid));
    if (!sm) return 'by-hand';
    console.log(`daemon: restarting through ${sm.kind} — waiting for it to stop first (a message being handled may finish) …`);
    const how = await restartGracefully(sm, pid);
    console.log(how === 'graceful' ? 'daemon: restarted' : `daemon: it did not stop in time — restarted the hard way (${restartCommand(sm).flat().join(' ')})`);
    return 'restarted';
  }
  // not running: start the service manager's job — only when it is THIS home's (see ofThisHome): without that,
  // a command run for another home (a test) would start the real daemon's job
  const job = await ofThisHome(await detectServiceJob());
  if (!job) return 'not-running';
  await runServiceCommand(startCommand(job)).catch(() => undefined);
  console.log(`daemon: was not running — started through ${job.kind} (${startCommand(job).flat().join(' ')})`);
  return 'started';
}

async function startInBackgroundAction(wait: boolean): Promise<void> {
  const { readPid, runningDaemonPid } = await import('./daemon/pidfile.js');
  const { startInBackground, waitUntilUp, tailOf } = await import('./daemon/background.js');
  // (ADR-083 review N3) a pid file whose pid is another program's by now names no daemon — on Windows that is the
  // usual state after a logoff, which kills the daemon without cleanup
  const existing = runningDaemonPid();
  if (existing !== null) {
    console.log(`daemon already running (pid ${existing})`);
    return;
  }
  try {
    // Windows: the directory the log (and everything else) goes into is private first
    (await import('./platform/acl.js')).protectDataDir(dataDir());
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const logFile = join(dataDir(), 'daemon.log');
  // the same command line, minus the two options that only concern this process
  const rest = process.argv.slice(2).filter((a) => a !== '--background' && a !== '--no-wait');
  // the daemon runs from the home directory, as under launchd / systemd (a development build: where tsx resolves from)
  const child = startInBackground({ argv: [...selfArgv(), ...rest], logFile, cwd: import.meta.url.endsWith('.ts') ? process.cwd() : homedir() });
  let spawnError: Error | null = null;
  child.once('error', (e) => {
    spawnError = e;
  });
  if (!wait && child.pid !== undefined) {
    console.log(`daemon: starting in the background (pid ${child.pid}) — log: ${logFile}`);
    return;
  }
  const up = child.pid === undefined ? 'exited' : await waitUntilUp({ child, readPid });
  if (up === 'up') {
    console.log(`daemon: started in the background (pid ${child.pid}) — log: ${logFile}`);
    return;
  }
  const why = spawnError ? (spawnError as Error).message : up === 'exited' ? `it exited with code ${child.exitCode}` : 'no sign of it after 20 s';
  console.error(`✗ the daemon did not start (${why}) — the end of ${logFile}:`);
  for (const l of tailOf(logFile)) console.error(`    ${l}`);
  process.exitCode = 1;
}

// (test/local-api-followups.test.ts reads this line: STARTED_BY must be taken before it)
const program = new Command();
program.name('morse')
  .description('Morse — messaging between AI agents (Claude Code, Codex, …), across addresses and networks.')
  // the package version never changes; a release is identified by its stamp (ADR-039, ADR-075)
  .version(describeRelease(readInstalledRelease()))
  // a parent's options only before its verb: `contact add x --json` gives --json to `add` (ADR-074)
  .enablePositionalOptions()
  // our own `help` (below) knows --all; commander's would be one more listed command
  .helpCommand(false);

/**
 * ADR-074 / ADR-077 (K) / ADR-090: `morse --help` lists five commands — the three messaging verbs, then the two nouns
 * (`agent` folded into `address`, `message` became `read`); these eleven are hidden but listed by `morse help --all`.
 * Every other command is a hidden alias of an older name.
 */
const VISIBLE_COMMANDS = ['read', 'send', 'reply', 'contact', 'address'];
const LISTED_HIDDEN = ['message', 'start', 'stop', 'status', 'update', 'setup', 'hook', 'list', 'done', 'connect', 'plugin'];
const hidden = { hidden: true } as const;
/** A removed command: one line, exit code 1. */
const removedCommand = (name: string, what: string) =>
  program
    .command(name, hidden)
    .argument('[args...]')
    .allowUnknownOption(true)
    .helpOption(false)
    .action(() => {
      console.error(`morse ${name} was removed (ADR-074) — ${what}`);
      process.exitCode = 1;
    });
removedCommand('collab', 'the shared collaboration doc is gone; agents coordinate in their messages');
removedCommand('flush', 'the daemon delivers (morse start)');

/** `morse start`'s options, in the order its help lists them: flags, what they do, the default when given. */
const START_OPTIONS: ReadonlyArray<readonly [flags: string, description: string, byDefault?: string]> = [
  ['--interval <ms>', 'mailbox poll interval', '1000'],
  ['--directory-ttl <ms>', 'session directory cache TTL', '30000'],
  ['--port <port>', 'web console port', '7433'],
  ['--no-web', 'disable the web console server'],
  ['--lan', 'hand messages over on the LAN by address (mDNS) this run — off unless morse.lan is true in config.json'],
  ['--no-lan', 'do not hand messages over on the LAN, even with morse.lan: true'],
  ['--no-notify', 'disable macOS notifications on new cross-agent traffic'],
  ['--peer <address@host:port...>', 'an address served on the LAN at host:port, without mDNS (networks where multicast does not work)'],
  ['--peer-port <port>', 'LAN port other Morse daemons hand messages to (default: console port + 1)'],
  ['--relay <url>', 'Morse relay (ws:// or wss://) (default: relay.url in ~/.morse/config.json)'],
  ['--background', 'start the daemon in the background (output appended to daemon.log in the data directory) and return — what the Windows logon task runs; on macOS / Linux launchd / systemd do this'],
  ['--no-wait', 'with --background: return at once, without checking that the daemon came up'],
];
const startCmd = program.command('start', hidden).description('Start the morse daemon (foreground) — delivers messages + serves the web console');
for (const [flags, description, byDefault] of START_OPTIONS) {
  if (byDefault === undefined) startCmd.option(flags, description);
  else startCmd.option(flags, description, byDefault);
}

/** Does anything answer on this port of 127.0.0.1? (ADR-087: /api/ping is the one route that needs no token.) */
const portAnswers = (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) }).then(
    () => true,
    () => false,
  );

/** `morse start` cannot go on: one line on stderr, exit code 1. */
const cannotStart = (line: string): never => {
  console.error(line);
  process.exit(1);
};

startCmd
  .action(async (opts: { interval: string; directoryTtl: string; port: string; peerPort?: string; web: boolean; lan?: boolean; notify: boolean; peer?: string[]; relay?: string; background?: boolean; wait: boolean }) => {
    // (ADR-089 follow-up M1) where launchd / systemd runs the daemon, a start by hand goes to it
    if (!isWindows() && (await handStartToServiceManager())) return;
    if (opts.background) return startInBackgroundAction(opts.wait);
    // (ADR-088 §4) MORSE_ADDRESS selects an address for ONE session. The daemon and everything it starts (the
    // plugins, their `morse` commands, the agents they run) work for every address here: a daemon started from a
    // shell that exports it must not hand it on — taken out of this process's environment before anything starts.
    {
      const { ADDRESS_SELECTORS, dropAddressSelectors } = await import('./address-env.js');
      const set = ADDRESS_SELECTORS.filter((k) => process.env[k] !== undefined);
      dropAddressSelectors();
      if (set.length) console.log(`morse: ${set.join(', ')} in the daemon's environment is ignored — it selects an address for one session; the daemon and its plugins work for all of them`);
    }
    // ADR-035: ~/.anytoany → ~/.morse before anything opens a file (no-op once moved;
    // with another daemon running it is left for that one / the next start)
    {
      const { migrateDataDir } = await import('./migrate-home.js');
      await migrateDataDir({ log: (l) => console.log(l) });
    }
    // ADR-080 — Windows, phase 1: the data directory private to its owner before anything is written
    // (a no-op elsewhere), and LAN off: listening for other devices raises the firewall prompt (phase 5)
    try {
      const { protectDataDir } = await import('./platform/acl.js');
      // (recheck: the daemon does not take the marker's word — a data directory restored without its ACL is protected again)
      protectDataDir(dataDir(), { recheck: true });
    } catch (e) {
      console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    // (ADR-091 follow-up) the LAN by address is OFF unless asked for: `--lan`, or morse.lan: true in config.json
    opts.lan = opts.lan ?? readMachineConfig().morse?.lan === true;
    if (platformOff('lan') && opts.lan) {
      opts.lan = false;
      console.log(`windows: ${offLine('lan')}`);
    }
    const mailbox = openMailbox();
    /** A whole-number option, or its fallback when it is missing, 0 or not a number. */
    const numberOr = (text: string | undefined, fallback: number): number => Number.parseInt(text ?? '', 10) || fallback;
    const port = numberOr(opts.port, 7433);
    /**
     * The @any- mention agents (~/.claude/agents/any-*) follow the session directory — never from an isolated
     * home (MORSE_HOME / ANYTOANY_HOME set: tests, smoke runs), which would rewrite and prune the operator's real ones.
     */
    const syncMentions = (sessions: SessionInfo[]): Promise<void> =>
      import('./cluster/sync-agents.js')
        .then(({ syncMentionAgents }) => syncMentionAgents(sessions, mailbox.listConversations()))
        .then(({ written, removed }) => {
          if (written.length + removed.length > 0) console.log(`mention agents: +${written.length} -${removed.length} (~/.claude/agents/any-*)`);
        })
        .catch((e: unknown) => console.error(`warning: mention agent sync failed: ${e instanceof Error ? e.message : String(e)}`));
    // (ADR-091) the sessions of this computer only: other computers are contacts, and nobody reads anyone's sessions.
    // Registered external agents are in it (replies to them must resolve) but are never delivered to.
    const sessionDirectory = cachedSessionDirectory(numberOr(opts.directoryTtl, 30_000), isIsolatedHome() ? undefined : syncMentions);

    const { writePid, clearPid, runningDaemonPid } = await import('./daemon/pidfile.js');
    // (ADR-083 review N3) a left-over pid file whose pid is another program's by now is stale: removed, and this daemon starts
    const existing = runningDaemonPid();
    if (existing && existing !== process.pid) cannotStart(`daemon already running (pid ${existing}) — stop it first with morse stop`);
    // Something answering on our port is another morse that owns this computer, pid file or not. Checked BEFORE the
    // pid file is touched: this process's exit cleanup would otherwise erase the survivor's record.
    if ((opts.web || opts.lan) && (await portAnswers(port))) cannotStart(`port ${port} is already serving — another morse is running (morse stop first)`);
    // ADR-080 — Windows: the daemon holds daemon.lock for as long as it lives; that, not the pid, tells a running
    // daemon from a stale pid file there (pids are reused fast, a logoff kills without cleanup). A no-op elsewhere
    {
      const { holdDaemonLock } = await import('./platform/daemon-lock.js');
      if (holdDaemonLock(dataDir()) === 'busy') {
        console.error('daemon already running (another process holds daemon.lock in the data directory) — stop it first with morse stop');
        process.exit(1);
      }
    }
    writePid();
    // (ADR-081 review N1) what this daemon can do, for commands that must know before they hand mail over: a live
    // pid WITHOUT this file is a daemon of the release before
    const { writeDaemonInfo, clearDaemonInfo, DAEMON_CAPABILITIES } = await import('./daemon/capabilities.js');
    // ADR-087 (was ADR-080, for the stop request alone): the daemon token — what every route of the local API must be
    // given. Random per start; only a reader of the data directory has it. Written whether or not there is a
    // console: a command believes a daemon.json by it.
    const daemonToken = (await import('./daemon/local-api.js')).newToken();
    let requestStop: () => void = () => undefined;
    writeDaemonInfo({ pid: process.pid, port: opts.web || opts.lan ? port : null, capabilities: [...DAEMON_CAPABILITIES], token: daemonToken });
    process.on('exit', () => {
      clearDaemonInfo(process.pid);
      clearPid(process.pid);
    });

    const { ownAddressByName } = await import('./daemon/own-address.js');

    const recovered = mailbox.recoverStale();
    if (recovered > 0) console.log(`recovered ${recovered} message(s) stranded by a previous daemon run`);
    // macOS notifications of new cross-agent traffic (off with --no-notify)
    const notifier = (await import('./daemon/notify.js')).createNotifier({ enabled: opts.notify });

    console.log(`morse ${version} — daemon starting (poll ${opts.interval}ms)`);

    /** The local API and web console, once it is up (not with --no-web, unless the LAN is on). */
    let web: ReturnType<typeof import('./daemon/server.js').startConsoleServer> | undefined;
    // (declared before the LAN starts: the LAN asks which addresses to announce as soon as it is up)
    let morse: import('./cluster/morse.js').Morse | null = null;
    // (ADR-091) the LAN by address: the same sealed envelopes the relay carries, handed over directly to an address
    // seen on the network (mDNS `_morse._tcp`). The device-based LAN (mutual TLS against the trust list) is gone.
    let lanAddress: import('./cluster/lan-address.js').AddressLan | null = null;
    let lanInbound: (blob: string) => void = () => undefined;
    let lanSeq = 0;
    if (opts.lan) {
      const { startAddressLan } = await import('./cluster/lan-address.js');
      try {
        lanAddress = await startAddressLan({
          // (default: the port after the console's)
          port: numberOr(opts.peerPort, port + 1),
          // (only the first address is announced and proven; envelopes are opened before they are taken)
          address: () => morse?.status().v3?.address ?? null,
          sign: (address, message) => morse?.lanSign?.(address, message) ?? null,
          check: async (blob) => (morse?.lanCheck ? morse.lanCheck(blob) : { ok: false }),
          onEnvelope: (blob) => lanInbound(blob),
          log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
        });
        for (const spec of opts.peer ?? []) {
          const m = /^([^@]+)@([^:]+):(\d+)$/.exec(spec);
          if (m) lanAddress.addPeer(m[1]!, m[2]!, Number(m[3]));
          else console.error(`warning: --peer ${spec}: expected <address>@<host>:<port>`);
        }
        console.log(`lan: by address on :${lanAddress.port} (mDNS _morse._tcp, the first address only, proven before use; messages only — each confirmed by its receipt)`);
      } catch (e) {
        console.error(`warning: lan: off — ${e instanceof Error ? e.message : String(e)}`);
      }
    } else console.log('lan: off (to hand messages over on this network by address: morse.lan: true in config.json, or morse start --lan)');

    // Morse relay (cross-network, end-to-end encrypted): an address not reachable on the LAN goes through it.
    const relayUrl = opts.relay ?? readMachineConfig().relay?.url;
    if (relayUrl) {
      const { startMorse } = await import('./cluster/morse.js');
      const { listRegistered: registered } = await import('./registry/external.js');
      const { directSettings } = await import('./cluster/direct.js');
      // ADR-069: direct WebRTC links to contacts' devices (node-datachannel, optional), relay as fallback
      // (ADR-080 #33: on Windows too, since phase 5 — the same path as macOS / Linux)
      const direct = directSettings(readMachineConfig().morse);
      morse = startMorse({
        url: relayUrl,
        mailbox,
        direct,
        // (ADR-091) LAN first for a message to an address proven on the LAN (only when the LAN is on)
        ...(lanAddress ? { lanAddress } : {}),
        log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
        onChange: () => web?.notifyChange(),
        // morse.im/<me>/<agent> from our own devices: a registered agent of that name, else its mailbox.
        // ADR-048: no "most recent session of that agent" guess any more — that woke the wrong session.
        resolveAgent: async (agent) => registered().find((r) => r.agent === agent)?.sessionId ?? null,
      });
      if (lanAddress) {
        const m = morse;
        lanInbound = (blob) => void m.receive({ id: `lan-${++lanSeq}`, from: '', blob, ts: Date.now(), via: 'lan' }).catch((e: unknown) => console.log(`[${new Date().toISOString()}] lan: inbound failed: ${e instanceof Error ? e.message : String(e)}`));
        lanAddress.republish();
      }
      console.log(`relay: ${relayUrl} (end-to-end encrypted; the relay sees only who sends to whom and ciphertext, and keeps a sealed message for an offline recipient for at most 7 days)${lanAddress ? ' — LAN first on this network' : ''}`);
      if (direct) {
        const m = morse;
        void m.ready?.().then(() => console.log(`[${new Date().toISOString()}] ${describeDirectStatus(m.status().direct)}`));
      } else console.log('direct: off (morse.direct.enabled = false, or MORSE_DIRECT=0) — relay only');
    }
    /** ADR-039: a chunked file transfer in progress defers an update (and its restart). */
    const updateBusy = () => transferBusy(morse?.transfers() ?? [], listIncoming());
    /** ADR-089: …and an update waits (bounded) for agent turns that are being delivered — messages held under a live lease. */
    writeUpdateState({ waiting: undefined }); // (a wait an earlier run did not live to end)
    const updateQuiet = (await import('./update/delivery-wait.js')).createDeliveryWait({
      live: () => mailbox.liveLeases().length,
      log: (l) => console.log(`[${new Date().toISOString()}] ${l}`),
      onWait: (w) => void writeUpdateState({ waiting: w ?? undefined }),
    });
    /** (ADR-089 review F2) set by the updater: after the orderly stop below, have the service manager restart the daemon. */
    let restartWith: ServiceManager | null = null;
    const { getDeviceName: deviceName } = await import('./cluster/device.js');
    const selfDevice = morse ? deviceName() : undefined;
    /** Every message to someone else goes through Morse: the LAN by address first, a direct link, the relay (ADR-091). */
    const transport = async (device: string, message: Message): Promise<{ ok: boolean; error?: string; waiting?: boolean; terminal?: boolean; via?: string }> => {
      if (morse) return morse.send(device, message);
      return { ok: false, error: `${device} unreachable: no relay configured (morse address sets one up)` };
    };

    console.log(`directory: ${(await sessionDirectory.list()).length} sessions discovered`);

    const { isRegisteredSession, listRegistered } = await import('./registry/external.js');
    /**
     * ADR-025: a send is refused at once when its headless delivery would run a CLI older than the App that wrote
     * the target session — null: nothing against it. A session that takes its mail itself (watched by
     * `morse read --wait`, live in its App, an external agent) is never delivered through a CLI: nothing to check.
     */
    const preflight = await (async () => {
      const [{ isMonitored }, { isSessionLive }] = await Promise.all([import('./daemon/monitor.js'), import('./daemon/session-liveness.js')]);
      const deliverers = new Map(deliveryAdapters().map((adapter) => [adapter.agent, adapter]));
      const pullsItself = (id: string): boolean => isMonitored(id) || isSessionLive(id) || isRegisteredSession(id);
      return async (s: SessionInfo): Promise<string | null> => {
        // ADR-080: on Windows nothing is delivered through an agent CLI in this release — every session pulls its mail
        if (platformOff('plugins') || pullsItself(s.sessionId)) return null;
        return (await deliverers.get(s.agent)?.preflight?.(s)) ?? null;
      };
    })();
    if (opts.web || opts.lan) {
      web = (await import('./daemon/server.js')).startConsoleServer({
        port, mailbox, preflight,
        directory: sessionDirectory.list,
        invalidateDirectory: sessionDirectory.invalidate,
        token: daemonToken,
        shutdown: { run: () => requestStop() },
        updateStatus: () => {
          const r = readInstalledRelease();
          return { busy: updateBusy(), release: r.release, version: r.version };
        },
        ...(morse
          ? {
              // (ADR-091, stage 2: no device or old name is known to the transport any more — `knowsDevice` and
              // `pairPerson` are gone, and the local API says "old names no longer work")
              // ADR-081: a bare address (or mail from another address of this computer) goes by address alone
              addressRoute: (target: string, from?: string | null) => morse!.addressRoute?.(target, from) ?? Promise.resolve(null),
              // (ADR-081 review: legacy rows) `--from <name>` is recorded as the address it stands for, when it is queued
              // (ADR-088 §1) …by its current name too, and the name said back is the current one (the transport goes by
              // the directory's)
              ownAddress: ownAddressByName((from) => morse!.ownAddress?.(from) ?? null),
              reloadAddresses: () => {
                const r = morse!.reloadAddresses?.() ?? { added: [], removed: [] };
                // (ADR-091) the LAN announces the addresses this computer hosts now
                if (r.added.length || r.removed.length) lanAddress?.republish();
                return r;
              },
              acceptAddress: (address: string, from?: string | null) => morse!.acceptAddress?.(address, from) ?? null,
              notifyAccepted: (handle: string, deviceId: string, myAddress?: string) => {
                const self = loadOrCreateIdentity().id;
                if (deviceId !== self) throw new Error('not this device (another HOME?) — nothing done');
                return morse!.notifyAccepted(handle, myAddress);
              },
              // ADR-038: up to morse.maxFileBytes (default 100 MB); bigger than one envelope → chunks
              stageFiles: (paths: string[]) => stageOutboxFiles(paths, undefined, fileLimitsFrom(readMachineConfig().morse).maxFileBytes),
              chunksFor: (files: MessageFile[], text: string) => {
                const maxBlob = morse!.status().limits.maxBlobBytes;
                const total = files.reduce((n, f) => n + f.size, 0);
                if (total + Buffer.byteLength(text) + 4096 <= maxAttachmentBytes(maxBlob)) return 0;
                const cs = chunkSizeFor(maxBlob);
                return files.reduce((n, f) => n + Math.max(1, Math.ceil(f.size / cs)), 0);
              },
              transferStatus: (id: string) => morse!.transfer(id) ?? null,
            }
          : {}),
        ...(morse
          ? {
              peering: {
                selfDevice: selfDevice!,
                selfId: loadOrCreateIdentity().id,
                trust: createTrustStore(),
                relay: () => morse?.status() ?? null,
              },
            }
          : {}),
      });
      console.log(`local API on 127.0.0.1:${web.port} (this home's morse command only) — web console: morse console`);
    }

    const { createRepeatFilter, rotateLogIfLarge } = await import('./daemon/log-hygiene.js');
    const repeats = createRepeatFilter();
    // ADR-046: daemon.log (launchd's StandardOutPath, or `>>` by hand) is rotated at 5 MB, 3 kept
    const logFile = join((await import('./home.js')).dataDir(), 'daemon.log');
    const rotate = () => {
      if (rotateLogIfLarge({ path: logFile })) console.log(`[${new Date().toISOString()}] log: rotated ${logFile} (older lines in daemon.log.1 … .3)`);
    };
    rotate();
    setInterval(rotate, 60_000).unref();
    const { VERSION_MISMATCH } = await import('./adapters/version-guard.js');
    /**
     * Each delivery event: a log line (ADR-046: the same 'waiting' / 'failed' for the same target only at growing
     * intervals), the console told; the operator is notified of a CLI too old to deliver with, and of mail that
     * reached one of the sessions here.
     */
    const onDispatch = (event: import('./daemon/dispatcher.js').DispatchEvent): void => {
      const { kind, detail, message: m } = event;
      const to = `@${m.to.device ?? 'local'}/${m.to.agent}`;
      const target = `${to}:${m.to.sessionId}`;
      const line = `[${new Date().toISOString()}] ${kind} ${m.id.slice(0, 8)} @${m.from.agent} → ${to}${detail ? ` — ${detail}` : ''}`;
      if (kind === 'delivered') repeats.forget(`${target}\0`);
      const shown = kind === 'waiting' || kind === 'failed' ? repeats.pass(`${target}\0${kind}\0${detail ?? ''}`, line) : line;
      if (shown) console.log(shown);
      web?.notifyChange();
      if (kind === 'failed' && detail?.startsWith(VERSION_MISMATCH)) notifier.versionMismatch(m.to.agent, detail);
      else if (kind === 'delivered' && !m.to.device) notifier.sessionActivity(m.to.agent, sessionDirectory.titleOf(m.to.sessionId) ?? m.to.sessionId.slice(0, 8), m.to.sessionId, 'received');
    };
    // ADR-052: the core delivers OUTBOUND only (other devices, people, the human's inbox);
    // it never runs an agent. Own-agent mail for a session here is the dispatch plugin's.
    const delivery = { mailbox, pullOnlySessions: ['inbox'], ...(selfDevice ? { selfDevice, relay: transport } : {}), onEvent: onDispatch };
    const running = (await import('./daemon/dispatcher.js')).startDispatcher(delivery, { intervalMs: numberOr(opts.interval, 1000) });

    // ADR-024: an external agent pulls its mail — no 'delivered' event, so nothing above fires for it — and a desktop
    // App such as 闪电说 does nothing until its user speaks. A notification is the operator's only sign that a reply
    // waits there. (The dispatch plugin's own profile addresses, @dispatch:<profile>, are not pull-only: it runs them, ADR-056.)
    const externalNotifier = (await import('./daemon/external-notify.js')).startExternalInboxNotifier({
      mailbox, notifier,
      listRegistered: () => listRegistered().filter((s) => s.agent !== 'dispatch'),
      onNotify: (session, messageId) => console.log(`[${new Date().toISOString()}] external-inbox ${messageId.slice(0, 8)} waiting for @${session.agent}:${session.title} — notified`),
    });

    // ADR-051: the on_message plugin hook — beside delivery, never in its path
    const { startOnMessageHook } = await import('./plugin/on-message.js');
    const onMessage = startOnMessageHook({
      mailbox,
      config: () => {
        const h = readMachineConfig().hooks?.on_message;
        return h && typeof h.command === 'string' && h.command.trim() ? { command: h.command, ...(typeof h.timeoutSec === 'number' && h.timeoutSec > 0 ? { timeoutSec: h.timeoutSec } : {}) } : null;
      },
      cursorFile: join((await import('./home.js')).dataDir(), 'on-message.cursor'),
      log: (l) => console.log(`[${new Date().toISOString()}] ${l}`),
    });

    // ADR-052: plugins — the daemon supervises them; the built-in `dispatch` runs your own agents
    const { startPluginManager, pluginSpecs } = await import('./plugin/manager.js');
    const plugins = startPluginManager({
      // ADR-080: no plugin runs on Windows in this release (said in the log below and by `morse status`)
      specs: () => (platformOff('plugins') ? [] : pluginSpecs(readMachineConfig().plugins, builtinPlugins())),
      env: { MORSE_CMD_JSON: JSON.stringify(selfArgv()), ...(opts.notify ? {} : { MORSE_NOTIFY: '0' }) },
      statusFile: join((await import('./home.js')).dataDir(), 'plugin-status.json'),
      log: (l) => console.log(`[${new Date().toISOString()}] ${l}`),
    });

    if (platformOff('plugins')) console.log(`windows: ${offLine('plugins')}`);

    // ADR-039: auto-update from the site — signed releases only, never during a file transfer
    const updater = await startDaemonUpdater(updateBusy, updateQuiet, (sm) => {
      restartWith = sm;
      requestStop();
    });

    // The orderly stop (ADR-089, reviews F1 and N5; src/daemon/shutdown.ts): once; under a hard deadline armed
    // first thing (a step that throws, a plugin that never comes back: the process exits non-zero and the
    // service manager starts it again); plugins get 15 s to let a running agent turn finish.
    const { createShutdown } = await import('./daemon/shutdown.js');
    const stopper = createShutdown({
      steps: [() => console.log('morse daemon stopping'), () => running.stop(), () => externalNotifier.stop(), () => onMessage.stop(), () => updater?.stop(), () => morse?.stop(), () => web?.close()],
      // mDNS goodbye first, so other devices drop this one at once (no ghost entry)
      wait: () => Promise.all([Promise.resolve(lanAddress?.stop()), plugins.stop()]),
      after: () => {
        if (!restartWith) return false;
        // an update: nothing is running any more — now the service manager restarts us (its signal ends this
        // process at once: a stop request after everything has stopped just exits); should it not, exit and
        // let KeepAlive / Restart= start the new code
        spawnRestart(restartWith);
        setTimeout(() => process.exit(0), 5000);
        return true;
      },
      exit: (code) => process.exit(code),
      log: (l) => console.log(`[${new Date().toISOString()}] ${l}`),
    });
    const shutdown = () => stopper.request();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
    // ADR-080: the same orderly stop without a signal (POST /api/shutdown — Windows has no SIGTERM)
    requestStop = shutdown;
    // from here on the daemon only reacts — until the orderly stop ends the process
    await new Promise<never>(() => undefined);
  });

/** Ask a process to stop the polite way (the daemon's SIGTERM runs the orderly stop); false: there is no such process. */
const askToStop = (pid: number): boolean => {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
};

program.command('stop', hidden)
  .description('Stop the morse daemon')
  .option('--restart', 'restart it instead: a message being handled may finish first, then launchd / systemd starts it again (a daemon started by hand is only stopped)')
  .action(async (opts: { restart?: boolean }) => {
    const { readPid, clearPid, isAlive, isMorseDaemon } = await import('./daemon/pidfile.js');
    /** (ADR-089) said after a daemon that no service manager runs was stopped by --restart */
    const byHand = () => console.log(`the daemon was started by hand — nobody starts it again for you: ${isWindows() ? 'morse start --background' : 'morse start'}`);
    if (opts.restart && !isWindows()) {
      const r = await restartThroughServiceManager();
      if (r === 'restarted' || r === 'started') return;
      if (r === 'not-running') {
        console.log('daemon not running — start it: morse start');
        return;
      }
    }
    let pid: number | null = readPid();
    if (pid && isAlive(pid) && isMorseDaemon(pid) === 'no') {
      // (ADR-083 review N3) the pid file is a left-over: its pid is another program's by now — not ours to signal
      clearPid(pid);
      console.log(`daemon not running (the pid file named pid ${pid}, which is another program now — removed the stale pid file)`);
      return;
    }
    if (isWindows()) {
      // ADR-080: no signals on Windows (SIGTERM kills at once) — ask the daemon, wait, then end the process tree
      const { readDaemonInfo, clearDaemonInfo } = await import('./daemon/capabilities.js');
      const { stopWithoutSignals } = await import('./daemon/stop.js');
      const { killTree } = await import('./platform/process.js');
      const outcome = await stopWithoutSignals({
        readPid,
        isAlive,
        clearPid: () => {
          const p = readPid();
          clearPid();
          if (p !== null) clearDaemonInfo(p);
        },
        readInfo: readDaemonInfo,
        killTree: (p) => killTree(p),
        log: (l) => console.log(l),
      });
      if (outcome === 'failed') process.exitCode = 1;
      else if (opts.restart) byHand();
      return;
    }
    if (!pid) {
      // pid file lost (crashed starter, manual delete). ADR-087 follow-up 3: the daemon is never looked for BY NAME —
      // `pgrep "morse start"` finds the daemon of any Morse home, and this command would have stopped it. Only the
      // process this home's own daemon.json names counts, and only while it is a live Morse daemon; when that
      // cannot be said for sure, nothing is touched.
      const { readDaemonInfo } = await import('./daemon/capabilities.js');
      const info = readDaemonInfo();
      if (!info || !isAlive(info.pid) || isMorseDaemon(info.pid) !== 'yes') return console.log('daemon not running (no pid file)');
      pid = info.pid;
      console.log(`pid file missing — this home's daemon.json names the daemon (pid ${pid})`);
    }
    console.log(askToStop(pid) ? `sent SIGTERM to daemon (pid ${pid})` : `daemon pid ${pid} not alive — cleaning pid file`);
    clearPid();
    if (opts.restart) byHand();
  });
program
  .command('console', hidden)
  .description("Open the web console of this home's daemon: prints a link that works once, for a minute (ADR-087)")
  .option('--port <port>', "daemon console port (this home's daemon's — any other port is refused; kept for older scripts)")
  .action(async (opts: { port?: string }) => {
    const { localApi, explicitPort, daemonOfThisHome, NoDaemonForThisHome, NO_DAEMON_LINE, notThisHomesDaemonLine } = await import('./daemon/local-api.js');
    const port = explicitPort(opts.port) ?? daemonOfThisHome()?.port ?? null;
    try {
      const res = await localApi('/api/console/code', { method: 'POST', port: port ?? undefined });
      const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
      if (!res.ok || !body?.code) {
        console.error(`error: ${res.status === 404 ? 'the running daemon has no web console sign-in (an older release) — restart it: morse stop --restart' : (body?.error ?? `daemon returned ${res.status}`)}`);
        process.exit(1);
      }
      // the code travels in the fragment: it is not sent to any server, and the page removes it from the address bar
      console.log(`http://127.0.0.1:${port}/console#code=${body.code}`);
      console.log('open it in a browser on this computer within a minute — the link works once');
    } catch (e) {
      console.error(`error: ${e instanceof NoDaemonForThisHome && e.why === 'other' && e.port !== null ? notThisHomesDaemonLine(e.port) : NO_DAEMON_LINE}`);
      process.exit(1);
    }
  });
program.command('status', hidden)
  .description('Daemon, relay, mailbox and update state; --check also checks the environment is ready for Morse (was morse doctor)')
  .option('--port <port>', "daemon console port (this home's daemon's — any other port is refused; kept for older scripts)")
  .option('--check', 'also check the environment: agent CLIs, session folders, hooks (exit code 1 if something is missing)')
  .action(async (opts: { port?: string; check?: boolean }) => {
    const { runningDaemonPid } = await import('./daemon/pidfile.js');
    const pid = runningDaemonPid();
    const running = pid !== null;
    console.log(running ? `daemon: running (pid ${pid})` : 'daemon: not running');
    try {
      // ADR-077: where the identity v3 contact migration stands on this computer
      const contacts = openMailbox().contacts;
      const backup = contacts.mark('p2.backup');
      const waiting = contacts.pendingSplits().length;
      console.log(`contacts: one per address${waiting ? ` — ${waiting} still to check with the relay` : ' — migration complete'}${backup ? `; backup ${backup}` : ''}`);
      // (ADR-083) each address of this computer has its own contacts, message requests and blocks
      const perAddress = contacts.mark('p4.backup');
      console.log(`contacts: kept per address of yours — each address has its own contacts, message requests and blocks${perAddress ? `; backup ${perAddress}` : ''}`);
      // (ADR-091) every contact by its address; who still needs a new one
      const needs = contacts.list().filter((c) => c.id !== 'self' && c.handle && !c.address).length;
      const byAddress = contacts.mark('p5.backup');
      console.log(`contacts: reached by address — ${needs ? `${needs} still need their new address (morse contact)` : 'every one'}${byAddress ? `; backup ${byAddress}` : ''}`);
      // internal, for debugging (it left `morse address`, ADR-077 J)
      console.log(`device: ${loadOrCreateIdentity().id}`);
    } catch {
      /* no mailbox yet */
    }
    if (running) {
      // ADR-043: relay state, when it last connected, how long it has been down
      const { localApi, explicitPort } = await import('./daemon/local-api.js');
      const peers = await localApi('/api/peers', { port: explicitPort(opts.port), timeoutMs: 3000 })
        .then((r) => (r.ok ? (r.json() as Promise<{ relay?: (RelayStatusView & { direct?: DirectStatusView }) | null }>) : null))
        .catch(() => null);
      console.log(peers ? describeRelayStatus(peers.relay ?? null) : 'relay: unknown (the daemon did not answer on its console port)');
      // ADR-069: direct links to contacts (WebRTC), relay as fallback
      if (peers?.relay) console.log(describeDirectStatus(peers.relay.direct));
    }
    // every message by state, in the order the states first occur
    const all = openMailbox().inbox({ all: true });
    const perState = new Map<string, number>();
    for (const { status } of all) perState.set(status, (perState.get(status) ?? 0) + 1);
    const breakdown = Array.from(perState, ([status, n]) => `${status}: ${n}`).join(', ');
    console.log(all.length ? `mailbox: ${all.length} messages — ${breakdown}` : 'mailbox: 0 messages');
    // ADR-039
    const r = readInstalledRelease();
    console.log(`release: ${describeRelease(r)}${r.builtAt ? `, built ${r.builtAt}` : ''}`);
    // ADR-084: a hint only on Node < 22 — never a refusal, no exit code change
    const nodeLine = nodeStatusLine();
    if (nodeLine) console.log(nodeLine);
    const st = readUpdateState();
    const auto = readMachineConfig().update?.auto !== false && !platformOff('update');
    const when = (t?: number) => (t ? `${new Date(t).toISOString()} (${formatRelativeTime(t)})` : 'never');
    console.log(`update: auto ${platformOff('update') ? 'off on Windows in this release' : !r.release ? 'off (development build)' : auto ? 'on' : 'off (update.auto: false)'} · site ${updateSite(readMachineConfig())}`);
    console.log(
      `  last check: ${when(st.lastCheckAt)}${st.result ? ` — ${st.result}${st.detail && st.detail !== st.result ? `: ${st.detail}` : ''}` : ''}${st.latest ? ` (latest release ${st.latest.release}, ${st.latest.version})` : ''}`,
    );
    if (running && auto && r.release && st.nextCheckAt && st.nextCheckAt > Date.now()) console.log(`  next check: ${new Date(st.nextCheckAt).toISOString()}`);
    // ADR-089: an update that is holding back for an agent turn says so here, not only in the daemon log
    const waitingLine = running ? (await import('./update/delivery-wait.js')).updateWaitingLine(st.waiting) : null;
    if (waitingLine) console.log(waitingLine);
    if (st.installed) console.log(`  last auto-install: release ${st.installed.release} at ${when(st.installed.at)}`);
    if (RELEASE_PUBLIC_KEY !== RELEASE_KEY_PLACEHOLDER) {
      const k = currentTrustedKey({ publicKey: RELEASE_PUBLIC_KEY, generation: RELEASE_KEY_GENERATION }, trustedKeyFile());
      console.log(`  release key: ${keyIdOf(k.publicKey)} (generation ${k.generation}, ${k.source === 'pinned' ? 'pinned in this build' : 'followed a signed key rotation'})`);
    }
    if (isWindows()) {
      // ADR-080: how the daemon starts at logon, and what is off on Windows in this release — said, not left to be found out
      const { windowsStatusLines } = await import('./platform/status.js');
      for (const l of windowsStatusLines()) console.log(l);
    }
    if (opts.check) {
      console.log('');
      await runChecks();
    }
  });
program
  .command('update', hidden)
  .description('Check https://morse.im for a newer signed release and install it now (ADR-039)')
  .option('--check', 'only report whether a newer release exists')
  .option('--force', 'install even while a file transfer is in progress')
  .option('--port <port>', "daemon console port (this home's daemon's — any other port is refused; kept for older scripts)")
  .action(async (opts: { check?: boolean; force?: boolean; port?: string }) => {
    const installed = readInstalledRelease();
    const site = updateSite(readMachineConfig());
    console.log(`installed: ${describeRelease(installed)}${installed.builtAt ? `, built ${installed.builtAt}` : ''}`);
    const c = await checkLatest({ site, ...releaseKeyDeps(), installedRelease: () => installed.release });
    const at = Date.now();
    if (c.kind !== 'error' && c.rotated) console.log(describeRotation(c.rotated));
    if (c.kind === 'error') {
      writeUpdateState({ lastCheckAt: at, result: 'error', detail: c.error });
      console.error(`✗ ${c.error}`);
      process.exitCode = 1;
      return;
    }
    if (c.kind === 'up-to-date') {
      writeUpdateState({ lastCheckAt: at, result: 'up-to-date', detail: c.detail, failures: 0, ...(c.latest ? { latest: { version: c.latest.version, release: c.latest.release } } : {}) });
      console.log(`latest:    ${c.latest ? describeRelease(c.latest) : '(unknown)'} — ${c.detail}`);
      return;
    }
    const m = c.manifest;
    const latest = { version: m.version, release: m.release };
    writeUpdateState({ lastCheckAt: at, result: 'available', detail: `release ${m.release} available`, latest });
    console.log(`latest:    ${describeRelease(m)}, built ${m.builtAt} — signature verified (${site}/version.json)`);
    if (opts.check) {
      console.log('a newer release is available — install it: morse update');
      return;
    }
    if (platformOff('update')) {
      // ADR-080 (phase 3): on Windows the running daemon holds the native modules npm would replace
      console.error(`✗ installing an update from here is not available on Windows in this release (ADR-080) — run the installer again: ${WINDOWS_INSTALL_COMMAND}`);
      process.exitCode = 1;
      return;
    }
    const { runningDaemonPid } = await import('./daemon/pidfile.js');
    const pid = runningDaemonPid();
    const daemonUp = pid !== null;
    if (daemonUp && !opts.force) {
      const { localApi, explicitPort } = await import('./daemon/local-api.js');
      const busy = await localApi('/api/update', { port: explicitPort(opts.port), timeoutMs: 3000 })
        .then((r) => (r.ok ? (r.json() as Promise<{ busy?: string | null }>) : null))
        .then((b) => b?.busy ?? null)
        .catch(() => null);
      if (busy) {
        console.error(`✗ ${busy} — try again when it is done, or: morse update --force`);
        process.exitCode = 1;
        return;
      }
    }
    console.log(`downloading ${site}/${m.file} (${m.size} bytes) …`);
    const r = await downloadAndInstall({ site, ...releaseKeyDeps(), installedRelease: () => installed.release, install: npmInstaller({ log: (l) => console.log(l) }) }, m);
    if (!r.ok) {
      writeUpdateState({ lastCheckAt: at, result: 'error', detail: r.error, latest });
      console.error(`✗ ${r.error}`);
      process.exitCode = 1;
      return;
    }
    writeUpdateState({ result: 'installed', detail: `installed release ${m.release}`, failures: 0, latest, installed: { ...latest, at: Date.now() } });
    console.log(`✓ installed ${describeRelease(m)} — sha256 and signature verified`);
    // the skill + hooks of the new version, as install.sh does
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, [join(installed.root, 'dist', 'cli.js'), 'setup'], { stdio: 'inherit' });
    if (!daemonUp) {
      console.log('daemon: not running — start it: morse start');
      return;
    }
    const sm = await ofThisHome(await detectServiceManager(pid));
    if (sm) {
      // (ADR-089 review F2) the daemon stops in its own orderly way first (a running agent turn gets its time)
      console.log(`daemon: restarting through ${sm.kind} — waiting for it to stop first (a message being handled may finish) …`);
      const how = await restartGracefully(sm, pid);
      console.log(how === 'graceful' ? 'daemon: restarted' : `daemon: it did not stop in time — restarted the hard way (${restartCommand(sm).flat().join(' ')})`);
    } else {
      console.log('daemon: running by hand — restart it to apply: morse stop --restart');
    }
  });
// `morse hook <kind>`: the UserPromptSubmit hooks `morse setup` registers with Claude Code and Codex
const hookCmd = program.command('hook', hidden).description('Hook processors wired into agent CLIs (internal)');
hookCmd.argument('<kind>', 'hook kind: claude-prompt-submit | codex-prompt-submit').action(async (kind: string) => (await import('./cli/hook-command.js')).runHookCommand(kind, openMailbox));
/**
 * `morse address` (ADR-074; was `morse relay show`; output ADR-077 J): the address(es) this
 * computer hosts with their local names, the old name that still reaches you, and the relay.
 * No device ID (that is in `morse status`), nothing about other computers. A computer with no address yet gets one first, exactly as plain
 * `morse join` does (ADR-074, 2026-11-14): the configured relay (else the default), this
 * computer's default agent name.
 */
async function showAddress(): Promise<void> {
  if (!(await hasAddress())) await createAddress();
  const relay = readMachineConfig().relay;
  // ADR-077 (J): the address(es) this computer hosts — the first one's key is the computer's own;
  // every agent added later has a key of its own. Nothing about other computers (they are contacts).
  const { ensureAgentAddresses } = await import('./identity/agent-addresses.js');
  const { loadPrimaryAddress } = await import('./identity/address-key.js');
  let mine: Array<{ name: string | null; address: string }> = [];
  try {
    // (ADR-088) the name is the one you gave the address, else the one the directory has for it
    const { namesOfHome } = await import('./identity/address-labels.js');
    const hosted = ensureAgentAddresses();
    const called = Object.entries(namesOfHome().byName);
    mine = hosted.map((a) => ({ name: called.find(([, address]) => address === a.key.address)?.[0] ?? null, address: a.key.address }));
    // (ADR-088 §3) one address: it needs no name, and none is shown — names appear when there are several to tell apart
    if (mine.length === 1) mine = [{ name: null, address: mine[0]!.address }];
  } catch (e) {
    console.error(`warning: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!mine.length) mine = [{ name: null, address: loadPrimaryAddress().address }];
  const width = `morse.im/${mine[0]!.address}`.length;
  // (ADR-088 §4) with several addresses: the one MORSE_ADDRESS selects for this session is marked — the one this
  // session speaks of as "my address". Naming none of them is said (this command lists them; it does not fail).
  let selected: string | null = null;
  if (mine.length > 1) {
    const { addressFromEnv } = await import('./commands/known-as.js');
    const env = addressFromEnv();
    if (env && 'error' in env) console.error(`warning: ${env.error}`);
    else if (env) selected = env.address;
  }
  mine.forEach((a, i) => console.log(`${i === 0 ? 'address: ' : '         '}${`morse.im/${a.address}`.padEnd(width)}${a.name ? `   ${a.name}` : ''}${a.address === selected ? '   ← this session (MORSE_ADDRESS)' : ''}`));
  // (ADR-091) the address above is the one to hand out — old names no longer reach anyone
  console.log(`relay:   ${relay?.url ?? '(none)'}`);
}
/** (ADR-091) Does this computer have an address yet — a key and its entry in the list of addresses here? */
async function hasAddress(): Promise<boolean> {
  const { localAgents } = await import('./cluster/agents.js');
  return localAgents().agents.length > 0;
}
/**
 * The first address of this computer (ADR-091): made HERE — the key is generated, the address is computed from it,
 * the relay is written into ~/.morse/config.json (the configured one, else the default). Nothing is registered: no
 * old name, no request to the relay (the address is announced when the daemon connects). Exits 1 when it fails.
 */
async function createAddress(opts: { name?: string; relay?: string } = {}): Promise<void> {
  const { defaultAgentName, localAgents, saveLocalAgents } = await import('./cluster/agents.js');
  const { getDeviceName } = await import('./cluster/device.js');
  const url = opts.relay ?? readMachineConfig().relay?.url ?? DEFAULT_RELAY_URL;
  try {
    if (!/^wss?:\/\//.test(url)) throw new Error(`relay URL must start with ws:// or wss:// (${url})`);
    if (localAgents().agents.length) return;
    const { normalizeAgentName } = await import('./cluster/agents.js');
    // (the name the list of addresses keeps for it: never shown while it is the only address — ADR-088 §3)
    const name = (opts.name && normalizeAgentName(opts.name) === opts.name ? opts.name : null) ?? localAgents().primary ?? defaultAgentName(getDeviceName());
    loadOrCreateIdentity();
    const { updateMachineConfig } = await import('./machine-config.js');
    updateMachineConfig((cfg) => {
      const prev = (cfg['relay'] && typeof cfg['relay'] === 'object' ? cfg['relay'] : {}) as Record<string, unknown>;
      cfg['relay'] = { ...prev, url };
    });
    saveLocalAgents({ primary: name, agents: [name] });
    const { ensureAgentAddresses } = await import('./identity/agent-addresses.js');
    ensureAgentAddresses();
    // ADR-081: the 26-character address is the one to share (anyone can add it and write to it)
    const { loadPrimaryAddress } = await import('./identity/address-key.js');
    console.log(`created: your address is morse.im/${loadPrimaryAddress().address} — send it to your friends; next: morse start`);
  } catch (e) {
    console.error(`error: could not create your address — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
const addressCmd = program
  .command('address')
  .description('Your address (lists them when there are several); add, set, remove')
  .action(() => showAddress());
/** One of the addresses here — by its name, its old name or the address itself (26 characters, with or without morse.im/). Exits 1 otherwise. */
const addressHere = async (who: string): Promise<{ address: string; name: string | null; directory: string }> => {
  const { normalizeAddress } = await import('./identity/address.js');
  const { addressNamed, namesOfHome } = await import('./identity/address-labels.js');
  try {
    const names = namesOfHome();
    const bare = normalizeAddress(who);
    const address = addressNamed(names, who) ?? (bare && names.addresses.includes(bare) ? bare : undefined);
    if (!address) throw new Error(`"${who}" is not one of your addresses here — morse address lists them`);
    const of = (m: Record<string, string>) => Object.entries(m).find(([, a]) => a === address)?.[0];
    return { address, name: of(names.byName) ?? null, directory: of(names.directory)! };
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
};
/** (ADR-087 §6 of ADR-088) Tell this home's daemon that the addresses changed — true = it took them on; false = restart it. */
const reloadAddresses = async (): Promise<boolean> => {
  try {
    const { localApi } = await import('./daemon/local-api.js');
    return (await localApi('/api/addresses/reload', { method: 'POST', timeoutMs: 15_000 })).ok;
  } catch {
    return false; // no daemon running for this home (it reads the addresses when it starts), or one of a release before
  }
};
/**
 * (ADR-088 §7) A name is on ONE side: a new name for an address of mine may not be a contact's remark (any case).
 * Only new naming is checked — names that already collide stay as they are.
 */
const refuseContactRemark = async (name: string): Promise<void> => {
  const { nameAsKept, sameName } = await import('./name-key.js');
  const taken = openMailbox()
    .contacts.list()
    .some((c) => c.remark && sameName(c.remark, name));
  if (taken) throw new Error(`"${nameAsKept(name)}" is already the remark of one of your contacts — pick another name`);
};
addressCmd
  .command('add')
  .description('Create another address here, with its own key (optionally with your name for it — see set)')
  .argument('[name]', 'your name for it, e.g. work')
  .action(async (name: string | undefined) => {
    const { normalizeAgentName } = await import('./cluster/agents.js');
    const { addressNamed, checkAddressName, namesOfHome, setAddressLabel } = await import('./identity/address-labels.js');
    /** the name the directory keeps for it: the name given when it can be one, else one that is made up (never shown) */
    let directory: string;
    let label: string | null = null;
    let fresh = true;
    try {
      const names = namesOfHome();
      const madeUp = (): string => {
        for (let n = names.addresses.length + 1; ; n++) if (!names.directory[`address-${n}`] && !addressNamed(names, `address-${n}`)) return `address-${n}`;
      };
      if (name === undefined || !name.trim()) directory = madeUp();
      else {
        label = checkAddressName(name);
        const has = addressNamed(names, label);
        // the address that is called this already: said as it always was ("already there"), nothing is named anew
        if (has && names.byName[label] === has && names.directory[label] === has) fresh = false;
        else if (has) throw new Error(`the name "${label}" is already used for another address`);
        if (fresh) await refuseContactRemark(label);
        directory = !fresh || (normalizeAgentName(label) === label && !names.directory[label]) ? label : madeUp();
      }
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    // the name is written before anything is said (and before the daemon takes the address on)
    const named = (address: string): void => {
      if (fresh && label !== directory) setAddressLabel(address, label ?? '');
    };
    return agentAction('add', directory, undefined, 'address', label, named);
  });
/** `morse address set [which] --name <name>` (and the hidden `rename <which> <new name>`): my name for one of my addresses. */
const nameAddress = async (which: string | undefined, name: string | undefined): Promise<void> => {
  try {
    const { namesOfHome, setAddressLabel } = await import('./identity/address-labels.js');
    if (name === undefined) throw new Error('nothing to change — give --name');
    // (an address that was never listed yet has no entry: listing is what records it)
    (await import('./identity/agent-addresses.js')).ensureAgentAddresses();
    const names = namesOfHome();
    if (which === undefined && names.addresses.length > 1) throw new Error('give one of your addresses (its name, or the address) — morse address lists them');
    if (which === undefined && !names.addresses.length) throw new Error('there is no address here yet — morse address');
    const it = which === undefined ? { address: names.addresses[0]!, name: Object.entries(names.byName).find(([, a]) => a === names.addresses[0])?.[0] ?? null } : await addressHere(which);
    // (ADR-088 §7) only a NEW name is checked against the contacts' remarks
    const { sameName } = await import('./name-key.js');
    if (name.trim() && !(it.name && sameName(name, it.name))) await refuseContactRemark(name);
    // (ADR-088 §1) a local label: nothing is asked of the relay, so no link anybody holds stops working
    const r = setAddressLabel(it.address, name);
    // an empty (or blank) name clears it, as it does a contact's remark — said, so that it is not taken for a typo
    console.log(`address: morse.im/${it.address}${r.to ? `   ${r.to}` : r.from ? '   (name cleared — it is shown by its address)' : '   (it has no name)'}`);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
};
addressCmd
  .command('set')
  .description('Change your name for one of your addresses (the address itself does not change, and whoever has it keeps reaching it)')
  .argument('[which]', 'its name, or the address (leave out when there is only one)')
  .option('--name <name>', 'new name ("" clears it)')
  .action((which: string | undefined, opts: { name?: string }) => nameAddress(which, opts.name));
addressCmd
  .command('rename', hidden)
  .description('(alias) morse address set <which> --name <new name>')
  .argument('<which>', 'its name, or the address')
  .argument('<new name>')
  .action((which: string, to: string) => nameAddress(which, to));
/**
 * ADR-077 (N6): the first address uses this install's own key — the daemon always logs it in, so it cannot be
 * "removed"; taking it out of the list would leave an address in use that is listed nowhere. Exits 1 when
 * `directory` (the name the directory has for it) is that one (ADR-081 §9: the hidden `morse agent remove`
 * refuses the same way).
 */
const refuseFirstAddress = async (directory: string, shown: string = directory): Promise<void> => {
  const { ensureAgentAddresses } = await import('./identity/agent-addresses.js');
  let first: string | null = null;
  let only = false;
  try {
    const mine = ensureAgentAddresses();
    first = mine.find((a) => a.primary)?.agent ?? null;
    only = mine.length === 1;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (first !== null && directory.trim().toLowerCase() === first) {
    // (ADR-088 §3) with one address there is no name to say — and nothing else to remove
    if (only) console.error("error: this is your only address here (it uses this install's own key) — it cannot be removed");
    else console.error(`error: ${shown} is the first address here (it uses this install's own key) — it cannot be removed; remove the others, or rename it: morse address set ${/\s/.test(shown) ? JSON.stringify(shown) : shown} --name <new name>`);
    process.exit(1);
  }
};
addressCmd
  .command('remove')
  .description('Remove one of your addresses here (it stops receiving; its key stays on disk)')
  .argument('<which>', 'its name, or the address')
  .action(async (which: string) => {
    const it = await addressHere(which);
    const shown = it.name ?? `morse.im/${it.address}`;
    await refuseFirstAddress(it.directory, shown);
    await agentAction('remove', it.directory, undefined, 'address', shown);
    (await import('./identity/address-labels.js')).dropAddressLabel(it.address);
  });
// (ADR-091, stage 2) the hidden `morse agent …` / `agents` (the relay's directory of old names) are gone: `morse address`.
/** Run one signed agent-directory request, print the result, keep the local cache in step. */
const agentAction = async (op: 'add' | 'remove' | 'default' | 'rename' | 'list', agent?: string, to?: string, style: 'agent' | 'address' = 'agent', /** (ADR-088) the name the user knows it by, when that is not the directory's (null = it has none) */ shown?: string | null, /** (ADR-088) an address was added: before anything is said */ added?: (address: string) => void): Promise<void> => {
  const { agentRequest, applyToLocal, localAgents } = await import('./cluster/agents.js');
  const { ensureAgentAddresses, renameAgentAddress } = await import('./identity/agent-addresses.js');
  /** ADR-077: every agent of this computer has an address; never fails the command. */
  const agentAddresses = () => {
    try {
      return ensureAgentAddresses();
    } catch (e) {
      console.error(`warning: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };
  const relay = readMachineConfig().relay;
  // (ADR-091) `morse address add | remove` change this computer only: a key, the list of its addresses — nothing is
  // asked of the relay (there is no directory of names any more). The hidden `morse agent …` still asks it (v2).
  const local = style === 'address' && (op === 'add' || op === 'remove');
  if (local ? !localAgents().agents.length : !relay?.url) {
    console.error('error: there is no address here yet — morse address');
    process.exit(1);
  }
  try {
    const r = local ? ({ agent, ...(op === 'add' && agent && localAgents().agents.includes(agent) ? { already: true } : {}) } as Awaited<ReturnType<typeof agentRequest>>) : await agentRequest({ url: relay!.url!, op, ...(agent !== undefined ? { agent } : {}), ...(to !== undefined ? { to } : {}) });
    applyToLocal(op, r);
    try {
      if (op === 'rename' && r.agent && r.from) renameAgentAddress(r.from, r.agent);
    } catch {
      /* the address index is rebuilt below */
    }
    if (op !== 'add') agentAddresses();
    const h = r.handle ?? relay?.handle ?? '<you>';
    if (style === 'address') {
      // ADR-077 (K): `morse address add|rename|remove` — the same change, said in terms of addresses
      const mine = agentAddresses();
      const of = (name: string | undefined) => mine.find((a) => a.agent === name)?.key.address;
      if (op === 'add') {
        const address = of(r.agent);
        if (address && !r.already) added?.(address);
        console.log(`${r.already ? 'already there' : 'added'}: ${shown === null ? '' : `${shown ?? r.agent} — `}morse.im/${address ?? '?'}${mine.find((a) => a.agent === r.agent)?.primary ? '' : '   (its own key)'}`);
        // (ADR-088 §6) the running daemon takes a new address on by itself; one that cannot (not running: it reads them
        // when it starts — or a daemon of a release before) is restarted as before
        if (!r.already) console.log((await reloadAddresses()) ? 'it is online now (the running daemon took it on)' : 'restart the daemon to bring this address online: morse stop --restart');
      } else if (op === 'rename') console.log(`renamed: ${r.from} → ${r.agent}   morse.im/${of(r.agent) ?? '?'}  (the address is the same)`);
      else if (op === 'remove') {
        console.log(`removed: ${shown ?? r.agent} — it no longer receives; its key stays in ~/.morse/addresses/`);
        console.log((await reloadAddresses()) ? 'the running daemon no longer logs it in' : 'restart the daemon so it stops logging this address in: morse stop --restart');
      }
      return;
    }
    if (op === 'list') {
      const primary = localAgents().primary;
      if (!r.agents?.length) console.log(`morse.im/${h} has no agents yet — morse agent add <name>`);
      for (const a of r.agents ?? []) {
        const notes = [a.agent === r.default ? 'default' : '', a.device === r.device ? (a.agent === primary ? 'this computer' : 'on this computer') : `on ${a.device.slice(0, 7)}`].filter(Boolean);
        console.log(`morse.im/${h}/${a.agent}  (${notes.join(', ')})`);
      }
      if (r.default) console.log(`morse.im/${h} → ${r.default} (the default agent)`);
    } else if (op === 'add') {
      console.log(`${r.already ? 'already registered' : 'added'}: morse.im/${h}/${r.agent} — on this computer${r.default === r.agent ? ' (and it is your default: morse.im/' + h + ')' : ''}`);
      // ADR-077: one agent = one address — an agent added after the first gets a key of its own
      const mine = agentAddresses().find((a) => a.agent === r.agent);
      if (mine) console.log(`address: ${mine.key.address}${mine.primary ? '  (this computer\'s first address)' : '  (its own key — ~/.morse/addresses/)'}`);
      // a running daemon logged in its addresses when it connected: the new one joins at its next start
      if (mine && !mine.primary && !r.already) console.log('restart the daemon to bring this address online: morse stop --restart');
    } else if (op === 'remove') {
      console.log(`removed: morse.im/${h}/${r.agent}${r.default ? `  (default is now ${r.default})` : '  (you have no agents left)'}`);
    } else if (op === 'default') {
      console.log(`default: morse.im/${h} → morse.im/${h}/${r.agent}`);
    } else {
      console.log(`renamed: morse.im/${h}/${r.from} → morse.im/${h}/${r.agent}${r.default === r.agent ? '  (still your default)' : ''} — the old address no longer works`);
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
};
// ADR-080: Windows has no launchd / systemd — the daemon is started at logon by a scheduled task of
// this user (the HKCU Run value when Windows refuses the task). install.ps1 runs `autostart enable`.
const autostartCmd = program
  .command('autostart', hidden)
  .description('Windows: start the daemon when you log on — enable | disable | status (macOS / Linux: launchd / systemd, set up by the installer)');
const autostartFail = (e: unknown): void => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
};
autostartCmd.action(async () => {
  const { autostartStatus } = await import('./platform/autostart.js');
  const { autostartLine } = await import('./platform/status.js');
  console.log(isWindows() ? autostartLine(autostartStatus({}).kind) : 'autostart: not used on this system — launchd / systemd start the daemon (set up by the installer)');
});
autostartCmd.command('status').action(async () => {
  const { autostartStatus } = await import('./platform/autostart.js');
  const { autostartLine } = await import('./platform/status.js');
  console.log(isWindows() ? autostartLine(autostartStatus({}).kind) : 'autostart: not used on this system — launchd / systemd start the daemon (set up by the installer)');
});
autostartCmd
  .command('enable')
  .description('Register the logon start (a scheduled task; the Run registry value when the task is refused)')
  .action(async () => {
    try {
      const { enableAutostart } = await import('./platform/autostart.js');
      const { realpathSync } = await import('node:fs');
      // the task would start the DEFAULT home's daemon — never registered from an isolated instance or a source checkout
      if (isWindows() && isIsolatedHome()) throw new Error('MORSE_HOME is set — the logon start only knows the default data directory; unset it and run this again');
      if (isWindows() && import.meta.url.endsWith('.ts')) throw new Error('this is a development build (running from source) — install Morse first');
      const r = enableAutostart({ node: realpathSync(process.execPath), cli: fileURLToPath(import.meta.url), workdir: homedir() });
      console.log(`autostart: ${r.detail}`);
    } catch (e) {
      autostartFail(e);
    }
  });
autostartCmd
  .command('disable')
  .description('Remove the logon start (the daemon that is running now is not stopped: morse stop)')
  .action(async () => {
    try {
      const { disableAutostart } = await import('./platform/autostart.js');
      const { removed } = disableAutostart({});
      console.log(removed.length ? `autostart: removed (${removed.map((k) => (k === 'task' ? 'scheduled task' : 'registry Run value')).join(', ')})` : 'autostart: nothing to remove');
    } catch (e) {
      autostartFail(e);
    }
  });

// ADR-074: hidden alias of `morse status --check` (the checks only)
program.command('doctor', hidden).description('(alias) morse status --check').action(runChecks);

const setupCmd = program.command('setup', hidden).description('Install the morse skill into agent CLIs and register the Claude hook');
setupCmd.option('--no-hook', 'skip Claude settings.json hook registration').action(async ({ hook }: { hook: boolean }) => {
  // ADR-035: move ~/.anytoany → ~/.morse (stops a running daemon for the move)
  const { migrateDataDir } = await import('./migrate-home.js');
  const { dataDir } = await import('./home.js');
  const { mkdirSync } = await import('node:fs');
  const moved = await migrateDataDir({ stopDaemon: true, log: (l) => console.log(l) });
  mkdirSync(dataDir(), { recursive: true });
  try {
    // ADR-080 — Windows: private to its owner before anything is written into it (a no-op elsewhere)
    (await import('./platform/acl.js')).protectDataDir(dataDir());
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.log(`data directory: ${dataDir()}${moved.status === 'skipped' ? ` (not moved: ${moved.reason})` : ''}`);
  if (moved.stoppedDaemon) console.log('the daemon was stopped for the move — start it again: morse start (launchd / systemd restart it by themselves)');
  await (await import('./setup.js')).runSetup({ withHook: hook });
});

const listCmd = program.command('list', hidden).description('List addressable sessions found here; --conversations: the session-to-session conversations (was morse conversations)');
listCmd.option('--json', 'output as JSON').option('--limit <n>', 'max sessions to show (0 = all)', '20');
listCmd
  .option('--conversations', 'the established session-to-session conversations instead')
  .action(async (opts: { json?: boolean; limit: string; conversations?: boolean }) => {
    if (opts.conversations) return showConversations(opts);
    await (await import('./cli/listing.js')).listSessions(opts);
  });
interface ExternalOpts {
  agent: string;
  session: string;
  title?: string;
  cwd?: string;
}
/** Register an external agent session (ADR-024): `morse connect --agent … --session …` (was `morse register`). */
async function registerExternal(opts: ExternalOpts): Promise<void> {
  const registry = await import('./registry/external.js');
  const session = { agent: opts.agent, sessionId: opts.session, ...(opts.title ? { title: opts.title } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) };
  // (a name that is not allowed, or a registry that cannot be written: one line, exit code 1)
  await (async () => {
    const s = registry.register(session);
    console.log(`registered ${sessionLabel(s)}  [${s.sessionId}]`);
    console.log('it is pull-only — it receives via `morse read --pull` or POST /api/inbox, never a headless resume');
    // (ADR-087) an app that calls the local API itself presents its own token — and acts as this agent only
    // — for THIS session id only (follow-up 1): register, read mail and send as (@agent, this session), nothing else
    const { ensureExternalToken, externalHeaderPath } = await import('./daemon/local-api.js');
    ensureExternalToken(s.agent, undefined, { session: s.sessionId });
    console.log(`its token for the local API — as @${s.agent}, session ${s.sessionId} only (POST /api/register, /api/inbox, /api/send; GET /api/sessions): curl -H @${externalHeaderPath(s.agent)} …`);
  })().catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
/** `morse connect --agent … --session … --uninstall` (was `morse unregister`). */
async function unregisterExternal({ agent, session }: { agent: string; session: string }): Promise<void> {
  (await import('./registry/external.js')).unregister(agent, session);
  console.log(`unregistered @${agent}:${session}`);
  // (ADR-087) the token is no longer for this session; with its last session gone, so is the token
  const { unbindExternalSession, removeExternalToken } = await import('./daemon/local-api.js');
  if (unbindExternalSession(agent, session)) removeExternalToken(agent);
}
program
  .command('register', hidden)
  .description('(alias) morse connect --agent <name> --session <id>')
  .requiredOption('--agent <name>', 'agent name, e.g. sds (lowercase, not a built-in name)')
  .requiredOption('--session <id>', 'the session id the app reports for itself')
  .option('--title <title>', 'human-readable name used for @-target matching')
  .option('--cwd <dir>', 'project directory, if the app has one')
  .action(registerExternal);
program.command('unregister', hidden)
  .description('(alias) morse connect --agent <name> --session <id> --uninstall')
  .requiredOption('--agent <name>', 'agent name')
  .requiredOption('--session <id>', 'session id')
  .action(unregisterExternal);
program
  .command('connect', hidden)
  .description('Wire a desktop App up to Morse (sds = 闪电说), or register an external agent session so it becomes addressable (--agent, --session; was morse register)')
  .argument('[app]', 'which app to connect — "sds"; leave out with --agent / --session')
  .option('--apply', 'with an app: actually write the files (default: preview only)')
  .option('--uninstall', 'remove what this command installed (with --agent / --session: forget that session)')
  .option('--agent <name>', 'an external agent session: its agent name, e.g. sds (lowercase, not a built-in name)')
  .option('--session <id>', 'an external agent session: the session id the app reports for itself')
  .option('--title <title>', 'with --agent: human-readable name used for @-target matching')
  .option('--cwd <dir>', 'with --agent: project directory, if the app has one')
  .addOption(new Option('--app-home <dir>', 'override the app data directory'))
  .option('--port <port>', "daemon port the app should call (default: this home's daemon's, else 7433)")
  .action(async (app: string | undefined, opts: { apply?: boolean; uninstall?: boolean; appHome?: string; port?: string; agent?: string; session?: string; title?: string; cwd?: string }) => {
    if (app === 'sds') return (await import('./cli/connect-sds.js')).connectSds(opts);
    if (app !== undefined) {
      console.error(`error: unknown app "${app}" — supported: sds (闪电说)`);
      process.exitCode = 1;
      return;
    }
    if (!opts.agent || !opts.session) {
      console.error('error: connect an app (morse connect sds), or an external agent session: morse connect --agent <name> --session <id> [--title <title>] [--cwd <dir>]');
      process.exitCode = 1;
      return;
    }
    const ext = { agent: opts.agent, session: opts.session };
    if (opts.uninstall) return unregisterExternal(ext);
    return registerExternal({ ...ext, ...(opts.title ? { title: opts.title } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  });
/** A session as the daemon names one it resolved a target to, or offers as a candidate. */
type SessionLabel = { agent: string; title: string; sessionId: string; device?: string };
/** `@[device/]agent:title` */
const sessionLabel = (s: SessionLabel): string => `${atOf(s)}:${s.title}`;
/** What the daemon answers to POST /api/send. */
interface SendAnswer {
  message?: Message;
  /** where the message was queued for */
  resolvedTarget?: SessionLabel;
  error?: string;
  /** with an error: the sessions the target may have meant */
  candidates?: SessionLabel[];
  /** a message with files sent in chunks: how many */
  chunks?: number;
  /** (ADR-081) the address of mine it is sent from, as the daemon understood it */
  sentFrom?: unknown;
}

const sendCmd = program.command('send')
  .description('Send a message: to a contact (their remark), an address (morse.im/<address>[/<agent>]) or a session (@<agent>:<session>)')
  .argument('<target>', 'who: a contact\'s name (bob, bob/<agent>), morse.im/<handle>[/<agent>], me/<agent> (your own agent), or a session @<agent>[:<session>]')
  .argument('[message]', 'message text (or --text-file)')
  .option('--text-file <path>', 'read the message text from this UTF-8 file instead — for text with quotes, %, &, line breaks, or a long text (always on Windows)')
  .option('--from <name>', 'which of your addresses here it goes out from (its name in `morse address`, or the address; default: MORSE_ADDRESS, else your first address)')
  .option('--session <session>', 'the session of yours the answer comes back to: @<agent>:<session> (resolved like a target); `--from @<agent>:<session>` still means this')
  .option('--port <port>', "daemon port for delegation (this home's daemon's — any other port is refused; kept for older scripts)")
  .option('--file <path...>', 'attach file(s) — to another address over Morse; up to 100 MB (morse.maxFileBytes), big files go in chunks')
  .option('--no-wait', 'with --file: do not show the progress, return once queued')
  .option('--json', 'output as JSON')
  .action(async (rawTarget: string, messageArg: string | undefined, opts: { from?: string; session?: string; port?: string; file?: string[]; wait?: boolean; json?: boolean; textFile?: string }) => {
    // ADR-080: the text as an argument, or from a file (a Windows command line damages quotes, %, & and long text)
    let message: string;
    try {
      message = (await import('./commands/text-file.js')).messageTextFrom(messageArg, opts.textFile);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    // ADR-050: a contact's remark name (bob, bob/mini) or me/<agent> → their address
    const { resolveSendTarget, messageViewOf } = await import('./commands/messaging.js');
    const mailbox = openMailbox();
    let target: string;
    try {
      target = resolveSendTarget(mailbox, rawTarget);
    } catch (e) {
      // (ADR-091) an old name, or a contact still by one: one line, nothing queued
      const line = `error: ${e instanceof Error ? e.message : String(e)}`;
      if (opts.json) console.log(JSON.stringify({ error: line.replace(/^error: /, '') }));
      else console.error(line);
      process.exit(1);
    }
    // ADR-081 §6: --from <name|address> = one of THIS computer's addresses (`morse address`): the message is
    // signed and sealed as that address. Anything else is a session, as before (@<agent>:<session>).
    let fromAddress: string | undefined;
    /** (ADR-081 review N1) the ADDRESS this message has to go out from, when a specific one is required. */
    let needFrom: string | null = null;
    const { normalizeAddress } = await import('./identity/address.js');
    const { ownAddressNames } = await import('./commands/known-as.js');
    const own = ownAddressNames();
    // (ADR-088 §5) two things that used to share `--from`: the ADDRESS of mine it goes out from (`--from <name>`),
    // and the SESSION of mine the answer comes back to (`--session`, or `--from @<agent>:<session>` as before)
    const looksLikeSession = (v: string): boolean => v.startsWith('@') || v.includes(':');
    if (opts.session && opts.from && looksLikeSession(opts.from)) {
      console.error('error: two sessions were named (--session and --from @…) — --from <name> is the address of yours it goes out from');
      process.exit(1);
    }
    const sessionArg = opts.session ?? (opts.from && looksLikeSession(opts.from) ? opts.from : undefined);
    let fromArg = opts.from && opts.from !== sessionArg ? opts.from : undefined;
    /** the address was named by MORSE_ADDRESS, not on the command */
    let fromEnv = false;
    // (ADR-088 §4) MORSE_ADDRESS=<name|address>: the address this process writes from unless the command says
    // otherwise — mail to a contact or an address; a session here (`@…`) is not written to "from an address"
    if (!fromArg && !rawTarget.startsWith('@')) {
      const { addressFromEnv } = await import('./commands/known-as.js');
      const env = addressFromEnv(own);
      if (env && 'error' in env) {
        console.error(`error: ${env.error}`);
        process.exit(1);
      }
      fromArg = env?.name;
      fromEnv = Boolean(env);
    }
    if (fromArg) {
      if (own.error) {
        console.error(`error: ${own.error}`);
        process.exit(1);
      }
      const { mineFrom } = await import('./commands/known-as.js');
      const hit = mineFrom(fromArg, own);
      if ('error' in hit) {
        console.error(`error: "${fromArg}" is not one of your addresses here — morse address lists them (a session is written @<agent>:<session>)`);
        process.exit(1);
      }
      fromAddress = hit.name;
      needFrom = hit.address;
    }
    // (ADR-083) WHICH contact this is, and so which of your addresses it goes out from. A contact belongs to one
    // address of yours; the same person can be a contact of two — two rows that share nothing. A remark names
    // one row: mail to it goes out from that row's address. A peer ADDRESS that is a contact of two of your
    // addresses is refused with one line unless --from says which. --from that is not the remark's address
    // is refused too: writing to them as another address is a separate contact, made by writing to their address.
    /** After the send: a line saying that a NEW contact (of the address named with --from) came of it. */
    let alsoNote: string | null = null;
    {
      const { ambiguousLine, nameOfMine } = await import('./commands/known-as.js');
      const { contactsOfTarget } = await import('./mailbox/known-as.js');
      const refuse = (line: string): never => {
        console.error(`error: ${line}`);
        process.exit(1);
      };
      /**
       * How to write to a contact that belongs to ANOTHER address of mine than the one named: from the address it
       * belongs to. Never "use their address … --from <the one named>": that makes them a contact of the second
       * address too — and shows them that address (review of the first draft of ADR-088).
       */
      const fromOwner = (ownerKey: string): string => {
        const owner = nameOfMine(ownerKey, own).replace(/^morse\.im\//, '');
        const arg = /\s/.test(owner) ? JSON.stringify(owner) : owner;
        const hasName = owner !== 'your first address';
        if (fromEnv) return `MORSE_ADDRESS names another address: write to them from the one they belong to — ${hasName ? `add --from ${arg}, or ` : ''}unset MORSE_ADDRESS`;
        return `write to them from the address they belong to: ${hasName ? `--from ${arg}, or ` : ''}leave --from out`;
      };
      const contacts = mailbox.contacts;
      const wantKey = needFrom ? contacts.mine(needFrom) : null;
      const peer = normalizeAddress(target);
      let paired: string[] = [];
      try {
        paired = createTrustStore().list().map((d) => d.name.toLowerCase());
      } catch {
        /* no trust list: only address and morse.im/… targets count */
      }
      const rows = contactsOfTarget(contacts, target, (h) => paired.includes(h)) ?? [];
      // the row the user NAMED (a remark, or a contact id) — not merely an address that has one
      const byName = !rawTarget.startsWith('@') && !rawTarget.includes(':') && !normalizeAddress(rawTarget) ? contacts.find(rawTarget) : null;
      const named = byName && byName.id !== 'self' && (byName.remark?.toLowerCase() === rawTarget.trim().toLowerCase() || byName.id === rawTarget.trim()) ? byName : null;
      const first = own.first;
      if (named) {
        const rowKey = named.myAddress ?? '';
        if (wantKey !== null && wantKey !== rowKey) {
          refuse(`"${rawTarget}" is a contact of your address ${nameOfMine(rowKey, own)}, not of ${fromAddress} — ${fromOwner(rowKey)}`);
        }
        if (wantKey === null && (rowKey || rows.length > 1)) {
          // from the address the contact belongs to — said to the daemon by the address itself
          needFrom = rowKey || first;
          if (needFrom) fromAddress = needFrom;
        }
      } else if (peer) {
        if (wantKey === null && rows.length > 1) refuse(ambiguousLine('contact', peer, rows.map((c) => c.myAddress ?? ''), own));
        if (wantKey === null && rows.length === 1 && rows[0]!.myAddress) {
          needFrom = rows[0]!.myAddress;
          fromAddress = needFrom;
        }
        if (wantKey !== null && rows.length && !rows.some((c) => (c.myAddress ?? '') === wantKey)) {
          alsoNote = `note: morse.im/${peer} is now a contact of your address ${nameOfMine(wantKey, own)} too — a separate contact from the one of ${rows.map((c) => nameOfMine(c.myAddress ?? '', own)).join(', ')} (its own name, group and history)`;
        }
      } else if (wantKey && rows.length) {
        // a contact by old name is the first address's alone
        refuse(`${target} is a contact of your first address, by its old name, not of ${fromAddress} — ${fromOwner('')}`);
      }
    }
    // (ADR-081 review N1) right after an update the daemon of the release before may still be running: it ignores a
    // sending address and would send this from your first address, old name and certificate included.
    // Asked BEFORE anything is posted; a daemon that does not say it can is handed nothing.
    const { daemonSendsFromAddress, OLD_DAEMON_LINE } = await import('./daemon/capabilities.js');
    const { localApi, explicitPort, NoDaemonForThisHome, notThisHomesDaemonLine } = await import('./daemon/local-api.js');
    /** (ADR-087) a port the command was given; without one the daemon of THIS home is the only one ever talked to */
    const sendPort = explicitPort(opts.port);
    if (needFrom) {
      const can = await daemonSendsFromAddress(sendPort);
      if (can === 'old') {
        console.error(`error: ${OLD_DAEMON_LINE}`);
        process.exit(1);
      }
      if (can === 'silent') {
        console.error(`error: the daemon did not answer${sendPort ? ` on port ${sendPort}` : ''} — nothing was sent; try again`);
        process.exit(1);
      }
    }
    const from: SessionRef = sessionArg ? await sessionOrExit(sessionArg) : { agent: 'user', sessionId: 'cli' };

    // prefer the daemon: its directory aggregates LAN peers, so @device/… resolves.
    // First contact with a person asks the relay (up to ~5 s for the connection + 15 s
    // for the answer) — wait longer than that, or the daemon queues it after we gave up.
    const sendTimeout = Number(process.env['MORSE_SEND_TIMEOUT_MS']) || 30_000;
    try {
      let res: Response;
      try {
        res = await localApi('/api/send', {
          port: sendPort,
          json: { target, from, text: message, ...(opts.file?.length ? { files: opts.file.map((f) => resolvePath(f)) } : {}), // (ADR-088 §1) the daemon is told the ADDRESS — a name is this command's business (it may be newer than the daemon's)
            ...(fromAddress ? { fromAddress: needFrom ?? fromAddress } : {}),
          },
          timeoutMs: sendTimeout,
        });
      } catch (e) {
        // (ADR-087) what answers on that port is not this home's daemon: nothing was handed to it — said, then
        // the same as "the daemon is not running"
        if (e instanceof NoDaemonForThisHome && e.why === 'other' && e.port !== null) console.error(`warning: ${notThisHomesDaemonLine(e.port)}`);
        // only "nobody listens on the port" means the daemon is not running; a timeout or
        // a dropped answer means it got the request and may well have queued the message
        const code = (e as { cause?: { code?: string } })?.cause?.code;
        if (code === 'ECONNREFUSED') throw e;
        console.error(
          `error: the daemon did not answer within ${Math.round(sendTimeout / 1000)} s (${e instanceof Error ? e.message : String(e)}) — the message may still have been queued: check with  morse read --all  before sending it again`,
        );
        process.exit(1);
      }
      const body = (await res.json()) as SendAnswer;
      if (res.ok && body.message && needFrom && body.sentFrom !== needFrom) {
        // (ADR-081 review N1) belt and braces — the daemon was asked first, so this is one that changed in between: it
        // queued the message without the sending address. Taken back if nobody started sending it yet.
        const stopped = mailbox.withdraw(body.message.id, `not sent: ${OLD_DAEMON_LINE}`);
        console.error(`error: ${OLD_DAEMON_LINE}`);
        console.error(
          stopped
            ? `  the message it queued [${body.message.id.slice(0, 8)}] was taken back — nothing was sent`
            : `  it had already taken the message [${body.message.id.slice(0, 8)}] — that one may have gone out from your first address: morse read --id ${body.message.id.slice(0, 8)}`,
        );
        process.exit(1);
      }
      // queued: where to, and (with files sent in chunks) followed until it is there
      const queued = res.ok ? body.message : undefined;
      const t = body.resolvedTarget;
      if (queued && t) {
        if (alsoNote) console.error(alsoNote);
        if (opts.json) {
          const mb = openMailbox();
          const m = mb.getMessage(queued.id) ?? queued;
          console.log(JSON.stringify({ queued: true, message: messageViewOf(mb, m), resolvedTarget: t, ...(body.chunks ? { chunks: body.chunks } : {}) }, null, 2));
          return;
        }
        console.log(`queued ${queued.id}\n  to: ${sessionLabel(t)} [${t.sessionId.slice(0, 8)}]`);
        const files = queued.parts.flatMap((p) => p.files ?? []);
        if (files.length) console.log(`  files: ${files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(', ')}${body.chunks ? ` — ${body.chunks} chunks` : ''}`);
        if (body.chunks && opts.wait !== false) await followTransfer(sendPort, queued.id, body.chunks);
        return;
      }
      // refused (a target it could not resolve, …): why, and the sessions it may have meant
      const refusal = [`error: ${body.error ?? `daemon returned ${res.status}`}`, ...(body.candidates ?? []).map((c) => `  candidate: ${sessionLabel(c)}  [${c.sessionId.slice(0, 8)}]`)];
      for (const line of refusal) console.error(line);
      process.exit(1);
    } catch (e) {
      if ((e as { cause?: { code?: string } })?.cause?.code !== 'ECONNREFUSED') {
        console.error(`error: unexpected answer from the daemon (${e instanceof Error ? e.message : String(e)}) — the message may still have been queued: check with  morse read --all`);
        process.exit(1);
      }
      // No daemon: a session on this computer can still be written to — queued here, delivered once it starts.
      // Another address can only be reached through the daemon.
      const { parseMorseAddress, hasRelayHost } = await import('./cluster/morse.js');
      if ((parseMorseAddress(target) && hasRelayHost(target)) || normalizeAddress(target) || fromAddress) {
        console.error(`error: the daemon is not running — messages to other addresses (${target}) go through it: morse start`);
        process.exit(1);
      }
      const to = await sessionOrExit(target);
      const mb = openMailbox();
      const m = mb.send({ from: { agent: from.agent, sessionId: from.sessionId }, to: { agent: to.agent, sessionId: to.sessionId }, text: message });
      if (opts.json) {
        // ADR-053: plugins send with --json whether or not the daemon runs
        console.log(JSON.stringify({ queued: true, offline: true, message: messageViewOf(mb, m), resolvedTarget: { agent: to.agent, title: to.title, sessionId: to.sessionId } }, null, 2));
        return;
      }
      const queuedHere = [`queued ${m.id} (daemon offline — local resolution only)`, `  to: ${sessionLabel(to)} [${to.sessionId.slice(0, 8)}]`, '  delivery starts once the daemon is running (morse start)'];
      console.log(queuedHere.join('\n'));
    }
  });
interface InboxOpts {
  /** (ADR-083) only what belongs to this address of mine */
  from?: string;
  session?: string;
  agent?: string;
  take?: boolean;
  all?: boolean;
  json?: boolean;
}
/** `morse read` with no <contact> (was `morse inbox`): to process, or every message with --all. */
async function showInbox(opts: InboxOpts): Promise<void> {
  if (opts.take && !opts.session && !opts.agent) {
    // ADR-048: an unscoped --take marked EVERY message delivered, outbound retries included
    console.error('error: --take needs a scope now: --session "@<agent>:<your session>" or --agent <name> (it only marks messages received there)');
    process.exit(1);
  }
  // whose mail: one session's, one agent's Morse mailbox (its 'inbox' session), or everyone's
  const scope = opts.session ? { toSession: (await sessionOrExit(opts.session)).sessionId } : opts.agent ? { toSession: 'inbox', toAgent: opts.agent } : {};
  const query = { ...scope, ...(opts.take ? { take: true } : {}), ...(opts.all ? { all: true } : {}) };
  const mailbox = openMailbox();
  // ADR-050: plain `morse message` (or --agent) is the to-process view; --session / --take / --all keep the old listing
  if (!opts.session && !opts.take && !opts.all) {
    const { printTodo } = await import('./commands/messaging.js');
    printTodo(mailbox, { ...(opts.agent ? { agent: opts.agent } : {}), ...(opts.json ? { json: true } : {}), ...(opts.from !== undefined ? { from: opts.from } : {}) });
    return;
  }
  let messages = mailbox.inbox(query);
  /** (ADR-083) --from: the key of that address of mine ('' = the first) */
  let myKey: string | undefined;
  if (opts.from !== undefined) {
    // (ADR-083) --from <name>: only the mail of that address's contacts
    const { mineFrom, ownAddressNames } = await import('./commands/known-as.js');
    const mine = mineFrom(opts.from, ownAddressNames());
    if ('error' in mine) {
      console.error(`error: ${mine.error}`);
      process.exit(1);
    }
    myKey = mine.key;
    // (mail between your own sessions and computers is the first address's, like the `self` contact)
    // (ADR-083 review R3: the address the MESSAGE belongs to — its contact's, found by the pair, never by the bare id)
    messages = messages.filter((m) => mailbox.addressOf(m) === mine.key);
  }
  if (opts.json) return console.log(JSON.stringify(messages, null, 2));
  // ADR-038: chunked messages still arriving — not in the inbox until every file is in and checked
  for (const t of listIncoming()) {
    console.log(
      `receiving ${t.held}/${t.total} chunks from @${t.senderName} [${t.msgId.slice(0, 8)}]: ${t.files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(', ')} — shows up here once complete`,
    );
  }
  if (messages.length === 0) console.log('inbox empty');
  // (ADR-083) with more than one address here every row of a contact's mail says which of mine it belongs to —
  // `  via <name>`, like `morse message` and `morse contact`; mail between my own sessions and computers does not
  const anyRemark: RemarkLookup = (h) => mailbox.contacts.byHandle(h)?.remark ?? null;
  const rowOf = await (async () => {
    const { nameOfMine, ownAddressNames, severalAddresses } = await import('./commands/known-as.js');
    const own = ownAddressNames();
    if (!severalAddresses(own)) return () => ({ remark: anyRemark, via: '' });
    return (m: Message): { remark: RemarkLookup; via: string } => {
      const c = mailbox.contactOf(m); // (ADR-083 review R3: by the pair, never by the bare id)
      if (!c) return { remark: remarkLookupFor(mailbox, m), via: '' }; // (a removed contact's mail: never another address's name for them)
      if (c.id === 'self') return { remark: anyRemark, via: '' };
      // (the same peer can be a contact of two of my addresses, under two names: the row shows the name of ITS contact)
      return { remark: (h) => (!c.handle && c.address === h ? c.remark : anyRemark(h)), via: `  via ${nameOfMine(c.myAddress ?? '', own)}` };
    };
  })();
  for (const m of messages) {
    const row = rowOf(m);
    printMessage(m, row.remark, row.via);
  }
  // ADR-037: strangers' first messages wait outside the inbox — say how many, never what
  const waiting = mailbox.requests.count(myKey);
  if (waiting > 0) {
    console.log(
      `\n${waiting} message request(s) from addresses you have not accepted — not in this inbox. Tell your owner; only they can accept (morse contact). An agent never accepts on its own.`,
    );
    // (ADR-081 review F4) full = a new person is refused until some are accepted or rejected
    // (ADR-083: each address of yours has its own room — with several, the full one is named)
    const { requestsFullLine } = await import('./mailbox/requests.js');
    const { nameOfMine, ownAddressNames, severalAddresses } = await import('./commands/known-as.js');
    const own = ownAddressNames();
    const fullAt = mailbox.requests.fullAt().filter((k) => myKey === undefined || k === myKey);
    if (fullAt.length && !severalAddresses(own)) console.log(requestsFullLine(waiting, mailbox.requests.max));
    else for (const k of fullAt) console.log(`${nameOfMine(k, own)}: ${requestsFullLine(mailbox.requests.count(k), mailbox.requests.max)}`);
  }
}

interface PullOpts {
  session?: string;
  cwd?: string;
  inbox?: boolean;
  quiet?: boolean;
  history?: boolean;
  limit?: string;
}
/** `morse read --pull` (was `morse pull`): new messages for THIS session, from disk. */
async function pullMessages(opts: PullOpts): Promise<void> {
  const mailbox = openMailbox();
  const { mailTargets, pullFor } = await import('./cli/session-mail.js');
  // messages to this computer's Morse agent(s) land in the 'inbox' session
  const targets = opts.inbox ? [{ id: 'inbox', label: 'Morse inbox (the addresses here)' }] : await mailTargets(opts, opts.quiet);
  if (targets.length > 0) await pullFor(mailbox, targets, { ...opts, fullForeign: opts.inbox === true });
}

interface WaitOpts {
  session?: string;
  cwd?: string;
  timeout?: string;
  poll?: string;
}
/** `morse read --wait` (was `morse monitor`): block until a message for this session arrives, print it here. */
async function waitForMessages(opts: WaitOpts): Promise<void> {
  const mailbox = openMailbox();
  const { mailTargets, waitFor } = await import('./cli/session-mail.js');
  const targets = await mailTargets(opts);
  if (targets.length > 0) await waitFor(mailbox, targets, opts);
}

/** `morse list --conversations` (was `morse conversations`). */
async function showConversations(opts: { json?: boolean }): Promise<void> {
  (await import('./cli/listing.js')).listConversations(openMailbox(), opts);
}

const inboxOptions = (c: Command): Command =>
  c
    .option('--all', 'every message, sent ones too: delivered ✓ / waiting / request pending / failed')
    .option('--agent <name>', "only that agent's Morse mailbox (morse.im/<you>/<name>)")
    .option('--session <target>', 'only messages to this session, @<agent>[:<session>] (also: the session --pull / --wait act for)')
    .option('--take', 'with --session or --agent: mark the listed received messages as delivered (pull mode)')
    .option('--json', 'output as JSON');
const pullOptions = (c: Command): Command =>
  c
    .option('--cwd <dir>', 'directory used to identify your session (default: current directory)')
    .option('--inbox', "pull the Morse inbox of the addresses here instead of a session's messages")
    .option('--quiet', 'print nothing when there is nothing new (for proactive/auto pulls)')
    .option('--history', 'SEE the recent cross-agent exchange in full (read-only, ignores cursor) — even messages already delivered/handled')
    .option('--limit <n>', 'with --history, how many recent messages to show', '15');
const waitOptions = (c: Command): Command =>
  c
    .option('--cwd <dir>', 'directory used to identify your session (default: current directory)')
    .option('--timeout <s>', 'stop waiting after this many seconds (then just run it again)', '1800')
    .option('--poll <ms>', 'poll interval', '1500');

// ADR-074: the old names, hidden, unchanged
inboxOptions(program.command('inbox', hidden).description('(alias) morse read')).option('--from <name>', 'only what belongs to this address of yours').action(showInbox);
pullOptions(program.command('pull', hidden).description('(alias) morse read --pull').option('--session <target>', 'pull for a specific session instead of auto-detecting by directory')).action(pullMessages);
waitOptions(program.command('monitor', hidden).description('(alias) morse read --wait').option('--session <target>', 'wait for a specific session instead of auto-detecting by directory')).action(waitForMessages);
program.command('conversations', hidden).description('(alias) morse list --conversations').option('--json', 'output as JSON').action(showConversations);

interface MessageOpts extends InboxOpts, PullOpts, WaitOpts {
  id?: string;
  pull?: boolean;
  wait?: boolean;
}
/**
 * `morse read` (ADR-090; was `morse message`, ADR-074): no <contact> = to process (was inbox); <contact> = everything
 * with one contact (was history); --id = one message; --pull (was pull); --wait (was monitor). Only shows: nothing
 * is marked processed (but --pull / --take, which take what they show, as before). `read <arg>` is also the old hidden
 * `read <id>` (readOne); `message <who>` is a contact only.
 */
const messageAction = (asRead: boolean) => async (who: string | undefined, opts: MessageOpts): Promise<void> => {
  const modes = [who !== undefined ? '<who>' : '', opts.id !== undefined ? '--id' : '', opts.pull ? '--pull' : '', opts.wait ? '--wait' : ''].filter(Boolean);
  if (modes.length > 1) {
    console.error(`error: give one of <who>, --id, --pull or --wait (not ${modes.join(' and ')})`);
    process.exit(1);
  }
  if (opts.pull) return pullMessages(opts);
  if (opts.wait) return waitForMessages(opts);
  const { readOne, showHistory, showMessage } = await import('./commands/messaging.js');
  if (opts.id !== undefined) return showMessage(openMailbox(), opts.id, opts);
  if (who !== undefined) return (asRead ? readOne : showHistory)(openMailbox(), who, { limit: opts.limit ?? '30', ...(opts.json ? { json: true } : {}), ...(opts.from !== undefined ? { from: opts.from } : {}) });
  return showInbox(opts);
};
// ADR-090: `read` is the visible one; `message` (ADR-074) and `messages` are its hidden aliases — skills, plugins,
// hooks and scripts call them; their `<who>` is a contact only
for (const name of ['read', 'message', 'messages'] as const) {
  const c = program
    .command(name, name === 'read' ? {} : hidden)
    .description(
      name === 'read'
        ? 'Read messages — the ones to process (lists them); <contact>: everything with one contact; --id: one in full; --pull / --wait: for this session. It only shows them — a message waits until morse reply or morse done (--pull and --take do take them)'
        : name === 'message'
          ? '(alias) morse read — its earlier name, for the skills, plugins and scripts that call it'
          : '(alias) morse read',
    );
  if (name === 'read') c.argument('[contact]', 'a contact (remark name, address, or "me"): everything with them, both directions, oldest first — or a message id (or a unique prefix): that one in full');
  else c.argument('[who]', 'a contact (remark name, address, or "me"): everything with them, both directions, oldest first');
  c
    .option('--id <id>', 'show one message in full (id or a unique prefix; does not mark it processed — morse done does)')
    .option('--pull', 'pull new messages for THIS session (by the current directory, or --session) from disk — it takes them: marked delivered and processed')
    .option('--wait', 'block until a message for this session arrives, print it here, then return (no headless resume)');
  inboxOptions(c);
  c.option('--cwd <dir>', 'with --pull / --wait: directory used to identify your session (default: current directory)')
    .option('--inbox', "with --pull: the Morse inbox of the addresses here instead of a session's messages")
    .option('--quiet', 'with --pull: print nothing when there is nothing new')
    .option('--history', 'with --pull: the recent exchange in full (read-only) — even messages already handled')
    .option('--limit <n>', 'with <who>: how many recent messages (default 30); with --pull --history: (default 15)')
    .option('--from <name>', 'only what belongs to this address of yours (its name in `morse address`, or the address); with <who>: which of your addresses, when the same address is a contact of two')
    .option('--timeout <s>', 'with --wait: stop after this many seconds (default 1800)')
    .option('--poll <ms>', 'with --wait: poll interval (default 1500)')
    .action(messageAction(name === 'read'));
}

/** `morse plugin` / `plugin list`: each plugin, on / off, its command, whether it is running. */
async function listPlugins(opts: { json?: boolean }): Promise<void> {
    const { pluginSpecs, readPluginStatus } = await import('./plugin/manager.js');
    const { dataDir } = await import('./home.js');
    const specs = pluginSpecs(readMachineConfig().plugins, builtinPlugins());
    const st = readPluginStatus(join(dataDir(), 'plugin-status.json'));
    const rows = specs.map((p) => {
      const s = st?.plugins.find((x) => x.name === p.name);
      return { name: p.name, enabled: p.enabled, builtin: p.builtin, command: p.builtin ? (p.name === 'ilink' ? 'built-in (WeChat through iLink: you on WeChat <-> your agent — morse plugin ilink status)' : p.name === 'attendant' ? 'built-in (your agent reads your contacts\' messages and decides whether to reply, within the permissions you set — morse plugin attendant status)' : 'built-in (own agents: session mail here, your own devices)') : p.argv[2], running: Boolean(s?.pid), pid: s?.pid ?? null, restarts: s?.restarts ?? 0 };
    });
    if (opts.json) {
      console.log(JSON.stringify({ plugins: rows }, null, 2));
      return;
    }
    for (const r of rows) console.log(`${r.name}  ${r.enabled ? 'on' : 'off'}${r.running ? `  running (pid ${r.pid}${r.restarts ? `, ${r.restarts} restart(s)` : ''})` : ''}  — ${r.command}`);
    const off = offReason('plugins');
    if (off) console.log(`note: none of them runs here — plugins are ${off}`);
}
const pluginCmd = program
  .command('plugin', hidden)
  .description('Plugins the daemon runs (docs/PLUGINS.md; lists them): enable / disable / add / remove · dispatch / attendant / ilink — the built-in ones\' own commands · claim / ack / nack / watch — the plugin interface')
  .option('--json', 'output as JSON')
  .action(listPlugins);
pluginCmd
  .command('list')
  .description('Each plugin: on / off, its command, whether it is running')
  .option('--json', 'output as JSON')
  .action(listPlugins);
const setPlugin = async (name: string, patch: { enabled?: boolean; command?: string } | null, json?: boolean) => {
  const { updateMachineConfig } = await import('./machine-config.js');
  updateMachineConfig((cfg) => {
    const all = (cfg['plugins'] && typeof cfg['plugins'] === 'object' ? cfg['plugins'] : {}) as Record<string, Record<string, unknown>>;
    if (patch === null) delete all[name];
    else all[name] = { ...(all[name] ?? {}), ...patch };
    cfg['plugins'] = all;
  });
  // ADR-080: recorded, but no plugin runs on Windows in this release — said here, not left to be found out
  const off = patch !== null && patch.enabled !== false ? offReason('plugins') : null;
  if (json) console.log(JSON.stringify({ name, ...(patch ?? { removed: true }), ...(off ? { note: `plugins are ${off}` } : {}) }));
  else if (off) console.log(`${name}: recorded as on, but it will not run — plugins are ${off}`);
  else console.log(`${name}: ${patch === null ? 'removed' : patch.enabled === false ? 'off' : 'on'} — the daemon applies it within a few seconds`);
};
pluginCmd
  .command('enable')
  .argument('<name>')
  .option('--json', 'output as JSON')
  .action((name: string, opts: { json?: boolean }) => setPlugin(name, { enabled: true }, opts.json));
pluginCmd
  .command('disable')
  .description('Turn a plugin off (disable dispatch: nothing runs your agents for your own mail any more)')
  .argument('<name>')
  .option('--json', 'output as JSON')
  .action((name: string, opts: { json?: boolean }) => setPlugin(name, { enabled: false }, opts.json));
pluginCmd
  .command('add')
  .description('Add a plugin: a command the daemon keeps running (restarted if it exits)')
  .argument('<name>')
  .argument('<command>', 'run through /bin/sh -c; MORSE_CMD_JSON in its environment says how to run morse')
  .option('--json', 'output as JSON')
  .action((name: string, command: string, opts: { json?: boolean }) => {
    if (name === 'dispatch' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
      console.error('error: plugin names are a-z 0-9 - (and "dispatch" is built in)');
      process.exit(1);
    }
    return setPlugin(name, { command, enabled: true }, opts.json);
  });
pluginCmd
  .command('remove')
  .argument('<name>')
  .option('--json', 'output as JSON')
  .action((name: string, opts: { json?: boolean }) => (name === 'dispatch' ? setPlugin(name, { enabled: false }, opts.json) : setPlugin(name, null, opts.json)));

/**
 * The built-in plugins' own command lines (ADR-053, ADR-059): `morse plugin dispatch|attendant|ilink …`
 * (ADR-074; the old `morse dispatch|attendant|ilink …` stay as hidden aliases). The arguments go to the
 * plugin as they are; it talks to Morse through this same `morse`.
 */
const builtinPluginCommands = [
  {
    name: 'dispatch',
    description: 'The dispatch plugin (your own agents): session — the dedicated sessions of launch profiles (docs/PLUGINS.md)',
    usage: 'session [<profile>] [--set <session id> [--cwd <dir>] | --clear] [--json]',
    argv: () => builtinDispatchArgv(),
    fallback: ['session'],
  },
  {
    name: 'attendant',
    description: 'The attendant plugin (your agent answers your contacts, within the permissions you set): status | approvals | approve <id> | reject <id> | dismiss <id|all> (docs/PLUGIN-ATTENDANT.md) — on by default; morse plugin disable attendant',
    usage: 'status [--json] · approvals [--all] [--json] · approve <id> · reject <id> · dismiss <id|all>',
    argv: () => builtinPluginArgv('attendant'),
    fallback: ['status'],
  },
  {
    name: 'ilink',
    description: 'The iLink (WeChat) plugin: login | status | simulate | import | instructions (docs/PLUGIN-ILINK.md) — off unless morse plugin enable ilink',
    usage: 'login [--qr <png>] [--no-wait] [--force] · status [--json] · simulate "<text>" · import --from <dir> [--force] · instructions',
    argv: () => builtinPluginArgv('ilink'),
    fallback: [] as string[],
  },
];
for (const p of builtinPluginCommands) {
  for (const parent of [pluginCmd, program]) {
    parent
      .command(p.name, parent === program ? hidden : {})
      .description(parent === program ? `(alias) morse plugin ${p.name}` : p.description)
      .argument('[args...]', p.usage)
      .allowUnknownOption(true)
      .helpOption(false)
      .action(async (args: string[]) => {
        // stdio is inherited: attendant approve / reject need you at a terminal
        const { spawn } = await import('node:child_process');
        const argv = p.argv();
        const { withoutAddressSelectors } = await import('./address-env.js');
        const child = spawn(argv[0]!, [...argv.slice(1), ...(args.length ? args : p.fallback)], { stdio: 'inherit', env: { ...withoutAddressSelectors(process.env), MORSE_CMD_JSON: JSON.stringify(selfArgv()) } });
        child.on('exit', (code) => process.exit(code ?? 1));
      });
  }
}

for (const parent of [pluginCmd, program]) {
  parent
    .command('watch', parent === program ? hidden : {})
    .description('Plugin interface: print one line per newly received message and per new message request, until stopped (docs/PLUGINS.md)')
    .option('--json', 'one JSON object per line (the plugin contract)')
    .option('--since <id|time>', 'start after this message id, or this time (ISO / epoch ms) — to catch up after being down')
    .option('--once', 'print what is there (since --since) and exit')
    .option('--interval <ms>', 'how often to look', '500')
    .action(async (opts: { json?: boolean; since?: string; once?: boolean; interval: string }) => {
      const { createEventSource, parseSince } = await import('./plugin/events.js');
      const mailbox = openMailbox();
      const since = parseSince(mailbox, opts.since);
      if ('error' in since) {
        console.error(`error: ${since.error}`);
        process.exit(1);
      }
      const source = createEventSource(mailbox, since);
      const print = () => {
        for (const e of source.poll()) {
          if (opts.json) console.log(JSON.stringify(e));
          else if (e.type === 'message') {
            const c = e.contact as { remark?: string | null; handle?: string | null; group?: string } | null;
            console.log(`${e.time} message ${e.id}  from ${c?.remark ?? c?.handle ?? 'you'} [${c?.group ?? '?'}]  to ${e.agent ?? '?'}${e.hasFiles ? '  +files' : ''}`);
          } else console.log(`${e.time} request from ${e.address} — morse contact`);
        }
      };
      print();
      if (opts.once) return;
      // Started by a plugin that reads our output through a pipe: once that process is gone
      // (killed, crashed) nobody reads any more. A write to the pipe would tell us, but with no
      // new event there is none — so we also look for the reader itself:
      // - MORSE_WATCH_PARENT=<pid> (set by the built-in plugins): that process no longer exists;
      // - otherwise, when our output is a pipe: our parent is no longer the process that started us.
      const told = Number(process.env['MORSE_WATCH_PARENT']);
      const reader = Number.isInteger(told) && told > 1 ? told : null;
      let piped = false;
      try {
        const out = fstatSync(1);
        piped = out.isFIFO() || out.isSocket();
      } catch {
        /* stdout is closed: the write error below ends us */
      }
      const startedBy = STARTED_BY;
      const readerGone = (): boolean => {
        if (reader === null) return piped && process.ppid !== startedBy;
        try {
          process.kill(reader, 0);
          return false;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code !== 'EPERM';
        }
      };
      const timer = setInterval(
        () => {
          if (readerGone()) return stop();
          print();
        },
        Math.max(100, Number.parseInt(opts.interval, 10) || 500),
      );
      const stop = () => {
        clearInterval(timer);
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      process.stdout.on('error', stop); // the reading plugin went away
    });
}

{
  const { registerMessagingCommands, registerClaimCommands } = await import('./commands/messaging.js');
  // ADR-074: the plugin interface is `morse plugin claim|ack|nack`; the top-level names stay as hidden aliases
  registerClaimCommands(pluginCmd, { openMailbox });
  registerClaimCommands(program, { openMailbox }, { hidden: true });
  registerMessagingCommands(program, {
    openMailbox,
    tellDaemonAccepted,
    untrust: (handle) => {
      const trust = createTrustStore();
      let n = 0;
      for (const d of trust.list()) if (d.tier === 'peer' && d.name.toLowerCase() === handle.toLowerCase() && trust.remove(d.id)) n++;
      return n;
    },
    selfHandle: () => readMachineConfig().relay?.handle ?? null,
    // ADR-081: read-only (the directory names and the index) — a contact command never creates a key
    ownAddresses: () => {
      try {
        const dir = join(dataDir(), 'addresses');
        const listed = existsSync(dir) ? readdirSync(dir).filter((n) => /^[23456789abcdefghjkmnpqrstvwxyz]{26}$/.test(n)) : [];
        let indexed: string[] = [];
        try {
          indexed = Object.values(JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents ?? {}) as string[];
        } catch {
          /* no index yet */
        }
        return [...new Set([...listed, ...indexed])];
      } catch {
        return [];
      }
    },
  });
}

// ADR-074: the six in a fixed order first (that is the order `morse --help` shows), then the rest
{
  const rank = (c: Command) => {
    const i = [...VISIBLE_COMMANDS, ...LISTED_HIDDEN].indexOf(c.name());
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  (program.commands as Command[]).sort((a, b) => rank(a) - rank(b));
}

/**
 * `morse help [--all] [command…]` (ADR-074): plain = `morse --help` (the six); --all adds the
 * ten hidden ones (the aliases of older names stay unlisted); with a command, its own help.
 */
program
  .command('help', hidden)
  .description('Show help; --all also lists the hidden commands')
  .argument('[command...]', 'a command (and verb) to show the help of')
  .option('--all', 'also list the hidden commands (they work as usual)')
  .action((path: string[], opts: { all?: boolean }) => {
    let cmd: Command = program;
    for (const name of path) {
      const next = cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
      if (!next) {
        console.error(`error: unknown command '${path.join(' ')}' — morse help --all lists them`);
        process.exit(1);
      }
      cmd = next;
    }
    if (cmd !== program || !opts.all) {
      process.stdout.write(cmd.helpInformation());
      return;
    }
    const rows = (names: string[]) =>
      names.map((n) => {
        const c = program.commands.find((x) => x.name() === n)!;
        const usage = c.usage();
        return { term: `${n}${usage ? ` ${usage}` : ''}`, text: c.description() };
      });
    const all = [...rows(VISIBLE_COMMANDS), ...rows(LISTED_HIDDEN)];
    const width = Math.min(Math.max(...all.map((r) => r.term.length)), 40) + 2;
    const line = (r: { term: string; text: string }) => `  ${r.term.padEnd(width)}${r.text}`;
    console.log(`Usage: ${program.name()} [options] [command]\n\n${program.description()}\n`);
    console.log('Commands:');
    for (const r of rows(VISIBLE_COMMANDS)) console.log(line(r));
    console.log('\nHidden commands (not in morse --help; they work as usual):');
    for (const r of rows(LISTED_HIDDEN)) console.log(line(r));
    console.log('\nmorse help <command> — the options and verbs of one command');
  });

// Compatibility (ADR-075): a config.json that still names the retired domain (relay.url /
// update.site on morse.talk) is rewritten once, before any command — the daemon too — reads it.
program.hook('preAction', () => {
  try {
    migrateLegacyDomains(undefined, (line) => console.error(line));
  } catch {
    /* config.json cannot be written (read-only home …): the command goes on with what is there */
  }
});

/**
 * (ADR-083) Right after an update the daemon of the release before may still be running — on a mailbox this
 * release keeps per address (`user_version` 4). It goes by the old rules: mail it files can land under
 * another address's contact, a request it deletes goes at every address, a block made by these commands
 * is invisible to it. So while such a daemon runs for this home:
 *   - EVERY command says the one line on stderr (`morse stop` does not: it is the fix);
 *   - a command that changes contacts, message requests or blocks, or queues mail, REFUSES: exit 1,
 *     nothing changed, nothing queued (with --json the line is also the `error` on stdout);
 *   - everything else works as usual — `morse start`, `update` and `status` included.
 * The upgrade of the mailbox itself is not held back: a mailbox still at the version before is upgraded by
 * the first command that opens it, as ever — a changing command opens it here, then refuses; another
 * command that upgrades it says the line when it ends. No daemon running: nothing is said or refused.
 */
program.hook('preAction', (_program, action) => {
  const path: string[] = [];
  for (let c: Command | null = action; c && c !== program; c = c.parent) path.unshift(c.name());
  if (path[0] === 'stop' || !olderDaemonRunning()) return;
  const perAddress = (): boolean => (mailboxVersion() ?? 0) >= SCHEMA_VERSION_V4;
  if (mailboxVersion() === null) return; // no mailbox here: nothing an older daemon and this command could disagree about
  const refuses = changesContactsOrSends(path);
  if (!perAddress() && refuses) openMailbox(); // the upgrade (said once, with its backup) — then the refusal below
  if (!perAddress()) {
    process.once('exit', () => {
      if (perAddress()) console.error(OLDER_DAEMON_LINE);
    });
    return;
  }
  console.error(OLDER_DAEMON_LINE);
  if (!refuses) return;
  if ((action.opts() as { json?: boolean }).json) console.log(JSON.stringify({ error: OLDER_DAEMON_LINE }));
  process.exit(1);
});

/**
 * (ADR-088 §4) MORSE_ADDRESS=<name|address> — the address of yours this process acts as: every command that takes
 * `--from <name>` and was not given one behaves as if that name had been written (`send` reads it itself: its
 * target may be a session). `--all-addresses` asks for every address here all the same. Unset: nothing changes —
 * the first address for sending, every address for listing. A value that names none of your addresses is one
 * clear line and exit 1.
 */
const takesFrom = (c: Command): boolean => c !== sendCmd && c.options.some((o) => o.long === '--from');
(function everyAddressOption(c: Command): void {
  if (takesFrom(c)) c.option('--all-addresses', 'every address here, also when MORSE_ADDRESS names one');
  c.commands.forEach(everyAddressOption);
})(program);
/** `morse plugin …` (and its hidden aliases): for the plugins, which work for the whole home — no selector applies. */
const underPlugin = (c: Command | null): boolean => (c ? c.name() === 'plugin' || underPlugin(c.parent) : false);
program.hook('preAction', async (_program, action) => {
  if (underPlugin(action)) return;
  if (!takesFrom(action) || action.getOptionValue('from') !== undefined || action.getOptionValue('allAddresses')) return;
  const env = (await import('./commands/known-as.js')).addressFromEnv();
  if (!env) return;
  if ('error' in env) {
    console.error(`error: ${env.error}`);
    process.exit(1);
  }
  action.setOptionValue('from', env.name);
  // (a refusal then says "unset MORSE_ADDRESS", not "leave --from out")
  (await import('./commands/known-as.js')).fromCameFromEnv(true);
});

program.parse();
