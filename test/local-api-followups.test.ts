import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectInbox } from '../src/hooks/prompt-hook.js';
import { DAEMON_CAPABILITIES } from '../src/daemon/capabilities.js';
import { bindExternalSession, ensureExternalToken, externalBinding, externalHeaderPath, externalTokenPath, LOCAL_TOKEN_HEADER, localApi, MAX_EXTERNAL_SESSIONS, NoDaemonForThisHome, PING_CHALLENGE_HEADER } from '../src/daemon/local-api.js';
import { startConsoleServer, type RunningServer } from '../src/daemon/server.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, STRANDED_NOTE, type Mailbox } from '../src/mailbox/mailbox.js';
import { register } from '../src/registry/external.js';
import { daemonJson, freePort, noDaemonJson, realServerOn, TEST_TOKEN } from './helpers/local-api.js';
import { cliRaw, freshHome, removeHomes } from './helpers/personas-home.js';
import { daemonStub, isRunning, killStubs, morseStartStub, unrelatedStub } from './helpers/stub-process.js';

/**
 * ADR-087, the follow-ups from the review of the first release:
 *
 *  1. an external agent's token is bound to its agent name AND session ids — registering a session id did not
 *     make it the caller's, and mail is read by (agent, session), never by a session id from the body;
 *  2. a command presents this home's token only to this home's daemon: not to another port, not to a listener
 *     that cannot prove it holds the token;
 *  3. `morse stop` never looks for a daemon by process name;
 *  4. a console session sends between sessions on this computer only;
 *  5. a message a restart found mid-delivery is not stuck: its holder's report still counts, and a pull takes it.
 */

