import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { SessionInfo } from '../adapters/types.js';
import type { Peer } from '../cluster/peers.js';
import type { RelayState } from '../cluster/relay-client.js';
import type { UntrustedContact } from '../cluster/secure-transport.js';
import type { TrustStore } from '../cluster/trust.js';
import type { Mailbox, MessageFile, SessionRef } from '../mailbox/mailbox.js';
import { DAEMON_CAPABILITIES } from './capabilities.js';
import { createHmac } from 'node:crypto';
import { bindExternalSession, externalAgentOfToken, externalBinding, LOCAL_TOKEN_HEADER, MAX_EXTERNAL_SESSION_ID, PING_CHALLENGE_HEADER, sameToken } from './local-api.js';

const require = createRequire(import.meta.url);

export interface ConsoleServerOptions {
  mailbox: Mailbox;
  /**
   * ADR-087: the daemon token — random per start, written to daemon.json (owner-only). Every route but the
   * ones marked `none` in LOCAL_API_ROUTES needs it (or a narrower credential) in the `x-morse-token` header.
   * Required: there is no way to start this server without it.
   */
  token: string;
  directory: () => Promise<SessionInfo[]>;
  port?: number;
  /** Poll interval for external mailbox writers (CLI in another process). */
  changePollMs?: number;
  /** Root for the external-agent registry (ADR-024); defaults to ~. Injectable for tests. */
  registryHome?: string;
  /** Drop the caller's directory cache. Called when an external agent registers,
   *  so it is addressable immediately instead of after the cache TTL — otherwise
   *  the first reply to a just-registered agent fails with a confusing not_found. */
  invalidateDirectory?: () => void;
  /** Pre-send check for a LOCAL target (ADR-025): non-null = refuse the send with
   *  409 and queue nothing, so the sender sees e.g. a CLI version mismatch now —
   *  instead of a silent dead letter whose cause the pull-hook recovery hides. */
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
  /** LAN peering status for /api/peers. The peer API itself is served by the
   *  separate mutual-TLS peer server (ADR-028); this console stays loopback-only. */
  peering?: {
    selfDevice: string;
    selfId: string;
    /** Live LAN peer list (mDNS + static). */
    peers?: () => Peer[];
    trust?: TrustStore;
    /** Devices with a valid certificate that tried to talk to us but aren't paired. */
    pending?: () => UntrustedContact[];
    /** Morse relay status (when configured). */
    relay?: () => { url: string; connected: boolean; state?: RelayState } | null;
  };
}

export interface RunningServer {
  port: number;
  notifyChange(): void;
  close(): void;
}

interface SendBody {
  from: SessionRef;
  to: SessionRef;
  text: string;
}

/** Machine-readable code from a preflight error's `<code>: …` prefix. */
function preflightCode(error: string): string {
  return /^([a-z_]+):/.exec(error)?.[1] ?? 'preflight_failed';
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

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(payload);
}

/**
 * The JSON body of a request. ADR-087: only `Content-Type: application/json` is read — a web page can post
 * `text/plain` to a loopback port without the browser asking first (a "simple" cross-origin request), and
 * what it posted used to be parsed as JSON all the same.
 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    req.resume();
    throw new HttpError(415, 'the body must be sent as Content-Type: application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // (too large: the rest is read and dropped, so that the sender gets its answer instead of a broken connection)
    if (size <= MAX_BODY_BYTES) chunks.push(c as Buffer);
    else chunks.length = 0;
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, 'the request body is too large');
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'the body is not valid JSON');
  }
}

function isSessionRef(v: unknown): v is SessionRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as SessionRef).agent === 'string' &&
    typeof (v as SessionRef).sessionId === 'string'
  );
}

/**
 * Optional narrowing for GET /api/sessions. The unfiltered directory is 4000+
 * sessions (~850KB) on a real machine — fine for the console, unusable inside an
 * agent's turn. With no query params the response is unchanged.
 */
