import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import {
  chunkCount,
  chunkRateFor,
  chunkSizeFor,
  createIncomingStore,
  decodeChunk,
  encodeChunk,
  fileLimitsFrom,
  fromRanges,
  listIncoming,
  manifestFor,
  manifestProblem,
  OutboundTransfer,
  readChunk,
  Throttle,
  toRanges,
  TransferStop,
  type ChunkHeader,
  type TransferAnswer,
  type TransferIO,
} from '../src/cluster/chunks.js';
import { loadOrCreateEncKey, seal } from '../src/cluster/e2e.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { startAddressLan } from '../src/cluster/lan-address.js';
import { loadPrimaryAddress } from '../src/identity/address-key.js';
import { sealV3 } from '../src/identity/envelope.js';
import { INBOX_AGENT, safeFileName, stageOutboxFiles, startMorse, type Morse, type MorseSendResult } from '../src/cluster/morse.js';
import { startRelayClient } from '../src/cluster/relay-client.js';
import { acceptRequest, formatRequests } from '../src/cluster/requests.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { dispatchOnce } from '../src/daemon/dispatcher.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox, type Message } from '../src/mailbox/mailbox.js';

/**
 * ADR-038: large files in chunks — framing, the recipient's staging store, the
 * sender's transfer loop, and whole transfers through a real (Node) relay and the LAN:
 * out-of-order / duplicate / lost chunks, resume after a restart (either side),
 * rate limits, size limits, message requests (no chunks until accepted, files sent
 * again after), staging clean-up.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-chunks-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const writeRandom = (dir: string, name: string, size: number) => {
  const p = join(dir, name);
  const data = randomBytes(size);
  writeFileSync(p, data);
  return { path: p, data };
};

// --- framing, ranges, sizes ----------------------------------------------------------------

describe('chunk framing and sizes', () => {
  it('a chunk frame round-trips (raw bytes, no base64 inside); a JSON plaintext is not a chunk', () => {
    const data = randomBytes(1000);
    const h: ChunkHeader = { kind: 'chunk', id: 'm-1', f: 1, seq: 7, n: 9, sha256: 'a'.repeat(64) };
    const frame = encodeChunk(h, data);
    expect(frame.length).toBeLessThan(data.length + 200);
    const back = decodeChunk(frame)!;
    expect(back.header).toEqual(h);
    expect(back.data.equals(data)).toBe(true);
    expect(decodeChunk(Buffer.from(JSON.stringify({ kind: 'message' })))).toBeNull();
    expect(() => decodeChunk(Buffer.from('MORSE-CHUNK-1\n{"kind":"chunk"}\nxx'))).toThrow(/malformed/);
  });

  it('ranges round-trip; chunk counts; 512 KiB chunks on the Cloudflare relay and the sealed chunk fits its 1,000,000-byte cap', () => {
    const bits = fromRanges([[0, 2], [5, 5], [7, 9]], 12);
    expect(toRanges(bits, 12)).toEqual([[0, 2], [5, 5], [7, 9]]);
    expect(toRanges(fromRanges('junk', 4), 4)).toEqual([]);
    expect(chunkCount(0, 1024)).toBe(1);
    expect(chunkCount(1024, 1024)).toBe(1);
    expect(chunkCount(1025, 1024)).toBe(2);
    expect(chunkSizeFor(1_000_000)).toBe(512 * 1024);
    expect(chunkSizeFor(2 * 1024 * 1024)).toBe(512 * 1024);
    expect(chunkSizeFor(64 * 1024)).toBe(34 * 1024);
    // a full 512 KiB chunk, sealed for real: well under the Cloudflare envelope cap
    const a = freshHome();
    const b = freshHome();
    const ida = loadOrCreateIdentity(a);
    const idb = loadOrCreateIdentity(b);
    const frame = encodeChunk({ kind: 'chunk', id: 'x'.repeat(36), f: 63, seq: 199, n: 200, sha256: 'f'.repeat(64) }, randomBytes(512 * 1024));
    const env = seal({ identity: ida, recipientId: idb.id, recipientEncPub: loadOrCreateEncKey(b).publicDer, plaintext: frame });
    const blob = JSON.stringify(env);
    expect(blob.length).toBeLessThan(720_000);
    expect(blob.length).toBeLessThan(1_000_000);
    expect(chunkRateFor(120)).toBe(100);
    expect(fileLimitsFrom(undefined)).toEqual({ maxFileBytes: 100 * 1024 * 1024, maxStagingBytes: 1024 * 1024 * 1024 });
    expect(fileLimitsFrom({ maxFileBytes: 5000 })).toEqual({ maxFileBytes: 5000, maxStagingBytes: 1024 * 1024 * 1024 });
  });

  it('manifests are checked: sizes, checksums, chunk counts, the size limit', () => {
    const ok = manifestFor([{ name: 'a.bin', size: 5000, sha256: 'a'.repeat(64) }], 1024);
    expect(ok.files[0]!.chunks).toBe(5);
    expect(manifestProblem(ok, 10_000)).toBeNull();
    expect(manifestProblem(ok, 4000)).toMatch(/too large.*morse\.maxFileBytes/);
    expect(manifestProblem({ ...ok, files: [{ ...ok.files[0]!, chunks: 4 }] }, 10_000)).toMatch(/chunk count/);
    expect(manifestProblem({ ...ok, files: [{ ...ok.files[0]!, sha256: 'xyz' }] }, 10_000)).toMatch(/checksum/);
    expect(manifestProblem({ chunkSize: 10, files: [] }, 10_000)).toMatch(/chunk size/);
    const two = manifestFor([{ name: 'a', size: 6000, sha256: 'a'.repeat(64) }, { name: 'b', size: 6000, sha256: 'b'.repeat(64) }], 1024);
    expect(manifestProblem(two, 10_000)).toMatch(/attachments too large: 12000 bytes in one message/);
  });

  it('sending: over the limit fails at once (each file, and all files of a message together)', () => {
    const home = freshHome();
    const small = writeRandom(home, 'small.bin', 3000);
    const big = writeRandom(home, 'big.bin', 6000);
    expect(() => stageOutboxFiles([big.path], home, 5000)).toThrow(/file too large: big\.bin is 6000 bytes .*morse\.maxFileBytes/);
    expect(() => stageOutboxFiles([small.path, small.path], home, 5000)).toThrow(/attachments too large: 6000 bytes .* in one message/);
    const staged = stageOutboxFiles([small.path, small.path], home, 10_000);
    expect(staged.map((f) => f.name)).toEqual(['small.bin', 'small.bin']);
    expect(new Set(staged.map((f) => f.path)).size).toBe(2); // same name twice: both kept
    expect(staged[0]!.sha256).toBe(sha(small.data));
    expect(statSync(staged[0]!.path).mode & 0o777).toBe(0o600);
  });
});

// --- recipient staging -----------------------------------------------------------------------

describe('recipient staging (incoming chunks)', () => {
  const sender = { id: 'SENDER-1', name: 'bob' };
  const setup = (opts: Parameters<typeof createIncomingStore>[0] = {}) => {
    const home = freshHome();
    const a = randomBytes(10_000);
    const b = randomBytes(2500);
    const manifest = manifestFor(
      [
        { name: 'a.bin', size: a.length, sha256: sha(a) },
        { name: '../b.bin', size: b.length, sha256: sha(b) },
      ],
      1024,
    );
    const chunksOf = (data: Buffer, f: number): Array<[ChunkHeader, Buffer]> =>
      Array.from({ length: manifest.files[f]!.chunks }, (_, seq) => [
        { kind: 'chunk', id: 'm-1', f, seq, n: manifest.files[f]!.chunks, sha256: manifest.files[f]!.sha256 },
        data.subarray(seq * 1024, seq * 1024 + 1024),
      ]);
    return { home, a, b, manifest, all: [...chunksOf(a, 0), ...chunksOf(b, 1)], store: createIncomingStore({ home, ...opts }) };
  };

  it('out of order and duplicated chunks: complete once each is in; SHA-256 checked; files 0600 in a 0700 dir; staging gone after', async () => {
    const { home, a, b, all, manifest, store } = setup();
    const r = store.begin(sender, 'm-1', { text: 'hi' }, manifest, 'morse-relay');
    expect(r).toMatchObject({ ok: true, resumed: false, complete: false });
    const shuffled = [...all].sort(() => Math.random() - 0.5);
    let last;
    for (const [h, d] of shuffled) {
      last = store.put(sender.id, h, d);
      expect(last.ok).toBe(true);
      const dup = store.put(sender.id, h, d); // a duplicate changes nothing
      expect(dup).toMatchObject({ ok: true, added: false });
    }
    expect(last).toMatchObject({ ok: true, complete: true, held: 13, total: 13 });
    expect(listIncoming(home)).toEqual([expect.objectContaining({ senderName: 'bob', msgId: 'm-1', held: 13, total: 13 })]);
    const dest = join(home, 'out', 'm-1');
    const files = await store.assemble(sender.id, 'm-1', dest, safeFileName);
    expect(files.map((f) => f.name)).toEqual(['a.bin', 'b.bin']);
    expect(readFileSync(files[0]!.path).equals(a)).toBe(true);
    expect(readFileSync(files[1]!.path).equals(b)).toBe(true);
    expect(statSync(files[0]!.path).mode & 0o777).toBe(0o600);
    expect(statSync(dest).mode & 0o777).toBe(0o700);
    store.remove(sender.id, 'm-1');
    expect(store.list()).toEqual([]);
    expect(readdirSync(store.dir)).toEqual([]);
  });

  it('a chunk that does not match the manifest is refused; a corrupted file loses all its chunks (sent again)', async () => {
    const { all, manifest, store } = setup();
    store.begin(sender, 'm-1', {}, manifest, 'morse-relay');
    expect(store.put(sender.id, { ...all[0]![0], sha256: 'b'.repeat(64) }, all[0]![1])).toMatchObject({ ok: false, error: /does not match/ });
    expect(store.put(sender.id, all[0]![0], Buffer.alloc(10))).toMatchObject({ ok: false, error: /wrong length/ });
    expect(store.put(sender.id, { ...all[0]![0], id: 'nope' }, all[0]![1])).toMatchObject({ ok: false, unknown: true });
    // chunk 3 of a.bin arrives with the right length but wrong bytes (a disk hiccup, say)
    for (const [h, d] of all) store.put(sender.id, h, h.f === 0 && h.seq === 3 ? randomBytes(d.length) : d);
    await expect(store.assemble(sender.id, 'm-1', join(store.dir, '..', 'x'), safeFileName)).rejects.toThrow(/checksum mismatch: a\.bin/);
    expect(store.have(sender.id, 'm-1')).toEqual([[], [[0, 2]]]); // a.bin from scratch, b.bin kept
  });

  it('resume: a new store on the same disk (daemon restart) knows which chunks it holds', () => {
    const { home, all, manifest, store } = setup();
    store.begin(sender, 'm-1', {}, manifest, 'morse-relay');
    for (const [h, d] of all.slice(0, 6)) store.put(sender.id, h, d);
    const again = createIncomingStore({ home });
    const r = again.begin(sender, 'm-1', {}, manifest, 'morse-lan');
    expect(r).toMatchObject({ ok: true, resumed: true, complete: false, have: [[[0, 5]], []] });
    expect(again.meta(sender.id, 'm-1')?.via).toBe('morse-lan');
  });

  it('staging is capped (busy) and cleaned after 24 h without progress; the size limit applies', () => {
    let t = 1_000_000;
    const { manifest, store, all } = setup({ now: () => t, maxStagingBytes: () => 20_000 });
    expect(store.begin(sender, 'm-1', {}, manifest, 'morse-relay')).toMatchObject({ ok: true });
    expect(store.begin({ id: 'OTHER', name: 'carol' }, 'm-2', {}, manifest, 'morse-relay')).toMatchObject({ ok: false, busy: true, error: /staging full/ });
    store.put(sender.id, all[0]![0], all[0]![1]);
    t += 23 * 3600_000;
    expect(store.cleanup()).toBe(0);
    store.put(sender.id, all[1]![0], all[1]![1]); // progress resets the clock
    t += 23 * 3600_000;
    expect(store.cleanup()).toBe(0);
    t += 2 * 3600_000;
    expect(store.cleanup()).toBe(1);
    expect(store.list()).toEqual([]);
    const tight = createIncomingStore({ home: freshHome(), maxFileBytes: () => 5000 });
    expect(tight.begin(sender, 'm-3', {}, manifest, 'morse-relay')).toMatchObject({ ok: false, error: /too large/ });
  });
});

// --- sender loop with a fake link ------------------------------------------------------------

describe('sender transfer loop', () => {
  const plan = (size: number, cs = 1024) => {
    const home = freshHome();
    const f = writeRandom(home, 'f.bin', size);
    return { f, manifest: manifestFor([{ name: 'f.bin', size, sha256: sha(f.data) }], cs), home };
  };

  it('lost chunks are sent again (only those); acknowledgements out of order do not go backwards', async () => {
    const { f, manifest, home } = plan(20 * 1024);
    const store = createIncomingStore({ home });
    const who = { id: 'S', name: 's' };
    const lost = new Set([3, 11, 19]);
    const sentSeqs: number[] = [];
    const io: TransferIO = {
      offer: async () => {
        const r = store.begin(who, 'm', {}, manifest, 'morse-lan');
        return r.ok ? { have: r.have } : { error: r.error };
      },
      send: async (h, data) => {
        sentSeqs.push(h.seq);
        if (lost.delete(h.seq)) return undefined; // vanished on the way: no answer
        const r = store.put(who.id, h, data);
        if (!r.ok) return undefined;
        return r.complete ? { complete: true } : { have: r.have };
      },
      throttle: async () => undefined,
    };
    const tr = new OutboundTransfer({ msgId: 'm', deviceId: 'D', label: 'x', manifest, paths: [f.path] });
    expect(await tr.run(io, { ackIdleMs: 50, window: 8, concurrency: 3 })).toBe('done');
    expect(sentSeqs.length).toBe(23); // 20 + the 3 lost ones once more
    expect(sentSeqs.filter((s) => s === 11).length).toBe(2);
    expect(tr.progress()).toMatchObject({ state: 'done', acked: 20, total: 20, sent: 23 });
  });

  it('final answers: request (no chunks), legacy receiver, refusal, busy, offline', async () => {
    const { f, manifest } = plan(5000);
    const mk = () => new OutboundTransfer({ msgId: 'm', deviceId: 'D', label: 'bob', manifest, paths: [f.path] });
    const io = (first: TransferAnswer | null, send: TransferIO['send'] = async () => undefined): TransferIO => ({ offer: async () => first, send, throttle: async () => undefined });
    let sent = 0;
    const count: TransferIO['send'] = async () => {
      sent++;
    };
    expect(await mk().run(io({ request: 'filed' }, count))).toBe('request');
    expect(await mk().run(io({ request: 'dropped' }, count))).toBe('held');
    expect(sent).toBe(0);
    const legacy = mk();
    expect(await legacy.run(io({ legacy: true }))).toBe('failed');
    expect(legacy.error).toMatch(/older Morse .* WITHOUT the attachments/);
    const refused = mk();
    expect(await refused.run(io({ error: 'file too large' }))).toBe('failed');
    expect(refused.error).toMatch(/refused the files: file too large/);
    expect(await mk().run(io({ busy: true }))).toBe('waiting');
    const off = mk();
    expect(await off.run({ offer: async () => Promise.reject(new TransferStop('offline', 'bob is offline')), send: async () => undefined, throttle: async () => undefined })).toBe('waiting');
    expect(off.error).toBe('bob is offline');
    const quiet = mk();
    expect(await quiet.run(io(null), { maxIdleRounds: 2 })).toBe('waiting');
    expect(quiet.error).toMatch(/did not answer/);
  });

  it('throttle: at most N envelopes a minute after the first burst (fake clock)', async () => {
    let t = 0;
    const th = new Throttle(() => 10, { now: () => t, sleep: async (ms) => void (t += ms) });
    for (let i = 0; i < 25; i++) await th.take();
    // 10 at once, then one every 6 s: 15 more → 90 s
    expect(t).toBeGreaterThanOrEqual(89_000);
    expect(t).toBeLessThanOrEqual(91_000);
  });

  it('readChunk reads the right slice; a short file is an error', () => {
    const { f } = plan(3000);
    expect(readChunk(f.path, 3000, 1024, 2).equals(f.data.subarray(2048))).toBe(true);
    expect(() => readChunk(f.path, 5000, 1024, 3)).toThrow(/shorter than expected/);
  });
});

// --- whole transfers through a real relay ----------------------------------------------------

interface Dev {
  home: string;
  id: string;
  /** (ADR-091) the computer's first address — what everything goes by */
  address: string;
  mailbox: Mailbox;
  morse?: Morse;
  logs: string[];
}
const dev = (): Dev => {
  const home = freshHome();
  return { home, id: loadOrCreateIdentity(home).id, address: loadPrimaryAddress(home).address, mailbox: createMailbox(createDb(':memory:')), logs: [] };
};
/** (ADR-091) the two of a world, by address: `bob` and `alice` stand for b's and a's addresses */
let bob = '';
let alice = '';

