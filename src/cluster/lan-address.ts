import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Bonjour, type Service } from 'bonjour-service';
import { keyMatchesAddress, normalizeAddress } from '../identity/address.js';
import { verifyBy } from '../identity/address-key.js';
import { pickLanAddress } from './peers.js';

/**
 * The LAN by ADDRESS (ADR-091 §8; hardened by the follow-up review, ADR-091 「第 2 期发布后的修补」): computers on one
 * network hand each other the very same sealed v3 envelopes the relay carries — nothing else. OFF unless the owner
 * turns it on (`morse.lan: true` in config.json, or `morse start --lan`).
 *
 *   discovery  mDNS service `_morse._tcp`: a random instance name per run, TXT `v=3` and ONE address — the first
 *              address of this computer (its other addresses are never announced: nobody on the network can link
 *              them to it). No device name, no device ID.
 *   proof      an announcement proves nothing (anyone can announce any address). Before an envelope goes to a
 *              computer that announced an address, that computer must prove it holds the address's key:
 *              `POST /v3/prove {address, nonce}` → `{key, sig}` (Ed25519 by the address key over
 *              "morse-lan-prove-v1\n<address>\n<nonce>"), checked against the address. A proof is kept for a while
 *              per (address, host, port); several computers announcing one address: only a proven one is used.
 *   transport  `POST /v3/envelope` with `{blob}` — one v3 envelope, signed by the sending address and sealed to the
 *              receiving one. The listener OPENS it first (signature, an address it hosts) and only then hands it
 *              on; whatever the outcome it answers the same (202 {}): no answer says which addresses live here. A
 *              202 means nothing to the sender — only the receipt (which never comes back over the LAN) confirms.
 *   limits     JSON only, no browser (no `Origin`), at most `LAN_MAX_BODY` bytes, short header / body timeouts, a
 *              connection cap, a per-IP rate and a per-IP cap on NEW senders (strangers' message requests).
 *
 * Tests: `mdns: false` and `addPeer` (no multicast), a random port.
 */

export const LAN_SERVICE_TYPE = 'morse';
export const LAN_ENVELOPE_PATH = '/v3/envelope';
export const LAN_PROVE_PATH = '/v3/prove';
/** The relay's single-envelope limit (1 040 000 bytes) plus room for the JSON around it. */
export const LAN_MAX_BODY = 1_100_000;
export const LAN_PROVE_CONTEXT = 'morse-lan-prove-v1';
/** How long a proof of (address, host, port) is trusted before it is asked again. */
export const LAN_PROOF_TTL_MS = 10 * 60_000;

export interface LanCheck {
  ok: boolean;
  /** the address that signed it (ok only) */
  from?: string;
  /** the sender is a contact of the address it wrote to (ok only) */
  known?: boolean;
}

export interface LanLimits {
  /** envelopes per IP per minute (default 120) */
  perIpPerMinute?: number;
  /** new senders (not contacts) per IP per 10 minutes (default 5) */
  strangersPerIp?: number;
  /** concurrent connections (default 32) */
  maxConnections?: number;
  /** addresses remembered from the network (default 256) */
  maxPeers?: number;
}

export interface AddressLanOptions {
  /** The port to listen on (0 = any free one). */
  port: number;
  host?: string;
  /** The ONE address announced (this computer's first address); null = nothing announced yet. */
  address: () => string | null;
  /** Sign `message` with the key of `address` (only the announced address is ever asked). null = not held here. */
  sign: (address: string, message: Buffer) => { publicKey: Buffer; sig: Buffer } | null;
  /** Open an envelope posted here: did it verify, and was it sealed to an address this computer hosts? */
  check: (blob: string) => Promise<LanCheck> | LanCheck;
  /** One envelope that verified — handled like a relay delivery. */
  onEnvelope: (blob: string) => void;
  /** false = no mDNS at all (tests; `addPeer` instead). */
  mdns?: boolean;
  limits?: LanLimits;
  /** Timeouts of what this side asks (ms): a proof, one POST. */
  timeouts?: { proveMs?: number; sendMs?: number };
  log?: (line: string) => void;
}

export interface AddressLan {
  port: number;
  /** Has `address` (someone else's) been announced on the LAN (and not failed lately)? */
  reachable(address: string): boolean;
  /** Prove, then POST one envelope to a computer that announced `address`. true = a proven computer took the POST
   *  (still unconfirmed: only the receipt confirms). */
  send(address: string, blob: string): Promise<boolean>;
  /** (tests, mDNS-hostile networks) `address` is announced at host:port — still proven before use. */
  addPeer(address: string, host: string, port: number): void;
  /** The address of this computer changed: announce it anew. */
  republish(): void;
  peers(): Array<{ address: string; host: string; port: number; lastSeenAt: number; proven: boolean }>;
  stop(): Promise<void>;
}

/** The TXT record of an announcement: the protocol and ONE address. */
export const lanTxt = (address: string | null): Record<string, string> => (address ? { v: '3', a0: address } : { v: '3' });
export const proveMessage = (address: string, nonce: string): Buffer => Buffer.from(`${LAN_PROVE_CONTEXT}\n${address}\n${nonce}`);

