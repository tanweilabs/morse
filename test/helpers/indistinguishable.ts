import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeRelay, type FakeRelay } from './fake-relay.js';
import { agentRequest } from '../../src/cluster/agents.js';
import { decodeChunk, encodeChunk, type ChunkHeader } from '../../src/cluster/chunks.js';
import { loadOrCreateIdentity } from '../../src/cluster/identity.js';
import { stageOutboxFiles, startMorse, INBOX_AGENT, type Morse, type MorseOptions, type MorseSendResult } from '../../src/cluster/morse.js';
import { acceptRequest } from '../../src/cluster/requests.js';
import { createTrustStore } from '../../src/cluster/trust.js';
import { loadPrimaryAddress, type AddressKey } from '../../src/identity/address-key.js';
import { ensureAgentAddresses } from '../../src/identity/agent-addresses.js';
import { openV3, sealV3 } from '../../src/identity/envelope.js';
import { ensurePrekeys } from '../../src/identity/prekeys.js';
import { updateMachineConfig } from '../../src/machine-config.js';
import { seenKeyFor } from '../../src/mailbox/contacts.js';
import { createDb, type Db } from '../../src/mailbox/db.js';
import { homeContactContext } from '../../src/mailbox/home-context.js';
import { createMailbox, type Mailbox, type Message } from '../../src/mailbox/mailbox.js';

/**
 * (ADR-083) The indistinguishability harness: "someone who knows two of my addresses cannot tell they
 * are on the same computer".
 *
 * One scene is three computers on the in-memory fake relay:
 *
 *   H   two addresses — A (its first, the device key's) and B (a second agent, its own key)
 *   C   a completely unrelated computer
 *   P   the observer: a normal Morse client (startMorse) that also hand-forges envelopes
 *
 * P knows two addresses: S, where it builds some state first, and T, which it then talks to. A script is
 * played TWICE, in two separate scenes, with the same S (an address of H) and
 *
 *   same computer    T = the OTHER address of H
 *   other computer   T = an address of C
 *
 * and everything P can observe is written down, in order (the transcript). After replacing only the
 * random strings by the role they play (the addresses → <S> / <T> / <P>, device ids and old handles, the
 * local names of the addresses, message ids, the relay's URL, P's temp directory) the two transcripts must
 * be equal line by line. Besides that, exactly three things are not compared as they come, each for timing
 * or sort order only: the seconds a transfer took in one log line (`<seconds> s`); the order of P's contact
 * and request lists (the store sorts them by the random address string — here: S, T, the rest); and the
 * chunk-by-chunk acknowledgements of a chunked message sent by P's NORMAL client (see `condensed` — the
 * hand-made chunk flows record every acknowledgement). Nothing else is normalised, and nothing is left out.
 *
 * What is written down:
 *   - every envelope the relay carried TO P's address, opened with P's own prekeys: who the relay named as
 *     sender, which address signed it, whether it carries a device certificate (and whose), WHICH of P's
 *     prekeys it is sealed to (ADR-083 review R1: `P's prekey #1` is the one P had at the start, `#2` the one
 *     it made when it replaced that — a computer that answers with a prekey it looked up for ANOTHER of its
 *     addresses shows here), whether it was handed over or kept for P, and the whole decrypted content
 *     (receipt: id / request / full / chunked; transfer answer: have / reset / busy / error / unknown;
 *     accepted; rekey; message: every field);
 *   - "nothing for P" when an action of P's got no envelope back within the settle window (below);
 *   - every envelope P itself put on the relay and what the relay said to it (sent / stored / offline),
 *     and every v2 envelope to or from P's device;
 *   - what `morse.send()` returned to P for each message of its normal client (MorseSendResult), what the
 *     relay answered to each forged envelope, what an address lookup of T returns (caps, online);
 *   - P's own mailbox at the checkpoints: outbound rows (status, receipt, request, waiting, last error,
 *     attempts), inbound rows, contacts, message requests, running transfers;
 *   - every line P's daemon logs.
 *
 * The settle window: after each action the harness waits until NOTHING happens anywhere in the scene for
 * `QUIET_POLLS` polls `POLL_MS` apart (no frame of any kind reaching the relay — a lookup, an envelope, an
 * acknowledgement —, no log line and no database write on any of the three computers; a poll during which
 * the test process itself, or its crypto thread pool, was slow does not count) — on the loopback relay an
 * answer takes a few milliseconds.
 *
 * "No receipt came" is decided the same way, by the SCENE, never by a clock: every computer's
 * `receiptTimeoutMs` is long (`RECEIPT_MS`), and while a `morse.send()` waits for a receipt the harness
 * watches the scene; once it has been quiet for `NO_ANSWER_POLLS` polls nothing is on its way, and the
 * harness ends that wait (`Morse.expireReceiptWait`) — `send` then returns what it returns when its
 * timeout runs out. A short client timeout (it was 0.6 s) ran out on a starved machine before an answer
 * that WAS on its way arrived — in one of the two scenes only, which read as a difference.
 *
 * What is NOT covered here, by ADR-083's own account: the RELAY can link the addresses (one connection,
 * one IP), every address's online presence can be looked up by anyone, and timing / writing style.
 */

export const POLL_MS = 12;
export const QUIET_POLLS = 4;
/** A poll during which this process was slower than this proves nothing (see `settle`). */
export const LAG_MS = 8;
/** Same for the crypto thread pool: a trivial digest that takes longer than this means in-flight sealing is slow too. */
export const CRYPTO_LAG_MS = 4;
const PROBE = new Uint8Array(32);
/** `morse.receiveLimit` of every computer in a scene (the VALUES are one per computer — ADR-083 §7; the counts are per address). */
export const LIMITS = { perSenderPerMinute: 12, totalPerMinute: 16 };
/** How many message requests each address keeps in a scene (createMailbox `maxRequests`). */
export const MAX_REQUESTS = 2;
/** The relay's envelope cap in a scene: small, so a file of a few hundred KB goes in chunks. */
export const MAX_BLOB = 64 * 1024;
/**
 * `receiptTimeoutMs` of every computer in a scene: long, and never meant to run out — the harness ends a wait
 * for a receipt when the scene is provably quiet (`Scene.send`). Were it to run out, the text says so
 * ("no receipt within 20s") in whichever scene it happened.
 */
export const RECEIPT_MS = 20_000;
/** How many quiet polls in a row mean "no receipt is on its way" (more than `QUIET_POLLS`: ending a wait is not undone by a late answer). */
export const NO_ANSWER_POLLS = 10;
/**
 * A chunked transfer's own clocks (how long the sender waits for an acknowledgement before it offers again, and
 * for the final receipt). No flow of this harness lets one run out — every transfer here is answered — so they
 * are long: a short one (it was 0.4 s) ran out on a starved machine in one scene only, and the extra offer it
 * caused showed in P's log ("6 chunk envelope(s) sent" against 5).
 */
