import { Bonjour, type Service } from 'bonjour-service';

/** A DNS-safe label for an mDNS host name. */
export function mdnsLabel(device: string): string {
  return device.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'device';
}
import type { SessionInfo } from '../adapters/types.js';
import type { Message } from '../mailbox/mailbox.js';
import type { DeviceIdentity } from './identity.js';
import { HANDLE_HEADER, peerRequest } from './secure-transport.js';

export interface Peer {
  device: string;
  host: string;
  /** The peer's mutual-TLS port (ADR-028). */
  port: number;
  /** Device ID from mDNS TXT — public, and only usable by whoever holds its key. */
  id: string;
  lastSeenAt: number;
}

/** What we present when calling a peer: our identity and our device name. */
export interface PeerClient {
  identity: DeviceIdentity;
  selfName: string;
}

export interface PeerRegistry {
  list(): Peer[];
  get(device: string): Peer | undefined;
  /** Manually add a peer (debugging / no-mDNS environments). */
  addStatic(device: string, host: string, port: number, id: string): void;
  /** Stop browsing and say goodbye on mDNS (TTL-0 records), so other devices drop us
   *  at once instead of keeping a ghost entry. Resolves when sent (≤ 500 ms). */
  stop(): Promise<void>;
}

// Compatibility: the mDNS service type (`_anytoany._tcp`) and the `anytoany-` instance / host
// names below keep the old project name — devices on older releases browse for and announce
// exactly these, and a renamed service would not find them on the LAN (ADR-075).
const SERVICE_TYPE = 'anytoany';

/**
 * Pick the address a LAN peer is actually reachable on. mDNS advertises every
 * interface, including proxy TUN fakes (198.18.0.0/15) and link-local junk —
 * prefer RFC1918 private ranges, never return known-unroutable ranges.
 */
export function pickLanAddress(addresses: string[]): string | undefined {
  const ipv4 = addresses.filter((a) => a.includes('.'));
  const unroutable = (a: string) =>
    a.startsWith('127.') ||
    a.startsWith('169.254.') ||
    a.startsWith('198.18.') ||
    a.startsWith('198.19.');
  const isPrivate = (a: string) =>
    a.startsWith('192.168.') ||
    a.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  return ipv4.find((a) => isPrivate(a) && !unroutable(a)) ?? ipv4.find((a) => !unroutable(a));
}

export interface DiscoveryOptions {
  selfDevice: string;
  /** Our mutual-TLS peer port, announced over mDNS. */
  port: number;
  /** Our public device ID, announced so others can pair with us (ADR-028). */
  selfId: string;
  /** Disable mDNS (tests / --peer only mode). */
  mdns?: boolean;
  /** Browse without announcing — for passive CLI scans that have no real port. */
  publish?: boolean;
}

/** Publish this daemon and track peers via mDNS (`_anytoany._tcp`). */
export function startPeerRegistry(opts: DiscoveryOptions): PeerRegistry {
  const peers = new Map<string, Peer>();
  let publisher: Bonjour | null = null;
  let finder: Bonjour | null = null;
  let requery: NodeJS.Timeout | null = null;

  if (opts.mdns !== false) {
    if (opts.publish !== false) {
      publisher = new Bonjour();
      publisher.publish({
        name: `anytoany-${opts.selfDevice}`,
        type: SERVICE_TYPE,
        port: opts.port,
        // Never claim the machine's own <hostname>.local: bonjour-service would
        // otherwise announce an A record for it (probe:false), and macOS's own
        // mDNSResponder then sees a "conflict" and renames the computer to
        // "<name>-2.local" (seen on a Mac mini, 2026-10-21). Use our own host name.
        host: `anytoany-${mdnsLabel(opts.selfDevice)}.local`,
        txt: { device: opts.selfDevice, id: opts.selfId },
        // A same-name record on the network can only be our own stale ghost
        // (a crashed daemon that never sent its mDNS goodbye). Probing would
        // throw an uncatchable name-conflict — announce and reclaim instead.
        probe: false,
      });
    }
    // Separate instance for browsing: sharing a socket with the publisher
    // starves the browser's own queries — it then only ever overhears
    // responses triggered by other hosts (verified on macOS).
    finder = new Bonjour();
    const browser = finder.find({ type: SERVICE_TYPE });
    const upsert = (service: Service): void => {
      const txt = (service.txt ?? {}) as { device?: string; id?: string };
      const device = txt.device;
      if (!device || device.toLowerCase() === opts.selfDevice.toLowerCase()) return;
      const host = pickLanAddress(service.addresses ?? []) ?? service.host;
      if (!host) return;
      peers.set(device.toLowerCase(), {
        device,
        host,
        port: service.port,
        id: txt.id ?? '',
        lastSeenAt: Date.now(),
      });
      // Same endpoint under another name = the device was renamed (or a ghost
      // advert from its previous daemon) — drop the stale alias so the
      // directory doesn't aggregate one machine twice.
      for (const [key, p] of peers) {
        if (key !== device.toLowerCase() && p.host === host && p.port === service.port) peers.delete(key);
      }
    };
    browser.on('up', upsert);
    browser.on('down', (service: Service) => {
      const txt = (service.txt ?? {}) as { device?: string };
      if (txt.device) peers.delete(txt.device.toLowerCase());
    });
    // The browser's initial query can be silently lost (socket races at
    // startup); it never re-asks on its own and would then only overhear
    // responses triggered by other hosts. Re-query periodically (verified fix).
    requery = setInterval(() => browser.update(), 30_000);
    requery.unref?.();
  }

  return {
    list: () => [...peers.values()],
    get: (device) => peers.get(device.toLowerCase()),
    addStatic(device, host, port, id) {
      peers.set(device.toLowerCase(), { device, host, port, id, lastSeenAt: Date.now() });
    },
    stop() {
      if (requery) clearInterval(requery);
      finder?.destroy();
      const pub = publisher;
      publisher = null;
      if (!pub) return Promise.resolve();
      return new Promise<void>((resolve) => {
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
      });
    },
  };
}

