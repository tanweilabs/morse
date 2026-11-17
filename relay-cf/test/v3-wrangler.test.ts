import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadOrCreateIdentity } from '../../src/cluster/identity.js';
import { signChallenge } from '../../src/cluster/relay-client.js';
import { loadOrCreateEncKey, makeKeyBundle } from '../../src/cluster/e2e.js';
import { createAddressKey, loadPrimaryAddress, signAs, type AddressKey } from '../../src/identity/address-key.js';
import { startMorse, type Morse } from '../../src/cluster/morse.js';
import { createTrustStore } from '../../src/cluster/trust.js';
import { createDb } from '../../src/mailbox/db.js';
import { createMailbox } from '../../src/mailbox/mailbox.js';
import { ensurePrekeys } from '../../src/identity/prekeys.js';

/**
 * ADR-073 against the REAL relay-cf code under `wrangler dev` (local workerd, simulated
 * Durable Objects; temp XDG_CONFIG_HOME so no login is read; nothing is deployed): the v3
 * endpoint /v3/ws/<address> — multi-address login, address lookup, live delivery, the
 * offline mailbox (store, deliver on login, ack-delete, redeliver when unacked, expiry →
 * `undeliverable`), signaling by address, the per-IP cap on new addresses, and /healthz +
 * the v2 welcome announcing protocols [2, 3]. ADR-081: the `caps` of an address (stored at
 * login, handed back by the address query, malformed ones dropped, an old-style hello
 * unchanged) and two daemons that never met reaching each other by address alone.
 * Skipped without relay-cf/node_modules.
 */

const WRANGLER = resolve(__dirname, '../node_modules/.bin/wrangler');
const run = existsSync(WRANGLER) && process.env['MORSE_SKIP_WRANGLER'] !== '1' ? describe : describe.skip;
const TTL_SEC = 3;
const NEW_PER_HOUR = 24;

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

type Frame = Record<string, unknown>;
interface Conn {
  ws: WebSocket;
  frames: Frame[];
  closed: { code: number } | null;
  welcome: Promise<Frame | null>;
  req(body: Frame): Promise<Frame>;
  next(pred: (f: Frame) => boolean, ms?: number): Promise<Frame>;
  close(): Promise<void>;
}

