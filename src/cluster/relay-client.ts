import { randomBytes, sign, createPrivateKey, X509Certificate } from 'node:crypto';
import WebSocket from 'ws';
import type { DeviceIdentity } from './identity.js';
import type { KeyBundle } from './e2e.js';
import { signAs, type AddressKey } from '../identity/address-key.js';
import { looksLikeAddress } from '../identity/address.js';
import type { PrekeyRecord } from '../identity/prekeys.js';

/**
 * Client side of the Morse relay protocol (relay-cf/src/protocol.ts): one
 * long-lived WebSocket per daemon, auto-reconnecting with backoff. Login = sign the
 * relay's random challenge with the device key; the relay only admits device IDs on
 * its allowlist. The relay FORWARDS and never stores: `send` tells us whether the
 * recipient had a live socket ('sent') or not ('offline'); either way the caller's
 * outbox is the source of truth until the recipient's end-to-end receipt arrives.
 * Everything that goes through here is already end-to-end encrypted (e2e.ts).
 */

export const LOGIN_CONTEXT = 'morse-relay-login-v1';
/** ADR-073: one address logging in on a v3 connection signs this, the nonce and its address. */
export const LOGIN_V3_CONTEXT = 'morse-relay-login-v3';

/** ADR-073: an address this computer hosts, as it logs in over v3. */
export interface V3Login {
  key: AddressKey;
  prekey: PrekeyRecord;
  /** ADR-081: what this client can do for the address (`addr1` = it takes v3 envelopes without a
   *  device certificate and handles them by address). Published with the login; none = as before. */
  caps?: string[];
}

/** ADR-081: this client receives v3 envelopes that carry no device certificate and handles them by address. */
export const CAP_ADDR1 = 'addr1';

/** ADR-077: one entry of the relay's frozen old-alias table: an old v2 name → the address of that agent. */
export interface AliasEntry {
  /** `handle` (the handle's default agent) or `handle/agent`. */
  name: string;
  address: string;
  agent: string;
  default?: boolean;
}

/** ADR-073: what the relay says about an address (unverified — the caller checks key and prekey). */
export interface AddressInfo {
  address: string;
  key: string | null;
  prekey: PrekeyRecord | null;
  online: boolean;
  /** ADR-081: the capabilities that address's client published ([] = none, or a relay from before caps). */
  caps: string[];
}

/** ADR-073: a v3 send — pushed live, kept in the offline mailbox, or (store:false) not kept. */
export interface V3SendResult {
  r: 'sent' | 'stored' | 'offline';
  expiresAt?: number;
}

/** ADR-073: an envelope `from` sent to `to` expired unread in the relay's offline mailbox. */
export interface Undeliverable {
  from: string;
  to: string;
  ref: string;
  ts: number;
}

export interface RelayDelivery {
  /** Relay-assigned id of this forward (logging only — nothing to ack). */
  id: string;
  from: string;
  /** The sender's handle per the relay's allowlist (absent on older relays). */
  fromHandle?: string;
  blob: string;
  ts: number;
  /** ADR-069: it came over a direct WebRTC link (from = the link's verified peer), not the relay.
   *  (ADR-091) 'lan' = handed over on the LAN by address (from = the address that signed it). */
  via?: 'direct' | 'lan';
  /** ADR-073 (v3): the address it was sent to (one of ours). */
  to?: string;
  /** ADR-073 (v3): the sender's opaque reference (its message id). */
  ref?: string;
  /** ADR-073 (v3): it waited in the relay's offline mailbox — ack it once handled. */
  stored?: boolean;
}

/** ADR-069: a WebRTC signal pushed by the relay (an end-to-end sealed envelope). */
export interface RelaySignal {
  from: string;
  fromHandle?: string;
  blob: string;
  ts: number;
}

export interface RelayLimits {
  maxBlobBytes: number;
  ratePerMinute: number;
}

export interface HandleDevice {
  id: string;
  name: string;
  bundle: KeyBundle | null;
}

/** Agent directory answer (ADR-033): the one device hosting morse.im/<handle>/<agent>. */
export interface AgentLocation {
  handle: string;
  /** The resolved agent name (for "no agent": the person's default). */
  agent: string;
  device: HandleDevice;
}

