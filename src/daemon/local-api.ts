import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../home.js';
import { listRegistered } from '../registry/external.js';
import { CAP_LISTENER_PROOF, readDaemonInfo, type DaemonInfo } from './capabilities.js';
import { isAlive, isMorseDaemon } from './pidfile.js';

/**
 * Who may use the daemon's local API (ADR-087).
 *
 * The API listens on 127.0.0.1 — and that alone protects nothing: any web page the owner opens can post
 * to a loopback port, and any process of any user can connect to it. So every route but a liveness probe
 * needs a secret that only a process able to read THIS home's data directory has:
 *
 *   - the DAEMON TOKEN: random per start, in `daemon.json` (owner-only). The `morse` command, the hooks
 *     and the plugins read it from their own home — which also keeps a command of one Morse home from
 *     ever talking to the daemon of another (its token does not match);
 *   - an EXTERNAL-AGENT TOKEN: long-lived, one per external agent (a desktop app that cannot run
 *     `morse`, ADR-024), in `api-tokens/<agent>` (owner-only), issued by `morse connect`. It opens only
 *     what such an agent needs, and only as that agent;
 *   - a CONSOLE SESSION: what the web console page gets in exchange for a one-time code from
 *     `morse console` (kept by the page for its tab; no cookie — a cookie would be sent to every other
 *     local server on 127.0.0.1 too). It opens only what the console page uses.
 *
 * All of them travel in the `x-morse-token` header — a header no page of another origin can send (it
 * needs a preflight, and a preflight finds nothing here) — never in a URL, never in a cookie.
 */
export const LOCAL_TOKEN_HEADER = 'x-morse-token';
/** `GET /api/ping` with this header (random hex) is answered with `proof` = HMAC-SHA256(daemon token, challenge), hex. */
export const PING_CHALLENGE_HEADER = 'x-morse-challenge';

/** Constant-time comparison (both sides hashed first: no length is leaked either). */
export function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return expected.length > 0 && timingSafeEqual(a, b);
}

export const newToken = (): string => randomBytes(24).toString('hex');

// ---- external-agent tokens -------------------------------------------------------------------
//
// Three files per agent in `api-tokens/` (the directory 0700, each file 0600):
//   <agent>          the token, one line — what the released code wrote, and what instructions written by
//                    it read with `$(cat …)`: unchanged, so an app connected before keeps working;
//   <agent>.header   the same token as a header line (`x-morse-token: …`) — instructions written now pass
//                    it to curl as `-H @<file>`, so the token is not on a command line (`ps` shows those);
//   <agent>.json     what the token is bound to: the session ids it may register and read as (follow-up 1).

const EXTERNAL_AGENT_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const externalTokenDir = (home?: string): string => join(dataDir(home), 'api-tokens');
export const externalTokenPath = (agent: string, home?: string): string => join(externalTokenDir(home), agent);
export const externalHeaderPath = (agent: string, home?: string): string => join(externalTokenDir(home), `${agent}.header`);
const bindingPath = (agent: string, home?: string): string => join(externalTokenDir(home), `${agent}.json`);

/**
 * What an external agent's token is bound to (ADR-087 follow-up 1): the token registers, reads mail and
 * sends as THIS agent, for THESE session ids — never by what a request body says.
 *   sessions  the session ids it is bound to: the ones named at `morse connect --agent … --session …`,
 *             and the ones an `open` app bound itself to;
 *   open      the app picks its own session id, which only it knows (闪电说: an id its runtime gives its
 *             shell — `morse connect sds` cannot know it). Such a token may bind itself to a session id
 *             that is NOBODY ELSE'S (the server checks); a token that is not open never binds anything.
 */
export interface ExternalBinding {
  sessions: string[];
  open: boolean;
}
/** The app integrations whose session id only the app knows: their tokens are `open`. */
const OPEN_AGENTS: readonly string[] = ['sds'];
/** The longest session id a token is bound to (they become file names and are compared on every request). */
export const MAX_EXTERNAL_SESSION_ID = 128;
/**
 * (ADR-089, with ADR-087) How many session ids one token is bound to at most. An `open` token (an app that
 * names its own session ids) binds a new id on every first use: without a bound the list — read and compared
 * on every request — grows for ever. At the limit the OLDEST binding is dropped (the app goes on working; an
 * id it still uses is bound again the next time it registers it, under the same "nobody else's" rule).
 */
export const MAX_EXTERNAL_SESSIONS = 256;

const ownerOnlyDir = (home?: string): string => {
  const dir = externalTokenDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700); // (mkdir's mode is masked by umask)
  } catch {
    /* Windows: the data directory's own protection applies */
  }
  return dir;
};
const writeOwnerOnly = (path: string, text: string): void => {
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }
};
const validAgent = (agent: string): void => {
  if (!EXTERNAL_AGENT_RE.test(agent)) throw new Error(`"${agent}" is not a valid external agent name (a-z 0-9 -, 2–32 characters, starting with a letter)`);
};

