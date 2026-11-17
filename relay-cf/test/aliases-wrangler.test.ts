import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey, randomBytes, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadOrCreateEncKey, makeKeyBundle } from '../../src/cluster/e2e.js';
import { loadOrCreateIdentity, type DeviceIdentity } from '../../src/cluster/identity.js';
import { signChallenge } from '../../src/cluster/relay-client.js';
import { loadPrimaryAddress, signAs } from '../../src/identity/address-key.js';
import { ensurePrekeys } from '../../src/identity/prekeys.js';
import { agentOpMessage } from '../src/protocol.js';

/**
 * The frozen old-alias table (identity v3 P2, spec §12.3 step 4) end to end against the REAL
 * relay-cf code under `wrangler dev` (local workerd, simulated KV + Durable Objects, temp
 * XDG_CONFIG_HOME so no login is read; nothing is deployed) — the way the admin will do it:
 *
 *   v2 data on the relay (allowlist, device key bundles, agent directory)
 *     → scripts/aliases-export.mjs reads it through the admin API and verifies it
 *     → `wrangler kv bulk put --local` loads the file it wrote (the Worker has no write path)
 *     → WS `alias` on a v3 connection and GET /v3/alias/… answer from it.
 *
 * Skipped without relay-cf/node_modules.
 */

const WRANGLER = resolve(__dirname, '../node_modules/.bin/wrangler');
const SCRIPT = resolve(__dirname, '../../scripts/aliases-export.mjs');
const run = existsSync(WRANGLER) && process.env['MORSE_SKIP_WRANGLER'] !== '1' ? describe : describe.skip;

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
};
const exec = (file: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }): Promise<{ code: number; out: string }> =>
  new Promise((done) => {
    execFile(file, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }));
  });

type Frame = Record<string, unknown>;
interface Conn {
  welcome: Promise<Frame | null>;
  req(body: Frame): Promise<Frame>;
  close(): Promise<void>;
}
interface Entry {
  name: string;
  address: string;
  agent: string;
  default?: true;
}