const TRANSFER_TUNING = { ackIdleMs: 8000, completeWaitMs: 15_000, maxIdleRounds: 3 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const turn = () => new Promise<void>((r) => setImmediate(r));
export const until = async (cond: () => boolean, what = 'a condition', ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`harness: timed out waiting for ${what}`);
    await sleep(10);
  }
};

export interface Dev {
  home: string;
  id: string;
  handle: string;
  agent: string;
  /** This computer's first address (its device key's). */
  address: string;
  key: AddressKey;
  /** Its device certificate (base64 DER) — what a legacy envelope carries. */
  cert: string;
  mailbox: Mailbox;
  db: Db;
  morse?: Morse;
  logs: string[];
  extra: Partial<MorseOptions>;
  /** `morse.strangers` of this computer (one setting per computer — ADR-083 §7). */
  strangers: 'request' | 'accept' | 'block';
}

/** One address of a computer, as its owner handles it. */
export interface Persona {
  dev: Dev;
  address: string;
  key: AddressKey;
  /** How the stores key it: '' = the computer's first address, else the address. */
  my: string;
  /** Its local name (`--from <name>`). */
  name: string;
  first: boolean;
}

export interface SceneSpec {
  /** T is the other address of the computer that has S (else: an address of the unrelated computer). */
  sameHome: boolean;
  /** false: S = H's first address, T = H's second. true (the mirror): S = H's second, T = H's first. */
  mirror?: boolean;
  /** The unrelated computer's address P talks to is ITS second one (default: its first, the only one it has). */
  elsewhereSecond?: boolean;
  /** `requestProbeMs` of P's client (default: the product's 10 min — later mail is held; 0 = every send goes out). */
  pProbeMs?: number;
}

const session = { agent: 'claude', sessionId: 's-1' };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** A message as a client other than ours could put it on the wire, by address. */
export const message = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ kind: 'message', id, contextId: id, from: { agent: 'claude', sessionId: '' }, to: { agent: 'user', sessionId: '' }, addr: 1, text, ...extra });

/** A small two-chunk file with fixed bytes (the same checksum in every scene). */
export const TWO_CHUNKS = (() => {
  const data = Buffer.alloc(2048);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
  const sha = createHash('sha256').update(data).digest('hex');
  const manifest = { chunkSize: 1024, files: [{ name: 'f.bin', size: 2048, sha256: sha, chunks: 2 }] };
  const chunk = (id: string, seq: number): { header: ChunkHeader; data: Buffer } => ({ header: { kind: 'chunk', id, f: 0, seq, n: 2, sha256: sha }, data: data.subarray(seq * 1024, seq * 1024 + 1024) });
  return { data, sha, manifest, chunk };
})();

export class Scene {
  relay!: FakeRelay;
  H!: Dev;
  C!: Dev;
  P!: Dev;
  /** H's first address, H's second address, and the unrelated computer's (the one P may talk to). */
  A!: Persona;
  B!: Persona;
  E!: Persona;
  /** Where P builds state first — always an address of H. */
  S!: Persona;
  /** The address the flow talks to. */
  T!: Persona;
  /** (S6) before P sends a message id to T, S is given a dedupe mark for that very id. */
  seedDedupeAtS = false;
  readonly entries: unknown[] = [];
  private readonly homes: string[] = [];
  private readonly devs: Dev[] = [];
  private readonly names: Array<[string, string]> = [];
  /** The ids of P's prekeys, in the order P made them (#1 = the one it starts with). */
  private readonly pPrekeys: string[] = [];
  private cursor = 0;
  private v2Cursor = 0;
  private logCursor = 0;
  private strangersMade = 0;
  private closed = false;

  private constructor(readonly spec: SceneSpec) {}

  static async open(spec: SceneSpec): Promise<Scene> {
    const s = new Scene(spec);
    try {
      await s.build();
    } catch (e) {
      await s.close();
      throw e;
    }
    return s;
  }

  // --- the three computers ------------------------------------------------------------------

  private home(): string {
    const h = mkdtempSync(join(tmpdir(), 'morse-personas-'));
    this.homes.push(h);
    return h;
  }

  private dev(handle: string, agent: string, more: string[], extra: Partial<MorseOptions>): Dev {
    const home = this.home();
    const identity = loadOrCreateIdentity(home);
    updateMachineConfig((cfg) => {
      cfg['relay'] = { handle, agent, agents: [agent, ...more] };
    }, join(home, '.morse', 'config.json'));
    const ctx = homeContactContext(home);
    const db = createDb(':memory:', { ctx });
    const key = loadPrimaryAddress(home, identity);
    const d: Dev = { home, id: identity.id, handle, agent, address: key.address, key, cert: new X509Certificate(identity.certPem).raw.toString('base64'), mailbox: createMailbox(db, { ctx, maxRequests: MAX_REQUESTS }), db, logs: [], extra, strangers: 'request' };
    d.extra = { ...extra, strangers: () => d.strangers };
    this.devs.push(d);
    return d;
  }

  private persona(dev: Dev, name: string): Persona {
    const key = name === dev.agent ? dev.key : ensureAgentAddresses(dev.home).find((a) => a.agent === name)!.key;
    const first = key.address === dev.address;
    return { dev, address: key.address, key, my: first ? '' : key.address, name, first };
  }

  private async build(): Promise<void> {
    const host: Partial<MorseOptions> = {
      receiveLimits: () => LIMITS,
      // every chunk is acknowledged at once: the answers to hand-made chunks come one by one, in order
      ackEvery: 1,
      ackDelayMs: 5,
      chunkRatePerMinute: 100_000,
      rateBackoffMs: 50,
      transferTuning: TRANSFER_TUNING,
    };
    this.H = this.dev('hqhandle', 'h1first', ['h1work'], host);
    this.C = this.dev('cqhandle', 'c1first', this.spec.elsewhereSecond ? ['c1work'] : [], host);
    this.P = this.dev('pqhandle', 'p1main', [], {
      ...(this.spec.pProbeMs !== undefined ? { requestProbeMs: this.spec.pProbeMs } : {}),
      chunkRatePerMinute: 100_000,
      rateBackoffMs: 50,
      transferTuning: TRANSFER_TUNING,
    });
    this.relay = await startFakeRelay({ port: 0, host: '127.0.0.1', v3: true, maxBlobBytes: MAX_BLOB, allowlist: this.devs.map((d) => ({ id: d.id, handle: d.handle })), log: () => undefined });
    for (const d of this.devs) await agentRequest({ url: this.url(), op: 'add', agent: d.agent, home: d.home });
    this.A = this.persona(this.H, 'h1first');
    this.B = this.persona(this.H, 'h1work');
    this.E = this.persona(this.C, this.spec.elsewhereSecond ? 'c1work' : 'c1first');
    this.S = this.spec.mirror ? this.B : this.A;
    this.T = this.spec.sameHome ? (this.spec.mirror ? this.A : this.B) : this.E;
    this.nameEverything();
    this.pPrekeys.push(ensurePrekeys(this.P.key).current.id);
    await Promise.all(this.devs.map((d) => this.connect(d)));
    this.logCursor = this.P.logs.length; // (P's login lines carry nothing about the exchange)
  }