let relay: FakeRelay | null = null;
const running: Morse[] = [];
const lanStops: Array<() => Promise<void>> = [];
afterEach(async () => {
  running.splice(0).forEach((m) => m.stop());
  await Promise.all(lanStops.splice(0).map((stop) => stop()));
  await relay?.close();
  relay = null;
});
const url = () => `ws://127.0.0.1:${relay!.port}`;
/** Small envelopes (64 KB) → ~34 KB chunks, so a few MB is ~100 chunks. */
const MAX_BLOB = 64 * 1024;
const FAST = { ackIdleMs: 400, completeWaitMs: 3000, maxIdleRounds: 3 };
const connect = (d: Dev, extra: Partial<Parameters<typeof startMorse>[0]> = {}) => {
  d.morse = startMorse({
    url: url(),
    home: d.home,
    mailbox: d.mailbox,
    receiptTimeoutMs: 2000,
    connectWaitMs: 300,
    chunkRatePerMinute: 100_000,
    rateBackoffMs: 50,
    transferTuning: FAST,
    log: (l) => d.logs.push(l),
    ...extra,
  });
  running.push(d.morse);
  return d.morse;
};
const online = async (...ds: Dev[]) => until(() => ds.every((d) => Boolean(d.morse!.v3Client?.()?.connected())));
const world = async (relayOpts: { ratePerMinute?: number } = {}) => {
  const [a, b] = [dev(), dev()];
  bob = b.address;
  alice = a.address;
  relay = await startFakeRelay({
    port: 0,
    host: '127.0.0.1',
    v3: true,
    maxBlobBytes: MAX_BLOB,
    ratePerMinute: relayOpts.ratePerMinute ?? 100_000,
    log: () => undefined,
  });
  return { a, b };
};
/** (ADR-091) each is the other's contact, by address */
const pair = (a: Dev, b: Dev) => {
  a.mailbox.contacts.ensureAddress(b.address);
  b.mailbox.contacts.ensureAddress(a.address);
};
const withFile = (a: Dev, text: string, size: number, to: Message['to'] = { agent: 'codex', sessionId: 'b-1', device: bob }) => {
  const src = writeRandom(a.home, `src-${size}.bin`, size);
  const files = stageOutboxFiles([src.path], a.home);
  return { data: src.data, m: a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to, text, files }) };
};
/** What the outbox does: call send until it is not "waiting" any more (or the deadline). */
const deliver = async (d: Dev, to: string, id: string, ms = 20_000): Promise<MorseSendResult> => {
  const end = Date.now() + ms;
  for (;;) {
    const r = await d.morse!.send(to, d.mailbox.getMessage(id)!);
    if (!r.waiting || Date.now() > end) return r;
    await until(() => d.morse!.transfer(id)?.state !== 'sending', Math.max(100, end - Date.now())).catch(() => undefined);
    await sleep(20);
  }
};
const filesOf = (d: Dev) => d.mailbox.inbox({ all: true }).flatMap((m) => m.parts.flatMap((p) => p.files ?? []));

