import { readFileSync, statSync } from 'node:fs';
import { request as httpRequest, createServer as createHttpServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAP_LOCAL_API_AUTH, DAEMON_CAPABILITIES } from '../src/daemon/capabilities.js';
import { daemonOfThisHome, ensureExternalToken, externalAgentOfToken, externalTokenPath, LOCAL_TOKEN_HEADER, localApi, NO_DAEMON_LINE, NoDaemonForThisHome, removeExternalToken } from '../src/daemon/local-api.js';
import { LOCAL_API_ROUTES, startConsoleServer, UNAUTHORIZED, type RunningServer } from '../src/daemon/server.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { daemonJson, freePort, noDaemonJson, realServerOn, TEST_TOKEN } from './helpers/local-api.js';
import { cliAt, cliRaw, freshHome, removeHomes } from './helpers/personas-home.js';
import { daemonStub, killStubs, unrelatedStub } from './helpers/stub-process.js';

/**
 * ADR-087 — who may use the daemon's local API.
 *
 * Before: no token, no Origin / Host check, and a body parsed as JSON whatever its content type — so any web
 * page the owner opened could queue mail to a local agent session AS THE OWNER (a "simple" cross-origin POST,
 * no preflight), have files read off the disk and sent to an address of its choosing, and read the session
 * list through DNS rebinding; and a `morse` command of one Morse home talked to whatever daemon listened on
 * the port — another home's.
 *
 * Now every route but the ones marked `none` needs a credential in the `x-morse-token` header, a browser on
 * another page is turned away before that is even looked at, and a command talks to the daemon of its own
 * home or to none.
 */

/** One raw HTTP request — headers exactly as given (`fetch` would not let a test set Host or Origin freely). */
const raw = (port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> =>
  new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: { host: `127.0.0.1:${port}`, ...(o.body !== undefined ? { 'content-length': String(Buffer.byteLength(o.body)) } : {}), ...(o.headers ?? {}) }, setHost: false }, (res) => {
      // (the event stream never ends: its head is the answer)
      if (String(res.headers['content-type']).startsWith('text/event-stream')) {
        res.destroy();
        return done({ status: res.statusCode ?? 0, headers: res.headers, text: '' });
      }
      let text = '';
      res.on('data', (c) => (text += String(c)));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', fail);
    req.end(o.body);
  });
const JSON_TYPE = { 'content-type': 'application/json' };
const withToken = (token: string = TEST_TOKEN): Record<string, string> => ({ [LOCAL_TOKEN_HEADER]: token });

let home: string;
let mailbox: Mailbox;
let server: RunningServer;
let port: number;
let staged: string[][];
let stopped: number;
const count = (): number => mailbox.inbox({ all: true }).length;

beforeAll(async () => {
  home = freshHome('morse-api-auth-');
  mailbox = createMailbox(createDb(':memory:'));
  port = await freePort();
  realServerOn(port);
  staged = [];
  stopped = 0;
  server = startConsoleServer({
    token: TEST_TOKEN,
    mailbox,
    directory: async () => [{ agent: 'claude', sessionId: 'c-1', title: 'a session', cwd: '/work/secret-project', lastActiveAt: 1 }],
    port,
    changePollMs: 60_000,
    registryHome: home,
    knowsDevice: (d) => d === 'kai',
    stageFiles: (paths) => {
      staged.push(paths);
      return [];
    },
    shutdown: { run: () => stopped++ },
  });
  await new Promise((r) => setTimeout(r, 50));
});
afterAll(async () => {
  server.close();
  await killStubs();
  removeHomes();
});