  url(): string {
    return `ws://127.0.0.1:${this.relay.port}`;
  }

  /** Every address a computer hosts. */
  private readonly hosted = new Map<Dev, string[]>();
  private addressesOf(d: Dev): string[] {
    if (!this.hosted.has(d)) this.hosted.set(d, [d.address, ...ensureAgentAddresses(d.home).map((a) => a.key.address).filter((a) => a !== d.address)]);
    return this.hosted.get(d)!;
  }

  async connect(d: Dev): Promise<void> {
    d.morse = startMorse({ url: this.url(), home: d.home, mailbox: d.mailbox, receiptTimeoutMs: RECEIPT_MS, connectWaitMs: 1000, log: (l) => d.logs.push(l), ...d.extra });
    await until(() => Boolean(d.morse!.v3Client?.()?.connected()) && this.addressesOf(d).every((a) => this.relay.onlineAddresses().includes(a)), `${d.handle} to be online`);
  }

  async disconnect(d: Dev): Promise<void> {
    d.morse?.stop();
    delete d.morse;
    const mine = this.addressesOf(d);
    await until(() => mine.every((a) => !this.relay.onlineAddresses().includes(a)), `${d.handle} to be offline`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const d of this.devs) d.morse?.stop();
    await this.relay?.close();
    for (const d of this.devs) {
      try {
        d.db.close();
      } catch {
        /* closed already */
      }
    }
    for (const h of this.homes) rmSync(h, { recursive: true, force: true });
  }

  // --- names: which random string plays which role --------------------------------------------

  /**
   * Only what is random per scene is given a name, by the ROLE it plays for P:
   *   <S> <T> <P>            the three addresses of the story; <E…> any other address in the scene
   *   <x-computer.…>         a computer's device id / old handle: they belong to its FIRST address (the device
   *                          key's), so they are named after that address — the computer of H is <S-computer>
   *                          when S is its first address. An envelope from T that shows them reads
   *                          <S-computer.…> in the same-computer scene and <T-computer.…> in the other: a
   *                          difference, as it must be.
   *   <x.name>               the local name of an address (`morse address`). It does travel: a reply carries the
   *                          name of the address that replies as `from.agent`. Named by address, so the name of
   *                          one address showing up in mail from another is a difference.
   */
  private nameEverything(): void {
    const label = new Map<string, string>();
    label.set(this.S.address, 'S');
    label.set(this.T.address, 'T');
    label.set(this.P.address, 'P');
    let other = 0;
    const personas: Persona[] = [this.A, this.B, this.E, ...(this.E.first ? [] : [this.persona(this.C, this.C.agent)]), this.persona(this.P, this.P.agent)];
    for (const p of personas) if (!label.has(p.address)) label.set(p.address, `E${++other}`);
    for (const [address, l] of label) this.nameAddress(address, `<${l}>`);
    for (const p of personas) this.names.push([p.name, `<${label.get(p.address)!}.name>`]);
    for (const d of this.devs) {
      const l = `<${label.get(d.address)!}-computer`;
      this.names.push([d.id, `${l}.device>`], [d.id.slice(0, 7), `${l}.device~7>`], [d.handle, `${l}.handle>`], [d.home, `${l}.home>`]);
    }
    this.names.push([this.url(), '<relay>']);
  }

  private nameAddress(address: string, label: string): void {
    this.names.push([address, label], [address.slice(0, 7), `${label.slice(0, -1)}~7>`]);
  }

  private normalise<X>(x: X): X {
    let s = JSON.stringify(x);
    for (const [raw, name] of [...this.names].sort((a, b) => b[0].length - a[0].length)) s = s.split(raw).join(name);
    return JSON.parse(s) as X;
  }

  /** The transcript: one line per entry; message ids (random) are numbered in the order they first appear. */
  transcript(): string[] {
    const lines = this.entries.map((e) => JSON.stringify(this.normalise(e)));
    const ids = new Map<string, string>();
    for (const l of lines) for (const id of l.match(UUID) ?? []) if (!ids.has(id)) ids.set(id, `<id#${ids.size + 1}>`);
    return lines.map((l) => {
      let out = l;
      for (const [id, name] of ids) out = out.split(id).join(name);
      for (const [id, name] of ids) out = out.split(id.slice(0, 8)).join(`${name.slice(0, -1)}~8>`);
      return out;
    });
  }

  // --- the settle window, and writing down what P saw -------------------------------------------

