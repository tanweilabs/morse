import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { encodeFrames, loadRtc, sdpFingerprint, startDirect, type DirectLink, type DirectOptions, type RtcDataChannel, type RtcModule, type RtcPeer } from '../src/cluster/direct.js';
import { loadOrCreateEncKey, makeKeyBundle, seal, verifyKeyBundle, type KeyBundle } from '../src/cluster/e2e.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';

/**
 * ADR-069 direct links (src/cluster/direct.ts): two links in this process, an in-memory
 * signal channel between them, the real node-datachannel on loopback (host candidates,
 * no STUN — no network needed).
 */

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));
const links: DirectLink[] = [];
afterEach(() => links.splice(0).forEach((l) => l.close()));

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const loaded = await loadRtc();
const ndc = 'rtc' in loaded ? loaded.rtc : null;
const withRtc = ndc ? describe : describe.skip;

interface Node {
  id: string;
  home: string;
  bundle: KeyBundle;
  identity: ReturnType<typeof loadOrCreateIdentity>;
  enc: ReturnType<typeof loadOrCreateEncKey>;
  got: string[];
  logs: string[];
  link?: DirectLink;
}
const bundles = new Map<string, KeyBundle>();
const node = (): Node => {
  const home = mkdtempSync(join(tmpdir(), 'morse-direct-'));
  homes.push(home);
  const identity = loadOrCreateIdentity(home);
  const enc = loadOrCreateEncKey(home);
  const bundle = makeKeyBundle(identity, enc);
  bundles.set(identity.id, bundle);
  return { id: identity.id, home, bundle, identity, enc, got: [], logs: [] };
};

/** In-memory signal channel: delivers to whichever link is registered for `to`. */
const bus = new Map<string, DirectLink>();
let tap: ((from: string, to: string, blob: string) => string | null) | null = null;
const captured: Array<{ from: string; to: string; blob: string }> = [];
afterEach(() => {
  bus.clear();
  tap = null;
  captured.length = 0;
});

const start = (n: Node, peers: () => string[], extra: Partial<DirectOptions> = {}): DirectLink => {
  const link = startDirect({
    identity: n.identity,
    enc: n.enc,
    recipientKey: async (id) => verifyKeyBundle(bundles.get(id)!, id),
    isPeer: (id) => peers().includes(id),
    signal: {
      send: async (to, blob) => {
        captured.push({ from: n.id, to, blob });
        const out = tap ? tap(n.id, to, blob) : blob;
        const target = bus.get(to);
        if (!target) return 'offline';
        if (out !== null) setImmediate(() => target.onSignal(n.id, out));
        return 'sent';
      },
    },
    onMessage: (_from, blob) => n.got.push(blob),
    log: (l) => n.logs.push(l),
    stun: [],
    rtc: ndc,
    connectTimeoutMs: 3000,
    ...extra,
  });
  n.link = link;
  bus.set(n.id, link);
  links.push(link);
  return link;
};
const pairUp = (extraA: Partial<DirectOptions> = {}, extraB: Partial<DirectOptions> = {}) => {
  const a = node();
  const b = node();
  start(a, () => [b.id], extraA);
  start(b, () => [a.id], extraB);
  return { a, b };
};

describe('direct helpers', () => {
  it('sdpFingerprint reads a=fingerprint, normalised', () => {
    expect(sdpFingerprint('v=0\r\na=fingerprint:SHA-256 ab:cd:EF\r\n')).toEqual({ algorithm: 'sha-256', value: 'AB:CD:EF' });
    expect(sdpFingerprint('v=0\r\n')).toBeNull();
  });

  it('encodeFrames splits into [type][seq][index][count] frames', () => {
    const frames = encodeFrames(7, Buffer.from('abcdefghij'), 4);
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => [f[0], f.readUInt32BE(1), f.readUInt32BE(5), f.readUInt32BE(9), f.subarray(13).toString()])).toEqual([
      [1, 7, 0, 3, 'abcd'],
      [1, 7, 1, 3, 'efgh'],
      [1, 7, 2, 3, 'ij'],
    ]);
    expect(encodeFrames(0, Buffer.alloc(0), 4)).toHaveLength(1);
  });

  it('loadRtc reports a missing module instead of throwing', async () => {
    const r = await loadRtc('node-datachannel-does-not-exist');
    expect(r).toEqual({ error: 'node-datachannel-does-not-exist is not installed' });
  });

  it('without the WebRTC module: unavailable, send says false, status says why', async () => {
    const a = node();
    const link = start(a, () => ['X'], { rtc: null });
    await link.ready();
    expect(link.available()).toBe(false);
    expect(await link.send('X', 'blob')).toBe(false);
    expect(link.status()).toMatchObject({ enabled: false, reason: 'WebRTC module unavailable', links: [] });
    link.onSignal('X', '{}'); // ignored, no throw
  });
});

