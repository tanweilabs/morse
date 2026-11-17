import { dataDir } from '../home.js';
import { stripAddressHost } from './address.js';
import { getDeviceName } from './device.js';
import { loadOrCreateIdentity, normalizeDeviceId, shortDeviceId } from './identity.js';
import { startPeerRegistry, type Peer } from './peers.js';
import type { UntrustedContact } from './secure-transport.js';
import { createTrustStore, type TrustedDevice } from './trust.js';

/**
 * `morse pair` / `morse peers` (ADR-028). Pairing is Syncthing's: each side adds the
 * other's public device ID. Nothing secret is ever printed or pasted.
 */

const INSTALL_URL = 'https://raw.githubusercontent.com/Ericgood/any-to-any/main/install.sh';

/** What the running daemon reports at /api/peers. */
export interface PeersSnapshot {
  lan: boolean;
  self?: { device: string; id: string } | null;
  peers: Array<Peer & { paired?: boolean; trustedName?: string }>;
  pending?: UntrustedContact[];
  /** Every paired device with its trust tier (Morse) — LAN-visible or not. */
  trusted?: TrustedDevice[];
  /** Morse relay status, when one is configured. */
  relay?: { url: string; connected: boolean } | null;
}

async function fetchSnapshot(port: number | undefined): Promise<PeersSnapshot | null> {
  try {
    // (ADR-087) this home's daemon, with this home's token — never whatever else listens on a port
    const { localApi } = await import('../daemon/local-api.js');
    const res = await localApi('/api/peers', { port, timeoutMs: 3000 });
    return res.ok ? ((await res.json()) as PeersSnapshot) : null;
  } catch {
    return null; // no daemon running for this home
  }
}

/** Name for a newly trusted device: explicit > what it announced/claimed > device-<short id>. */
export function suggestName(id: string, snapshot: PeersSnapshot | null): string {
  const seen = snapshot?.peers.find((p) => p.id === id)?.device;
  const claimed = snapshot?.pending?.find((c) => c.id === id)?.claimedName;
  return seen ?? claimed ?? `device-${shortDeviceId(id).toLowerCase()}`;
}

export function showSelf(): void {
  const { id } = loadOrCreateIdentity();
  const name = getDeviceName();
  console.log(`device: ${name}`);
  console.log(`id:     ${id}`);
  console.log(`\nThis ID is public — sharing it is safe. To pair with another device of yours:`);
  console.log(`  on the other device:  morse pair add ${id} --name ${name}`);
  console.log(`  then here:            morse pair add <its id>        (\`morse peers\` shows it)`);
  console.log(`New device without Morse yet?  morse pair --invite`);
}

export function showInvite(): void {
  const { id } = loadOrCreateIdentity();
  const name = getDeviceName();
  console.log(`Paste this into the other device's terminal — or hand it to any agent there:\n`);
  console.log(`  curl -fsSL ${INSTALL_URL} | bash -s -- --trust ${id} --trust-name ${name}\n`);
  console.log(`It installs Morse, trusts this device, and prints its own ID.`);
  console.log(`Then, back here:  morse pair add <the ID it printed>`);
  console.log(`(Only public IDs are exchanged — nothing in this command is secret. ADR-028)`);
}

/**
 * `morse pair add morse.im/mei` (or just `mei`): pair every device of a
 * person listed under that handle on the Morse relay — tier `peer` (someone else's
 * agents), or `owner` when it is your OWN handle (ADR-034: only your invites put a
 * device under it). An owner entry is never downgraded.
 */