  private activity(): string {
    const dbs = this.devs.map((d) => {
      try {
        return String((d.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
      } catch {
        return '?';
      }
    });
    return `${this.relay.frames()}/${this.relay.v3Log().length}/${this.relay.v2Sends().length}/${this.relay.signals()}/${this.devs.map((d) => d.logs.length).join(',')}/${dbs.join(',')}`;
  }

  /**
   * Wait until nothing happens anywhere in the scene (see the file comment). A poll counts as quiet only
   * when the process itself was responsive during it (its timer fired within `LAG_MS` of when it should):
   * while other scenes of the same test run keep the event loop busy, an answer on its way could be slow
   * too, so such a poll proves nothing and the count starts over.
   */
  async settle(o: { polls?: number; until?: () => boolean } = {}): Promise<void> {
    const end = Date.now() + 20_000;
    let last = this.activity();
    for (let quiet = 0; quiet < (o.polls ?? QUIET_POLLS); ) {
      if (o.until?.()) return;
      const t0 = performance.now();
      await sleep(POLL_MS);
      await turn();
      const lag = performance.now() - t0 - POLL_MS;
      // An answer on its way spends most of its time in asynchronous crypto (HPKE open, sign, seal on the
      // thread pool) — invisible to `activity()`. When the machine is starved (the whole suite running in
      // parallel) that work can take longer than the quiet window, and a receipt then shows up one step
      // late in the transcript. So a poll only counts when the thread pool itself answered promptly.
      const c0 = performance.now();
      await globalThis.crypto.subtle.digest('SHA-256', PROBE);
      const cryptoLag = performance.now() - c0;
      const now = this.activity();
      if (now === last && lag <= LAG_MS && cryptoLag <= CRYPTO_LAG_MS) quiet++;
      else {
        quiet = 0;
        last = now;
      }
      if (Date.now() > end) throw new Error('harness: the scene never became quiet');
    }
  }

  /**
   * `morse.send()` on a computer of the scene. Whether a receipt comes is decided by the scene, not by a clock
   * (see the file comment): while `send` is under way the scene is watched; when it has been quiet for
   * `NO_ANSWER_POLLS` polls and `send` still waits for a receipt, none is on its way and the wait is ended.
   * (`send` busy with something else — a lookup, the relay connection — is simply waited for.)
   */
  private async send(d: Dev, to: string, m: Message, o: { mark?: boolean } = {}): Promise<MorseSendResult> {
    let over = false;
    const sent = d.morse!
      .send(to, m)
      .then((r) => {
        // what the daemon's outbox does with the answer — at once (a chunked transfer that ends a moment later
        // must find the row as the outbox leaves it), not after the watching below
        if (o.mark !== false) {
          if (r.ok) d.mailbox.markDelivered(m.id);
          else d.mailbox.markFailed(m.id, r.error ?? 'failed', r.waiting ? { waiting: true } : undefined);
        }
        return r;
      })
      .finally(() => {
        over = true;
      });
    sent.catch(() => undefined); // (awaited below; never an unhandled rejection meanwhile)
    while (!over) {
      await this.settle({ polls: NO_ANSWER_POLLS, until: () => over });
      if (over) break;
      d.morse!.expireReceiptWait?.(m.id);
      await turn();
    }
    return sent;
  }

  /** Which of P's prekeys an envelope was sealed to, by the order P made them. */
  private prekeyName(id: string): string {
    const i = this.pPrekeys.indexOf(id);
    return i < 0 ? 'a prekey of P the harness did not see made' : `P's prekey #${i + 1}`;
  }

  /**
   * P replaces its prekey — what every client does once a week: the one it had is retired (P keeps its private
   * half for 8 days and still opens what is sealed to it), a new one is made and published. Here: by stopping
   * P's client and starting it again, which logs in with the new one. From now on a computer that looks P up
   * gets `#2`; one that goes by an earlier lookup of its own still seals to `#1`.
   */
  async rotatesPrekey(): Promise<void> {
    await this.settle();
    await this.drain();
    const P = this.P;
    await this.disconnect(P);
    const dir = join(P.key.dir, 'prekeys');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { retiredAt?: number };
      if (!rec.retiredAt) writeFileSync(join(dir, f), `${JSON.stringify({ ...rec, retiredAt: Date.now() })}\n`, { mode: 0o600 });
    }
    await this.connect(P);
    const now = ensurePrekeys(P.key).current.id;
    if (this.pPrekeys.includes(now)) throw new Error('harness: P still has the prekey it had');
    this.pPrekeys.push(now);
    let published = '';
    for (const end = Date.now() + 10_000; published !== now; ) {
      if (Date.now() > end) throw new Error("harness: the relay does not answer with P's new prekey");
      published = (await P.morse!.v3Client!()!.lookupAddress!(P.address)).prekey?.id ?? '';
    }
    this.logCursor = P.logs.length; // (P's own logout / login lines carry nothing about the exchange)
    this.note(`P replaces its prekey: the relay now answers with P's prekey #${this.pPrekeys.length}`);
    await this.after();
  }

  private certOwner(cert: string): string {
    const d = this.devs.find((x) => x.cert === cert);
    return d ? `certificate of ${d.id}` : 'a certificate of nobody in the scene';
  }

  private bodyOf(buf: Buffer): unknown {
    const chunk = decodeChunk(buf);
    if (chunk) return { chunk: chunk.header, bytes: chunk.data.length };
    try {
      const plain = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
      if (Array.isArray(plain['files'])) plain['files'] = (plain['files'] as Array<Record<string, unknown>>).map((f) => ({ ...f, data: `${String(f['data']).length} base64 characters` }));
      return plain;
    } catch {
      return { unreadable: buf.length };
    }
  }

  /** Everything new on the relay that P sent or was sent, then P's new log lines. Returns how many envelopes were for P. */
  private async drain(): Promise<number> {
    const log = this.relay.v3Log();
    let forP = 0;
    for (; this.cursor < log.length; this.cursor++) {
      const e = log[this.cursor]!;
      if (e.to === this.P.address) {
        forP++;
        try {
          const o = await openV3(JSON.parse(e.blob), { address: this.P.address, keys: ensurePrekeys(this.P.key).keys });
          const content = this.bodyOf(o.body) as { kind?: unknown; id?: unknown } | null;
          if (content && content.kind === 'message' && typeof content.id === 'string') this.wireIds.set(e.blob, content.id);
          this.entries.push({ 'envelope for P': { 'relay says from': e.from, 'signed by': o.from, certificate: o.cert ? this.certOwner(o.cert) : 'none', 'sealed to': this.prekeyName(o.prekeyId), relay: e.r, content: this.bodyOf(o.body) } });
        } catch (err) {
          this.entries.push({ 'envelope for P': { 'relay says from': e.from, relay: e.r, 'cannot be opened': err instanceof Error ? err.message : String(err) } });
        }
      } else if (e.from === this.P.address) this.entries.push({ 'envelope from P': { to: e.to, relay: e.r } });
    }
    const v2 = this.relay.v2Sends();
    for (; this.v2Cursor < v2.length; this.v2Cursor++) {
      const e = v2[this.v2Cursor]!;
      if (e.to === this.P.id || e.from === this.P.id) {
        if (e.to === this.P.id) forP++;
        this.entries.push({ 'v2 envelope': e });
      }
    }
    for (; this.logCursor < this.P.logs.length; this.logCursor++) this.entries.push({ "P's log": this.P.logs[this.logCursor]!.replace(/\b\d+(\.\d+)? s\b/g, '<seconds> s') });
    return forP;
  }

  /** After an action: settle, then write down what reached P — or that nothing did. */
  private async after(): Promise<void> {
    await this.settle();
    if ((await this.drain()) === 0) this.entries.push({ 'envelope for P': 'nothing' });
  }

  private flowMark = 0;
  /** The flow starts here (what T's computer logs from now on can be looked at with `hostLogsOfFlow`). */
  beginFlow(title: string): void {
    this.note(title);
    this.flowMark = this.T.dev.logs.length;
  }

  /** What the computer of T logged since the flow began (for the harness's own checks — never part of the transcript). */
  hostLogsOfFlow(): string[] {
    return this.T.dev.logs.slice(this.flowMark);
  }

  /** Something the harness or an owner does (not an observation — it only says where in the story we are). */
  note(text: string): void {
    this.entries.push({ story: text });
  }

  private rows(d: Dev): Message[] {
    return (d.db.prepare('SELECT id FROM messages ORDER BY rowid').all() as Array<{ id: string }>).map((r) => d.mailbox.getMessage(r.id)!);
  }

  private rank(who: string | null): number {
    const order = [this.S.address, this.T.address, this.A.address, this.B.address, this.E.address, this.H.handle, this.C.handle];
    const i = order.indexOf(who ?? '');
    return i < 0 ? order.length : i;
  }

  /** P's own mailbox, as `morse message` / `morse contact` would show it — everything, not only T's rows. */
  async snapshot(label: string): Promise<void> {
    await this.settle();
    await this.drain();
    const P = this.P;
    const rows = this.rows(P);
    this.entries.push({
      "P's mailbox": label,
      outbound: rows.filter((m) => m.direction === 'out').map((m) => ({
        id: m.id,
        to: m.to.device ?? null,
        text: m.parts.map((p) => p.text).join('\n'),
        files: m.parts.flatMap((p) => p.files ?? []).map((f) => f.name),
        status: m.status,
        attempts: m.attempts,
        receipt: Boolean(m.receiptAt),
        request: Boolean(m.request),
        waiting: Boolean(m.waiting),
        lastError: m.lastError ?? null,
        contact: m.contactId ?? null,
        myAddress: m.myAddress ?? null,
      })),
      inbound: rows.filter((m) => m.direction === 'in').map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        text: m.parts.map((p) => p.text).join('\n'),
        tier: m.fromTier ?? null,
        ownThread: Boolean(m.ownThread),
        contact: m.contactId ?? null,
        myAddress: m.myAddress ?? null,
        myAgent: m.myAgent ?? null,
        context: m.contextId,
      })),
      // (both lists come sorted by the address string, i.e. at random: here S first, then T, then anyone else)
      contacts: P.mailbox.contacts.list().filter((c) => c.id !== 'self').sort((a, b) => this.rank(a.address ?? a.handle) - this.rank(b.address ?? b.handle)).map((c) => ({ id: c.id, address: c.address, handle: c.handle, remark: c.remark, group: c.group, state: c.state, myAddress: c.myAddress, addresses: c.addresses })),
      requests: P.mailbox.requests.list().sort((a, b) => this.rank(a.handle) - this.rank(b.handle)).map((r) => ({ at: r.myAddress, from: r.handle, device: r.deviceId, toAddress: r.toAddress ?? null, to: r.to, msg: r.msgId, text: r.text, count: r.count, droppedFiles: r.droppedFiles })),
      transfers: (P.morse?.transfers() ?? []).map((t) => ({ msg: t.msgId, to: t.to, via: t.via, state: t.state, total: t.total, acked: t.acked, error: t.error ?? null })),
      receiving: P.morse?.incoming() ?? [],
      // (ADR-069 signalling frames the relay forwarded for anyone in the scene: none is expected by address)
      signals: this.relay.signals(),
    });
  }

  // --- P, the observer: its normal client ---------------------------------------------------------

  private async handToMorse(to: Persona, m: Message): Promise<MorseSendResult> {
    return this.send(this.P, m.to.device ?? to.address, m);
  }

  private claim(expect: string): Message {
    const c = this.P.mailbox.claimNextPending({ scope: 'outbound' });
    if (!c || c.id !== expect) throw new Error(`harness: P's outbox handed over ${c?.id ?? 'nothing'} instead of the message just queued`);
    return c;
  }

  /** (S6) S gets a dedupe mark for this id before T sees it — through the store: the id did not exist earlier. */
  private seed(to: Persona, id: unknown): void {
    if (!this.seedDedupeAtS || to !== this.T || typeof id !== 'string') return;
    this.S.dev.mailbox.firstSeen(seenKeyFor(this.P.address, this.S.my), id);
  }

  /** `morse send morse.im/<to> "<text>" [--file …]` on P, as P's daemon runs it; what it returned is written down. */
  async say(to: Persona, text: string, o: { files?: string[] } = {}): Promise<Message | null> {
    const P = this.P;
    const route = await P.morse!.addressRoute!(`morse.im/${to.address}`, null);
    if (!route) throw new Error('harness: P would not send by address');
    if (!route.ok && !route.waiting) {
      this.entries.push({ 'P sends': text, to: to.address, refused: route.error });
      await this.after();
      return null;
    }
    P.morse!.acceptAddress!(to.address, route.ok ? route.from : null);
    const m = P.mailbox.send({
      from: session,
      to: { agent: INBOX_AGENT, sessionId: '', device: to.address },
      text,
      via: 'cli',
      ...(route.ok ? { myAddress: route.from } : {}),
      ...(o.files?.length ? { files: stageOutboxFiles(o.files, P.home) } : {}),
    });
    this.seed(to, m.id);
    const r = await this.handToMorse(to, this.claim(m.id));
    this.entries.push({ 'P sends': text, to: to.address, id: m.id, 'morse.send returned': r });
    await this.after();
    return m;
  }

  /**
   * The outbox hands a message of P's to Morse again, as if no receipt had come (a late resend of the same id).
   * A message that waits (failed, to be retried) is claimed first, as the outbox does when it is due.
   */
  async again(to: Persona, m: Message): Promise<void> {
    const cur = this.P.mailbox.getMessage(m.id)!;
    let r: MorseSendResult;
    if (cur.status === 'failed' && cur.waiting) {
      this.P.mailbox.nudge(m.id);
      r = await this.handToMorse(to, this.claim(m.id));
    } else {
      const { receiptAt: _receiptAt, ...row } = cur;
      r = await this.send(this.P, row.to.device ?? to.address, row, { mark: false });
    }
    this.entries.push({ 'P sends again': m.id, to: to.address, 'morse.send returned': r });
    await this.after();
  }

  /** P's outbox runs: everything that is due goes to Morse, oldest first. */
  async outbox(): Promise<MorseSendResult[]> {
    const out: MorseSendResult[] = [];
    for (let c = this.P.mailbox.claimNextPending({ scope: 'outbound' }); c; c = this.P.mailbox.claimNextPending({ scope: 'outbound' })) {
      const r = await this.send(this.P, c.to.device!, c);
      out.push(r);
      this.entries.push({ "P's outbox sends": c.id, to: c.to.device, 'morse.send returned': r });
    }
    if (!out.length) this.entries.push({ "P's outbox sends": 'nothing is due' });
    await this.after();
    return out;
  }

  /** `morse reply <id> "<text>"` on P, to the message from `from` that says `toText`. */
  async reply(from: Persona, toText: string, text: string): Promise<void> {
    const original = this.rows(this.P).find((m) => m.direction === 'in' && m.from.device === from.address && m.parts[0]?.text === toText);
    if (!original) {
      this.entries.push({ 'P replies': text, to: from.address, failed: `P has no message "${toText}" from that address` });
      await this.after();
      return;
    }
    const m = this.P.mailbox.reply(original.id, text);
    this.seed(from, m.id);
    const r = await this.handToMorse(from, this.claim(m.id));
    this.entries.push({ 'P replies': text, to: from.address, id: m.id, 'morse.send returned': r });
    await this.after();
  }

  /** A chunked message of P's normal client: wait until its transfer is over (done / request / failed / waiting). */
  async transferOver(m: Message): Promise<void> {
    await until(() => ['done', 'request', 'failed', 'held', 'waiting'].includes(this.P.morse!.transfer(m.id)?.state ?? ''), 'the transfer to end', 20_000);
    await this.settle();
  }

  /**
   * (the one place the transcript is condensed — timing, nothing else) While a chunked message of P's NORMAL
   * client runs, P hands over several chunks at a time and the recipient acknowledges each as it lands: how
   * many `have` acknowledgements come back, which chunks each one lists and how they interleave with P's own
   * envelopes is decided by the order P's concurrent envelopes happen to arrive in. So for this one action the
   * `have` acknowledgements are written down ONCE, without their chunk ranges (who sent and signed them,
   * certificate, how the relay handed them over, kind, id), and P's own envelopes are not listed. Every other
   * envelope for P (the answer to the offer when it is not a plain `have`, the final receipt, a refusal …),
   * what morse.send returned and P's log lines are written down in full and in order. Hand-made chunks
   * (`rawChunk`), sent one at a time, are written down envelope by envelope, ranges included.
   */
  async condensed(what: string, run: () => Promise<void>): Promise<void> {
    await this.settle();
    await this.drain();
    const from = this.entries.length;
    await run();
    await this.settle();
    await this.drain();
    const during = this.entries.splice(from);
    const haveOf = (e: unknown): Record<string, unknown> | null => {
      const env = (e as { 'envelope for P'?: Record<string, unknown> })['envelope for P'];
      const c = env && typeof env === 'object' ? (env['content'] as Record<string, unknown> | undefined) : undefined;
      if (!c || c['kind'] !== 'transfer' || !Array.isArray(c['have']) || Object.keys(c).sort().join() !== 'have,id,kind') return null;
      return { ...env, content: { kind: c['kind'], id: c['id'], have: '(chunk ranges: timing)' } };
    };
    const kinds = [...new Set(during.map(haveOf).filter((x) => x !== null).map((x) => JSON.stringify(x)))].sort().map((x) => JSON.parse(x) as unknown);
    this.entries.push({ condensed: what, '`have` acknowledgements for P': kinds.length ? kinds : 'none' });
    for (const e of during) if (!haveOf(e) && !('envelope from P' in (e as object)) && (e as { 'envelope for P'?: unknown })['envelope for P'] !== 'nothing') this.entries.push(e);
  }

  // --- P, the observer: hand-made envelopes ---------------------------------------------------------

  private async seal(from: AddressKey, to: Persona, body: Buffer, o: { cert?: string; wrongPrekey?: boolean } = {}): Promise<string> {
    const info = await this.P.morse!.v3Client!()!.lookupAddress!(to.address);
    // (wrongPrekey: sealed to a prekey the recipient never had — P's own — so none of the recipient's opens it)
    const prekey = o.wrongPrekey ? ensurePrekeys(this.P.key).current : info.prekey!;
    return JSON.stringify(await sealV3({ from, to: to.address, prekey, body, ...(o.cert ? { cert: o.cert } : {}) }));
  }

  /** P puts a hand-made envelope for `to` on the relay (signed by P's address); the relay's answer is written down. */
  async raw(to: Persona, plain: Record<string, unknown>, o: { cert?: boolean; wrongPrekey?: boolean; ref?: string } = {}): Promise<void> {
    this.seed(to, plain['id']);
    await this.put(to, Buffer.from(JSON.stringify(plain)), { 'P forges': plain, ...(o.cert ? { with: "P's device certificate" } : {}), ...(o.wrongPrekey ? { sealedTo: 'a prekey the recipient does not have' } : {}), ...(o.ref ? { ref: o.ref } : {}) }, o);
  }

  /** One hand-made chunk of a chunked message. */
  async rawChunk(to: Persona, c: { header: ChunkHeader; data: Buffer }, o: { cert?: boolean } = {}): Promise<void> {
    await this.put(to, encodeChunk(c.header, c.data), { 'P forges a chunk': c.header, ...(o.cert ? { with: "P's device certificate" } : {}) }, o);
  }

  private async put(to: Persona, body: Buffer, what: Record<string, unknown>, o: { cert?: boolean; wrongPrekey?: boolean; ref?: string }): Promise<void> {
    let said: string;
    try {
      const blob = await this.seal(this.P.key, to, body, { ...(o.cert ? { cert: this.P.cert } : {}), ...(o.wrongPrekey ? { wrongPrekey: true } : {}) });
      said = (await this.P.morse!.v3Client!()!.sendV3!(to.address, blob, o.ref ? { ref: o.ref } : {})).r;
    } catch (e) {
      said = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.entries.push({ ...what, to: to.address, 'the relay answered': said });
    await this.after();
  }

  /** The ids of the messages P has received from an address so far (to answer them at ANOTHER address). */
  receivedFrom(from: Persona): string[] {
    const P = this.P;
    // (what P's mailbox keeps is its own row id; the id on the wire is what the envelope said — read it from the relay's log)
    const ids: string[] = [];
    for (const e of this.relay.v3Log()) {
      if (e.to !== P.address || e.from !== from.address) continue;
      const seen = this.wireIds.get(e.blob);
      if (seen) ids.push(seen);
    }
    return ids;
  }
  private readonly wireIds = new Map<string, string>();

  /** What anyone gets when they ask the relay about an address (presence is a known limit: both are online here). */
  async lookup(to: Persona): Promise<void> {
    const info = await this.P.morse!.v3Client!()!.lookupAddress!(to.address);
    this.entries.push({ 'P looks up': to.address, published: Boolean(info.key), prekey: Boolean(info.prekey), online: info.online, caps: info.caps });
  }

  /** `morse contact accept <address>` on P: P accepts the message request an address sent it, and its daemon tells them. */
  async accepts(from: Persona): Promise<void> {
    const P = this.P;
    const r = acceptRequest(from.address, { mailbox: P.mailbox, trust: createTrustStore(P.home), home: P.home });
    this.entries.push({ 'P accepts the message request of': from.address, ...(r.ok ? { ok: true } : { ok: false, error: r.error }) });
    if (r.ok) await P.morse!.notifyAccepted(from.address, r.request.myAddress);
    await this.after();
  }

  /**
   * (S9) P and the computer H are paired the OLD way (handle + device certificate — what a contact from
   * before ADR-081 is): each has the other's device in its trust list, and one message went by old name.
   * Such a contact belongs to H's first address only.
   */
  async pairTheOldWay(): Promise<void> {
    createTrustStore(this.H.home).add({ id: this.P.id, name: this.P.handle, tier: 'peer' });
    createTrustStore(this.P.home).add({ id: this.H.id, name: this.H.handle, tier: 'peer' });
    await this.sayTheOldWay('hello, the old way');
    await this.H.morse!.migrateContacts!();
    await this.P.morse!.migrateContacts!();
    this.note('both computers ran the contact migration');
    await this.after();
  }

  /** `morse send <the old handle of H> "<text>"` on P: by old name, the device path (P and H are paired the old way). */
  async sayTheOldWay(text: string): Promise<void> {
    const m = this.P.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: this.H.handle }, text });
    const r = await this.handToMorse(this.A, this.claim(m.id));
    this.entries.push({ 'P sends, by old name': text, to: this.H.handle, id: m.id, 'morse.send returned': r });
    await this.after();
  }

  /** What an owner's own `morse send` / outbox said — not an observation of P's, but it decides what P gets next. */
  ownerWasTold(p: Persona, what: unknown): void {
    this.entries.push({ 'the owner was told': what, at: p.address });
  }

  // --- other people (never observed by P) -------------------------------------------------------------

  /**
   * `n` strangers each write one message to `to` (hand-made, handed to that computer as the relay would):
   * they fill its message requests. Their addresses are published by nobody — the receipt cannot be sent,
   * which changes nothing for the request.
   */
  async strangersWrite(to: Persona, n: number, each = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      const key = loadPrimaryAddress(this.home());
      const k = ++this.strangersMade;
      this.nameAddress(key.address, `<stranger${k}>`);
      for (let j = 0; j < each; j++) {
        const blob = await this.seal(key, to, Buffer.from(JSON.stringify(message(`stranger-${k}-${j + 1}`, `hello from stranger ${k} (${j + 1})`))));
        await to.dev.morse!.receive({ id: `inj-${k}-${j}`, from: key.address, blob, ts: Date.now(), to: to.address });
      }
    }
    this.note(`${n} stranger(s) wrote ${each} message(s) each to ${to.address}`);
    await this.after();
  }

  // --- the owner of an address (what they do is not observed; what it causes is) ------------------------

  owner(p: Persona) {
    const d = p.dev;
    const P = this.P.address;
    const did = async (what: string) => {
      this.note(`the owner of ${p.address} ${what}`);
      await this.after();
    };
    const inboundFrom = (text: string): Message => {
      const m = this.rows(d).find((x) => x.direction === 'in' && x.from.device === P && x.myAddress === p.address && x.parts[0]?.text.startsWith(text));
      if (!m) throw new Error(`harness: ${p.name} has no message "${text}" from P`);
      return m;
    };
    const send = async (m: Message): Promise<MorseSendResult> => {
      const c = d.mailbox.claimNextPending({ scope: 'outbound' });
      if (!c || c.id !== m.id) throw new Error(`harness: the outbox of ${p.name} handed over ${c?.id ?? 'nothing'} instead of the message just queued`);
      return this.send(d, c.to.device!, c);
    };
    return {
      /** `morse contact accept <P> --from <name>`: the CLI accepts, then tells the daemon. */
      accept: async (): Promise<void> => {
        const r = acceptRequest(P, { mailbox: d.mailbox, trust: createTrustStore(d.home), home: d.home, myAddress: p.my });
        if (!r.ok) throw new Error(`harness: ${p.name} cannot accept P: ${r.error}`);
        await d.morse!.notifyAccepted(P, r.request.myAddress);
        await did('accepts the message request of P');
      },
      /** `morse contact reject <P> --from <name>`. */
      reject: async (who: string = P): Promise<void> => {
        d.mailbox.requests.remove(who, p.my);
        await did(who === P ? 'rejects the message request of P' : 'rejects the message request of a stranger');
      },
      /** `morse contact reject <address>` for the stranger whose request has waited longest at this address. */
      rejectAStranger: async (): Promise<void> => {
        const others = d.mailbox.requests.list(p.my).filter((r) => r.handle !== P);
        const oldest = others[others.length - 1];
        if (!oldest) throw new Error(`harness: no stranger's request waits at ${p.name}`);
        d.mailbox.requests.remove(oldest.handle, p.my);
        await did('rejects the message request of a stranger');
      },
      /** `morse contact add <P> --from <name> [--name … --group …]`. */
      add: async (o: { remark?: string; group?: string } = {}): Promise<void> => {
        let c = d.mailbox.contacts.byAddress(P, p.my) ?? d.mailbox.contacts.ensureAddress(P, p.my);
        d.mailbox.contacts.unblockAt(P, p.my);
        if (c.state === 'blocked') c = d.mailbox.contacts.set(c.id, { state: 'active' });
        if (o.remark !== undefined || o.group !== undefined) d.mailbox.contacts.set(c.id, { ...(o.remark !== undefined ? { remark: o.remark } : {}), ...(o.group !== undefined ? { group: o.group } : {}) });
        if (d.mailbox.requests.get(P, p.my)) {
          const r = acceptRequest(P, { mailbox: d.mailbox, trust: createTrustStore(d.home), home: d.home, myAddress: p.my });
          if (r.ok) await d.morse!.notifyAccepted(P, r.request.myAddress);
        }
        await did('adds P as a contact');
      },
      /** `morse contact set <P> --name … --group …`. */
      set: async (patch: { remark?: string; group?: string }): Promise<void> => {
        const c = d.mailbox.contacts.byAddress(P, p.my);
        if (!c) throw new Error(`harness: P is no contact of ${p.name}`);
        d.mailbox.contacts.set(c.id, patch);
        await did('names and groups the contact P');
      },
      /** `morse contact block <P> --from <name>` (src/commands/messaging.ts blockAction). */
      block: async (): Promise<void> => {
        const c = d.mailbox.contacts.byAddress(P, p.my) ?? d.mailbox.contacts.ensureAddress(P, p.my);
        d.mailbox.contacts.blockAt(P, p.my);
        d.mailbox.requests.remove(P, p.my);
        d.mailbox.contacts.set(c.id, { state: 'blocked' });
        await did('blocks P');
      },
      /** `morse contact unblock <P> --from <name>`. */
      unblock: async (): Promise<void> => {
        const c = d.mailbox.contacts.byAddress(P, p.my);
        d.mailbox.contacts.unblockAt(P, p.my);
        if (c) d.mailbox.contacts.set(c.id, { state: 'active' });
        await did('unblocks P');
      },
      /** `morse contact remove <P> --from <name>`. */
      remove: async (): Promise<void> => {
        const c = d.mailbox.contacts.byAddress(P, p.my);
        if (!c) throw new Error(`harness: P is no contact of ${p.name}`);
        d.mailbox.contacts.remove(c.id);
        await did('removes the contact P');
      },
      /** `morse reply <id> "<text>"` to P's message that starts with `toText`. Returns what the owner was told. */
      reply: async (toText: string, text: string): Promise<MorseSendResult> => {
        const r = await send(d.mailbox.reply(inboundFrom(toText).id, text));
        await did(`replies "${text}" to P's "${toText}"`);
        return r;
      },
      /** `morse send morse.im/<P> "<text>" --from <name>` (src/daemon/server.ts /api/send). */
      write: async (text: string): Promise<MorseSendResult | { refused: string }> => {
        const route = await d.morse!.addressRoute!(`morse.im/${P}`, p.address);
        if (!route) {
          // not by address: P's address is that of a device paired here the old way (only ever from a first
          // address) — the daemon queues it for that device and accepts nothing
          if (!p.first) throw new Error(`harness: ${p.name} would not send by address`);
          const r = await send(d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: P }, text, via: 'cli', myAgent: p.name, myAddress: p.address }));
          await did(`writes "${text}" to P`);
          return r;
        }
        if (!route.ok && !route.waiting) {
          await did(`tries to write "${text}" to P`);
          return { refused: route.error };
        }
        d.morse!.acceptAddress!(P, p.address);
        const r = await send(d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: P }, text, via: 'cli', myAgent: p.name, myAddress: p.address }));
        await did(`writes "${text}" to P`);
        return r;
      },
      /** `morse.strangers` in the config of the computer that has this address (the setting is the whole computer's). */
      strangers: async (mode: 'request' | 'accept' | 'block'): Promise<void> => {
        d.strangers = mode;
        await did(`sets morse.strangers to "${mode}" on that computer`);
      },
      /** The owner's outbox runs (what the daemon does every few seconds). */
      outbox: async (): Promise<MorseSendResult[]> => {
        const out: MorseSendResult[] = [];
        for (let c = d.mailbox.claimNextPending({ scope: 'outbound' }); c; c = d.mailbox.claimNextPending({ scope: 'outbound' })) {
          const r = await this.send(d, c.to.device!, c);
          out.push(r);
        }
        await did('lets the outbox run');
        return out;
      },
      /** The computer that has this address stops its daemon and starts it again. */
      restart: async (): Promise<void> => {
        await this.disconnect(d);
        await this.connect(d);
        await did('restarts the daemon of that computer');
      },
      goAway: async (): Promise<void> => {
        await this.disconnect(d);
        await did('takes that computer offline');
      },
      comeBack: async (): Promise<void> => {
        await this.connect(d);
        await did('brings that computer back');
      },
      /** The prekeys of this address are gone (a restored backup, a wiped directory): what was sealed to them cannot be opened. */
      losePrekeys: (): void => {
        rmSync(join(p.key.dir, 'prekeys'), { recursive: true, force: true });
        this.note(`the prekeys of ${p.address} are lost`);
      },
      has: (text: string): boolean => this.rows(d).some((x) => x.direction === 'in' && x.from.device === P && x.myAddress === p.address && x.parts[0]?.text.startsWith(text)),
    };
  }

  /** A file of fixed bytes in P's home (the same checksum in every scene). */
  file(name: string, bytes: number): string {
    const dir = join(this.P.home, 'to-send');
    mkdirSync(dir, { recursive: true });
    const data = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) data[i] = (i * 131 + 17) & 0xff;
    const path = join(dir, name);
    writeFileSync(path, data);
    return path;
  }

  /** Every message row of a computer (tests look into H's own stores). */
  messagesOf(d: Dev): Message[] {
    return this.rows(d);
  }
}

