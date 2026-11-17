import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateEncKey, makeKeyBundle } from '../src/cluster/e2e.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { startRelayClient, type RelayClient, type RelayClientOptions } from '../src/cluster/relay-client.js';

/**
 * ADR-043: the relay connection must always come back. A production daemon logged
 * `relay: disconnected (1006)` and then nothing for 8 days: the next attempt hung
 * (no handshake timeout, no login timeout), so neither 'close' nor 'welcome' ever came
 * and nothing scheduled another attempt. A half-open socket was trusted for ~12 min
 * because pings were sent but their answers never checked.
 */

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const device = () => {
  const home = mkdtempSync(join(tmpdir(), 'morse-liveness-'));
  homes.push(home);
  const identity = loadOrCreateIdentity(home);
  return { identity, bundle: makeKeyBundle(identity, loadOrCreateEncKey(home)) };
};

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const client = (url: string, extra: Partial<RelayClientOptions> = {}): RelayClient => {
  const c = startRelayClient({ url, ...device(), onDeliver: async () => undefined, minBackoffMs: 20, maxBackoffMs: 50, ...extra });
  cleanups.push(() => c.close());
  return c;
};

/** A TCP server that accepts and then never says a word (a stalled proxy / TLS peer). */
const silentTcp = async () => {
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => sockets.push(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  );
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, connections: () => sockets.length };
};

/**
 * A minimal relay: challenge → welcome on hello, then (unless `answer`) silent.
 * `autoPong: false` = protocol pings go unanswered (a half-open path).
 */
const fakeRelay = async (o: { challenge?: boolean; autoPong?: boolean } = {}) => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: o.autoPong ?? true });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const frames: string[] = [];
  let connections = 0;
  wss.on('connection', (ws) => {
    connections++;
    if (o.challenge !== false) ws.send(JSON.stringify({ type: 'challenge', nonce: 'n' }));
    ws.on('message', (raw) => {
      const text = raw.toString();
      frames.push(text);
      if ((JSON.parse(text) as { type: string }).type === 'hello') ws.send(JSON.stringify({ type: 'welcome', handle: 'alice' }));
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close(() => r());
      }),
  );
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, connections: () => connections, frames, wss };
};

describe('relay client: connection attempts always end (ADR-043)', () => {
  it('retries when the TCP connection is accepted but the handshake never answers', async () => {
    const srv = await silentTcp();
    const c = client(srv.url, { connectTimeoutMs: 150 });
    await until(() => srv.connections() >= 3);
    expect(c.connected()).toBe(false);
    expect(c.state().failures).toBeGreaterThanOrEqual(2);
    expect(c.state().lastAttemptAt).not.toBeNull();
  });

  it('retries when the upgrade succeeds but the relay never sends its challenge', async () => {
    const relay = await fakeRelay({ challenge: false });
    const c = client(relay.url, { connectTimeoutMs: 150 });
    await until(() => relay.connections() >= 3);
    expect(c.connected()).toBe(false);
    expect(c.state().lastError).toMatch(/no login within/);
  });

  it('the watchdog restarts the loop when an attempt never ends by itself', async () => {
    const created: string[] = [];
    // a socket that never emits anything and ignores terminate()
    const stuck = () => {
      const e = new EventEmitter() as unknown as WebSocket;
      Object.assign(e, { readyState: WebSocket.CONNECTING, terminate: () => undefined, close: () => undefined, ping: () => undefined, send: () => undefined });
      return e;
    };
    client('ws://127.0.0.1:9', {
      connectTimeoutMs: 60_000,
      watchdogMs: 100,
      createSocket: (u) => {
        created.push(u);
        return stuck();
      },
    });
    await until(() => created.length >= 3);
  });

  it('a connection that throws while opening does not end the loop', async () => {
    let n = 0;
    const relay = await fakeRelay();
    const c = client(relay.url, {
      createSocket: (u) => {
        if (n++ === 0) throw new Error('boom');
        return new WebSocket(u);
      },
    });
    expect(await c.waitConnected(3000)).toBe(true);
  });
});

describe('relay client: liveness (ADR-043)', () => {
  it('drops a logged-in connection whose pings go unanswered, probes with a JSON ping first, and reconnects', async () => {
    const relay = await fakeRelay({ autoPong: false });
    const logs: string[] = [];
    const c = client(relay.url, { pingIntervalMs: 40, livenessTimeoutMs: 200, log: (l) => logs.push(l) });
    expect(await c.waitConnected(3000)).toBe(true);
    await until(() => relay.connections() >= 2);
    expect(relay.frames).toContain('{"type":"ping"}');
    expect(logs.some((l) => /no answer from .* connection is dead, reconnecting/.test(l))).toBe(true);
  });

  it('keeps an idle connection whose pings are answered — and sends no JSON pings then', async () => {
    const relay = await fakeRelay();
    const c = client(relay.url, { pingIntervalMs: 40, livenessTimeoutMs: 200 });
    expect(await c.waitConnected(3000)).toBe(true);
    await sleep(600);
    expect(c.connected()).toBe(true);
    expect(relay.connections()).toBe(1);
    expect(relay.frames.filter((f) => f.includes('"ping"'))).toEqual([]);
  });

  it('state() tells when it last connected and since when it is disconnected', async () => {
    const relay = await fakeRelay();
    const c = client(relay.url, { minBackoffMs: 5000, maxBackoffMs: 5000 });
    expect(c.state().connected).toBe(false);
    expect(c.state().lastConnectedAt).toBeNull();
    expect(await c.waitConnected(3000)).toBe(true);
    const s = c.state();
    expect(s.connected).toBe(true);
    expect(s.lastConnectedAt).toBeGreaterThan(0);
    expect(s.disconnectedSince).toBeNull();
    relay.wss.clients.forEach((ws) => ws.terminate());
    await until(() => !c.connected());
    expect(c.state().disconnectedSince).toBeGreaterThanOrEqual(s.lastConnectedAt!);
    expect(c.state().lastConnectedAt).toBe(s.lastConnectedAt);
  });
});