const call = (port: number, o: { method?: string; path: string; headers?: Record<string, string>; json?: unknown }): Promise<{ status: number; body: Record<string, unknown> }> =>
  new Promise((done, fail) => {
    const body = o.json === undefined ? undefined : JSON.stringify(o.json);
    const req = httpRequest({ host: '127.0.0.1', port, method: o.method ?? (body ? 'POST' : 'GET'), path: o.path, headers: { host: `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}), ...(o.headers ?? {}) }, setHost: false }, (res) => {
      let text = '';
      res.on('data', (c) => (text += String(c)));
      res.on('end', () => done({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
    });
    req.on('error', fail);
    req.end(body);
  });
const tok = (token: string): Record<string, string> => ({ [LOCAL_TOKEN_HEADER]: token });

let home: string;
let mailbox: Mailbox;
let server: RunningServer;
let port: number;
const CLAUDE = { agent: 'claude', sessionId: 'c0ffee00-1111-4222-8333-444455556666' };
const statusOf = (id: string) => mailbox.getMessage(id)!.status;

beforeAll(async () => {
  home = freshHome('morse-api-fu-');
  mailbox = createMailbox(createDb(':memory:'));
  port = await freePort();
  realServerOn(port);
  server = startConsoleServer({
    token: TEST_TOKEN,
    mailbox,
    directory: async () => [
      { ...CLAUDE, title: 'payments refactor', cwd: '/Users/you/work/secret-client/payments', lastActiveAt: 5 },
      { agent: 'codex', sessionId: 'x-9', title: 'docs', cwd: '/Users/you/work/site', lastActiveAt: 4 },
    ],
    port,
    changePollMs: 60_000,
    registryHome: home,
    knowsDevice: (d) => d === 'kai',
  });
  await new Promise((r) => setTimeout(r, 50));
});
afterAll(async () => {
  server.close();
  await killStubs();
  removeHomes();
});

describe('1 — an external agent\'s token is bound to its agent AND its sessions (ADR-087 follow-up 1)', () => {
  let sds: string;
  const post = (path: string, json: unknown, token: string = sds) => call(port, { path, json, headers: tok(token) });

  beforeAll(() => {
    sds = ensureExternalToken('sds', home, { open: true });
  });

  it('the reviewer\'s request — {"agent": <itself>, "sessionId": <another agent\'s session>, "register": true} — reads nothing, takes nothing, registers nothing', async () => {
    const m = mailbox.send({ from: { agent: 'user', sessionId: 'cli' }, to: CLAUDE, text: 'for the Claude session only' });
    const r = await post('/api/inbox', { agent: 'sds', sessionId: CLAUDE.sessionId, register: true });
    expect(r).toEqual({ status: 403, body: { error: 'forbidden' } });
    expect(JSON.stringify(r.body)).not.toContain('for the Claude session only');
    expect(statusOf(m.id)).toBe('pending');
    // …nor by registering first and reading second, nor without `register`, nor through /api/register
    expect((await post('/api/register', { agent: 'sds', sessionId: CLAUDE.sessionId })).status).toBe(403);
    expect((await post('/api/inbox', { sessionId: CLAUDE.sessionId })).status).toBe(403);
    expect((await post('/api/inbox', { agent: 'sds', sessionId: CLAUDE.sessionId })).status).toBe(403);
    expect(statusOf(m.id)).toBe('pending');
    expect(existsSync(join(home, '.morse', 'registered'))).toBe(false);
    expect(externalBinding('sds', home)).toEqual({ sessions: [], open: true });
    // the session that is NOT in the directory, but has mail under another agent's name: not free either
    const hidden = mailbox.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'kimi', sessionId: 'k-undiscovered' }, text: 'kimi only' });
    expect((await post('/api/inbox', { agent: 'sds', sessionId: 'k-undiscovered', register: true })).status).toBe(403);
    expect(statusOf(hidden.id)).toBe('pending');
    // the mailbox's own names, another app's session
    register({ agent: 'notes-app', sessionId: 'n-1' }, { home });
    for (const sessionId of ['inbox', 'cli', 'web', 'user', ' main', 'n-1', 'x'.repeat(129)]) expect((await post('/api/inbox', { agent: 'sds', sessionId, register: true })).status, sessionId).toBe(403);
  });

  it('its own session: bound the first time it is named (an id that is nobody else\'s), and from then on the mail of (sds, that session) — nothing addressed to another agent under the same id', async () => {
    const first = await post('/api/inbox', { agent: 'sds', sessionId: 'dsh-main', register: true, title: '闪电说助手' });
    expect(first.status).toBe(201);
    expect(externalBinding('sds', home)).toEqual({ sessions: ['dsh-main'], open: true });
    const mine = mailbox.send({ from: CLAUDE, to: { agent: 'sds', sessionId: 'dsh-main' }, text: 'done — the login page is fixed' });
    // (a message that names the same session id under ANOTHER agent's name is not the app's)
    const notMine = mailbox.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'codex', sessionId: 'dsh-main' }, text: 'for codex, by coincidence of ids' });
    const r = await post('/api/inbox', { sessionId: 'dsh-main' });
    expect(r.status).toBe(201);
    expect(r.body['count']).toBe(1);
    expect(String(r.body['text'])).toContain('done — the login page is fixed');
    expect(JSON.stringify(r.body)).not.toContain('for codex');
    expect(statusOf(mine.id)).toBe('delivered');
    expect(statusOf(notMine.id)).toBe('pending');
    // it sends as (sds, a session it is bound to) — not from a session id it made up
    expect((await post('/api/send', { target: '@codex:docs', from: { agent: 'sds', sessionId: 'dsh-main' }, text: 'please' })).status).toBe(201);
    expect((await post('/api/send', { target: '@codex:docs', from: { agent: 'sds', sessionId: CLAUDE.sessionId }, text: 'as the Claude session?' })).status).toBe(403);
    expect((await post('/api/send', { target: '@codex:docs', from: { agent: 'sds', sessionId: 'never-bound' }, text: 'x' })).status).toBe(403);
  });

  it('(ADR-089) an `open` token is bound to at most 256 session ids: the oldest binding goes, the app keeps working', async () => {
    expect(MAX_EXTERNAL_SESSIONS).toBe(256);
    for (let i = 0; i < MAX_EXTERNAL_SESSIONS + 3; i++) bindExternalSession('sds', `many-${i}`, home);
    const b = externalBinding('sds', home)!;
    expect(b.sessions).toHaveLength(MAX_EXTERNAL_SESSIONS);
    expect(b.sessions[b.sessions.length - 1]).toBe(`many-${MAX_EXTERNAL_SESSIONS + 2}`);
    expect(b.sessions).not.toContain('many-0');
    // through the API too: one more id is bound, the list does not grow; a dropped id is bound again when it is used
    expect((await post('/api/inbox', { agent: 'sds', sessionId: 'one-more', register: true })).status).toBe(201);
    expect((await post('/api/inbox', { agent: 'sds', sessionId: 'many-0', register: true })).status).toBe(201);
    const after = externalBinding('sds', home)!;
    expect(after.sessions).toHaveLength(MAX_EXTERNAL_SESSIONS);
    expect(after.sessions.slice(-2)).toEqual(['one-more', 'many-0']);
  });

  it('a token that is not `open` (issued for named sessions) binds nothing by itself', async () => {
    const notes = ensureExternalToken('notes-app', home, { session: 'n-1' });
    expect(externalBinding('notes-app', home)).toEqual({ sessions: ['n-1'], open: false });
    expect((await post('/api/inbox', { agent: 'notes-app', sessionId: 'n-1', register: true }, notes)).status).toBe(201);
    for (const sessionId of ['n-2', 'brand-new', CLAUDE.sessionId, 'dsh-main']) expect((await post('/api/inbox', { agent: 'notes-app', sessionId, register: true }, notes)).status, sessionId).toBe(403);
    expect(externalBinding('notes-app', home)).toEqual({ sessions: ['n-1'], open: false });
    // one app never reads another's session
    expect((await post('/api/inbox', { sessionId: 'n-1' }, sds)).status).toBe(403);
  });

  it('GET /api/sessions for an external agent: what it needs to name a target (agent, title) — no session id, no directory; searched by title only (ADR-089); bounded', async () => {
    const all = await call(port, { path: '/api/sessions', headers: tok(sds) });
    expect(all.status).toBe(200);
    expect(all.body['sessions']).toEqual([
      { agent: 'claude', title: 'payments refactor', lastActiveAt: 5 },
      { agent: 'codex', title: 'docs', lastActiveAt: 4 },
    ]);
    expect(JSON.stringify(all.body)).not.toMatch(/c0ffee00|secret-client|\/Users\//);
    const names = async (q: string) => ((await call(port, { path: `/api/sessions?${q}`, headers: tok(sds) })).body['sessions'] as Array<{ title: string }>).map((x) => x.title);
    expect(await names('q=payments')).toEqual(['payments refactor']); // (the title)
    expect(await names('q=site')).toEqual([]); // (ADR-089: not the project folder's name — nothing of the directory can be asked for)
    expect(await names('q=secret-client')).toEqual([]); // (nor the rest of the path)
    expect(await names('q=c0ffee00')).toEqual([]);
    expect(await names('agent=codex')).toEqual(['docs']);
    expect(await names('limit=1')).toEqual(['payments refactor']);
    // the morse command still gets the full entries
    const full = await call(port, { path: '/api/sessions', headers: tok(TEST_TOKEN) });
    expect((full.body['sessions'] as Array<Record<string, unknown>>)[0]).toMatchObject({ sessionId: CLAUDE.sessionId, cwd: '/Users/you/work/secret-client/payments' });
  });

  it('a token of the release before (a token file and nothing else) keeps working for the session it registered — bound in place, no `morse connect` needed', async () => {
    const h = freshHome('morse-api-fu-legacy-');
    const p = await freePort();
    realServerOn(p);
    const mb = createMailbox(createDb(':memory:'));
    const s = startConsoleServer({ token: TEST_TOKEN, mailbox: mb, directory: async () => [{ ...CLAUDE, title: 't', cwd: '/w', lastActiveAt: 1 }], port: p, changePollMs: 60_000, registryHome: h });
    try {
      // exactly what the first ADR-087 release left: api-tokens/<agent> (one line), a registered session, no binding
      mkdirSync(join(h, '.morse', 'api-tokens'), { recursive: true, mode: 0o700 });
      const legacy = 'ab12'.repeat(12);
      writeFileSync(externalTokenPath('sds', h), `${legacy}\n`, { mode: 0o600 });
      writeFileSync(externalTokenPath('notes-app', h), `${'cd34'.repeat(12)}\n`, { mode: 0o600 });
      register({ agent: 'sds', sessionId: 'the-apps-session', title: '闪电说助手' }, { home: h });
      register({ agent: 'notes-app', sessionId: 'n-7' }, { home: h });
      const waiting = mb.send({ from: CLAUDE, to: { agent: 'sds', sessionId: 'the-apps-session' }, text: 'queued before the update' });
      const claudes = mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: CLAUDE, text: 'claude only' });

      const r = await call(p, { path: '/api/inbox', json: { agent: 'sds', sessionId: 'the-apps-session', register: true, title: '闪电说助手' }, headers: tok(legacy) });
      expect(r.status).toBe(201);
      expect(String(r.body['text'])).toContain('queued before the update');
      expect(mb.getMessage(waiting.id)!.status).toBe('delivered');
      // bound in place: the token file is untouched, the binding is what that release had recorded
      expect(readFileSync(externalTokenPath('sds', h), 'utf8')).toBe(`${legacy}\n`);
      expect(JSON.parse(readFileSync(join(h, '.morse', 'api-tokens', 'sds.json'), 'utf8'))).toEqual({ v: 1, sessions: ['the-apps-session'], open: true });
      if (process.platform !== 'win32') expect(statSync(join(h, '.morse', 'api-tokens', 'sds.json')).mode & 0o777).toBe(0o600);
      // …and the same token is refused what it never had: the reviewer's request
      expect((await call(p, { path: '/api/inbox', json: { agent: 'sds', sessionId: CLAUDE.sessionId, register: true }, headers: tok(legacy) })).status).toBe(403);
      expect(mb.getMessage(claudes.id)!.status).toBe('pending');
      // a token issued for a named session (`morse connect --agent … --session …`): that session, and no other
      const notes = 'cd34'.repeat(12);
      expect((await call(p, { path: '/api/inbox', json: { agent: 'notes-app', sessionId: 'n-7', register: true }, headers: tok(notes) })).status).toBe(201);
      expect((await call(p, { path: '/api/inbox', json: { agent: 'notes-app', sessionId: 'n-8', register: true }, headers: tok(notes) })).status).toBe(403);
      expect(externalBinding('notes-app', h)).toEqual({ sessions: ['n-7'], open: false });
    } finally {
      s.close();
    }
  });

  it('the header file: the same token as one header line, owner-only — what `curl -H @<file>` sends', () => {
    expect(readFileSync(externalHeaderPath('sds', home), 'utf8')).toBe(`x-morse-token: ${sds}\n`);
    expect(readFileSync(externalTokenPath('sds', home), 'utf8')).toBe(`${sds}\n`);
    if (process.platform !== 'win32') expect(statSync(externalHeaderPath('sds', home)).mode & 0o777).toBe(0o600);
    // (asking again changes nothing — not the token, not what it is bound to)
    const before = externalBinding('sds', home);
    expect(ensureExternalToken('sds', home, { open: true })).toBe(sds);
    expect(externalBinding('sds', home)).toEqual(before);
  });
});

describe('2 — the token is presented to this home\'s daemon only (ADR-087 follow-up 2)', () => {
  const listener = async (answer: (req: { url: string; token: string | undefined; challenge: string | undefined }) => { status: number; body: unknown }) => {
    const got: Array<{ url: string; token: string | undefined }> = [];
    const s: Server = createHttpServer((req, res) => {
      req.resume();
      const seen = { url: req.url ?? '', token: req.headers[LOCAL_TOKEN_HEADER] as string | undefined, challenge: req.headers[PING_CHALLENGE_HEADER] as string | undefined };
      got.push({ url: seen.url, token: seen.token });
      const a = answer(seen);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
    await new Promise<void>((done) => s.listen(0, '127.0.0.1', () => done()));
    return { port: (s.address() as { port: number }).port, got, close: () => new Promise<void>((done) => s.close(() => done())) };
  };
  const inHome = async <T>(h: string, run: () => Promise<T>): Promise<T> => {
    const before = process.env['MORSE_HOME'];
    process.env['MORSE_HOME'] = h;
    try {
      return await run();
    } finally {
      if (before === undefined) delete process.env['MORSE_HOME'];
      else process.env['MORSE_HOME'] = before;
    }
  };
  const refused = async (run: () => Promise<unknown>): Promise<NoDaemonForThisHome> => {
    try {
      await run();
    } catch (e) {
      expect(e).toBeInstanceOf(NoDaemonForThisHome);
      return e as NoDaemonForThisHome;
    }
    throw new Error('the request was sent');
  };

  it('GET /api/ping answers a challenge with HMAC(token, challenge) — and gives nothing else away', async () => {
    const challenge = 'c'.repeat(48);
    expect((await call(port, { path: '/api/ping', headers: { [PING_CHALLENGE_HEADER]: challenge } })).body).toEqual({ morse: true, proof: createHmac('sha256', TEST_TOKEN).update(challenge).digest('hex') });
    expect((await call(port, { path: '/api/ping' })).body).toEqual({ morse: true });
    for (const bad of ['', 'short', 'not-hex-'.repeat(8), 'c'.repeat(200)]) expect((await call(port, { path: '/api/ping', headers: { [PING_CHALLENGE_HEADER]: bad } })).body, bad).toEqual({ morse: true });
    expect([...DAEMON_CAPABILITIES]).toContain('listener-proof');
  });

  it('`--port` that is not the port this home\'s daemon.json names: refused, and NOTHING is sent there — no token, no request', async () => {
    const elsewhere = await listener(() => ({ status: 200, body: {} }));
    const h = freshHome('morse-api-fu-port-');
    daemonJson(h, port);
    try {
      await inHome(h, async () => {
        const e = await refused(() => localApi('/api/send', { port: elsewhere.port, json: { target: '@claude', text: 'x' } }));
        expect({ why: e.why, port: e.port }).toEqual({ why: 'other', port: elsewhere.port });
        // (the port daemon.json names — given or not — is this home's daemon: asked, and it answers)
        expect((await localApi('/api/peers', { port })).status).toBe(200);
        expect((await localApi('/api/peers')).status).toBe(200);
      });
      expect(elsewhere.got).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  it('a daemon.json left behind, its port taken by another program: the listener cannot prove it holds the token — the token is not shown to it', async () => {
    const impostor = await listener(({ url }) => (url === '/api/ping' ? { status: 200, body: { morse: true, proof: '0'.repeat(64) } } : { status: 200, body: { stolen: true } }));
    const silent = await listener(({ url }) => (url === '/api/ping' ? { status: 200, body: { morse: true } } : { status: 200, body: {} }));
    const h = freshHome('morse-api-fu-stale-');
    try {
      for (const l of [impostor, silent]) {
        daemonJson(h, l.port, { proves: true }); // (a daemon of this release wrote it: it says `listener-proof`)
        await inHome(h, async () => expect((await refused(() => localApi('/api/send', { json: { target: '@claude', text: 'x' } }))).why).toBe('other'));
        expect(l.got).toEqual([{ url: '/api/ping', token: undefined }]);
      }
    } finally {
      await impostor.close();
      await silent.close();
    }
  });

  it('a daemon of the first ADR-087 release (no `listener-proof` in its daemon.json) is still talked to — on its own port', async () => {
    const first = await listener(({ token }) => (token === TEST_TOKEN ? { status: 200, body: { ok: true } } : { status: 401, body: {} }));
    const h = freshHome('morse-api-fu-first-');
    daemonJson(h, first.port, { capabilities: ['from-address', 'contacts-per-address', 'local-api-auth'] });
    try {
      await inHome(h, async () => expect((await localApi('/api/peers')).status).toBe(200));
      expect(first.got).toEqual([{ url: '/api/peers', token: TEST_TOKEN }]);
    } finally {
      await first.close();
    }
  });

  it('through the real CLI: `morse send … --port <another port>` hands that port nothing', async () => {
    const elsewhere = await listener(() => ({ status: 201, body: { message: { id: 'm1', parts: [] }, resolvedTarget: { agent: 'inbox', title: 'inbox', sessionId: '' } } }));
    const h = freshHome('morse-api-fu-cli-');
    daemonJson(h, port);
    try {
      expect((await cliRaw(h, ['message'])).code).toBe(0);
      const r = await cliRaw(h, ['send', 'morse.im/k7f3a9xq', 'hello', '--port', String(elsewhere.port)]);
      expect(r.code).toBe(1);
      expect(r.err.split('\n').filter(Boolean)).toEqual([
        `warning: port ${elsewhere.port} is not this home's Morse daemon — nothing was sent to it; no Morse daemon is running for this home — morse start`,
        'error: the daemon is not running — messages to other addresses (morse.im/k7f3a9xq) go through it: morse start',
      ]);
      expect(elsewhere.got).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  }, 30_000);

  it('the ilink plugin names no port any more: `morse send` finds this home\'s daemon by itself', async () => {
    const { createMorseSide } = await import('../src/plugins/ilink/morse.js');
    const source = readFileSync(new URL('../src/plugins/ilink/morse.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/'--port'/);
    expect(createMorseSide.length).toBeLessThanOrEqual(1);
    for (const f of ['attendant', 'dispatch', 'ilink']) {
      const dir = new URL(`../src/plugins/${f}/`, import.meta.url);
      const { readdirSync } = await import('node:fs');
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) expect(readFileSync(new URL(name, dir), 'utf8'), `${f}/${name}`).not.toMatch(/'--port'/);
    }
  });
});