function filterSessions(sessions: SessionInfo[], params: URLSearchParams): SessionInfo[] {
  const agent = params.get('agent');
  const q = params.get('q');
  const rawLimit = Number.parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : null;

  let out = sessions;
  if (agent) out = out.filter((s) => s.agent === agent.toLowerCase());
  if (q) {
    const needle = q.toLowerCase();
    out = out.filter(
      (s) => s.title.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle),
    );
  }
  return limit === null ? out : out.slice(0, limit);
}

/** Local-only web console: REST + SSE + static UI, bound to 127.0.0.1. */
export function startConsoleServer(opts: ConsoleServerOptions): RunningServer {
  const port = opts.port ?? 7433;
  const sseClients = new Set<ServerResponse>();
  const webuiFile = join(dirname(require.resolve('../../package.json')), 'webui', 'index.html');

  const broadcast = (): void => {
    for (const res of sseClients) res.write(`data: {"kind":"changed"}\n\n`);
  };

  // catch writes from other processes (morse send in a shell, hooks, agents)
  let lastStamp = '';
  const pollTimer = setInterval(() => {
    try {
      const msgs = opts.mailbox.inbox({ all: true });
      const last = msgs[msgs.length - 1];
      const stamp = `${msgs.length}:${last ? `${last.id}:${last.updatedAt}:${last.status}` : ''}`;
      const changedSince = msgs.reduce((acc, m) => Math.max(acc, m.updatedAt), 0);
      const full = `${stamp}:${changedSince}`;
      if (lastStamp && full !== lastStamp) broadcast();
      lastStamp = full;
    } catch {
      /* transient read errors must not kill the poller */
    }
  }, opts.changePollMs ?? 1500);

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  // ---- ADR-087: console sessions (the web console page) -------------------------------------
  /** one-time code → when it expires (handed out to `morse console`, exchanged once by the page) */
  const consoleCodes = new Map<string, number>();
  /** session token → when it expires (kept by the page in sessionStorage, sent in the token header) */
  const consoleSessions = new Map<string, number>();
  const sweep = (m: Map<string, number>): void => {
    const now = Date.now();
    for (const [k, until] of m) if (until <= now) m.delete(k);
  };
  const consoleSessionOf = (given: string): boolean => {
    sweep(consoleSessions);
    let hit = false;
    for (const t of consoleSessions.keys()) if (sameToken(given, t)) hit = true;
    return hit;
  };

  /** The names this server answers to: its loopback addresses with ITS port (a name that merely resolves here is not one — DNS rebinding). */
  const ownHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  /** Who is calling — null when the request carries no valid credential. */
  const callerOf = (req: IncomingMessage): Caller | null => {
    const given = req.headers[LOCAL_TOKEN_HEADER];
    if (typeof given !== 'string' || !given) return null;
    if (sameToken(given, opts.token)) return { kind: 'daemon' };
    if (consoleSessionOf(given)) return { kind: 'console' };
    const agent = externalAgentOfToken(given, opts.registryHome);
    return agent ? { kind: 'external', agent } : null;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;

    const remote = req.socket.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

    if (path.startsWith('/api/peer/')) {
      // moved off the plaintext console onto the mutual-TLS peer port (ADR-028)
      json(res, 404, { error: 'the peer API is served over mutual TLS on the peer port (ADR-028)' });
      return;
    }

    // the console is bound to 127.0.0.1; keep the check as defence in depth
    if (!isLoopback) {
      json(res, 403, { error: 'local console endpoints are loopback-only' });
      return;
    }

    // ---- ADR-087: what a browser on some other page could send is turned away before anything else ----
    // no CORS, ever: a preflight finds nothing here, so no page can send the token header or a JSON body cross-origin
    if (req.method === 'OPTIONS') {
      json(res, 404, { error: 'not found' });
      return;
    }
    // the Host must be this server's own loopback name and port (DNS rebinding: a page on evil.example whose
    // name was re-pointed at 127.0.0.1 still says `Host: evil.example`)
    const host = (req.headers.host ?? '').toLowerCase();
    if (!ownHosts.has(host)) {
      json(res, 403, { error: FORBIDDEN });
      return;
    }
    // an Origin header means a browser: only this server's own page may talk to it (the `morse` command sends none)
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      json(res, 403, { error: FORBIDDEN });
      return;
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      json(res, 403, { error: FORBIDDEN });
      return;
    }

    const route = LOCAL_API_ROUTES.find((r) => r.method === req.method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)));
    const open = route !== undefined && (route.auth as readonly LocalApiAuth[]).includes('none');
    const caller = open ? null : callerOf(req);
    if (!open && !caller) {
      // (asked before the route is: an unauthenticated caller does not learn which paths exist)
      req.resume();
      json(res, 401, { error: UNAUTHORIZED });
      return;
    }
    if (!route) {
      req.resume();
      json(res, 404, { error: 'not found' });
      return;
    }
    if (caller && !(route.auth as readonly LocalApiAuth[]).includes(caller.kind)) {
      req.resume();
      json(res, 403, { error: FORBIDDEN });
      return;
    }
    /** The route this request is for — the only thing the handlers below go by. */
    const name: LocalApiRouteName = route.name;
    /** The part of the path a route with a pattern captures (a message or conversation id). */
    const param = (): string => (route.path as RegExp).exec(path)![1]!;
    /** (ADR-087) an external agent acts as itself only */
    const external = caller?.kind === 'external' ? caller.agent : null;

    if (name === 'ping') {
      // the liveness probe: says that a Morse daemon listens here, and nothing else.
      // (ADR-087 follow-up 2) A command proves to itself that the listener is ITS home's daemon before it presents
      // the token: it sends a random challenge and gets back HMAC(token, challenge) — which only the process
      // that holds this home's token can compute, and which gives nothing of the token away.
      const challenge = req.headers[PING_CHALLENGE_HEADER];
      const proof = typeof challenge === 'string' && /^[0-9a-f]{32,128}$/.test(challenge) ? createHmac('sha256', opts.token).update(challenge).digest('hex') : null;
      json(res, 200, { morse: true, ...(proof ? { proof } : {}) });
      return;
    }
    if (name === 'consolePage') {
      // static: the page holds no data and no secret — it asks for both with a console session
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      res.end(readFileSync(webuiFile, 'utf8'));
      return;
    }
    if (name === 'consoleCode') {
      // `morse console`: a one-time code the page it opens trades for a session (60 s, single use)
      req.resume();
      sweep(consoleCodes);
      const code = randomBytes(24).toString('hex');
      consoleCodes.set(code, Date.now() + CONSOLE_CODE_TTL_MS);
      json(res, 201, { code, expiresInMs: CONSOLE_CODE_TTL_MS });
      return;
    }
    if (name === 'consoleSession') {
      const body = (await readBody(req)) as { code?: unknown };
      sweep(consoleCodes);
      let hit: string | null = null;
      if (typeof body.code === 'string' && body.code) for (const c of consoleCodes.keys()) if (sameToken(body.code, c)) hit = c;
      if (!hit) {
        json(res, 401, { error: UNAUTHORIZED });
        return;
      }
      consoleCodes.delete(hit);
      const token = randomBytes(24).toString('hex');
      consoleSessions.set(token, Date.now() + CONSOLE_SESSION_TTL_MS);
      json(res, 201, { token, expiresInMs: CONSOLE_SESSION_TTL_MS });
      return;
    }
    if (name === 'shutdown') {
      if (!opts.shutdown) {
        json(res, 404, { error: 'not found' });
        return;
      }
      req.resume();
      json(res, 202, { ok: true, pid: process.pid });
      const { run } = opts.shutdown;
      setImmediate(run);
      return;
    }
    if (name === 'sessions') {
      if (external) {
        // (ADR-087 follow-up 1) an external agent gets what it needs to NAME a target — `@<agent>:<part of the
        // title>` — and nothing else: no session id, no directory. A search matches the TITLE only (ADR-089: it
        // used to match the project folder's name too — a way to learn, by asking, what the folders of sessions
        // are called, which the answer itself never shows), and the list is always bounded.
        const q = url.searchParams.get('q')?.toLowerCase() ?? '';
        const agent = url.searchParams.get('agent')?.toLowerCase() ?? '';
        const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
        const sessions = (await opts.directory())
          .filter((x) => (!agent || x.agent === agent) && (!q || x.title.toLowerCase().includes(q)))
          .slice(0, limit)
          .map((x) => ({ agent: x.agent, title: x.title, lastActiveAt: x.lastActiveAt, ...(x.device ? { device: x.device } : {}) }));
        json(res, 200, { sessions });
        return;
      }
      json(res, 200, { sessions: filterSessions(await opts.directory(), url.searchParams) });
      return;
    }
    // ADR-024: external agents (desktop Apps like 闪电说) cannot run `morse` — a
    // minimal PATH plus a sandbox that blocks writes to ~/.morse. They register
    // and pull over loopback HTTP instead, which the sandbox does not restrict.
    if (name === 'register' || name === 'inbox') {
      const body = (await readBody(req)) as {
        agent?: string;
        sessionId?: string;
        title?: string;
        cwd?: string;
        register?: boolean;
      };
      const isInbox = name === 'inbox';
      if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
        json(res, 400, { error: 'expected {agent, sessionId, title?, cwd?}' });
        return;
      }
      const { register, listRegistered } = await import('../registry/external.js');
      const homeOpt = opts.registryHome ? { home: opts.registryHome } : {};
      // (ADR-087, follow-up 1) an external agent's token registers and reads as THAT agent, for the session ids the
      // token is BOUND to — never by what the body says. (Before the follow-up, registering counted as owning:
      // `{agent: <itself>, sessionId: <any session's id>, register: true}` then read that session's mail.)
      if (external) {
        const sid = body.sessionId;
        const asItself = typeof body.agent !== 'string' || body.agent.trim().toLowerCase() === external;
        const binding = externalBinding(external, opts.registryHome);
        if (!asItself || !binding || sid.length > MAX_EXTERNAL_SESSION_ID) {
          json(res, 403, { error: FORBIDDEN });
          return;
        }
        if (!binding.sessions.includes(sid)) {
          // an app that names its own session id (`open`) may bind itself to one that is NOBODY ELSE'S: not a
          // session of any agent here, not another app's, not one any mail was ever addressed to under another
          // agent's name, not one of the mailbox's own names
          const reserved = ['inbox', 'cli', 'web', 'user'].includes(sid.trim().toLowerCase()) || sid !== sid.trim();
          const free =
            binding.open &&
            !reserved &&
            !listRegistered({ ...homeOpt, includeStale: true }).some((r) => r.sessionId === sid && r.agent !== external) &&
            !(await opts.directory()).some((x) => x.sessionId === sid && x.agent !== external) &&
            !opts.mailbox.inbox({ toSession: sid, all: true }).some((m) => m.to.agent !== external);
          if (!free) {
            json(res, 403, { error: FORBIDDEN });
            return;
          }
          bindExternalSession(external, sid, opts.registryHome);
        }
        body.agent = external; // (it registers as itself, whether or not it said so)
      }

      // /api/register always registers; /api/inbox only when asked — so one call
      // can register, refresh lastSeenAt and collect mail together.
      if (!isInbox || body.register) {
        if (typeof body.agent !== 'string') {
          json(res, 400, { error: 'expected {agent, sessionId, title?, cwd?}' });
          return;
        }
        let session;
        try {
          session = register(
            {
              agent: body.agent,
              sessionId: body.sessionId,
              ...(body.title ? { title: body.title } : {}),
              ...(body.cwd ? { cwd: body.cwd } : {}),
            },
            homeOpt,
          );
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          return;
        }
        opts.invalidateDirectory?.();
        if (!isInbox) {
          broadcast();
          json(res, 201, { session, registered: listRegistered(homeOpt).length });
          return;
        }
      }

      // Reuses the pull-hook collector, so external agents inherit dead-letter
      // recovery (ADR-022) for free. `text` is render-ready for the agent to read out.
      const { collectInbox } = await import('../hooks/prompt-hook.js');
      // (follow-up 1) for an external agent the mail is that of (its agent name, this session) — a session id alone
      // never selects mail addressed to another agent
      const mine = external ? { toAgent: external } : {};
      const messages = opts.mailbox.inbox({ toSession: body.sessionId, all: true, ...mine });
      const before = new Set(messages.filter((m) => m.status === 'delivered').map((m) => m.id));
      const text = collectInbox(opts.mailbox, body.sessionId, { ...homeOpt, ...(external ? { agent: external } : {}) });
      const collected = opts.mailbox
        .inbox({ toSession: body.sessionId, all: true, ...mine })
        .filter((m) => m.status === 'delivered' && !before.has(m.id));
      broadcast();
      json(res, 201, { count: collected.length, text, messages: collected });
      return;
    }
    if (name === 'peers') {
      // (ADR-081 review N1) `capabilities`: what a command may rely on before it posts — a daemon of the release
      // before answers without it, and `morse send --from` then hands it nothing
      const capabilities = DAEMON_CAPABILITIES;
      if (!opts.peering) {
        json(res, 200, { lan: false, self: null, peers: [], capabilities });
        return;
      }
      if (!opts.peering.peers) {
        // relay-only (Morse, --no-lan): no LAN discovery, but paired devices + tiers
        json(res, 200, {
          lan: false,
          self: { device: opts.peering.selfDevice, id: opts.peering.selfId },
          peers: [],
          trusted: opts.peering.trust?.list() ?? [],
          relay: opts.peering.relay?.() ?? null,
          capabilities,
        });
        return;
      }
      const trust = opts.peering.trust;
      const peers = (opts.peering.peers?.() ?? []).map((p) => {
        const trusted = p.id ? trust?.get(p.id) : undefined;
        return { ...p, paired: Boolean(trusted), ...(trusted ? { trustedName: trusted.name } : {}) };
      });
      json(res, 200, {
        lan: true,
        self: { device: opts.peering.selfDevice, id: opts.peering.selfId },
        peers,
        trusted: trust?.list() ?? [],
        pending: opts.peering.pending?.() ?? [],
        relay: opts.peering.relay?.() ?? null,
        capabilities,
      });
      return;
    }
    if (name === 'conversations') {
      json(res, 200, { conversations: opts.mailbox.listConversations() });
      return;
    }
    if (name === 'conversationMessages') {
      json(res, 200, { messages: opts.mailbox.listMessages(param()) });
      return;
    }
    if (name === 'send') {
      const body = (await readBody(req)) as { target?: string; from?: SessionRef; text?: string; files?: unknown; fromAddress?: unknown };
      if (typeof body.target !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
        json(res, 400, { error: 'expected {target, from?, text, files?, fromAddress?}' });
        return;
      }
      // (ADR-087) an external agent sends as itself, text only: it names no file on this disk to attach and no
      // address of the owner's to send from
      if (
        external &&
        (!isSessionRef(body.from) ||
          body.from.agent !== external ||
          body.from.device !== undefined ||
          body.files !== undefined ||
          body.fromAddress !== undefined ||
          // (follow-up 1) …and from a session its token is bound to
          !externalBinding(external, opts.registryHome)?.sessions.includes(body.from.sessionId))
      ) {
        json(res, 403, { error: FORBIDDEN });
        return;
      }
      const { resolveTarget } = await import('../directory/resolve.js');
      const { parseMorseAddress, hasRelayHost, INBOX_AGENT, OLD_NAMES_LINE } = await import('../cluster/morse.js');
      const { normalizeAddress } = await import('../identity/address.js');
      const sessions = await opts.directory();
      const { contactsOfTarget } = await import('../mailbox/known-as.js');
      // ADR-081 §6: the address of ours this is sent from (`morse send --from <name|address>`) — resolved to the
      // ADDRESS here, when it is queued (ADR-081 review: legacy rows): the row records it, a name alone never is
      const named = typeof body.fromAddress === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/i.test(body.fromAddress.trim()) ? body.fromAddress.trim().toLowerCase() : undefined;
      /** The address of ours it goes out from, when one is named, remembered or resolved; its local name (display). */
      let myAddress: string | undefined;
      let myAgent: string | undefined;
      if (named) {
        const own = opts.ownAddress?.(named) ?? null;
        myAddress = normalizeAddress(named) ?? own?.address;
        if (!myAddress) {
          json(res, 422, { error: `"${named}" is not one of your addresses here — morse address lists them` });
          return;
        }
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
        const persons = contactsOfTarget(contacts, body.target, (h) => Boolean(opts.knowsDevice?.(h)));
        const peer = normalizeAddress(body.target);
        if (persons && myAddress && contacts.mine(myAddress) && !peer) {
          // a contact by old name is the first address's alone: another address of mine never writes to an old name —
          // and the way out is the address they belong to, never "write to their address from the other one" (that
          // makes them a contact of it too, and shows them that address)
          const firstName = nameFor('');
          json(res, 422, {
            error: `${body.target} is a contact of your first address, by its old name, not of ${nameFor(contacts.mine(myAddress))} — write to them from the address they belong to: ${firstName === 'your first address' ? '' : `--from ${firstName.replace(/^morse\.im\//, '')}, or `}leave --from out`,
          });
          return;
        }
        if (persons && !myAddress && persons.length > 1) {
          json(res, 422, { error: `morse.im/${peer ?? body.target} is a contact of ${persons.length} of your addresses (${persons.map((c) => nameFor(c.myAddress)).join(', ')}) — say which one: --from <name>` });
          return;
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
        const route = await opts.addressRoute(body.target, myAddress ?? null);
        if (route && !route.ok && !route.waiting) {
          json(res, 422, { error: route.error });
          return;
        }
        // (ADR-091) the address the transport goes to — a contact's, when `target` named it by its remark or old name
        byAddress = route?.ok ? route.address : route ? normalizeAddress(body.target) : null;
        // (ADR-081 review F1) a bare address with nothing named: the address the transport sends it from
        if (route?.ok && route.from && !myAddress) myAddress = route.from;
      }
      // Morse first: a paired PERSON (morse.im/<handle>[/<agent>]) beats any local
      // session that happens to share the name
      const person = byAddress ? null : parseMorseAddress(body.target);
      // (ADR-091, stage 2) an old name (morse.im/<handle>[/<agent>]) no address is known for reaches nobody any more: one
      // line, nothing queued. A bare word that is no contact goes on to the sessions here.
      if (person && !opts.pairPerson && (hasRelayHost(body.target) || body.target.includes('/'))) {
        json(res, 422, { error: OLD_NAMES_LINE(body.target) });
        return;
      }
      let isPerson = Boolean(person && opts.knowsDevice?.(person.handle));
      if (person && !isPerson && opts.pairPerson && hasRelayHost(body.target)) {
        // morse.im/<handle> spelled out and nobody paired yet: first contact pairs them (ADR-032)
        const p = await opts.pairPerson(person.handle);
        if (!p.ok && !p.waiting) {
          json(res, 422, { error: p.error ?? `cannot reach ${body.target}` });
          return;
        }
        isPerson = true; // paired now, or queued until the relay is back (the transport retries the lookup)
      }
      let r = isPerson || byAddress ? null : resolveTarget(body.target, sessions);
      if (r && !r.ok && person && opts.pairPerson && r.reason === 'not_found') {
        // a bare name that is no local session: maybe a person on the relay
        const p = await opts.pairPerson(person.handle);
        if (p.ok) r = null;
      }
      let resolved: SessionInfo;
      if (byAddress) {
        // the address is all there is to say: no agent name, no session (an address IS its agent). Writing
        // to it accepts it (ADR-037): it is a contact from here on, a request of theirs moves to the inbox
        opts.acceptAddress?.(byAddress, myAddress ?? null);
        resolved = { device: byAddress, agent: INBOX_AGENT, sessionId: '', title: 'inbox', cwd: '', lastActiveAt: 0 };
      } else if (!r) {
        // person-level: their inbox; agent-level: that agent's session is picked on THEIR machine
        const agent = person!.agent ?? INBOX_AGENT;
        resolved = { device: person!.handle, agent, sessionId: '', title: person!.agent ? agent : 'inbox', cwd: '', lastActiveAt: 0 };
      } else if (r.ok) {
        resolved = r.session;
      } else {
        // Morse: a relay-paired device has no directory here — accept an explicit
        // @device/agent:session address for it as-is
        const raw = /^@?([^/\s]+)\/([^:\s]+):(\S+)$/.exec(body.target.trim());
        if (!raw || !opts.knowsDevice?.(raw[1]!)) {
          json(res, 422, {
            error: `cannot resolve target "${body.target}" (${r.reason})`,
            candidates: r.candidates.slice(0, 8),
          });
          return;
        }
        resolved = { device: raw[1]!, agent: raw[2]!, sessionId: raw[3]!, title: raw[3]!, cwd: '', lastActiveAt: 0 };
      }
      const to: SessionRef = { agent: resolved.agent, sessionId: resolved.sessionId };
      if (resolved.device) to.device = resolved.device;
      const from: SessionRef = isSessionRef(body.from) ? body.from : { agent: 'user', sessionId: 'cli' };
      // remote targets are checked by the owning daemon at delivery time
      const refused = !to.device && opts.preflight ? await opts.preflight(resolved) : null;
      if (refused) {
        json(res, 409, { error: refused, code: preflightCode(refused), resolvedTarget: resolved });
        return;
      }
      let files: MessageFile[] = [];
      if (Array.isArray(body.files) && body.files.length) {
        if (!to.device || !opts.stageFiles) {
          json(res, 400, { error: 'files can only be sent to another address over the Morse relay' });
          return;
        }
        try {
          files = opts.stageFiles(body.files.filter((f): f is string => typeof f === 'string'));
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      const m = opts.mailbox.send({ from, to, text: body.text, via: 'cli', ...(files.length ? { files } : {}), ...(myAddress && to.device ? { myAddress, ...(myAgent ? { myAgent } : {}) } : {}) });
      broadcast();
      const chunks = files.length && opts.chunksFor ? opts.chunksFor(files, body.text) : 0;
      // (ADR-081 review N1) `sentFrom`: the address of ours the message goes out from as the row records it — '' = none
      // was named or remembered: this computer's first address. (Mail for a session here records none: the
      // one that was named is echoed.) A daemon of the release before sends no such field.
      json(res, 201, { message: m, resolvedTarget: resolved, sentFrom: to.device ? (m.myAddress ?? '') : (myAddress ?? ''), ...(chunks ? { chunks } : {}) });
      return;
    }
    if (name === 'transfer') {
      // ADR-038: how far an outgoing message (and its chunked files) is
      const id = decodeURIComponent(param());
      const m = opts.mailbox.getMessage(id);
      if (!m) {
        json(res, 404, { error: 'no such message' });
        return;
      }
      json(res, 200, { message: m, transfer: opts.transferStatus?.(id) ?? null });
      return;
    }
    if (name === 'update') {
      // ADR-039: `morse update` asks before it installs (a transfer in progress defers it)
      json(res, 200, opts.updateStatus?.() ?? { busy: null });
      return;
    }
    if (name === 'messages') {
      const body = (await readBody(req)) as Partial<SendBody> & { conversationId?: string };
      if (!isSessionRef(body.from) || !isSessionRef(body.to) || typeof body.text !== 'string' || !body.text.trim()) {
        json(res, 400, { error: 'expected {from:{agent,sessionId}, to:{agent,sessionId}, text, conversationId?}' });
        return;
      }
      // (ADR-087 follow-up 4) the web console wires sessions on THIS computer together: a console session names no
      // other device or address — mail to a contact is `morse send`'s, which the owner runs in a terminal
      if (caller?.kind === 'console' && (body.to.device !== undefined || body.from.device !== undefined)) {
        json(res, 403, { error: 'the web console sends between sessions here only — for another address use: morse send' });
        return;
      }
      if (!body.to.device && opts.preflight) {
        const to = body.to;
        const target = (await opts.directory()).find(
          (s) => !s.device && s.agent === to.agent && s.sessionId === to.sessionId,
        );
        const refused = target ? await opts.preflight(target) : null;
        if (refused) {
          json(res, 409, { error: refused, code: preflightCode(refused) });
          return;
        }
      }
      const m = opts.mailbox.send({
        from: body.from,
        to: body.to,
        text: body.text,
        via: 'webui',
        ...(typeof body.conversationId === 'string' && body.conversationId
          ? { conversationId: body.conversationId }
          : {}),
      });
      broadcast();
      // (ADR-081 review N1) like /api/send: the address of ours an outbound message goes out from ('' = the first)
      json(res, 201, { message: m, ...(m.to.device ? { sentFrom: m.myAddress ?? '' } : {}) });
      return;
    }
    if (name === 'accepted') {
      const body = (await readBody(req)) as { handle?: unknown; deviceId?: unknown; myAddress?: unknown };
      if (typeof body.handle !== 'string' || !body.handle.trim() || typeof body.deviceId !== 'string') {
        json(res, 400, { error: 'expected {handle, deviceId}' });
        return;
      }
      if (!opts.notifyAccepted) {
        json(res, 404, { error: 'Morse relay is not enabled on this daemon' });
        return;
      }
      let told: number;
      try {
        // (ADR-083) `myAddress`: which address of ours accepted ('' = the first) — a command of the release before sends none
        told = await opts.notifyAccepted(body.handle, body.deviceId, typeof body.myAddress === 'string' ? body.myAddress : undefined);
      } catch (e) {
        json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      broadcast();
      json(res, 200, { ok: true, told });
      return;
    }
    if (name === 'retry') {
      req.resume();
      const m = opts.mailbox.retry(param());
      broadcast();
      json(res, 200, { message: m });
      return;
    }
    if (name === 'addressesReload') {
      req.resume();
      if (!opts.reloadAddresses) {
        json(res, 404, { error: 'Morse relay is not enabled on this daemon' });
        return;
      }
      json(res, 200, { ok: true, ...opts.reloadAddresses() });
      return;
    }
    if (name === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: {"kind":"hello"}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    // (every name of LOCAL_API_ROUTES is handled above: this line is not reached)
    name satisfies never;
    json(res, 404, { error: 'not found' });
  }

  server.on('error', (e: NodeJS.ErrnoException) => {
    const hint = e.code === 'EADDRINUSE' ? ` — port ${port} already in use (another morse running?)` : '';
    console.error(`console server error: ${e.message}${hint}`);
    process.exit(1);
  });
  // loopback only, always: other devices reach us through the mutual-TLS peer server
  server.listen(port, '127.0.0.1');
  return {
    port,
    notifyChange: broadcast,
    close() {
      clearInterval(pollTimer);
      for (const c of sseClients) c.end();
      server.close();
    },
  };
}
