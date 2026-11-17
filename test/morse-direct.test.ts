import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { loadRtc, type RtcDataChannel, type RtcModule, type RtcPeer } from '../src/cluster/direct.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { stageOutboxFiles, startMorse, type Morse, type MorseSendResult } from '../src/cluster/morse.js';
import { loadPrimaryAddress } from '../src/identity/address-key.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

/**
 * ADR-069 routing in morse.ts: direct first, relay as fallback. Two Morse instances
 * against the in-memory fake relay (which forwards `signal`), the real node-datachannel
 * on loopback. The real Worker is covered by relay-cf/test/direct-wrangler.test.ts.
 *
 * (ADR-091) By address: a link is between two addresses that are each other's contacts; its signals are v3
 * envelopes over the v3 connection. No device, no trust list, no v2 login.
 */

const loaded = await loadRtc();
const ndc = 'rtc' in loaded ? loaded.rtc : null;
const withRtc = ndc ? describe : describe.skip;

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-direct-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const until = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

interface Dev {
  home: string;
  id: string;
  /** (ADR-091) the computer's first address — what a link is between */
  address: string;
  mailbox: Mailbox;
  logs: string[];
  morse?: Morse;
}
const dev = (): Dev => {
  const home = freshHome();
  return { home, id: loadOrCreateIdentity(home).id, address: loadPrimaryAddress(home).address, mailbox: createMailbox(createDb(':memory:')), logs: [] };
};

let relay: FakeRelay | null = null;
const running: Morse[] = [];
afterEach(async () => {
  running.splice(0).forEach((m) => m.stop());
  await relay?.close();
  relay = null;
});

const connect = (d: Dev, extra: Partial<Parameters<typeof startMorse>[0]> = {}) => {
  d.morse = startMorse({
    url: `ws://127.0.0.1:${relay!.port}`,
    home: d.home,
    mailbox: d.mailbox,
    receiptTimeoutMs: 4000,
    log: (l) => d.logs.push(l),
    direct: { stun: [], rtc: ndc },
    ...extra,
  });
  running.push(d.morse);
  return d.morse;
};
const online = async (...ds: Dev[]) => until(() => ds.every((d) => Boolean(d.morse!.v3Client?.()?.connected())));
/** (ADR-091) each is the other's contact, by address */
const pair = (a: Dev, b: Dev) => {
  a.mailbox.contacts.ensureAddress(b.address);
  b.mailbox.contacts.ensureAddress(a.address);
};
/** the peer of `a` in these tests is always b — `bob` stands for its address */
let bob = '';
let alice = '';
const sendFrom = (a: Dev, text: string) => a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'codex', sessionId: 'b-1', device: bob }, text });

