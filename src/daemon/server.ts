import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { SessionInfo } from '../adapters/types.js';
import type { Peer } from '../cluster/peers.js';
import type { RelayState } from '../cluster/relay-client.js';
import type { UntrustedContact } from '../cluster/secure-transport.js';
import type { TrustStore } from '../cluster/trust.js';
import type { Mailbox, MessageFile, SessionRef } from '../mailbox/mailbox.js';
import { DAEMON_CAPABILITIES } from './capabilities.js';
import { bindExternalSession, externalAgentOfToken, externalBinding, LOCAL_TOKEN_HEADER, MAX_EXTERNAL_SESSION_ID, PING_CHALLENGE_HEADER, sameToken } from './local-api.js';

// The daemon's local HTTP API: what the `morse` command, hooks, plugins, external apps and the web console
// talk to. It listens on 127.0.0.1 only; other computers reach the daemon through the mutual-TLS peer
// server (ADR-028). Every route, and who may call it, is listed in LOCAL_API_ROUTES (ADR-087).

/** The web console page shipped with the package (webui/index.html). */
const CONSOLE_PAGE = fileURLToPath(new URL('../../webui/index.html', import.meta.url));

export interface ConsoleServerOptions {
  mailbox: Mailbox;
  /**
   * ADR-087: the daemon token — random per start, written to daemon.json (owner-only). Every route but the
   * ones marked `none` in LOCAL_API_ROUTES needs it (or a narrower credential) in the `x-morse-token` header.
   * Required: there is no way to start this server without it.
   */
  token: string;
  /** The session directory (local sessions plus registered external ones). */
  directory: () => Promise<SessionInfo[]>;
  /** Listening port on 127.0.0.1 (default 7433). */
  port?: number;
  /** How often to look for mailbox writes made by other processes (a `morse send` in a shell, hooks). */
  changePollMs?: number;
  /** Home folder of the external-agent registry (ADR-024); default the user's home. Tests point it elsewhere. */
  registryHome?: string;
  /** Forget the caller's cached directory. Called after an external agent registers, so it can be addressed
   *  right away instead of answering "not found" until the cache runs out. */
  invalidateDirectory?: () => void;
  /** Check a LOCAL target before anything is queued (ADR-025). A string refuses the send with 409 and that
   *  text, so the sender learns about e.g. a CLI version mismatch now rather than through a dead letter. */
  preflight?: (session: SessionInfo) => Promise<string | null>;
  /** Morse: a paired device reachable through the relay. Lets /api/send address
   *  `@device/agent:session` directly — the relay carries no session directory. */
  knowsDevice?: (device: string) => boolean;
  /** Morse: pair a person by handle through the relay on first contact
   *  (`morse send morse.im/<handle>` with nobody paired yet). waiting = the relay is
   *  unreachable right now — the message is queued and the lookup retried. */
  pairPerson?: (handle: string) => Promise<{ ok: boolean; waiting?: boolean; error?: string }>;
  /** Morse (ADR-081): would this target (sent from the address of ours named `from`) go by address
   *  alone, and can it? null = no — the usual resolution below. `ok: false` without `waiting` = it
   *  cannot be sent (too old, nobody published it …): refused with that one line, nothing queued. */
  addressRoute?: (target: string, from?: string | null) => Promise<null | { ok: true; address: string; from?: string } | { ok: false; waiting?: boolean; error: string }>;
  /**
   * Morse (ADR-081 review: legacy rows): which address of this computer a `fromAddress` is (a local name, or the
   * address itself) and its name here. null = none. The ADDRESS is recorded with the queued message —
   * a name alone never is. Without this, a `fromAddress` that is a name is refused.
   */
  ownAddress?: (from: string) => { address: string; name: string | null; /** (ADR-088) the name the relay directory has for it: what a row keeps */ directory?: string | null } | null;
  /** Morse (ADR-081): writing to an address accepts it — unblocked, its request moved in, a contact. */
  acceptAddress?: (address: string, /** (ADR-083) the address of ours that writes: it becomes THAT address's contact */ from?: string | null) => string | null;
  /** Morse (ADR-037): a message request was accepted (by the CLI) — tell that person's
   *  devices so they send what they held back. Resolves to how many got it. */
  notifyAccepted?: (handle: string, deviceId: string, /** (ADR-083) the address of ours that accepted ('' = the first) */ myAddress?: string) => Promise<number>;
  /** (ADR-088 §6) `morse address add` / `remove` changed the addresses on disk: take them on without a restart. */
  reloadAddresses?: () => { added: string[]; removed: string[] };
  /** Morse: copy files to attach into the outbox (0600); throws when too large. */
  stageFiles?: (paths: string[]) => MessageFile[];
  /** Morse (ADR-038): how many chunks these files go in (0 = inline, one envelope). */
  chunksFor?: (files: MessageFile[], text: string) => number;
  /** Morse (ADR-038): progress of an outgoing chunked message (`morse send --file` shows it). */
  transferStatus?: (msgId: string) => unknown;
  /**
   * ADR-080: the orderly stop that needs no signal (Windows has none) — `POST /api/shutdown`
   * with the daemon token (ADR-087: like every other route) runs `run` after answering.
   */
  shutdown?: { run: () => void };
  /** ADR-039: auto-update view for `morse update` — is a file transfer in progress (defer)? */
  updateStatus?: () => { busy: string | null; release: number; version: string };
  /** What GET /api/peers reports. The peer API itself runs on its own mutual-TLS server (ADR-028). */
  peering?: {
    /** This computer's device name and id. */
    selfDevice: string;
    selfId: string;
    /** Peers seen on the LAN right now (mDNS and static entries); absent = relay only, no LAN discovery. */
    peers?: () => Peer[];
    /** Paired devices. */
    trust?: TrustStore;
    /** Devices with a valid certificate that tried to reach us without being paired. */
    pending?: () => UntrustedContact[];
    /** Morse relay status (when configured). */
    relay?: () => { url: string; connected: boolean; state?: RelayState } | null;
  };
}

