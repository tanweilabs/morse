import { morseHome } from '../home.js';
import { bareHandle, formatAddress } from './address.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';
import { requestsFullLine, type MessageRequest } from '../mailbox/requests.js';
import { blockHandle, unblockHandle } from './blocklist.js';
import { formatBytes } from './chunks.js';
import { isAddress } from '../identity/address.js';
import { seenKeyFor } from '../mailbox/contacts.js';
import type { TrustStore, TrustedDevice } from './trust.js';

/**
 * Accepting / declining a Morse message request (ADR-037). Both only ever happen on
 * the operator's explicit word (`morse contact accept|block`, `morse pair add`,
 * or sending to that person) — never by an agent on its own.
 */

/** What a stranger's first message may become in config: request (default), accept (old auto pair-back), block. */
export type StrangerMode = 'request' | 'accept' | 'block';

/** `morse.strangers` from ~/.morse/config.json; the old `autoPairBack: false` means block. */
export function strangerMode(cfg: { strangers?: unknown; autoPairBack?: unknown } | undefined): StrangerMode {
  const s = cfg?.strangers;
  if (s === 'request' || s === 'accept' || s === 'block') return s;
  if (cfg?.autoPairBack === false) return 'block';
  return 'request';
}

/** `morse.im/x`, `morse.im/x/air`, `@x` → `x` — how requests are keyed. Compatibility: any host in front is
 *  accepted, so an address typed with the retired `morse.talk/` still finds its request (ADR-075). */
export const handleKey = (raw: string): string => bareHandle(raw);

export type AcceptOutcome =
  | { ok: true; request: MessageRequest; message: Message; device: TrustedDevice; /** the contact it became */ contactId: string }
  | { ok: false; error: string; /** (ADR-083) it waits at several of my addresses ('' = the first) and none was named */ ambiguous?: string[] };

/**
 * (ADR-083) WHICH request `handle` means: the one at the address of mine that is named (`my`: '' = the
 * first); with none named, the one there is — two are never guessed between.
 */
export function pickRequest(mailbox: Mailbox, handle: string, my?: string | null): { request: MessageRequest } | { error: string; ambiguous?: string[] } {
  const none = `no message request from morse.im/${handle} (morse contact lists them)`;
  if (my !== undefined && my !== null) {
    const r = mailbox.requests.get(handle, mailbox.contacts.mine(my));
    return r ? { request: r } : { error: none };
  }
  const all = mailbox.requests.find(handle);
  if (all.length > 1) return { error: `morse.im/${handle} has a message request at ${all.length} of your addresses — say which one: --from <name>`, ambiguous: all.map((r) => r.myAddress) };
  return all[0] ? { request: all[0] } : { error: none };
}

/**
 * Pair the person as `peer` (the device that wrote — verified when the request was
 * filed; their other devices pair on their first message), unblock them, and move the
 * request's message into the inbox as a normal peer message. Needs no relay.
 *
 * ADR-081: a request that ARRIVED BY ADDRESS (`toAddress` set: signed by the address it is keyed by,
 * written to that address of yours) becomes the address-only contact `a:<address>` — nothing is
 * written to trusted-devices.json (there is no device to pair: the address is the identity), the
 * message keeps the bare address as its sender and the address of yours it was written to.
 *
 * An old handle never has the shape of an address. A request keyed by an address-shaped string that
 * did NOT arrive by address (a device the relay listed under such a "handle" — only a row from before
 * this was refused on arrival can be one) is not accepted at all: as an address it would put a
 * stranger's text into the thread of whoever really holds that address.
 */