export interface RelayClientOptions {
  url: string;
  identity: DeviceIdentity;
  bundle: KeyBundle;
  /** Process one inbound blob (verify, decrypt, file). */
  onDeliver: (d: RelayDelivery) => Promise<void>;
  /** ADR-069: a WebRTC signal for this device (offer / answer / candidate, sealed). */
  onSignal?: (s: RelaySignal) => void;
  /** Called after every successful login (first connect and each reconnect). */
  onConnected?: () => void;
  /** Lookup-only connection (never "online", receives nothing) — `morse pair add <handle>`. */
  passive?: boolean;
  /** ADR-073: speak protocol 3 at /v3/ws/<first address>, logging in all these addresses. */
  v3?: { logins: () => V3Login[] };
  /** ADR-073: an envelope we left in the relay's offline mailbox expired unread. */
  onUndeliverable?: (n: Undeliverable) => void;
  /** A handle's display nickname as the relay states it (ADR-036): at login for our own
   *  handle, and with every directory answer. null = that handle has none. */
  onNickname?: (handle: string, nickname: string | null, self: boolean) => void;
  log?: (line: string) => void;
  /** Reconnect backoff bounds. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  /** One connection attempt (TCP + TLS + upgrade + login) must reach `welcome` within this (default 20 s). */
  connectTimeoutMs?: number;
  /** Liveness (ADR-043): a WebSocket ping this often while logged in (default 20 s)… */
  pingIntervalMs?: number;
  /** …and the connection counts as dead when nothing at all came back for this long (default 45 s). */
  livenessTimeoutMs?: number;
  /** Watchdog: not logged in and no connection attempt started for this long → start one (default 3 min). */
  watchdogMs?: number;
  /** Test hook: open the socket (default: `new WebSocket(url, …)`). */
  createSocket?: (url: string) => WebSocket;
}

/** What `morse status` shows about the relay connection (ADR-043). */
export interface RelayState {
  connected: boolean;
  /** Last successful login (epoch ms), null = never in this daemon run. */
  lastConnectedAt: number | null;
  /** Logged out since (epoch ms); null while connected. */
  disconnectedSince: number | null;
  /** Start of the latest connection attempt (epoch ms). */
  lastAttemptAt: number | null;
  /** Failed attempts since the last login. */
  failures: number;
  /** Why the last attempt or connection ended. */
  lastError: string | null;
}

export interface RelayClient {
  /** The relay URL in use (the configured one). */
  readonly url: string;
  connected(): boolean;
  /** Connection history for status output (ADR-043). */
  state?(): RelayState;
  /** This device's handle on the relay (from the allowlist), once logged in. */
  handle(): string | null;
  /** Caps announced by the relay at login (defaults until then). */
  limits(): RelayLimits;
  /** ADR-073: protocol versions the relay announced at login ([2] when it said nothing). */
  protocols?(): number[];
  /** ADR-073 (v3 connection): send a sealed envelope to an address. */
  sendV3?(to: string, blob: string, opts?: { ref?: string; store?: boolean; from?: string }): Promise<V3SendResult>;
  /** ADR-073 (v3 connection): an address's key, signed prekey and whether it is online. */
  lookupAddress?(address: string): Promise<AddressInfo>;
  /** ADR-077 (v3 connection): the frozen old aliases under `handle` (all of its agents, default first)
   *  or the one for `handle/agent`. Rejects when the relay has no alias query (an older relay). */
  lookupAlias?(name: string): Promise<AliasEntry[]>;
  /** ADR-073 (v3 connection): publish a rotated prekey. */
  publishPrekey?(address: string, prekey: PrekeyRecord): Promise<void>;
  /** ADR-073 (v3 connection): stored deliveries of `to` were handled — the relay deletes them. */
  ack?(to: string, ids: string[]): void;
  /** 'sent' = pushed to the recipient's live socket; 'offline' = nobody there (keep it in your outbox). */
  send(to: string, blob: string): Promise<'sent' | 'offline'>;
  /** ADR-069: forward a WebRTC signal. 'sent' = pushed to the recipient's live socket.
   *  Rejects with "relay: unknown request" on a relay that predates signaling. */
  signal?(to: string, blob: string): Promise<'sent' | 'offline'>;
  /** The recipient's key bundle from the relay directory (unverified — caller verifies). */
  bundle(id: string): Promise<KeyBundle | null>;
  /** Directory lookup: a person's handle → their devices (bundles unverified). */
  lookupHandle(handle: string): Promise<HandleDevice[]>;
  /** Agent directory: which ONE device hosts morse.im/<handle>/<agent> (no agent =
   *  the person's default agent). null = no such agent. Bundle unverified. */
  resolveAgent(handle: string, agent?: string): Promise<AgentLocation | null>;
  /** Wait up to `ms` for a logged-in connection. */
  waitConnected(ms: number): Promise<boolean>;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Default cap when the relay has not told us yet (the Cloudflare build announces 1,000,000). */
export const DEFAULT_RELAY_LIMITS: RelayLimits = { maxBlobBytes: 1_000_000, ratePerMinute: 120 };

export function signChallenge(identity: DeviceIdentity, nonce: string): string {
  return sign(null, Buffer.from(`${LOGIN_CONTEXT}\n${nonce}`), createPrivateKey(identity.keyPem)).toString('base64');
}

/** ws(s)://host[/base] → ws(s)://host[/base]/v3/ws/<address> (ADR-073) */
export function relayV3SocketUrl(base: string, address: string): string {
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/v3/ws/${encodeURIComponent(address)}`;
  return u.toString();
}

/** The v3 hello: every address signs the challenge (ADR-073). */
export function v3Hello(logins: V3Login[], nonce: string): Record<string, unknown> {
  return {
    type: 'hello',
    v: 3,
    addresses: logins.map((l) => ({
      address: l.key.address,
      key: l.key.publicKey.toString('base64'),
      sig: signAs(l.key, `${LOGIN_V3_CONTEXT}\n${nonce}\n${l.key.address}`).toString('base64'),
      prekey: l.prekey,
      ...(l.caps?.length ? { caps: l.caps } : {}),
    })),
  };
}

/** ws(s)://host[/base] → ws(s)://host[/base]/v1/ws/<device id> */
export function relaySocketUrl(base: string, deviceId: string): string {
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/v1/ws/${encodeURIComponent(deviceId)}`;
  return u.toString();
}

export function startRelayClient(opts: RelayClientOptions): RelayClient {
  const log = opts.log ?? (() => undefined);
  const minBackoff = opts.minBackoffMs ?? 1000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const requestTimeout = opts.requestTimeoutMs ?? 15_000;
  const connectTimeout = opts.connectTimeoutMs ?? 20_000;
  const pingInterval = opts.pingIntervalMs ?? 20_000;
  const livenessTimeout = opts.livenessTimeoutMs ?? 45_000;
  const watchdogMs = opts.watchdogMs ?? 3 * 60_000;
  const createSocket =
    opts.createSocket ?? ((u: string) => new WebSocket(u, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: connectTimeout }));
  const certB64 = new X509Certificate(opts.identity.certPem).raw.toString('base64');