export interface RunningServer {
  port: number;
  /** Tell every open event stream that something changed. */
  notifyChange(): void;
  /** Stop polling, end the event streams and stop listening. */
  close(): void;
}

/**
 * ADR-087 — every route of the local API, and who may call it. THE list: a request is matched against it
 * before anything else is looked at, the caller is checked against `auth` in one place, and the handlers
 * below are reached by `name` only — a route that is not here does not exist, and an entry cannot be
 * written without saying who may use it.
 *
 *   none      no credential (the liveness probe; the static console page, which holds no data; the exchange
 *             of a one-time code for a console session)
 *   daemon    the daemon token of this home's daemon.json — the `morse` command, hooks, plugins
 *   console   a console session (the web console page, after `morse console`)
 *   external  an external agent's own token (`morse connect`, ADR-024) — and only as that agent
 */
export type LocalApiAuth = 'none' | 'daemon' | 'console' | 'external';
export interface LocalApiRoute {
  name: string;
  method: 'GET' | 'POST';
  path: string | RegExp;
  /** A concrete path that matches (for tests that walk the list). */
  example: string;
  auth: readonly LocalApiAuth[];
}
export const LOCAL_API_ROUTES = [
  { name: 'ping', method: 'GET', path: '/api/ping', example: '/api/ping', auth: ['none'] },
  { name: 'consolePage', method: 'GET', path: /^\/(?:index\.html|console)?$/, example: '/', auth: ['none'] },
  { name: 'consoleSession', method: 'POST', path: '/api/console/session', example: '/api/console/session', auth: ['none'] },
  { name: 'consoleCode', method: 'POST', path: '/api/console/code', example: '/api/console/code', auth: ['daemon'] },
  { name: 'shutdown', method: 'POST', path: '/api/shutdown', example: '/api/shutdown', auth: ['daemon'] },
  { name: 'sessions', method: 'GET', path: '/api/sessions', example: '/api/sessions', auth: ['daemon', 'console', 'external'] },
  { name: 'register', method: 'POST', path: '/api/register', example: '/api/register', auth: ['daemon', 'external'] },
  { name: 'inbox', method: 'POST', path: '/api/inbox', example: '/api/inbox', auth: ['daemon', 'external'] },
  { name: 'peers', method: 'GET', path: '/api/peers', example: '/api/peers', auth: ['daemon'] },
  { name: 'conversations', method: 'GET', path: '/api/conversations', example: '/api/conversations', auth: ['daemon', 'console'] },
  { name: 'conversationMessages', method: 'GET', path: /^\/api\/conversations\/([0-9a-f-]+)\/messages$/, example: '/api/conversations/00000000-0000-4000-8000-000000000000/messages', auth: ['daemon', 'console'] },
  { name: 'send', method: 'POST', path: '/api/send', example: '/api/send', auth: ['daemon', 'external'] },
  { name: 'transfer', method: 'GET', path: /^\/api\/morse\/transfer\/([^/]+)$/, example: '/api/morse/transfer/x', auth: ['daemon'] },
  { name: 'update', method: 'GET', path: '/api/update', example: '/api/update', auth: ['daemon'] },
  { name: 'messages', method: 'POST', path: '/api/messages', example: '/api/messages', auth: ['daemon', 'console'] },
  { name: 'accepted', method: 'POST', path: '/api/morse/accepted', example: '/api/morse/accepted', auth: ['daemon'] },
  { name: 'retry', method: 'POST', path: /^\/api\/messages\/([0-9a-f-]+)\/retry$/, example: '/api/messages/00000000-0000-4000-8000-000000000000/retry', auth: ['daemon', 'console'] },
  { name: 'events', method: 'GET', path: '/api/events', example: '/api/events', auth: ['daemon', 'console'] },
  { name: 'addressesReload', method: 'POST', path: '/api/addresses/reload', example: '/api/addresses/reload', auth: ['daemon'] },
] as const satisfies readonly LocalApiRoute[];
export type LocalApiRouteName = (typeof LOCAL_API_ROUTES)[number]['name'];

/** Who a request comes from, once its credential was checked. */
type Caller = { kind: 'daemon' } | { kind: 'console' } | { kind: 'external'; agent: string };

/** What an unauthenticated caller is told — the same words whatever was wrong, and nothing about why. */
export const UNAUTHORIZED = 'unauthorized — this Morse daemon answers only the morse command of its own home and release (update: morse update; an app that was connected before: morse connect <app> --apply)';
const FORBIDDEN = 'forbidden';

/** A refusal with its HTTP status, thrown from inside a handler. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The largest request body the API reads (text and file PATHS travel here — never file contents). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CONSOLE_CODE_TTL_MS = 60_000;
const CONSOLE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PORT = 7433;
const DEFAULT_CHANGE_POLL_MS = 1500;
/** The most sessions one /api/sessions answer lists when a limit is asked for. */
const MAX_SESSION_LIMIT = 200;

const REGISTER_USAGE = 'expected {agent, sessionId, title?, cwd?}';
const MESSAGES_USAGE = 'expected {from:{agent,sessionId}, to:{agent,sessionId}, text, conversationId?}';
const NO_RELAY = 'Morse relay is not enabled on this daemon';

