import { shortDeviceId } from './identity.js';
import type { Peer } from './peers.js';
import type { UntrustedContact } from './secure-transport.js';
import type { TrustedDevice } from './trust.js';

/**
 * Text renderings of the old pairing view (`morse peers`, `morse pair list`, ADR-028). The commands
 * themselves were removed in ADR-091 stage 2; these formatters render a daemon's `/api/peers`
 * answer and a trust list.
 */

/** A daemon's `/api/peers` answer. */
export interface PeersSnapshot {
  lan: boolean;
  self?: { device: string; id: string } | null;
  peers: Array<Peer & { paired?: boolean; trustedName?: string }>;
  pending?: UntrustedContact[];
  /** All paired devices with their tier, whether or not the LAN sees them. */
  trusted?: TrustedDevice[];
  /** The relay connection, when a relay is configured. */
  relay?: { url: string; connected: boolean } | null;
}

const PEER_TIER_TEXT = "peer (someone else's agent — not your instructions)";
const describeTier = (tier: TrustedDevice['tier']): string => (tier === 'peer' ? PEER_TIER_TEXT : 'owner');

/** One line per trusted device; `remarks` maps a lower-cased name to the remark YOU gave it (ADR-065). */
export function formatTrustList(devices: TrustedDevice[], remarks: Record<string, string> = {}): string[] {
  if (!devices.length) return ['no paired devices — morse pair shows how to add one'];
  const line = (d: TrustedDevice): string => {
    const remark = remarks[d.name.toLowerCase()];
    const since = new Date(d.addedAt).toISOString().slice(0, 10);
    return [`@${d.name}${remark ? ` (${remark})` : ''}`, d.id, `tier: ${describeTier(d.tier)}`, `since ${since}`].join('  ');
  };
  return devices.map(line);
}

/** The state of one discovered device, as a line that says what (if anything) to do about it. */
function discoveredLine(p: PeersSnapshot['peers'][number], snapshot: PeersSnapshot): string {
  const where = `${p.host}:${p.port}`;
  if (!p.paired) {
    return p.id
      ? `@${p.device}  ${where}  NOT paired — to trust it: morse pair add ${p.id} --name ${p.device}`
      : `@${p.device}  ${where}  older Morse (no device ID) — upgrade it to pair`;
  }
  // an own device just says "paired"; a device of someone else always says so
  const tier = snapshot.trusted?.find((t) => t.id === p.id)?.tier ?? 'owner';
  const state = tier === 'peer' ? `paired (${describeTier(tier)})` : 'paired';
  return `@${p.trustedName ?? p.device}  ${where}  ${state}  ${shortDeviceId(p.id)}`;
}

function pendingLines(c: UntrustedContact): string {
  const from = c.claimedName ?? 'unknown device';
  const address = c.address ? ` (${c.address})` : '';
  const nameFlag = c.claimedName ? ` --name ${c.claimedName}` : '';
  return `pairing request from ${from}${address}: ${c.id}\n  if that is yours: morse pair add ${c.id}${nameFlag}`;
}

/** The `morse peers` view: devices on the LAN, pairing requests, relay, paired devices, and this device's ID. */
export function formatPeers(snapshot: PeersSnapshot, selfId: string): string[] {
  const out = [...snapshot.peers.map((p) => discoveredLine(p, snapshot)), ...(snapshot.pending ?? []).map(pendingLines)];
  if (!out.length && snapshot.lan !== false) out.push('no peers found on the LAN (is morse start running on the other device? same network?)');

  const relay = snapshot.relay as { url: string; connected: boolean; handle?: string | null } | null | undefined;
  if (relay) {
    const you = relay.handle ? `  (you are morse.im/${relay.handle})` : '';
    out.push(`relay: ${relay.url} — ${relay.connected ? 'connected' : 'NOT connected'}${you}`);
  }
  const trusted = snapshot.trusted ?? [];
  if (trusted.length) out.push('paired devices:', ...trusted.map((t) => `  @${t.name}  tier: ${describeTier(t.tier)}  ${shortDeviceId(t.id)}`));
  out.push(`(this device: ${selfId} — the other side adds it with: morse pair add ${selfId})`);
  return out;
}