describe("the reviewer's proofs no longer work (ADR-087)", () => {
  const MAIL = JSON.stringify({ from: { agent: 'user', sessionId: 'web' }, to: { agent: 'user', sessionId: 'inbox' }, text: 'queued by a web page' });

  it('a cross-origin "simple" POST (Origin: evil, Content-Type: text/plain, a JSON body) queues nothing', async () => {
    const before = count();
    const r = await raw(port, { method: 'POST', path: '/api/messages', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: MAIL });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text)).toEqual({ error: 'forbidden' });
    // …nor without the Origin header (a form post from a page that hides it): no token
    expect((await raw(port, { method: 'POST', path: '/api/messages', headers: { 'content-type': 'text/plain' }, body: MAIL })).status).toBe(401);
    // …nor from the page of another local server (same host, another port)
    expect((await raw(port, { method: 'POST', path: '/api/messages', headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'text/plain' }, body: MAIL })).status).toBe(403);
    expect((await raw(port, { method: 'POST', path: '/api/messages', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: MAIL })).status).toBe(403);
    expect(count()).toBe(before);
  });

  it('files are not read off the disk for a web page: POST /api/send with `files` and a morse.im target', async () => {
    const before = count();
    const body = JSON.stringify({ target: 'morse.im/kai', text: 'here are your files', files: ['/etc/passwd'] });
    for (const headers of [{ origin: 'https://evil.example', 'content-type': 'text/plain' }, { 'content-type': 'text/plain' }, { ...JSON_TYPE }, { ...JSON_TYPE, ...withToken('not-the-token') }]) {
      const r = await raw(port, { method: 'POST', path: '/api/send', headers, body });
      expect([401, 403], JSON.stringify(headers)).toContain(r.status);
    }
    expect(staged).toEqual([]);
    expect(count()).toBe(before);
  });

  it('DNS rebinding: a request whose Host is not this server\'s own loopback name and port is refused — whatever it asks for', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `localhost.evil.example:${port}`, '']) {
      for (const path of ['/api/sessions', '/api/conversations', '/api/ping', '/']) {
        const r = await raw(port, { path, headers: { host, ...withToken() } });
        expect(r.status, `${host} ${path}`).toBe(403);
        expect(r.text).not.toContain('secret-project');
      }
    }
    // its own names are answered
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) expect((await raw(port, { path: '/api/sessions', headers: { host, ...withToken() } })).status).toBe(200);
  });
});

