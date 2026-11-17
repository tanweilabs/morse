import type { SessionInfo } from '../adapters/types.js';
import type { TrustedDevice } from './trust.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';
import { loadOrCreateIdentity, type DeviceIdentity } from './identity.js';
import { createPeerApiHandler, type MorseInbound } from './peer-api.js';
import {
  deliverMorseToPeer,
  fetchPeerSessions,
  relayToPeer,
  startPeerRegistry,
  type MorseLanResult,
  type Peer,
  type PeerClient,
  type PeerRegistry,
} from './peers.js';
import { probePeerId, peerRequest, startPeerServer, type PeerServer, type UntrustedContact } from './secure-transport.js';
import { createTrustStore, type TrustStore } from './trust.js';
import { demotedDevices, effectiveTrust, pinnedAddressLookup } from './effective-trust.js';

/**
 * The daemon's LAN layer (ADR-002 discovery + ADR-028 identity/encryption):
 * our identity, the trust list, mDNS discovery, the mutual-TLS peer server, and
 * the client side (directory aggregation, relay). Only paired peers are used.
 */

export interface LanOptions {
  selfDevice: string;
  /** Mutual-TLS peer port (console port + 1 by default). */
  peerPort: number;
  mailbox: Mailbox;
  localDirectory: () => Promise<SessionInfo[]>;
  onChange?: () => void;
  /** host:port of peers to add without mDNS (debugging, mDNS-hostile networks). */
  staticPeers?: string[];
  /** Isolated home for tests; defaults to MORSE_HOME / ~. */
  home?: string;
  /** Disable mDNS (tests). */
  mdns?: boolean;
  bindHost?: string;
  log?: (line: string) => void;
}

export interface Lan {
  selfDevice: string;
  identity: DeviceIdentity;
  trust: TrustStore;
  registry: PeerRegistry;
  peerPort: number;
  /** Unpaired devices that contacted us, newest last (pairing requests). */
  pending(): UntrustedContact[];
  /** A paired peer by device name (trusted name or mDNS name). */
  findPeer(device: string): Peer | undefined;
  remoteSessions(): Promise<SessionInfo[]>;
  relay(device: string, message: Message): Promise<{ ok: boolean; error?: string }>;
  /** Morse over the LAN (ADR-034): the direct path the Morse layer tries first. */
  morse: LanMorseLink;
  /** Where Morse messages handed to us over the LAN are filed (set once Morse starts). */
  setMorseInbound(fn: MorseInbound): void;
  /** First contact over the LAN (ADR-034): an unpaired device that claims a Morse handle
   *  asks to hand us a message — the Morse layer checks the relay directory and pairs it
   *  (or not). Set once Morse starts; without it unpaired devices are refused. */
  setMorseAdmit(fn: MorseAdmit): void;
  /** Close the peer server; resolves once the mDNS goodbye is sent. */
  stop(): Promise<void>;
}

/** What the Morse layer needs from the LAN layer to deliver directly. */
export interface LanMorseLink {
  /** That device is paired AND currently discovered on the LAN (mDNS or --peer). */
  reachable(deviceId: string): boolean;
  /** POST the message to its peer API over pinned mutual TLS; ok = it filed it.
   *  notPaired = it refused us (has not paired us and could not do so automatically).
   *  request (ADR-037) = it filed it as a message request (`filed`), or did not keep it
   *  because one from us is already waiting (`dropped`). */
  deliver(deviceId: string, payload: unknown, opts?: { timeoutMs?: number; sealed?: boolean }): Promise<MorseLanResult>;
}

/** Pair an unpaired LAN caller that claims a Morse handle, if the relay directory agrees. */
export type MorseAdmit = (deviceId: string, claimedHandle: string) => Promise<TrustedDevice | undefined>;

const MAX_PENDING = 20;

