import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../file-lock.js';
import { dataDir } from '../home.js';
import { isAlive, readPid, runningDaemonPid } from './pidfile.js';

/**
 * What the running daemon can do that a command has to know BEFORE it hands mail over (ADR-081 review N1).
 * Right after an update the daemon of the release before may still be running: it ignores a sending
 * address, so mail meant to go out from another of your addresses would leave from the first one,
 * with the old name and the device certificate. A command that needs a specific sending address
 * therefore asks first, and hands nothing to a daemon that does not say it can.
 *
 * Where a daemon says it:
 *   - `GET /api/peers` of its console (loopback) answers `capabilities: [...]`;
 *   - `POST /api/send` echoes the address the message will be sent from (`sentFrom`);
 *   - `daemon.json` next to the pid file names its pid and console port — only a daemon of this
 *     release (or later) writes it, so a live pid without it is an older daemon, on whatever port.
 */
export const CAP_FROM_ADDRESS = 'from-address';
/**
 * (ADR-083) This daemon keeps contacts, message requests and blocks per address of this computer (mailbox
 * `user_version` 4). One that does not say so is of the release before: on a migrated database it still files
 * mail under whatever contact row the sender has (another address's, too), deletes a request at every address
 * and does not see a block made by this release's commands — see `olderDaemonRunning` below.
 */
export const CAP_CONTACTS_PER_ADDRESS = 'contacts-per-address';
/**
 * (ADR-087) This daemon's local API answers only a caller that presents this home's token (daemon.json), an
 * external agent's own token, or a console session — and never a web page. One that does not say so is of a
 * release before: any page the owner opens can queue mail through it, so it has to be restarted.
 */
export const CAP_LOCAL_API_AUTH = 'local-api-auth';
/**
 * (ADR-087 follow-up 2) This daemon's `GET /api/ping` answers a challenge with HMAC(token, challenge): a command
 * checks that the listener on the port IS its home's daemon before it presents the token. A daemon that does
 * not say so (the first ADR-087 release) is presented the token as that release did. Not a required
 * capability: nothing is refused for its absence.
 */
export const CAP_LISTENER_PROOF = 'listener-proof';
/**
 * (ADR-091) This daemon reaches every contact by address and takes nobody's mail as yours (no owner tier, no `self`
 * group of computers): the database it works on is at schema v5. A daemon that does not say so (the release before)
 * still gives your computers paired the old way your authority — it has to be restarted.
 */
export const CAP_ADDRESSES_ONLY = 'addresses-only';
export const DAEMON_CAPABILITIES: readonly string[] = [CAP_FROM_ADDRESS, CAP_CONTACTS_PER_ADDRESS, CAP_LOCAL_API_AUTH, CAP_LISTENER_PROOF, CAP_ADDRESSES_ONLY];
/** What a daemon must say for this release's commands to work with it (`olderDaemonRunning`). */
const REQUIRED_CAPABILITIES: readonly string[] = [CAP_CONTACTS_PER_ADDRESS, CAP_LOCAL_API_AUTH, CAP_ADDRESSES_ONLY];

/** The one line for a command that needs a sending address while the running daemon is older. */
export const OLD_DAEMON_LINE = 'the running Morse daemon is older than this command — restart it: morse stop --restart';

/**
 * (ADR-083) The one line EVERY command says (stderr) while a daemon of the release before is running on a
 * database that already keeps contacts per address — and all a command that would change contacts,
 * requests or blocks, or queue mail, says before it refuses.
 */
export const OLDER_DAEMON_LINE = 'the running Morse daemon is older than this version — restart it: morse stop --restart';

export interface DaemonInfo {
  pid: number;
  /** The console port; null = started without a console. */
  port: number | null;
  capabilities: string[];
  /**
   * ADR-087 (was ADR-080, for `POST /api/shutdown` alone): the daemon token — what EVERY route of the local
   * API must be given in the `x-morse-token` header. Random per start; only someone who can read the data
   * directory has it — a web page posting to the loopback port does not, nor does a command of another
   * Morse home. A daemon of this release always writes one; one of a release before may have none.
   */
  token?: string;
}

const infoFile = (): string => join(dataDir(), 'daemon.json');

export function writeDaemonInfo(info: DaemonInfo): void {
  const path = infoFile();
  mkdirSync(dirname(path), { recursive: true });
  // written whole or not at all: a command that reads it while the daemon starts must never see half a file
  // (it would take the daemon for absent — and since ADR-087 every command reads this file)
  writeFileAtomic(path, `${JSON.stringify(info)}\n`, { mode: 0o600 });
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const v = JSON.parse(readFileSync(infoFile(), 'utf8')) as Partial<DaemonInfo>;
    if (typeof v.pid !== 'number' || !Array.isArray(v.capabilities)) return null;
    return { pid: v.pid, port: typeof v.port === 'number' ? v.port : null, capabilities: v.capabilities.filter((c): c is string => typeof c === 'string'), ...(typeof v.token === 'string' && v.token ? { token: v.token } : {}) };
  } catch {
    return null;
  }
}