describe('3 — `morse stop` never looks for a daemon by name (ADR-087 follow-up 3)', () => {
  it('no pid file, no daemon.json: "not running" — and a process that reads exactly like some Morse daemon is left alone', async () => {
    // what `pgrep -f "(anyd|morse) start"` would have found: another home's daemon
    const decoy = await morseStartStub();
    const h = freshHome('morse-stop-none-');
    mkdirSync(join(h, '.morse'), { recursive: true });
    const r = await cliRaw(h, ['stop']);
    expect(r).toEqual({ code: 0, err: '', out: 'daemon not running (no pid file)\n' });
    await new Promise((done) => setTimeout(done, 300));
    expect(isRunning(decoy.pid!)).toBe(true);
    // (no command of the CLI searches the process table for a daemon any more)
    expect(readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8')).not.toMatch(/exec(File)?Sync\(\s*['"`]pgrep/);
  }, 30_000);

  it('no pid file, but this home\'s daemon.json names a live Morse daemon: that one is stopped; one that names another program: nothing is touched', async () => {
    const mine = await daemonStub();
    const h = freshHome('morse-stop-json-');
    daemonJson(h, 1, { pid: mine.pid! });
    const r = await cliRaw(h, ['stop']);
    expect(r).toEqual({ code: 0, err: '', out: `pid file missing — this home's daemon.json names the daemon (pid ${mine.pid})\nsent SIGTERM to daemon (pid ${mine.pid})\n` });
    await new Promise<void>((done) => (mine.exitCode !== null || mine.signalCode !== null ? done() : mine.once('exit', () => done())));
    expect(isRunning(mine.pid!)).toBe(false);

    const other = await unrelatedStub();
    daemonJson(h, 1, { pid: other.pid! });
    expect(await cliRaw(h, ['stop'])).toEqual({ code: 0, err: '', out: 'daemon not running (no pid file)\n' });
    await new Promise((done) => setTimeout(done, 300));
    expect(isRunning(other.pid!)).toBe(true);
    noDaemonJson(h);
  }, 30_000);
});

describe('4 — a console session sends between sessions on this computer only (ADR-087 follow-up 4)', () => {
  it('POST /api/messages with a device on either side is refused for a console session; the morse command may', async () => {
    const { code } = (await call(port, { path: '/api/console/code', method: 'POST', headers: tok(TEST_TOKEN) })).body as { code: string };
    const { token } = (await call(port, { path: '/api/console/session', json: { code } })).body as { token: string };
    const before = mailbox.inbox({ all: true }).length;
    const local = { from: { agent: 'user', sessionId: 'cli' }, to: CLAUDE, text: 'from the console, to a session here' };
    expect((await call(port, { path: '/api/messages', json: local, headers: tok(token) })).status).toBe(201);
    for (const body of [
      { ...local, to: { agent: 'inbox', sessionId: '', device: 'kai' } },
      { ...local, to: { agent: 'inbox', sessionId: '', device: 'k7f3a9xqm2v8c4h6jt5rwn8d2p' } },
      { ...local, to: { ...CLAUDE, device: '' } },
      { ...local, from: { agent: 'claude', sessionId: 's', device: 'kai' } },
    ]) {
      const r = await call(port, { path: '/api/messages', json: body, headers: tok(token) });
      expect(r, JSON.stringify(body)).toEqual({ status: 403, body: { error: 'the web console sends between sessions here only — for another address use: morse send' } });
    }
    expect(mailbox.inbox({ all: true }).length).toBe(before + 1);
    expect((await call(port, { path: '/api/messages', json: { ...local, to: { agent: 'inbox', sessionId: '', device: 'kai' } }, headers: tok(TEST_TOKEN) })).status).toBe(201);
  });
});

describe('5 — a message a restart found mid-delivery is not stuck (ADR-087 follow-up 5)', () => {
  const fresh = () => createMailbox(createDb(':memory:'));
  const TO = { agent: 'codex', sessionId: 'x-1' };
  const queued = (mb: Mailbox, text = 'queued before the update') => mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: TO, text });

  it('(the window) a holder still delivering when the daemon restarts: the message is set aside as failed — and its report used to be thrown away', () => {
    const mb = fresh();
    const m = queued(mb);
    expect(mb.claimNextPending({ scope: 'local' })?.id).toBe(m.id); // (the dispatch plugin of the run before holds it)
    expect(mb.recoverStale()).toBe(1); // (the new daemon starts)
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'failed', lastError: STRANDED_NOTE, attempts: 0 });
    // the holder finishes its turn and reports: delivered — not "illegal transition: failed -> delivered"
    expect(mb.markDelivered(m.id).status).toBe('delivered');
    expect(mb.claimNextPending({ scope: 'local' })).toBeNull(); // (and it is not delivered a second time)
  });

  it('the holder reports a failure, or hands the message back: counted as for any held message', () => {
    const mb = fresh();
    const a = queued(mb, 'a');
    mb.claimNextPending({ scope: 'local' });
    mb.recoverStale();
    expect(mb.markFailed(a.id, 'the agent CLI exited 1')).toMatchObject({ status: 'failed', attempts: 1, lastError: 'the agent CLI exited 1' });
    const b = queued(mb, 'b');
    expect(mb.claimById(b.id)?.id).toBe(b.id);
    mb.recoverStale(true);
    expect(mb.release(b.id)).toBe(true);
    expect(mb.getMessage(b.id)!.status).toBe('pending');
  });

  it('only a message that was set aside and not claimed again: any other failed message still needs a claim first', () => {
    const mb = fresh();
    const m = queued(mb);
    mb.claimNextPending({ scope: 'local' });
    mb.markFailed(m.id, 'a real failure');
    expect(() => mb.markDelivered(m.id)).toThrow(/illegal transition: failed -> delivered/);
    expect(() => mb.markFailed(m.id, 'again')).toThrow(/illegal transition: failed -> failed/);
    const d = queued(mb, 'delivered already');
    mb.claimNextPending({ scope: 'local', skipIds: [m.id] });
    mb.markDelivered(d.id);
    expect(() => mb.markDelivered(d.id)).toThrow(/illegal transition: delivered -> delivered/);
  });

  it('a pull for the session takes it (it used to return only `pending` and dead-lettered mail — a set-aside message was invisible to it)', () => {
    const mb = fresh();
    const h = freshHome('morse-fu-pull-');
    const m = queued(mb);
    mb.claimNextPending({ scope: 'local' });
    mb.recoverStale();
    const text = collectInbox(mb, TO.sessionId, { home: h });
    expect(text).toContain('queued before the update');
    expect(mb.getMessage(m.id)!.status).toBe('delivered');
    expect(collectInbox(mb, TO.sessionId, { home: h })).toBeNull(); // (once)
    // a message that failed for a reason of its own is the dispatcher's to retry, as before
    const other = queued(mb, 'failed for real');
    mb.claimNextPending({ scope: 'local' });
    mb.markFailed(other.id, 'the agent CLI exited 1');
    expect(collectInbox(mb, TO.sessionId, { home: h })).toBeNull();
    expect(mb.getMessage(other.id)!.status).toBe('failed');
  });

  it('the dispatcher still retries a set-aside message nobody reported on or pulled (after the usual wait)', () => {
    let t = 1_000_000;
    const mb = createMailbox(createDb(':memory:'), { now: () => t });
    const m = queued(mb);
    mb.claimNextPending({ scope: 'local' });
    mb.recoverStale();
    expect(mb.claimNextPending({ scope: 'local' })).toBeNull();
    t += 31_000;
    expect(mb.claimNextPending({ scope: 'local' })?.id).toBe(m.id);
  });
});