const readBody = (req: IncomingMessage, max: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > max) {
      reject(new Error('too large'));
      return;
    }
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });

interface Candidate {
  host: string;
  port: number;
  lastSeenAt: number;
  instance?: string;
  provenAt?: number;
  failedAt?: number;
}

export async function startAddressLan(opts: AddressLanOptions): Promise<AddressLan> {
  const log = opts.log ?? (() => undefined);
  const perIpPerMinute = opts.limits?.perIpPerMinute ?? 120;
  const strangersPerIp = opts.limits?.strangersPerIp ?? 5;
  const maxPeers = opts.limits?.maxPeers ?? 256;
  const proveMs = opts.timeouts?.proveMs ?? 2000;
  const sendMs = opts.timeouts?.sendMs ?? 5000;
  /** address → the computers that announced it (at most 4, newest first) */
  const peers = new Map<string, Candidate[]>();
  const mine = () => normalizeAddress(opts.address() ?? '');

  // ---- per-IP limits -----------------------------------------------------------------------------------
  const rate = new Map<string, number[]>();
  const strangers = new Map<string, Map<string, number>>();
  const overRate = (ip: string): boolean => {
    const now = Date.now();
    const seen = (rate.get(ip) ?? []).filter((t) => now - t < 60_000);
    seen.push(now);
    rate.set(ip, seen);
    if (rate.size > 4096) rate.clear();
    return seen.length > perIpPerMinute;
  };
  /** a new sender from this IP: within the cap? (a sender already counted stays allowed) */
  const strangerAllowed = (ip: string, from: string): boolean => {
    const now = Date.now();
    const m = strangers.get(ip) ?? new Map<string, number>();
    for (const [a, t] of m) if (now - t > 10 * 60_000) m.delete(a);
    strangers.set(ip, m);
    if (strangers.size > 4096) strangers.clear();
    if (m.has(from)) return true;
    if (m.size >= strangersPerIp) return false;
    m.set(from, now);
    return true;
  };

  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const ip = req.socket.remoteAddress ?? '?';
    if (req.method !== 'POST' || (req.url !== LAN_ENVELOPE_PATH && req.url !== LAN_PROVE_PATH)) return answer(res, 404, { error: 'not found' });
    // (ADR-087) never a browser: a page can post a form across origins, but not with an Origin it does not send
    if (req.headers['origin'] !== undefined || req.headers['sec-fetch-site'] !== undefined) return answer(res, 403, { error: 'not from a browser' });
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return answer(res, 415, { error: 'expected application/json' });
    if (overRate(ip)) return answer(res, 429, { error: 'too many requests' });
    readBody(req, req.url === LAN_PROVE_PATH ? 1024 : LAN_MAX_BODY).then(
      async (raw) => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
          if (!body || typeof body !== 'object') throw new Error('not an object');
        } catch {
          return answer(res, 400, { error: 'expected JSON' });
        }
        if (req.url === LAN_PROVE_PATH) {
          const address = normalizeAddress(String(body['address'] ?? ''));
          const nonce = String(body['nonce'] ?? '');
          // (only the announced address is ever proven — any other answers exactly as an address not here)
          const signed = address && address === mine() && /^[A-Za-z0-9_-]{16,64}$/.test(nonce) ? opts.sign(address, proveMessage(address, nonce)) : null;
          if (!signed) return answer(res, 404, { error: 'not here' });
          return answer(res, 200, { key: signed.publicKey.toString('base64'), sig: signed.sig.toString('base64') });
        }
        const blob = body['blob'];
        if (typeof blob !== 'string') return answer(res, 400, { error: 'expected {blob: <a v3 envelope>}' });
        let c: LanCheck;
        try {
          c = await opts.check(blob);
        } catch {
          c = { ok: false };
        }
        // the same answer whatever happened: nothing says which addresses live here
        answer(res, 202, {});
        if (!c.ok || !c.from) return;
        if (!c.known && !strangerAllowed(ip, c.from)) {
          log(`lan: dropped a message from a new sender ${c.from.slice(0, 7)} — too many new senders from ${ip} (they can write through the relay)`);
          return;
        }
        try {
          opts.onEnvelope(blob);
        } catch (e) {
          log(`lan: an envelope could not be handled: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      () => {
        // (and nothing more is read: the connection goes once the answer is out)
        res.setHeader('connection', 'close');
        res.on('finish', () => req.socket.destroy());
        answer(res, 413, { error: 'too large' });
      },
    );
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 2_000;
  server.maxConnections = opts.limits?.maxConnections ?? 32;
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve((server.address() as { port: number }).port));
  });

  // ---- the computers seen on the network -----------------------------------------------------------------
  const remember = (address: string, c: Candidate) => {
    if (address === mine()) return;
    const list = (peers.get(address) ?? []).filter((x) => !(x.host === c.host && x.port === c.port));
    const prev = (peers.get(address) ?? []).find((x) => x.host === c.host && x.port === c.port);
    list.unshift({ ...c, ...(prev?.provenAt ? { provenAt: prev.provenAt } : {}) });
    peers.delete(address);
    peers.set(address, list.slice(0, 4));
    // bounded: the address seen longest ago goes first
    while (peers.size > maxPeers) peers.delete(peers.keys().next().value!);
  };
  const usable = (c: Candidate) => !c.failedAt || Date.now() - c.failedAt > 60_000;

  // ---- mDNS --------------------------------------------------------------------------------------------
  const instance = `morse-${randomBytes(6).toString('hex')}`;
  let publisher: Bonjour | null = null;
  let finder: Bonjour | null = null;
  let requery: NodeJS.Timeout | null = null;
  const publish = () => {
    if (opts.mdns === false) return;
    try {
      publisher?.unpublishAll();
      publisher?.destroy();
    } catch {
      /* the old announcement goes stale by itself */
    }
    publisher = new Bonjour();
    // (a host name of our own, never the machine's <hostname>.local — see src/cluster/peers.ts)
    publisher.publish({ name: instance, type: LAN_SERVICE_TYPE, port, host: `${instance}.local`, txt: lanTxt(mine()), probe: false });
  };
  if (opts.mdns !== false) {
    publish();
    finder = new Bonjour();
    const browser = finder.find({ type: LAN_SERVICE_TYPE });
    const addressOf = (s: Service): string | null => {
      const txt = (s.txt ?? {}) as Record<string, unknown>;
      if (String(txt['v'] ?? '') !== '3') return null;
      return normalizeAddress(String(txt['a0'] ?? ''));
    };
    browser.on('up', (s: Service) => {
      if (s.name === instance) return;
      const host = pickLanAddress(s.addresses ?? []) ?? s.host;
      const a = addressOf(s);
      if (host && a) remember(a, { host, port: s.port, lastSeenAt: Date.now(), instance: s.name });
    });
    browser.on('down', (s: Service) => {
      for (const [a, list] of peers) {
        const left = list.filter((c) => c.instance !== s.name);
        if (left.length) peers.set(a, left);
        else peers.delete(a);
      }
    });
    requery = setInterval(() => browser.update(), 30_000);
    requery.unref?.();
  }

  const postJson = (c: Candidate, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown } | null> =>
    new Promise((resolve) => {
      const data = JSON.stringify(body);
      const req = httpRequest({ host: c.host, port: c.port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, timeout: timeoutMs }, (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > 4096) return res.destroy();
          parts.push(d);
        });
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(Buffer.concat(parts).toString('utf8'));
          } catch {
            /* no body */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(null));
      req.end(data);
    });

  /** Does the computer at `c` hold the key of `address`? */
  const prove = async (address: string, c: Candidate): Promise<boolean> => {
    if (c.provenAt && Date.now() - c.provenAt < LAN_PROOF_TTL_MS) return true;
    const nonce = randomBytes(18).toString('base64url');
    const r = await postJson(c, LAN_PROVE_PATH, { address, nonce }, proveMs);
    const j = (r?.json ?? {}) as { key?: unknown; sig?: unknown };
    if (r?.status === 200 && typeof j.key === 'string' && typeof j.sig === 'string') {
      const key = Buffer.from(j.key, 'base64');
      if (key.length === 32 && keyMatchesAddress(key, address) && verifyBy(key, proveMessage(address, nonce), Buffer.from(j.sig, 'base64'))) {
        c.provenAt = Date.now();
        return true;
      }
    }
    log(`lan: ${c.host}:${c.port} announced ${address.slice(0, 7)} but could not prove it holds that address — not used`);
    return false;
  };

  return {
    port,
    reachable: (address) => {
      const a = normalizeAddress(address);
      return Boolean(a && (peers.get(a) ?? []).some(usable));
    },
    send: async (address, blob) => {
      const a = normalizeAddress(address);
      if (!a) return false;
      for (const c of (peers.get(a) ?? []).filter(usable)) {
        if (!(await prove(a, c))) {
          c.failedAt = Date.now();
          continue;
        }
        const r = await postJson(c, LAN_ENVELOPE_PATH, { blob }, sendMs);
        if (r?.status === 202) return true;
        c.failedAt = Date.now();
        delete c.provenAt;
      }
      return false;
    },
    addPeer: (address, host, p) => {
      const a = normalizeAddress(address);
      if (a) remember(a, { host, port: p, lastSeenAt: Date.now() });
    },
    republish: publish,
    peers: () => [...peers.entries()].flatMap(([address, list]) => list.map((c) => ({ address, host: c.host, port: c.port, lastSeenAt: c.lastSeenAt, proven: Boolean(c.provenAt) }))),
    stop: () =>
      new Promise<void>((resolve) => {
        if (requery) clearInterval(requery);
        finder?.destroy();
        server.close();
        server.closeAllConnections?.();
        const pub = publisher;
        publisher = null;
        if (!pub) return resolve();
        const done = () => {
          clearTimeout(t);
          pub.destroy();
          resolve();
        };
        const t = setTimeout(done, 500);
        try {
          pub.unpublishAll(done);
        } catch {
          done();
        }
      }),
  };
}