export function acceptRequest(raw: string, opts: { mailbox: Mailbox; trust: TrustStore; home?: string; /** (ADR-083) the address of mine it waits at ('' = the first) */ myAddress?: string | null }): AcceptOutcome {
  const home = opts.home ?? morseHome();
  const handle = handleKey(raw);
  const picked = pickRequest(opts.mailbox, handle, opts.myAddress);
  if ('error' in picked) return { ok: false, ...picked };
  const req = picked.request;
  const list = req.droppedFileList?.length ? `: ${req.droppedFileList.map((f) => `${f.name} (${formatBytes(f.size)})`).join(', ')}` : '';
  const note = req.droppedFiles
    ? `\n\n[${req.droppedFiles} attachment(s) not kept while this was a message request${list} — they send them again now that you accepted (if they do not: their Morse is older — ask them to send the files again)]`
    : '';
  if (isAddress(handle) && !req.toAddress) {
    return { ok: false, error: `the request filed under morse.im/${handle} did not come from that address (it came the old way, from a sender the relay listed under an address-shaped name) — it cannot be accepted: morse contact reject ${handle}` };
  }
  if (req.toAddress) {
    if (!isAddress(handle)) return { ok: false, error: `the request from morse.im/${handle} is damaged (by address, but not keyed by one) — morse contact reject ${handle}` };
    // (ADR-083) a contact OF the address of mine it was written to — and of no other
    const contact = opts.mailbox.contacts.ensureAddress(handle, req.myAddress);
    const message: Message = opts.mailbox.send({
      from: { agent: req.from.agent, sessionId: req.from.sessionId, device: handle },
      to: req.to,
      text: req.text + note,
      via: req.via,
      fromTier: 'peer',
      contactId: contact.id,
      // which address of yours they wrote to: the `accepted` notice and your replies are signed by it
      myAddress: req.toAddress,
      ...(req.contextId ? { contextId: req.contextId } : {}),
    });
    opts.mailbox.contacts.unblockAt(handle, req.myAddress);
    if (contact.state === 'blocked') opts.mailbox.contacts.set(contact.id, { state: 'active' });
    // a late resend of this very message is a duplicate (the dedupe key of mail by address is the pair)
    opts.mailbox.firstSeen(seenKeyFor(handle, req.myAddress), req.msgId);
    opts.mailbox.requests.remove(handle, req.myAddress);
    return { ok: true, request: req, message, device: { id: handle, name: handle, tier: 'peer', addedAt: Date.now() }, contactId: contact.id };
  }
  const input = {
    from: { agent: req.from.agent, sessionId: req.from.sessionId, device: req.fromAgent ? `${handle}/${req.fromAgent}` : handle },
    to: req.to,
    text: req.text + note,
    via: req.via,
    fromTier: 'peer' as const,
  };
  const message: Message = opts.mailbox.send({ ...input, ...(req.contextId ? { contextId: req.contextId } : {}) });
  const known = opts.trust.get(req.deviceId);
  const device = known?.tier === 'owner' ? known : opts.trust.add({ id: req.deviceId, name: handle, tier: 'peer' });
  unblockHandle(handle, home);
  // ADR-049: accepted = a contact (group `other` until the owner labels them);
  // ADR-065: named only by the owner's remark — an old client's nickname is ignored
  opts.mailbox.contacts.ensure(handle);
  // a late resend of this very message is now a duplicate, not a second copy
  opts.mailbox.firstSeen(req.deviceId, req.msgId);
  opts.mailbox.requests.remove(handle);
  return { ok: true, request: req, message, device, contactId: message.contactId ?? `c:${handle}` };
}

/** Delete the request and block the person: their messages are dropped from now on. */
export function declineRequest(raw: string, opts: { mailbox: Mailbox; home?: string; myAddress?: string | null }): { ok: true; request: MessageRequest } | { ok: false; error: string; ambiguous?: string[] } {
  const handle = handleKey(raw);
  const picked = pickRequest(opts.mailbox, handle, opts.myAddress);
  if ('error' in picked) return { ok: false, ...picked };
  const req = picked.request;
  opts.mailbox.requests.remove(handle, req.myAddress);
  // (ADR-083) a request by address: blocked at the address of mine it was written to; the old way: the old handle
  if (req.toAddress && isAddress(handle)) opts.mailbox.contacts.blockAt(handle, req.myAddress);
  else blockHandle(handle, opts.home ?? morseHome());
  return { ok: true, request: req };
}

const two = (n: number) => String(n).padStart(2, '0');
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** `morse contact` lines. `max` (how many are kept): says so when the area is full. */
export function formatRequests(list: MessageRequest[], opts: { max?: number; /** (ADR-083) more than one address here: how each of mine is called ('' = the first) — every line then says which */ via?: (my: string) => string } = {}): string[] {
  if (list.length === 0) return ['no message requests'];
  const lines = [`${list.length} message request(s) — addresses you have not accepted; nothing here reaches your inbox or your agents until you accept:`];
  if (opts.max && !opts.via && list.length >= opts.max) lines.push(requestsFullLine(list.length, opts.max));
  // (ADR-083) each address of yours has its own room
  if (opts.max && opts.via) {
    const per = new Map<string, number>();
    for (const r of list) per.set(r.myAddress, (per.get(r.myAddress) ?? 0) + 1);
    for (const [my, n] of per) if (n >= opts.max) lines.push(`${opts.via(my)}: ${requestsFullLine(n, opts.max)}`);
  }
  for (const r of list) {
    const address = formatAddress(r.handle, r.fromAgent);
    const who = address; // ADR-065: a stranger has no remark yet — only the address, never a nickname
    const device = `${r.deviceName ? `${r.deviceName} ` : ''}${r.deviceId.slice(0, 7)}`;
    const more = r.count > 1 ? `  (+${r.count - 1} more dropped, last ${stamp(r.lastAt)})` : '';
    const text = r.text.replace(/\s+/g, ' ').trim();
    // ADR-081: a request by address has no computer behind it to name — the address is all there is
    lines.push(`  ${who}  ${r.toAddress ? '' : `computer ${device}  `}${stamp(r.firstAt)}${more}${opts.via ? `  via ${opts.via(r.myAddress)}` : ''}`);
    const files = r.droppedFileList?.length
      ? `  [${r.droppedFileList.length} attachment(s) not kept: ${r.droppedFileList.map((f) => `${f.name} ${formatBytes(f.size)}`).join(', ')} — sent after you accept]`
      : r.droppedFiles
        ? `  [${r.droppedFiles} attachment(s) not kept]`
        : '';
    lines.push(`    ${JSON.stringify(text.length > 100 ? `${text.slice(0, 100)}…` : text)}${files}`);
    if (isAddress(r.handle) && !r.toAddress) lines.push(`    [this did NOT come from this address — a sender the relay listed under an address-shaped name wrote it; it cannot be accepted: morse contact reject ${r.handle}]`);
  }
  lines.push('accept:  morse contact accept <address>     reject:  morse contact reject <address>     block:  morse contact block <address>');
  return lines;
}