describe('every route needs a credential — the list is THE list (ADR-087)', () => {
  const guarded = LOCAL_API_ROUTES.filter((r) => !(r.auth as readonly string[]).includes('none'));
  const open = LOCAL_API_ROUTES.filter((r) => (r.auth as readonly string[]).includes('none'));

  it('(the routes: three need nothing, every other one names who may call it)', () => {
    expect(open.map((r) => `${r.method} ${r.example}`).sort()).toEqual(['GET /', 'GET /api/ping', 'POST /api/console/session']);
    expect(guarded.length).toBeGreaterThanOrEqual(15);
    for (const r of guarded) expect(r.auth.length, r.name).toBeGreaterThan(0);
    // every route says `daemon`: the morse command can do everything
    for (const r of guarded) expect(r.auth, r.name).toContain('daemon');
    // each example matches its own pattern, and no two routes answer the same request
    for (const r of LOCAL_API_ROUTES) {
      const hits = LOCAL_API_ROUTES.filter((x) => x.method === r.method && (typeof x.path === 'string' ? x.path === r.example : x.path.test(r.example)));
      expect(hits.map((h) => h.name), r.name).toEqual([r.name]);
    }
  });

  it('the handlers are reached through the list alone: the server source compares no path and no method of its own', () => {
    const source = readFileSync(new URL('../src/daemon/server.ts', import.meta.url), 'utf8');
    const handle = source.slice(source.indexOf('async function handle('));
    // (the two checks that come BEFORE the list: the peer prefix and OPTIONS)
    expect(handle.match(/\bpath === '\//g)).toBeNull();
    expect(handle.match(/path\.(startsWith|endsWith|includes)\('\/(?!api\/peer\/)/g)).toBeNull();
    expect(handle.match(/req\.method === '(?!OPTIONS')/g)).toBeNull();
    // every handler is `if (name === '<a name of the list>')`, and every name of the list has one
    const handled = [...handle.matchAll(/name === '([A-Za-z]+)'/g)].map((m) => m[1]!);
    expect([...new Set(handled)].sort()).toEqual(LOCAL_API_ROUTES.map((r) => r.name).sort());
  });

  it.each(guarded.map((r) => [`${r.method} ${r.example}`, r] as const))('%s: no token, a wrong token, the token anywhere but the header → 401, the same words, nothing done', async (_name, r) => {
    const before = count();
    const body = r.method === 'POST' ? JSON.stringify({ from: { agent: 'user', sessionId: 'web' }, to: { agent: 'user', sessionId: 'inbox' }, target: '@claude:c-1', text: 'x', agent: 'sds', sessionId: 's', handle: 'kai', deviceId: 'd' }) : undefined;
    const attempts: Array<{ path: string; headers: Record<string, string> }> = [
      { path: r.example, headers: {} },
      { path: r.example, headers: withToken('0'.repeat(48)) },
      { path: r.example, headers: withToken(TEST_TOKEN.slice(0, -1)) },
      { path: r.example, headers: withToken(`${TEST_TOKEN}0`) },
      { path: r.example, headers: withToken('') },
      { path: `${r.example}?token=${TEST_TOKEN}&${LOCAL_TOKEN_HEADER}=${TEST_TOKEN}`, headers: {} },
      { path: r.example, headers: { authorization: `Bearer ${TEST_TOKEN}`, cookie: `${LOCAL_TOKEN_HEADER}=${TEST_TOKEN}; morse_console=${TEST_TOKEN}` } },
    ];
    for (const a of attempts) {
      const res = await raw(port, { method: r.method, path: a.path, headers: { ...(body ? JSON_TYPE : {}), ...a.headers }, ...(body ? { body } : {}) });
      expect(res.status, JSON.stringify(a)).toBe(401);
      expect(JSON.parse(res.text)).toEqual({ error: UNAUTHORIZED });
    }
    expect(count()).toBe(before);
    expect(stopped).toBe(0);
  });

  it('a path that does not exist says 401 too — an unauthenticated caller does not learn which paths do', async () => {
    for (const path of ['/api/nope', '/api/collab', '/secret', '/api/sessions/']) {
      expect((await raw(port, { path })).status, path).toBe(401);
      expect((await raw(port, { path, headers: withToken() })).status, path).toBe(404);
    }
    // a method a route does not have
    expect((await raw(port, { method: 'DELETE', path: '/api/sessions' })).status).toBe(401);
    expect((await raw(port, { method: 'POST', path: '/api/sessions', headers: withToken() })).status).toBe(404);
  });

  it('with the daemon token every route answers (the morse command)', async () => {
    const answers: Record<string, number> = {};
    for (const r of guarded.filter((x) => x.name !== 'shutdown')) {
      const body = r.method === 'POST' && !['retry', 'consoleCode'].includes(r.name) ? '{}' : undefined;
      const res = await raw(port, { method: r.method, path: r.example, headers: { ...withToken(), ...(body ? JSON_TYPE : {}) }, ...(body ? { body } : {}) });
      answers[r.name] = res.status;
      expect([401, 403], r.name).not.toContain(res.status);
    }
    // (400 / 404 here are the routes' own answers to an empty body or an unknown id)
    expect(answers).toMatchObject({ sessions: 200, peers: 200, conversations: 200, events: 200, update: 200, consoleCode: 201 });
  });

  it('no answer ever carries a CORS header; a preflight finds nothing', async () => {
    for (const r of LOCAL_API_ROUTES) {
      const pre = await raw(port, { method: 'OPTIONS', path: r.example, headers: { origin: 'https://evil.example', 'access-control-request-method': r.method, 'access-control-request-headers': `${LOCAL_TOKEN_HEADER}, content-type` } });
      expect(pre.status, r.name).toBe(404);
      for (const res of [pre, await raw(port, { method: r.method, path: r.example }), await raw(port, { method: r.method, path: r.example, headers: { ...withToken(), origin: 'https://evil.example' } })]) {
        expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-')), r.name).toEqual([]);
      }
    }
  });
});

describe('a browser on another page is turned away even WITH a valid token (ADR-087)', () => {
  it('any Origin but this server\'s own, any Sec-Fetch-Site but same-origin / none: 403', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: `http://127.0.0.1:${port + 1}` }, { origin: `https://127.0.0.1:${port}` }, { origin: `http://evil.example:${port}` }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      const r = await raw(port, { path: '/api/sessions', headers: { ...withToken(), ...headers } });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.text).not.toContain('secret-project');
    }
    for (const headers of [{ origin: `http://127.0.0.1:${port}` }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
      expect((await raw(port, { path: '/api/sessions', headers: { ...withToken(), ...headers } })).status, JSON.stringify(headers)).toBe(200);
    }
  });

  it('a body is read only as Content-Type: application/json — and only so much of it', async () => {
    const before = count();
    const mail = JSON.stringify({ from: { agent: 'user', sessionId: 'web' }, to: { agent: 'user', sessionId: 'inbox' }, text: 'typed' });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json-seq', '']) {
      const r = await raw(port, { method: 'POST', path: '/api/messages', headers: { ...withToken(), ...(type ? { 'content-type': type } : {}) }, body: mail });
      expect(r.status, type).toBe(415);
    }
    expect(count()).toBe(before);
    expect((await raw(port, { method: 'POST', path: '/api/messages', headers: { ...withToken(), ...JSON_TYPE }, body: '{ not json' })).status).toBe(400);
    expect((await raw(port, { method: 'POST', path: '/api/messages', headers: { ...withToken(), ...JSON_TYPE }, body: JSON.stringify({ text: 'x'.repeat(5 * 1024 * 1024) }) })).status).toBe(413);
    expect(count()).toBe(before);
    const ok = await raw(port, { method: 'POST', path: '/api/messages', headers: { ...withToken(), 'content-type': 'Application/JSON; charset=utf-8' }, body: mail });
    expect(ok.status).toBe(201);
    expect(count()).toBe(before + 1);
  });
});