/** A WebRTC stack whose data channels misbehave on the receiving side. */
const misbehaving = (mode: 'swallow' | 'hangup'): RtcModule => ({
  PeerConnection: class {
    constructor(name: string, cfg: { iceServers: string[] }) {
      const pc = new ndc!.PeerConnection(name, cfg) as RtcPeer;
      const wrapDc = (dc: RtcDataChannel): RtcDataChannel =>
        new Proxy(dc, {
          get(target, prop) {
            if (prop === 'onMessage') {
              return (cb: (m: string | Buffer | ArrayBuffer) => void) =>
                target.onMessage((m) => {
                  if (mode === 'swallow') return; // never delivered → no receipt
                  pc.close(); // the link dies as the message arrives
                  void cb;
                });
            }
            const v = Reflect.get(target, prop) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
      return new Proxy(pc, {
        get(target, prop) {
          if (prop === 'onDataChannel') return (cb: (dc: RtcDataChannel) => void) => target.onDataChannel((dc) => cb(wrapDc(dc)));
          if (prop === 'createDataChannel') return (label: string, c?: Record<string, unknown>) => wrapDc(target.createDataChannel(label, c));
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    }
  } as unknown as RtcModule['PeerConnection'],
});

/**
 * A WebRTC stack whose close() reaches the other side late — as under load, when the
 * native threads lag behind: for `ms` the other side still sees an open link.
 */
const slowClose = (ms: number): RtcModule => ({
  PeerConnection: class {
    constructor(name: string, cfg: { iceServers: string[] }) {
      const pc = new ndc!.PeerConnection(name, cfg) as RtcPeer;
      const later = (close: () => void) => () =>
        void setTimeout(() => {
          try {
            close();
          } catch {
            /* already closed */
          }
        }, ms);
      const wrapDc = (dc: RtcDataChannel): RtcDataChannel =>
        new Proxy(dc, {
          get(target, prop) {
            if (prop === 'close') return later(() => target.close());
            const v = Reflect.get(target, prop) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
      return new Proxy(pc, {
        get(target, prop) {
          if (prop === 'close') return later(() => target.close());
          if (prop === 'onDataChannel') return (cb: (dc: RtcDataChannel) => void) => target.onDataChannel((dc) => cb(wrapDc(dc)));
          if (prop === 'createDataChannel') return (label: string, c?: Record<string, unknown>) => wrapDc(c ? target.createDataChannel(label, c) : target.createDataChannel(label));
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    }
  } as unknown as RtcModule['PeerConnection'],
});

withRtc('morse: direct first, relay as fallback (ADR-069)', () => {
  it('delivers over a direct link; the receipt comes back over it; the link is reused', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true,  });
    connect(a);
    connect(b);
    await online(a, b);
    const r = await a.morse!.send(bob, sendFrom(a, 'over the data channel'));
    expect(r).toEqual({ ok: true, via: 'direct' });
    expect(b.mailbox.inbox()[0]!.parts[0]).toMatchObject({ text: 'over the data channel', via: 'morse-relay' });
    expect(a.logs.some((l) => /delivered via direct/.test(l))).toBe(true);
    expect(b.logs.some((l) => /direct: received .* via direct/.test(l))).toBe(true);
    // (the last ICE candidates may still be on their way once the link carried the first message)
    await new Promise((r) => setTimeout(r, 300));
    const signals = relay.signals();
    expect(signals).toBeGreaterThan(0);
    expect(await a.morse!.send(bob, sendFrom(a, 'second'))).toEqual({ ok: true, via: 'direct' });
    expect(relay.signals()).toBe(signals);
    // and back the other way over the same link
    const back = b.mailbox.send({ from: { agent: 'codex', sessionId: 'b-1' }, to: { agent: 'claude', sessionId: 'a-1', device: alice }, text: 'reply' });
    expect(await b.morse!.send(alice, back)).toEqual({ ok: true, via: 'direct' });
    expect(a.morse!.status().direct).toMatchObject({ enabled: true, links: [{ id: b.address, state: 'open' }] });
    expect(relay.dump()).not.toContain('over the data channel');
  });

  it('the other side has no direct links (older client): relay after ~3 s, then straight to the relay', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true,  });
    connect(a, { direct: { stun: [], rtc: ndc, connectTimeoutMs: 800 } });
    connect(b, { direct: false });
    await online(a, b);
    const t0 = Date.now();
    expect(await a.morse!.send(bob, sendFrom(a, 'first'))).toEqual({ ok: true, via: 'relay' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(750);
    const t1 = Date.now();
    expect(await a.morse!.send(bob, sendFrom(a, 'second'))).toEqual({ ok: true, via: 'relay' });
    expect(Date.now() - t1).toBeLessThan(700);
    expect(b.mailbox.inbox().map((m) => m.parts[0]!.text)).toEqual(['first', 'second']);
  });

  it('an old relay without signaling: straight to the relay, no waiting', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true, signal: false });
    connect(a);
    connect(b);
    await online(a, b);
    const t0 = Date.now();
    expect(await a.morse!.send(bob, sendFrom(a, 'hello'))).toEqual({ ok: true, via: 'relay' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(a.morse!.status().direct?.noSignalUntil).toBeGreaterThan(Date.now());
  });

  it('no receipt over the link in time: the link is dropped and the message goes through the relay', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true,  });
    connect(a, { directReceiptMs: 400 });
    connect(b, { direct: { stun: [], rtc: misbehaving('swallow') } });
    await online(a, b);
    expect(await a.morse!.send(bob, sendFrom(a, 'lost on the link'))).toEqual({ ok: true, via: 'relay' });
    expect(b.mailbox.inbox().map((m) => m.parts[0]!.text)).toEqual(['lost on the link']);
    expect(a.logs.some((l) => /direct failed \(no receipt within 0.4 s\) — falling back to relay/.test(l))).toBe(true);
    expect(a.morse!.status().direct?.backoff.map((x) => x.id)).toEqual([b.address]);
  });

  it('the sender gave up on a link the other side still sees as open: the receipt comes back through the relay', async () => {
    // the sender no longer reads the link once it fell back; a receipt written to it would be lost
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true,  });
    connect(a, { directReceiptMs: 400, direct: { stun: [], rtc: slowClose(1000) } });
    connect(b, { direct: { stun: [], rtc: misbehaving('swallow') } });
    await online(a, b);
    const t0 = Date.now();
    expect(await a.morse!.send(bob, sendFrom(a, 'half-closed link'))).toEqual({ ok: true, via: 'relay' });
    expect(Date.now() - t0).toBeLessThan(1400); // before the close arrived: b answered while its link still looked open
    expect(b.morse!.status().direct?.links.map((l) => l.state)).toEqual(['open']);
    expect(b.mailbox.inbox().map((m) => m.parts[0]!.text)).toEqual(['half-closed link']);
    expect(a.logs.some((l) => /relay: receipt for .* from morse.im\//.test(l))).toBe(true);
  });

  it('the link drops mid-way: the message goes through the relay at once', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true,  });
    connect(a, { directReceiptMs: 3000 });
    connect(b, { direct: { stun: [], rtc: misbehaving('hangup') } });
    await online(a, b);
    const t0 = Date.now();
    expect(await a.morse!.send(bob, sendFrom(a, 'dropped link'))).toEqual({ ok: true, via: 'relay' });
    expect(Date.now() - t0).toBeLessThan(2900);
    expect(a.logs.some((l) => /direct failed \(the link dropped before the receipt\)/.test(l))).toBe(true);
    expect(b.mailbox.inbox()).toHaveLength(1);
  });

  it('the relay goes down while a link is open: the link still carries messages', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true,  });
    connect(a, { connectWaitMs: 200 });
    connect(b);
    await online(a, b);
    expect(await a.morse!.send(bob, sendFrom(a, 'one'))).toEqual({ ok: true, via: 'direct' });
    await relay.close();
    relay = null;
    await until(() => !a.morse!.v3Client?.()?.connected());
    const down = await a.morse!.send(bob, sendFrom(a, 'relay is down'));
    expect(down, `${JSON.stringify(down)} A: ${a.logs.join(' // ')} B: ${b.logs.join(' // ')}`).toEqual({ ok: true, via: 'direct' });
    expect(b.mailbox.inbox().map((m) => m.parts[0]!.text)).toEqual(['one', 'relay is down']);
  });

  it('strangers get no direct link: a message request still goes through the relay', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    a.mailbox.contacts.ensureAddress(b.address); // b does not know a
    relay = await startFakeRelay({ port: 0, v3: true,  });
    connect(a, { direct: { stun: [], rtc: ndc, connectTimeoutMs: 600 } });
    connect(b);
    await online(a, b);
    const r = await a.morse!.send(bob, sendFrom(a, 'hi, stranger here'));
    expect(r).toMatchObject({ ok: true, via: 'relay', request: true });
    expect(b.logs.some((l) => /not a contact or paired device/.test(l))).toBe(true);
    expect(b.morse!.status().direct?.links).toEqual([]);
  });

  it('direct off: status has no direct section and nothing is signaled', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true,  });
    connect(a, { direct: false });
    connect(b, { direct: false });
    await online(a, b);
    expect(await a.morse!.send(bob, sendFrom(a, 'plain relay'))).toEqual({ ok: true, via: 'relay' });
    expect(a.morse!.status().direct).toBeUndefined();
    expect(relay.signals()).toBe(0);
  });
});

