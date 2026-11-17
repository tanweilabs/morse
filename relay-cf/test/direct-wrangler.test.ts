import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRtc } from '../../src/cluster/direct.js';
import { loadOrCreateIdentity } from '../../src/cluster/identity.js';
import { loadPrimaryAddress } from '../../src/identity/address-key.js';
import { startMorse, type Morse } from '../../src/cluster/morse.js';
import { createDb } from '../../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../../src/mailbox/mailbox.js';

/**
 * ADR-069 end to end against the REAL Cloudflare relay code: relay-cf under
 * `wrangler dev` (local workerd + simulated KV / Durable Objects; XDG_CONFIG_HOME is a
 * temp dir so no wrangler login is read, nothing is deployed). Two Morse instances log
 * in, signal each other through the Worker's new `signal` frame, open a WebRTC data
 * channel on this machine, and exchange messages over it.
 *
 * Server side (not part of the public client export). Skipped when relay-cf/node_modules is not installed (`cd relay-cf && npm ci`) or
 * node-datachannel cannot load.
 */

const WRANGLER = resolve(__dirname, '../node_modules/.bin/wrangler');
const loaded = await loadRtc();
const ndc = 'rtc' in loaded ? loaded.rtc : null;
const run = existsSync(WRANGLER) && ndc && process.env['MORSE_SKIP_WRANGLER'] !== '1' ? describe : describe.skip;

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });
const until = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

interface Dev {
  home: string;
  id: string;
  mailbox: Mailbox;
  logs: string[];
  morse?: Morse;
}

run('direct links through the real relay-cf under wrangler dev (ADR-069)', () => {
  const root = mkdtempSync(join(tmpdir(), 'morse-direct-cf-'));
  const admin = `test-admin-${randomBytes(8).toString('hex')}`;
  let port = 0;
  let proc: ChildProcess | null = null;
  let out = '';
  const devs: Dev[] = [];

  beforeAll(async () => {
    port = await freePort();
    proc = spawn(WRANGLER, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', join(root, 'state'), '--var', `ADMIN_KEY:${admin}`, '--log-level', 'log'], {
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
    devs.forEach((d) => d.morse?.stop());
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
  });


  // (ADR-091) by address: no allowlist, no handle, no trust list — each is the other's contact by address
  const dev = async (name: string): Promise<Dev & { address: string }> => {
    const home = mkdtempSync(join(root, `${name}-`));
    const d = { home, id: loadOrCreateIdentity(home).id, address: loadPrimaryAddress(home).address, mailbox: createMailbox(createDb(':memory:')), logs: [] as string[] };
    devs.push(d);
    return d;
  };
  const connect = (d: Dev) => {
    d.morse = startMorse({ url: `ws://127.0.0.1:${port}`, home: d.home, mailbox: d.mailbox, receiptTimeoutMs: 8000, log: (l) => d.logs.push(l), direct: { stun: [], rtc: ndc } });
    return d.morse;
  };

  it('two addresses open a data channel via the Worker (signals by address over the v3 connection) and exchange messages over it', async () => {
    const a = await dev('alice');
    const b = await dev('bob');
    a.mailbox.contacts.ensureAddress(b.address);
    b.mailbox.contacts.ensureAddress(a.address);
    connect(a);
    connect(b);
    await until(() => Boolean(a.morse!.v3Client?.()?.connected() && b.morse!.v3Client?.()?.connected()), 20_000);
    // no v2 login at all
    expect(a.morse!.client.connected()).toBe(false);

    const m1 = a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'codex', sessionId: 'b-1', device: b.address }, text: 'hello over WebRTC via relay-cf signaling' });
    expect(await a.morse!.send(b.address, m1)).toEqual({ ok: true, via: 'direct' });
    expect(b.mailbox.inbox()[0]!.parts[0]!.text).toBe('hello over WebRTC via relay-cf signaling');
    expect(a.logs.some((l) => /direct: link to .* open/.test(l))).toBe(true);
    // the Worker carried the lookups and signals by address — but no message envelope ("relay v3: A → B sent (…)")
    expect(out).not.toMatch(/relay v3: \S+ → \S+ (sent|stored)/);

    const m2 = b.mailbox.send({ from: { agent: 'codex', sessionId: 'b-1' }, to: { agent: 'claude', sessionId: 'a-1', device: a.address }, text: 'and back' });
    expect(await b.morse!.send(a.address, m2)).toEqual({ ok: true, via: 'direct' });
    expect(a.mailbox.inbox().map((m) => m.parts[0]!.text)).toContain('and back');
    expect(a.morse!.status().direct).toMatchObject({ enabled: true, links: [{ id: b.address, state: 'open' }] });
  }, 60_000);
});