// --- comparing two transcripts ------------------------------------------------------------------

type Op = { tag: ' ' | '-' | '+'; line: string };

/** The two transcripts aligned line by line (longest common subsequence): ' ' in both, '-' only same computer, '+' only other computer. */
function align(same: string[], other: string[]): Op[] {
  const n = same.length;
  const m = other.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = same[i] === other[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same[i] === other[j]) ops.push({ tag: ' ', line: same[i++]! }), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ tag: '-', line: same[i++]! });
    else ops.push({ tag: '+', line: other[j++]! });
  }
  while (i < n) ops.push({ tag: '-', line: same[i++]! });
  while (j < m) ops.push({ tag: '+', line: other[j++]! });
  return ops;
}

/** A line-by-line difference, with one line of context. '' = identical. */
export function difference(same: string[], other: string[]): string {
  if (same.length === other.length && same.every((l, i) => l === other[i])) return '';
  const ops = align(same, other);
  const out: string[] = [];
  let skipped = false;
  ops.forEach((op, k) => {
    const show = op.tag !== ' ' || (k > 0 && ops[k - 1]!.tag !== ' ') || (k + 1 < ops.length && ops[k + 1]!.tag !== ' ');
    if (!show) return void (skipped = true);
    if (skipped) out.push('    …');
    skipped = false;
    out.push(`${op.tag === '-' ? '  - same computer:  ' : op.tag === '+' ? '  + other computer: ' : '                    '}${op.line}`);
  });
  return out.join('\n');
}