withRtc('direct links over loopback (real node-datachannel)', () => {
  it('opens a link, carries envelopes both ways, reuses it', async () => {
    const { a, b } = pairUp();
    expect(await a.link!.send(b.id, 'hello from a')).toBe(true);
    await until(() => b.got.length === 1);
    expect(b.got).toEqual(['hello from a']);
    expect(a.link!.isOpen(b.id)).toBe(true);
    await until(() => b.link!.isOpen(a.id));
    const signalsAfterOpen = captured.length;
    expect(await b.link!.send(a.id, 'hello back', false)).toBe(true);
    expect(await a.link!.send(b.id, 'again')).toBe(true);
    await until(() => a.got.length === 1 && b.got.length === 2);
    expect(captured.length).toBe(signalsAfterOpen); // no new signaling for a reused link
    expect(a.link!.status()).toMatchObject({ enabled: true, links: [{ id: b.id, state: 'open', role: 'offer' }] });
    expect(a.logs.some((l) => /direct: link to .* open/.test(l))).toBe(true);
    // the relay (signal channel) only ever saw sealed envelopes: no SDP, no candidates
    for (const s of captured) expect(s.blob).not.toMatch(/a=fingerprint|candidate:/);
  });

  it('fragments a large envelope and reassembles it', async () => {
    const { a, b } = pairUp();
    const big = 'x'.repeat(900_000) + 'END';
    expect(await a.link!.send(b.id, big)).toBe(true);
    await until(() => b.got.length === 1);
    expect(b.got[0]!.length).toBe(big.length);
    expect(b.got[0]!.endsWith('END')).toBe(true);
  });

  it('fragments handed over in another order are still put together (node-datachannel swaps message callbacks under load)', async () => {
    // the receiving side gets every frame, but in reverse — two messages' fragments mixed
    const scrambled = (holdMs: number): RtcModule => ({
      PeerConnection: class {
        constructor(name: string, cfg: { iceServers: string[] }) {
          const pc = new ndc!.PeerConnection(name, cfg) as RtcPeer;
          const bound = (target: object, prop: string | symbol) => {
            const v = Reflect.get(target, prop) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          };
          const wrapDc = (dc: RtcDataChannel): RtcDataChannel => {
            const held: Buffer[] = [];
            let timer: NodeJS.Timeout | undefined;
            return new Proxy(dc, {
              get(target, prop) {
                if (prop === 'onMessage') {
                  return (cb: (m: string | Buffer | ArrayBuffer) => void) =>
                    target.onMessage((m) => {
                      held.push(Buffer.from(m as Buffer));
                      clearTimeout(timer);
                      timer = setTimeout(() => held.splice(0).reverse().forEach((f) => cb(f)), holdMs);
                    });
                }
                return bound(target, prop);
              },
            });
          };
          return new Proxy(pc, {
            get(target, prop) {
              if (prop === 'onDataChannel') return (cb: (dc: RtcDataChannel) => void) => target.onDataChannel((dc) => cb(wrapDc(dc)));
              return bound(target, prop);
            },
          });
        }
      } as unknown as RtcModule['PeerConnection'],
    });
    const a = node();
    const b = node();
    start(a, () => [b.id]);
    start(b, () => [a.id], { rtc: scrambled(200) });
    const first = 'a'.repeat(400_000) + 'END-1';
    const second = 'b'.repeat(200_000) + 'END-2';
    expect(await a.link!.send(b.id, first)).toBe(true);
    expect(await a.link!.send(b.id, second)).toBe(true);
    expect(await a.link!.send(b.id, 'small')).toBe(true);
    await until(() => b.got.length === 3, 3000);
    expect([...b.got].sort()).toEqual([first, second, 'small'].sort()); // each one whole; their order is not promised
    expect(b.logs.join('\n')).not.toMatch(/malformed|unfinished/);
  });

  it('a fragment that cannot belong (index beyond the count, the same one twice) drops that message only', async () => {
    // a's own data channel, to write frames by hand: [type=1][seq][index][count][payload]
    let raw: RtcDataChannel | null = null;
    const tapping: RtcModule = {
      PeerConnection: class {
        constructor(name: string, cfg: { iceServers: string[] }) {
          const pc = new ndc!.PeerConnection(name, cfg) as RtcPeer;
          return new Proxy(pc, {
            get(target, prop) {
              if (prop === 'createDataChannel') return (label: string) => (raw = target.createDataChannel(label));
              const v = Reflect.get(target, prop) as unknown;
              return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
            },
          });
        }
      } as unknown as RtcModule['PeerConnection'],
    };
    const a = node();
    const b = node();
    start(a, () => [b.id], { rtc: tapping });
    start(b, () => [a.id]);
    expect(await a.link!.send(b.id, 'opens the link')).toBe(true);
    await until(() => b.got.length === 1);
    const frame = (seq: number, index: number, count: number, text: string) => {
      const h = Buffer.alloc(13);
      h[0] = 1;
      h.writeUInt32BE(seq, 1);
      h.writeUInt32BE(index, 5);
      h.writeUInt32BE(count, 9);
      return Buffer.concat([h, Buffer.from(text)]);
    };
    const dc = raw as unknown as RtcDataChannel;
    dc.sendMessageBinary(frame(900, 5, 2, 'x')); // index beyond the count
    dc.sendMessageBinary(frame(901, 0, 2, 'he'));
    dc.sendMessageBinary(frame(901, 0, 2, 'he')); // the same fragment twice
    dc.sendMessageBinary(frame(901, 1, 2, 'llo')); // … so 901 starts over and stays unfinished
    dc.sendMessageBinary(frame(902, 1, 2, 'ld')); // out of order, whole
    dc.sendMessageBinary(frame(902, 0, 2, 'wor'));
    await until(() => b.got.length === 2);
    expect(b.got[1]).toBe('world');
    await until(() => b.logs.filter((l) => /malformed/.test(l)).length === 2);
    expect(b.logs.filter((l) => /malformed/.test(l)).map((l) => /\((.*)\)/.exec(l)![1])).toEqual(['fragment index', 'fragment twice']);
  });

  it('frames that arrive before the open callback are not lost (the caller writes the moment its own end is open)', async () => {
    // the answering side learns "open" late — as when its callbacks are delivered in another order under load
    const lateOpen = (ms: number): RtcModule => ({
      PeerConnection: class {
        constructor(name: string, cfg: { iceServers: string[] }) {
          const pc = new ndc!.PeerConnection(name, cfg) as RtcPeer;
          const bound = (target: object, prop: string | symbol) => {
            const v = Reflect.get(target, prop) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          };
          const wrapDc = (dc: RtcDataChannel): RtcDataChannel => {
            let told = false;
            return new Proxy(dc, {
              get(target, prop) {
                if (prop === 'onOpen') {
                  return (cb: () => void) =>
                    target.onOpen(() =>
                      void setTimeout(() => {
                        told = true;
                        cb();
                      }, ms),
                    );
                }
                if (prop === 'isOpen') return () => told && target.isOpen();
                return bound(target, prop);
              },
            });
          };
          return new Proxy(pc, {
            get(target, prop) {
              if (prop === 'onDataChannel') return (cb: (dc: RtcDataChannel) => void) => target.onDataChannel((dc) => cb(wrapDc(dc)));
              return bound(target, prop);
            },
          });
        }
      } as unknown as RtcModule['PeerConnection'],
    });
    const a = node();
    const b = node();
    start(a, () => [b.id]);
    start(b, () => [a.id], { rtc: lateOpen(600) });
    const big = 'y'.repeat(300_000) + 'END';
    expect(await a.link!.send(b.id, big)).toBe(true);
    await until(() => b.got.length === 1, 3000);
    expect(b.got[0]).toBe(big);
    expect(b.logs.join('\n')).not.toMatch(/malformed/);
    expect(b.link!.isOpen(a.id)).toBe(true);
    expect(b.logs.filter((l) => /link to .* open/.test(l))).toHaveLength(1); // the late callback opens nothing twice
  });

  it('a call that fails the moment it is set up is made once more — and only once', async () => {
    // the first `howMany` connections we make never get the answer and report "failed" instead
    const failingFirst = (howMany: number) => {
      const made = { n: 0 };
      const rtc: RtcModule = {
        PeerConnection: class {
          constructor(name: string, cfg: { iceServers: string[] }) {
            const pc = new ndc!.PeerConnection(name, cfg) as RtcPeer;
            const mine = ++made.n;
            let onState: ((state: string) => void) | null = null;
            return new Proxy(pc, {
              get(target, prop) {
                if (prop === 'onStateChange') {
                  return (cb: (state: string) => void) => {
                    onState = cb;
                    target.onStateChange(cb);
                  };
                }
                if (prop === 'setRemoteDescription' && mine <= howMany) {
                  return () => void setImmediate(() => onState?.('failed'));
                }
                const v = Reflect.get(target, prop) as unknown;
                return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
              },
            });
          }
        } as unknown as RtcModule['PeerConnection'],
      };
      return { rtc, made };
    };

    const once = failingFirst(1);
    const a = node();
    const b = node();
    start(a, () => [b.id], { rtc: once.rtc });
    start(b, () => [a.id]);
    expect(await a.link!.send(b.id, 'second call')).toBe(true);
    await until(() => b.got.length === 1);
    expect(b.got).toEqual(['second call']);
    expect(once.made.n).toBe(2);
    expect(a.logs.filter((l) => /failed as it was set up .* calling once more/.test(l))).toHaveLength(1);
    expect(a.link!.status().backoff).toEqual([]);
    expect(a.link!.isOpen(b.id)).toBe(true);

    // it keeps failing: one more call, then the usual backoff (the caller uses the relay)
    const always = failingFirst(99);
    const c = node();
    const d = node();
    start(c, () => [d.id], { rtc: always.rtc });
    start(d, () => [c.id]);
    expect(await c.link!.send(d.id, 'never')).toBe(false);
    expect(always.made.n).toBe(2);
    expect(c.logs.filter((l) => /calling once more/.test(l))).toHaveLength(1);
    expect(c.logs.some((l) => /no link to .* opened \(connection failed\) — relay only for this device/.test(l))).toBe(true);
    expect(c.link!.status().backoff.map((x) => x.id)).toEqual([d.id]);
    expect(d.got).toEqual([]);
  });

  it('refuses an envelope over maxMessageBytes (the caller uses the relay)', async () => {
    const { a, b } = pairUp({ maxMessageBytes: 1000 });
    expect(await a.link!.send(b.id, 'small')).toBe(true);
    expect(await a.link!.send(b.id, 'y'.repeat(2000))).toBe(false);
  });

  it('closes an idle link; whenDown resolves', async () => {
    const { a, b } = pairUp({ idleTimeoutMs: 300 });
    expect(await a.link!.send(b.id, 'one')).toBe(true);
    await a.link!.whenDown(b.id);
    expect(a.link!.isOpen(b.id)).toBe(false);
    expect(a.logs.some((l) => /closed \(idle\)/.test(l))).toBe(true);
    await until(() => !b.link!.isOpen(a.id));
    expect(await a.link!.whenDown(b.id)).toBeUndefined(); // no link: resolves at once
  });

  it('both calling at once ends with one working link', async () => {
    const { a, b } = pairUp();
    const [x, y] = await Promise.all([a.link!.send(b.id, 'from a'), b.link!.send(a.id, 'from b')]);
    expect([x, y]).toEqual([true, true]);
    await until(() => a.got.length === 1 && b.got.length === 1);
    expect(a.link!.status().links).toHaveLength(1);
    expect(b.link!.status().links).toHaveLength(1);
  });

  it('a restarted peer calls again and replaces the old link', async () => {
    const { a, b } = pairUp();
    expect(await a.link!.send(b.id, 'one')).toBe(true);
    await until(() => b.got.length === 1);
    b.link!.close();
    await a.link!.whenDown(b.id);
    const b2 = { ...b, got: [] as string[], logs: [] as string[] };
    start(b2, () => [a.id]);
    expect(await b2.link!.send(a.id, 'after restart')).toBe(true);
    await until(() => a.got.includes('after restart'));
  });

  it('close() hangs up every link BEFORE it returns: a daemon that exits right after stopping is noticed by the other side at once, not after ~30 s (seen on Windows, ADR-080 #37)', async () => {
    // count the native close() calls on a's side
    const closedNow: string[] = [];
    const counting: RtcModule = {
      PeerConnection: class {
        constructor(name: string, config: { iceServers: string[] }) {
          const pc = new ndc!.PeerConnection(name, config);
          return new Proxy(pc, {
            get(target, key) {
              if (key === 'close')
                return () => {
                  closedNow.push(name);
                  target.close();
                };
              const v = (target as unknown as Record<string | symbol, unknown>)[key];
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          });
        }
      } as unknown as RtcModule['PeerConnection'],
    };
    const { a, b } = pairUp({ rtc: counting });
    expect(await a.link!.send(b.id, 'one')).toBe(true);
    await until(() => b.link!.isOpen(a.id));
    const down = b.link!.whenDown(a.id);
    a.link!.close();
    // no setImmediate / timer in between: the process may exit on the next line (the orderly stop does)
    expect(closedNow).toHaveLength(1);
    const t0 = Date.now();
    await down;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(b.logs.join('\n')).toMatch(/closed by the other side|connection (closed|disconnected)/);
  });

  it('peer drop is noticed: whenDown resolves when the other side closes', async () => {
    const { a, b } = pairUp();
    expect(await a.link!.send(b.id, 'one')).toBe(true);
    await until(() => b.link!.isOpen(a.id));
    const down = a.link!.whenDown(b.id);
    b.link!.drop(a.id, 'test');
    await down;
    expect(a.link!.isOpen(b.id)).toBe(false);
  });
});

withRtc('direct links refuse what they should (ADR-069 security)', () => {
  it('a device that is not a contact there gets no link: timeout, then backoff (no second wait)', async () => {
    const a = node();
    const b = node();
    start(a, () => [b.id], { connectTimeoutMs: 600 });
    start(b, () => []); // b does not know a
    const t0 = Date.now();
    expect(await a.link!.send(b.id, 'hi')).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(b.logs.some((l) => /not a contact or paired device/.test(l))).toBe(true);
    const t1 = Date.now();
    expect(await a.link!.send(b.id, 'hi')).toBe(false);
    expect(Date.now() - t1).toBeLessThan(100);
    expect(a.link!.status().backoff.map((x) => x.id)).toEqual([b.id]);
    expect(a.logs.some((l) => /relay only for this device for 5 min/.test(l))).toBe(true);
  });

  it('we never call a device that is not a contact here', async () => {
    const a = node();
    const b = node();
    start(a, () => []);
    start(b, () => [a.id]);
    expect(await a.link!.send(b.id, 'hi')).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('drops a signal whose envelope sender is not the channel sender (relay forging a sender)', async () => {
    const { a, b } = pairUp({ connectTimeoutMs: 600 });
    tap = (from, _to, blob) => (from === a.id ? blob.replace(/"from":"[^"]+"/, `"from":"${b.id}"`) : blob);
    expect(await a.link!.send(b.id, 'hi')).toBe(false);
    expect(b.logs.some((l) => /envelope sender differs/.test(l))).toBe(true);
  });

  it('drops a tampered signal (does not verify)', async () => {
    const { a, b } = pairUp({ connectTimeoutMs: 600 });
    tap = (from, _to, blob) => {
      if (from !== a.id) return blob;
      const env = JSON.parse(blob) as { ct: string };
      const ct = Buffer.from(env.ct, 'base64');
      ct[0]! ^= 1;
      return JSON.stringify({ ...env, ct: ct.toString('base64') });
    };
    expect(await a.link!.send(b.id, 'hi')).toBe(false);
    expect(b.logs.some((l) => /does not verify/.test(l))).toBe(true);
  });

  it('drops a replayed signal and a stale one', async () => {
    const { a, b } = pairUp();
    expect(await a.link!.send(b.id, 'hi')).toBe(true);
    const offer = captured.find((s) => s.from === a.id)!;
    b.link!.onSignal(a.id, offer.blob);
    await until(() => b.logs.some((l) => /replayed/.test(l)));
    // a correctly sealed signal from a, but two minutes old
    const old = seal({
      identity: a.identity,
      recipientId: b.id,
      recipientEncPub: verifyKeyBundle(b.bundle, b.id),
      plaintext: Buffer.from(JSON.stringify({ t: 'morse-direct-v1', type: 'candidate', session: 'ab'.repeat(16), ts: Date.now() - 180_000, candidate: 'a=candidate:1 1 UDP 1 127.0.0.1 9 typ host', mid: '0' })),
    });
    b.link!.onSignal(a.id, JSON.stringify(old));
    await until(() => b.logs.some((l) => /stale/.test(l)));
    b.link!.onSignal(a.id, 'not json');
    await until(() => b.logs.some((l) => /not an envelope/.test(l)));
    expect(b.got).toEqual(['hi']); // the link itself is unaffected
  });

  it('closes a link whose DTLS certificate is not the one the signed SDP named', async () => {
    // a lying WebRTC stack on b's side: reports a different remote fingerprint
    const liar: RtcModule = {
      PeerConnection: class {
        constructor(name: string, cfg: { iceServers: string[] }) {
          const pc = new ndc!.PeerConnection(name, cfg) as RtcPeer;
          return new Proxy(pc, {
            get(target, prop) {
              if (prop === 'remoteFingerprint') return () => ({ algorithm: 'sha-256', value: '00:11' });
              const v = Reflect.get(target, prop) as unknown;
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          });
        }
      } as unknown as RtcModule['PeerConnection'],
    };
    const { a, b } = pairUp({ rtc: liar, connectTimeoutMs: 1500 });
    expect(await a.link!.send(b.id, 'hi')).toBe(false);
    expect(a.logs.some((l) => /DTLS fingerprint does not match/.test(l))).toBe(true);
    expect(b.got).toEqual([]);
  });

  it('an old relay ("unknown request"): no direct attempts for a while, until signaling is reset', async () => {
    const a = node();
    const b = node();
    let calls = 0;
    const link = startDirect({
      identity: a.identity,
      enc: a.enc,
      recipientKey: async (id) => verifyKeyBundle(bundles.get(id)!, id),
      isPeer: () => true,
      signal: {
        send: async () => {
          calls++;
          throw new Error('relay: unknown request');
        },
      },
      onMessage: () => undefined,
      log: (l) => a.logs.push(l),
      stun: [],
      rtc: ndc,
    });
    links.push(link);
    expect(await link.send(b.id, 'x')).toBe(false);
    expect(a.logs.some((l) => /does not forward signaling/.test(l))).toBe(true);
    expect(link.status().noSignalUntil).toBeGreaterThan(Date.now());
    const before = calls;
    expect(await link.send(b.id, 'x')).toBe(false);
    expect(calls).toBe(before);
    link.resetSignaling();
    expect(link.status().noSignalUntil).toBeUndefined();
    await sleep(10);
  });

  it('the peer is offline on the signal channel: gives up at once, no backoff', async () => {
    const a = node();
    const b = node();
    start(a, () => [b.id]);
    // b never registered on the bus → 'offline'
    const t0 = Date.now();
    expect(await a.link!.send(b.id, 'x')).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(a.link!.status().backoff).toEqual([]);
  });
});

describe('direct settings and status line', () => {
  it('directSettings: on by default; morse.direct.enabled false or MORSE_DIRECT=0 turns it off; stun from config', async () => {
    const { directSettings } = await import('../src/cluster/direct.js');
    expect(directSettings(undefined, {})).toEqual({});
    expect(directSettings({ direct: { enabled: true } }, {})).toEqual({});
    expect(directSettings({ direct: { enabled: false } }, {})).toBe(false);
    expect(directSettings({ direct: false }, {})).toBe(false);
    expect(directSettings(undefined, { MORSE_DIRECT: '0' })).toBe(false);
    expect(directSettings(undefined, { MORSE_DIRECT: 'off' })).toBe(false);
    expect(directSettings({ direct: { stun: ['stun:example.org:3478', 42] } }, {})).toEqual({ stun: ['stun:example.org:3478'] });
  });

  it('describeDirectStatus: one line for morse status', async () => {
    const { describeDirectStatus } = await import('../src/format.js');
    expect(describeDirectStatus(undefined)).toBe('direct: off (morse.direct.enabled = false, or MORSE_DIRECT=0)');
    expect(describeDirectStatus({ enabled: false, reason: 'node-datachannel is not installed', links: [], backoff: [] })).toBe(
      'direct: off — node-datachannel is not installed (relay only)',
    );
    expect(describeDirectStatus({ enabled: true, links: [], backoff: [] })).toBe('direct: on — no link open (opened on demand, relay as fallback)');
    expect(
      describeDirectStatus({
        enabled: true,
        links: [
          { id: 'ABCDEFG-XXXX', state: 'open', role: 'offer', since: 0, lastUsed: 0, path: 'host↔srflx' },
          { id: 'HIJKLMN-XXXX', state: 'connecting', role: 'answer', since: 0, lastUsed: 0 },
        ],
        backoff: [{ id: 'OPQRSTU-XXXX', until: Date.now() + 60_000 }],
        noSignalUntil: Date.now() + 1000,
      }),
    ).toBe('direct: on — 1 link(s) open: ABCDEFG (host↔srflx) · connecting: HIJKLMN · relay only for now: OPQRSTU · the relay does not forward signaling (old relay)');
  });
});