type PeerAddress = Pick<Peer, 'device' | 'host' | 'port' | 'id'>;

/** One call to a paired peer over pinned mutual TLS (ADR-028). */
async function callPeer(
  peer: PeerAddress,
  client: PeerClient,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!peer.id) throw new Error(`peer ${peer.device} did not announce a device ID (older Morse?) — upgrade it`);
  return peerRequest({
    host: peer.host,
    port: peer.port,
    expectedId: peer.id,
    identity: client.identity,
    selfName: client.selfName,
    method,
    path,
    ...(body !== undefined ? { body } : {}),
  });
}

function httpError(peer: PeerAddress, client: PeerClient, status: number, body: unknown): string {
  if (status === 403) {
    return `peer ${peer.device}: not paired — on @${peer.device} run: morse pair add ${client.identity.id}`;
  }
  const detail = (body as { error?: string } | null)?.error ?? '';
  return `peer ${peer.device}: HTTP ${status} ${detail}`.trim();
}

const unreachable = (peer: PeerAddress, e: unknown): string =>
  `peer ${peer.device} unreachable: ${e instanceof Error ? e.message : String(e)}`;

/** Pull a peer's local session directory, stamping each entry with its device. */
export async function fetchPeerSessions(peer: Peer, client: PeerClient): Promise<SessionInfo[]> {
  const r = await callPeer(peer, client, 'GET', '/api/peer/sessions');
  if (r.status !== 200) throw new Error(httpError(peer, client, r.status, r.body));
  const { sessions } = r.body as { sessions: SessionInfo[] };
  return sessions.map((s) => ({ ...s, device: peer.device }));
}

/**
 * Hand a message to the peer daemon. Perspective flip: our 'to.device' becomes
 * the peer's local target. The peer records the sending device from OUR
 * certificate, not from this body (ADR-028).
 */
export async function relayToPeer(
  peer: Peer,
  message: Message,
  client: PeerClient,
): Promise<{ ok: boolean; error?: string }> {
  const wire = {
    contextId: message.contextId,
    from: { agent: message.from.agent, sessionId: message.from.sessionId },
    to: { agent: message.to.agent, sessionId: message.to.sessionId },
    text: message.parts.map((p) => p.text).join('\n'),
  };
  try {
    const r = await callPeer(peer, client, 'POST', '/api/peer/messages', wire);
    return r.status === 201 ? { ok: true } : { ok: false, error: httpError(peer, client, r.status, r.body) };
  } catch (e) {
    return { ok: false, error: unreachable(peer, e) };
  }
}

/**
 * Morse over the LAN (ADR-034): hand a Morse message (the same plaintext the relay
 * path seals) straight to a paired device's peer API. Mutual TLS pins both ends, so
 * the recipient knows exactly which trusted device sent it; its 201/200 answer is
 * the receipt. Anything else (old peer without the route, unpaired, unreachable) is
 * an error and the caller falls back to the relay.
 */
export async function deliverMorseToPeer(
  peer: PeerAddress,
  payload: unknown,
  client: PeerClient,
  timeoutMs = 5000,
  /** ADR-073: '/api/peer/morse3' carries a sealed v3 envelope instead of the plaintext. */
  path: '/api/peer/morse' | '/api/peer/morse3' = '/api/peer/morse',
): Promise<MorseLanResult> {
  try {
    if (!peer.id) throw new Error(`peer ${peer.device} did not announce a device ID`);
    // our Morse handle, so a recipient that has not paired us yet can confirm it with
    // the relay directory and accept this first message directly (ADR-034)
    const fromHandle = (payload as { fromHandle?: unknown } | null)?.fromHandle;
    const r = await peerRequest({
      host: peer.host,
      port: peer.port,
      expectedId: peer.id,
      identity: client.identity,
      selfName: client.selfName,
      method: 'POST',
      path,
      body: payload,
      ...(typeof fromHandle === 'string' && fromHandle ? { headers: { [HANDLE_HEADER]: fromHandle } } : {}),
      timeoutMs,
    });
    if (r.status === 201 || r.status === 200) return { ok: true, status: r.status, body: r.body };
    // ADR-037: they have not accepted us — it went to their message requests (or was not kept)
    if (r.status === 202) return { ok: true, status: r.status, body: r.body, request: (r.body as { request?: unknown } | null)?.request === 'dropped' ? 'dropped' : 'filed' };
    return { ok: false, status: r.status, body: r.body, error: httpError(peer, client, r.status, r.body), ...(r.status === 403 ? { notPaired: true } : {}) };
  } catch (e) {
    return { ok: false, error: unreachable(peer, e) };
  }
}

/** What a Morse hand-over on the LAN answered (status + body: the chunked transfer reads them, ADR-038). */
export interface MorseLanResult {
  ok: boolean;
  error?: string;
  notPaired?: boolean;
  request?: 'filed' | 'dropped';
  status?: number;
  body?: unknown;
}