describe('the liveness probe and the console page need nothing — and give nothing away (ADR-087)', () => {
  it('GET /api/ping: that a Morse daemon listens here, nothing else', async () => {
    const r = await raw(port, { path: '/api/ping' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ morse: true });
  });

  it('GET / (and /console): the static page — no data, no token in it; it may not be framed and is not cached', async () => {
    for (const path of ['/', '/index.html', '/console']) {
      const r = await raw(port, { path });
      expect(r.status, path).toBe(200);
      expect(String(r.headers['content-type'])).toMatch(/^text\/html/);
      expect(r.text).not.toContain(TEST_TOKEN);
      expect(r.text).not.toContain('secret-project');
      expect(r.text).toContain('morse console'); // (it says how to sign in)
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('the web console signs in with a one-time code from `morse console` (ADR-087)', () => {
  const code = async (): Promise<string> => (JSON.parse((await raw(port, { method: 'POST', path: '/api/console/code', headers: withToken() })).text) as { code: string }).code;
  const exchange = (c: unknown) => raw(port, { method: 'POST', path: '/api/console/session', headers: { ...JSON_TYPE, origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ code: c }) });

  it('a code is traded once for a session; a wrong, used or missing code gets nothing', async () => {
    const c = await code();
    expect(c).toMatch(/^[0-9a-f]{48}$/);
    for (const wrong of ['', 'x', c.slice(0, -1), `${c}0`, 42, null]) expect((await exchange(wrong)).status, String(wrong)).toBe(401);
    const first = await exchange(c);
    expect(first.status).toBe(201);
    const { token } = JSON.parse(first.text) as { token: string };
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(token).not.toBe(TEST_TOKEN);
    expect((await exchange(c)).status).toBe(401); // (used)
    // a code is not a credential anywhere else, and a session is not a code
    expect((await raw(port, { path: '/api/sessions', headers: withToken(c) })).status).toBe(401);
    expect((await exchange(token)).status).toBe(401);
    // the exchange itself obeys the browser rules: not from another page
    const c2 = await code();
    expect((await raw(port, { method: 'POST', path: '/api/console/session', headers: { ...JSON_TYPE, origin: 'https://evil.example' }, body: JSON.stringify({ code: c2 }) })).status).toBe(403);
    expect((await raw(port, { method: 'POST', path: '/api/console/session', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ code: c2 }) })).status).toBe(415);
    expect((await exchange(c2)).status).toBe(201); // (neither attempt used it up)
  });

  it('a console session opens what the page uses — and nothing else', async () => {
    const { token } = JSON.parse((await exchange(await code())).text) as { token: string };
    const as = (r: { method: string; example: string }, body?: string) => raw(port, { method: r.method, path: r.example, headers: { ...withToken(token), ...(body ? JSON_TYPE : {}) }, ...(body ? { body } : {}) });
    for (const r of LOCAL_API_ROUTES.filter((x) => !(x.auth as readonly string[]).includes('none'))) {
      const allowed = (r.auth as readonly string[]).includes('console');
      const res = await as(r, r.method === 'POST' && r.name !== 'retry' ? '{}' : undefined);
      if (allowed) expect([401, 403], r.name).not.toContain(res.status);
      else expect(res.status, r.name).toBe(403);
    }
    expect(LOCAL_API_ROUTES.filter((r) => (r.auth as readonly string[]).includes('console')).map((r) => r.name).sort()).toEqual(['conversationMessages', 'conversations', 'events', 'messages', 'retry', 'sessions']);
    expect(stopped).toBe(0);
    expect(staged).toEqual([]);
  });

  it('only the morse command can ask for a code', async () => {
    const { token } = JSON.parse((await exchange(await code())).text) as { token: string };
    expect((await raw(port, { method: 'POST', path: '/api/console/code' })).status).toBe(401);
    expect((await raw(port, { method: 'POST', path: '/api/console/code', headers: withToken(token) })).status).toBe(403);
  });
});

describe('an external agent has its own token — and acts as itself only (ADR-087, ADR-024)', () => {
  let sds: string;
  const post = (path: string, body: unknown, token: string = sds) => raw(port, { method: 'POST', path, headers: { ...withToken(token), ...JSON_TYPE }, body: JSON.stringify(body) });

  beforeAll(() => {
    sds = ensureExternalToken('sds', home);
  });

  it('the token: random, in a file only the owner can read, the same until it is removed', () => {
    expect(sds).toMatch(/^[0-9a-f]{48}$/);
    expect(ensureExternalToken('sds', home)).toBe(sds);
    expect(readFileSync(externalTokenPath('sds', home), 'utf8')).toBe(`${sds}\n`);
    if (process.platform !== 'win32') {
      expect(statSync(externalTokenPath('sds', home)).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, '.morse', 'api-tokens')).mode & 0o777).toBe(0o700);
    }
    expect(externalAgentOfToken(sds, home)).toBe('sds');
    expect(externalAgentOfToken(TEST_TOKEN, home)).toBeNull();
    expect(() => ensureExternalToken('../x', home)).toThrow(/not a valid external agent name/);
    expect(() => ensureExternalToken('A', home)).toThrow(/not a valid external agent name/);
  });

  it('it registers, reads its own mail, lists sessions and sends — as `sds`', async () => {
    const inbox = await post('/api/inbox', { agent: 'sds', sessionId: 'main', register: true, title: '闪电说助手' });
    expect(inbox.status).toBe(201);
    expect((await post('/api/register', { agent: 'sds', sessionId: 'second' })).status).toBe(201);
    expect((await post('/api/inbox', { sessionId: 'main' })).status).toBe(201); // (a session it registered)
    expect((await raw(port, { path: '/api/sessions?limit=5', headers: withToken(sds) })).status).toBe(200);
    const before = count();
    const sent = await post('/api/send', { target: '@claude:c-1', from: { agent: 'sds', sessionId: 'main' }, text: 'please fix the login page' });
    expect(sent.status).toBe(201);
    expect(count()).toBe(before + 1);
  });

  it('never as another agent, never another session\'s mail, no files, no address of the owner\'s, nothing else of the API', async () => {
    const before = count();
    // another agent's name; the built-in ones
    for (const agent of ['ilink', 'claude', 'user', 'SDS2']) expect((await post('/api/register', { agent, sessionId: 'x' })).status, agent).toBe(403);
    expect((await post('/api/inbox', { agent: 'claude', sessionId: 'c-1', register: true })).status).toBe(403);
    // the mail of a session it did not register (a Claude session; the owner's inbox)
    for (const sessionId of ['c-1', 'inbox', 'cli']) expect((await post('/api/inbox', { sessionId })).status, sessionId).toBe(403);
    // sending: as itself, text only
    const ok = { target: '@claude:c-1', from: { agent: 'sds', sessionId: 'main' }, text: 'x' };
    for (const body of [
      { ...ok, from: { agent: 'user', sessionId: 'cli' } },
      { ...ok, from: { agent: 'claude', sessionId: 'c-1' } },
      { ...ok, from: undefined },
      { ...ok, from: { agent: 'sds', sessionId: 'main', device: 'kai' } },
      { ...ok, target: 'morse.im/kai', files: ['/etc/passwd'] },
      { ...ok, files: [] },
      { ...ok, fromAddress: 'work' },
    ]) {
      expect((await post('/api/send', body)).status, JSON.stringify(body)).toBe(403);
    }
    expect(staged).toEqual([]);
    expect(count()).toBe(before);
    // the rest of the API
    for (const r of LOCAL_API_ROUTES.filter((x) => !(x.auth as readonly string[]).includes('none') && !(x.auth as readonly string[]).includes('external'))) {
      const res = await raw(port, { method: r.method, path: r.example, headers: { ...withToken(sds), ...(r.method === 'POST' ? JSON_TYPE : {}) }, ...(r.method === 'POST' ? { body: '{}' } : {}) });
      expect(res.status, r.name).toBe(403);
    }
    expect(LOCAL_API_ROUTES.filter((r) => (r.auth as readonly string[]).includes('external')).map((r) => r.name).sort()).toEqual(['inbox', 'register', 'send', 'sessions']);
    expect(stopped).toBe(0);
  });

  it('removed (`morse connect … --uninstall`): the token opens nothing any more — at once, no restart', async () => {
    const other = ensureExternalToken('other-app', home);
    expect((await raw(port, { path: '/api/sessions', headers: withToken(other) })).status).toBe(200);
    removeExternalToken('other-app', home);
    expect((await raw(port, { path: '/api/sessions', headers: withToken(other) })).status).toBe(401);
    expect((await raw(port, { path: '/api/sessions', headers: withToken(sds) })).status).toBe(200);
  });
});