describe('large files through the relay (ADR-038)', () => {
  it('3 MB arrives byte-identical as ONE message (text + file together), only after every chunk; the sender gets the receipt', async () => {
    const { a, b } = await world();
    pair(a, b);
    connect(a);
    connect(b);
    await online(a, b);
    const { data, m } = withFile(a, 'the big one', 3 * 1024 * 1024);
    const first = await a.morse!.send(bob, m);
    expect(first).toMatchObject({ ok: false, waiting: true });
    expect(first.error).toMatch(/sending to morse\.im\/\w{26} — 1 file\(s\), 3\.0 MB: 0\/\d+ chunks confirmed/);
    // mid-way: nothing in bob's inbox yet, but "receiving x/y"
    await until(() => (b.morse!.incoming()[0]?.held ?? 0) > 0);
    const mid = b.morse!.incoming()[0]!;
    expect(mid.held).toBeLessThan(mid.total);
    expect(b.mailbox.inbox({ all: true })).toEqual([]);
    expect(await deliver(a, bob, m.id)).toEqual({ ok: true, via: 'relay' });
    expect(a.mailbox.getMessage(m.id)?.receiptAt).toBeTypeOf('number');
    const got = b.mailbox.inbox({ all: true });
    expect(got).toHaveLength(1);
    expect(got[0]!.parts[0]!.text).toMatch(/^the big one\n\n\[attachments saved to your inbox — not executed, not opened\]/);
    const f = got[0]!.parts[0]!.files![0]!;
    expect(readFileSync(f.path).equals(data)).toBe(true);
    expect(f.size).toBe(data.length);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(f.path.startsWith(join(b.home, '.morse', 'inbox-files'))).toBe(true);
    expect(b.morse!.incoming()).toEqual([]); // staging cleared
    expect(a.logs.some((l) => /delivered via relay — (\d+)\/\1 chunks, 3\.0 MB, SHA-256 checked/.test(l))).toBe(true);
    expect(b.logs.some((l) => /receiving .* from @\w{26} — 1 file\(s\), 3\.0 MB in \d+ chunks/.test(l))).toBe(true);
    // a late resend of the whole message is a duplicate: no second copy
    a.morse!.stop();
    const again = connect(a);
    await online(a);
    expect(await again.send(bob, { ...a.mailbox.getMessage(m.id)!, receiptAt: undefined } as Message)).toMatchObject({ waiting: true });
    await until(() => a.morse!.transfer(m.id)?.state === 'done');
    expect(b.mailbox.inbox({ all: true })).toHaveLength(1);
  });

  it('lost chunks (relay hiccup) are sent again, only those; the recipient restarts mid-way and the transfer resumes', async () => {
    const { a, b } = await world();
    pair(a, b);
    let n = 0;
    const lost: number[] = [];
    connect(a, {
      client: (o) => {
        const real = startRelayClient(o);
        return {
          ...real,
          url: real.url,
          // pretend the 5th and 9th chunk envelopes went out — they never reach bob (ADR-091: over the v3 connection)
          sendV3: async (to: string, blob: string, o2?: { ref?: string; store?: boolean; from?: string }) => {
            n++;
            if ((n === 6 || n === 10) && blob.length > 20_000) {
              lost.push(n);
              return { r: 'sent' as const };
            }
            return real.sendV3!(to, blob, o2);
          },
        };
      },
    });
    connect(b);
    await online(a, b);
    const { data, m } = withFile(a, 'resume me', 3 * 1024 * 1024);
    expect(await a.morse!.send(bob, m)).toMatchObject({ waiting: true });
    // bob's daemon goes away a third of the way in
    await until(() => (b.morse!.incoming()[0]?.held ?? 0) >= 30);
    b.morse!.stop();
    const heldAtStop = listIncoming(b.home)[0]!.held;
    await until(() => a.morse!.transfer(m.id)?.state === 'waiting');
    expect(a.morse!.transfer(m.id)!.error).toMatch(/offline|closed|not connected/);
    // back (same disk, same mailbox): the outbox tries again and only the missing chunks go
    connect(b);
    await online(b);
    expect(await deliver(a, bob, m.id)).toMatchObject({ ok: true });
    const total = a.morse!.transfer(m.id)?.total ?? 0;
    expect(lost).toHaveLength(2);
    const f = filesOf(b)[0]!;
    expect(readFileSync(f.path).equals(data)).toBe(true);
    expect(heldAtStop).toBeGreaterThanOrEqual(30);
    // resumed, not restarted: far fewer than two full rounds of chunk envelopes
    const sent = n;
    expect(total === 0 || sent < 2 * total).toBe(true);
    expect(b.logs.filter((l) => /receiving .* from @\w{26}/.test(l))).toHaveLength(1); // one "receiving" line: the second run resumed
  });

  it('the sender restarts mid-way: the new daemon asks what bob holds and sends only the rest', async () => {
    const { a, b } = await world();
    pair(a, b);
    connect(a);
    connect(b);
    await online(a, b);
    const { data, m } = withFile(a, 'sender restart', 3 * 1024 * 1024);
    await a.morse!.send(bob, m);
    await until(() => (b.morse!.incoming()[0]?.held ?? 0) >= 40);
    a.morse!.stop();
    const before = b.morse!.incoming()[0]!.held;
    const a2 = connect(a);
    await online(a);
    expect(await deliver(a, bob, m.id)).toMatchObject({ ok: true });
    expect(readFileSync(filesOf(b)[0]!.path).equals(data)).toBe(true);
    const sentSecondRun = a2.transfer(m.id)?.sent ?? Number(/(\d+) chunk envelope\(s\) sent/.exec(a.logs.filter((l) => /delivered via relay/.test(l)).pop() ?? '')?.[1]);
    const total = Math.ceil((3 * 1024 * 1024) / chunkSizeFor(MAX_BLOB));
    expect(sentSecondRun).toBeLessThanOrEqual(total - before + 30); // the rest, plus at most what was in flight
  });

  it('rate limits: the relay saying "rate limited" only slows it down; chunks do not count against the recipient\'s per-sender message limit', async () => {
    const { a, b } = await world();
    pair(a, b);
    let n = 0;
    connect(a, {
      client: (o) => {
        const real = startRelayClient(o);
        return {
          ...real,
          url: real.url,
          send: async (to, blob) => {
            if (++n % 4 === 0) throw new Error('relay: rate limited (max 120/min)');
            return real.send(to, blob);
          },
        };
      },
    });
    connect(b, { receiveLimits: () => ({ perSenderPerMinute: 2, totalPerMinute: 3 }) });
    await online(a, b);
    const { data, m } = withFile(a, 'under limits', 2 * 1024 * 1024);
    expect(await deliver(a, bob, m.id)).toMatchObject({ ok: true });
    expect(readFileSync(filesOf(b)[0]!.path).equals(data)).toBe(true);
    expect(b.logs.some((l) => /rate limit/.test(l))).toBe(false);
    // the throttle keeps chunks under the relay's per-device rate (5/6 of it) — see the unit test above
  });

  it('too large for the recipient: refused, the sender fails it (no endless retry)', async () => {
    const { a, b } = await world();
    pair(a, b);
    connect(a);
    connect(b, { fileLimits: () => ({ maxFileBytes: 1024 * 1024, maxStagingBytes: 1024 * 1024 * 1024 }) });
    await online(a, b);
    const { m } = withFile(a, 'too big for bob', 2 * 1024 * 1024);
    const r = await deliver(a, bob, m.id);
    expect(r).toMatchObject({ ok: false });
    expect(r.waiting).toBeUndefined();
    expect(r.error).toMatch(/refused the files: file too large/);
    expect(b.mailbox.inbox({ all: true })).toEqual([]);
    expect(b.morse!.incoming()).toEqual([]);
  });

  it('through the real outbox (dispatcher): queued → waiting while it sends → delivered as soon as the transfer ends', async () => {
    const { a, b } = await world();
    pair(a, b);
    connect(a);
    connect(b);
    await online(a, b);
    const { data, m } = withFile(a, 'via the dispatcher', 1024 * 1024);
    const events: string[] = [];
    const run = () =>
      dispatchOnce({ mailbox: a.mailbox, adapters: new Map(), directory: async () => [], selfDevice: 'alice-mini', relay: (device, msg) => a.morse!.send(device, msg), onEvent: (e) => events.push(e.kind) });
    expect(await run()).toBe(true);
    expect(a.mailbox.getMessage(m.id)).toMatchObject({ status: 'failed', waiting: true });
    expect(a.mailbox.getMessage(m.id)!.lastError).toMatch(/sending to morse\.im\/\w{26} — 1 file\(s\), 1\.0 MB/);
    await until(() => a.mailbox.getMessage(m.id)!.receiptAt !== undefined);
    // nudged: due right away, not after the 30 s retry interval
    expect(await run()).toBe(true);
    expect(a.mailbox.getMessage(m.id)?.status).toBe('delivered');
    expect(events).toEqual(['waiting', 'delivered']);
    expect(readFileSync(filesOf(b)[0]!.path).equals(data)).toBe(true);
  });

  it('small files still go inline, in one envelope (as before)', async () => {
    const { a, b } = await world();
    pair(a, b);
    connect(a);
    connect(b);
    await online(a, b);
    const { data, m } = withFile(a, 'tiny', 10_000);
    expect(await a.morse!.send(bob, m)).toEqual({ ok: true, via: 'relay' });
    expect(a.morse!.transfer(m.id)).toBeUndefined();
    expect(readFileSync(filesOf(b)[0]!.path).equals(data)).toBe(true);
  });
});