function readBindingFile(agent: string, home?: string): ExternalBinding | null {
  try {
    const v = JSON.parse(readFileSync(bindingPath(agent, home), 'utf8')) as { sessions?: unknown; open?: unknown };
    if (!Array.isArray(v.sessions)) return null;
    return { sessions: [...new Set(v.sessions.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_EXTERNAL_SESSION_ID))], open: v.open === true };
  } catch {
    return null;
  }
}
const writeBinding = (agent: string, b: ExternalBinding, home?: string): void => writeOwnerOnly(bindingPath(agent, home), `${JSON.stringify({ v: 1, sessions: b.sessions, open: b.open })}\n`);

/**
 * The binding of `agent`'s token. A token of the release before this follow-up has none on disk: it is given
 * one here, in place, from what that release recorded — the sessions this agent has registered — so nobody has
 * to run `morse connect` again. null: the agent has no token.
 */
export function externalBinding(agent: string, home?: string): ExternalBinding | null {
  if (!EXTERNAL_AGENT_RE.test(agent) || !readExternalToken(agent, home)) return null;
  const onDisk = readBindingFile(agent, home);
  if (onDisk) return onDisk;
  const migrated: ExternalBinding = { sessions: listRegistered({ ...(home ? { home } : {}), includeStale: true }).filter((r) => r.agent === agent).map((r) => r.sessionId).filter((x) => x.length <= MAX_EXTERNAL_SESSION_ID), open: OPEN_AGENTS.includes(agent) };
  try {
    writeBinding(agent, migrated, home);
  } catch {
    /* a read-only home: the same answer is worked out again next time */
  }
  return migrated;
}

/**
 * The token of the external agent `agent` — created (owner-only) when there is none yet, with its header
 * file. `bind`: a session id the token is for (`morse connect --agent … --session …`); `open`: an app that
 * names its own session id (`morse connect sds`).
 */
export function ensureExternalToken(agent: string, home?: string, bind: { session?: string; open?: boolean } = {}): string {
  validAgent(agent);
  if (bind.session !== undefined && (!bind.session || bind.session.length > MAX_EXTERNAL_SESSION_ID)) throw new Error(`a session id for the local API is 1–${MAX_EXTERNAL_SESSION_ID} characters long`);
  ownerOnlyDir(home);
  let token = readExternalToken(agent, home);
  const fresh = !token;
  if (!token) {
    token = newToken();
    writeOwnerOnly(externalTokenPath(agent, home), `${token}\n`);
  }
  let header = '';
  try {
    header = readFileSync(externalHeaderPath(agent, home), 'utf8');
  } catch {
    /* none yet */
  }
  if (header !== `${LOCAL_TOKEN_HEADER}: ${token}\n`) writeOwnerOnly(externalHeaderPath(agent, home), `${LOCAL_TOKEN_HEADER}: ${token}\n`);
  // a token made just now is bound to nothing but what is named here; one from before keeps what it has
  const before = fresh ? { sessions: [], open: false } : (externalBinding(agent, home) ?? { sessions: [], open: false });
  const next: ExternalBinding = { sessions: bind.session && !before.sessions.includes(bind.session) ? [...before.sessions, bind.session] : before.sessions, open: before.open || bind.open === true || (fresh && OPEN_AGENTS.includes(agent)) };
  if (fresh || next.open !== before.open || next.sessions.length !== before.sessions.length || !readBindingFile(agent, home)) writeBinding(agent, next, home);
  return token;
}

/** Bind `agent`'s token to one more session id (the server does, for an `open` token, once it knows the id is nobody else's). */
export function bindExternalSession(agent: string, sessionId: string, home?: string): void {
  const b = externalBinding(agent, home);
  if (!b || b.sessions.includes(sessionId)) return;
  writeBinding(agent, { ...b, sessions: [...b.sessions, sessionId].slice(-MAX_EXTERNAL_SESSIONS) }, home);
}

/** Take a session id out of the binding. true = the token is bound to nothing any more (and is not `open`): it can go. */
export function unbindExternalSession(agent: string, sessionId: string, home?: string): boolean {
  const b = externalBinding(agent, home);
  if (!b) return false;
  const sessions = b.sessions.filter((s) => s !== sessionId);
  if (sessions.length !== b.sessions.length) writeBinding(agent, { ...b, sessions }, home);
  return sessions.length === 0 && !b.open;
}

