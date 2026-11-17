import { connect as netConnect, type Socket } from 'node:net';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LAN_MAX_BODY, lanTxt, startAddressLan, type AddressLan, type AddressLanOptions } from '../src/cluster/lan-address.js';

/**
 * (ADR-091 follow-up) The LAN listener on its own: it opens before it answers and answers the same whatever it
 * found; no browser, JSON only, bounded body, connections, request rate and new senders per IP; it proves only the
 * announced address; it remembers a bounded number of addresses. (With Morse: test/morse-remove-v2.test.ts.)
 */

const HERE = 'k7f3a9xqm2v8c4h6jt5rwn8d2p';
const lans: AddressLan[] = [];
afterEach(async () => {
  await Promise.all(lans.splice(0).map((l) => l.stop()));
});

const listener = async (o: Partial<AddressLanOptions> = {}) => {
  const l = await startAddressLan({ port: 0, host: '127.0.0.1', mdns: false, address: () => HERE, sign: () => null, check: () => ({ ok: false }), onEnvelope: () => undefined, ...o });
  lans.push(l);
  return l;
};
const post = (port: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }, path = '/v3/envelope') =>
  new Promise<{ status: number; body: string }>((resolve) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += String(d)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(body);
  });
const env = (to: string) => JSON.stringify({ blob: JSON.stringify({ v: 3, to, enc: 'x', ct: 'y' }) });

describe('the LAN listener (ADR-091 follow-up)', () => {
  it('opens every envelope before it hands it on — and answers the same whatever it found: nothing says which addresses live here', async () => {
    const checked: string[] = [];
    const taken: string[] = [];
    const l = await listener({
      check: (blob) => {
        checked.push(blob);
        return JSON.parse(blob).to === HERE ? { ok: true, from: 'm4q8c2vxk7h3n9td5rwf6pj2ya', known: true } : { ok: false };
      },
      onEnvelope: (blob) => void taken.push(blob),
    });
    const here = await post(l.port, env(HERE));
    const elsewhere = await post(l.port, env('m4q8c2vxk7h3n9td5rwf6pj2ya'));
    const garbage = await post(l.port, JSON.stringify({ blob: 'not an envelope' }));
    expect([here, elsewhere, garbage]).toEqual([
      { status: 202, body: '{}' },
      { status: 202, body: '{}' },
      { status: 202, body: '{}' },
    ]);
    expect(checked).toHaveLength(3);
    expect(taken).toHaveLength(1);
    expect(await post(l.port, 'not json')).toMatchObject({ status: 400 });
    expect(await post(l.port, '{}', undefined, '/api/peer/morse')).toMatchObject({ status: 404 });
  });

  it('never from a browser, JSON only, and no body above the relay\'s envelope limit', async () => {
    const l = await listener({ check: () => ({ ok: true, from: 'm4q8c2vxk7h3n9td5rwf6pj2ya', known: true }) });
    expect(await post(l.port, env(HERE), { 'content-type': 'application/json', origin: 'https://evil.example' })).toMatchObject({ status: 403 });
    expect(await post(l.port, env(HERE), { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).toMatchObject({ status: 403 });
    expect(await post(l.port, env(HERE), { 'content-type': 'text/plain' })).toMatchObject({ status: 415 });
    // (said in the header: refused before a byte of the body is read)
    expect(await post(l.port, 'x', { 'content-type': 'application/json', 'content-length': String(LAN_MAX_BODY + 10) })).toMatchObject({ status: 413 });
    expect(LAN_MAX_BODY).toBeLessThan(1_200_000);
  });

  it('a few NEW senders per IP: the rest are dropped (their message requests do not fill the store) — contacts are not counted', async () => {
    const taken: string[] = [];
    let n = 0;
    const l = await listener({
      limits: { strangersPerIp: 3 },
      check: (blob) => {
        const to = JSON.parse(blob).to as string;
        return to === 'contact' ? { ok: true, from: 'contact-address', known: true } : { ok: true, from: `stranger-${++n}`, known: false };
      },
      onEnvelope: (blob) => void taken.push(blob),
    });
    for (let i = 0; i < 6; i++) await post(l.port, env(`s${i}`));
    for (let i = 0; i < 4; i++) await post(l.port, env('contact'));
    expect(taken.filter((b) => JSON.parse(b).to !== 'contact')).toHaveLength(3);
    expect(taken.filter((b) => JSON.parse(b).to === 'contact')).toHaveLength(4);
  });

  it('a request rate per IP, and a cap on connections held open', async () => {
    const l = await listener({ limits: { perIpPerMinute: 5, maxConnections: 4 } });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await post(l.port, env(HERE))).status);
    expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    // slow connections that never finish their request: no more than the cap are kept
    const sockets: Socket[] = [];
    let closedEarly = 0;
    await Promise.all(
      Array.from({ length: 12 }, () => new Promise<void>((resolve) => {
        const s = netConnect(l.port, '127.0.0.1', () => {
          s.write('POST /v3/envelope HTTP/1.1\r\nHost: x\r\n');
          resolve();
        });
        s.on('close', () => closedEarly++);
        s.on('error', () => undefined);
        sockets.push(s);
      })),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(closedEarly).toBeGreaterThanOrEqual(8);
    sockets.forEach((s) => s.destroy());
  });

  it('proves only the address it announces — asked about any other, the same answer as for an address nowhere', async () => {
    const signed: string[] = [];
    const l = await listener({ sign: (address) => (signed.push(address), address === HERE ? { publicKey: Buffer.alloc(32, 1), sig: Buffer.alloc(64, 2) } : null) });
    expect((await post(l.port, JSON.stringify({ address: HERE, nonce: 'abcdefghijklmnopqrstuv' }), undefined, '/v3/prove')).status).toBe(200);
    const other = await post(l.port, JSON.stringify({ address: 'm4q8c2vxk7h3n9td5rwf6pj2ya', nonce: 'abcdefghijklmnopqrstuv' }), undefined, '/v3/prove');
    const nowhere = await post(l.port, JSON.stringify({ address: '23456789abcdefghjkmnpqrstv', nonce: 'abcdefghijklmnopqrstuv' }), undefined, '/v3/prove');
    expect(other).toEqual(nowhere);
    expect(signed).toEqual([HERE]); // never even asked to sign as another address
    expect(lanTxt(HERE)).toEqual({ v: '3', a0: HERE });
  });

  it('remembers a bounded number of addresses; a computer that cannot prove the address it announced is never sent to', async () => {
    const l = await listener({ limits: { maxPeers: 3 } });
    const addrs = ['22222222222222222222222222', '33333333333333333333333333', '44444444444444444444444444', '55555555555555555555555555', '66666666666666666666666666'];
    for (const a of addrs) l.addPeer(a, '127.0.0.1', 9);
    expect(l.peers().map((p) => p.address)).toEqual(addrs.slice(2));
    const posted: string[] = [];
    const liar = await listener({ address: () => null, check: () => ({ ok: true, from: 'x', known: true }), onEnvelope: (b) => void posted.push(b) });
    l.addPeer('77777777777777777777777777', '127.0.0.1', liar.port);
    expect(l.reachable('77777777777777777777777777')).toBe(true);
    expect(await l.send('77777777777777777777777777', '{}')).toBe(false);
    expect(posted).toEqual([]);
    expect(l.reachable('77777777777777777777777777')).toBe(false); // left alone for a while
  });
});