// ---------------------------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------------------------

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, JSON_HEADERS);
  res.end(text);
}

/**
 * The JSON body of a request. ADR-087: only `Content-Type: application/json` is read — a web page can post
 * `text/plain` to a loopback port without the browser asking first (a "simple" cross-origin request), and
 * what it posted used to be parsed as JSON all the same. An empty body reads as `{}`.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const mediaType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    req.resume();
    throw new HttpError(415, 'the body must be sent as Content-Type: application/json');
  }
  // An oversized body is still read to the end (and dropped) so the sender gets an answer rather than a reset.
  let total = 0;
  const kept: Buffer[] = [];
  for await (const piece of req as AsyncIterable<Buffer>) {
    total += piece.length;
    if (total > MAX_BODY_BYTES) kept.length = 0;
    else kept.push(piece);
  }
  if (total > MAX_BODY_BYTES) throw new HttpError(413, 'the request body is too large');
  const text = Buffer.concat(kept).toString('utf8');
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'the body is not valid JSON');
  }
}

/** Has the shape of a SessionRef: an object with string `agent` and `sessionId`. */
function looksLikeSessionRef(value: unknown): value is SessionRef {
  if (typeof value !== 'object' || value === null) return false;
  const { agent, sessionId } = value as Record<string, unknown>;
  return typeof agent === 'string' && typeof sessionId === 'string';
}

/** The machine-readable code of a preflight refusal: its leading `<code>:`, else 'preflight_failed'. */
function refusalCode(refusal: string): string {
  const match = refusal.match(/^([a-z_]+):/);
  return match ? match[1]! : 'preflight_failed';
}

/** A positive `limit` query parameter, capped at MAX_SESSION_LIMIT; `fallback` when absent or nonsense. */
function limitParam(params: URLSearchParams, fallback: number | null): number | null {
  const asked = Number.parseInt(params.get('limit') ?? '', 10);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_SESSION_LIMIT) : fallback;
}

/**
 * GET /api/sessions for the daemon token and the console. A real directory can hold thousands of
 * sessions — fine for the console page, far too much inside an agent's turn — so `agent`, `q` (text in the
 * title or folder, any case) and `limit` narrow it. Without them the answer is the whole directory.
 */
