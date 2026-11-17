import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { DAEMON_CAPABILITIES } from '../src/daemon/capabilities.js';
import { LOCAL_TOKEN_HEADER } from '../src/daemon/local-api.js';
import { startConsoleServer, type ConsoleServerOptions, type RunningServer } from '../src/daemon/server.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { authedFetch, freePort, TEST_TOKEN } from './helpers/local-api.js';

// The daemon's local HTTP API as the `morse` command and the web console use it: routes, JSON shapes,
// the event stream and change detection. Who may call what is covered by local-api-auth.test.ts.

const API = { agent: 'claude', sessionId: '5e550001-aaaa-4000-8000-000000000001' };
const WEB = { agent: 'codex', sessionId: '5e550002-bbbb-4000-8000-000000000002' };
const SESSIONS: SessionInfo[] = [
  { agent: 'claude', sessionId: API.sessionId, title: 'API Gateway', cwd: '/repo/gateway', lastActiveAt: 11 },
  { agent: 'codex', sessionId: WEB.sessionId, title: 'Web Shell', cwd: '/repo/shell', lastActiveAt: 22 },
];

const running: RunningServer[] = [];
afterEach(() => {
  while (running.length) running.pop()!.close();
});

/** Start a console server on a free port with an in-memory mailbox; returns helpers bound to it. */
async function serve(extra: Partial<ConsoleServerOptions> = {}) {
  const mailbox: Mailbox = extra.mailbox ?? createMailbox(createDb(':memory:'));
  const port = await freePort();
  const server = startConsoleServer({ token: TEST_TOKEN, mailbox, directory: async () => SESSIONS, port, changePollMs: 60_000, ...extra });
  running.push(server);
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  const get = (path: string) => authedFetch(url(path));
  const post = (path: string, body?: unknown) =>
    authedFetch(url(path), { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { mailbox, server, port, url, get, post };
}

/** Open the event stream and collect its `data:` lines until `stop()`. */
function listen(port: number): Promise<{ status: number; type: string; lines: string[]; stop: () => void }> {
  return new Promise((done, fail) => {
    const lines: string[] = [];
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events', headers: { [LOCAL_TOKEN_HEADER]: TEST_TOKEN } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) lines.push(line.slice(6));
      });
      res.on('error', () => undefined);
      done({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), lines, stop: () => req.destroy() });
    });
    req.on('error', (e) => (String(e).includes('socket hang up') ? undefined : fail(e)));
    req.end();
  });
}
const until = async (check: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('static page and plain routes', () => {
  it('serves the console page as HTML with a locked-down policy', async () => {
    const { get } = await serve();
    for (const path of ['/', '/index.html', '/console']) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(await r.text()).toContain('Morse console');
    }
  });

  it('answers JSON with no-store and nosniff', async () => {
    const r = await (await serve()).get('/api/conversations');
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await r.json()).toEqual({ conversations: [] });
  });

  it('404s an unknown route, and the old peer paths with a pointer to the TLS port', async () => {
    const { get, post } = await serve();
    expect((await get('/api/does-not-exist')).status).toBe(404);
    const peer = await get('/api/peer/sessions');
    expect(peer.status).toBe(404);
    expect(((await peer.json()) as { error: string }).error).toMatch(/mutual TLS/);
    expect((await post('/api/peer/messages', { x: 1 })).status).toBe(404);
  });

  it('GET /api/update reports the update view, or not busy', async () => {
    expect(await (await (await serve()).get('/api/update')).json()).toEqual({ busy: null });
    const view = { busy: 'transfer abc', release: 7, version: '1.2.3' };
    expect(await (await (await serve({ updateStatus: () => view })).get('/api/update')).json()).toEqual(view);
  });

  it('POST /api/shutdown answers first, then runs the stop; 404 without one', async () => {
    let stops = 0;
    const s = await serve({ shutdown: { run: () => stops++ } });
    const r = await s.post('/api/shutdown');
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ ok: true, pid: process.pid });
    await until(() => stops === 1);
    expect((await (await serve()).post('/api/shutdown')).status).toBe(404);
  });
});