  let ws: WebSocket | null = null;
  let ready = false;
  let closed = false;
  let handle: string | null = null;
  let limits: RelayLimits = DEFAULT_RELAY_LIMITS;
  let protocols: number[] = [2];
  const v3 = opts.v3;
  const v3Primary = () => v3?.logins()[0]?.key.address ?? '';
  let backoff = minBackoff;
  let reconnectTimer: NodeJS.Timeout | null = null;
  /** Ends the current attempt / connection without retrying (set while one exists). */
  let teardown: (() => void) | null = null;
  const st: RelayState = { connected: false, lastConnectedAt: null, disconnectedSince: Date.now(), lastAttemptAt: null, failures: 0, lastError: null };
  const pending = new Map<string, Pending>();
  const waiters = new Set<() => void>();
  const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

  const failAll = (why: string) => {
    for (const [rid, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      pending.delete(rid);
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
    reconnectTimer.unref?.();
    backoff = Math.min(backoff * 2, maxBackoff);
  };

  // ADR-043: every attempt ends — by `welcome`, by its own timeout, or by a close — and
  // every end schedules the next attempt. Nothing waits on the socket library to emit
  // 'close' (a stalled TLS / proxy connection may never do so); the watchdog below
  // restarts the loop should it still stall.
  const connect = () => {
    if (closed) return;
    teardown?.();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    st.lastAttemptAt = Date.now();
    const url = opts.url;
    let sock: WebSocket;
    try {
      sock = createSocket(v3 ? relayV3SocketUrl(url, v3Primary()) : relaySocketUrl(url, opts.identity.id));
    } catch (e) {
      st.failures++;
      st.lastError = e instanceof Error ? e.message : String(e);
      log(`relay: cannot open a connection to ${url}: ${st.lastError}`);
      scheduleReconnect();
      return;
    }
    ws = sock;
    let over = false;
    let error: string | null = null;
    let lastHeard = Date.now();
    let lastPingAt = 0;
    let pingTimer: NodeJS.Timeout | null = null;

    /** End this attempt / connection once; `retry` = schedule the next attempt. */
    const end = (why: string, retry: boolean, code?: number, reason?: string) => {
      if (over) return;
      over = true;
      clearTimeout(connectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (teardown === stop) teardown = null;
      if (ws === sock) ws = null;
      try {
        // shutting down: a clean close; anything else: drop it now (it may be half-open)
        if (closed && sock.readyState === WebSocket.OPEN) sock.close();
        else if (sock.readyState !== WebSocket.CLOSED) sock.terminate();
      } catch {
        /* already gone */
      }
      const was = ready;
      ready = false;
      st.connected = false;
      if (was) st.disconnectedSince = Date.now();
      st.lastError = why;
      failAll('relay connection closed');
      if (closed || !retry) return;
      if (code !== undefined && (was || code === 4003)) {
        log(`relay: disconnected (${code}${reason ? ` ${reason}` : ''})${code === 4003 ? ' — this device is not on the relay allowlist' : ''}`);
      }
      if (!was) {
        st.failures++;
        // the first failure, then the 2nd, 4th, 8th … in a row: visible without flooding the log
        if (code !== 4003 && (st.failures & (st.failures - 1)) === 0) {
          log(`relay: cannot connect to ${url} (${why}) — ${st.failures} failed attempt(s) in a row, retrying (backoff up to ${secs(maxBackoff)})`);
        }
      }
      scheduleReconnect();
    };
    const stop = () => end('replaced by a new connection attempt', false);
    teardown = stop;
    const connectTimer = setTimeout(() => end(`no login within ${secs(connectTimeout)}`, true), connectTimeout);
    connectTimer.unref?.();

    sock.on('message', (raw) => {
      if (over) return;
      lastHeard = Date.now();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg['type']) {
        case 'challenge':
          if (v3) {
            sock.send(JSON.stringify(v3Hello(v3.logins(), String(msg['nonce']))));
            return;
          }
          sock.send(
            JSON.stringify({
              type: 'hello',
              cert: certB64,
              sig: signChallenge(opts.identity, String(msg['nonce'])),
              bundle: opts.bundle,
              ...(opts.passive ? { passive: true } : {}),
            }),
          );
          return;
        case 'welcome': {
          clearTimeout(connectTimer);
          ready = true;
          backoff = minBackoff;
          st.connected = true;
          st.lastConnectedAt = Date.now();
          st.disconnectedSince = null;
          st.failures = 0;
          st.lastError = null;
          handle = typeof msg['handle'] === 'string' ? msg['handle'] : null;
          // (ADR-081, ADR-081 review F3) an old name never has the shape of an address: a relay that says ours does is not believed
          if (handle && looksLikeAddress(handle)) {
            log(`relay: ${url} says your old name is ${handle}, which has the shape of an address — ignored (no old name is used)`);
            handle = null;
          }
          protocols = Array.isArray(msg['protocols']) ? (msg['protocols'] as unknown[]).filter((p): p is number => typeof p === 'number') : [2];
          // only when the relay states it (an older relay, or the Node one, says nothing: keep what we have)
          if (handle && !opts.passive && 'nickname' in msg) opts.onNickname?.(handle, typeof msg['nickname'] === 'string' ? msg['nickname'] : null, true);
          const l = msg['limits'] as Partial<RelayLimits> | undefined;
          limits = {
            maxBlobBytes: typeof l?.maxBlobBytes === 'number' && l.maxBlobBytes > 0 ? l.maxBlobBytes : DEFAULT_RELAY_LIMITS.maxBlobBytes,
            ratePerMinute: typeof l?.ratePerMinute === 'number' && l.ratePerMinute > 0 ? l.ratePerMinute : DEFAULT_RELAY_LIMITS.ratePerMinute,
          };
          // Liveness (ADR-043): a protocol ping every interval — answered by the relay's
          // runtime without waking its Durable Object. Only after a ping went unanswered is a
          // JSON ping sent as a second probe (relay-cf answers it by auto-response, also
          // without waking it). Nothing at all for livenessTimeout = the socket is dead.
          pingTimer = setInterval(() => {
            const silent = Date.now() - lastHeard;
            if (silent >= livenessTimeout) {
              log(`relay: no answer from ${url} for ${secs(silent)} — connection is dead, reconnecting`);
              end(`no answer for ${secs(silent)}`, true, 1006);
              return;
            }
            try {
              if (lastPingAt && lastHeard < lastPingAt) sock.send('{"type":"ping"}');
              sock.ping();
              lastPingAt = Date.now();
            } catch {
              /* the close event or the liveness check deals with it */
            }
          }, pingInterval);
          pingTimer.unref?.();
          log(
            v3
              ? `relay: v3 connected to ${url} as ${v3Primary().slice(0, 7)}${v3.logins().length > 1 ? ` (+${v3.logins().length - 1} address(es))` : ''}`
              : `relay: connected to ${url} as ${opts.identity.id.slice(0, 7)}${handle ? ` (morse handle: ${handle})` : ''} — max ${limits.maxBlobBytes} bytes/envelope`,
          );
          for (const w of waiters) w();
          waiters.clear();
          opts.onConnected?.();
          return;
        }
        case 'deliver': {
          const d: RelayDelivery = {
            id: String(msg['id']),
            from: String(msg['from']),
            ...(typeof msg['fromHandle'] === 'string' ? { fromHandle: msg['fromHandle'] } : {}),
            blob: String(msg['blob']),
            ts: Number(msg['ts']),
            ...(typeof msg['to'] === 'string' ? { to: msg['to'] } : {}),
            ...(typeof msg['ref'] === 'string' ? { ref: msg['ref'] } : {}),
            ...(msg['stored'] === true ? { stored: true } : {}),
          };
          opts.onDeliver(d).catch((e: unknown) => log(`relay: inbound ${d.id} failed: ${e instanceof Error ? e.message : String(e)}`));
          return;
        }
        case 'signal': {
          if (typeof msg['from'] !== 'string' || typeof msg['blob'] !== 'string') return;
          const sig: RelaySignal = {
            from: msg['from'],
            ...(typeof msg['fromHandle'] === 'string' ? { fromHandle: msg['fromHandle'] } : {}),
            blob: msg['blob'],
            ts: Number(msg['ts']) || Date.now(),
          };
          try {
            opts.onSignal?.(sig);
          } catch (e) {
            log(`relay: signal from ${sig.from.slice(0, 7)} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          return;
        }
        case 'undeliverable': {
          if (typeof msg['ref'] === 'string' && typeof msg['to'] === 'string') {
            opts.onUndeliverable?.({ from: String(msg['from'] ?? ''), to: msg['to'], ref: msg['ref'], ts: Number(msg['ts']) || Date.now() });
          }
          return;
        }
        case 'nickname': {
          // pushed when any computer of OUR handle changes the nickname (ADR-036)
          if (handle && msg['handle'] === handle) opts.onNickname?.(handle, typeof msg['nickname'] === 'string' && msg['nickname'] ? msg['nickname'] : null, true);
          return;
        }
        case 'sent':
        case 'stored':
        case 'address':
        case 'alias':
        case 'prekey':
        case 'signaled':
        case 'offline':
        case 'bundle':
        case 'handle':
        case 'agent':
        case 'error': {
          const rid = typeof msg['rid'] === 'string' ? msg['rid'] : null;
          const p = rid ? pending.get(rid) : undefined;
          if (p && rid) {
            clearTimeout(p.timer);
            pending.delete(rid);
            if (msg['type'] === 'error') p.reject(new Error(`relay: ${String(msg['error'])}`));
            else p.resolve(msg);
          } else if (msg['type'] === 'error') {
            log(`relay: ${String(msg['error'])}`);
          }
          return;
        }
        default:
          return; // 'pong' (counted above) and anything newer
      }
    });
    sock.on('pong', () => {
      lastHeard = Date.now();
    });
    sock.on('close', (code, reason) => end(error ?? `closed (${code})`, true, code, reason?.length ? reason.toString() : ''));
    sock.on('error', (e) => {
      // 'close' follows — and the attempt timeout covers a socket that never closes
      error = e instanceof Error ? e.message : String(e);
    });
  };

  // ADR-043 watchdog: not logged in and no attempt started for watchdogMs → start one.
  const watchdog = setInterval(
    () => {
      if (closed || ready) return;
      const since = Date.now() - (st.lastAttemptAt ?? 0);
      if (since < watchdogMs) return;
      log(`relay: no connection attempt for ${secs(since)} — restarting the reconnect loop`);
      backoff = minBackoff;
      connect();
    },
    Math.max(10, Math.min(watchdogMs / 4, 60_000)),
  );
  watchdog.unref?.();

  const request = (body: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (!ready || !ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`relay ${opts.url} not connected`));
        return;
      }
      const rid = randomBytes(8).toString('hex');
      const timer = setTimeout(() => {
        pending.delete(rid);
        reject(new Error('relay request timed out'));
      }, requestTimeout);
      pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ ...body, rid }));
    });

  connect();

  return {
    url: opts.url,
    connected: () => ready,
    state: () => ({ ...st }),
    handle: () => handle,
    limits: () => limits,
    protocols: () => protocols,
    async sendV3(to, blob, o = {}) {
      const r = await request({ type: 'send', to, blob, ...(o.ref ? { ref: o.ref } : {}), ...(o.store === false ? { store: false } : {}), ...(o.from ? { from: o.from } : {}) });
      if (r['type'] === 'stored') return { r: 'stored', ...(typeof r['expiresAt'] === 'number' ? { expiresAt: r['expiresAt'] } : {}) };
      return { r: r['type'] === 'sent' ? 'sent' : 'offline' };
    },
    async lookupAddress(address) {
      const r = await request({ type: 'address', address });
      return {
        address: typeof r['address'] === 'string' ? r['address'] : address,
        key: typeof r['key'] === 'string' ? r['key'] : null,
        prekey: (r['prekey'] as PrekeyRecord | null | undefined) ?? null,
        online: r['online'] === true,
        caps: Array.isArray(r['caps']) ? (r['caps'] as unknown[]).filter((c): c is string => typeof c === 'string') : [],
      };
    },
    async lookupAlias(name) {
      // (ADR-081 review F3) an alias is a frozen OLD name: one shaped like an address is not one, asked for or answered
      if (looksLikeAddress(name.split('/')[0] ?? '')) return [];
      const r = await request({ type: 'alias', name });
      const list = Array.isArray(r['entries']) ? (r['entries'] as unknown[]) : [];
      return list.flatMap((e) => {
        const x = e as Partial<AliasEntry> | null;
        return x && typeof x.name === 'string' && typeof x.address === 'string' && typeof x.agent === 'string' && !looksLikeAddress(x.name.split('/')[0] ?? '')
          ? [{ name: x.name, address: x.address, agent: x.agent, ...(x.default === true ? { default: true as const } : {}) }]
          : [];
      });
    },
    async publishPrekey(address, prekey) {
      await request({ type: 'prekey', address, prekey });
    },
    ack(to, ids) {
      if (!ids.length || !ready || !ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'ack', to, ids }));
      } catch {
        /* not acked: the relay delivers it again next login (deduped here) */
      }
    },
    async send(to, blob) {
      const r = await request({ type: 'send', to, blob });
      return r['type'] === 'sent' ? 'sent' : 'offline';
    },
    async signal(to, blob) {
      const r = await request({ type: 'signal', to, blob });
      return r['type'] === 'signaled' ? 'sent' : 'offline';
    },
    async bundle(id) {
      const r = await request({ type: 'bundle', id });
      return (r['bundle'] as KeyBundle | null) ?? null;
    },
    async lookupHandle(h) {
      // (ADR-081 review F3) an address is nobody's old name: the directory is not even asked
      if (looksLikeAddress(h.replace(/^@/, ''))) return [];
      const r = await request({ type: 'handle', handle: h });
      const devices = Array.isArray(r['devices']) ? (r['devices'] as HandleDevice[]) : [];
      if (devices.length && typeof r['handle'] === 'string' && 'nickname' in r) opts.onNickname?.(r['handle'], typeof r['nickname'] === 'string' ? r['nickname'] : null, false);
      return devices.filter((d) => typeof d?.id === 'string').map((d) => ({ id: d.id, name: typeof d.name === 'string' ? d.name : '', bundle: d.bundle ?? null }));
    },
    async resolveAgent(h, agent) {
      if (looksLikeAddress(h.replace(/^@/, ''))) return null; // (ADR-081 review F3) as above
      const r = await request({ type: 'agent', handle: h, ...(agent ? { agent } : {}) });
      const d = r['device'] as HandleDevice | null | undefined;
      if (!d || typeof d.id !== 'string' || typeof r['agent'] !== 'string') return null;
      if (typeof r['handle'] === 'string' && 'nickname' in r) opts.onNickname?.(r['handle'], typeof r['nickname'] === 'string' ? r['nickname'] : null, false);
      return { handle: String(r['handle'] ?? h), agent: r['agent'], device: { id: d.id, name: typeof d.name === 'string' ? d.name : '', bundle: d.bundle ?? null } };
    },
    waitConnected(ms) {
      if (ready) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(t);
          resolve(true);
        };
        const t = setTimeout(() => {
          waiters.delete(done);
          resolve(false);
        }, ms);
        waiters.add(done);
      });
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(watchdog);
      teardown?.();
      failAll('relay client closed');
    },
  };
}
