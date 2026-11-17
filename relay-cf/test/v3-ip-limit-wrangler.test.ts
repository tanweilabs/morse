import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadPrimaryAddress, signAs, type AddressKey } from '../../src/identity/address-key.js';
import { ensurePrekeys } from '../../src/identity/prekeys.js';

/**
 * The per-client-IP limit on v3 `send` frames against the REAL relay-cf code under
 * `wrangler dev` (local workerd, simulated Durable Objects; its own instance, port and temp
 * state; nothing is deployed): two connections — two addresses, so two AddressHubs — share
 * ONE budget, V3_RATE_PER_IP_PER_MINUTE, through the IpBucket of their IP. Locally there is
 * no CF-Connecting-IP header, so every connection has the same (unknown) IP: exactly "two
 * connections from one IP". The pure parts are in ip-bucket.test.ts.
 * Skipped without relay-cf/node_modules.
 */

const WRANGLER = resolve(__dirname, '../node_modules/.bin/wrangler');
const run = existsSync(WRANGLER) && process.env['MORSE_SKIP_WRANGLER'] !== '1' ? describe : describe.skip;
const RATE = 30; // a minute: one token back every 2 s
const LEASE = 20; // IP_LEASE_SIZE

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
const until = async (cond: () => boolean | Promise<boolean>, ms: number, every = 50) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(every);
  }
};

type Frame = Record<string, unknown>;
interface Conn {
  frames: Frame[];
  welcome: Promise<Frame | null>;
  req(body: Frame): Promise<Frame>;
  close(): Promise<void>;
}