/**
 * Exactly the lines the two transcripts do NOT share, in order — for a test that pins a known difference:
 * every other line is then identical in both.
 */
export function changes(same: string[], other: string[]): { onlySameComputer: string[]; onlyOtherComputer: string[] } {
  const ops = align(same, other);
  return { onlySameComputer: ops.filter((o) => o.tag === '-').map((o) => o.line), onlyOtherComputer: ops.filter((o) => o.tag === '+').map((o) => o.line) };
}

export interface Played {
  transcript: string[];
}

/**
 * Play `script` in one scene. `inspect` runs at the end, before the scene is torn down (to look into the
 * computers' own stores).
 */
export async function play(spec: SceneSpec, script: (s: Scene) => Promise<void>, inspect?: (s: Scene) => void | Promise<void>): Promise<Played> {
  const s = await Scene.open(spec);
  try {
    await script(s);
    await s.snapshot('at the end');
    if (inspect) await inspect(s);
    return { transcript: s.transcript() };
  } finally {
    await s.close();
  }
}

export interface Checks {
  /** Looks into the computers' own stores at the end of each scene (never part of the transcript). */
  inspect?: (s: Scene, sameHome: boolean) => void | Promise<void>;
  /**
   * What the transcript of the OTHER-computer scene (the unrelated computer: the behaviour nobody doubts) must
   * show, so that "identical" cannot mean "nothing happened in either".
   */
  baseline?: (lines: string[]) => void;
}

