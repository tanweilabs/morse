import { randomBytes } from 'node:crypto';
import { open, seal, type EncKey, type SealedEnvelope } from './e2e.js';
import type { DeviceIdentity } from './identity.js';

/**
 * Direct links between contacts' devices over WebRTC data channels (ADR-069,
 * docs/specs/phase7-webrtc-direct.md).
 *
 * A direct link only changes the PATH: what travels over it is the same end-to-end
 * sealed Morse envelope the relay would carry, and the caller still waits for the
 * end-to-end receipt. Anything that does not work out (no native module, the peer
 * never answers, the link drops) makes `send` say false and the caller uses the relay.
 *
 * Transport-agnostic on purpose: this module knows device IDs, a `SignalChannel`
 * (today the Cloudflare relay; later a LAN-local one) and how to get a peer's verified
 * X25519 key. It never sees a relay URL, a handle or a Durable Object.
 *
 * Security: every signal (offer / answer / ICE candidate) is a full Morse envelope —
 * signed by the sender's device key, encrypted to the recipient — and is accepted only
 * from a known contact / paired device, fresh, and not replayed. The DTLS fingerprint in
 * the SDP is therefore bound to the device identity: libdatachannel checks the peer's
 * DTLS certificate against it, and we compare `remoteFingerprint()` once more when the
 * channel opens. The relay can neither forge a signal nor read the candidates.
 */

export const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478'];
const SIGNAL_TAG = 'morse-direct-v1';
const FRAME_DATA = 1;
const HEADER_BYTES = 13;

/** The minimal slice of node-datachannel this module uses (a test can supply its own). */
export interface RtcDataChannel {
  sendMessageBinary(buffer: Buffer): boolean;
  isOpen(): boolean;
  maxMessageSize(): number;
  close(): void;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void;
}

export interface RtcPeer {
  close(): void;
  setRemoteDescription(sdp: string, type: string): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  createDataChannel(label: string, config?: Record<string, unknown>): RtcDataChannel;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onStateChange(cb: (state: string) => void): void;
  onDataChannel(cb: (dc: RtcDataChannel) => void): void;
  remoteFingerprint(): { value: string; algorithm: string };
  getSelectedCandidatePair?(): { local: { type: string }; remote: { type: string } } | null;
}

export interface RtcModule {
  PeerConnection: new (name: string, config: { iceServers: string[] }) => RtcPeer;
}

/** Load node-datachannel (an optional dependency). Never throws. */
export async function loadRtc(specifier = 'node-datachannel'): Promise<{ rtc: RtcModule } | { error: string }> {
  try {
    const mod = (await import(specifier)) as { PeerConnection?: unknown; default?: { PeerConnection?: unknown } };
    const PeerConnection = mod.PeerConnection ?? mod.default?.PeerConnection;
    if (typeof PeerConnection !== 'function') return { error: `${specifier} has no PeerConnection` };
    return { rtc: { PeerConnection: PeerConnection as RtcModule['PeerConnection'] } };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
    return { error: /Cannot find (package|module)/.test(msg) ? `${specifier} is not installed` : `${specifier} failed to load: ${msg}` };
  }
}

/**
 * `morse.direct` in ~/.morse/config.json → the daemon's direct-link settings; false = off.
 * On by default. `{"enabled": false}` (or `false`) or env MORSE_DIRECT=0/off/false turns it off.
 */
export function directSettings(morse: { direct?: unknown } | undefined, env: Record<string, string | undefined> = process.env): DirectTuning | false {
  if (/^(0|off|false|no)$/i.test(env['MORSE_DIRECT'] ?? '')) return false;
  const d = morse?.direct;
  if (d === false) return false;
  if (!d || typeof d !== 'object') return {};
  const c = d as { enabled?: unknown; stun?: unknown };
  if (c.enabled === false) return false;
  const stun = Array.isArray(c.stun) ? c.stun.filter((x): x is string => typeof x === 'string' && x.length > 0) : null;
  return stun ? { stun } : {};
}