/** Remove daemon.json — only the daemon that wrote it does (ownPid). */
export function clearDaemonInfo(ownPid: number): void {
  try {
    if (readDaemonInfo()?.pid !== ownPid) return;
    rmSync(infoFile());
  } catch {
    /* already gone */
  }
}

/**
 * Can the daemon that is running send from a named address?
 *   yes     it says so (its console, or its daemon.json when the console is not reachable);
 *   old     a daemon answers, or is alive, and does not say so — the release before;
 *   none    no daemon is running;
 *   silent  something holds the port but did not answer in time: cannot tell.
 * (ADR-087) Only THIS home's daemon counts — the one its daemon.json describes — and it is asked with this
 * home's token. `port`: a console port a command was given (`--port`); without one the port daemon.json
 * gives. Whatever else listens on a port (another Morse home's daemon on the default one) is never asked.
 */
export async function daemonSendsFromAddress(port?: number, timeoutMs = 3000): Promise<'yes' | 'old' | 'none' | 'silent'> {
  // (ADR-087) only THIS home's daemon is ever asked — the one its daemon.json describes; whatever else may be
  // listening on a port is not talked to
  const { daemonOfThisHome, localApi, NoDaemonForThisHome } = await import('./local-api.js');
  const mine = daemonOfThisHome();
  // a live Morse daemon that left no daemon.json is one of a release before, on whatever port
  // (a pid file whose pid belongs to another program by now names no daemon — ADR-083 review N3)
  if (!mine) return runningDaemonPid() !== null ? 'old' : 'none';
  const says = mine.capabilities.includes(CAP_FROM_ADDRESS);
  const ask = port ?? mine.port;
  if (ask === null) return says ? 'yes' : 'old';
  try {
    const res = await localApi('/api/peers', { port: ask, timeoutMs });
    const body = (await res.json().catch(() => null)) as { capabilities?: unknown } | null;
    return Array.isArray(body?.capabilities) && body.capabilities.includes(CAP_FROM_ADDRESS) ? 'yes' : 'old';
  } catch (e) {
    // what answers there is not this home's daemon: this home's own (alive, by its daemon.json) has no console there
    if (e instanceof NoDaemonForThisHome) return says ? 'yes' : 'old';
    // (it did not answer in time: its own daemon.json — asked for only without --port — is word enough)
    if ((e as { cause?: { code?: string } })?.cause?.code !== 'ECONNREFUSED') return port === undefined && says ? 'yes' : 'silent';
    // nobody listens there: a daemon of this release without a console (or on another port) has said so in daemon.json
    return says ? 'yes' : 'old';
  }
}

/**
 * (ADR-083) Is a daemon running for THIS home that does not keep contacts per address? Told from the files
 * next to the mailbox alone (no port is asked — every command asks this): the pid file names a live
 * process, and no daemon.json of that very pid says `contacts-per-address` (the release before wrote no
 * daemon.json, or one without it). No daemon — or this process itself, starting up — is not one.
 *
 * (review N3) "A live process" is not yet "a Morse daemon": after a crash or a reboot the pid in a left-over
 * pid file belongs to some other program of the user sooner or later. Before this says "an older daemon is
 * running" — every changing command refuses then, and the advice is `morse stop`, which signals that pid —
 * the process must read like a Morse daemon (`runningDaemonPid`); a pid file that names another program is
 * stale: it is removed and nothing is said. Asked only when the answer would be yes: a daemon of this
 * release (the usual case) costs no look at the process table.
 */
export function olderDaemonRunning(): boolean {
  const pid = readPid();
  if (pid === null || pid === process.pid || !isAlive(pid)) return false;
  const info = readDaemonInfo();
  if (info && info.pid === pid && REQUIRED_CAPABILITIES.every((c) => info.capabilities.includes(c))) return false;
  return runningDaemonPid() === pid;
}

/**
 * (ADR-083) The commands that change contacts, message requests or blocks, or queue mail — by their path
 * (`contact add` = ['contact', 'add']), hidden aliases included. While an older daemon runs on a database
 * that is kept per address these refuse (exit 1, nothing changed, nothing queued); every other command
 * only says the line. `contact` / `requests` with no verb only list.
 */
const CHANGING_COMMANDS: ReadonlySet<string> = new Set([
  'send',
  'reply',
  'contact add',
  'contact set',
  'contact remove',
  'contact accept',
  'contact reject',
  'contact block',
  'contact unblock',
  // the names from before ADR-074
  'block',
  'unblock',
  'requests accept',
  'requests reject',
  'requests block',
  'requests decline',
]);
export const changesContactsOrSends = (path: readonly string[]): boolean => CHANGING_COMMANDS.has(path.join(' '));