run('relay-cf v3 under wrangler dev: the send limit one IP shares over its connections', () => {
  const root = mkdtempSync(join(tmpdir(), 'morse-v3-ip-cf-'));
  let port = 0;
  let proc: ChildProcess | null = null;
  let out = '';

  beforeAll(async () => {
    port = await freePort();
    proc = spawn(WRANGLER, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', join(root, 'state'), '--var', `V3_RATE_PER_IP_PER_MINUTE:${RATE}`, '--log-level', 'log'], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, XDG_CONFIG_HOME: join(root, 'xdg'), WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

  const newKey = (): AddressKey => loadPrimaryAddress(mkdtempSync(join(root, 'h-')));

  /** A v3 login of one address; `req` answers with the frame that carries the request's rid. */
  const login = (k: AddressKey): Conn => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v3/ws/${k.address}`);
    const frames: Frame[] = [];
    const waiting = new Map<string, (f: Frame) => void>();
    const c: Conn = {
      frames,
      welcome: new Promise((done) => {
        ws.on('message', (raw) => {
          const f = JSON.parse(raw.toString()) as Frame;
          if (f['type'] === 'challenge') {
            const sig = signAs(k, `morse-relay-login-v3\n${String(f['nonce'])}\n${k.address}`).toString('base64');
            ws.send(JSON.stringify({ type: 'hello', v: 3, addresses: [{ address: k.address, key: k.publicKey.toString('base64'), sig, prekey: ensurePrekeys(k).current }] }));
          }
          if (f['type'] === 'welcome') done(f);
          const rid = typeof f['rid'] === 'string' ? f['rid'] : '';
          const w = waiting.get(rid);
          if (w) {
            waiting.delete(rid);
            w(f);
          } else frames.push(f);
        });
        ws.on('close', () => done(null));
      }),
      req: (body) =>
        new Promise((done, fail) => {
          const rid = randomBytes(6).toString('hex');
          const t = setTimeout(() => fail(new Error(`no answer to ${JSON.stringify(body).slice(0, 100)} within 10 s`)), 10_000);
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
    return c;
  };

  /** `n` sends at once (not one after the other: the lease in flight is shared by all of them). */
  const burst = (from: Conn, to: AddressKey, n: number, tag: string): Promise<Frame[]> => Promise.all(Array.from({ length: n }, (_, i) => from.req({ type: 'send', to: to.address, blob: `${tag}-${i}` })));
  const sent = (rs: Frame[]) => rs.filter((r) => r['type'] === 'sent');
  const refused = (rs: Frame[]) => rs.filter((r) => r['type'] === 'error');
  const delivered = (c: Conn, tag: string) => c.frames.filter((f) => f['type'] === 'deliver' && String(f['blob']).startsWith(`${tag}-`)).length;

  it(`two connections from one IP share ${RATE} sends a minute: the second gets what the first left`, async () => {
    const a = newKey();
    const b = newKey();
    const A = login(a);
    const B = login(b);
    expect(await A.welcome).toMatchObject({ type: 'welcome', v: 3, addresses: [a.address] });
    expect(await B.welcome).toMatchObject({ type: 'welcome', v: 3, addresses: [b.address] });

    // sends that fail validation are answered as before and cost nothing of the budget
    const bad = await Promise.all([...Array.from({ length: 25 }, () => A.req({ type: 'send', to: 'not-an-address', blob: 'x' })), ...Array.from({ length: 25 }, () => A.req({ type: 'send', to: b.address, blob: '' }))]);
    expect(bad.map((r) => r['error'])).toEqual([...Array.from({ length: 25 }, () => 'bad recipient address'), ...Array.from({ length: 25 }, () => 'empty blob')]);

    const t0 = Date.now();
    // A: one full lease
    const a1 = await burst(A, b, LEASE, 'A1');
    expect(sent(a1)).toHaveLength(LEASE);
    // B (another address, another AddressHub, the same IP): only what is left in the bucket
    const b1 = await burst(B, a, LEASE, 'B1');
    // A again: its lease is used up, the bucket has nothing for it
    const a2 = await burst(A, b, 5, 'A2');
    const elapsed = Date.now() - t0;

    const accepted = sent(a1).length + sent(b1).length + sent(a2).length;
    const back = Math.floor((elapsed * RATE) / 60_000); // tokens that came back meanwhile (0 unless the machine is very slow)
    expect(accepted).toBeGreaterThanOrEqual(RATE);
    expect(accepted).toBeLessThanOrEqual(RATE + back);
    if (back === 0) {
      expect(accepted).toBe(RATE);
      expect(sent(b1)).toHaveLength(RATE - LEASE); // limited by what A used
      expect(sent(a2)).toHaveLength(0);
    }
    // every answer is `sent` or the refusal clients wait on — the per-connection limiter's text shape
    const no = [...refused(b1), ...refused(a2)];
    expect(sent(b1).length + sent(a2).length + no.length).toBe(LEASE + 5);
    expect(no.length).toBeGreaterThanOrEqual(LEASE + 5 - (RATE - LEASE) - back);
    for (const r of no) expect(r['error']).toBe(`rate limited (max ${RATE}/min)`);
    // a refused send was not delivered; an accepted one was
    await until(() => delivered(B, 'A1') === LEASE && delivered(A, 'B1') === sent(b1).length, 5000);
    await sleep(300);
    expect(delivered(A, 'B1')).toBe(sent(b1).length);
    expect(delivered(B, 'A1') + delivered(B, 'A2')).toBe(sent(a1).length + sent(a2).length);

    // nothing else is limited by it
    expect(await B.req({ type: 'address', address: a.address })).toMatchObject({ type: 'address', online: true });
    expect(await B.req({ type: 'signal', to: a.address, blob: 'SDP' })).toMatchObject({ type: 'signaled' });

    // waiting works, as clients do: tokens come back at RATE a minute, for either connection
    let again: Frame = {};
    await until(async () => (again = await B.req({ type: 'send', to: a.address, blob: 'B2-0' }))['type'] === 'sent', 15_000, 500);
    expect(again).toMatchObject({ type: 'sent' });

    // the relay logged the refusal (once per lease request, not per send), and its bucket was reachable
    expect(out).toMatch(/over 30 sends\/min/);
    expect(out).not.toContain('per-IP send limit unavailable');
    await Promise.all([A.close(), B.close()]);
  }, 60_000);
});