/** How signals travel (ADR-069 step 1: the relay; step 2: the local network). */
export interface SignalChannel {
  /** 'sent' = handed to the peer's live connection; 'offline' = the peer is not there. */
  send(to: string, blob: string): Promise<'sent' | 'offline'>;
}

export interface DirectTuning {
  /** STUN servers (default stun:stun.cloudflare.com:3478). */
  stun?: string[];
  /** How long `send` waits for a new link to open (default 3 s). */
  connectTimeoutMs?: number;
  /** An answering side closes a link that did not open within this (default 15 s). */
  answerTimeoutMs?: number;
  /** A link with no traffic either way for this long is closed (default 5 min). */
  idleTimeoutMs?: number;
  /** After a failed attempt the device is not tried again for this long, doubling (default 5 min)… */
  backoffMs?: number;
  /** …up to this (default 6 h). */
  maxBackoffMs?: number;
  /** The signal channel does not support signaling (an old relay): pause this long (default 1 h). */
  noSignalMs?: number;
  /** Largest envelope over a link (default 4 MiB). */
  maxMessageBytes?: number;
  /** A signal older (or newer) than this is refused (default 2 min). */
  signalMaxAgeMs?: number;
  /** Test hook: the WebRTC module; null = unavailable; default: load node-datachannel. */
  rtc?: RtcModule | null;
}

export interface DirectOptions extends DirectTuning {
  /** The old way (ADR-069): signals are v1 envelopes of this device, sealed to the peer's device key. */
  identity?: DeviceIdentity;
  enc?: EncKey;
  /** The peer's VERIFIED X25519 key (pinned bundle, or fetched and checked). */
  recipientKey?: (id: string) => Promise<Buffer>;
  /**
   * (ADR-091) By address: who this side is (the id the peer knows it by — the tie-break of two offers at once)
   * and how a signal is sealed for / opened from a peer: a v3 envelope signed by our address and sealed to
   * theirs. `open` throws when it does not verify; `nonce` is what tells a replay.
   */
  byAddress?: {
    self: string;
    seal: (to: string, plaintext: Buffer) => Promise<string>;
    open: (from: string, blob: string) => Promise<{ plaintext: Buffer; nonce: string }>;
  };
  /** Known contact / paired device that is not blocked — the only ones we link with. */
  isPeer: (id: string) => boolean;
  signal: SignalChannel;
  /** One whole envelope that arrived over a link (the caller verifies and files it). */
  onMessage: (from: string, blob: string) => void;
  log?: (line: string) => void;
}

export interface DirectLinkInfo {
  id: string;
  state: 'connecting' | 'open';
  role: 'offer' | 'answer';
  since: number;
  lastUsed: number;
  /** Selected ICE candidate types, e.g. "host↔srflx" (open links). */
  path?: string;
}

export interface DirectStatus {
  enabled: boolean;
  /** Why direct links are off (no module, …). */
  reason?: string;
  links: DirectLinkInfo[];
  /** Devices not tried right now, until when (epoch ms). */
  backoff: Array<{ id: string; until: number }>;
  /** The signal channel cannot signal (an old relay) until then. */
  noSignalUntil?: number;
}

export interface DirectLink {
  /** Resolves once the WebRTC module is loaded (or known to be missing). */
  ready(): Promise<void>;
  available(): boolean;
  isOpen(id: string): boolean;
  /**
   * Hand one envelope to `to` over a direct link, opening one if needed (≤ connectTimeoutMs)
   * unless `establish` is false. true = written to an open channel; false = use the relay.
   */
  send(to: string, blob: string, establish?: boolean): Promise<boolean>;
  /** Resolves when the current link to `id` closes (at once when there is none). */
  whenDown(id: string): Promise<void>;
  /** Close the link to `id`; with `backoffMs`, do not try it again for that long. */
  drop(id: string, why: string, backoffMs?: number): void;
  /** A signal from `from` (as the signal channel authenticated it). */
  onSignal(from: string, blob: string): void;
  /** The signal channel came (back) up: signaling may work again. */
  resetSignaling(): void;
  status(): DirectStatus;
  close(): void;
}