export function readExternalToken(agent: string, home?: string): string | null {
  try {
    const t = readFileSync(externalTokenPath(agent, home), 'utf8').trim();
    return /^[0-9a-f]{32,}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

export function removeExternalToken(agent: string, home?: string): void {
  if (!EXTERNAL_AGENT_RE.test(agent)) return;
  for (const path of [externalTokenPath(agent, home), externalHeaderPath(agent, home), bindingPath(agent, home)]) rmSync(path, { force: true });
}

/** Which external agent a presented token belongs to — null when to none. Read from disk each time: `morse connect` takes effect at once. */
export function externalAgentOfToken(given: string, home?: string): string | null {
  let names: string[];
  try {
    names = readdirSync(externalTokenDir(home));
  } catch {
    return null;
  }
  let hit: string | null = null;
  for (const name of names) {
    if (!EXTERNAL_AGENT_RE.test(name)) continue; // (the .header and .json files are not tokens)
    const t = readExternalToken(name, home);
    // (every token is compared: how long this takes says nothing about which one matched)
    if (t && sameToken(given, t)) hit = name;
  }
  return hit;
}

// ---- the client side: a command talks to the daemon of ITS OWN home, or to none ---------------

/** Nobody to talk to: thrown the way a refused connection is (`cause.code`), so "the daemon is not running" paths apply. */
export class NoDaemonForThisHome extends Error {
  override readonly cause = { code: 'ECONNREFUSED' as const };
  constructor(
    /** 'none' = this home has no running daemon; 'other' = something answers on that port, and it is not this home's daemon. */
    readonly why: 'none' | 'other',
    readonly port: number | null,
  ) {
    super(NO_DAEMON_LINE);
  }
}
export const NO_DAEMON_LINE = 'no Morse daemon is running for this home — morse start';
export const notThisHomesDaemonLine = (port: number): string => `port ${port} is not this home's Morse daemon — nothing was sent to it; ${NO_DAEMON_LINE}`;

/**
 * The running daemon of this home as its `daemon.json` describes it — null when there is none. A daemon of
 * this release is believed by its token (whoever accepts it wrote that file); one of the release before
 * left no token, so its pid must be a live Morse daemon (by its command line; where that cannot be read, a
 * live pid is believed, as before).
 */
export function daemonOfThisHome(): DaemonInfo | null {
  const info = readDaemonInfo();
  if (!info || !isAlive(info.pid)) return null;
  if (!info.token && isMorseDaemon(info.pid) === 'no') return null;
  return info;
}

/** A `--port` a command was given, as a number — undefined when none was: the port is then this home's daemon's. */
export const explicitPort = (raw: string | number | undefined): number | undefined => (raw === undefined || raw === '' ? undefined : Number.parseInt(String(raw), 10) || undefined);

export interface LocalApiInit {
  method?: 'GET' | 'POST';
  /** Sent as JSON (with the content type the daemon requires). */
  json?: unknown;
  /** A port a command was given (`--port`). It must be the one this home's daemon.json names — any other is refused, unasked. */
  port?: number | undefined;
  timeoutMs?: number;
}

/** Listeners this process has already seen prove that they hold this home's token (`port token`). */
const proven = new Set<string>();

/**
 * Is the listener on `port` the daemon that wrote this home's daemon.json? Asked WITHOUT presenting the token:
 * a random challenge goes to the open liveness probe, and only the holder of the token can answer it.
 * Throws what `fetch` throws when nobody listens.
 */
async function listenerHoldsToken(port: number, token: string, timeoutMs: number): Promise<boolean> {
  const key = `${port} ${token}`;
  if (proven.has(key)) return true;
  const challenge = randomBytes(24).toString('hex');
  const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { headers: { [PING_CHALLENGE_HEADER]: challenge }, signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)) });
  const body = (await res.json().catch(() => null)) as { proof?: unknown } | null;
  const ok = res.ok && typeof body?.proof === 'string' && sameToken(body.proof, createHmac('sha256', token).update(challenge).digest('hex'));
  if (ok) proven.add(key);
  return ok;
}

/**
 * One request to the local API of THIS home's daemon, with this home's token. Never to anything else:
 * no daemon.json here (or a dead daemon's) = `NoDaemonForThisHome('none')`, nothing is sent; a port that is
 * not the one daemon.json names, or a listener that cannot prove it holds this home's token =
 * `NoDaemonForThisHome('other')` — and the token is NOT presented to it (follow-up 2: `--port` used to send
 * this home's token to whatever listened there).
 */
export async function localApi(path: string, init: LocalApiInit = {}): Promise<Response> {
  const info = daemonOfThisHome();
  const port = init.port ?? info?.port ?? null;
  if (!info || port === null) throw new NoDaemonForThisHome('none', port);
  // a port other than this home's daemon's is somebody else's listener, whatever it is
  if (info.port !== port) throw new NoDaemonForThisHome('other', port);
  const timeoutMs = init.timeoutMs ?? 5000;
  // a daemon of this release proves itself before it is shown the token (a stale daemon.json whose port another
  // program took over would otherwise be handed it)
  if (info.token && info.capabilities.includes(CAP_LISTENER_PROOF) && !(await listenerHoldsToken(port, info.token, timeoutMs))) throw new NoDaemonForThisHome('other', port);
  const headers: Record<string, string> = {};
  if (info.token) headers[LOCAL_TOKEN_HEADER] = info.token;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) {
    await res.arrayBuffer().catch(() => undefined);
    throw new NoDaemonForThisHome('other', port);
  }
  return res;
}