describe('GET /api/sessions', () => {
  it('returns the whole directory when unfiltered', async () => {
    expect(await (await (await serve()).get('/api/sessions')).json()).toEqual({ sessions: SESSIONS });
  });

  it('narrows by agent (case-insensitive), by title or folder text, and by limit', async () => {
    const { get } = await serve();
    const titles = async (qs: string) => ((await (await get(`/api/sessions${qs}`)).json()) as { sessions: SessionInfo[] }).sessions.map((s) => s.title);
    expect(await titles('?agent=CODEX')).toEqual(['Web Shell']);
    expect(await titles('?q=gateway')).toEqual(['API Gateway']);
    expect(await titles('?q=/repo/sh')).toEqual(['Web Shell']);
    expect(await titles('?q=zzz')).toEqual([]);
    expect(await titles('?limit=1')).toEqual(['API Gateway']);
    expect(await titles('?limit=-3')).toHaveLength(2);
    expect(await titles('?limit=many')).toHaveLength(2);
  });

  it('caps the limit at 200', async () => {
    const many: SessionInfo[] = Array.from({ length: 250 }, (_, i) => ({ agent: 'claude', sessionId: `s${i}`, title: `t${i}`, cwd: '/x', lastActiveAt: i }));
    const { get } = await serve({ directory: async () => many });
    expect(((await (await get('/api/sessions?limit=999')).json()) as { sessions: unknown[] }).sessions).toHaveLength(200);
  });
});