interface SignalPlain {
  t: typeof SIGNAL_TAG;
  type: 'offer' | 'answer' | 'candidate';
  session: string;
  ts: number;
  sdp?: string;
  candidate?: string;
  mid?: string;
}

interface Conn {
  peer: string;
  session: string;
  role: 'offer' | 'answer';
  pc: RtcPeer;
  dc: RtcDataChannel | null;
  state: 'connecting' | 'open' | 'closed';
  startedAt: number;
  lastUsed: number;
  remoteSet: boolean;
  pending: Array<[string, string]>;
  remoteFp: { algorithm: string; value: string } | null;
  timer: NodeJS.Timeout | null;
  down: Array<() => void>;
  /** Messages being put together from their fragments, by message number (see onFrame). */
  rx: Map<number, { parts: Array<Buffer | undefined>; count: number; have: number; size: number }>;
  txSeq: number;
  /** Keeps this link's outgoing signals in order (offer before its candidates). */
  chain: Promise<void>;
  /** This offer is the one second try after the first failed the moment it was set up. */
  retry: boolean;
}

/** `a=fingerprint:<alg> <hex>` from an SDP. */
export function sdpFingerprint(sdp: string): { algorithm: string; value: string } | null {
  const m = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/m.exec(sdp);
  return m ? { algorithm: m[1]!.toLowerCase(), value: m[2]!.toUpperCase() } : null;
}

/** One data frame: [type=1][seq u32][index u32][count u32][payload]. */
export function encodeFrames(seq: number, data: Buffer, fragment: number): Buffer[] {
  const count = Math.max(1, Math.ceil(data.length / fragment));
  const out: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const head = Buffer.alloc(HEADER_BYTES);
    head[0] = FRAME_DATA;
    head.writeUInt32BE(seq >>> 0, 1);
    head.writeUInt32BE(i, 5);
    head.writeUInt32BE(count, 9);
    out.push(Buffer.concat([head, data.subarray(i * fragment, (i + 1) * fragment)]));
  }
  return out;
}

/** A call that fails within this long of being started failed "as it was set up": it is tried once more. */
const QUICK_FAILURE_MS = 1000;

/** Messages one link puts together at the same time (each at most maxMessageBytes). */
const MAX_PARTIAL_MESSAGES = 4;

const toBuffer = (m: string | Buffer | ArrayBuffer): Buffer =>
  typeof m === 'string' ? Buffer.from(m, 'utf8') : Buffer.isBuffer(m) ? m : Buffer.from(new Uint8Array(m));