describe('large files and message requests (ADR-037 + ADR-038)', () => {
  it('a request takes no chunks — only names and sizes; after accept the sender sends the files again', async () => {
    const { a, b } = await world();
    connect(a);
    connect(b);
    await online(a, b);
    // (ADR-091: no names are registered with the relay — the addresses are all there is)
    // alice writes to bob (a stranger to him) with a 2 MB file
    const { data, m } = withFile(a, 'hello bob, here is the report', 2 * 1024 * 1024, { agent: INBOX_AGENT, sessionId: '', device: bob });
    expect(await deliver(a, bob, m.id)).toMatchObject({ ok: true, request: true });
    expect(a.mailbox.getMessage(m.id)?.request).toBe(true);
    expect(a.morse!.transfer(m.id)).toBeUndefined(); // finished and forgotten
    expect(a.logs.some((l) => /is in their message requests .* no files sent/.test(l))).toBe(true);
    const req = b.mailbox.requests.get(alice)!;
    expect(req).toMatchObject({ droppedFiles: 1, droppedFileList: [{ name: `src-${2 * 1024 * 1024}.bin`, size: 2 * 1024 * 1024 }] });
    expect(formatRequests([req]).join('\n')).toMatch(/1 attachment\(s\) not kept: src-2097152\.bin 2\.0 MB — sent after you accept/);
    // a chunk from someone whose message is only a request is dropped, never staged
    const chunk = encodeChunk({ kind: 'chunk', id: m.id, f: 0, seq: 0, n: 61, sha256: 'a'.repeat(64) }, randomBytes(1000));
    // (ADR-091: by address — signed by alice's address, sealed to bob's)
    const info = await a.morse!.v3Client!()!.lookupAddress!(b.address);
    const env = await sealV3({ from: loadPrimaryAddress(a.home), to: b.address, prekey: info.prekey!, body: chunk });
    expect((await a.morse!.v3Client!()!.sendV3!(b.address, JSON.stringify(env))).r).toBe('sent');
    await sleep(200);
    expect(existsSync(join(b.home, '.morse', 'incoming-chunks')) ? readdirSync(join(b.home, '.morse', 'incoming-chunks')) : []).toEqual([]);
    expect(b.mailbox.inbox({ all: true })).toEqual([]);
    // bob accepts; his daemon tells alice; alice's device queues the files again
    const r = acceptRequest(alice, { mailbox: b.mailbox, trust: createTrustStore(b.home), home: b.home });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.parts[0]!.text).toMatch(/1 attachment\(s\) not kept while this was a message request: src-2097152\.bin \(2\.0 MB\) — they send them again/);
    expect(await b.morse!.notifyAccepted(alice)).toBe(1);
    await until(() => a.logs.some((l) => /accepted your message request .*sending the files of 1 message\(s\) again/.test(l)));
    const resend = a.mailbox.inbox({ all: true }).find((x) => x.parts[0]!.text.includes(`of my earlier message ${m.id.slice(0, 8)}`))!;
    expect(resend).toBeDefined();
    expect(await deliver(a, bob, resend.id)).toMatchObject({ ok: true });
    const got = b.mailbox.inbox({ all: true }).find((x) => x.parts[0]!.files?.length)!;
    expect(readFileSync(got.parts[0]!.files![0]!.path).equals(data)).toBe(true);
    expect(got.fromTier).toBe('peer');
  });
});