describe('a command talks to the daemon of ITS OWN home — or to none (ADR-087, finding 2)', () => {
  /** What a listener got: any request at all is one too many when the command should not have talked to it. */
  const listener = async (answer: (token: string | undefined) => number = () => 200): Promise<{ port: number; got: Array<{ url: string; token: string | undefined }>; close: () => Promise<void> }> => {
    const got: Array<{ url: string; token: string | undefined }> = [];
    const s: Server = createHttpServer((req, res) => {
      req.resume();
      const token = req.headers[LOCAL_TOKEN_HEADER] as string | undefined;
      got.push({ url: req.url ?? '', token });
      res.writeHead(answer(token), { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((done) => s.listen(0, '127.0.0.1', () => done()));
    return { port: (s.address() as { port: number }).port, got, close: () => new Promise((done) => s.close(() => done())) };
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

  it('no daemon.json in this home: nothing is sent — not to the port it was given, not to any default', async () => {
    const l = await listener();
    const h = freshHome('morse-api-nohome-');
    try {
      await inHome(h, async () => {
        expect(daemonOfThisHome()).toBeNull();
        for (const p of [l.port, undefined]) {
          const e = await refused(() => localApi('/api/send', { port: p, json: { target: '@claude', text: 'x' } }));
          expect({ why: e.why, message: e.message, code: e.cause.code }).toEqual({ why: 'none', message: NO_DAEMON_LINE, code: 'ECONNREFUSED' });
        }
      });
      expect(l.got).toEqual([]);
    } finally {
      await l.close();
    }
  });

  it('a daemon.json whose daemon is gone (a dead pid): nothing is sent either', async () => {
    const l = await listener();
    const h = freshHome('morse-api-dead-');
    const gone = await unrelatedStub();
    const pid = gone.pid!;
    gone.kill('SIGKILL');
    await new Promise((r) => gone.once('exit', r));
    daemonJson(h, l.port, { pid });
    try {
      await inHome(h, async () => expect((await refused(() => localApi('/api/peers'))).why).toBe('none'));
      expect(l.got).toEqual([]);
    } finally {
      await l.close();
    }
  });

  it('what answers on the port does not accept this home\'s token (another home\'s daemon): said so, and nothing more is sent', async () => {
    const l = await listener((token) => (token === 'the-other-homes-token' ? 200 : 401));
    const h = freshHome('morse-api-other-');
    daemonJson(h, l.port);
    try {
      await inHome(h, async () => {
        const e = await refused(() => localApi('/api/send', { json: { target: '@claude', text: 'x' } }));
        expect({ why: e.why, port: e.port }).toEqual({ why: 'other', port: l.port });
      });
      expect(l.got).toEqual([{ url: '/api/send', token: TEST_TOKEN }]);
    } finally {
      await l.close();
    }
  });

  it('this home\'s daemon: the request carries this home\'s token, as JSON, to the port daemon.json names', async () => {
    const h = freshHome('morse-api-mine-');
    daemonJson(h, port);
    await inHome(h, async () => {
      expect(daemonOfThisHome()).toMatchObject({ port, token: TEST_TOKEN });
      const res = await localApi('/api/peers');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { capabilities: string[] }).capabilities).toEqual([...DAEMON_CAPABILITIES]);
      expect(DAEMON_CAPABILITIES).toContain(CAP_LOCAL_API_AUTH);
    });
  });

  it('a daemon of the release before (a daemon.json without a token) is believed only when its pid is a live Morse daemon — and is sent no token', async () => {
    const l = await listener();
    const h = freshHome('morse-api-old-');
    const before = ['from-address', 'contacts-per-address'];
    try {
      // the pid is this test process: alive, but not a Morse daemon
      daemonJson(h, l.port, { token: null, capabilities: before });
      await inHome(h, async () => expect((await refused(() => localApi('/api/peers'))).why).toBe('none'));
      expect(l.got).toEqual([]);
      const old = await daemonStub();
      daemonJson(h, l.port, { token: null, capabilities: before, pid: old.pid! });
      await inHome(h, async () => expect((await localApi('/api/peers')).status).toBe(200));
      expect(l.got).toEqual([{ url: '/api/peers', token: undefined }]);
    } finally {
      await l.close();
    }
  });
});

describe('through the real CLI (temp MORSE_HOME + HOME, isolated ports)', () => {
  let daemonHome: string;

  beforeAll(() => {
    daemonHome = freshHome('morse-api-cli-');
    daemonJson(daemonHome, port);
  });

  it('a command of ANOTHER home, pointed at this daemon\'s port, hands it nothing — it says no daemon runs for its home', async () => {
    const other = freshHome('morse-api-cli-other-');
    const before = count();
    // (no daemon.json there at all)
    expect((await cliAt(other, ['message'])).code).toBe(0); // (its mailbox exists from here on: the first command says so on stderr)
    // (`cliRaw`: the command exactly as given — the helper that describes the home's daemon first would defeat the point)
    const none = await cliRaw(other, ['send', 'morse.im/k7f3a9xq', 'from another home', '--port', String(port)]);
    expect(none).toEqual({ code: 1, out: '', err: 'error: the daemon is not running — messages to other addresses (morse.im/k7f3a9xq) go through it: morse start\n' });
    // (a daemon.json of its own daemon, which is not the one listening there)
    daemonJson(other, port, { token: 'f'.repeat(48) });
    const wrong = await cliRaw(other, ['send', 'morse.im/k7f3a9xq', 'from another home', '--port', String(port)]);
    expect(wrong.code).toBe(1);
    expect(wrong.err.split('\n').filter(Boolean)).toEqual([
      `warning: port ${port} is not this home's Morse daemon — nothing was sent to it; no Morse daemon is running for this home — morse start`,
      'error: the daemon is not running — messages to other addresses (morse.im/k7f3a9xq) go through it: morse start',
    ]);
    // …and the other commands that ask the daemon something: nothing reaches it, each goes on as with no daemon
    noDaemonJson(other);
    const status = await cliRaw(other, ['status', '--port', String(port)]);
    expect(status.code).toBe(0);
    expect(status.out.split('\n')[0]).toBe('daemon: not running');
    const con = await cliRaw(other, ['console', '--port', String(port)]);
    expect(con).toEqual({ code: 1, out: '', err: `error: ${NO_DAEMON_LINE}\n` });
    expect(count()).toBe(before);
  }, 60_000);

  it('`morse console`: a link that works once — the page it opens can sign in with it', async () => {
    const r = await cliAt(daemonHome, ['console']);
    expect(r.code, r.err).toBe(0);
    const lines = r.out.split('\n').filter(Boolean);
    expect(lines[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/console#code=[0-9a-f]{48}$`));
    expect(lines[1]).toBe('open it in a browser on this computer within a minute — the link works once');
    const code = lines[0]!.split('#code=')[1]!;
    const first = await raw(port, { method: 'POST', path: '/api/console/session', headers: JSON_TYPE, body: JSON.stringify({ code }) });
    expect(first.status).toBe(201);
    expect((await raw(port, { method: 'POST', path: '/api/console/session', headers: JSON_TYPE, body: JSON.stringify({ code }) })).status).toBe(401);
    const { token } = JSON.parse(first.text) as { token: string };
    expect((await raw(port, { path: '/api/conversations', headers: withToken(token) })).status).toBe(200);
  }, 30_000);

  it('`morse connect --agent <name> --session <id>`: the app gets its own token; gone with its last session', async () => {
    const r = await cliAt(daemonHome, ['connect', '--agent', 'notes-app', '--session', 'n-1']);
    expect(r.code, r.err).toBe(0);
    const path = join(daemonHome, '.morse', 'api-tokens', 'notes-app');
    expect(r.out).toContain(`its token for the local API — as @notes-app, session n-1 only (POST /api/register, /api/inbox, /api/send; GET /api/sessions): curl -H @${path}.header …`);
    const token = readFileSync(path, 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(r.out).not.toContain(token); // (the token itself is never printed)
    expect(readFileSync(`${path}.header`, 'utf8')).toBe(`x-morse-token: ${token}\n`);
    // (follow-up 1) bound to the session it was issued for — and to a second one only when that is connected too
    expect(JSON.parse(readFileSync(`${path}.json`, 'utf8'))).toEqual({ v: 1, sessions: ['n-1'], open: false });
    expect((await cliAt(daemonHome, ['connect', '--agent', 'notes-app', '--session', 'n-2'])).code).toBe(0);
    expect(JSON.parse(readFileSync(`${path}.json`, 'utf8'))).toEqual({ v: 1, sessions: ['n-1', 'n-2'], open: false });
    expect(readFileSync(path, 'utf8').trim()).toBe(token);
    expect((await cliAt(daemonHome, ['connect', '--agent', 'notes-app', '--session', 'n-1', '--uninstall'])).code).toBe(0);
    expect(JSON.parse(readFileSync(`${path}.json`, 'utf8'))).toEqual({ v: 1, sessions: ['n-2'], open: false });
    expect((await cliAt(daemonHome, ['connect', '--agent', 'notes-app', '--session', 'n-2', '--uninstall'])).code).toBe(0);
    for (const f of [path, `${path}.header`, `${path}.json`]) expect(() => readFileSync(f), f).toThrow();
  }, 30_000);
});

describe('across the update (ADR-087)', () => {
  it('an older morse command (no token) against this daemon: 401 with words that say what to do — nothing is queued', async () => {
    const before = count();
    // what `morse send` of the release before posts
    const res = await fetch(`http://127.0.0.1:${port}/api/send`, { method: 'POST', headers: JSON_TYPE, body: JSON.stringify({ target: '@claude:c-1', from: { agent: 'user', sessionId: 'cli' }, text: 'from an old command' }) });
    expect(res.status).toBe(401);
    const { error } = (await res.json()) as { error: string };
    // (that release prints `error: <this>` and exits 1)
    expect(error).toBe(UNAUTHORIZED);
    expect(error).toContain('morse update');
    expect(error).toContain('morse connect <app> --apply');
    expect(count()).toBe(before);
    // its "is the port taken?" probe at `morse start` still gets an answer (any answer means taken)
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions`)).status).toBe(401);
  });

  it('this release says `local-api-auth` — a daemon that does not is an older one for every command (test/cli-older-daemon.test.ts)', () => {
    expect([...DAEMON_CAPABILITIES]).toEqual(['from-address', 'contacts-per-address', 'local-api-auth', 'listener-proof', 'addresses-only']);
  });
});