withRtc('morse: large files with direct links (ADR-069 + ADR-038)', () => {
  /** Small relay envelopes (64 KB) so 1 MB is a chunked transfer either way. */
  const CHUNKY = { chunkRatePerMinute: 100_000, rateBackoffMs: 50, transferTuning: { ackIdleMs: 400, completeWaitMs: 3000, maxIdleRounds: 3 }, connectWaitMs: 300 };
  const withFile = (a: Dev, size: number) => {
    const path = join(a.home, 'big.bin');
    const data = randomBytes(size);
    writeFileSync(path, data);
    const files = stageOutboxFiles([path], a.home);
    return { data, m: a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'codex', sessionId: 'b-1', device: bob }, text: 'file', files }) };
  };
  const deliver = async (d: Dev, id: string, ms = 20_000): Promise<MorseSendResult> => {
    const end = Date.now() + ms;
    for (;;) {
      const r = await d.morse!.send(bob, d.mailbox.getMessage(id)!);
      if (!r.waiting || Date.now() > end) return r;
      await until(() => d.morse!.transfer(id)?.state !== 'sending', Math.max(100, end - Date.now())).catch(() => undefined);
    }
  };
  const fileOf = (d: Dev) => d.mailbox.inbox({ all: true }).flatMap((m) => m.parts.flatMap((p) => p.files ?? []))[0]!;

  it('a chunked file goes over the direct link when it opens', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true, maxBlobBytes: 64 * 1024, ratePerMinute: 100_000 });
    connect(a, CHUNKY);
    connect(b, CHUNKY);
    await online(a, b);
    const { data, m } = withFile(a, 1024 * 1024);
    expect(await deliver(a, m.id)).toEqual({ ok: true, via: 'direct' });
    expect(readFileSync(fileOf(b).path).equals(data)).toBe(true);
    expect(a.logs.some((l) => /delivered via direct — (\d+)\/\1 chunks/.test(l))).toBe(true);
  });

  it('no direct link: data bigger than one relay envelope still goes through the relay in chunks', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true, maxBlobBytes: 64 * 1024, ratePerMinute: 100_000 });
    connect(a, { ...CHUNKY, direct: { stun: [], rtc: ndc, connectTimeoutMs: 500 } });
    connect(b, { ...CHUNKY, direct: false });
    await online(a, b);
    const { data, m } = withFile(a, 1024 * 1024);
    expect(await deliver(a, m.id)).toEqual({ ok: true, via: 'relay' });
    expect(readFileSync(fileOf(b).path).equals(data)).toBe(true);
    expect(a.logs.some((l) => /delivered via relay — (\d+)\/\1 chunks/.test(l))).toBe(true);
  });

  it('chunks of a big file: over the link, or through the v3 relay — never into its offline mailbox', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true, maxBlobBytes: 64 * 1024, ratePerMinute: 100_000 });
    connect(a, { ...CHUNKY, direct: { stun: [], rtc: ndc, connectTimeoutMs: 500 } });
    connect(b, { ...CHUNKY, direct: false });
    await online(a, b);
    const { data, m } = withFile(a, 300 * 1024);
    expect(await deliver(a, m.id)).toEqual({ ok: true, via: 'relay' });
    expect(readFileSync(fileOf(b).path).equals(data)).toBe(true);
    expect(relay.v3Sends().sent).toBeGreaterThan(5);
    expect(relay.v3Sends().stored).toBe(0);
  });
});

withRtc('direct links carry v3 envelopes too (ADR-073)', () => {
  const v3Online = (...ds: Dev[]) => until(() => ds.every((d) => Boolean(d.morse!.v3Client?.()?.connected())));

  it('both on v3: the message and its receipt go over the link as v3 envelopes', async () => {
    const a = dev();
    const b = dev();
    bob = b.address;
    alice = a.address;
    pair(a, b);
    relay = await startFakeRelay({ port: 0, v3: true,  });
    connect(a);
    connect(b);
    await online(a, b);
    expect(await a.morse!.send(bob, sendFrom(a, 'v3 over the data channel'))).toEqual({ ok: true, via: 'direct' });
    expect(b.mailbox.inbox()[0]!.parts[0]).toMatchObject({ text: 'v3 over the data channel', via: 'morse-relay' });
    expect(a.logs.some((l) => /delivered via direct \(WebRTC data channel, v3, peer\)/.test(l))).toBe(true);
    expect(relay.v3Sends()).toEqual({ sent: 0, stored: 0, offline: 0 }); // nothing went through the relay
  });

});