describe('large files held for a request, then accepted', () => {
  it('a big file that is "dropped" (they have a request from us already) is held, and goes through once they accept', async () => {
    const { a, b } = await world();
    connect(a, { requestProbeMs: 0 }); // every try reaches bob (an older client would behave like this)
    connect(b);
    await online(a, b);
    // (ADR-091: no names are registered with the relay — the addresses are all there is)
    const to = { agent: INBOX_AGENT, sessionId: '', device: bob };
    const first = a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to, text: 'hi bob' });
    expect(await a.morse!.send(bob, first)).toMatchObject({ ok: true, request: true });
    const { data, m } = withFile(a, 'the file', 2 * 1024 * 1024, to);
    const held = await deliver(a, bob, m.id, 1000);
    expect(held).toMatchObject({ ok: false, waiting: true });
    await until(() => a.morse!.transfer(m.id)?.state !== 'sending');
    expect(a.morse!.transfer(m.id)?.state).toBe('held'); // bob's device did not keep it ("dropped"): no chunk was sent
    expect(a.morse!.transfer(m.id)?.sent).toBe(0);
    expect(a.mailbox.getMessage(m.id)?.receiptAt).toBeUndefined();
    expect(b.morse!.incoming()).toEqual([]);
    acceptRequest(alice, { mailbox: b.mailbox, trust: createTrustStore(b.home), home: b.home });
    await b.morse!.notifyAccepted(alice);
    await until(() => a.logs.some((l) => /accepted your message request \(they told us\)/.test(l)));
    expect(await deliver(a, bob, m.id)).toMatchObject({ ok: true, via: 'relay' });
    expect(readFileSync(filesOf(b)[0]!.path).equals(data)).toBe(true);
  }, 20_000);
});