function narrowSessions(all: SessionInfo[], params: URLSearchParams): SessionInfo[] {
  const agent = params.get('agent')?.toLowerCase();
  const text = params.get('q')?.toLowerCase();
  const limit = limitParam(params, null);
  const hits = all.filter(
    (s) =>
      (!agent || s.agent === agent) &&
      (!text || s.title.toLowerCase().includes(text) || s.cwd.toLowerCase().includes(text)),
  );
  return limit === null ? hits : hits.slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Change notification: the event stream and the mailbox poll
// ---------------------------------------------------------------------------------------------

const eventLine = (kind: 'hello' | 'changed'): string => `data: {"kind":"${kind}"}\n\n`;

/** Open server-sent-event streams (`/api/events`); each gets `{"kind":"changed"}` when something moved. */
function createEventStreams() {
  const open = new Set<ServerResponse>();
  return {
    attach(req: IncomingMessage, res: ServerResponse): void {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(eventLine('hello'));
      open.add(res);
      req.on('close', () => open.delete(res));
    },
    changed(): void {
      const line = eventLine('changed');
      for (const res of open) res.write(line);
    },
    endAll(): void {
      for (const res of open) res.end();
    },
  };
}

/**
 * Watch the mailbox for writes this process did not announce (other processes share the database).
 * A fingerprint of the message table — count, newest update, and the last row's id, update time and
 * status — is compared on every tick; `onChange` fires when it differs from the previous one.
 */
function watchMailbox(mailbox: Mailbox, everyMs: number, onChange: () => void): NodeJS.Timeout {
  let previous: string | undefined;
  return setInterval(() => {
    try {
      const all = mailbox.inbox({ all: true });
      const last = all.at(-1);
      let newest = 0;
      for (const m of all) if (m.updatedAt > newest) newest = m.updatedAt;
      const fingerprint = JSON.stringify([all.length, newest, last?.id, last?.updatedAt, last?.status]);
      if (previous !== undefined && fingerprint !== previous) onChange();
      previous = fingerprint;
    } catch {
      // a busy or locked database now and then is no reason to stop watching
    }
  }, everyMs);
}

/** Short-lived random tokens with an expiry (console codes and console sessions, ADR-087). */
function createTokenJar(ttlMs: number) {
  const expiry = new Map<string, number>();
  const prune = (): void => {
    const t = Date.now();
    for (const [token, until] of expiry) if (until <= t) expiry.delete(token);
  };
  /** The stored token equal to `given` (compared in constant time, every one of them), or null. */
  const find = (given: string): string | null => {
    prune();
    let hit: string | null = null;
    for (const token of expiry.keys()) if (sameToken(given, token)) hit = token;
    return hit;
  };
  return {
    ttlMs,
    issue(): string {
      prune();
      const token = randomBytes(24).toString('hex');
      expiry.set(token, Date.now() + ttlMs);
      return token;
    },
    holds: (given: string): boolean => find(given) !== null,
    /** Use up a token once: true when it was valid. */
    redeem(given: string): boolean {
      const hit = find(given);
      if (hit !== null) expiry.delete(hit);
      return hit !== null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

/** What a handler answers: a JSON reply, or nothing when it wrote the response itself. */
type Reply = { status: number; body: unknown } | void;
const reply = (status: number, body: unknown): Reply => ({ status, body });

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  caller: Caller | null;
  /** The agent name of an external caller (ADR-087: it acts as itself only), else null. */
  external: string | null;
  /** The id a route with a pattern captures from the path (a message or conversation id). */
  param(): string;
  /** The request's JSON body. */
  body<T>(): Promise<T>;
  /** Run `fn` once the reply has been written. */
  afterReply(fn: () => void): void;
}

/** Local-only web console: REST + SSE + static UI, bound to 127.0.0.1. */
export function startConsoleServer(opts: ConsoleServerOptions): RunningServer {
  const port = opts.port ?? DEFAULT_PORT;
  const streams = createEventStreams();
  const poll = watchMailbox(opts.mailbox, opts.changePollMs ?? DEFAULT_CHANGE_POLL_MS, streams.changed);
  const changed = streams.changed;
  /** one-time codes handed to `morse console`, traded once by the page it opens for a session */
  const consoleCodes = createTokenJar(CONSOLE_CODE_TTL_MS);
  /** console sessions, kept by the page in sessionStorage and sent in the token header */
  const consoleSessions = createTokenJar(CONSOLE_SESSION_TTL_MS);
  const homeOpt = opts.registryHome ? { home: opts.registryHome } : {};

  /** The names this server answers to: its loopback addresses with ITS port (a name that merely resolves here is not one — DNS rebinding). */
  const ownHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  /** Who is calling — null when the request carries no valid credential. */
  const callerOf = (req: IncomingMessage): Caller | null => {
    const given = req.headers[LOCAL_TOKEN_HEADER];
    if (typeof given !== 'string' || !given) return null;
    if (sameToken(given, opts.token)) return { kind: 'daemon' };
    if (consoleSessions.holds(given)) return { kind: 'console' };
    const agent = externalAgentOfToken(given, opts.registryHome);
    return agent ? { kind: 'external', agent } : null;
  };

  /**
   * Turn away what must never reach a handler, before any credential is looked at. Returns the refusal,
   * or null to go on.
   */
  const screen = (req: IncomingMessage, path: string): { status: number; error: string } | null => {
    if (path.startsWith('/api/peer/')) {
      // the peer API moved off this plaintext port onto the mutual-TLS peer port (ADR-028)
      return { status: 404, error: 'the peer API is served over mutual TLS on the peer port (ADR-028)' };
    }
    // bound to 127.0.0.1 anyway; checked again as defence in depth
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      return { status: 403, error: 'local console endpoints are loopback-only' };
    }
    // ---- ADR-087: what a browser on some other page could send is turned away before anything else ----
    // no CORS, ever: a preflight finds nothing here, so no page can send the token header or a JSON body cross-origin
    if (req.method === 'OPTIONS') return { status: 404, error: 'not found' };
    // the Host must be this server's own loopback name and port (DNS rebinding: a page on evil.example whose
    // name was re-pointed at 127.0.0.1 still says `Host: evil.example`)
    const host = (req.headers.host ?? '').toLowerCase();
    if (!ownHosts.has(host)) return { status: 403, error: FORBIDDEN };
    // an Origin header means a browser: only this server's own page may talk to it (the `morse` command sends none)
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) return { status: 403, error: FORBIDDEN };
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return { status: 403, error: FORBIDDEN };
    return null;
  };

  function ping({ req }: RequestContext): Reply {
    // the liveness probe: says that a Morse daemon listens here, and nothing else.
    // (ADR-087 follow-up 2) A command proves to itself that the listener is ITS home's daemon before it presents
    // the token: it sends a random challenge and gets back HMAC(token, challenge) — which only the process
    // that holds this home's token can compute, and which gives nothing of the token away.
    const challenge = req.headers[PING_CHALLENGE_HEADER];
    const proof = typeof challenge === 'string' && /^[0-9a-f]{32,128}$/.test(challenge) ? createHmac('sha256', opts.token).update(challenge).digest('hex') : null;
    return reply(200, { morse: true, ...(proof ? { proof } : {}) });
  }

  function consolePage({ res }: RequestContext): Reply {
    // static: the page holds no data and no secret — it asks for both with a console session.
    // Read on every request, so an updated install serves its new page without a restart.
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(readFileSync(CONSOLE_PAGE, 'utf8'));
  }

  function consoleCode(): Reply {
    // `morse console`: a one-time code the page it opens trades for a session (60 s, single use)
    return reply(201, { code: consoleCodes.issue(), expiresInMs: consoleCodes.ttlMs });
  }

  async function consoleSession({ body }: RequestContext): Promise<Reply> {
    const { code } = await body<{ code?: unknown }>();
    if (typeof code !== 'string' || !code || !consoleCodes.redeem(code)) return reply(401, { error: UNAUTHORIZED });
    return reply(201, { token: consoleSessions.issue(), expiresInMs: consoleSessions.ttlMs });
  }

  function shutdown({ afterReply }: RequestContext): Reply {
    if (!opts.shutdown) return reply(404, { error: 'not found' });
    afterReply(opts.shutdown.run);
    return reply(202, { ok: true, pid: process.pid });
  }

  async function sessions({ url, external }: RequestContext): Promise<Reply> {
    const all = await opts.directory();
    if (!external) return reply(200, { sessions: narrowSessions(all, url.searchParams) });
    // (ADR-087 follow-up 1) an external agent gets what it needs to NAME a target — `@<agent>:<part of the
    // title>` — and nothing else: no session id, no directory. A search matches the TITLE only (ADR-089: it
    // used to match the project folder's name too — a way to learn, by asking, what the folders of sessions
    // are called, which the answer itself never shows), and the list is always bounded.
    const q = url.searchParams.get('q')?.toLowerCase() ?? '';
    const agent = url.searchParams.get('agent')?.toLowerCase() ?? '';
    const limit = limitParam(url.searchParams, 50)!;
    const sessions = all
      .filter((x) => (!agent || x.agent === agent) && (!q || x.title.toLowerCase().includes(q)))
      .slice(0, limit)
      .map((x) => ({ agent: x.agent, title: x.title, lastActiveAt: x.lastActiveAt, ...(x.device ? { device: x.device } : {}) }));
    return reply(200, { sessions });
  }


  function peers(): Reply {
    // (ADR-081 review N1) `capabilities`: what a command may rely on before it posts — a daemon of the release
    // before answers without it, and `morse send --from` then hands it nothing
    const capabilities = DAEMON_CAPABILITIES;
    const peering = opts.peering;
    if (!peering) return reply(200, { lan: false, self: null, peers: [], capabilities });
    const self = { device: peering.selfDevice, id: peering.selfId };
    const trusted = peering.trust?.list() ?? [];
    const relay = peering.relay?.() ?? null;
    // relay only (Morse, --no-lan): no LAN discovery, but the paired devices and their tiers
    if (!peering.peers) return reply(200, { lan: false, self, peers: [], trusted, relay, capabilities });
    const peers = peering.peers().map((p) => {
      const pairedAs = p.id ? peering.trust?.get(p.id) : undefined;
      return { ...p, paired: Boolean(pairedAs), ...(pairedAs ? { trustedName: pairedAs.name } : {}) };
    });
    return reply(200, { lan: true, self, peers, trusted, pending: peering.pending?.() ?? [], relay, capabilities });
  }



  function transfer({ param }: RequestContext): Reply {
    // ADR-038: how far an outgoing message (and its chunked files) is
    const id = decodeURIComponent(param());
    const message = opts.mailbox.getMessage(id);
    if (!message) return reply(404, { error: 'no such message' });
    return reply(200, { message, transfer: opts.transferStatus?.(id) ?? null });
  }


  async function messages({ body, caller }: RequestContext): Promise<Reply> {
    const input = await body<{ from?: unknown; to?: unknown; text?: unknown; conversationId?: unknown }>();
    const { from, to, text } = input;
    if (!looksLikeSessionRef(from) || !looksLikeSessionRef(to) || typeof text !== 'string' || text.trim() === '') {
      return reply(400, { error: MESSAGES_USAGE });
    }
    // (ADR-087 follow-up 4) the web console wires sessions on THIS computer together: a console session names no
    // other device or address — mail to a contact is `morse send`'s, which the owner runs in a terminal
    if (caller?.kind === 'console' && (to.device !== undefined || from.device !== undefined)) {
      return reply(403, { error: 'the web console sends between sessions here only — for another address use: morse send' });
    }
    // a local target is checked first (ADR-025); one on another device by its own daemon when it arrives
    if (!to.device && opts.preflight) {
      const session = (await opts.directory()).find((s) => !s.device && s.agent === to.agent && s.sessionId === to.sessionId);
      const refusal = session ? await opts.preflight(session) : null;
      if (refusal) return reply(409, { error: refusal, code: refusalCode(refusal) });
    }
    const conversationId = typeof input.conversationId === 'string' && input.conversationId ? input.conversationId : undefined;
    const message = opts.mailbox.send({ from, to, text, via: 'webui', ...(conversationId ? { conversationId } : {}) });
    changed();
    // (ADR-081 review N1) like /api/send: the address of ours an outbound message goes out from ('' = the first)
    return reply(201, { message, ...(message.to.device ? { sentFrom: message.myAddress ?? '' } : {}) });
  }

  async function accepted({ body }: RequestContext): Promise<Reply> {
    const input = await body<{ handle?: unknown; deviceId?: unknown; myAddress?: unknown }>();
    if (typeof input.handle !== 'string' || !input.handle.trim() || typeof input.deviceId !== 'string') {
      return reply(400, { error: 'expected {handle, deviceId}' });
    }
    if (!opts.notifyAccepted) return reply(404, { error: NO_RELAY });
    let told: number;
    try {
      // (ADR-083) `myAddress`: which address of ours accepted ('' = the first) — a command of the release before sends none
      told = await opts.notifyAccepted(input.handle, input.deviceId, typeof input.myAddress === 'string' ? input.myAddress : undefined);
    } catch (e) {
      return reply(409, { error: e instanceof Error ? e.message : String(e) });
    }
    changed();
    return reply(200, { ok: true, told });
  }

  function retry({ param }: RequestContext): Reply {
    // a refusal (not failed / dead, unknown id) comes back as the generic 500 with its message
    const message = opts.mailbox.retry(param());
    changed();
    return reply(200, { message });
  }

  function addressesReload(): Reply {
    if (!opts.reloadAddresses) return reply(404, { error: NO_RELAY });
    return reply(200, { ok: true, ...opts.reloadAddresses() });
  }

  function events({ req, res }: RequestContext): Reply {
    streams.attach(req, res);
  }

  /**
   * POST /api/register and POST /api/inbox (ADR-024). Desktop apps such as 闪电说 cannot run `morse` (a bare
   * PATH, a sandbox that forbids writing ~/.morse), so they register and pull their mail over loopback HTTP.
   * /api/register always registers; /api/inbox registers only when the body says `register: true`, so one
   * call can register, refresh lastSeenAt and collect mail.
   */
  async function externalMail({ body, external }: RequestContext, route: 'register' | 'inbox'): Promise<Reply> {
    const input = await body<{ agent?: string; sessionId?: string; title?: string; cwd?: string; register?: boolean }>();
    const sessionId = input.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) return reply(400, { error: REGISTER_USAGE });
    const registry = await import('../registry/external.js');
    // (ADR-087, follow-up 1) an external agent's token registers and reads as THAT agent, for the session ids the
    // token is BOUND to — never by what the body says. (Before the follow-up, registering counted as owning:
    // `{agent: <itself>, sessionId: <any session's id>, register: true}` then read that session's mail.)
    if (external) {
      const sid = sessionId;
      const asItself = typeof input.agent !== 'string' || input.agent.trim().toLowerCase() === external;
      const binding = externalBinding(external, opts.registryHome);
      if (!asItself || !binding || sid.length > MAX_EXTERNAL_SESSION_ID) return reply(403, { error: FORBIDDEN });
      if (!binding.sessions.includes(sid)) {
        // an app that names its own session id (`open`) may bind itself to one that is NOBODY ELSE'S: not a
        // session of any agent here, not another app's, not one any mail was ever addressed to under another
        // agent's name, not one of the mailbox's own names
        const reserved = ['inbox', 'cli', 'web', 'user'].includes(sid.trim().toLowerCase()) || sid !== sid.trim();
        const free =
          binding.open &&
          !reserved &&
          !registry.listRegistered({ ...homeOpt, includeStale: true }).some((r) => r.sessionId === sid && r.agent !== external) &&
          !(await opts.directory()).some((x) => x.sessionId === sid && x.agent !== external) &&
          !opts.mailbox.inbox({ toSession: sid, all: true }).some((m) => m.to.agent !== external);
        if (!free) return reply(403, { error: FORBIDDEN });
        bindExternalSession(external, sid, opts.registryHome);
      }
      input.agent = external; // (it registers as itself, whether or not it said so)
    }

    if (route === 'register' || input.register) {
      if (typeof input.agent !== 'string') return reply(400, { error: REGISTER_USAGE });
      const entry = { agent: input.agent, sessionId, ...(input.title ? { title: input.title } : {}), ...(input.cwd ? { cwd: input.cwd } : {}) };
      let session: ReturnType<typeof registry.register>;
      try {
        session = registry.register(entry, homeOpt);
      } catch (e) {
        return reply(400, { error: e instanceof Error ? e.message : String(e) });
      }
      opts.invalidateDirectory?.();
      if (route === 'register') {
        changed();
        return reply(201, { session, registered: registry.listRegistered(homeOpt).length });
      }
    }

    // The prompt hook's collector does the pull, so an app gets the same dead-letter recovery (ADR-022) and a
    // ready-to-read `text`. What it took is told apart by status: delivered now, and not before the call.
    const { collectInbox: pull } = await import('../hooks/prompt-hook.js');
    // (follow-up 1) for an external agent the mail is that of (its agent name, this session) — a session id alone
    // never selects mail addressed to another agent
    const query = { toSession: sessionId, all: true, ...(external ? { toAgent: external } : {}) };
    const deliveredBefore = new Set(opts.mailbox.inbox(query).flatMap((m) => (m.status === 'delivered' ? [m.id] : [])));
    const text = pull(opts.mailbox, sessionId, { ...homeOpt, ...(external ? { agent: external } : {}) });
    const messages = opts.mailbox.inbox(query).filter((m) => m.status === 'delivered' && !deliveredBefore.has(m.id));
    changed();
    return reply(201, { count: messages.length, text, messages });
  }

  /** POST /api/send — what `morse send` posts: resolve the target, check it, queue the message. */
  async function handleSend({ body, external }: RequestContext): Promise<Reply> {
    const input = await body<{ target?: string; from?: SessionRef; text?: string; files?: unknown; fromAddress?: unknown }>();
    const { target, text } = input;
    if (typeof target !== 'string' || typeof text !== 'string' || text.trim() === '') {
      return reply(400, { error: 'expected {target, from?, text, files?, fromAddress?}' });
    }
    // (ADR-087) an external agent sends as itself, text only: it names no file on this disk to attach and no
    // address of the owner's to send from
    if (
      external &&
      (!looksLikeSessionRef(input.from) ||
        input.from.agent !== external ||
        input.from.device !== undefined ||
        input.files !== undefined ||
        input.fromAddress !== undefined ||
        // (follow-up 1) …and from a session its token is bound to
        !externalBinding(external, opts.registryHome)?.sessions.includes(input.from.sessionId))
    ) {
      return reply(403, { error: FORBIDDEN });
    }
    const [sessions, { resolveTarget }, { parseMorseAddress, hasRelayHost, INBOX_AGENT, OLD_NAMES_LINE }, { normalizeAddress }, { contactsOfTarget }] = await Promise.all([
      opts.directory(),
      import('../directory/resolve.js'),
      import('../cluster/morse.js'),
      import('../identity/address.js'),
      import('../mailbox/known-as.js'),
    ]);
    // ADR-081 §6: the address of ours this is sent from (`morse send --from <name|address>`) — resolved to the
    // ADDRESS here, when it is queued (ADR-081 review: legacy rows): the row records it, a name alone never is
    const named = typeof input.fromAddress === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/i.test(input.fromAddress.trim()) ? input.fromAddress.trim().toLowerCase() : undefined;
    /** The address of ours it goes out from, when one is named, remembered or resolved; its local name (display). */
    let myAddress: string | undefined;
    let myAgent: string | undefined;
    if (named) {
      const own = opts.ownAddress?.(named) ?? null;
      myAddress = normalizeAddress(named) ?? own?.address;
      if (!myAddress) return reply(422, { error: `"${named}" is not one of your addresses here — morse address lists them` });
      // (ADR-088) the row keeps the directory's name for the address — stable, the same as on the rows of mail that
      // came in; the name you gave it is looked up from the address when a row is shown
      myAgent = own?.directory ?? own?.name ?? undefined;
    }
    // (ADR-083) WHICH contact this is: a person can be a contact of several of my addresses — separate rows
    // that share nothing. With an address named: that address's contact (made by this very message when
    // there is none). With none named: the contact there is, sent from the address it belongs to; a peer
    // address that is a contact of two of mine is refused with one line — never guessed.
    {
      const contacts = opts.mailbox.contacts;
      const nameFor = (key: string): string => {
        const a = key || contacts.firstAddress();
        return (a ? opts.ownAddress?.(a)?.name : null) ?? (a ? `morse.im/${a}` : 'your first address');
      };
      const persons = contactsOfTarget(contacts, target, (h) => Boolean(opts.knowsDevice?.(h)));
      const peer = normalizeAddress(target);
      if (persons && myAddress && contacts.mine(myAddress) && !peer) {
        // a contact by old name is the first address's alone: another address of mine never writes to an old name —
        // and the way out is the address they belong to, never "write to their address from the other one" (that
        // makes them a contact of it too, and shows them that address)
        const firstName = nameFor('');
        return reply(422, {
          error: `${target} is a contact of your first address, by its old name, not of ${nameFor(contacts.mine(myAddress))} — write to them from the address they belong to: ${firstName === 'your first address' ? '' : `--from ${firstName.replace(/^morse\.im\//, '')}, or `}leave --from out`,
        });
      }
      if (persons && !myAddress && persons.length > 1) {
        return reply(422, { error: `morse.im/${peer ?? target} is a contact of ${persons.length} of your addresses (${persons.map((c) => nameFor(c.myAddress)).join(', ')}) — say which one: --from <name>` });
      }
      if (persons && !myAddress && persons.length === 1 && persons[0]!.myAddress) {
        myAddress = persons[0]!.myAddress;
        const owning = opts.ownAddress?.(myAddress);
        myAgent = owning?.directory ?? owning?.name ?? undefined;
      }
    }
    // ADR-081 §2: a bare address (or mail from an address of ours other than the first) goes by address
    // alone — asked before anything is queued, so "their Morse is too old" is said here, once
    let byAddress: string | null = null;
    if (opts.addressRoute) {
      const route = await opts.addressRoute(target, myAddress ?? null);
      if (route && !route.ok && !route.waiting) return reply(422, { error: route.error });
      // (ADR-091) the address the transport goes to — a contact's, when `target` named it by its remark or old name
      byAddress = route?.ok ? route.address : route ? normalizeAddress(target) : null;
      // (ADR-081 review F1) a bare address with nothing named: the address the transport sends it from
      if (route?.ok && route.from && !myAddress) myAddress = route.from;
    }
    // Morse first: a paired PERSON (morse.im/<handle>[/<agent>]) beats any local
    // session that happens to share the name
    const person = byAddress ? null : parseMorseAddress(target);
    // (ADR-091, stage 2) an old name (morse.im/<handle>[/<agent>]) no address is known for reaches nobody any more: one
    // line, nothing queued. A bare word that is no contact goes on to the sessions here.
    if (person && !opts.pairPerson && (hasRelayHost(target) || target.includes('/'))) return reply(422, { error: OLD_NAMES_LINE(target) });
    let isPerson = Boolean(person && opts.knowsDevice?.(person.handle));
    if (person && !isPerson && opts.pairPerson && hasRelayHost(target)) {
      // morse.im/<handle> spelled out and nobody paired yet: first contact pairs them (ADR-032)
      const p = await opts.pairPerson(person.handle);
      if (!p.ok && !p.waiting) return reply(422, { error: p.error ?? `cannot reach ${target}` });
      isPerson = true; // paired now, or queued until the relay is back (the transport retries the lookup)
    }
    let local = isPerson || byAddress ? null : resolveTarget(target, sessions);
    if (local && !local.ok && person && opts.pairPerson && local.reason === 'not_found') {
      // a bare name that is no local session: maybe a person on the relay
      const p = await opts.pairPerson(person.handle);
      if (p.ok) local = null;
    }

    /** A target with no session directory here: the device and agent are all there is. */
    const remote = (device: string, agent: string, sessionId: string, title: string): SessionInfo => ({ device, agent, sessionId, title, cwd: '', lastActiveAt: 0 });
    let resolved: SessionInfo;
    if (byAddress) {
      // the address is all there is to say: no agent name, no session (an address IS its agent). Writing
      // to it accepts it (ADR-037): it is a contact from here on, a request of theirs moves to the inbox
      opts.acceptAddress?.(byAddress, myAddress ?? null);
      resolved = remote(byAddress, INBOX_AGENT, '', 'inbox');
    } else if (local === null) {
      // person-level: their inbox; agent-level: that agent's session is picked on THEIR machine
      const agent = person!.agent ?? INBOX_AGENT;
      resolved = remote(person!.handle, agent, '', person!.agent ? agent : 'inbox');
    } else if (local.ok) {
      resolved = local.session;
    } else {
      // Morse: a relay-paired device has no directory here — accept an explicit
      // @device/agent:session address for it as-is
      const spelled = /^@?([^/\s]+)\/([^:\s]+):(\S+)$/.exec(target.trim());
      if (!spelled || !opts.knowsDevice?.(spelled[1]!)) {
        return reply(422, { error: `cannot resolve target "${target}" (${local.reason})`, candidates: local.candidates.slice(0, 8) });
      }
      resolved = remote(spelled[1]!, spelled[2]!, spelled[3]!, spelled[3]!);
    }

    const to: SessionRef = resolved.device
      ? { agent: resolved.agent, sessionId: resolved.sessionId, device: resolved.device }
      : { agent: resolved.agent, sessionId: resolved.sessionId };
    // without a sender the message comes from the human at the command line
    const from: SessionRef = looksLikeSessionRef(input.from) ? input.from : { agent: 'user', sessionId: 'cli' };
    // only a local target is checked here; a remote one by the daemon that owns it, at delivery
    if (!to.device && opts.preflight) {
      const refusal = await opts.preflight(resolved);
      if (refusal) return reply(409, { error: refusal, code: refusalCode(refusal), resolvedTarget: resolved });
    }
    let files: MessageFile[] = [];
    if (Array.isArray(input.files) && input.files.length) {
      if (!to.device || !opts.stageFiles) return reply(400, { error: 'files can only be sent to another address over the Morse relay' });
      try {
        files = opts.stageFiles(input.files.filter((f): f is string => typeof f === 'string'));
      } catch (e) {
        return reply(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    const message = opts.mailbox.send({ from, to, text, via: 'cli', ...(files.length ? { files } : {}), ...(myAddress && to.device ? { myAddress, ...(myAgent ? { myAgent } : {}) } : {}) });
    changed();
    const chunks = files.length && opts.chunksFor ? opts.chunksFor(files, text) : 0;
    // (ADR-081 review N1) `sentFrom`: the address of ours the message goes out from as the row records it — '' = none
    // was named or remembered: this computer's first address. (Mail for a session here records none: the
    // one that was named is echoed.) A daemon of the release before sends no such field.
    return reply(201, { message, resolvedTarget: resolved, sentFrom: to.device ? (message.myAddress ?? '') : (myAddress ?? ''), ...(chunks ? { chunks } : {}) });
  }

  /**
   * Screen, authenticate, route and answer one request. Every route of LOCAL_API_ROUTES is dispatched by its
   * name below, and only by its name: no handler looks at the path or the method itself (ADR-087).
   */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const refusal = screen(req, path);
    if (refusal) return sendJson(res, refusal.status, { error: refusal.error });

    const route = LOCAL_API_ROUTES.find((r) => r.method === req.method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)));
    const open = route !== undefined && (route.auth as readonly LocalApiAuth[]).includes('none');
    const caller = open ? null : callerOf(req);
    // (who is asked before what: an unauthenticated caller does not learn which paths exist)
    const turnAway = !open && !caller ? { status: 401, error: UNAUTHORIZED } : !route ? { status: 404, error: 'not found' } : caller && !(route.auth as readonly LocalApiAuth[]).includes(caller.kind) ? { status: 403, error: FORBIDDEN } : null;
    if (turnAway || !route) {
      req.resume();
      return sendJson(res, turnAway?.status ?? 404, { error: turnAway?.error ?? 'not found' });
    }

    let bodyRead = false;
    let after: (() => void) | undefined;
    const ctx: RequestContext = {
      req,
      res,
      url,
      caller,
      external: caller?.kind === 'external' ? caller.agent : null,
      param: () => (route.path as RegExp).exec(path)![1]!,
      body: async <T>() => {
        bodyRead = true;
        return (await readJsonBody(req)) as T;
      },
      afterReply: (fn) => {
        after = fn;
      },
    };

    const name: LocalApiRouteName = route.name;
    let answer: Reply;
    if (name === 'ping') answer = ping(ctx);
    else if (name === 'consolePage') answer = consolePage(ctx);
    else if (name === 'consoleCode') answer = consoleCode();
    else if (name === 'consoleSession') answer = await consoleSession(ctx);
    else if (name === 'shutdown') answer = shutdown(ctx);
    else if (name === 'sessions') answer = await sessions(ctx);
    else if (name === 'register' || name === 'inbox') answer = await externalMail(ctx, name);
    else if (name === 'peers') answer = peers();
    else if (name === 'conversations') answer = reply(200, { conversations: opts.mailbox.listConversations() });
    else if (name === 'conversationMessages') answer = reply(200, { messages: opts.mailbox.listMessages(ctx.param()) });
    else if (name === 'send') answer = await handleSend(ctx);
    else if (name === 'transfer') answer = transfer(ctx);
    // ADR-039: `morse update` asks before it installs (a transfer in progress defers it)
    else if (name === 'update') answer = reply(200, opts.updateStatus?.() ?? { busy: null });
    else if (name === 'messages') answer = await messages(ctx);
    else if (name === 'accepted') answer = await accepted(ctx);
    else if (name === 'retry') answer = retry(ctx);
    else if (name === 'addressesReload') answer = addressesReload();
    else if (name === 'events') answer = events(ctx);
    else {
      // (every name of LOCAL_API_ROUTES has its branch above: this one is not reached)
      name satisfies never;
      answer = reply(404, { error: 'not found' });
    }

    if (!answer) return; // the handler wrote the response itself (the page, the event stream)
    // a POST whose handler never wanted a body: let whatever was sent drain
    if (route.method === 'POST' && !bodyRead) req.resume();
    sendJson(res, answer.status, answer.body);
    if (after) setImmediate(after);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      req.resume();
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    const busy = err.code === 'EADDRINUSE' ? ` — port ${port} already in use (another morse running?)` : '';
    console.error(`console server error: ${err.message}${busy}`);
    process.exit(1);
  });
  // 127.0.0.1 and nothing else: other computers talk to the daemon through the mutual-TLS peer server
  server.listen(port, '127.0.0.1');

  return {
    port,
    notifyChange: changed,
    close() {
      clearInterval(poll);
      streams.endAll();
      server.close();
    },
  };
}