describe('web console messaging', () => {
  it('POST /api/messages queues a webui message and the conversation views show it', async () => {
    const { post, get } = await serve();
    const r = await post('/api/messages', { from: API, to: WEB, text: 'from the console' });
    expect(r.status).toBe(201);
    const { message } = (await r.json()) as { message: { id: string; conversationId: string; parts: Array<{ via?: string }>; to: unknown } };
    expect(message.parts[0]?.via).toBe('webui');
    expect(message.to).toEqual(WEB);
    const { conversations } = (await (await get('/api/conversations')).json()) as { conversations: Array<{ id: string; messageCount: number }> };
    expect(conversations.map((c) => [c.id, c.messageCount])).toEqual([[message.conversationId, 1]]);
    const { messages } = (await (await get(`/api/conversations/${message.conversationId}/messages`)).json()) as { messages: Array<{ id: string }> };
    expect(messages.map((m) => m.id)).toEqual([message.id]);
  });

  it('POST /api/messages files into a named conversation', async () => {
    const { post, mailbox } = await serve();
    const seed = mailbox.send({ from: API, to: WEB, text: 'seed' });
    const r = await post('/api/messages', { from: { agent: 'user', sessionId: 'web' }, to: WEB, text: 'aside', conversationId: seed.conversationId });
    expect(((await r.json()) as { message: { conversationId: string } }).message.conversationId).toBe(seed.conversationId);
  });

  it('POST /api/messages rejects a body without both ends and text', async () => {
    const { post } = await serve();
    for (const body of [{ text: 'no ends' }, { from: API, to: WEB }, { from: API, to: WEB, text: '   ' }, { from: { agent: 'x' }, to: WEB, text: 'y' }]) {
      const r = await post('/api/messages', body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('expected {from:{agent,sessionId}, to:{agent,sessionId}, text, conversationId?}');
    }
  });

  it('rejects a body that is not JSON', async () => {
    const { url } = await serve();
    const r = await authedFetch(url('/api/messages'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'the body is not valid JSON' });
  });

  it('POST /api/messages/:id/retry requeues a dead message, and reports a refusal as 500', async () => {
    const { post, mailbox } = await serve();
    const m = mailbox.send({ from: API, to: WEB, text: 'x' });
    const refused = await post(`/api/messages/${m.id}/retry`);
    expect(refused.status).toBe(500);
    expect(((await refused.json()) as { error: string }).error).toMatch(/only failed/);
    mailbox.claimNextPending();
    mailbox.markFailed(m.id, 'gone', { terminal: true });
    const ok = await post(`/api/messages/${m.id}/retry`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { message: { status: string } }).message.status).toBe('pending');
  });

  it('GET /api/morse/transfer/:id shows a message and its transfer, 404 for none', async () => {
    const { get, mailbox } = await serve({ transferStatus: (id) => ({ id, sent: 1, of: 2 }) });
    const m = mailbox.send({ from: API, to: { ...WEB, device: 'far' }, text: 'big' });
    const r = await get(`/api/morse/transfer/${m.id}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ message: { id: m.id }, transfer: { id: m.id, sent: 1, of: 2 } });
    const none = await get('/api/morse/transfer/unknown-id');
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'no such message' });
  });
});

describe('version guard before queueing (ADR-025)', () => {
  const MISMATCH = 'version_mismatch: codex CLI 0.150.0 is older than Codex Desktop (0.160.0)';

  it('refuses /api/send and /api/messages to a stale local CLI with 409 and queues nothing', async () => {
    const asked: string[] = [];
    const { post, mailbox } = await serve({
      preflight: async (s) => {
        asked.push(s.sessionId);
        return s.agent === 'codex' ? MISMATCH : null;
      },
    });
    const viaSend = await post('/api/send', { target: '@codex:web shell', text: 'hello' });
    expect(viaSend.status).toBe(409);
    expect(await viaSend.json()).toMatchObject({ error: MISMATCH, code: 'version_mismatch', resolvedTarget: { sessionId: WEB.sessionId } });
    const viaConsole = await post('/api/messages', { from: API, to: WEB, text: 'hello' });
    expect(viaConsole.status).toBe(409);
    expect(await viaConsole.json()).toEqual({ error: MISMATCH, code: 'version_mismatch' });
    expect(mailbox.inbox({ all: true })).toEqual([]);
    expect((await post('/api/send', { target: '@claude:gateway', text: 'fine' })).status).toBe(201);
    expect(asked).toContain(API.sessionId);
  });

  it('an error without a code prefix is reported as preflight_failed', async () => {
    const { post } = await serve({ preflight: async () => 'Something Odd happened' });
    expect(await (await post('/api/messages', { from: API, to: WEB, text: 'x' })).json()).toEqual({ error: 'Something Odd happened', code: 'preflight_failed' });
  });
});

describe('POST /api/send to a local session', () => {
  it('resolves the target, sends as the CLI by default, and echoes what it resolved', async () => {
    const { post } = await serve();
    const r = await post('/api/send', { target: '@claude:gateway', text: 'ship it' });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { message: { from: unknown; to: unknown; parts: Array<{ via?: string }> }; resolvedTarget: SessionInfo; sentFrom: string };
    expect(body.message.from).toEqual({ agent: 'user', sessionId: 'cli' });
    expect(body.message.to).toEqual(API);
    expect(body.message.parts[0]?.via).toBe('cli');
    expect(body.resolvedTarget.sessionId).toBe(API.sessionId);
    expect(body.sentFrom).toBe('');
  });

  it('keeps an explicit sender', async () => {
    const { post } = await serve();
    const r = await post('/api/send', { target: '@codex:shell', from: API, text: 'hi' });
    expect(((await r.json()) as { message: { from: unknown } }).message.from).toEqual(API);
  });

  it('400 without target or text; 422 with candidates when nothing matches', async () => {
    const { post } = await serve();
    expect((await post('/api/send', { text: 'no target' })).status).toBe(400);
    expect((await post('/api/send', { target: '@claude:gateway', text: '' })).status).toBe(400);
    const missing = await post('/api/send', { target: '@claude:nothing-like-it', text: 'x' });
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { error: string }).error).toMatch(/^cannot resolve target "@claude:nothing-like-it" \(/);
  });

  it('files can only go to another address', async () => {
    const { post } = await serve({ stageFiles: () => [] });
    const r = await post('/api/send', { target: '@claude:gateway', text: 'x', files: ['/etc/hosts'] });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'files can only be sent to another address over the Morse relay' });
  });

  it('an explicit @device/agent:session reaches a known paired device as written', async () => {
    const { post } = await serve({ knowsDevice: (d) => d === 'studio' });
    const r = await post('/api/send', { target: '@studio/kimi:k-77', text: 'remote' });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { message: { to: unknown }; resolvedTarget: SessionInfo };
    expect(body.message.to).toEqual({ agent: 'kimi', sessionId: 'k-77', device: 'studio' });
    expect(body.resolvedTarget).toMatchObject({ device: 'studio', agent: 'kimi', sessionId: 'k-77', title: 'k-77' });
  });
});

describe('GET /api/peers', () => {
  it('without peering: LAN off, nobody, and the capabilities', async () => {
    expect(await (await (await serve()).get('/api/peers')).json()).toEqual({ lan: false, self: null, peers: [], capabilities: [...DAEMON_CAPABILITIES] });
  });

  it('relay only: self, trusted devices and relay state, no LAN list', async () => {
    const trustHome = mkdtempSync(join(tmpdir(), 'morse-srv-trust-'));
    try {
      const trust = createTrustStore(trustHome);
      const relay = { url: 'wss://relay.example', connected: true };
      const { get } = await serve({ peering: { selfDevice: 'here', selfId: 'ID-HERE', trust, relay: () => relay } });
      expect(await (await get('/api/peers')).json()).toEqual({
        lan: false,
        self: { device: 'here', id: 'ID-HERE' },
        peers: [],
        trusted: [],
        relay,
        capabilities: [...DAEMON_CAPABILITIES],
      });
    } finally {
      rmSync(trustHome, { recursive: true, force: true });
    }
  });

  it('with LAN: pairing is by trusted device id, not by the name a peer claims', async () => {
    const trustHome = mkdtempSync(join(tmpdir(), 'morse-srv-trust-'));
    const KNOWN = 'KKKKKKK-NNNNNNN-OOOOOOO-WWWWWWW-NNNNNNN-KKKKKKK-NNNNNNN-OWN';
    const OTHER = 'OOOOOOO-TTTTTTT-HHHHHHH-EEEEEEE-RRRRRRR-OOOOOOO-TTTTTTT-HER';
    try {
      const trust = createTrustStore(trustHome);
      trust.add({ id: KNOWN, name: 'desk-mac' });
      const { get } = await serve({
        peering: {
          selfDevice: 'laptop',
          selfId: 'SELF-ID',
          trust,
          peers: () => [
            { device: 'desk', host: '10.1.1.2', port: 7434, id: KNOWN, lastSeenAt: 5 },
            { device: 'desk-mac', host: '10.1.1.3', port: 7434, id: OTHER, lastSeenAt: 6 },
          ],
          pending: () => [{ id: OTHER, claimedName: 'desk-mac', at: 9 }],
        },
      });
      const body = (await (await get('/api/peers')).json()) as {
        lan: boolean;
        self: unknown;
        peers: Array<{ device: string; paired: boolean; trustedName?: string }>;
        trusted: Array<{ id: string; tier: string }>;
        pending: Array<{ id: string }>;
        relay: unknown;
      };
      expect(body.lan).toBe(true);
      expect(body.self).toEqual({ device: 'laptop', id: 'SELF-ID' });
      expect(body.peers.map((p) => [p.device, p.paired, p.trustedName])).toEqual([
        ['desk', true, 'desk-mac'],
        ['desk-mac', false, undefined],
      ]);
      expect(body.trusted).toEqual([expect.objectContaining({ id: KNOWN, tier: 'owner' })]);
      expect(body.pending.map((p) => p.id)).toEqual([OTHER]);
      expect(body.relay).toBeNull();
    } finally {
      rmSync(trustHome, { recursive: true, force: true });
    }
  });
});

describe('external agents over HTTP (ADR-024)', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'morse-srv-ext-'));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const APP = { agent: 'sds', sessionId: 'desktop-app-1' };

  it('/api/register makes the app addressable and drops the directory cache', async () => {
    const dropped: number[] = [];
    const { post } = await serve({ registryHome: home, invalidateDirectory: () => dropped.push(1) });
    const r = await post('/api/register', { ...APP, title: 'Desk assistant', cwd: '/apps/sds' });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { session: { agent: string; title: string; lastSeenAt: number }; registered: number };
    expect(body.session).toMatchObject({ agent: 'sds', title: 'Desk assistant' });
    expect(body.session.lastSeenAt).toBeGreaterThan(0);
    expect(body.registered).toBeGreaterThanOrEqual(1);
    expect(dropped).toEqual([1]);
  });

  it('a refused registration (reserved name) is a 400 and keeps the cache', async () => {
    const dropped: number[] = [];
    const { post } = await serve({ registryHome: home, invalidateDirectory: () => dropped.push(1) });
    const r = await post('/api/register', { agent: 'claude', sessionId: 'impostor' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/reserved/i);
    expect(dropped).toEqual([]);
  });

  it('/api/register and /api/inbox need a session id; register needs an agent', async () => {
    const { post } = await serve({ registryHome: home });
    for (const [path, body] of [
      ['/api/inbox', { agent: 'sds' }],
      ['/api/register', { agent: 'sds', sessionId: '  ' }],
      ['/api/register', { sessionId: 'only-id' }],
    ] as const) {
      const r = await post(path, body);
      expect(r.status, path).toBe(400);
      expect(await r.json()).toEqual({ error: 'expected {agent, sessionId, title?, cwd?}' });
    }
  });

  it('/api/inbox with register:true registers and collects in one call; a second call is empty', async () => {
    const { post, mailbox } = await serve({ registryHome: home });
    const m = mailbox.send({ from: WEB, to: APP, text: 'the build is green' });
    const first = await post('/api/inbox', { ...APP, register: true, title: 'Desk assistant' });
    expect(first.status).toBe(201);
    const body = (await first.json()) as { count: number; text: string | null; messages: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.text).toContain('the build is green');
    expect(body.messages.map((x) => x.id)).toEqual([m.id]);
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
    expect(await (await post('/api/inbox', APP)).json()).toEqual({ count: 0, text: null, messages: [] });
  });

  it('/api/send takes the app as the sender, so answers find their way back', async () => {
    const { post } = await serve({ registryHome: home });
    const r = await post('/api/send', { target: '@codex:shell', from: APP, text: 'please update X' });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { message: { from: unknown } }).message.from).toEqual(APP);
  });
});

describe('change notifications', () => {
  it('the event stream greets, then reports each change the daemon is told about', async () => {
    const { port, server, post } = await serve();
    const stream = await listen(port);
    try {
      expect(stream.status).toBe(200);
      expect(stream.type).toBe('text/event-stream');
      await until(() => stream.lines.length === 1);
      expect(stream.lines).toEqual(['{"kind":"hello"}']);
      server.notifyChange();
      await until(() => stream.lines.length === 2);
      await post('/api/messages', { from: API, to: WEB, text: 'x' });
      await until(() => stream.lines.length === 3);
      expect(stream.lines.slice(1)).toEqual(['{"kind":"changed"}', '{"kind":"changed"}']);
    } finally {
      stream.stop();
    }
  });

  it('notices writes made by another process through the mailbox poll', async () => {
    const { port, mailbox } = await serve({ changePollMs: 20 });
    const stream = await listen(port);
    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(stream.lines).toEqual(['{"kind":"hello"}']);
      mailbox.send({ from: API, to: WEB, text: 'written elsewhere' });
      await until(() => stream.lines.includes('{"kind":"changed"}'));
      const seen = stream.lines.length;
      await new Promise((r) => setTimeout(r, 80));
      expect(stream.lines).toHaveLength(seen);
    } finally {
      stream.stop();
    }
  });

  it('close() ends open streams', async () => {
    const { port, server } = await serve();
    const ended = await new Promise<boolean>((done) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events', headers: { [LOCAL_TOKEN_HEADER]: TEST_TOKEN } }, (res) => {
        res.on('data', () => server.close());
        res.on('end', () => done(true));
      });
      req.on('error', () => done(false));
      req.end();
    });
    expect(ended).toBe(true);
  });
});