/**
 * Play the script in both scenes — against the other address of the same computer and against an unrelated
 * computer — and hand back the two transcripts. `ADR083_DUMP=<dir>` writes both there (to read a failure in full).
 */
export async function playBoth(title: string, spec: Omit<SceneSpec, 'sameHome'>, script: (s: Scene) => Promise<void>, checks: Checks = {}): Promise<{ same: string[]; other: string[] }> {
  const { inspect, baseline } = checks;
  const [same, other] = await Promise.all([
    play({ ...spec, sameHome: true }, script, inspect ? (s) => inspect(s, true) : undefined),
    play({ ...spec, sameHome: false }, script, inspect ? (s) => inspect(s, false) : undefined),
  ]);
  const dump = process.env['ADR083_DUMP'];
  if (dump) {
    mkdirSync(dump, { recursive: true });
    const name = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 120);
    writeFileSync(join(dump, `${name}.same-computer.txt`), same.transcript.join('\n') + '\n');
    writeFileSync(join(dump, `${name}.other-computer.txt`), other.transcript.join('\n') + '\n');
  }
  // a transcript with nothing in it would prove nothing
  if (!other.transcript.some((l) => l.includes('envelope for P') || l.includes('morse.send returned'))) throw new Error(`${title}\nharness: the transcript records no observation at all`);
  if (baseline) {
    try {
      baseline(other.transcript);
    } catch (e) {
      throw new Error(`${title}\nharness: the scene on the unrelated computer did not go as the flow intends — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { same: same.transcript, other: other.transcript };
}

/**
 * THE assertion: play the script against the other address of the same computer and against an unrelated
 * computer, and require the two transcripts to be identical. Throws with the exact difference.
 */
export async function indistinguishable(title: string, spec: Omit<SceneSpec, 'sameHome'>, script: (s: Scene) => Promise<void>, checks: Checks = {}): Promise<void> {
  const { same, other } = await playBoth(title, spec, script, checks);
  const diff = difference(same, other);
  if (diff) throw new Error(`${title}\nP can tell the two addresses are on the same computer — what P observed differs (${same.length} vs ${other.length} transcript lines):\n${diff}`);
}