export function startDirect(opts: DirectOptions): DirectLink {
  const log = opts.log ?? (() => undefined);
  const stun = opts.stun ?? DEFAULT_STUN;
  const connectTimeout = opts.connectTimeoutMs ?? 3000;
  const answerTimeout = opts.answerTimeoutMs ?? 15_000;
  const idleTimeout = opts.idleTimeoutMs ?? 5 * 60_000;
  const backoffBase = opts.backoffMs ?? 5 * 60_000;
  const backoffMax = opts.maxBackoffMs ?? 6 * 3600_000;
  const noSignalMs = opts.noSignalMs ?? 3600_000;
  const maxMessage = opts.maxMessageBytes ?? 4 * 1024 * 1024;
  const maxAge = opts.signalMaxAgeMs ?? 120_000;
  const self = opts.byAddress?.self ?? opts.identity!.id;
  const short = (id: string) => id.slice(0, 7);

  let rtc: RtcModule | null = null;
  let reason: string | undefined;
  let closed = false;
  const loading: Promise<void> =
    opts.rtc !== undefined
      ? Promise.resolve().then(() => {
          rtc = opts.rtc ?? null;
          if (!rtc) reason = 'WebRTC module unavailable';
        })
      : loadRtc().then((r) => {
          if ('rtc' in r) rtc = r.rtc;
          else reason = r.error;
        });

  const conns = new Map<string, Conn>();
  /** peer → callbacks waiting for a link to that device to open (true) or give up (false). */
  const openWaiters = new Map<string, Set<(ok: boolean) => void>>();
  const backoff = new Map<string, { until: number; n: number }>();
  let noSignalUntil = 0;
  /** envelope nonce → seen at (replay protection, kept for 2 × maxAge). */
  const seen = new Map<string, number>();
  /** Candidates that came before their offer (the relay may reorder): peer → session → list. */
  const early = new Map<string, { session: string; at: number; list: Array<[string, string]> }>();
  const strangerLogged = new Map<string, number>();

  const notifyOpen = (peer: string, ok: boolean) => {
    const ws = openWaiters.get(peer);
    if (!ws) return;
    openWaiters.delete(peer);
    for (const w of ws) w(ok);
  };

  const backedOff = (peer: string): boolean => (backoff.get(peer)?.until ?? 0) > Date.now();

  const shut = (c: Conn, why: string, o: { backoff?: 'grow' | number; replaced?: boolean; now?: boolean } = {}) => {
    if (c.state === 'closed') return;
    const wasOpen = c.state === 'open';
    c.state = 'closed';
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    const hangUp = () => {
      try {
        c.dc?.close();
      } catch {
        /* already closed */
      }
      try {
        c.pc.close();
      } catch {
        /* already closed */
      }
    };
    // closing from inside a libdatachannel callback: let that callback return first. Not when the
    // whole module stops (`now`): the daemon exits right after — a deferred close never runs, nothing
    // tells the other side, and it waits ~30 s for ICE to give up (seen on Windows, ADR-080 #37).
    // libdatachannel's close() puts the goodbye on the wire before it returns.
    if (o.now) hangUp();
    else setImmediate(hangUp);
    if (conns.get(c.peer) === c) conns.delete(c.peer);
    for (const d of c.down.splice(0)) d();
    if (!o.replaced && !conns.has(c.peer)) notifyOpen(c.peer, false);
    if (o.backoff !== undefined) {
      const prev = backoff.get(c.peer);
      const n = o.backoff === 'grow' ? (prev?.n ?? 0) + 1 : (prev?.n ?? 0);
      const ms = o.backoff === 'grow' ? Math.min(backoffBase * 2 ** (n - 1), backoffMax) : o.backoff;
      backoff.set(c.peer, { until: Date.now() + ms, n });
      log(`direct: ${wasOpen ? 'link to' : 'no link to'} ${short(c.peer)} ${wasOpen ? 'closed' : 'opened'} (${why}) — relay only for this device for ${Math.round(ms / 60_000) || '<1'} min`);
    } else if (!o.replaced || wasOpen) {
      log(`direct: ${wasOpen ? `link to ${short(c.peer)} closed` : `no link to ${short(c.peer)}`} (${why})`);
    }
  };

  const sendSignal = (c: Conn, body: Omit<SignalPlain, 't' | 'session' | 'ts'>) => {
    c.chain = c.chain
      .then(async () => {
        if (c.state === 'closed') return;
        const plain: SignalPlain = { t: SIGNAL_TAG, session: c.session, ts: Date.now(), ...body };
        const bytes = Buffer.from(JSON.stringify(plain));
        const blob = opts.byAddress ? await opts.byAddress.seal(c.peer, bytes) : JSON.stringify(seal({ identity: opts.identity!, recipientId: c.peer, recipientEncPub: await opts.recipientKey!(c.peer), plaintext: bytes }));
        // not awaited: the next signal goes out right behind this one, in order
        opts.signal.send(c.peer, blob).then(
          (r) => {
            // (a late candidate of a link that is already open changes nothing: the link stays)
            if (r === 'offline' && c.state !== 'open') shut(c, 'the other side is offline');
          },
          (e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            // (ADR-091) the relay went away after the link opened: the link does not need it any more
            if (c.state === 'open') return;
            if (/unknown request/.test(msg)) {
              noSignalUntil = Date.now() + noSignalMs;
              shut(c, 'the relay does not forward signaling yet');
            } else shut(c, `signaling failed: ${msg}`);
          },
        );
      })
      .catch((e: unknown) => shut(c, `cannot seal a signal: ${e instanceof Error ? e.message : String(e)}`));
  };

  const write = (c: Conn, blob: string): boolean => {
    const dc = c.dc;
    if (c.state !== 'open' || !dc || !dc.isOpen()) return false;
    const data = Buffer.from(blob, 'utf8');
    if (data.length > maxMessage) return false;
    const fragment = Math.max(1024, Math.min((dc.maxMessageSize() || 65_536) - HEADER_BYTES, 65_536));
    try {
      for (const f of encodeFrames(c.txSeq, data, fragment)) dc.sendMessageBinary(f);
    } catch (e) {
      shut(c, `send failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    c.txSeq = (c.txSeq + 1) >>> 0;
    c.lastUsed = Date.now();
    return true;
  };

  const onFrame = (c: Conn, raw: string | Buffer | ArrayBuffer) => {
    if (c.state !== 'open') return;
    const m = toBuffer(raw);
    c.lastUsed = Date.now();
    if (m.length < HEADER_BYTES || m[0] !== FRAME_DATA) return;
    const seq = m.readUInt32BE(1);
    const index = m.readUInt32BE(5);
    const count = m.readUInt32BE(9);
    const bad = (why: string) => {
      c.rx.delete(seq);
      log(`direct: dropped a malformed message from ${short(c.peer)} (${why})`);
    };
    if (count < 1 || count > Math.ceil(maxMessage / 1024) + 1) return bad('fragment count');
    if (index >= count) return bad('fragment index');
    // Each fragment says which message it belongs to and where it goes, and that is what
    // decides — not the order the frames are handed to us. The channel is reliable and
    // ordered, but node-datachannel's message callbacks can arrive swapped under load
    // (seen: … f3 f5 f4 f6 …); putting them together by arrival order lost the message.
    let rx = c.rx.get(seq);
    if (!rx) {
      // a few messages may be in the air at once; the oldest unfinished one makes room
      if (c.rx.size >= MAX_PARTIAL_MESSAGES) {
        const oldest = c.rx.keys().next().value as number;
        c.rx.delete(oldest);
        log(`direct: dropped an unfinished message from ${short(c.peer)} (too many at once)`);
      }
      rx = { parts: new Array<Buffer | undefined>(count), count, have: 0, size: 0 };
      c.rx.set(seq, rx);
    }
    if (rx.count !== count) return bad('fragment count changed');
    if (rx.parts[index] !== undefined) return bad('fragment twice');
    rx.parts[index] = m.subarray(HEADER_BYTES);
    rx.have++;
    rx.size += m.length - HEADER_BYTES;
    if (rx.size > maxMessage) return bad('too large');
    if (rx.have < count) return;
    c.rx.delete(seq);
    const blob = Buffer.concat(rx.parts as Buffer[]).toString('utf8');
    try {
      opts.onMessage(c.peer, blob);
    } catch (e) {
      log(`direct: inbound from ${short(c.peer)} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onOpen = (c: Conn) => {
    if (c.state !== 'connecting') return;
    // defense in depth (ADR-069): the DTLS certificate must be the one the signed SDP named
    let actual: { value: string; algorithm: string } | null = null;
    try {
      actual = c.pc.remoteFingerprint();
    } catch {
      actual = null;
    }
    const want = c.remoteFp;
    if (!want || !actual || actual.algorithm.toLowerCase() !== want.algorithm || actual.value.toUpperCase() !== want.value) {
      shut(c, 'DTLS fingerprint does not match the signed SDP', { backoff: 'grow' });
      return;
    }
    c.state = 'open';
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.lastUsed = Date.now();
    backoff.delete(c.peer);
    let path = '';
    try {
      const p = c.pc.getSelectedCandidatePair?.();
      if (p) path = `${p.local.type}↔${p.remote.type}, `;
    } catch {
      /* not available */
    }
    log(`direct: link to ${short(c.peer)} open (${path}${Date.now() - c.startedAt} ms, ${c.role === 'offer' ? 'we called' : 'they called'})`);
    notifyOpen(c.peer, true);
  };

  const wireChannel = (c: Conn, dc: RtcDataChannel) => {
    if (c.dc && c.dc !== dc) {
      try {
        dc.close();
      } catch {
        /* ignore */
      }
      return;
    }
    c.dc = dc;
    dc.onOpen(() => onOpen(c));
    dc.onClosed(() => shut(c, 'closed by the other side'));
    dc.onError((err) => shut(c, `channel error: ${err}`));
    dc.onMessage((m) => {
      // The other side writes the moment ITS end is open, and the callbacks are queued
      // separately: the first frames can get here before our `open` callback does. Data on
      // the channel means it is open — run the open checks (the DTLS fingerprint) now;
      // dropping those frames would lose the message (and every later fragment of it).
      if (c.state === 'connecting') onOpen(c);
      onFrame(c, m);
    });
    if (dc.isOpen()) onOpen(c);
  };

  const newConn = (peer: string, role: 'offer' | 'answer', session: string): Conn => {
    const r = rtc!;
    const pc = new r.PeerConnection(`morse-${short(peer)}`, { iceServers: stun });
    const c: Conn = {
      peer,
      session,
      role,
      pc,
      dc: null,
      state: 'connecting',
      startedAt: Date.now(),
      lastUsed: Date.now(),
      remoteSet: false,
      pending: [],
      remoteFp: null,
      timer: null,
      down: [],
      rx: new Map(),
      txSeq: 0,
      chain: Promise.resolve(),
      retry: false,
    };
    conns.set(peer, c);
    pc.onLocalDescription((sdp, type) => {
      const t = String(type).toLowerCase();
      if (t === 'offer' || t === 'answer') sendSignal(c, { type: t, sdp });
    });
    pc.onLocalCandidate((candidate, mid) => sendSignal(c, { type: 'candidate', candidate, mid }));
    pc.onStateChange((state) => {
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        const ourCallFailed = c.state === 'connecting' && c.role === 'offer' && state === 'failed';
        // Now and then a link fails the instant it is set up (seen on loopback: ICE completes, then the
        // transport closes at once — about 1 call in 3000). That says nothing about the path, and
        // the next call opens: call once more, inside the time the sender is already waiting,
        // instead of doing without a direct link to this device for the next 5 minutes.
        if (ourCallFailed && !c.retry && !closed && Date.now() - c.startedAt < QUICK_FAILURE_MS) {
          shut(c, `connection ${state}`, { replaced: true });
          log(`direct: the link to ${short(c.peer)} failed as it was set up (${Date.now() - c.startedAt} ms) — calling once more`);
          try {
            startOffer(c.peer).retry = true;
          } catch (e) {
            log(`direct: cannot start a link to ${short(c.peer)}: ${e instanceof Error ? e.message : String(e)}`);
            notifyOpen(c.peer, false);
          }
          return;
        }
        shut(c, `connection ${state}`, ourCallFailed ? { backoff: 'grow' } : {});
      }
    });
    return c;
  };

  const flush = (c: Conn) => {
    const queued = early.get(c.peer);
    if (queued && queued.session === c.session) {
      c.pending.push(...queued.list);
      early.delete(c.peer);
    }
    for (const [cand, mid] of c.pending.splice(0)) {
      try {
        c.pc.addRemoteCandidate(cand, mid);
      } catch {
        /* a candidate libdatachannel cannot use */
      }
    }
  };

  const startOffer = (peer: string): Conn => {
    const c = newConn(peer, 'offer', randomBytes(16).toString('hex'));
    wireChannel(c, c.pc.createDataChannel('morse'));
    return c;
  };

  const waitOpen = (peer: string, ms: number): Promise<boolean> => {
    if (conns.get(peer)?.state === 'open') return Promise.resolve(true);
    return new Promise((resolve) => {
      const set = openWaiters.get(peer) ?? new Set<(ok: boolean) => void>();
      openWaiters.set(peer, set);
      const done = (ok: boolean) => {
        clearTimeout(t);
        set.delete(done);
        resolve(ok);
      };
      const t = setTimeout(() => done(false), ms);
      set.add(done);
    });
  };

  const handleSignal = async (from: string, blob: string): Promise<void> => {
    await loading;
    if (!rtc || closed) return;
    const drop = (why: string) => log(`direct: dropped a signal from ${short(from)} — ${why}`);
    let env: SealedEnvelope | null = null;
    if (!opts.byAddress) {
      try {
        env = JSON.parse(blob) as SealedEnvelope;
      } catch {
        return drop('not an envelope');
      }
      if (!env || env.from !== from) return drop('envelope sender differs from the channel sender');
    }
    if (!opts.isPeer(from)) {
      // strangers (message requests) never get a direct link; logged at most every 10 min
      if (Date.now() - (strangerLogged.get(from) ?? 0) > 600_000) {
        strangerLogged.set(from, Date.now());
        if (strangerLogged.size > 1000) strangerLogged.clear();
        drop('not a contact or paired device here');
      }
      return;
    }
    let p: SignalPlain;
    let nonce: string;
    try {
      if (opts.byAddress) {
        // (ADR-091) a v3 envelope: signed by the address it says, sealed to ours — `open` checks both
        const o = await opts.byAddress.open(from, blob);
        p = JSON.parse(o.plaintext.toString('utf8')) as SignalPlain;
        nonce = o.nonce;
      } else {
        p = JSON.parse(open(env!, { id: self, enc: opts.enc! }).plaintext.toString('utf8')) as SignalPlain;
        nonce = env!.nonce;
      }
    } catch (e) {
      return drop(`does not verify (${e instanceof Error ? e.message : String(e)})`);
    }
    if (p?.t !== SIGNAL_TAG || typeof p.session !== 'string' || !/^[0-9a-f]{32}$/.test(p.session)) return drop('not a direct-link signal');
    if (typeof p.ts !== 'number' || Math.abs(Date.now() - p.ts) > maxAge) return drop('stale (clock skew or replay)');
    if (seen.has(nonce)) return drop('replayed');
    seen.set(nonce, Date.now());

    const cur = conns.get(from);
    if (p.type === 'offer' && typeof p.sdp === 'string') {
      if (cur?.session === p.session) return; // duplicate
      if (cur && cur.state === 'connecting' && cur.role === 'offer') {
        // both called at once: the smaller device ID keeps its own offer
        if (self < from) return;
        shut(cur, 'they called at the same time', { replaced: true });
      } else if (cur) {
        shut(cur, 'replaced by a new link from the other side', { replaced: true });
      }
      const fp = sdpFingerprint(p.sdp);
      if (!fp) return drop('offer without a DTLS fingerprint');
      const c = newConn(from, 'answer', p.session);
      c.remoteFp = fp;
      c.pc.onDataChannel((dc) => wireChannel(c, dc));
      c.timer = setTimeout(() => shut(c, `did not open within ${Math.round(answerTimeout / 1000)} s`), answerTimeout);
      c.timer.unref?.();
      try {
        c.pc.setRemoteDescription(p.sdp, 'offer');
      } catch (e) {
        return shut(c, `bad offer: ${e instanceof Error ? e.message : String(e)}`);
      }
      c.remoteSet = true;
      flush(c);
      return;
    }
    if (p.type === 'answer' && typeof p.sdp === 'string') {
      if (!cur || cur.session !== p.session || cur.role !== 'offer' || cur.remoteSet) return;
      const fp = sdpFingerprint(p.sdp);
      if (!fp) return shut(cur, 'answer without a DTLS fingerprint');
      cur.remoteFp = fp;
      try {
        cur.pc.setRemoteDescription(p.sdp, 'answer');
      } catch (e) {
        return shut(cur, `bad answer: ${e instanceof Error ? e.message : String(e)}`);
      }
      cur.remoteSet = true;
      flush(cur);
      return;
    }
    if (p.type === 'candidate' && typeof p.candidate === 'string') {
      const mid = typeof p.mid === 'string' ? p.mid : '0';
      if (cur && cur.session === p.session) {
        if (cur.remoteSet) {
          try {
            cur.pc.addRemoteCandidate(p.candidate, mid);
          } catch {
            /* unusable candidate */
          }
        } else if (cur.pending.length < 64) cur.pending.push([p.candidate, mid]);
        return;
      }
      // before its offer: keep a few for a short while
      const q = early.get(from);
      if (!q || q.session !== p.session) early.set(from, { session: p.session, at: Date.now(), list: [[p.candidate, mid]] });
      else if (q.list.length < 64) q.list.push([p.candidate, mid]);
    }
  };

  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const c of [...conns.values()]) if (c.state === 'open' && now - c.lastUsed >= idleTimeout) shut(c, 'idle');
      for (const [n, at] of seen) if (now - at > 2 * maxAge) seen.delete(n);
      for (const [p, q] of early) if (now - q.at > 30_000) early.delete(p);
      for (const [p, b] of backoff) if (b.until <= now && now - b.until > backoffMax) backoff.delete(p);
    },
    Math.max(50, Math.min(idleTimeout / 4, 30_000)),
  );
  sweep.unref?.();

  return {
    ready: () => loading,
    available: () => Boolean(rtc) && !closed,
    isOpen: (id) => conns.get(id)?.state === 'open',
    async send(to, blob, establish = true) {
      await loading;
      if (!rtc || closed || !opts.isPeer(to)) return false;
      let c = conns.get(to);
      if (c?.state === 'open') return write(c, blob);
      if (!establish) return false;
      if (!c) {
        if (backedOff(to) || noSignalUntil > Date.now()) return false;
        try {
          c = startOffer(to);
        } catch (e) {
          log(`direct: cannot start a link to ${short(to)}: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      }
      const ok = await waitOpen(to, connectTimeout);
      const now = conns.get(to);
      if (!ok) {
        if (now && now.state === 'connecting' && now.role === 'offer') shut(now, `did not open within ${(connectTimeout / 1000).toFixed(1)} s`, { backoff: 'grow' });
        return false;
      }
      return now ? write(now, blob) : false;
    },
    whenDown(id) {
      const c = conns.get(id);
      if (!c || c.state === 'closed') return Promise.resolve();
      return new Promise((resolve) => c.down.push(resolve));
    },
    drop(id, why, backoffMs) {
      const c = conns.get(id);
      if (c) shut(c, why, backoffMs !== undefined ? { backoff: backoffMs } : {});
      else if (backoffMs !== undefined) backoff.set(id, { until: Date.now() + backoffMs, n: backoff.get(id)?.n ?? 0 });
    },
    onSignal(from, blob) {
      handleSignal(from, blob).catch((e: unknown) => log(`direct: signal from ${short(from)} failed: ${e instanceof Error ? e.message : String(e)}`));
    },
    resetSignaling() {
      noSignalUntil = 0;
    },
    status() {
      const now = Date.now();
      const links: DirectLinkInfo[] = [...conns.values()]
        .filter((c) => c.state !== 'closed')
        .map((c) => {
          let path: string | undefined;
          if (c.state === 'open') {
            try {
              const p = c.pc.getSelectedCandidatePair?.();
              if (p) path = `${p.local.type}↔${p.remote.type}`;
            } catch {
              /* not available */
            }
          }
          return { id: c.peer, state: c.state as 'connecting' | 'open', role: c.role, since: c.startedAt, lastUsed: c.lastUsed, ...(path ? { path } : {}) };
        });
      return {
        enabled: Boolean(rtc) && !closed,
        ...(reason ? { reason } : closed ? { reason: 'stopped' } : {}),
        links,
        backoff: [...backoff].filter(([, b]) => b.until > now).map(([id, b]) => ({ id, until: b.until })),
        ...(noSignalUntil > now ? { noSignalUntil } : {}),
      };
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      for (const c of [...conns.values()]) shut(c, 'stopped', { now: true });
      for (const p of [...openWaiters.keys()]) notifyOpen(p, false);
    },
  };
}