export async function startLan(opts: LanOptions): Promise<Lan> {
  const log = opts.log ?? (() => undefined);
  const identity = loadOrCreateIdentity(opts.home);
  // ADR-077: a computer of yours moved out of contact group `self` is a peer on every LAN path too
  const addressOf = pinnedAddressLookup(opts.home);
  const trust = effectiveTrust(createTrustStore(opts.home), demotedDevices(() => opts.mailbox.contacts, log));
  const client: PeerClient = { identity, selfName: opts.selfDevice };

  const pendingById = new Map<string, UntrustedContact>();
  let morseInbound: MorseInbound | undefined;
  let morseAdmit: MorseAdmit | undefined;
  const server: PeerServer = await startPeerServer({
    identity,
    trust,
    port: opts.peerPort,
    ...(opts.bindHost ? { host: opts.bindHost } : {}),
    handle: createPeerApiHandler({
      selfDevice: opts.selfDevice,
      selfId: identity.id,
      mailbox: opts.mailbox,
      addressOf,
      localDirectory: opts.localDirectory,
      ...(opts.onChange ? { onChange: opts.onChange } : {}),
      morseInbound: () => morseInbound,
    }),
    // only a Morse message may pair a stranger on first contact — nothing else is served to it
    admit: async (contact) =>
      contact.claimedHandle && contact.method === 'POST' && (contact.path === '/api/peer/morse' || contact.path === '/api/peer/morse3') && morseAdmit
        ? morseAdmit(contact.id, contact.claimedHandle)
        : undefined,
    onUntrusted: (contact) => {
      if (!pendingById.has(contact.id)) {
        log(
          contact.claimedHandle
            ? `lan: morse.im/${contact.claimedHandle} (${contact.claimedName ?? 'unknown device'}, ${contact.id.slice(0, 7)}) is not paired here — their messages come through the relay; to accept them directly: morse pair add morse.im/${contact.claimedHandle}`
            : `lan: pairing request from ${contact.claimedName ?? 'unknown'} (${contact.id}) — to accept: morse pair add ${contact.id}`,
        );
      }
      pendingById.delete(contact.id);
      pendingById.set(contact.id, contact);
      if (pendingById.size > MAX_PENDING) pendingById.delete(pendingById.keys().next().value as string);
    },
  });

  const registry = startPeerRegistry({
    selfDevice: opts.selfDevice,
    selfId: identity.id,
    port: server.port,
    ...(opts.mdns === false ? { mdns: false } : {}),
  });

  for (const spec of opts.staticPeers ?? []) {
    const [host, p] = spec.split(':');
    const port = Number.parseInt(p ?? '', 10);
    if (!host || !Number.isFinite(port)) continue;
    try {
      const id = await probePeerId({ host, port, identity });
      const trusted = trust.get(id);
      // name it by our trust entry when paired; otherwise ask it (only works once paired)
      let device = trusted?.name ?? host;
      if (trusted) {
        const info = await peerRequest({ host, port, expectedId: id, identity, selfName: opts.selfDevice, method: 'GET', path: '/api/peer/info' });
        device = (info.body as { device?: string } | null)?.device ?? device;
      }
      registry.addStatic(device, host, port, id);
      log(`lan: static peer @${device} (${host}:${port}) ${trusted ? 'paired' : `NOT paired — morse pair add ${id}`}`);
    } catch (e) {
      log(`warning: static peer ${spec} unreachable at startup: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const pairedPeers = (): Peer[] => registry.list().filter((p) => p.id && trust.get(p.id));

  const peerById = (id: string): Peer | undefined => (trust.get(id) ? registry.list().find((p) => p.id === id) : undefined);

  const findPeer = (device: string): Peer | undefined => {
    const direct = registry.get(device);
    if (direct?.id && trust.get(direct.id)) return direct;
    // the operator may have named the device differently when pairing
    const named = trust.byName(device);
    return named ? registry.list().find((p) => p.id === named.id) : undefined;
  };

  return {
    selfDevice: opts.selfDevice,
    identity,
    trust,
    registry,
    peerPort: server.port,
    pending: () => [...pendingById.values()].filter((c) => !trust.get(c.id)),
    findPeer,
    async remoteSessions() {
      // only our own devices share their session directory (peer tier: messages only)
      const owners = pairedPeers().filter((p) => trust.get(p.id)?.tier !== 'peer');
      const results = await Promise.allSettled(owners.map((p) => fetchPeerSessions(p, client)));
      return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    },
    async relay(device, message) {
      const peer = findPeer(device);
      if (!peer) {
        const seen = registry.get(device);
        return {
          ok: false,
          error: seen
            ? `device "${device}" is on the LAN but not paired — run: morse pair add ${seen.id}`
            : `device "${device}" not found on LAN (morse peers to inspect)`,
        };
      }
      return relayToPeer(peer, message, client);
    },
    morse: {
      reachable: (id) => Boolean(peerById(id)),
      async deliver(id, payload, o) {
        const peer = peerById(id);
        if (!peer) return { ok: false, error: `device ${id.slice(0, 7)} is not on the LAN` };
        // ADR-073: `sealed` = a v3 envelope ({fromHandle?, sealedV3}) to /api/peer/morse3
        return deliverMorseToPeer(peer, payload, client, o?.timeoutMs, o?.sealed ? '/api/peer/morse3' : '/api/peer/morse');
      },
    },
    setMorseInbound(fn) {
      morseInbound = fn;
    },
    setMorseAdmit(fn) {
      morseAdmit = fn;
    },
    stop() {
      server.close();
      return registry.stop();
    },
  };
}