run('relay-cf v3 under wrangler dev (ADR-073)', () => {
  const root = mkdtempSync(join(tmpdir(), 'morse-v3-cf-'));
  const admin = `test-admin-${randomBytes(8).toString('hex')}`;
  let port = 0;
  let proc: ChildProcess | null = null;
  let out = '';
  let fresh = 0; // new addresses published so far (the per-IP cap counts them)

  beforeAll(async () => {
    port = await freePort();
    proc = spawn(
      WRANGLER,
      ['dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', join(root, 'state'), '--var', `ADMIN_KEY:${admin}`, '--var', `MAILBOX_TTL_SEC:${TTL_SEC}`, '--var', `NEW_ADDRESSES_PER_IP_PER_HOUR:${NEW_PER_HOUR}`, '--log-level', 'log'],
      {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, XDG_CONFIG_HOME: join(root, 'xdg'), WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    proc.stdout!.on('data', (b: Buffer) => (out += b.toString()));
    proc.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    await until(
      () =>
        fetch(`http://127.0.0.1:${port}/healthz`)
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

  const home = () => mkdtempSync(join(root, 'h-'));
  const newKey = (): AddressKey => {
    fresh++;
    return loadPrimaryAddress(home());
  };

  const open = (path: string, onChallenge: (nonce: string, ws: WebSocket) => void): Conn => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const frames: Frame[] = [];
    const waiters = new Set<() => void>();
    const c: Conn = {
      ws,
      frames,
      closed: null,
      welcome: new Promise((done) => {
        ws.on('message', (raw) => {
          const f = JSON.parse(raw.toString()) as Frame;
          frames.push(f);
          if (f['type'] === 'challenge') onChallenge(String(f['nonce']), ws);
          if (f['type'] === 'welcome') done(f);
          for (const w of [...waiters]) w();
        });
        ws.on('close', (code) => {
          c.closed = { code };
          done(null);
          for (const w of [...waiters]) w();
        });
      }),
      req: (body) => {
        const rid = randomBytes(6).toString('hex');
        ws.send(JSON.stringify({ ...body, rid }));
        return c.next((f) => f['rid'] === rid);
      },
      next: (pred, ms = 10_000) =>
        new Promise((done, fail) => {
          const seen = new Set<Frame>();
          const check = () => {
            const hit = frames.find((f) => !seen.has(f) && pred(f));
            if (hit) {
              frames.splice(frames.indexOf(hit), 1);
              waiters.delete(check);
              clearTimeout(t);
              done(hit);
            }
          };
          const t = setTimeout(() => {
            waiters.delete(check);
            fail(new Error(`no matching frame within ${ms} ms; have ${JSON.stringify(frames).slice(0, 500)}`));
          }, ms);
          waiters.add(check);
          check();
        }),
      close: () =>
        new Promise((done) => {
          if (ws.readyState === WebSocket.CLOSED) return done();
          ws.once('close', () => done());
          ws.close();
        }),
    };
    return c;
  };

  const login = (keys: AddressKey[], opts: { badSig?: boolean; caps?: (k: AddressKey) => unknown } = {}): Conn =>
    open(`/v3/ws/${keys[0]!.address}`, (nonce, ws) =>
      ws.send(
        JSON.stringify({
          type: 'hello',
          v: 3,
          addresses: keys.map((k) => ({
            address: k.address,
            key: k.publicKey.toString('base64'),
            sig: signAs(k, `morse-relay-login-v3\n${opts.badSig ? 'x' : nonce}\n${k.address}`).toString('base64'),
            prekey: ensurePrekeys(k).current,
            ...(opts.caps ? { caps: opts.caps(k) } : {}),
          })),
        }),
      ),
    );

  it('/healthz and the v2 welcome announce protocols [2, 3]', async () => {
    const h = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Frame;
    expect(h['protocols']).toEqual([2, 3]);
    // a v2 device login (allowlist + certificate) is unchanged, its welcome just says so too
    const dh = home();
    const id = loadOrCreateIdentity(dh);
    await fetch(`http://127.0.0.1:${port}/admin/allowlist/${id.id}`, { method: 'PUT', headers: { Authorization: `Bearer ${admin}` }, body: JSON.stringify({ handle: 'mei', name: 'mei-test' }) });
    const cert = new X509Certificate(id.certPem).raw.toString('base64');
    const v2 = open(`/v1/ws/${id.id}`, (nonce, ws) => ws.send(JSON.stringify({ type: 'hello', cert, sig: signChallenge(id, nonce), bundle: makeKeyBundle(id, loadOrCreateEncKey(dh)) })));
    expect(await v2.welcome).toMatchObject({ type: 'welcome', id: id.id, handle: 'mei', protocols: [2, 3] });
    await v2.close();
  }, 30_000);

  it('one connection logs in two addresses; others look them up; live delivery to either', async () => {
    const a1 = newKey();
    const a2 = createAddressKey(a1.dir.replace(/\/\.morse\/addresses\/.*$/, ''));
    fresh++;
    const b = newKey();
    const A = login([a1, a2]);
    expect(await A.welcome).toMatchObject({ type: 'welcome', v: 3, addresses: [a1.address, a2.address], protocols: [2, 3] });
    const B = login([b]);
    await B.welcome;
    const info = await B.req({ type: 'address', address: a2.address.toUpperCase() });
    expect(info).toMatchObject({ type: 'address', address: a2.address, key: a2.publicKey.toString('base64'), online: true });
    expect((info['prekey'] as Frame)['id']).toBe(ensurePrekeys(a2).current.id);
    expect(await B.req({ type: 'address', address: newKey().address })).toMatchObject({ key: null, prekey: null, online: false });
    fresh--; // that one never logged in
    expect(await B.req({ type: 'send', to: a2.address, blob: 'SEALED-1', ref: 'm1' })).toMatchObject({ type: 'sent' });
    expect(await A.next((f) => f['type'] === 'deliver')).toMatchObject({ to: a2.address, from: b.address, blob: 'SEALED-1', ref: 'm1' });
    expect(await B.req({ type: 'send', to: a1.address, blob: 'SEALED-2' })).toMatchObject({ type: 'sent' });
    const d = await A.next((f) => f['type'] === 'deliver');
    expect(d).toMatchObject({ to: a1.address, from: b.address, blob: 'SEALED-2' });
    expect(d['stored']).toBeUndefined();
    // sending as an address this connection did not log in
    expect(await B.req({ type: 'send', from: a1.address, to: a1.address, blob: 'x' })).toMatchObject({ type: 'error' });
    // signaling by address (ADR-069 over v3)
    expect(await B.req({ type: 'signal', to: a2.address, blob: 'SDP' })).toMatchObject({ type: 'signaled' });
    expect(await A.next((f) => f['type'] === 'signal')).toMatchObject({ from: b.address, to: a2.address, blob: 'SDP' });
    // a rotated prekey is published without reconnecting
    const p2 = { ...ensurePrekeys(a1, Date.now() + 8 * 86400_000).current };
    expect(await A.req({ type: 'prekey', address: a1.address, prekey: p2 })).toMatchObject({ type: 'prekey', ok: true });
    expect(((await B.req({ type: 'address', address: a1.address }))['prekey'] as Frame)['id']).toBe(p2.id);
    expect(await A.req({ type: 'prekey', address: a1.address, prekey: { ...p2, createdAt: 1 } })).toMatchObject({ type: 'error' });
    await A.close();
    await B.close();
  }, 30_000);

  it('offline mailbox: stored while away, delivered on login, deleted on ack; redelivered when not acked', async () => {
    const a = newKey();
    const b = newKey();
    let A = login([a]);
    await A.welcome;
    await A.close();
    const B = login([b]);
    await B.welcome;
    const s1 = await B.req({ type: 'send', to: a.address, blob: 'SEALED-OFFLINE-1', ref: 'r1' });
    expect(s1).toMatchObject({ type: 'stored' });
    expect(Number(s1['expiresAt'])).toBeGreaterThan(Date.now());
    expect(await B.req({ type: 'send', to: a.address, blob: 'SEALED-OFFLINE-2', ref: 'r2' })).toMatchObject({ type: 'stored' });
    // store:false (file chunks): not kept, the sender holds it
    expect(await B.req({ type: 'send', to: a.address, blob: 'SEALED-CHUNK', store: false })).toMatchObject({ type: 'offline' });
    // never logged in → not stored
    const ghost = newKey();
    fresh--;
    expect(await B.req({ type: 'send', to: ghost.address, blob: 'x' })).toMatchObject({ type: 'error', error: expect.stringMatching(/unknown address/) });

    A = login([a]);
    await A.welcome;
    const d1 = await A.next((f) => f['type'] === 'deliver' && f['blob'] === 'SEALED-OFFLINE-1');
    const d2 = await A.next((f) => f['type'] === 'deliver' && f['blob'] === 'SEALED-OFFLINE-2');
    expect(d1).toMatchObject({ stored: true, from: b.address, to: a.address, ref: 'r1' });
    A.ws.send(JSON.stringify({ type: 'ack', to: a.address, ids: [d1['id']] })); // only the first
    await sleep(300);
    await A.close();
    A = login([a]);
    await A.welcome;
    const again = await A.next((f) => f['type'] === 'deliver');
    expect(again).toMatchObject({ blob: 'SEALED-OFFLINE-2', stored: true, id: d2['id'] });
    A.ws.send(JSON.stringify({ type: 'ack', to: a.address, ids: [again['id']] }));
    await sleep(300);
    await A.close();
    A = login([a]);
    await A.welcome;
    await sleep(500);
    expect(A.frames.filter((f) => f['type'] === 'deliver')).toEqual([]);
    await A.close();
    await B.close();
    expect(out).not.toContain('SEALED-OFFLINE'); // the relay logs sizes, never the envelope
  }, 30_000);

  it('an envelope nobody fetched expires; its sender gets `undeliverable` (pushed, or kept until it logs in)', async () => {
    const a = newKey();
    const b = newKey();
    const c = newKey();
    let A = login([a]);
    await A.welcome;
    await A.close();
    const B = login([b]);
    await B.welcome;
    const C = login([c]);
    await C.welcome;
    expect(await B.req({ type: 'send', to: a.address, blob: 'E1', ref: 'msg-b' })).toMatchObject({ type: 'stored' });
    expect(await C.req({ type: 'send', to: a.address, blob: 'E2', ref: 'msg-c' })).toMatchObject({ type: 'stored' });
    await C.close();
    expect(await B.next((f) => f['type'] === 'undeliverable', (TTL_SEC + 8) * 1000)).toMatchObject({ from: b.address, to: a.address, ref: 'msg-b' });
    const C2 = login([c]);
    await C2.welcome;
    expect(await C2.next((f) => f['type'] === 'undeliverable', 8000)).toMatchObject({ from: c.address, to: a.address, ref: 'msg-c' });
    A = login([a]);
    await A.welcome;
    await sleep(500);
    expect(A.frames.filter((f) => f['type'] === 'deliver')).toEqual([]); // gone
    await Promise.all([A.close(), B.close(), C2.close()]);
  }, 40_000);

  it('two Morse daemons: v3 envelopes through the Worker, and the offline mailbox end to end', async () => {
    // (ADR-091) by address: nobody is on an allowlist, nobody has an old name — each is the other's contact
    const mk = async () => {
      const h = home();
      const id = loadOrCreateIdentity(h).id;
      fresh++;
      return { home: h, id, address: loadPrimaryAddress(h).address, mailbox: createMailbox(createDb(':memory:')), logs: [] as string[], morse: null as Morse | null };
    };
    const a = await mk();
    const b = await mk();
    a.mailbox.contacts.ensureAddress(b.address);
    b.mailbox.contacts.ensureAddress(a.address);
    const start = (d: typeof a) => (d.morse = startMorse({ url: `ws://127.0.0.1:${port}`, home: d.home, mailbox: d.mailbox, receiptTimeoutMs: 8000, log: (l) => d.logs.push(l) }));
    const v3up = (d: typeof a) => Boolean(d.morse?.v3Client?.()?.connected());
    try {
      start(a);
      start(b);
      await until(() => v3up(a) && v3up(b), 20_000);
      const m1 = a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'codex', sessionId: 'b-1', device: b.address }, text: 'v3 through the Worker' });
      expect(await a.morse!.send(b.address, m1)).toEqual({ ok: true, via: 'relay' });
      expect(b.mailbox.inbox()[0]!.parts[0]!.text).toBe('v3 through the Worker');
      expect(a.logs.some((l) => /delivered via relay \(v3, peer\)/.test(l))).toBe(true);
      // lin goes offline; kai's next message waits in the relay's mailbox, then arrives
      b.morse!.stop();
      await until(async () => {
        const probe = login([newKey()]);
        await probe.welcome;
        const r = await probe.req({ type: 'address', address: b.morse!.address!()! });
        await probe.close();
        return r['online'] === false;
      }, 10_000);
      const m2 = a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'codex', sessionId: 'b-1', device: b.address }, text: 'kept while you were away' });
      expect(await a.morse!.send(b.address, m2)).toEqual({ ok: true, via: 'relay' });
      expect(a.logs.some((l) => /left in the relay's offline mailbox/.test(l))).toBe(true);
      start(b);
      await until(() => b.mailbox.inbox().some((m) => m.parts[0]!.text === 'kept while you were away'), 20_000);
      await until(() => Boolean(a.mailbox.getMessage(m2.id)!.receiptAt), 20_000);
      expect(out).not.toContain('kept while you were away');
    } finally {
      a.morse?.stop();
      b.morse?.stop();
    }
  }, 60_000);

  it('caps (ADR-081): stored with each address at login and returned by the address query; malformed ones dropped; an old-style hello has none', async () => {
    const a1 = newKey();
    const a2 = createAddressKey(a1.dir.replace(/\/\.morse\/addresses\/.*$/, ''));
    fresh++;
    const b = newKey();
    const messy = ['addr1', 'x2', 'addr1', 'UPPER', 'has space', 'a'.repeat(17), 7, null, '', 'ok9'];
    let A = login([a1, a2], { caps: (k) => (k === a1 ? ['addr1'] : messy) });
    expect(await A.welcome).toMatchObject({ type: 'welcome', v: 3, addresses: [a1.address, a2.address] }); // never an error
    const B = login([b]); // an old-style hello: no caps field at all
    expect(await B.welcome).toMatchObject({ type: 'welcome', v: 3, addresses: [b.address] });
    const caps = async (address: string) => (await B.req({ type: 'address', address }))['caps'];
    expect(await caps(a1.address)).toEqual(['addr1']);
    expect(await caps(a2.address)).toEqual(['addr1', 'x2', 'ok9']); // (the address another one's connection hosts)
    expect(await caps(b.address)).toEqual([]); // its own record: none published
    const ghost = newKey();
    fresh--; // never logs in
    expect(await B.req({ type: 'address', address: ghost.address })).toMatchObject({ key: null, prekey: null, online: false, caps: [] });
    // the rest of the answer is what it was
    expect(await B.req({ type: 'address', address: a1.address })).toMatchObject({ type: 'address', address: a1.address, key: a1.publicKey.toString('base64'), online: true });
    // a rotated prekey leaves the caps alone
    const p2 = { ...ensurePrekeys(a1, Date.now() + 8 * 86400_000).current };
    expect(await A.req({ type: 'prekey', address: a1.address, prekey: p2 })).toMatchObject({ type: 'prekey', ok: true });
    const after = await B.req({ type: 'address', address: a1.address });
    expect((after['prekey'] as Frame)['id']).toBe(p2.id);
    expect(after['caps']).toEqual(['addr1']);
    // kept while the address is offline (first contact may happen then: the envelope waits in its mailbox)
    await A.close();
    await until(async () => (await B.req({ type: 'address', address: a1.address }))['online'] === false, 10_000);
    expect(await caps(a1.address)).toEqual(['addr1']);
    expect(await caps(a2.address)).toEqual(['addr1', 'x2', 'ok9']);
    // caps are what the client that logs in NOW can do: more than 8 → the first 8; not a list → none; none given → none
    const many = Array.from({ length: 12 }, (_, i) => `c${i}`);
    A = login([a1, a2], { caps: (k) => (k === a1 ? many : 'addr1') });
    expect(await A.welcome).not.toBeNull();
    expect(await caps(a1.address)).toEqual(many.slice(0, 8));
    expect(await caps(a2.address)).toEqual([]);
    await A.close();
    A = login([a1, a2]); // the same addresses from a client that knows no caps (e.g. after a downgrade)
    expect(await A.welcome).not.toBeNull();
    expect(await caps(a1.address)).toEqual([]);
    expect(await caps(a2.address)).toEqual([]);
    await Promise.all([A.close(), B.close()]);
  }, 40_000);

  it('two Morse daemons that never met: first contact by address alone through the Worker — request, accept, reply (ADR-081)', async () => {
    const mk = async (handle: string) => {
      const h = home();
      const id = loadOrCreateIdentity(h).id;
      // (each has a v2 login of its own, as every install does; neither is told the other's handle)
      const r = await fetch(`http://127.0.0.1:${port}/admin/allowlist/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ handle, name: `${handle}-test` }) });
      expect(r.status).toBe(200);
      fresh++;
      return { home: h, address: loadPrimaryAddress(h).address, mailbox: createMailbox(createDb(':memory:')), logs: [] as string[], morse: null as Morse | null };
    };
    const a = await mk('ann');
    const b = await mk('ben');
    const start = (d: typeof a) => (d.morse = startMorse({ url: `ws://127.0.0.1:${port}`, home: d.home, mailbox: d.mailbox, receiptTimeoutMs: 8000, log: (l) => d.logs.push(l) }));
    const outbox = async (d: typeof a) => {
      const c = d.mailbox.claimNextPending({ scope: 'outbound' })!;
      const r = await d.morse!.send(c.to.device!, c);
      if (r.ok) d.mailbox.markDelivered(c.id);
      else d.mailbox.markFailed(c.id, r.error ?? 'failed', r.waiting ? { waiting: true } : undefined);
      return r;
    };
    try {
      start(a);
      start(b);
      await until(() => Boolean(a.morse?.v3Client?.()?.connected()) && Boolean(b.morse?.v3Client?.()?.connected()), 20_000);
      // the real relay hands back what the real client published
      expect((await a.morse!.v3Client!()!.lookupAddress!(b.address)).caps).toEqual(['addr1']);
      expect(await a.morse!.addressRoute!(`morse.im/${b.address}`)).toEqual({ ok: true, address: b.address, from: a.address }); // (ADR-081 review F1: + the address of ours it goes out from)
      a.morse!.acceptAddress!(b.address);
      a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'user', sessionId: '', device: b.address }, text: 'by address through the Worker' });
      expect(await outbox(a)).toEqual({ ok: true, via: 'relay', request: true });
      expect(b.mailbox.requests.get(a.address)).toMatchObject({ handle: a.address, deviceId: a.address, text: 'by address through the Worker' });
      expect(b.mailbox.inbox({ all: true })).toEqual([]);
      const { acceptRequest } = await import('../../src/cluster/requests.js');
      const accepted = acceptRequest(a.address, { mailbox: b.mailbox, trust: createTrustStore(b.home), home: b.home });
      expect(accepted).toMatchObject({ ok: true, contactId: `a:${a.address}` });
      expect(await b.morse!.notifyAccepted(a.address)).toBe(1);
      if (!accepted.ok) throw new Error('unreachable');
      b.mailbox.reply(accepted.message.id, 'and back, by address');
      expect(await outbox(b)).toEqual({ ok: true, via: 'relay' });
      const back = a.mailbox.inbox({ all: true }).find((m) => m.direction === 'in')!;
      expect(back).toMatchObject({ from: { device: b.address }, contactId: `a:${b.address}`, fromTier: 'peer', ownThread: true, to: { agent: 'claude', sessionId: 'a-1' } });
      expect(back.parts[0]!.text).toBe('and back, by address');
      expect(createTrustStore(a.home).list()).toEqual([]);
      expect(createTrustStore(b.home).list()).toEqual([]);
      // offline: kept in the Worker's mailbox for the address, delivered at its next login
      b.morse!.stop();
      await until(async () => (await a.morse!.v3Client!()!.lookupAddress!(b.address)).online === false, 10_000);
      a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'user', sessionId: '', device: b.address }, text: 'kept by address' });
      expect(await outbox(a)).toEqual({ ok: true, via: 'relay' });
      start(b);
      await until(() => b.mailbox.inbox({ all: true }).some((m) => m.parts[0]!.text === 'kept by address'), 20_000);
      expect(out).not.toMatch(/by address through the Worker|kept by address/);
    } finally {
      a.morse?.stop();
      b.morse?.stop();
    }
  }, 60_000);

  it('a bad login signature is refused (4001); a newer connection replaces the older (4000)', async () => {
    const a = newKey();
    fresh--; // refused before publishing
    const bad = login([a], { badSig: true });
    expect(await bad.welcome).toBeNull();
    expect(bad.closed?.code).toBe(4001);
    fresh++;
    const one = login([a]);
    await one.welcome;
    const two = login([a]);
    await two.welcome;
    await until(() => one.closed !== null, 5000);
    expect(one.closed?.code).toBe(4000);
    await two.close();
  }, 20_000);

  it('per network: at most NEW_ADDRESSES_PER_IP_PER_HOUR new addresses an hour (4029); known ones always log in', async () => {
    const known = newKey();
    const k = login([known]);
    await k.welcome;
    await k.close();
    while (fresh < NEW_PER_HOUR) {
      const c = login([newKey()]);
      expect(await c.welcome).not.toBeNull();
      await c.close();
    }
    const over = login([loadPrimaryAddress(home())]);
    expect(await over.welcome).toBeNull();
    expect(over.closed?.code).toBe(4029);
    const again = login([known]); // not new: not counted
    expect(await again.welcome).not.toBeNull();
    await again.close();
  }, 30_000);
});