export async function addTrustedHandle(raw: string, opts: { url?: string; home?: string; mailbox?: import('../mailbox/mailbox.js').Mailbox; port?: number | undefined }): Promise<boolean> {
  const { parseMorseAddress, lookupHandle, tierForHandle } = await import('./morse.js');
  const { readMachineConfig } = await import('../machine-config.js');
  const addr = parseMorseAddress(raw);
  if (!addr || addr.agent) {
    console.error(`error: "${raw}" is neither a device ID nor a handle (e.g. morse.im/mei)`);
    return false;
  }
  const url = opts.url ?? readMachineConfig().relay?.url;
  if (!url) {
    console.error('error: no relay configured — morse relay set wss://<relay> first (handles live on the relay)');
    return false;
  }
  let found;
  try {
    found = await lookupHandle(addr.handle, { url, ...(opts.home ? { home: opts.home } : {}) });
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const self = loadOrCreateIdentity(opts.home);
  const devices = found.devices.filter((d) => d.id !== self.id);
  if (devices.length === 0) {
    console.error(`error: the relay has no device under "${addr.handle}" (the relay operator adds devices to a handle)`);
    return false;
  }
  const trust = createTrustStore(opts.home);
  const { unblockHandle } = await import('./blocklist.js');
  if (unblockHandle(addr.handle, opts.home)) console.log(`unblocked ${addr.handle}`);
  const tier = tierForHandle(addr.handle, found.self);
  for (const d of devices) {
    const known = trust.get(d.id);
    const entry = known?.tier === 'owner' ? known : trust.add({ id: d.id, name: addr.handle, tier });
    console.log(`trusted ${addr.handle}'s device ${d.name ? `"${d.name}" ` : ''}${shortDeviceId(d.id)}  tier: ${entry.tier}${tier === 'owner' ? ' (your own handle)' : ''}  ${d.keyPinned ? 'key pinned' : 'no key yet (it has not logged in to the relay)'}`);
  }
  // pairing someone = accepting their waiting message request, if any (ADR-037)
  const mailbox = opts.mailbox ?? (await openMailboxAt(opts.home));
  const { acceptRequest } = await import('./requests.js');
  const accepted = acceptRequest(addr.handle, { mailbox, trust, ...(opts.home ? { home: opts.home } : {}) });
  if (accepted.ok) {
    console.log(`accepted their message request — it is in your inbox now [${accepted.message.id.slice(0, 8)}]`);
    // tell THIS device's daemon (it checks the device ID), so it notifies them now
    {
      const { localApi } = await import('../daemon/local-api.js');
      await localApi('/api/morse/accepted', { port: opts.port, json: { handle: addr.handle, deviceId: self.id }, timeoutMs: 15_000 }).catch(() => undefined); // no daemon running: they find out on their next try
    }
  }
  console.log(`send with:  morse send morse.im/${addr.handle} "hello"   (or morse.im/${addr.handle}/<agent>)`);
  console.log(`Your first message reaches ${addr.handle} as a message request until they accept you (morse contact on their side).`);
  console.log('Pairing by handle trusts the relay for WHICH devices are theirs; each key is still verified against its device ID.');
  return true;
}

async function openMailboxAt(home?: string) {
  const { createDb } = await import('../mailbox/db.js');
  const { createMailbox } = await import('../mailbox/mailbox.js');
  const { join } = await import('node:path');
  return createMailbox(createDb(join(dataDir(home), 'mailbox.db')));
}

export async function addTrusted(rawId: string, opts: { name?: string; port?: number | undefined; peer?: boolean; relayUrl?: string }): Promise<boolean> {
  const id = normalizeDeviceId(rawId);
  if (!id) {
    if (/^[^:\s]+$/.test(rawId.trim()) && rawId.length < 64) return addTrustedHandle(rawId, { ...(opts.relayUrl ? { url: opts.relayUrl } : {}), port: opts.port });
    console.error(`error: "${rawId}" is not a device ID (52 letters/digits, e.g. ABCDEFG-HIJKLMN-…) nor a handle (morse.im/<name>).`);
    return false;
  }
  const self = loadOrCreateIdentity();
  if (id === self.id) {
    console.error('error: that is this device’s own ID — run `morse pair add` with the OTHER device’s ID');
    return false;
  }
  const name = opts.name ?? suggestName(id, await fetchSnapshot(opts.port));
  const entry = createTrustStore().add({ id, name, tier: opts.peer ? 'peer' : 'owner' });
  console.log(
    entry.tier === 'peer'
      ? `trusted @${entry.name} (${entry.id}) — tier: peer (someone else's device; its messages are labelled as peer messages and never carry your authority)`
      : `trusted @${entry.name} (${entry.id}) — tier: owner (your own device; its messages carry your authority)`,
  );
  console.log(`The other device must also trust this one:  morse pair add ${self.id} --name ${getDeviceName()}`);
  console.log('A running daemon picks this up immediately — no restart needed.');
  return true;
}

export async function removeTrusted(idOrName: string, home?: string): Promise<boolean> {
  const byId = normalizeDeviceId(idOrName);
  const key = byId ?? stripAddressHost(idOrName);
  const trust = createTrustStore(home);
  const { readMachineConfig } = await import('../machine-config.js');
  const { join } = await import('node:path');
  const ownHandle = readMachineConfig(home ? join(dataDir(home), 'config.json') : undefined).relay?.handle?.toLowerCase();
  // a person's handle (theirs, or your own — ADR-034 would otherwise re-pair your devices as owner)
  const peerHandle =
    !byId &&
    (key.toLowerCase() === ownHandle || trust.list().some((d) => d.tier === 'peer' && d.name.toLowerCase() === key.toLowerCase()));
  let n = 0;
  while (trust.remove(key)) n++; // a handle may cover several devices
  if (n === 0) {
    console.error(`error: no paired device matches "${idOrName}" (morse pair list)`);
    return false;
  }
  console.log(`removed ${idOrName}${n > 1 ? ` (${n} devices)` : ''} — it can no longer talk to this device`);
  if (peerHandle) {
    // otherwise their next message would pair them right back (ADR-032)
    const { blockHandle } = await import('./blocklist.js');
    blockHandle(key, home);
    console.log(`blocked morse.im/${key.toLowerCase()} — their messages are dropped (undo: morse pair add morse.im/${key.toLowerCase()})`);
  }
  return true;
}

export const tierLabel = (tier: TrustedDevice['tier']): string =>
  tier === 'peer' ? "peer (someone else's agent — not your instructions)" : 'owner';

/** `remarks`: YOUR remark per handle (ADR-065) — never a self-chosen nickname. */
export function formatTrustList(devices: TrustedDevice[], remarks: Record<string, string> = {}): string[] {
  if (devices.length === 0) return ['no paired devices — morse pair shows how to add one'];
  return devices.map((d) => {
    const remark = remarks[d.name.toLowerCase()];
    return `@${d.name}${remark ? ` (${remark})` : ''}  ${d.id}  tier: ${tierLabel(d.tier)}  since ${new Date(d.addedAt).toISOString().slice(0, 10)}`;
  });
}

export async function listTrusted(): Promise<void> {
  const mailbox = await openMailboxAt();
  const remarks = Object.fromEntries(mailbox.contacts.list().flatMap((c) => (c.handle && c.remark ? [[c.handle.toLowerCase(), c.remark]] : [])));
  for (const line of formatTrustList(createTrustStore().list(), remarks)) console.log(line);
}

/** `morse peers` lines: discovered devices, their pairing state, and pending requests. */
export function formatPeers(snapshot: PeersSnapshot, selfId: string): string[] {
  const lines: string[] = [];
  for (const p of snapshot.peers) {
    if (p.paired) {
      const tier = snapshot.trusted?.find((t) => t.id === p.id)?.tier ?? 'owner';
      // owner stays the plain "paired"; a peer-tier device is always called out
      lines.push(`@${p.trustedName ?? p.device}  ${p.host}:${p.port}  paired${tier === 'peer' ? ` (${tierLabel(tier)})` : ''}  ${shortDeviceId(p.id)}`);
    } else if (!p.id) {
      lines.push(`@${p.device}  ${p.host}:${p.port}  older Morse (no device ID) — upgrade it to pair`);
    } else {
      lines.push(`@${p.device}  ${p.host}:${p.port}  NOT paired — to trust it: morse pair add ${p.id} --name ${p.device}`);
    }
  }
  for (const c of snapshot.pending ?? []) {
    lines.push(
      `pairing request from ${c.claimedName ?? 'unknown device'}${c.address ? ` (${c.address})` : ''}: ${c.id}` +
        `\n  if that is yours: morse pair add ${c.id}${c.claimedName ? ` --name ${c.claimedName}` : ''}`,
    );
  }
  if (lines.length === 0 && snapshot.lan !== false) lines.push('no peers found on the LAN (is morse start running on the other device? same network?)');
  if (snapshot.relay) {
    const r = snapshot.relay as { url: string; connected: boolean; handle?: string | null };
    lines.push(`relay: ${r.url} — ${r.connected ? 'connected' : 'NOT connected'}${r.handle ? `  (you are morse.im/${r.handle})` : ''}`);
  }
  if (snapshot.trusted?.length) {
    lines.push('paired devices:');
    for (const t of snapshot.trusted) lines.push(`  @${t.name}  tier: ${tierLabel(t.tier)}  ${shortDeviceId(t.id)}`);
  }
  lines.push(`(this device: ${selfId} — the other side adds it with: morse pair add ${selfId})`);
  return lines;
}

export async function showPeers(port?: number): Promise<void> {
  const self = loadOrCreateIdentity();
  let snapshot = await fetchSnapshot(port);
  if (snapshot && !snapshot.lan) {
    console.log('daemon is running with LAN peering disabled (--no-lan)');
    if (!snapshot.trusted) snapshot.trusted = createTrustStore().list();
    console.log(`self: @${getDeviceName()}`);
    for (const line of formatPeers(snapshot, self.id)) console.log(line);
    return;
  }
  if (!snapshot) {
    const registry = startPeerRegistry({ selfDevice: getDeviceName(), selfId: self.id, port: 0, publish: false });
    console.log('daemon not reachable — passive mDNS scan for 3s…');
    await new Promise((r) => setTimeout(r, 3000));
    const trust = createTrustStore();
    snapshot = {
      lan: true,
      peers: registry.list().map((p) => {
        const t = p.id ? trust.get(p.id) : undefined;
        return { ...p, paired: Boolean(t), ...(t ? { trustedName: t.name } : {}) };
      }),
      trusted: trust.list(),
    };
    registry.stop();
  }
  console.log(`self: @${getDeviceName()}`);
  for (const line of formatPeers(snapshot, self.id)) console.log(line);
}