describe('large files and the LAN by address (ADR-038, ADR-091 follow-up)', () => {
  it('a contact on the LAN who takes envelopes and drops them holds up nothing: no chunk, answer or receipt goes over the LAN — the relay carries the file', async () => {
    const { a, b } = await world();
    pair(a, b);
    const posted: string[] = [];
    const lanOf = async (d: Dev, drop: boolean) => {
      const l = await startAddressLan({
        port: 0,
        host: '127.0.0.1',
        mdns: false,
        address: () => d.morse?.status().v3?.address ?? null,
        sign: (address, message) => d.morse?.lanSign?.(address, message) ?? null,
        check: (blob) => d.morse!.lanCheck!(blob),
        onEnvelope: (blob) => (drop ? void posted.push(blob) : void d.morse!.receive({ id: `lan-${Math.random()}`, from: '', blob, ts: Date.now(), via: 'lan' })),
      });
      lanStops.push(() => l.stop());
      return l;
    };
    const la = await lanOf(a, false);
    connect(a, { lanAddress: la, lanReceiptMs: 300 });
    connect(b);
    await online(a, b);
    // b's listener proves b's address — and swallows whatever it is handed
    const lb = await lanOf(b, true);
    la.addPeer(b.address, '127.0.0.1', lb.port);
    const { data, m } = withFile(a, 'not held up by the LAN', 3 * 1024 * 1024);
    const t0 = Date.now();
    expect(await deliver(a, bob, m.id)).toEqual({ ok: true, via: 'relay' });
    expect(Date.now() - t0).toBeLessThan(8000);
    const got = b.mailbox.inbox({ all: true }).find((x) => x.direction === 'in')!;
    expect(readFileSync(got.parts[0]!.files![0]!.path).equals(data)).toBe(true);
    expect(posted).toEqual([]); // the LAN took none of it
  }, 20_000);
});