describe('two races the back-to-back test runs of this branch ran into (fixed at the cause)', () => {
  it('daemon.json is written whole or not at all — a command that reads it while the daemon starts never sees half a file', async () => {
    const { writeDaemonInfo, readDaemonInfo } = await import('../src/daemon/capabilities.js');
    const h = freshHome('morse-fu-atomic-');
    const before = process.env['MORSE_HOME'];
    process.env['MORSE_HOME'] = h;
    try {
      const info = { pid: process.pid, port: 1, capabilities: [...DAEMON_CAPABILITIES], token: TEST_TOKEN };
      writeDaemonInfo(info);
      expect(readDaemonInfo()).toEqual(info);
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(join(h, '.morse')).filter((f) => f.startsWith('daemon.json'))).toEqual(['daemon.json']); // (no temporary file left)
      if (process.platform !== 'win32') expect(statSync(join(h, '.morse', 'daemon.json')).mode & 0o777).toBe(0o600);
    } finally {
      if (before === undefined) delete process.env['MORSE_HOME'];
      else process.env['MORSE_HOME'] = before;
    }
    // (the write goes through a rename: nothing in the module truncates the file in place)
    expect(readFileSync(new URL('../src/daemon/capabilities.ts', import.meta.url), 'utf8')).not.toContain('writeFileSync');
  });

  it('`morse plugin watch` knows who started it from the moment the process begins — not from after its first output', () => {
    // (read later, a reader killed right after the first event was taken for "the parent is still the same": the
    // watch then polled for ever. The behaviour itself is test/plugin-interface.test.ts.)
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(source.indexOf('const STARTED_BY = process.ppid;')).toBeGreaterThan(0);
    expect(source.indexOf('const STARTED_BY = process.ppid;')).toBeLessThan(source.indexOf('const program = new Command();'));
    expect(source).toContain('const startedBy = STARTED_BY;');
    expect(source.match(/process\.ppid/g)!.length).toBe(2); // (where it is captured, and where the watch compares)
  });
});