run('relay-cf old aliases under wrangler dev (identity v3 P2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'morse-alias-cf-'));
  const admin = `test-admin-${randomBytes(8).toString('hex')}`;
  const wranglerEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'xdg'), WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' };
  let port = 0;
  let proc: ChildProcess | null = null;
  let out = '';
  const base = () => `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${admin}` };

  beforeAll(async () => {
    port = await freePort();
    proc = spawn(WRANGLER, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', join(root, 'state'), '--var', `ADMIN_KEY:${admin}`, '--log-level', 'log'], {
      cwd: resolve(__dirname, '..'),
      env: wranglerEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout!.on('data', (b: Buffer) => (out += b.toString()));
    proc.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    await until(
      () =>
        fetch(`${base()}/healthz`)
          .then((r) => r.ok)
          .catch(() => false),
      60_000,
    ).catch((e: unknown) => {
      throw new Error(`wrangler dev did not come up: ${String(e)}\n${out.slice(-2000)}`);
    });
  }, 90_000);

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await sleep(500);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
  });

  const open = (path: string, onChallenge: (nonce: string, ws: WebSocket) => void): Conn => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const waiting = new Map<string, (f: Frame) => void>();
    return {
      welcome: new Promise((done) => {
        ws.on('message', (raw) => {
          const f = JSON.parse(raw.toString()) as Frame;
          if (f['type'] === 'challenge') onChallenge(String(f['nonce']), ws);
          if (f['type'] === 'welcome') done(f);
          const w = typeof f['rid'] === 'string' ? waiting.get(f['rid']) : undefined;
          if (w) w(f);
        });
        ws.on('close', () => done(null));
      }),
      req: (body) =>
        new Promise((done, fail) => {
          const rid = randomBytes(6).toString('hex');
          const t = setTimeout(() => fail(new Error(`no answer to ${JSON.stringify(body)}`)), 10_000);
          waiting.set(rid, (f) => {
            clearTimeout(t);
            done(f);
          });
          ws.send(JSON.stringify({ ...body, rid }));
        }),
      close: () =>
        new Promise((done) => {
          if (ws.readyState === WebSocket.CLOSED) return done();
          ws.once('close', () => done());
          ws.close();
        }),
    };
  };

  /** A v2 computer: on the allowlist under `handle`; `login` uploads its key bundle (certificate). */
  const computer = async (handle: string, opts: { login: boolean }) => {
    const home = mkdtempSync(join(root, 'h-'));
    const id = loadOrCreateIdentity(home);
    const cert = new X509Certificate(id.certPem).raw.toString('base64');
    const put = await fetch(`${base()}/admin/allowlist/${id.id}`, { method: 'PUT', headers: auth, body: JSON.stringify({ handle, name: `${handle}-test` }) });
    expect(put.status).toBe(200);
    if (opts.login) {
      const v2 = open(`/v1/ws/${id.id}`, (nonce, ws) => ws.send(JSON.stringify({ type: 'hello', cert, sig: signChallenge(id, nonce), bundle: makeKeyBundle(id, loadOrCreateEncKey(home)) })));
      expect(await v2.welcome).toMatchObject({ type: 'welcome', id: id.id, handle });
      await v2.close();
    }
    // the address this computer's first agent has in v3: its device key (spec §12.2)
    return { home, identity: id, id: id.id, cert, address: loadPrimaryAddress(home).address };
  };
  /** POST /v1/agents add — signed by the device, as `morse agent add` does (ADR-033). */
  const addAgent = async (d: { identity: DeviceIdentity; cert: string }, agent: string) => {
    const ts = Date.now();
    const sig = sign(null, Buffer.from(agentOpMessage(ts, 'add', agent)), createPrivateKey(d.identity.keyPem)).toString('base64');
    const r = await fetch(`${base()}/v1/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'add', agent, cert: d.cert, ts, sig }) });
    expect(r.status).toBe(200);
  };
  /** A v3 connection of some unrelated address: the one asking. */
  const asker = async (): Promise<Conn> => {
    const k = loadPrimaryAddress(mkdtempSync(join(root, 'h-')));
    const c = open(`/v3/ws/${k.address}`, (nonce, ws) =>
      ws.send(JSON.stringify({ type: 'hello', v: 3, addresses: [{ address: k.address, key: k.publicKey.toString('base64'), sig: signAs(k, `morse-relay-login-v3\n${nonce}\n${k.address}`).toString('base64'), prekey: ensurePrekeys(k).current }] })),
    );
    expect(await c.welcome).toMatchObject({ type: 'welcome', v: 3 });
    return c;
  };
  const http = async (path: string) => {
    const r = await fetch(`${base()}${path}`);
    return { status: r.status, cache: r.headers.get('cache-control'), cors: r.headers.get('access-control-allow-origin'), body: (await r.json()) as { name?: string; entries?: Entry[]; error?: string } };
  };
  const exportTable = (args: string[]) => exec(process.execPath, [SCRIPT, '--relay', base(), '--admin-key-env', 'TEST_RELAY_ADMIN', ...args], { env: { PATH: process.env['PATH'] ?? '', TEST_RELAY_ADMIN: admin } });

  let mini: Awaited<ReturnType<typeof computer>>;
  let air: Awaited<ReturnType<typeof computer>>;
  let pro: Awaited<ReturnType<typeof computer>>;
  let ghost: Awaited<ReturnType<typeof computer>>;

  it('/healthz says the relay answers alias queries; before the table is loaded every name is unknown', async () => {
    expect((await (await fetch(`${base()}/healthz`)).json()) as Frame).toMatchObject({ ok: true, protocols: [2, 3], aliases: true });
    expect(await http('/v3/alias/alice')).toMatchObject({ status: 404, body: { name: 'alice', entries: [] } });
    const c = await asker();
    expect(await c.req({ type: 'alias', name: 'alice' })).toMatchObject({ type: 'alias', name: 'alice', entries: [] });
    expect(await c.req({ type: 'alias', name: 'alice/air' })).toMatchObject({ type: 'alias', name: 'alice/air', entries: [] });
    await c.close();
  }, 30_000);

  it('admin: GET /admin/handles/<handle>?certs=1 adds each device certificate (read-only, behind the admin key)', async () => {
    // alice: two computers, three agents (mini is the first → the default; claude shares mini's computer)
    mini = await computer('alice', { login: true });
    air = await computer('alice', { login: true });
    await addAgent(mini, 'mini');
    await addAgent(air, 'air');
    await addAgent(mini, 'claude');
    // an 8-character random handle with one computer
    pro = await computer('k7f3a9xq', { login: true });
    await addAgent(pro, 'pro');
    // carol's computer joined and registered an agent but never connected: the relay has no certificate
    ghost = await computer('carol', { login: false });
    await addAgent(ghost, 'old');
    // dave has a computer and no agent
    await computer('dave', { login: true });

    const plain = (await (await fetch(`${base()}/admin/handles/alice`, { headers: auth })).json()) as { devices: Array<Record<string, unknown>>; default: string };
    expect(plain.default).toBe('mini');
    expect(plain.devices.map((d) => d['id']).sort()).toEqual([mini.id, air.id].sort());
    expect(plain.devices.every((d) => !('cert' in d))).toBe(true); // unchanged without the flag

    const withCerts = (await (await fetch(`${base()}/admin/handles/alice?certs=1`, { headers: auth })).json()) as { devices: Array<{ id: string; handle: string; cert: string | null }>; agents: Array<{ agent: string; device: string }> };
    expect(Object.fromEntries(withCerts.devices.map((d) => [d.id, d.cert]))).toEqual({ [mini.id]: mini.cert, [air.id]: air.cert });
    expect(withCerts.devices.every((d) => d.handle === 'alice')).toBe(true);
    expect(withCerts.agents.map((a) => [a.agent, a.device]).sort()).toEqual([['air', air.id], ['claude', mini.id], ['mini', mini.id]]);
    const carol = (await (await fetch(`${base()}/admin/handles/carol?certs=1`, { headers: auth })).json()) as { devices: Array<{ id: string; cert: string | null }> };
    expect(carol.devices).toMatchObject([{ id: ghost.id, cert: null }]);

    expect((await fetch(`${base()}/admin/handles/alice?certs=1`)).status).toBe(401);
    expect((await fetch(`${base()}/admin/handles/alice?certs=1`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  }, 60_000);

  it('the export script builds the table from the admin API, refuses what it cannot verify, and its file loads with `wrangler kv bulk put`', async () => {
    const file = join(root, 'aliases.json');
    // carol/old cannot be verified (no certificate): nothing is written
    const refused = await exportTable(['--out', file]);
    expect(refused.out).toMatch(/carol\/old: no certificate/);
    expect(refused.code).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(refused.out).not.toContain(admin);

    const r = await exportTable(['--out', file, '--allow-problems']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/dave: no agents/);
    expect(r.out).toMatch(/4 handles in the source → 2 records, 6 old names/);
    const bulk = JSON.parse(readFileSync(file, 'utf8')) as Array<{ key: string; value: string }>;
    expect(bulk.map((x) => x.key)).toEqual(['alias:alice', 'alias:k7f3a9xq']);
    expect(JSON.parse(bulk[0]!.value)).toEqual({ v: 1, handle: 'alice', default: 'mini', agents: { air: air.address, claude: mini.address, mini: mini.address } });
    expect(JSON.parse(bulk[1]!.value)).toEqual({ v: 1, handle: 'k7f3a9xq', default: 'pro', agents: { pro: pro.address } });
    // the script only read: the relay still knows no alias
    expect((await http('/v3/alias/alice')).status).toBe(404);

    // what the admin runs (here against the local simulated KV of this wrangler dev)
    const put = await exec(WRANGLER, ['kv', 'bulk', 'put', file, '--local', '--persist-to', join(root, 'state'), '--binding', 'ALLOWLIST'], { cwd: resolve(__dirname, '..'), env: wranglerEnv });
    expect(put.code, put.out).toBe(0);
    await until(async () => (await http('/v3/alias/alice')).status === 200, 10_000);
  }, 90_000);

  it('WS `alias` on a v3 connection: bare handle, handle/agent, the default by name, unknown, bad, host-prefixed / upper-case', async () => {
    const c = await asker();
    // bare handle with several agents: the default first under the bare name, the rest by agent name
    expect(await c.req({ type: 'alias', name: 'alice' })).toEqual({
      type: 'alias',
      rid: expect.any(String),
      name: 'alice',
      entries: [
        { name: 'alice', address: mini.address, agent: 'mini', default: true },
        { name: 'alice/air', address: air.address, agent: 'air' },
        { name: 'alice/claude', address: mini.address, agent: 'claude' }, // same computer as mini: same address
      ],
    });
    expect((await c.req({ type: 'alias', name: 'alice/air' }))['entries']).toEqual([{ name: 'alice/air', address: air.address, agent: 'air' }]);
    expect(await c.req({ type: 'alias', name: 'alice/mini' })).toMatchObject({ name: 'alice/mini', entries: [{ name: 'alice/mini', address: mini.address, agent: 'mini', default: true }] });
    expect((await c.req({ type: 'alias', name: 'k7f3a9xq' }))['entries']).toEqual([{ name: 'k7f3a9xq', address: pro.address, agent: 'pro', default: true }]);
    // unknown names (never registered, refused by the export, no agent): an empty list, not an error
    for (const name of ['nobody', 'alice/nobody', 'carol', 'carol/old', 'dave']) expect(await c.req({ type: 'alias', name })).toMatchObject({ type: 'alias', name, entries: [] });
    // bad names
    for (const name of ['alice/air/x', 'a', '', 'al ice', 7, undefined]) expect(await c.req({ type: 'alias', name })).toMatchObject({ type: 'error', error: 'bad alias name' });
    // as pasted: host prefix, @, upper case, trailing slash
    expect(await c.req({ type: 'alias', name: 'https://morse.im/Alice/AIR/' })).toMatchObject({ type: 'alias', name: 'alice/air', entries: [{ name: 'alice/air', address: air.address, agent: 'air' }] });
    expect(await c.req({ type: 'alias', name: '@MORSE.TALK/K7F3A9XQ' })).toMatchObject({ type: 'alias', name: 'k7f3a9xq', entries: [{ address: pro.address }] });
    // an alias answers with an address the ordinary `address` query understands
    expect(await c.req({ type: 'address', address: air.address })).toMatchObject({ type: 'address', address: air.address });
    await c.close();
  }, 30_000);

  it('GET /v3/alias/<handle>[/<agent>]: public, same answers, 404 when there is none, cacheable', async () => {
    const all = await http('/v3/alias/alice');
    expect(all).toMatchObject({ status: 200, cache: 'public, max-age=300', cors: '*' });
    expect(all.body).toEqual({
      name: 'alice',
      entries: [
        { name: 'alice', address: mini.address, agent: 'mini', default: true },
        { name: 'alice/air', address: air.address, agent: 'air' },
        { name: 'alice/claude', address: mini.address, agent: 'claude' },
      ],
    });
    expect((await http('/v3/alias/alice/air')).body).toEqual({ name: 'alice/air', entries: [{ name: 'alice/air', address: air.address, agent: 'air' }] });
    expect((await http('/v3/alias/alice/mini')).body).toEqual({ name: 'alice/mini', entries: [{ name: 'alice/mini', address: mini.address, agent: 'mini', default: true }] });
    expect((await http('/v3/alias/ALICE/Air/')).body).toMatchObject({ name: 'alice/air', entries: [{ address: air.address }] });
    expect(await http('/v3/alias/nobody')).toMatchObject({ status: 404, cache: 'public, max-age=300', body: { name: 'nobody', entries: [] } });
    expect(await http('/v3/alias/alice/nobody')).toMatchObject({ status: 404, body: { name: 'alice/nobody', entries: [] } });
    expect(await http('/v3/alias/alice/air/x')).toMatchObject({ status: 400, body: { error: 'bad alias name' } });
    expect(await http('/v3/alias/a')).toMatchObject({ status: 400, body: { error: 'bad alias name' } });
    expect(await http('/v3/alias/%E0%A4%A')).toMatchObject({ status: 400 });
    expect((await fetch(`${base()}/v3/alias/alice`, { method: 'POST' })).status).toBe(405);
  }, 30_000);

  it('alias records are read-only and are not allowlist entries', async () => {
    // GET /admin/allowlist lists devices only — not the alias records sharing the namespace
    const list = (await (await fetch(`${base()}/admin/allowlist`, { headers: auth })).json()) as { devices: Array<{ id: string }> };
    expect(list.devices.length).toBe(5);
    expect(list.devices.some((d) => d.id.startsWith('alias:') || d.id.startsWith('@'))).toBe(false);
    expect(list.devices.map((d) => d.id)).toEqual(expect.arrayContaining([mini.id, air.id, pro.id, ghost.id]));
    // no admin route writes or deletes one
    for (const method of ['PUT', 'DELETE']) {
      const r = await fetch(`${base()}/admin/allowlist/${encodeURIComponent('alias:alice')}`, { method, headers: auth, body: method === 'PUT' ? JSON.stringify({ handle: 'mallory' }) : null });
      expect(r.status).toBe(400);
    }
    for (const method of ['PUT', 'POST', 'DELETE']) expect((await fetch(`${base()}/v3/alias/alice`, { method, headers: auth })).status).toBe(405);
    // the v2 directory is untouched: the same export gives the same table again
    const again = join(root, 'aliases-2.json');
    expect((await exportTable(['--out', again, '--allow-problems'])).code).toBe(0);
    expect(readFileSync(again, 'utf8')).toBe(readFileSync(join(root, 'aliases.json'), 'utf8'));
    expect((await http('/v3/alias/alice')).body.entries?.[0]).toEqual({ name: 'alice', address: mini.address, agent: 'mini', default: true });
  }, 60_000);
});
