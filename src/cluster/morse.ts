import { createHash, createPrivateKey, randomInt, randomUUID, X509Certificate } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { morseHome, dataDir } from '../home.js';
import { readMachineConfig } from '../machine-config.js';
import { safeFileName, uniqueFileName } from '../platform/filename.js';
import { hasAddressHost, OLD_NAMES_LINE, stripAddressHost } from './address.js';
import { isBlocked, unblockHandle } from './blocklist.js';
import type { Mailbox, Message, MessageFile } from '../mailbox/mailbox.js';
import { loadOrCreateEncKey, makeKeyBundle, open, seal, verifyKeyBundle, type KeyBundle, type SealedEnvelope } from './e2e.js';
import { deviceIdFromCert, loadOrCreateIdentity, type DeviceIdentity } from './identity.js';
import { addressFromPublicKey, keyMatchesAddress, looksLikeAddress, rawPublicKey } from '../identity/address.js';
import { loadPrimaryAddress, signAs, type AddressKey } from '../identity/address-key.js';
import { agentAddressIndex, ensureAgentAddresses } from '../identity/agent-addresses.js';
import { nameOfAddress as shownNameOf } from '../identity/address-labels.js';
import { OWN_DEVICE, SELF_CONTACT, seenKeyFor, type Contact } from '../mailbox/contacts.js';
import { completeContactSplit, type SplitOutcome } from './contact-split.js';
import { demotedDevices, effectiveTrust, pinnedAddressLookup } from './effective-trust.js';
import { normalizeAddress } from '../identity/address.js';
import { isEnvelopeV3, openV3, PrekeyUnknownError, sealV3, type EnvelopeV3, type OpenedV3 } from '../identity/envelope.js';
import { ensurePrekeys, PREKEY_JITTER_MS, verifyPrekey, type PrekeyRecord, type PrekeyState } from '../identity/prekeys.js';
import { startRotationSchedule, systemClock, twinsOf, type RotationClock, type RotationSchedule } from '../identity/prekey-schedule.js';
import { localAgents, normalizeAgentName } from './agents.js';
import { createRepeatFilter } from '../daemon/log-hygiene.js';
import { startDirect, type DirectLink, type DirectStatus, type DirectTuning } from './direct.js';
import { CAP_ADDR1, DEFAULT_RELAY_LIMITS, startRelayClient, type AgentLocation, type HandleDevice, type RelayClient, type RelayDelivery, type RelayLimits, type RelayState, type Undeliverable } from './relay-client.js';
import { createTrustStore, type TrustStore, type TrustTier, type TrustedDevice } from './trust.js';
import type { LanMorseLink } from './lan.js';
import type { AddressLan } from './lan-address.js';
import { acceptRequest, handleKey, strangerMode, type StrangerMode } from './requests.js';
import {
  chunkRateFor,
  chunkSizeFor,
  createIncomingStore,
  decodeChunk,
  DEFAULT_CHUNK_BYTES,
  encodeChunk,
  fileLimitsFrom,
  formatBytes,
  isLanChunk,
  manifestFor,
  OutboundTransfer,
  sha256FileSync,
  Throttle,
  totalBytes,
  TransferStop,
  type ChunkHeader,
  type ChunkedManifest,
  type HaveRanges,
  type IncomingStore,
  type IncomingSummary,
  type TransferAnswer,
  type TransferIO,
  type TransferProgress,
  type TransferTuning,
} from './chunks.js';

/**
 * Morse cross-network transport. Every AGENT has one address (ADR-033):
 *
 *   morse.im/mei/air   → the agent "air", hosted on exactly one of mei's devices
 *   morse.im/mei       → mei's DEFAULT agent (her first, or the one she chose)
 *
 * The relay's agent directory says which device hosts an agent. Sending = ask the
 * relay where the agent lives, seal the message for THAT device only (no fan-out),
 * hand it to the relay, which forwards it live or answers "offline". The message
 * counts as delivered only when that device returns an end-to-end receipt; until
 * then it stays in the local outbox and is retried — resolving the agent again each
 * time, so a renamed or moved agent is followed (the relay stores nothing).
 * Inbound: verify + decrypt, check the sender is paired, resolve the agent to a local
 * session (else this computer's agent inbox), file into the mailbox with the sender's
 * trust tier, send a receipt. A person who is NOT paired here (ADR-037) gets one
 * "message request" instead — kept apart from the inbox until the operator accepts —
 * and their receipt says so, so their device holds further messages until then.
 *
 * By address alone (ADR-081, "native"): a bare 26-character address needs no handle, no
 * directory and no pairing — its key hashes to it. Sending to one (or from an address of
 * this computer other than its first): look up key + prekey + capabilities over the v3
 * connection, check them locally, seal a v3 envelope signed by the SENDING address with no
 * device certificate, hand it to the relay (its offline mailbox when they are away).
 * Receiving one: the sender is the signing address — a blocked address is dropped, a
 * contact's address is filed under that contact, anyone else is a message request keyed by
 * the address. Answers (receipts, "accepted", transfer status) go back the same way, signed
 * by the address that was written to. Everything with a device certificate keeps going
 * through the device rules above, unchanged.
 */

/** Person-level address: the human's inbox on the recipient device. */
export const INBOX_AGENT = 'user';
export const INBOX_SESSION = 'inbox';

interface WireFile {
  name: string;
  data: string; // base64
  sha256: string;
}

type Plain =
  | {
      kind: 'message';
      id: string;
      contextId: string;
      from: { agent: string; sessionId: string };
      /** sessionId '' = "whichever session of this agent" — resolved on the recipient. */
      to: { agent: string; sessionId: string };
      /** The sender's own address (ADR-033) — so a reply reaches the agent that wrote,
       *  not just "the person". Honoured only when it matches the paired handle. */
      fromHandle?: string;
      fromAgent?: string;
      /** ADR-036 display nickname: still accepted from old clients, never sent or shown (ADR-065). */
      fromNickname?: string;
      /** ADR-081: "this exchange is by address — answer to the address that signed this envelope".
       *  Such a message carries no fromHandle / fromAgent, and its envelope no device certificate. */
      addr?: 1;
      text: string;
      files?: WireFile[];
      /** ADR-038: files too big for one envelope — their manifest; the bytes follow as chunks. */
      chunked?: ChunkedManifest;
    }
  /** request (ADR-037): it reached the recipient's message requests, not their inbox —
   *  `filed` = it is the waiting request · `dropped` = they already have one from you
   *  (not kept: hold it and send it again once they accept).
   *  chunked (ADR-038): a chunked message, filed with all its files (an older Morse never says so).
   *  full (ADR-081 review F4, only with request 'dropped'): not kept because their message requests are full —
   *  nobody was pushed out for it. An older Morse reads just "dropped" and holds the message, which is right. */
  | { kind: 'receipt'; id: string; request?: 'filed' | 'dropped'; full?: true; chunked?: true }
  /** ADR-037: "I accepted your message request" — send what you held back. */
  | { kind: 'accepted' }
  /** ADR-038: the recipient's side of a chunked transfer — which chunks it holds, or why not. */
  | { kind: 'transfer'; id: string; have?: HaveRanges; reset?: boolean; busy?: boolean; error?: string; unknown?: boolean }
  /** ADR-073: "none of my prekeys opens what you left in my mailbox (ref) — fetch my new one and send it again". */
  | { kind: 'rekey'; ref: string };

type MessagePlain = Extract<Plain, { kind: 'message' }>;

export interface MorseSendResult {
  ok: boolean;
  error?: string;
  /** true = nothing is wrong with the message; the recipient is just not reachable
   *  right now (offline, relay down, no receipt yet). Keep it and retry later. */
  waiting?: boolean;
  /** How it went out (ADR-034, ADR-069): straight over the LAN, a direct WebRTC link,
   *  through the relay, or filed here. */
  via?: 'lan' | 'direct' | 'relay' | 'self';
  /** ADR-037: it arrived, but in the recipient's message requests — they have not accepted you yet. */
  request?: boolean;
  /** (ADR-091 follow-up) it can never go as written (an old name): fail it for good, never "deliver" it anywhere else. */
  terminal?: boolean;
}

/** Inbound rate limits per receiving device (ADR-037): per sending person and in total.
 *  0 = no limit. */
export interface ReceiveLimits {
  perSenderPerMinute: number;
  totalPerMinute: number;
}
/** ADR-073 (owner 2026-11-14): no receive limit unless you set one in `morse.receiveLimit`. */
export const DEFAULT_RECEIVE_LIMITS: ReceiveLimits = { perSenderPerMinute: 0, totalPerMinute: 0 };

/** `morse.receiveLimit` in ~/.morse/config.json: each cap works on its own; missing, 0 or invalid = no limit. */
export function receiveLimitsFrom(cfg: { receiveLimit?: { perSenderPerMinute?: unknown; totalPerMinute?: unknown } } | undefined): ReceiveLimits {
  const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 0);
  return {
    perSenderPerMinute: pos(cfg?.receiveLimit?.perSenderPerMinute),
    totalPerMinute: pos(cfg?.receiveLimit?.totalPerMinute),
  };
}

export interface ReceiveLimiter {
  /** Count one message from `sender`; null = allowed, else the limit it ran into (nothing counted).
   *  (ADR-083) `scope` = the address of mine it was written to ('' = the first): "per sender" is per
   *  (my address, sender), "in total" is per address of mine — what one address takes never counts for another. */
  take(sender: string, scope?: string): null | 'sender' | 'total';
  /** Would one more from `sender` be allowed? (counts nothing) */
  peek(sender: string, scope?: string): boolean;
}

/** Sliding one-minute windows: per sender (a handle, or a device ID) and overall. A cap of 0
 *  is no limit; with neither set nothing is counted. */
export function createReceiveLimiter(limits: () => ReceiveLimits, now: () => number = Date.now): ReceiveLimiter {
  const WINDOW = 60_000;
  const per = new Map<string, number[]>();
  const totals = new Map<string, number[]>();
  const recent = (xs: number[], t: number) => xs.filter((x) => x > t - WINDOW);
  const look = (sender: string, scope: string) => {
    const t = now();
    const all = recent(totals.get(scope) ?? [], t);
    if (all.length) totals.set(scope, all);
    else totals.delete(scope);
    const key = scope ? `${scope}\n${sender.toLowerCase()}` : sender.toLowerCase();
    const xs = recent(per.get(key) ?? [], t);
    if (xs.length) per.set(key, xs);
    else per.delete(key);
    if (per.size > 2000) for (const [k, v] of per) if (!recent(v, t).length) per.delete(k);
    const l = limits();
    const verdict =
      l.perSenderPerMinute > 0 && xs.length >= l.perSenderPerMinute ? ('sender' as const) : l.totalPerMinute > 0 && all.length >= l.totalPerMinute ? ('total' as const) : null;
    return { t, key, xs, all, verdict };
  };
  return {
    take(sender, scope = '') {
      const l = limits();
      if (!(l.perSenderPerMinute > 0) && !(l.totalPerMinute > 0)) return null; // no limit: count nothing
      const { t, key, xs, all, verdict } = look(sender, scope);
      if (verdict) return verdict;
      per.set(key, [...xs, t]);
      totals.set(scope, [...all, t]);
      return null;
    },
    peek: (sender, scope = '') => {
      const l = limits();
      if (!(l.perSenderPerMinute > 0) && !(l.totalPerMinute > 0)) return true;
      return look(sender, scope).verdict === null;
    },
  };
}

export interface MorseOptions {
  url: string;
  mailbox: Mailbox;
  home?: string;
  identity?: DeviceIdentity;
  trust?: TrustStore;
  log?: (line: string) => void;
  onChange?: () => void;
  /** How long `send` waits for the recipient's end-to-end receipt before handing
   *  the message back to the outbox for a later retry. */
  receiptTimeoutMs?: number;
  /** How long `send` waits for the relay connection to come (back) up first. */
  connectWaitMs?: number;
  /** morse.im/<me>/<agent> from one of OUR devices: a registered external agent of
   *  that name (ADR-024). Never consulted for another person's message (ADR-048). */
  resolveAgent?: (agent: string) => Promise<string | null>;
  /** This computer's own agent name (the sender address on what it sends). Default:
   *  `relay.agent` in ~/.morse/config.json, written by `morse join`. */
  selfAgent?: () => string | null;
  /** What a message from someone not paired here becomes (ADR-037): a message request
   *  (default), an automatic pairing (`accept`, the old ADR-032 pair-back), or nothing
   *  (`block`). Default: `morse.strangers` in ~/.morse/config.json. */
  strangers?: () => StrangerMode;
  /** Deprecated (ADR-032): true = strangers `accept`, false = `block`. */
  autoPairBack?: () => boolean;
  /** Inbound rate limits (ADR-037). Default: `morse.receiveLimit` in ~/.morse/config.json. */
  receiveLimits?: () => ReceiveLimits;
  /** While a recipient has not accepted our message request, one held message is tried
   *  again this often (in case their "accepted" notice was missed). Default 10 min. */
  requestProbeMs?: number;
  /** The LAN layer (ADR-034): a recipient device that is paired and discovered on
   *  the LAN gets the message directly over mutual TLS; the relay is the fallback. */
  lan?: LanMorseLink;
  /** How long a first-contact LAN caller may wait for the relay directory (default 3 s). */
  lanAdmitTimeoutMs?: number;
  /**
   * (ADR-091) The LAN by ADDRESS (src/cluster/lan-address.ts): an envelope for an address seen on the LAN goes there
   * first; what arrives on it is handled like a relay delivery.
   */
  lanAddress?: AddressLan;
  /** (ADR-091) After a LAN hand-over, how long to wait for the receipt before the relay carries it (default min(receiptTimeoutMs / 2, 5 s)). */
  lanReceiptMs?: number;
  /** Test hook: replace the relay client. */
  client?: (opts: Parameters<typeof startRelayClient>[0]) => RelayClient;
  /** ADR-038: `morse.maxFileBytes` / `morse.maxStagingBytes`. Default: ~/.morse/config.json. */
  fileLimits?: () => { maxFileBytes: number; maxStagingBytes: number };
  /** ADR-038: preferred chunk size (default 512 KiB; never more than fits one relay envelope). */
  chunkBytes?: number;
  /** ADR-038: chunk envelopes a minute through the relay (default 5/6 of the relay's per-device rate). */
  chunkRatePerMinute?: number;
  /** ADR-038: pause after the relay says "rate limited", before the same envelope goes again (default 2 s). */
  rateBackoffMs?: number;
  /** ADR-038: the recipient acknowledges every N chunks (default 8), or after `ackDelayMs` of quiet (default 300). */
  ackEvery?: number;
  ackDelayMs?: number;
  /** ADR-038: sender flow control (window, timeouts). */
  transferTuning?: TransferTuning;
  /** ADR-038: unfinished incoming transfers older than this are deleted (default 24 h). */
  stagingTtlMs?: number;
  /** ADR-069: direct WebRTC links to contacts' devices, the relay as fallback. Off when
   *  absent (the daemon turns it on from `morse.direct` in ~/.morse/config.json). */
  direct?: DirectTuning | false;
  /** ADR-069: after a direct send, how long to wait for the receipt before the link is
   *  dropped and the message goes through the relay (default min(receiptTimeoutMs / 2, 5 s)). */
  directReceiptMs?: number;
  /** ADR-073: use identity v3 (addresses, v3 envelopes, the offline mailbox) once the relay
   *  announces protocol 3. Default true; false = behave exactly like a client before v3. */
  v3?: boolean;
  /** ADR-073: how long a recipient's v3 lookup (address + prekey) is reused (default 10 min). */
  v3LookupTtlMs?: number;
  /**
   * ADR-081: the capabilities published for every address this computer logs in. Default
   * `['addr1']`. Without `addr1` this client behaves exactly like the release before
   * (20261114170051): it neither sends nor takes mail by address alone (tests: an older peer).
   */
  caps?: string[];
  /**
   * (ADR-083 review R4, tests) The clock and timers the prekeys of this computer's addresses are replaced on —
   * each address at its own moments (src/identity/prekey-schedule.ts). Default: the system's. With one given,
   * a new prekey is dated exactly "now" (no random stretch back), so a test can tell what it will see.
   */
  prekeyClock?: RotationClock;
}

/** Outcome of pairing a person by handle through the live relay connection. */
export type PairOutcome =
  | { ok: true; devices: TrustedDevice[] }
  /** waiting = the relay is not reachable right now; nothing is wrong with the handle */
  | { ok: false; waiting?: boolean; error: string };

export interface Morse {
  client: RelayClient;
  /** `to` is a handle (person; the agent comes from the message, none = their
   *  default agent), `handle/agent`, a paired device name, or a device ID. */
  send(to: string, message: Message): Promise<MorseSendResult>;
  /** Whether `to` names someone we could reach through the relay. */
  knows(to: string): boolean;
  /** Pair every device of a person (tier peer) via the relay directory — what
   *  `morse send morse.im/<handle>` does on first contact. Unblocks the handle. */
  pairHandle(handle: string): Promise<PairOutcome>;
  status(): { url: string; connected: boolean; handle: string | null; agent: string | null; limits: RelayLimits; state?: RelayState; direct?: DirectStatus; v3?: { connected: boolean; address: string } };
  /** Process one inbound delivery (exposed for tests). */
  receive(d: RelayDelivery): Promise<void>;
  /** (ADR-091 follow-up) The LAN listener asks: does this envelope open here (signature, an address hosted here)?
   *  Nothing is filed or answered. `known` = its sender is a contact of the address it was written to. */
  lanCheck?(blob: string): Promise<{ ok: boolean; from?: string; known?: boolean }>;
  /** (ADR-091 follow-up) The LAN proof: sign with the key of `address` — only this computer's FIRST address. */
  lanSign?(address: string, message: Buffer): { publicKey: Buffer; sig: Buffer } | null;
  /** A Morse message handed over directly on the LAN by a trusted device (ADR-034):
   *  filed exactly like a relay delivery; the answer is the receipt. */
  receiveDirect(peer: TrustedDevice, body: unknown): Promise<{ status: number; body: unknown }>;
  /** First contact over the LAN (ADR-034): an unpaired device that claims `handle` wants
   *  to hand us a message. Pair it like a relay pair-back — the relay directory must list
   *  that device under the handle with a key bundle that verifies against its ID — and
   *  return its trust entry; undefined (= refuse) when the relay cannot confirm it right
   *  now, auto pair-back is off, or the handle is blocked. */
  admitDirect(deviceId: string, handle: string): Promise<TrustedDevice | undefined>;
  /** Upgrade devices the relay lists under OUR handle from peer to owner (ADR-034).
   *  Runs by itself after every relay login; exposed for tests. */
  syncOwnDevices(): Promise<TrustedDevice[]>;
  /** ADR-037: tell a person whose message request was accepted here, so their device
   *  sends what it held back. Best effort; returns how many of their devices got it. */
  notifyAccepted(handle: string, /** (ADR-083) the address of mine that accepted ('' = the first); an address request tells only as that one */ myAddress?: string | null): Promise<number>;
  /** ADR-038: progress of an outgoing chunked message (undefined = none running here). */
  transfer(msgId: string): TransferProgress | undefined;
  transfers(): TransferProgress[];
  /** ADR-038: unfinished incoming chunked messages ("receiving x/y"). */
  incoming(): IncomingSummary[];
  /** (ADR-083 review R4, tests) When each address of this computer next looks at its prekey — its own moment, not a shared tick. */
  prekeySlots?(): Array<{ address: string; at: number }>;
  /**
   * (tests) Stop waiting for the receipt of this message NOW, as if `receiptTimeoutMs` had run out: the
   * `send` that waits returns "forwarded but no receipt". false = no `send` is waiting for it. A test
   * harness that can see that nothing is on its way ends the wait with this instead of with a short
   * timeout — which, on a busy machine, runs out before an answer that IS on its way arrives.
   */
  expireReceiptWait?(msgId: string): boolean;
  /** ADR-069: resolves once the direct-link module is loaded (or known missing). */
  ready?(): Promise<void>;
  /** ADR-073: the v3 connection (null until the relay announced protocol 3). */
  v3Client?(): RelayClient | null;
  /** ADR-073: this computer's address (null until v3 started). */
  address?(): string | null;
  /** ADR-077: every address this computer hosts (one per agent), the device key's first. */
  addresses?(): Array<{ address: string; agent: string | null }>;
  /** ADR-077: the online half of the contact migration (runs by itself after every relay login;
   *  exposed for tests and `morse status`). */
  migrateContacts?(): Promise<SplitOutcome>;
  /**
   * ADR-081: would a message to `to` (sent from the address of this computer named `from` — its local
   * name or the address itself; default its first) go by address alone — and can it? null = no: the
   * usual path (a session, an old name, a paired device). `ok: false` without `waiting` = it cannot be
   * sent (their Morse is too old, nobody published that address, `from` is not an address this daemon
   * holds, …): say so and queue nothing. `ok: true` names the address of ours it goes out from — the
   * caller records it with the message (`myAddress`).
   */
  /**
   * (ADR-081 review: legacy rows) Which address of this computer `from` is — a local name (`morse address`) or the
   * address itself — and the name it has here (display). Also one on disk this daemon has not loaded
   * yet. null = no address of this computer answers to that name. The caller records the ADDRESS with
   * the message it queues; a name alone is never stored.
   */
  ownAddress?(from: string): { address: string; name: string | null } | null;
  /**
   * (ADR-088 §6) The addresses of this home changed on disk (`morse address add` / `remove`): take a new one on,
   * let a removed one go — without restarting the daemon. Returns what changed (by address).
   */
  reloadAddresses?(): { added: string[]; removed: string[] };
  addressRoute?(to: string, from?: string | null): Promise<null | { ok: true; address: string; /** the address of OURS it goes out from */ from: string } | { ok: false; waiting?: boolean; error: string }>;
  /**
   * ADR-081: you are writing to this address — that accepts it (ADR-037): it is unblocked, its
   * waiting message request (if any) moves to your inbox, and it is a contact (`a:<address>` when
   * nobody had it). Returns the contact id.
   */
  acceptAddress?(address: string, /** (ADR-083) the address of mine that writes (default: the first) — it becomes THAT address's contact */ from?: string | null): string | null;
  stop(): void;
}

/** A sender-chosen file name made safe to create — here and on Windows (ADR-080): src/platform/filename.ts. */
export { safeFileName };

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`relay did not answer within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/** Where received files land: ~/.morse/inbox-files/<message id>/ (dir 0700, files 0600). */
export function inboxFilesDir(home: string = morseHome()): string {
  return join(dataDir(home), 'inbox-files');
}

// --- pinned keys (~/.morse/peer-keys.json) ----------------------------------

const pinsPath = (home: string) => join(dataDir(home), 'peer-keys.json');

export function pinnedBundles(home: string = morseHome()): Record<string, KeyBundle> {
  try {
    return JSON.parse(readFileSync(pinsPath(home), 'utf8')) as Record<string, KeyBundle>;
  } catch {
    return {};
  }
}

/** Pin a VERIFIED bundle (caller ran verifyKeyBundle against the paired device ID). */
export function pinKeyBundle(bundle: KeyBundle, home: string = morseHome()): void {
  // under the file's lock: the daemon and CLI calls pin keys at the same time
  withFileLock(pinsPath(home), () => {
    const pins = pinnedBundles(home);
    pins[bundle.id] = bundle;
    writeFileAtomic(pinsPath(home), `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
  });
}

// --- addresses -----------------------------------------------------------------

export interface MorseAddress {
  handle: string;
  /** undefined = the person's inbox. */
  agent?: string;
}

/**
 * Parse a person-level address: `mei`, `@mei`, `morse.im/mei`,
 * `mei/claude`, `morse.im/mei/claude` — with `https://`, any case, a trailing slash.
 * Compatibility: the same written with `morse.talk/` (the retired domain, ADR-075) is
 * still accepted as input.
 * The host part names the relay the handle lives on; only the configured relay is
 * used, so it is accepted and ignored. Returns null for anything else (e.g.
 * `@device/agent:session`).
 */
export function parseMorseAddress(input: string): MorseAddress | null {
  const s = stripAddressHost(input);
  const m = /^([a-z0-9][a-z0-9_-]{1,31})(?:\/([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?))?$/i.exec(s);
  if (!m || s.includes(':')) return null;
  return { handle: m[1]!.toLowerCase(), ...(m[2] ? { agent: m[2].toLowerCase() } : {}) };
}

export { OLD_NAMES_LINE } from './address.js';

/** `mei/air`, `morse.im/mei/air` → `mei` (the paired name; any host in front, also the retired `morse.talk/` — compatibility); anything else unchanged. */
export function handleOf(to: string): string {
  return stripAddressHost(to).split('/')[0] ?? to;
}

/** All trusted devices that answer to `to` (handle / name — `handle/agent` counts as the handle — or one device ID). */
export function devicesFor(trust: TrustStore, to: string): TrustedDevice[] {
  const byId = trust.get(to);
  if (byId) return [byId];
  const key = handleOf(to).toLowerCase();
  return trust.list().filter((d) => d.name.toLowerCase() === key);
}

/** `morse.im/<handle>…` (any host in front) — an explicit person address, never a local session name. */
export function hasRelayHost(input: string): boolean {
  return hasAddressHost(input);
}

/**
 * The tier for devices the relay lists under `handle` (ADR-034): your OWN handle →
 * `owner` (only you can put a device there — with an invite issued for your handle),
 * anyone else's → `peer`.
 */
export function tierForHandle(handle: string, selfHandle: string | null | undefined): TrustTier {
  return selfHandle && handle.toLowerCase() === selfHandle.toLowerCase() ? 'owner' : 'peer';
}

/**
 * An old (v2) handle never has the shape of an address — exactly 26 characters of the address
 * alphabet, any case (ADR-081 §4; ADR-081 review F3). Requests, blocks and contacts keep an address where a
 * handle used to be, so a relay that listed a device under such a "handle" could pass that device
 * off as the address. Everything that takes a handle from outside (a sender's claim, a relay
 * directory answer, a pairing) refuses one of this shape.
 */
export const addressShapedHandle = (handle: string | null | undefined): boolean => typeof handle === 'string' && looksLikeAddress(handleOf(handle));

/**
 * Trust every device the relay lists under `handle` — tier peer, or owner when it is
 * our own handle (ADR-034) — pinning each key bundle that verifies against its own
 * device ID. With `expect`, nothing is trusted unless that device ID is among them
 * (used when a stranger's message says it is from this handle). Our own device is
 * skipped. An owner entry is never downgraded.
 */
export function trustHandleDevices(
  handle: string,
  found: HandleDevice[],
  opts: { trust: TrustStore; home: string; selfId: string; selfHandle?: string | null; expect?: string; keep?: (deviceId: string) => boolean },
): TrustedDevice[] {
  if (addressShapedHandle(handle)) return []; // (ADR-081 review F3) an address is never a name devices are trusted under
  const devices = found.filter((d) => d.id !== opts.selfId);
  if (opts.expect && !devices.some((d) => d.id === opts.expect)) return [];
  const tier = tierForHandle(handle, opts.selfHandle);
  const out: TrustedDevice[] = [];
  for (const d of devices) {
    const known = opts.trust.get(d.id);
    if (known?.tier === 'owner') {
      out.push(known); // one of your own devices, paired by ID: never downgraded to peer
      continue;
    }
    if (known && opts.keep?.(d.id)) {
      out.push(known); // ADR-077 (N5b): a computer of yours you moved out of group self — its entry is left exactly as it is
      continue;
    }
    if (d.bundle) {
      try {
        verifyKeyBundle(d.bundle, d.id);
        pinKeyBundle(d.bundle, opts.home);
      } catch {
        /* a bad bundle is never pinned; the key is fetched (and verified) at send time */
      }
    }
    out.push(opts.trust.add({ id: d.id, name: handle, tier }));
  }
  return out;
}

/** A receipt as `send` sees it: which device, and whether it went to their message requests. */
interface ReceiptSeen {
  deviceId: string;
  request?: 'filed' | 'dropped';
  /** (ADR-081 review F4) with `dropped`: their message requests are full. */
  full?: boolean;
}

/** Nothing may be signed as this address: this daemon does not hold it right now (ADR-081 review F1). */
class NoSignerError extends Error {
  constructor(readonly address: string) {
    super(`the address ${address} is not here right now (or its key is not loaded)`);
  }
}

/**
 * (ADR-091) The v2 side of a computer that has none (installed since v2 was removed, or `v2: false`): never connected,
 * knows no old name, and every v2 request fails. Everything by address goes over the v3 connection.
 */
function offlineV2(url: string): RelayClient {
  const none = () => Promise.reject(new Error('this computer does not use old names (v2)'));
  return {
    url,
    connected: () => false,
    handle: () => null,
    limits: () => DEFAULT_RELAY_LIMITS,
    protocols: () => [],
    send: none,
    bundle: none,
    lookupHandle: none,
    resolveAgent: none,
    waitConnected: async () => false,
    close: () => undefined,
  };
}

export function startMorse(opts: MorseOptions): Morse {
  const home = opts.home ?? morseHome();
  const log = opts.log ?? (() => undefined);
  const identity = opts.identity ?? loadOrCreateIdentity(home);
  const enc = loadOrCreateEncKey(home);
  // ADR-077: a computer of yours moved out of contact group `self` is a peer wherever its tier is read
  const pinnedAddress = pinnedAddressLookup(home);
  const lowered = demotedDevices(() => opts.mailbox.contacts, log);
  const trust = effectiveTrust(opts.trust ?? createTrustStore(home), lowered);
  const receiptTimeout = opts.receiptTimeoutMs ?? 10_000;
  const connectWait = opts.connectWaitMs ?? 5000;
  /** A LAN caller waits on the line while we ask the relay — keep it under its timeout. */
  const lanAdmitTimeout = opts.lanAdmitTimeoutMs ?? 3000;
  const legacyPairBack = opts.autoPairBack;
  const strangers: () => StrangerMode =
    opts.strangers ?? (legacyPairBack ? () => (legacyPairBack() ? 'accept' : 'block') : () => strangerMode(readMachineConfig().morse));
  /** config limits, re-read at most every 5 s (edits apply without a restart) */
  let limitsCache = { at: 0, limits: DEFAULT_RECEIVE_LIMITS };
  const limits =
    opts.receiveLimits ??
    (() => {
      if (Date.now() - limitsCache.at > 5000) limitsCache = { at: Date.now(), limits: receiveLimitsFrom(readMachineConfig().morse) };
      return limitsCache.limits;
    });
  const limiter = createReceiveLimiter(limits);
  const limitLogged = new Map<string, number>();
  /** Count one inbound message from `who`; false = over the limit (dropped, logged once a minute). */
  const withinLimit = (who: string, how: 'relay' | 'lan', /** (ADR-083) the address of mine it was written to ('' = the first) */ scope = ''): boolean => {
    const over = limiter.take(who, scope);
    if (!over) return true;
    const key = `${over}:${scope}:${who.toLowerCase()}`;
    if (Date.now() - (limitLogged.get(key) ?? 0) > 60_000) {
      limitLogged.set(key, Date.now());
      if (limitLogged.size > 1000) limitLogged.clear();
      log(
        over === 'sender'
          ? `${how}: rate limit — dropping messages from morse.im/${who} (more than ${limits().perSenderPerMinute} a minute; morse.receiveLimit in ~/.morse/config.json) — they keep them and try again later`
          : `${how}: rate limit — dropping inbound messages (more than ${limits().totalPerMinute} a minute in total; morse.receiveLimit in ~/.morse/config.json) — senders keep them and try again later`,
      );
    }
    return false;
  };
  /** ADR-038: file limits from config, re-read at most every 5 s */
  let fileCache = { at: 0, limits: fileLimitsFrom(undefined) };
  const fileLimits =
    opts.fileLimits ??
    (() => {
      if (Date.now() - fileCache.at > 5000) fileCache = { at: Date.now(), limits: fileLimitsFrom(readMachineConfig().morse) };
      return fileCache.limits;
    });
  const incoming: IncomingStore = createIncomingStore({
    home,
    maxFileBytes: () => fileLimits().maxFileBytes,
    maxStagingBytes: () => fileLimits().maxStagingBytes,
    ...(opts.stagingTtlMs ? { ttlMs: opts.stagingTtlMs } : {}),
  });
  try {
    const n = incoming.cleanup();
    if (n) log(`morse: removed ${n} unfinished incoming transfer(s) with no progress for 24 h`);
  } catch {
    /* unreadable staging dir: nothing to clean */
  }
  const cleanupTimer = setInterval(() => {
    try {
      const n = incoming.cleanup();
      if (n) log(`morse: removed ${n} unfinished incoming transfer(s) with no progress for 24 h`);
    } catch {
      /* next hour */
    }
  }, 60 * 60_000);
  cleanupTimer.unref?.();
  const probeMs = opts.requestProbeMs ?? 10 * 60_000;
  const selfAgent = opts.selfAgent ?? (() => localAgents(home).primary);
  /** message id → the device it was sent to (only that device may confirm it). */
  const sentTo = new Map<string, string>();
  /** ADR-046: repeated identical LAN failures per device, logged at growing intervals. */
  const lanFailures = createRepeatFilter();

  let client: RelayClient;
  /** ADR-069: direct WebRTC links to contacts' devices (null = off / relay only). */
  let direct: DirectLink | null = null;
  /** (ADR-091) direct links are between addresses (this computer's first one and a contact), signaled over the v3 connection. */
  const directByAddress = opts.v3 !== false && (opts.caps ?? [CAP_ADDR1]).includes(CAP_ADDR1);
  /** message id → resolver, while `send` waits for an end-to-end receipt. */
  const receiptWaiters = new Map<string, (r: ReceiptSeen) => void>();

  /** The recipient's X25519 key: pinned copy, else fetched from the relay and VERIFIED against its device ID. */
  const recipientKey = async (id: string): Promise<Buffer> => {
    const pinned = pinnedBundles(home)[id];
    if (pinned) return verifyKeyBundle(pinned, id);
    const fetched = await client.bundle(id);
    if (!fetched) throw new Error(`device ${id.slice(0, 7)} has never logged in to the relay — no encryption key yet`);
    const key = verifyKeyBundle(fetched, id); // throws if the relay tampered with it
    pinKeyBundle(fetched, home);
    return key;
  };

  // --- identity v3 (ADR-073): this computer's address, prekeys, the v3 connection ------------

  /** The v3 connection (opened once the v2 relay announced protocol 3). */
  let v3client: RelayClient | null = null;
  let addrKey: AddressKey | null = null;
  let prekeys: PrekeyState | null = null;
  /** ADR-077: the other addresses this computer hosts (agents added after the first) → key, prekeys, agent. */
  const hosted = new Map<string, { key: AddressKey; prekeys: PrekeyState; agent: string }>();
  /** This computer's first address (the device key's) — known without the v3 connection, and without touching the disk. */
  const firstAddress: string | null = (() => {
    try {
      return addressFromPublicKey(rawPublicKey(createPrivateKey(identity.keyPem)));
    } catch {
      return null;
    }
  })();
  /**
   * Review F1: why the other addresses of this computer could not be loaded at start (a damaged
   * agents.json), or null. While set this is NOT "a computer with only its first address": nothing
   * whose address cannot be told is sent.
   */
  let hostedBroken: string | null = null;
  // (ADR-083) contacts, requests, blocks, dedupe and limits are kept per address of mine, the first one as ''
  try {
    opts.mailbox.contacts.knowFirstAddress(firstAddress);
  } catch {
    /* a mailbox without it: every address is told apart by its own string */
  }
  /** How an address of mine is keyed in the stores: '' = this computer's first address, else the address. */
  const mineKey = (self: string): string => (self === firstAddress ? '' : self);
  const certB64 = new X509Certificate(identity.certPem).raw.toString('base64');
  const v3LookupTtl = opts.v3LookupTtlMs ?? 10 * 60_000;
  /** device ID → its v3 address + verified prekey (null = not on v3: use v2), and when we looked. */
  const v3Peers = new Map<string, { at: number; peer: { address: string; prekey: PrekeyRecord } | null }>();

  /** The address of a device: computed from the key in its (pinned, ID-checked) certificate (§12.2). */
  const addressOfDevice = (deviceId: string): string | null => {
    const b = pinnedBundles(home)[deviceId];
    if (!b) return null;
    try {
      const der = Buffer.from(b.cert, 'base64');
      if (deviceIdFromCert(der) !== deviceId) return null;
      return addressFromPublicKey(rawPublicKey(new X509Certificate(der).publicKey));
    } catch {
      return null;
    }
  };

  /** The device whose certificate a v3 sender attached (P1 bridge, ADR-073 §9), if its key is the sender's. */
  const deviceOfCert = (cert: string | undefined, fromKey: Buffer): string | null => {
    if (!cert) return null;
    try {
      const der = Buffer.from(cert, 'base64');
      return rawPublicKey(new X509Certificate(der).publicKey).equals(fromKey) ? deviceIdFromCert(der) : null;
    } catch {
      return null;
    }
  };

  /** ADR-073: the v3 address of each sender device we have seen a signed envelope from. */
  const senderAddresses = new Map<string, string>();
  /** ADR-073: record a contact's address (its device's), for `morse contact --json` and plugins. */
  const noteAddress = (contactId: string | undefined, deviceId: string) => {
    if (!contactId) return;
    const address = senderAddresses.get(deviceId) ?? addressOfDevice(deviceId);
    if (!address) return;
    try {
      opts.mailbox.contacts.seenAddress(contactId, address, deviceId);
    } catch {
      /* bookkeeping only */
    }
  };

  /**
   * Is this device on v3? Its address (from its certificate) must be published on the relay
   * with a key that IS that address and a prekey signed by it. Cached (`v3LookupTtlMs`; a
   * miss for a minute); anything uncertain → null = use v2, exactly as before.
   */
  const peerV3 = async (deviceId: string): Promise<{ address: string; prekey: PrekeyRecord } | null> => {
    if (!addrKey) return null;
    const hit = v3Peers.get(deviceId);
    if (hit && Date.now() - hit.at < (hit.peer ? v3LookupTtl : 60_000)) return hit.peer;
    if (!v3client?.connected() || !v3client.lookupAddress) return hit?.peer ?? null; // relay down: what we knew
    let peer: { address: string; prekey: PrekeyRecord } | null = null;
    try {
      await recipientKey(deviceId); // pins its v2 key bundle (with the certificate) if needed
      const address = addressOfDevice(deviceId);
      if (address) {
        const info = await withTimeout(v3client.lookupAddress(address), 5000);
        const key = info.key ? Buffer.from(info.key, 'base64') : null;
        if (key && keyMatchesAddress(key, address) && verifyPrekey(info.prekey, address, key)) peer = { address, prekey: info.prekey };
      }
    } catch {
      peer = null;
    }
    v3Peers.set(deviceId, { at: Date.now(), peer });
    if (v3Peers.size > 2000) v3Peers.clear();
    return peer;
  };

  // --- by address alone (ADR-081) -------------------------------------------------------------

  /** What this client publishes for its addresses; without `addr1` there is no native path at all. */
  const caps = opts.caps ?? [CAP_ADDR1];
  const nativeOn = opts.v3 !== false && caps.includes(CAP_ADDR1);

  /**
   * A correspondent as the device rules see it — or (ADR-081) one known ONLY by address:
   * then `id` is THEIR address and `self` the address of OURS this exchange runs on (the one
   * they wrote to / we write from). Such a peer is never in the trust list and always tier
   * `peer`; whatever is sealed for it is signed by `self`, with no device certificate.
   */
  type Peer = TrustedDevice & {
    self?: string;
    /**
     * (ADR-091) It wrote the OLD way — a v3 envelope with its device certificate and no `addr: 1` (a Morse from before
     * v2 was removed, sending to a contact it knows by old name), or a v1 envelope. Such a sender only takes an
     * answer that carries this computer's certificate, from the first address: its receipts, transfer answers and
     * notices are sealed that way. Everything else about it is decided by address, like any other.
     */
    legacy?: boolean;
  };
  const isNative = (p: { self?: string } | string): p is Peer & { self: string } => typeof p !== 'string' && typeof p.self === 'string';
  /** (ADR-091 follow-up) Addresses that wrote to the first address the old way (with their certificate): told in kind. */
  const OLD_WAY_MARK = 'old-way:';
  const noteOldWay = (address: string): void => {
    try {
      if (!opts.mailbox.contacts.mark(`${OLD_WAY_MARK}${address}`)) opts.mailbox.contacts.setMark(`${OLD_WAY_MARK}${address}`, '1');
    } catch {
      /* bookkeeping only */
    }
  };
  const wroteOldWay = (address: string): boolean => {
    try {
      return Boolean(opts.mailbox.contacts.mark(`${OLD_WAY_MARK}${address}`));
    } catch {
      return false;
    }
  };
  const nativePeer = (theirs: string, ours: string, name: string = theirs, legacy = false): Peer & { self: string } => ({ id: theirs, name, tier: 'peer', addedAt: 0, self: ours, ...(legacy ? { legacy: true } : {}) });
  /** (ADR-091) What the relay allows for one envelope: the v3 connection's, else the v2 one's (both say the same). */
  const relayLimits = (): RelayLimits => (v3client?.connected() ? v3client.limits() : client.connected() ? client.limits() : (v3client ?? client).limits());
  /** (ADR-091) Is the relay there — by address (the v3 connection), or the v2 one for what still needs it? */
  const relayUp = (): boolean => Boolean(v3client?.connected()) || client.connected();

  /**
   * Review F1 — THE one place a signing key for mail by address comes from. The key of exactly this
   * address, and only while this daemon holds it and has logged it in: the first address, or one a
   * later agent has. Anything else is null and then NOTHING is signed — there is no fallback to the
   * first address, by name or otherwise. Every envelope without a device certificate (a message, a
   * receipt, an `accepted` notice, a rekey notice, a chunk, a transfer answer) is sealed by
   * `sealNative`, which gets its key here.
   */
  const signerFor = (address: string): AddressKey | null => (addrKey?.address === address ? addrKey : (hosted.get(address)?.key ?? null));
  const isOwnAddress = (address: string): boolean => Boolean(signerFor(address));
  const noSignerSaid = new Set<string>();
  /** The refusal for an address `signerFor` has no key for (said once per address in the log). */
  const noSigner = (self: string): NoSignerError => {
    if (!noSignerSaid.has(self)) {
      noSignerSaid.add(self);
      if (noSignerSaid.size > 500) noSignerSaid.clear();
      log(`morse: nothing is sent from your address morse.im/${self} — it is no longer here (or its key is not loaded); no other address signs in its place`);
    }
    return new NoSignerError(self);
  };
  /** Seal `body` for `to`, signed by OUR address `self` and carrying no certificate — or throw NoSignerError. */
  const sealNative = async (self: string, to: string, prekey: PrekeyRecord, body: Buffer, maxBlobBytes?: number): Promise<EnvelopeV3> => {
    const key = signerFor(self);
    if (!key) throw noSigner(self);
    return sealV3({ from: key, to, prekey, body, ...(maxBlobBytes ? { maxBlobBytes } : {}) });
  };
  /** Log line for an answer that could not go out — silent when the reason was already said (no signer). */
  const notSent = (what: string, e: unknown) => {
    if (!(e instanceof NoSignerError)) log(`relay: ${what} not sent: ${e instanceof Error ? e.message : String(e)}`);
  };

  /**
   * The contact an address belongs to (its own address, or one of its computers') — never `self`.
   * (ADR-083) AT the address of mine `self`: a contact of another address of this computer is a
   * stranger here, like on any other computer.
   */
  const contactOfAddress = (address: string, self: string): Contact | null => {
    try {
      const c = opts.mailbox.contacts.byAddress(address, mineKey(self));
      return c && c.id !== SELF_CONTACT ? c : null;
    } catch {
      return null; // cannot tell: a stranger (the lower trust)
    }
  };

  /**
   * Blocked here: the address itself, or the contact it belongs to (by state, or by its old handle) —
   * also once that contact was removed: a blocked person does not get back in by address (the
   * tombstone of the removed contact still names the handle; unblocking the handle lifts this too).
   */
  // (ADR-083) all of it AT the address of mine `self`: a block by address is one of (my address, their address);
  // the old handles of morse-blocked.json and the tombstones are the first address's business only
  const addressBlocked = (address: string, contact: Contact | null, self: string): boolean => {
    const my = mineKey(self);
    try {
      if (opts.mailbox.contacts.isBlockedAt(address, my)) return true;
    } catch {
      return true; // cannot tell: nothing is taken or sent (the lower trust)
    }
    if (contact) return contact.state === 'blocked' || Boolean(!my && contact.handle && contact.origin !== OWN_DEVICE && isBlocked(contact.handle, home));
    if (my) return false;
    try {
      const was = JSON.parse(opts.mailbox.contacts.mark(`removed:${address}`) ?? 'null') as { handle?: unknown; origin?: unknown } | null;
      return Boolean(was && typeof was.handle === 'string' && was.handle && was.origin !== OWN_DEVICE && isBlocked(was.handle, home));
    } catch {
      return false;
    }
  };

  type Lookup = { ok: true; prekey: PrekeyRecord; caps: string[] } | { ok: false; waiting?: boolean; error: string };
  /**
   * (the address of OURS that asked, their address) → what the relay said about it, CHECKED (cached like the
   * per-device lookups).
   * (ADR-083 review R1) Keyed by the PAIR, never by their address alone: which prekey an answer is sealed to is
   * something they observe. With one cache for the whole computer, a peer that wrote to my address A, changed
   * its prekey and then wrote to my address B for the first time got B's receipt sealed to the prekey A had
   * looked up — an unrelated computer would have fetched the new one. Each address of mine looks up, caches,
   * forgets and judges ("too old", "not published") on its own.
   */
  const addressLookups = new Map<string, Map<string, { at: number; res: Lookup }>>();
  /** The lookups of ONE address of ours (their address → answer). Each has its own room: what fills one never empties another. */
  const lookupsOf = (self: string): Map<string, { at: number; res: Lookup }> => {
    let m = addressLookups.get(self);
    if (!m) addressLookups.set(self, (m = new Map()));
    return m;
  };

  /**
   * ADR-081 §2: key + signed prekey + capabilities of an address, over the v3 connection. The
   * relay is not trusted: the key must hash to the address and must have signed the prekey.
   * `needCaps`: the address must have published `addr1` (first contact; an answer to mail that
   * came by address needs no such proof).
   */
  const lookupNative = async (self: string, address: string, needCaps: boolean): Promise<Lookup> => {
    const tooOld: Lookup = { ok: false, error: `${address}: their Morse is too old to be reached by address (it needs the release after 20261114170051) — ask them to update: run the installer again (morse.im)` };
    const judge = (res: Lookup): Lookup => (res.ok && needCaps && !res.caps.includes(CAP_ADDR1) ? tooOld : res);
    const hit = lookupsOf(self).get(address);
    if (hit && Date.now() - hit.at < (hit.res.ok && hit.res.caps.includes(CAP_ADDR1) ? v3LookupTtl : 60_000)) return judge(hit.res);
    if (!v3client?.connected() || !v3client.lookupAddress) return { ok: false, waiting: true, error: `relay ${opts.url} not connected — morse.im/${address} gets it when the relay is back` };
    let res: Lookup;
    try {
      const info = await withTimeout(v3client.lookupAddress(address), 5000);
      const key = info.key ? Buffer.from(info.key, 'base64') : null;
      if (!key) res = { ok: false, error: `nobody has published ${address} yet` };
      else if (!keyMatchesAddress(key, address) || !info.prekey || !verifyPrekey(info.prekey, address, key))
        res = { ok: false, error: `${address}: what the relay returned for this address does not verify (the key is not this address's, or did not sign its prekey) — not sent` };
      else res = { ok: true, prekey: info.prekey, caps: info.caps };
    } catch (e) {
      return { ok: false, waiting: true, error: `cannot look up morse.im/${address} right now (${e instanceof Error ? e.message : String(e)}) — will retry` };
    }
    const mine = lookupsOf(self);
    mine.delete(address); // (so the map stays in the order the answers came: the oldest first)
    mine.set(address, { at: Date.now(), res });
    // (over the cap: only the OLDEST entries of this address of ours go)
    if (mine.size > 2000) for (const k of [...mine.keys()].slice(0, mine.size - 2000)) mine.delete(k);
    return judge(res);
  };

  /** A sealed envelope for one device: v3 when it is on v3 (`v3` = its address), else v1/v2.
   *  ADR-081: `from` = the address of ours that signed a native one (the relay must be told). */
  interface Sealed {
    blob: string;
    v3?: { address: string; from?: string };
  }

  const sealBytes = async (to: string | Peer, plaintext: Buffer): Promise<Sealed> => {
    const max = relayLimits().maxBlobBytes;
    let out: Sealed;
    if (isNative(to)) {
      // ADR-081: signed by the address this exchange runs on — never the first one by default, no certificate
      if (!signerFor(to.self)) throw noSigner(to.self); // before anything is looked up
      const peer = await lookupNative(to.self, to.id, false);
      if (!peer.ok) throw new Error(peer.error);
      // (ADR-091) an answer to someone who wrote the old way carries this computer's certificate (the first address only)
      const env = to.legacy && addrKey && to.self === addrKey.address ? await sealV3({ from: addrKey, to: to.id, prekey: peer.prekey, body: plaintext, cert: certB64, maxBlobBytes: max }) : await sealNative(to.self, to.id, peer.prekey, plaintext, max);
      out = { blob: JSON.stringify(env), v3: { address: to.id, from: to.self } };
    } else {
      const toId = typeof to === 'string' ? to : to.id;
      const peer = await peerV3(toId);
      if (peer && addrKey) {
        const env = await sealV3({ from: addrKey, to: peer.address, prekey: peer.prekey, body: plaintext, cert: certB64, maxBlobBytes: max });
        out = { blob: JSON.stringify(env), v3: { address: peer.address } };
      } else {
        out = { blob: JSON.stringify(seal({ identity, recipientId: toId, recipientEncPub: await recipientKey(toId), plaintext })) };
      }
    }
    if (Buffer.byteLength(out.blob) > max) throw new Error(`message too large for the relay: ${Buffer.byteLength(out.blob)} bytes encrypted > ${max}`);
    return out;
  };
  const sealFor = (to: string | Peer, plain: Plain): Promise<Sealed> => sealBytes(to, Buffer.from(JSON.stringify(plain)));

  /**
   * Through the relay: a v3 envelope over the v3 connection (to the address; `stored` = the
   * recipient is offline and the relay keeps it — ADR-073), else over v2 to the device.
   */
  const sendRelay = async (to: string, sealed: Sealed, o: { ref?: string; store?: boolean } = {}): Promise<'sent' | 'offline' | 'stored'> => {
    if (sealed.v3) {
      if (!v3client?.sendV3) throw new Error('relay v3 not connected');
      return (await v3client.sendV3(sealed.v3.address, sealed.blob, { ...o, ...(sealed.v3.from ? { from: sealed.v3.from } : {}) })).r;
    }
    return client.send(to, sealed.blob);
  };

  /**
   * ADR-069: one sealed envelope to a device — over an open direct link when there is
   * one (`establish`: open one first, ≤ 3 s), else through the relay.
   */
  const sendBlob = async (to: string, sealed: Sealed, establish = false, o: { ref?: string; store?: boolean } = {}): Promise<{ r: 'sent' | 'offline' | 'stored'; via: 'lan' | 'direct' | 'relay' }> => {
    // (ADR-091) by address: a direct link (between this computer's FIRST address and a contact), then the relay.
    // (follow-up) Never the LAN: nothing confirms what goes there except a message's receipt — chunks, answers,
    // receipts and notices would be lost to whoever answers on the LAN (only `viaLanAddress` uses it, for messages)
    const linkable = sealed.v3 ? !sealed.v3.from || sealed.v3.from === addrKey?.address : !directByAddress;
    if (direct && linkable && (await direct.send(sealed.v3 && directByAddress ? sealed.v3.address : to, sealed.blob, establish))) return { r: 'sent', via: 'direct' };
    return { r: await sendRelay(to, sealed, o), via: 'relay' };
  };
  /** (ADR-091) Addresses whose LAN side took an envelope and then gave no receipt: the relay for a while. */
  const lanFailed = new Map<string, number>();
  const lanFailing = (address: string): boolean => Date.now() - (lanFailed.get(address) ?? 0) < 10 * 60_000;

  type Opened = { chunk: { header: ChunkHeader; data: Buffer } } | { plain: Plain };

  /** Decrypt an envelope to us: a chunk frame (ADR-038) or a JSON plaintext. Throws when it does not verify. */
  const openPlain = (env: SealedEnvelope): Opened => {
    const buf = open(env, { id: identity.id, enc }).plaintext;
    const chunk = decodeChunk(buf);
    return chunk ? { chunk } : { plain: JSON.parse(buf.toString('utf8')) as Plain };
  };

  /**
   * An answer (a receipt, a transfer status) goes back the way its message came. What came
   * through the relay may be the sender's fallback after it gave up on a direct link that
   * still looks open from here (its close has not reached us yet): the sender no longer
   * reads that link, so an answer written to it is lost and the sender never sees a receipt.
   * Only when the relay cannot take it (down, or the sender offline there) is a link tried.
   */
  const sendBack = async (to: string, sealed: Sealed, cameVia: 'lan' | 'direct' | 'relay' | undefined): Promise<{ r: 'sent' | 'offline' | 'stored'; via: 'lan' | 'direct' | 'relay' }> => {
    if (cameVia !== 'relay' || !direct) return sendBlob(to, sealed);
    try {
      const r = await sendRelay(to, sealed);
      if (r !== 'offline') return { r, via: 'relay' };
    } catch {
      /* the relay is gone meanwhile — an open link, if there is one */
    }
    return sendBlob(to, sealed);
  };

  const sendReceipt = (to: { id: string; name: string; self?: string }, id: string, request?: 'filed' | 'dropped' | 'full', chunked?: boolean, cameVia?: 'lan' | 'direct' | 'relay') =>
    sealFor(isNative(to) ? to : to.id, {
      kind: 'receipt',
      id,
      // (ADR-081 review F4) "full" travels as dropped + full: an older Morse holds the message, a newer one says why
      ...(request ? { request: request === 'full' ? ('dropped' as const) : request } : {}),
      ...(request === 'full' ? { full: true as const } : {}),
      ...(chunked ? { chunked: true as const } : {}),
    })
      .then((blob) => sendBack(to.id, blob, cameVia))
      .then(({ r }) => {
        if (r === 'offline') log(`relay: receipt for ${id.slice(0, 8)} not delivered — @${to.name} went offline (they will resend)`);
      })
      .catch((e: unknown) => notSent(`receipt to @${to.name}`, e));

  /**
   * Where the files of one received message are kept. (ADR-083) By address, at an address of mine other
   * than the first, the directory carries that address: the same message id written to two of my
   * addresses is two messages, each with its own files.
   */
  const filesDirOf = (msgId: string, sender?: Peer): string => join(inboxFilesDir(home), `${safeFileName(msgId)}${sender && isNative(sender) && mineKey(sender.self) ? `~${mineKey(sender.self)}` : ''}`);
  const storeFiles = (msgId: string, files: WireFile[], sender?: Peer): MessageFile[] => {
    const dir = filesDirOf(msgId, sender);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const out: MessageFile[] = [];
    const used = new Set<string>();
    for (const f of files) {
      const data = Buffer.from(f.data, 'base64');
      const digest = sha256(data);
      if (digest !== f.sha256) throw new Error(`attachment ${f.name}: checksum mismatch`);
      // (two names that are one file to a case-insensitive file system — A.txt, a.txt — are told apart, never overwritten)
      const name = uniqueFileName(safeFileName(f.name), used);
      const path = join(dir, name);
      // 0600: readable by the owner only, never executable; never opened automatically
      writeFileSync(path, data, { mode: 0o600, flag: existsSync(path) ? 'w' : 'wx' });
      chmodSync(path, 0o600);
      out.push({ name, path, size: data.length, sha256: digest });
    }
    return out;
  };

  /**
   * Where an incoming message lands here (ADR-048). From another person: ALWAYS the
   * addressed agent's mailbox (`<agent>/inbox`) — a session id they send (older
   * clients put ours there) only tells us which agent; it never picks a session, so
   * nothing of theirs is resumed, woken or injected. From our own devices (tier
   * owner): an explicit session id is kept (same-handle session mail), and an agent
   * name may map to a registered external agent of that name; otherwise the mailbox.
   * There is no "most recently active session of that agent" fallback any more.
   */
  const localSession = async (to: { agent: string; sessionId: string }, tier: TrustTier = 'peer'): Promise<{ agent: string; sessionId: string }> => {
    if (tier === 'owner' && to.sessionId) return to;
    if (to.agent === INBOX_AGENT) return { agent: INBOX_AGENT, sessionId: INBOX_SESSION };
    const mine = localAgents(home);
    // an old client's reply names our runtime (claude, codex …) + a session: map it to our agent
    const agent = mine.agents.includes(to.agent) || !to.sessionId ? to.agent : (mine.primary ?? to.agent);
    if (tier === 'owner') {
      try {
        const sid = await opts.resolveAgent?.(agent);
        if (sid) return { agent, sessionId: sid };
      } catch {
        /* fall through to the mailbox */
      }
    }
    return { agent, sessionId: INBOX_SESSION };
  };

  const pairHandle = async (raw: string, expect?: string): Promise<PairOutcome> => {
    const addr = parseMorseAddress(raw);
    if (!addr) return { ok: false, error: `"${raw}" is not a Morse handle` };
    // (ADR-081 review F3) an address is not an old name: no device is ever paired under one
    if (addressShapedHandle(addr.handle)) return { ok: false, error: `"${addr.handle}" is an address, not an old name — there is nothing to pair (morse contact add morse.im/${addr.handle})` };
    if (!client.connected() && !(await client.waitConnected(connectWait))) {
      return { ok: false, waiting: true, error: `relay ${opts.url} not connected` };
    }
    let found: HandleDevice[];
    try {
      found = await client.lookupHandle(addr.handle);
    } catch (e) {
      return { ok: false, waiting: true, error: e instanceof Error ? e.message : String(e) };
    }
    const devices = trustHandleDevices(addr.handle, found, { trust, home, selfId: identity.id, selfHandle: client.handle(), keep: lowered, ...(expect ? { expect } : {}) });
    if (devices.length === 0) {
      return { ok: false, error: expect ? `the relay does not list that device under ${addr.handle}` : `nobody called ${addr.handle} on the relay` };
    }
    if (!expect) {
      unblockHandle(addr.handle, home);
      // pairing someone yourself (pair add, or writing to them) accepts their waiting request (ADR-037)
      if (opts.mailbox.requests.get(addr.handle)) acceptPending(addr.handle, 'you paired them');
    }
    return { ok: true, devices };
  };

  // --- message requests (ADR-037) ------------------------------------------------

  /** Move a waiting request into the inbox (pairs the device that wrote) and tell them. */
  const acceptPending = (handle: string, why: string, /** (ADR-083) the address of mine it waits at ('' = the first) */ my = ''): boolean => {
    const r = acceptRequest(handle, { mailbox: opts.mailbox, trust, home, myAddress: my });
    if (!r.ok) return false;
    log(`morse: accepted the message request from morse.im/${r.request.handle} (${why}) — it is in your inbox now`);
    opts.onChange?.();
    void notifyAccepted(r.request.handle, r.request.myAddress);
    return true;
  };

  const notifyAccepted = async (raw: string, myAddress?: string | null): Promise<number> => {
    const handle = handleKey(raw);
    const address = nativeOn ? normalizeAddress(handle) : null;
    if (address) {
      // ADR-081: an address was accepted — tell it by address, signed by the address of ours it wrote to
      // (ADR-081 review F1: by THAT address or not at all — an address this daemon no longer holds tells nobody)
      // (ADR-083) ONE address of mine accepted: only it says so. A caller that does not say which (a command of
      // the release before) can only have meant the first address.
      const accepted = myAddress === undefined || myAddress === null ? '' : mineKey(normalizeAddress(myAddress) ?? '');
      const selves = writtenTo(address).filter((a) => mineKey(a) === accepted);
      let told = 0;
      for (const self of selves) {
        try {
          if (!v3client?.connected()) break;
          // (kept in the relay's mailbox when they are away: they learn it at their next login)
          // (ADR-091 follow-up) to one that wrote the old way (a Morse of the release before, at the first address): with this
          // computer's certificate — that Morse takes only that; without it, what it held back waits for its own retry.
          // Anyone else gets it as before (ADR-083: what an address says must not depend on which computer it is on)
          if ((await sendRelay(address, await sealFor(nativePeer(address, self, address, self === addrKey?.address && wroteOldWay(address)), { kind: 'accepted' }))) !== 'offline') told++;
        } catch (e) {
          if (!(e instanceof NoSignerError)) log(`relay: could not tell morse.im/${address} about the accepted request: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      log(
        told
          ? `relay: told morse.im/${address} you accepted their message request — what they held back comes now`
          : `relay: morse.im/${address} could not be told right now — they send what they held back on their next try`,
      );
      return told;
    }
    const devices = trust.list().filter((t) => t.tier === 'peer' && t.name.toLowerCase() === handle);
    let told = 0;
    for (const d of devices) {
      try {
        if (!client.connected()) break;
        if ((await sendRelay(d.id, await sealFor(d.id, { kind: 'accepted' }))) !== 'offline') told++;
      } catch (e) {
        log(`relay: could not tell @${d.name} (${d.id.slice(0, 7)}) about the accepted request: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log(
      told
        ? `relay: told morse.im/${handle} you accepted their message request (${told} device(s)) — what they held back comes now`
        : `relay: morse.im/${handle} is not reachable right now — they send what they held back on their next try`,
    );
    return told;
  };

  /** What happens to a message from a device that is not paired here. */
  const decide = (handle: string, how: 'relay' | 'lan'): 'pair' | 'request' | 'drop' => {
    const what = how === 'relay' ? 'relay: dropped message from' : 'lan: not accepting a direct message from';
    if (isBlocked(handle, home)) {
      log(`${what} morse.im/${handle} — you removed them or declined their request (to undo: morse pair add morse.im/${handle})`);
      return 'drop';
    }
    const me = client.handle();
    if (me && handle === me.toLowerCase()) return 'pair'; // one of your own devices (ADR-034)
    // someone you already accepted, writing from another device of theirs
    if (trust.list().some((t) => t.tier === 'peer' && t.name.toLowerCase() === handle)) return 'pair';
    const mode = strangers();
    if (mode === 'accept') return 'pair';
    if (mode === 'block') {
      log(`${what} morse.im/${handle} — not paired, and strangers are blocked (morse.strangers: "block"; to accept them: morse pair add morse.im/${handle})`);
      return 'drop';
    }
    return 'request';
  };

  const isOwnHandle = (handle: string) => {
    const me = client.handle();
    return Boolean(me && me.toLowerCase() === handle);
  };

  /** The relay directory lists `deviceId` under `handle`, with a key bundle that verifies (pinned). */
  const verifyStranger = async (handle: string, deviceId: string, ms: number): Promise<{ ok: true; name?: string } | { ok: false; error: string }> => {
    if (addressShapedHandle(handle)) return { ok: false, error: `"${handle}" has the shape of an address — not an old name` };
    if (!client.connected()) return { ok: false, error: 'relay not connected' };
    let found: HandleDevice[];
    try {
      found = await withTimeout(client.lookupHandle(handle), ms);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const listed = found.find((d) => d.id === deviceId);
    if (!listed) return { ok: false, error: `the relay does not list that device under ${handle}` };
    try {
      if (!listed.bundle) throw new Error('no key bundle');
      verifyKeyBundle(listed.bundle, deviceId);
      pinKeyBundle(listed.bundle, home);
    } catch (e) {
      return { ok: false, error: `its key bundle does not verify (${e instanceof Error ? e.message : String(e)})` };
    }
    return { ok: true, ...(listed.name ? { name: listed.name } : {}) };
  };

  /** A request keeps no attachment — only their names and sizes (ADR-037/038). */
  const droppedOf = (plain: MessagePlain): { droppedFiles: number; droppedFileList?: Array<{ name: string; size: number }> } => {
    const list = [
      ...(Array.isArray(plain.files) ? plain.files.map((f) => ({ name: safeFileName(String(f?.name ?? 'file')), size: typeof f?.data === 'string' ? Math.floor((f.data.length * 3) / 4) : 0 })) : []),
      ...(Array.isArray(plain.chunked?.files) ? plain.chunked.files.map((f) => ({ name: safeFileName(String(f?.name ?? 'file')), size: Number(f?.size) || 0 })) : []),
    ];
    return { droppedFiles: list.length, ...(list.length ? { droppedFileList: list } : {}) };
  };

  /** Device names of strangers a LAN admit just verified (for the request's "device" line). */
  const verifiedNames = new Map<string, string>();
  /** (ADR-081 review F4) "message requests are full" is logged at growing intervals, not once per refused stranger. */
  const fullSaid = createRepeatFilter();

  /**
   * File a stranger's message as their one message request. A retry of the stored
   * message is a duplicate; any other message while it waits is dropped (counted).
   */
  const fileRequest = async (
    from: { id: string; handle: string },
    plain: Extract<Plain, { kind: 'message' }>,
    via: 'morse-relay' | 'morse-lan',
    deviceName?: string,
    /** ADR-081: it came BY ADDRESS — `from.handle` is the address that signed it, this the address of ours it was written to */
    toAddress?: string,
  ): Promise<'filed' | 'duplicate' | 'dropped' | 'full'> => {
    const how = via === 'morse-lan' ? 'lan' : 'relay';
    const h = from.handle;
    // (ADR-081 review F3) the old way, an address-shaped name is nobody's handle: never a request keyed like an address
    if (!toAddress && addressShapedHandle(h)) throw new Error(`"${h}" has the shape of an address — not an old name`);
    const theirs = plain.fromHandle === h; // claims about the person count only for the handle we verified
    const fromAgent = theirs && typeof plain.fromAgent === 'string' ? normalizeAgentName(plain.fromAgent) : null;
    // (ADR-083) one request per (the address of mine it was written to, the sender); each address has its own room
    const my = toAddress ? mineKey(toAddress) : '';
    const existing = opts.mailbox.requests.get(h, my);
    const to = existing ? existing.to : await localSession(plain.to);
    const r = opts.mailbox.requests.file({
      myAddress: my,
      handle: h,
      deviceId: from.id,
      ...(deviceName ? { deviceName } : {}),
      msgId: plain.id,
      ...(plain.contextId ? { contextId: plain.contextId } : {}),
      from: { agent: plain.from.agent, sessionId: plain.from.sessionId },
      ...(fromAgent ? { fromAgent } : {}),
      to,
      ...(toAddress ? { toAddress } : {}),
      text: plain.text,
      ...droppedOf(plain),
      via,
    });
    const who = `morse.im/${h}`; // ADR-065: an old client's fromNickname is accepted and ignored
    if (r.result === 'full') {
      // (ADR-081 review F4) nobody who is waiting is pushed out: the newcomer is refused and tries again later
      const line = fullSaid.pass(`full:${my}`, `${how}: message requests are full (${opts.mailbox.requests.count(my)} of ${opts.mailbox.requests.max}) — refused a new one from ${who}; nobody new can reach you until you accept or reject some (morse contact)`);
      if (line) log(line);
      return 'full';
    }
    if (r.result === 'filed') {
      log(
        `${how}: message request from ${who} — not paired with you, so it waits in your requests, not your inbox (no agent sees it). See: morse contact · accept: morse contact accept ${h} · block: morse contact block ${h}`,
      );
      opts.onChange?.();
    } else if (r.result === 'dropped') {
      log(`${how}: dropped another message from ${who} — their message request is still waiting for you (one per address; morse contact)`);
    }
    return r.result;
  };

  /** Relay path for a stranger in `request` mode: decrypt, verify the handle, file, receipt. */
  const receiveRequest = async (d: RelayDelivery, fromId: string, handle: string, openLazy: () => Opened): Promise<void> => {
    let plain: Plain;
    try {
      const o = openLazy();
      if ('chunk' in o) return; // a message request takes no file chunks (ADR-038) — only names and sizes
      plain = o.plain;
    } catch (e) {
      log(`relay: dropped ${d.id} from unpaired morse.im/${handle} — ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!isMessage(plain)) return; // receipts / notices from someone not paired here mean nothing
    let deviceName: string | undefined;
    const existing = opts.mailbox.requests.get(handle);
    if (!existing || existing.deviceId !== fromId) {
      const v = await verifyStranger(handle, fromId, Math.max(receiptTimeout, 5000));
      if (!v.ok) {
        log(`relay: dropped message from UNPAIRED device ${fromId.slice(0, 7)} claiming morse.im/${handle} — ${v.error}`);
        return;
      }
      deviceName = v.name;
    }
    let r: 'filed' | 'duplicate' | 'dropped' | 'full';
    try {
      r = await fileRequest({ id: fromId, handle }, plain, 'morse-relay', deviceName);
    } catch (e) {
      log(`relay: could not file the message request from morse.im/${handle}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // the receipt says "message request": their device holds the rest until we accept
    void sendReceipt({ id: fromId, name: handle }, plain.id, r === 'duplicate' ? 'filed' : r, undefined, d.via === 'direct' ? 'direct' : 'relay');
  };

  // --- sender side: waiting for a recipient to accept us (ADR-037) ---------------------

  /**
   * Recipient DEVICES whose message requests hold a message of ours (each device keeps
   * its own requests and trust list): device ID → when we last let one held message
   * through (a probe, in case their "accepted" notice was missed).
   */
  // (ADR-081: for an ADDRESS we wrote to by address alone the key is that address AND the address of ours we
  // wrote from — to them these are two different senders; `name` is then how the held messages were addressed:
  // the address itself, or the old name of the contact it belongs to)
  // (`full`, ADR-081 review F4: not "they have a request of ours" but "their message requests are full" — held the same way)
  const awaiting = new Map<string, { lastTry: number; name?: string; full?: boolean }>();
  /** Addresses a request of ours waits at, as the mailbox knew at start (which of our addresses wrote is not kept). */
  const pendingAt = new Set<string>();
  // after a restart we only know the person: probe each of their devices once
  // (ADR-083) …per PAIR: a request of my address A waiting at someone says nothing about what my address B sends them
  for (const p of opts.mailbox.requestPending()) {
    if (!p.my) for (const t of trust.list()) if (t.tier === 'peer' && t.name.toLowerCase() === p.to) awaiting.set(t.id, { lastTry: 0 });
    if (normalizeAddress(p.to)) pendingAt.add(`${p.to}/${p.my}`);
  }
  const holdKey = (device: { id: string; self?: string }) => (isNative(device) ? `${device.id}/${device.self}` : device.id);
  /** The hold on a correspondent, if any (an address from before the restart: one probe, like a device). */
  const holdOf = (device: { id: string; name?: string; self?: string }) => {
    const key = holdKey(device);
    if (!awaiting.has(key) && isNative(device) && pendingAt.delete(`${device.id}/${mineKey(device.self)}`)) awaiting.set(key, { lastTry: 0, name: device.id });
    return awaiting.get(key);
  };

  const awaitAccept = (device: { id: string; name?: string; self?: string }, full = false) => {
    const cur = holdOf(device);
    if (cur) {
      cur.lastTry = Date.now();
      cur.full = full;
    } else awaiting.set(holdKey(device), { lastTry: Date.now(), ...(isNative(device) && device.name ? { name: device.name } : {}), ...(full ? { full } : {}) });
  };

  /** That device accepted us (a notice, a plain receipt, or a message from it): send what was held. */
  const settleAccepted = (peer: { id: string; name: string; self?: string }, why: string) => {
    const hold = holdOf(peer);
    if (!hold || !awaiting.delete(holdKey(peer))) return;
    const device = { id: peer.id, name: hold.name ?? peer.name };
    // their message requests kept none of our attachments (ADR-038): send those files again now
    // (ADR-083) they accepted ONE address of mine: only what that address sent them is released
    const my = isNative(peer) ? mineKey(peer.self) : '';
    const withFiles = opts.mailbox.requestMessages(device.name, my).filter((m) => m.parts.some((p) => p.files?.length));
    const n = opts.mailbox.requestAccepted(device.name, my);
    let resent = 0;
    for (const m of withFiles) {
      const files = m.parts.flatMap((p) => p.files ?? []).filter((f) => existsSync(f.path));
      if (!files.length) continue;
      // (ADR-081 review: legacy rows) a row of this release without a sending address cannot exist — its files are not sent from a guess
      if (!m.myAddress && !m.fromFirstAddress && !fromBefore(m)) {
        log(`morse: the files of ${m.id.slice(0, 8)} are not sent again — the message does not record which of your addresses it was written from`);
        continue;
      }
      const input = {
        from: m.from,
        to: m.to,
        text: `[the ${files.length} file(s) of my earlier message ${m.id.slice(0, 8)} — held back while it waited in your message requests]`,
        via: 'morse-files',
        files,
        // ADR-081: from the same address of ours as the message they belong to — the address when the row has
        // one; else it went from this computer's first address (none was named, or the release before queued it)
        ...(m.myAddress ? { myAddress: m.myAddress, ...(m.myAgent ? { myAgent: m.myAgent } : {}) } : { firstAddress: true }),
      };
      try {
        opts.mailbox.send({ ...input, contextId: m.contextId });
        resent++;
      } catch (e) {
        log(`morse: could not queue the files of ${m.id.slice(0, 8)} again: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log(
      `morse: morse.im/${device.name} (${device.id.slice(0, 7)}) accepted your message request (${why})${n ? ` — sending the ${n} message(s) held for them` : ''}${resent ? `${n ? ' and' : ' —'} sending the files of ${resent} message(s) again (a request keeps no files)` : ''}`,
    );
    opts.onChange?.();
  };

  const heldResult = (device: { id: string; name: string; self?: string }): MorseSendResult => ({
    ok: false,
    waiting: true,
    error: awaiting.get(holdKey(device))?.full
      ? `morse.im/${device.name}: their message requests are full — try again later (held here; it is sent again by itself)`
      : `waiting for morse.im/${device.name} to accept your message request — held here, sent once they accept`,
  });

  /** A held device: the held result, except once per probe interval (then null = send it). */
  const holdFor = (device: { id: string; name: string; self?: string }): MorseSendResult | null => {
    const hold = holdOf(device);
    if (!hold) return null;
    if (Date.now() - hold.lastTry < probeMs) return heldResult(device);
    hold.lastTry = Date.now();
    return null;
  };

  /** One lookup per handle at a time: a stranger's retries can arrive in a burst. */
  const pairingBack = new Map<string, Promise<TrustedDevice | undefined>>();
  /**
   * Pair a device that is not paired here (decide() said so: your own handle, a person
   * you accepted before, or strangers set to `accept`). `relay`: the relay vouched for the
   * sender's handle and the sealed envelope is signed by the device. `lan`: mutual TLS
   * proves the device ID, the handle is only claimed — so the relay must be reachable
   * NOW (no waiting: the caller is on the line) and must list that device under the
   * handle with a key bundle that verifies against its ID.
   */
  const autoPair = (handle: string, from: string, how: 'relay' | 'lan'): Promise<TrustedDevice | undefined> => {
    const running = pairingBack.get(handle);
    if (running) return running.then(() => trust.get(from));
    const attempt: Promise<PairOutcome> = how === 'relay' ? pairHandle(handle, from) : pairOverLan(handle, from);
    const p = attempt
      .then((r) => {
        if (!r.ok) {
          log(
            how === 'relay'
              ? `relay: dropped message from UNPAIRED device ${from.slice(0, 7)} claiming morse.im/${handle} — ${r.error}`
              : `lan: cannot confirm morse.im/${handle} (${from.slice(0, 7)}) with the relay — ${r.error}; their message comes through the relay instead`,
          );
          return undefined;
        }
        const tier = tierForHandle(handle, client.handle());
        const lan = how === 'lan';
        log(
          tier === 'owner'
            ? `${how}: auto-paired morse.im/${handle} (${r.devices.length} device(s), tier owner — your own devices)${lan ? ', first contact over the LAN' : ''}`
            : `${how}: auto-paired morse.im/${handle} (${r.devices.length} device(s), tier peer) — they messaged you first${lan ? ' over the LAN' : ''}; to block them: morse pair remove ${handle}`,
        );
        // accepted strangers mode: a request left from before is moved in too
        if (opts.mailbox.requests.get(handle)) acceptPending(handle, 'paired automatically');
        return trust.get(from);
      })
      .finally(() => pairingBack.delete(handle));
    pairingBack.set(handle, p);
    return p;
  };

  /** pairHandle for a LAN caller: relay up right now, device listed, bundle verifies. */
  const pairOverLan = async (handle: string, from: string): Promise<PairOutcome> => {
    if (!client.connected()) return { ok: false, waiting: true, error: 'relay not connected' };
    let found: HandleDevice[];
    try {
      found = await withTimeout(client.lookupHandle(handle), lanAdmitTimeout);
    } catch (e) {
      return { ok: false, waiting: true, error: e instanceof Error ? e.message : String(e) };
    }
    const listed = found.find((d) => d.id === from);
    if (!listed) return { ok: false, error: `the relay does not list that device under ${handle}` };
    try {
      if (!listed.bundle) throw new Error('no key bundle');
      verifyKeyBundle(listed.bundle, from);
    } catch (e) {
      return { ok: false, error: `its key bundle does not verify (${e instanceof Error ? e.message : String(e)})` };
    }
    const devices = trustHandleDevices(handle, found, { trust, home, selfId: identity.id, selfHandle: client.handle(), keep: lowered, expect: from });
    return devices.length ? { ok: true, devices } : { ok: false, error: `the relay does not list that device under ${handle}` };
  };

  const admitDirect = async (deviceId: string, raw: string): Promise<TrustedDevice | undefined> => {
    const known = trust.get(deviceId);
    if (known) return known; // paired meanwhile (e.g. a relay pair-back raced us)
    const handle = parseMorseAddress(raw)?.handle;
    if (!handle || deviceId === identity.id) return undefined;
    if (addressShapedHandle(handle)) {
      log(`lan: not accepting a direct message from device ${deviceId.slice(0, 7)} — the name it claims (${handle}) has the shape of an address, which no old name has`);
      return undefined;
    }
    const decision = decide(handle, 'lan');
    if (decision === 'drop') return undefined;
    if (!isOwnHandle(handle) && !limiter.peek(handle)) {
      withinLimit(handle, 'lan'); // logs it
      return undefined;
    }
    if (decision === 'pair') return autoPair(handle, deviceId, 'lan');
    // a message request: confirm the claim with the relay directory, but pair nothing
    const existing = opts.mailbox.requests.get(handle);
    if (!existing || existing.deviceId !== deviceId) {
      const v = await verifyStranger(handle, deviceId, lanAdmitTimeout);
      if (!v.ok) {
        log(`lan: cannot confirm morse.im/${handle} (${deviceId.slice(0, 7)}) with the relay — ${v.error}; their message comes through the relay instead`);
        return undefined;
      }
      if (v.name) verifiedNames.set(deviceId, v.name);
      if (verifiedNames.size > 500) verifiedNames.clear();
    }
    // NOT stored in the trust list: this caller may hand over this one message, as a request
    return { id: deviceId, name: handle, tier: 'peer', addedAt: Date.now() };
  };

  /**
   * Devices the relay lists under OUR handle are our own (ADR-034): only an invite
   * issued for this handle puts a device there. Upgrade any of them still paired as
   * peer (paired before ADR-034) to owner. Never adds a device (a removed one stays
   * removed until the next contact), never touches a blocked handle.
   */
  const syncOwnDevices = async (): Promise<TrustedDevice[]> => {
    const me = client.handle();
    if (!me || isBlocked(me, home)) return [];
    let found: HandleDevice[];
    try {
      found = await client.lookupHandle(me);
    } catch {
      return []; // next login tries again
    }
    const mine = new Set(found.map((d) => d.id));
    const upgraded = trust
      .list()
      .filter((t) => t.tier === 'peer' && t.id !== identity.id && mine.has(t.id) && !lowered(t.id)) // (N5b) not one you moved out of group self
      .map((t) => trust.add({ id: t.id, name: t.name, tier: 'owner' }));
    if (upgraded.length) log(`relay: ${upgraded.length} device(s) under your own handle morse.im/${me} upgraded from peer to owner`);
    return upgraded;
  };

  const isMessage = (p: unknown): p is Extract<Plain, { kind: 'message' }> => {
    const m = p as Partial<Extract<Plain, { kind: 'message' }>> | null;
    return (
      m?.kind === 'message' &&
      typeof m.id === 'string' &&
      m.id.length > 0 &&
      typeof m.text === 'string' &&
      typeof m.to?.agent === 'string' &&
      m.to.agent.length > 0 &&
      typeof m.to.sessionId === 'string' &&
      typeof m.from?.agent === 'string' &&
      m.from.agent.length > 0 &&
      typeof m.from.sessionId === 'string'
    );
  };

  /**
   * File one message from a trusted device into the mailbox (relay or LAN — same
   * rules): dedupe by (sender, message id), store attachments, resolve the agent to a
   * local session, keep the sender's tier. Throws when filing fails (the seen-mark is
   * undone so the sender's retry is accepted).
   */
  const fileMessage = async (
    sender: Peer,
    plain: Extract<Plain, { kind: 'message' }>,
    via: 'morse-relay' | 'morse-lan',
    /** ADR-038: files of a chunked message, already checked and in place */
    stored?: MessageFile[],
    /** ADR-069: the envelope came over a direct WebRTC link (still filed as morse-relay); (ADR-091) or the LAN by address */
    path?: 'direct' | 'lan',
  ): Promise<'filed' | 'duplicate'> => {
    if (!opts.mailbox.firstSeen(seenKey(sender), plain.id)) return 'duplicate';
    // (ADR-091) nobody's mail is yours: there is no owner tier any more — every computer but this one is a contact,
    // whatever the old trust list says about it (permissions are per contact, given by you)
    const tier: TrustTier = 'peer';
    try {
      const files = stored ?? (plain.files?.length ? storeFiles(plain.id, plain.files, sender) : []);
      const note = files.length
        ? `\n\n[attachments saved to your inbox — not executed, not opened]\n${files.map((f) => `- ${f.path} (${formatBytes(f.size)}${f.size >= 1024 ? `, ${f.size} bytes` : ''}, sha256 ${f.sha256.slice(0, 16)}…)`).join('\n')}`
        : '';
      const to = await localSession(plain.to, tier);
      // reply address: <handle>/<agent> when the sender's claim matches who we paired it as
      const fromAgent = typeof plain.fromAgent === 'string' ? normalizeAgentName(plain.fromAgent) : null;
      const fromDevice = fromAgent && plain.fromHandle === sender.name ? `${sender.name}/${fromAgent}` : sender.name;
      // ADR-065: an old client's fromNickname is accepted on the wire and ignored
      const filed = opts.mailbox.send({
        from: { agent: plain.from.agent, sessionId: plain.from.sessionId, device: fromDevice },
        to,
        text: plain.text + note,
        via,
        ...(plain.contextId ? { contextId: plain.contextId } : {}),
        fromTier: tier,
        ...(files.length ? { files } : {}),
        // ADR-081 (ADR-081 review F1): by address — WHICH address of ours it was written to (answers are signed by it)
        ...(isNative(sender) ? { myAddress: sender.self } : {}),
        // ADR-077: the contact is chosen by the sender's VERIFIED address, never by the agent name it writes
        // (ADR-081: for mail by address alone that is the contact the signing address belongs to)
        ...(() => {
          const contactId = isNative(sender)
            ? contactOfAddress(sender.id, sender.self)?.id
            : opts.mailbox.contacts.filingContact({ address: senderAddresses.get(sender.id) ?? addressOfDevice(sender.id), deviceId: sender.id }, sender.name, tier);
          return contactId ? { contactId } : {};
        })(),
      });
      if (!isNative(sender)) noteAddress(filed.contactId, sender.id);
      kickMigration();
      const how = via === 'morse-lan' ? 'lan' : (path ?? 'relay');
      log(`${how}: received ${plain.id.slice(0, 8)} from @${fromDevice} (${tier}) via ${how} → @${to.agent}:${to.sessionId.slice(0, 8)}${files.length ? ` + ${files.length} file(s)` : ''}`);
      opts.onChange?.();
      return 'filed';
    } catch (e) {
      opts.mailbox.forgetSeen(seenKey(sender), plain.id);
      throw e;
    }
  };

  // --- large files, recipient side (ADR-038) ---------------------------------------------

  const viaWord = (via: string) => (via === 'morse-lan' ? 'lan' : 'relay');

  /**
   * Who an incoming chunked transfer is staged under: the sending device — or, by address (ADR-081 review F2),
   * the PAIR "their address → the address of ours it was written to". Chunks that arrive at another
   * address of this computer are not part of that transfer.
   */
  const stageId = (sender: Peer): string => (isNative(sender) ? `${sender.id}>${sender.self}` : sender.id);
  /**
   * (ADR-083) The dedupe key of a sender: its device — or, by address, the pair (their address, the address
   * of mine it wrote to). A message id that another address of this computer has seen is new here.
   */
  const seenKey = (sender: Peer): string => (isNative(sender) ? seenKeyFor(sender.id, mineKey(sender.self)) : sender.id);

  /** A trusted device offers a chunked message: stage it (or resume) and say which chunks we hold. */
  const onManifest = async (sender: Peer, plain: MessagePlain, via: 'morse-relay' | 'morse-lan'): Promise<TransferAnswer> => {
    const how = viaWord(via);
    if (filedHere(sender, plain.id)) return { complete: true }; // filed already: the receipt again
    const m = plain.chunked!;
    // (ADR-083: `scope` — the room for unfinished files is counted per address of mine)
    const r = incoming.begin({ id: stageId(sender), name: sender.name, ...(isNative(sender) ? { pair: { theirs: sender.id, ours: sender.self }, scope: mineKey(sender.self) } : {}) }, plain.id, plain, m, via);
    if (!r.ok) {
      log(`${how}: not taking the files of ${plain.id.slice(0, 8)} from @${sender.name} — ${r.error}`);
      return r.busy ? { busy: true } : { error: r.error };
    }
    const files = `${m.files.length} file(s), ${formatBytes(totalBytes(m))}`;
    if (!r.resumed) log(`${how}: receiving ${plain.id.slice(0, 8)} from @${sender.name} — ${files} in ${m.files.reduce((n, f) => n + f.chunks, 0)} chunks (filed once all are in and checked)`);
    if (r.complete) return finishIncoming(sender, plain.id);
    return { have: r.have };
  };

  /** One chunk from a trusted device. null = ignored (malformed / not for a transfer we know). */
  const onChunk = async (sender: Peer, h: ChunkHeader, data: Buffer, via: 'morse-relay' | 'morse-lan'): Promise<TransferAnswer | null> => {
    const r = incoming.put(stageId(sender), h, data);
    if (!r.ok) {
      if (r.unknown) return filedHere(sender, h.id) ? { complete: true } : finishing.has(stagingKeyOf(stageId(sender), h.id)) ? null : { unknown: true };
      log(`${viaWord(via)}: ignored a chunk of ${h.id.slice(0, 8)} from @${sender.name} — ${r.error}`);
      return null;
    }
    if (r.complete) return finishIncoming(sender, h.id);
    return { have: r.have };
  };

  const stagingKeyOf = (senderId: string, msgId: string) => `${senderId}\n${msgId}`;
  /**
   * "You have it already" for a transfer that is no longer staged: the message was filed from this
   * sender — and, by address (ADR-081 review F2), it was written to THIS address of ours. A chunk that arrives
   * at another address of this computer learns nothing about what the first one received.
   */
  // (ADR-083: the dedupe mark itself is per pair now — `seenKey`)
  const filedHere = (sender: Peer, msgId: string): boolean => {
    try {
      return opts.mailbox.hasSeen(seenKey(sender), msgId);
    } catch {
      return false;
    }
  };
  /** One assembly per transfer at a time (the last chunks may arrive together). */
  const finishing = new Map<string, Promise<TransferAnswer>>();

  /** Every chunk is in: check the files, move them to the inbox dir, file the message (text + files together). */
  const finishIncoming = (sender: Peer, msgId: string): Promise<TransferAnswer> => {
    const stage = stageId(sender);
    const key = stagingKeyOf(stage, msgId);
    const running = finishing.get(key);
    if (running) return running;
    const p = (async (): Promise<TransferAnswer> => {
      const meta = incoming.meta(stage, msgId);
      if (!meta) return filedHere(sender, msgId) ? { complete: true } : { unknown: true };
      const via = meta.via === 'morse-lan' ? 'morse-lan' : 'morse-relay';
      let files: MessageFile[];
      try {
        files = await incoming.assemble(stage, msgId, filesDirOf(msgId, sender), safeFileName);
      } catch (e) {
        log(`${viaWord(via)}: ${msgId.slice(0, 8)} from @${sender.name}: ${e instanceof Error ? e.message : String(e)}`);
        return { have: incoming.have(stage, msgId) ?? [], reset: true };
      }
      try {
        await fileMessage(sender, meta.plain as MessagePlain, via, files);
      } catch (e) {
        log(`${viaWord(via)}: could not file ${msgId.slice(0, 8)} from @${sender.name}: ${e instanceof Error ? e.message : String(e)} — the sender sends it again`);
        incoming.remove(stage, msgId);
        return { unknown: true };
      }
      incoming.remove(stage, msgId);
      return { complete: true };
    })().finally(() => finishing.delete(key));
    finishing.set(key, p);
    return p;
  };

  /** Acknowledgements over the relay come in batches: every `ackEvery` chunks, or after a short quiet. */
  const ackEvery = opts.ackEvery ?? 8;
  const ackDelay = opts.ackDelayMs ?? 300;
  const acks = new Map<string, { n: number; timer: NodeJS.Timeout | null }>();
  const flushAck = (sender: Peer, msgId: string, cameVia: 'lan' | 'direct' | 'relay') => {
    const key = stagingKeyOf(stageId(sender), msgId);
    const a = acks.get(key);
    if (a?.timer) clearTimeout(a.timer);
    acks.delete(key);
    const have = incoming.have(stageId(sender), msgId);
    if (!have) return;
    void sealFor(isNative(sender) ? sender : sender.id, { kind: 'transfer', id: msgId, have })
      .then((blob) => sendBack(sender.id, blob, cameVia))
      .catch((e: unknown) => notSent(`chunk acknowledgement to @${sender.name}`, e));
  };

  /** "No such transfer" goes back at most every 5 s per transfer (in-flight chunks would each ask). */
  // (ADR-083 review R1: one map per address of ours — the cap of one is never filled, or emptied, by what arrives at another)
  const unknownSaid = new Map<string, Map<string, number>>();
  const unknownSaidAt = (sender: Peer): Map<string, number> => {
    const scope = isNative(sender) ? mineKey(sender.self) : '';
    let m = unknownSaid.get(scope);
    if (!m) unknownSaid.set(scope, (m = new Map()));
    return m;
  };
  /** Answer a relay / direct-link sender about its chunked message, over the path its envelope came on. */
  const answerRelay = (sender: Peer, msgId: string, a: TransferAnswer | null, batch: boolean, cameVia: 'lan' | 'direct' | 'relay') => {
    if (!a) return;
    if (a.unknown) {
      const key = stagingKeyOf(stageId(sender), msgId);
      const said = unknownSaidAt(sender);
      if (Date.now() - (said.get(key) ?? 0) < 5000) return;
      said.set(key, Date.now());
      if (said.size > 500) said.clear();
    }
    if (a.complete) {
      const key = stagingKeyOf(stageId(sender), msgId);
      const pending = acks.get(key);
      if (pending?.timer) clearTimeout(pending.timer);
      acks.delete(key);
      void sendReceipt(sender, msgId, undefined, true, cameVia);
      return;
    }
    if (batch && a.have && !a.reset) {
      const key = stagingKeyOf(stageId(sender), msgId);
      const cur = acks.get(key) ?? { n: 0, timer: null };
      cur.n++;
      acks.set(key, cur);
      if (cur.n >= ackEvery) return flushAck(sender, msgId, cameVia);
      if (!cur.timer) {
        cur.timer = setTimeout(() => flushAck(sender, msgId, cameVia), ackDelay);
        cur.timer.unref?.();
      }
      return;
    }
    void sealFor(isNative(sender) ? sender : sender.id, { kind: 'transfer', id: msgId, ...a })
      .then((blob) => sendBack(sender.id, blob, cameVia))
      .catch((e: unknown) => notSent(`transfer status to @${sender.name}`, e));
  };

  /** HTTP answer for the same, on the LAN (synchronous: the reply IS the acknowledgement). */
  const lanAnswer = (a: TransferAnswer | null): { status: number; body: unknown } => {
    if (!a) return { status: 400, body: { error: 'chunk not accepted' } };
    if (a.complete) return { status: 201, body: { ok: true, chunked: true } };
    if (a.busy) return { status: 503, body: { error: 'busy receiving other files — try again later', busy: true } };
    if (a.error) return { status: 413, body: { error: a.error } };
    if (a.unknown) return { status: 409, body: { error: 'no such transfer — send the message again', unknown: true } };
    return { status: 200, body: { ok: true, transfer: { have: a.have ?? [], ...(a.reset ? { reset: true } : {}) } } };
  };

  /**
   * One delivery — through the relay (v2 or v3) or a direct link. 'retry' = it could not be
   * filed (a stored v3 delivery is then not acked, so the relay hands it over again).
   */
  const receive = async (d: RelayDelivery): Promise<'retry' | void> => {
    /** ADR-069: the same envelope may come over a direct link instead of the relay */
    const path = d.via === 'direct' ? 'direct' : 'relay';
    let env: SealedEnvelope | EnvelopeV3;
    try {
      env = JSON.parse(d.blob) as SealedEnvelope;
    } catch {
      log(`${path}: dropped unparseable blob ${d.id}`);
      return;
    }
    if (isEnvelopeV3(env)) return receiveV3(d, env);
    const v2 = env as SealedEnvelope;
    if (v2.from !== d.from) {
      log(`${path}: dropped ${d.id} — envelope sender differs from ${path === 'direct' ? 'the direct link peer' : 'relay sender'}`);
      return;
    }
    // (ADR-091) a v1 envelope — only a Morse that does not speak v3 at all still writes one, and it can only come over a
    // v2 connection, which this client no longer has (stage 2): not taken. (With v3 switched off — a stand-in for a
    // Morse from before v3 — the device rules below still take it.)
    if (nativeOn) {
      log(`${path}: dropped a v1 envelope ${d.id} — old-style mail is taken only as a v3 envelope (their Morse must be updated)`);
      return;
    }
    let opened: Opened | null = null;
    return receiveFrom(d, v2.from, d.fromHandle, () => {
      if (!opened) {
        opened = openPlain(v2); // verified: the certificate hashes to the sender ID and signed the envelope
        try {
          senderAddresses.set(v2.from, addressFromPublicKey(rawPublicKey(new X509Certificate(Buffer.from(v2.cert, 'base64')).publicKey)));
        } catch {
          /* bookkeeping only */
        }
      }
      return opened;
    });
  };

  /**
   * ADR-073: a v3 envelope — open it with our prekeys, check the sender (the relay's `from`
   * for a relay delivery, the link's device for a direct one), map the sender to its device
   * through the certificate it attached (P1 bridge, ADR-073 §9), then the same rules as v2.
   */
  const receiveV3 = async (d: RelayDelivery, env: EnvelopeV3): Promise<'retry' | void> => {
    const path = d.via === 'direct' ? 'direct' : d.via === 'lan' ? 'lan' : 'relay';
    if (!addrKey || !prekeys) return 'retry'; // v3 not set up yet (cannot happen: we publish before anyone seals to us)
    // ADR-077: sealed to another agent of this computer (an address with its own key)?
    const other = hosted.get(env.to);
    // (ADR-081 review F1) sealed to an address this daemon does not hold: not ours to open, and nothing answers it
    if (!other && env.to !== addrKey.address) {
      log(`${path}: dropped v3 envelope ${d.id} — it is for ${String(env.to).slice(0, 7)}, an address that is not here right now`);
      return;
    }
    let o: OpenedV3;
    try {
      o = await openV3(env, other ? { address: other.key.address, keys: other.prekeys.keys } : { address: addrKey.address, keys: prekeys.keys });
    } catch (e) {
      if (e instanceof PrekeyUnknownError && path === 'relay' && d.ref) {
        log(`relay: a v3 envelope from ${d.from.slice(0, 7)} was sealed to a prekey we no longer have — asking them to send it again`);
        void askRekey(d.from, d.ref, env.to);
        return;
      }
      log(`${path}: dropped v3 envelope ${d.id} — ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (path === 'relay' && d.from !== o.from) {
      log(`relay: dropped v3 envelope ${d.id} — the signed sender differs from the relay's`);
      return;
    }
    // (ADR-091) a direct link is between two addresses: what comes over it is signed by the address at the other end
    if (path === 'direct' && directByAddress && d.from !== o.from) {
      log(`direct: dropped v3 envelope ${d.id} — its sender is not the direct link peer`);
      return;
    }
    const senderId = deviceOfCert(o.cert, o.fromKey);
    // (a client without `addr1` — the release before ADR-081 — takes nothing without its sender's certificate)
    if (!senderId && !nativeOn) {
      log(`${path}: dropped v3 envelope from ${o.from.slice(0, 7)} — it carries no device certificate (identity v3 phase 1 maps senders to devices)`);
      return;
    }
    const chunk = decodeChunk(o.body);
    let opened: Opened;
    try {
      opened = chunk ? { chunk } : { plain: JSON.parse(o.body.toString('utf8')) as Plain };
    } catch {
      log(`${path}: dropped v3 envelope ${d.id} — unreadable content`);
      return;
    }
    // ADR-081 §3: no device certificate, or the content says "by address" → handled BY ADDRESS: the sender
    // is the address that signed the envelope (openV3 checked key, signature and recipient). Everything
    // else goes through the device rules below, exactly as before.
    // (ADR-083) …and whatever is sealed to an address of ours OTHER than the first, certificate or not: the
    // device rules (pairing, old names, the device certificate on every answer) speak as the first address
    // only — a second address never falls onto them. Its sender is the address that signed, nothing more.
    // (ADR-091) …and since v2 was removed EVERY v3 envelope: the certificate, when there is one, only says that the sender
    // wrote the old way — it is answered with ours, at the first address (`legacy`), and that is all it decides
    if (nativeOn) {
      const byAddress = !o.cert || Boolean(other) || ('plain' in opened && (opened.plain as { addr?: unknown } | null)?.addr === 1);
      // (an answer — a receipt, a transfer status, a notice — from a computer paired here the old way is about mail this
      // computer sent it the old way (to a contact by old name whose address it does not know yet): the device rules
      // that sent it read it. Every MESSAGE, and every chunk, is decided by address.)
      // (the certificate says which device of the old trust list this address is)
      if (!byAddress && senderId) {
        senderAddresses.set(senderId, o.from);
        if (senderAddresses.size > 5000) senderAddresses.clear();
      }
      return receiveNative(d, o, opened, other, !byAddress);
    }
    if (!senderId) {
      log(`${path}: dropped v3 envelope from ${o.from.slice(0, 7)} — it carries no device certificate (identity v3 phase 1 maps senders to devices)`);
      return;
    }
    if (path === 'direct' && senderId !== d.from) {
      log(`direct: dropped v3 envelope ${d.id} — its sender is not the direct link peer`);
      return;
    }
    senderAddresses.set(senderId, o.from);
    if (senderAddresses.size > 5000) senderAddresses.clear();
    // ADR-077: mail for that address is mail for its agent — whatever agent name the sender wrote
    if (other && 'plain' in opened && isMessage(opened.plain)) opened.plain.to = { ...opened.plain.to, agent: other.agent };
    // a stranger's handle is only a claim here (signed, but the relay vouches for nothing in
    // v3): every use of it is checked against the v2 directory, as for a LAN first contact
    const hint = 'plain' in opened && opened.plain.kind === 'message' && typeof opened.plain.fromHandle === 'string' ? opened.plain.fromHandle : undefined;
    return receiveFrom(d, senderId, hint, () => opened);
  };

  /**
   * ADR-073: tell `address` (as the relay named the sender) to fetch our new prekey and resend `ref`.
   * `to` = the address of OURS the unreadable envelope was sealed to: the notice is about that address
   * and is signed by it (ADR-081 review F1: through `sealNative`, or — the first address to a paired device —
   * with this computer's certificate, as before).
   */
  const askRekey = async (address: string, ref: string, to: string): Promise<void> => {
    try {
      if (!v3client?.lookupAddress || !v3client.sendV3 || !addrKey) return;
      const first = to === addrKey.address;
      if (!first && !signerFor(to)) return;
      const info = await v3client.lookupAddress(address);
      const key = info.key ? Buffer.from(info.key, 'base64') : null;
      if (!key || !keyMatchesAddress(key, address) || !verifyPrekey(info.prekey, address, key)) return;
      const body = Buffer.from(JSON.stringify({ kind: 'rekey', ref } satisfies Plain));
      // ADR-081: we cannot read who wrote, nor how. What was sealed to an address of ours other than the
      // first is answered BY that address, by address alone (never with this computer's certificate). For
      // the first address: a paired device gets the certificate-carrying notice as before; anyone else the
      // form its client understands (by address when it published `addr1`).
      const paired = trust.list().some((t) => (senderAddresses.get(t.id) ?? pinnedAddress(t.id)) === address);
      const native = nativeOn && (!first || (!paired && info.caps.includes(CAP_ADDR1)));
      // an address other than the first has no certificate to show: by address, or not at all
      if (!native && !first) return;
      const env = native ? await sealNative(to, address, info.prekey!, body) : await sealV3({ from: addrKey, to: address, prekey: info.prekey, body, cert: certB64 });
      await v3client.sendV3(address, JSON.stringify(env), native ? { from: to } : {});
    } catch (e) {
      if (!(e instanceof NoSignerError)) log(`relay: could not ask ${address.slice(0, 7)} to resend: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** The address a message of ours went to by address alone: its `to` when that is one, else its contact's. */
  const addressedTo = (m: Message): string | null => {
    const direct = m.to.device ? normalizeAddress(m.to.device) : null;
    if (direct) return direct;
    try {
      return (m.contactId ? opts.mailbox.contacts.get(m.contactId)?.address : null) ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Which address of OURS a local NAME stands for — only for rows from before the address itself was
   * recorded (`messages.agent`). A name an address of this daemon has → that address; no name, or this
   * computer's own agent name → its first address (what such a row always meant); anything else → null:
   * the name is not one of ours any more, and nothing is guessed (ADR-081 review F1).
   */
  const addressOfName = (name: string | undefined): string | null => {
    const h = name ? [...hosted.values()].find((x) => x.agent === name) : undefined;
    if (h) return h.key.address;
    return !name || name === selfAgent() ? (addrKey?.address ?? firstAddress) : null;
  };

  /** The address of OURS a message belongs to (sent from / written to): as recorded, else by its name (rows from before). */
  const ownAddressOf = (m: Pick<Message, 'myAddress' | 'myAgent' | 'fromFirstAddress'> & { direction?: Message['direction']; createdAt?: number }): string | null => {
    if (m.myAddress) return m.myAddress;
    // (ADR-081 review: legacy rows) outbound without an address: none was named, or the release before queued it → the
    // first address; a row of this release always has one — nothing is read from its name
    if (m.direction === 'out') return m.fromFirstAddress || fromBefore(m) ? (addrKey?.address ?? firstAddress) : null;
    return m.fromFirstAddress ? (addrKey?.address ?? firstAddress) : addressOfName(m.myAgent);
  };

  /**
   * The addresses of OURS that `address` wrote to, from the mail filed from it (ADR-081 review F1: the recorded
   * address; a row from before by its name). Nothing recorded = nobody to answer as — never "the first
   * address, then". An address this daemon no longer holds stays in the list: `sealNative` refuses it.
   */
  const writtenTo = (address: string): string[] => {
    const out = new Set<string>();
    try {
      for (const t of opts.mailbox.inboundTargets(address)) {
        const mine = ownAddressOf(t);
        if (mine) out.add(mine);
      }
    } catch {
      /* cannot tell: nobody is told */
    }
    return [...out];
  };

  /**
   * ADR-081 §3: one delivery BY ADDRESS — a v3 envelope without a device certificate (or whose content
   * says `addr: 1`), through the relay. Who sent it is the address that signed it; nothing the sender
   * writes about itself (a handle, an agent name) is read. `other` = it was sealed to an address of
   * ours other than the first: every answer is then signed by THAT address.
   *
   *   blocked address                → dropped
   *   a contact's address            → filed under that contact (tier peer — never owner), receipt
   *   anyone else                    → ADR-037, keyed by the address: one message request (text ≤ 64 KB,
   *                                    attachments only counted), `morse.strangers` and the receive
   *                                    limits apply; the receipt says filed / dropped
   */
  const receiveNative = async (d: RelayDelivery, o: OpenedV3, opened: Opened, other: { key: AddressKey; agent: string } | undefined, legacy = false): Promise<'retry' | void> => {
    const from = o.from;
    /** (ADR-091) what its answers go back on: the path it came on (the LAN, a direct link, the relay) */
    const cameVia: 'lan' | 'direct' | 'relay' = d.via === 'direct' ? 'direct' : d.via === 'lan' ? 'lan' : 'relay';
    const self = other?.key ?? addrKey!;
    if (isOwnAddress(from)) {
      log(`relay: dropped a message by address from ${from.slice(0, 7)} — that is an address of this computer`);
      return;
    }
    // (ADR-083) everything below is decided for the pair (the address of mine it was written to, the sender)
    const my = mineKey(self.address);
    if (legacy && !my) noteOldWay(from);
    let contact = contactOfAddress(from, self.address);
    // (ADR-091 follow-up) an old-style envelope at the first address names the old name it was written under (and the
    // pairing named the computer): a name blocked here the old way — morse-blocked.json, whose entries for declined
    // requests and removed contacts carry no address — blocks this address too. Checked BEFORE the name is dropped.
    if (legacy && !my) {
      const claimed = 'plain' in opened && opened.plain && typeof (opened.plain as { fromHandle?: unknown }).fromHandle === 'string' ? String((opened.plain as { fromHandle: string }).fromHandle) : null;
      const pairedName = trust.list().find((t) => (senderAddresses.get(t.id) ?? pinnedAddress(t.id)) === from)?.name ?? null;
      const name = [claimed, pairedName].find((n) => n && !addressShapedHandle(n) && isBlocked(n, home));
      if (name) {
        try {
          opts.mailbox.contacts.blockAt(from, '');
        } catch {
          /* dropped all the same */
        }
        log(`relay: dropped message from morse.im/${from} — written under the old name ${name}, which is blocked here; the address is blocked now too (to undo: morse contact unblock ${from})`);
        return;
      }
    }
    // (ADR-091) a computer paired here the old way (by old name, or as one of yours) whose contact was not made by
    // address yet — the migration knew no address for it — is a contact: it was accepted long ago. Never one you
    // removed (its tombstone stays), and only at the first address (pairing was the first address's).
    if (!contact && !my && legacy) {
      const paired = trust.list().find((t) => (senderAddresses.get(t.id) ?? pinnedAddress(t.id)) === from);
      let removed = false;
      try {
        removed = Boolean(opts.mailbox.contacts.mark(`removed:${from}`));
      } catch {
        removed = true; // cannot tell: not made (the lower trust)
      }
      if (paired && !removed) {
        try {
          // the contact of the old name it was paired under, when there is one (its address is this — the certificate
          // says so); else one by its address
          const filed = opts.mailbox.contacts.filingContact({ address: from, deviceId: paired.id }, paired.name, 'peer');
          let byName = filed ? opts.mailbox.contacts.get(filed) : null;
          if (!byName && paired.tier !== 'owner' && !addressShapedHandle(paired.name)) {
            // (the contact of the old name it was paired under — made as the device rules made it, when there is none)
            const h = opts.mailbox.contacts.byHandle(paired.name);
            byName = h ? (h.id !== SELF_CONTACT && (!h.address || h.address === from) ? h : null) : opts.mailbox.contacts.ensure(handleOf(paired.name).toLowerCase());
          }
          if (byName && byName.id !== SELF_CONTACT) {
            opts.mailbox.contacts.seenAddress(byName.id, from, paired.id);
            contact = byName;
          } else {
            contact = opts.mailbox.contacts.ensureAddress(from, '');
            log(`relay: morse.im/${from} — a computer paired here the old way (${paired.name}) — is a contact by address now`);
          }
        } catch {
          /* a stranger then: a message request */
        }
      }
    }
    if (addressBlocked(from, contact, self.address)) {
      log(`relay: dropped message from morse.im/${from} — blocked here (to undo: morse contact unblock ${from})`);
      return;
    }
    const peer = nativePeer(from, self.address, from, legacy && !other);
    if ('chunk' in opened) {
      // ADR-038: chunks of a message whose manifest we took — only from a contact (a message request takes none)
      if (!contact) return;
      answerRelay(peer, opened.chunk.header.id, await onChunk(peer, opened.chunk.header, opened.chunk.data, 'morse-relay'), true, cameVia);
      return;
    }
    const plain = opened.plain as Plain | null;
    if (!plain || typeof plain !== 'object') {
      log(`relay: dropped malformed message ${d.id} from morse.im/${from}`);
      return;
    }
    // (ADR-081 review F2) an answer counts only for the address PAIR it belongs to: signed by the address the message
    // went to AND arrived at the address of ours the message was sent from — never across our addresses
    const pairOf = (out: Outbound | undefined): out is Outbound => Boolean(out && isNative(out.device) && out.device.id === from && out.device.self === self.address);
    if (plain.kind === 'transfer') {
      const out = outbound.get(String(plain.id));
      if (pairOf(out)) {
        deliverAnswer(out, {
          ...(Array.isArray(plain.have) ? { have: plain.have } : {}),
          ...(plain.reset ? { reset: true } : {}),
          ...(plain.busy ? { busy: true } : {}),
          ...(typeof plain.error === 'string' ? { error: plain.error } : {}),
          ...(plain.unknown ? { unknown: true } : {}),
        });
      }
      return;
    }
    if (plain.kind === 'receipt') {
      const request = plain.request === 'filed' || plain.request === 'dropped' ? plain.request : undefined;
      const full = request === 'dropped' && plain.full === true; // (ADR-081 review F4) their message requests are full
      const out = outbound.get(String(plain.id));
      if (pairOf(out)) {
        out.full = full;
        deliverAnswer(out, request ? { request } : plain.chunked ? { complete: true } : { legacy: true });
        return;
      }
      const m = typeof plain.id === 'string' ? opts.mailbox.getMessage(plain.id) : null;
      // only the ADDRESS the message went to can confirm it (after a restart: the one its row names) …
      const expected = m ? (sentTo.get(m.id) ?? addressedTo(m)) : null;
      if (!m || !m.to.device || expected !== from) return;
      // … and only at the address of ours it was sent from
      if (ownAddressOf(m) !== self.address) return;
      sentTo.delete(m.id);
      // (held messages are found by how they were addressed: the address, or the contact's old name)
      const held = nativePeer(from, self.address, normalizeAddress(m.to.device) ?? handleOf(m.to.device).toLowerCase());
      if (request !== 'dropped') opts.mailbox.markReceipt(m.id);
      if (request === 'filed') opts.mailbox.markRequest(m.id);
      if (request) awaitAccept(held, full);
      else settleAccepted(held, 'the other side confirmed a message to its inbox');
      receiptWaiters.get(m.id)?.({ deviceId: from, ...(request ? { request } : {}), ...(full ? { full } : {}) });
      log(`relay: receipt for ${m.id.slice(0, 8)} from morse.im/${from}${request === 'filed' ? ' — in their message requests (request pending)' : full ? ' — not kept (their message requests are full); held here' : request === 'dropped' ? ' — not kept (they have a request from you already); held here' : ''}`);
      opts.onChange?.();
      return;
    }
    if (plain.kind === 'accepted') {
      settleAccepted(peer, 'they told us');
      return;
    }
    if (plain.kind === 'rekey') {
      // ADR-073: they could not open what we left in their mailbox — fresh prekey, send it again
      // (ADR-083 review R1) …the prekey THIS address of ours had looked up — and no other address's: a notice that
      // reaches one address says nothing to another. The per-device cache is the device path's, i.e. the first
      // address's alone: a notice at another address of this computer leaves it as it is.
      lookupsOf(self.address).delete(from);
      if (!my) for (const t of trust.list()) if ((senderAddresses.get(t.id) ?? pinnedAddress(t.id)) === from) v3Peers.delete(t.id);
      const m = typeof plain.ref === 'string' ? opts.mailbox.getMessage(plain.ref) : null;
      // (only for a message that went to them: by address, or to the contact this address is a computer of —
      // and, ADR-081 review F2, only when the notice came to the address of ours that message was sent from)
      const theirs = m ? (addressedTo(m) === from || (Boolean(m.contactId) && contactOfAddress(from, self.address)?.id === m.contactId)) && ownAddressOf(m) === self.address : false;
      if (m && theirs && !m.receiptAt && m.to.device && opts.mailbox.markUndelivered(m.id, `morse.im/${from} could not open it (an old key) — sending it again`, { retry: true })) {
        log(`relay: ${m.id.slice(0, 8)} → morse.im/${from} is sent again with their new prekey`);
        opts.onChange?.();
      }
      return;
    }
    if (!isMessage(plain)) {
      log(`relay: dropped malformed message ${d.id} from morse.im/${from}`);
      return;
    }
    // the sender is its address: what it writes about itself is not read, let alone believed
    delete plain.fromHandle;
    delete plain.fromAgent;
    delete plain.fromNickname;
    // mail for an address is mail for its agent — whatever agent name the sender wrote; never a session
    // (ADR-091 follow-up) …except an old-style envelope at the first address written to `<old name>/<agent>`: an old name
    // covered every agent of the computer, so the agent it names — when it is one of this computer's — is the one it is for
    const named = legacy && !other && typeof plain.to?.agent === 'string' && [...hosted.values()].some((h) => h.agent === plain.to.agent) ? plain.to.agent : null;
    plain.to = { agent: other?.agent ?? named ?? selfAgent() ?? plain.to.agent, sessionId: '' };

    if (!contact) {
      const mode = strangers();
      if (mode === 'block') {
        log(`relay: dropped message from morse.im/${from} — not a contact, and strangers are blocked (morse.strangers: "block"; to accept them: morse contact add morse.im/${from})`);
        return;
      }
      if (!withinLimit(from, 'relay', my)) return; // no receipt: the sender retries later
      if (mode === 'request') {
        let r: 'filed' | 'duplicate' | 'dropped' | 'full';
        try {
          // (the request keeps the address of ours it was written to: that is also what marks it "by address")
          r = await fileRequest({ id: from, handle: from }, plain, 'morse-relay', undefined, self.address);
        } catch (e) {
          log(`relay: could not file the message request from morse.im/${from}: ${e instanceof Error ? e.message : String(e)}`);
          return 'retry';
        }
        // the receipt says "message request": their computer holds the rest until we accept
        // (full — ADR-081 review F4: not kept, and nobody was pushed out for it; they try again later)
        void sendReceipt(peer, plain.id, r === 'duplicate' ? 'filed' : r, undefined, cameVia);
        return;
      }
      // morse.strangers "accept": whoever writes is a contact at once (the old pair-back) — a request left
      // from before moves in too. Nothing is paired: an address has no device to trust.
      try {
        contact = opts.mailbox.contacts.ensureAddress(from, my);
        if (opts.mailbox.requests.get(from, my)) acceptPending(from, 'accepted automatically', my);
      } catch (e) {
        log(`relay: could not accept morse.im/${from}: ${e instanceof Error ? e.message : String(e)}`);
        return 'retry';
      }
      log(`relay: morse.im/${from} wrote to you first — a contact now (morse.strangers: "accept"); to block them: morse contact block ${from}`);
    } else if (!(Boolean(plain.chunked) && incoming.has(stageId(peer), plain.id)) && !withinLimit(from, 'relay', my)) return; // a chunked message counts once (ADR-038)
    settleAccepted(peer, 'they wrote to you');
    if (plain.chunked) {
      answerRelay(peer, plain.id, await onManifest(peer, plain, 'morse-relay'), false, cameVia);
      return;
    }
    try {
      await fileMessage(peer, plain, 'morse-relay', undefined, d.via);
    } catch (e) {
      log(`relay: could not file ${plain.id.slice(0, 8)} from morse.im/${from}: ${e instanceof Error ? e.message : String(e)}`);
      return 'retry';
    }
    // receipt (again, for a duplicate): signed by the address that was written to
    void sendReceipt(peer, plain.id, undefined, undefined, cameVia);
  };

  /** The rules for one delivery once its sender device is known (relay v2 / v3, direct). */
  const receiveFrom = async (d: RelayDelivery, fromId: string, handleHint: string | undefined, openLazy: () => Opened): Promise<'retry' | void> => {
    const path = d.via === 'direct' ? 'direct' : 'relay';
    let sender = trust.get(fromId);
    let counted = false;
    if (!sender) {
      const claimed = handleHint ? parseMorseAddress(handleHint)?.handle : undefined;
      // (ADR-081 review F3) an old name never has the shape of an address — whoever says so (the relay, or the sender)
      const handle = claimed && !addressShapedHandle(claimed) ? claimed : undefined;
      if (!handle) {
        log(`relay: dropped message from UNPAIRED device ${fromId} — ${claimed ? `the name given for it (${claimed}) has the shape of an address, which no old name has` : 'if you know them: morse pair add <their handle>'}`);
        return;
      }
      const decision = decide(handle, 'relay');
      if (decision === 'drop') return;
      if (!isOwnHandle(handle)) {
        if (!withinLimit(handle, 'relay')) return;
        counted = true;
      }
      if (decision === 'request') return receiveRequest(d, fromId, handle, openLazy);
      sender = await autoPair(handle, fromId, 'relay');
      if (!sender) return;
    }
    // (ADR-081 review F3) a device paired under an address-shaped name (only an entry from before such names were refused
    // can be one): its mail would be filed as if that ADDRESS had written — nothing from it is taken
    if (addressShapedHandle(sender.name)) {
      log(`${path}: dropped ${d.id} from device ${fromId.slice(0, 7)} — it is paired under "${sender.name}", which has the shape of an address (no old name does); remove it: morse pair remove ${fromId}`);
      return;
    }
    const me = client.handle();
    if (sender.tier === 'peer' && me && handleHint && parseMorseAddress(handleHint)?.handle === me.toLowerCase() && !isBlocked(me, home) && !lowered(sender.id)) {
      // one of our own devices, still paired as peer (before ADR-034): confirm with the directory, then owner
      const p = await pairHandle(me, fromId);
      sender = trust.get(fromId) ?? sender;
      if (p.ok) log(`relay: @${sender.name} (${fromId.slice(0, 7)}) is under your own handle — now tier ${sender.tier}`);
    }
    let plain: Plain;
    try {
      const o = openLazy();
      if ('chunk' in o) {
        // ADR-038: chunks of a message whose manifest we took; not counted as messages
        const a = await onChunk(sender, o.chunk.header, o.chunk.data, 'morse-relay');
        answerRelay(sender, o.chunk.header.id, a, true, path);
        return;
      }
      plain = o.plain;
    } catch (e) {
      log(`${path}: dropped ${d.id} from @${sender.name} — ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (plain.kind === 'transfer') {
      const out = outbound.get(String(plain.id));
      if (out && !isNative(out.device) && out.device.id === sender.id) {
        deliverAnswer(out, {
          ...(Array.isArray(plain.have) ? { have: plain.have } : {}),
          ...(plain.reset ? { reset: true } : {}),
          ...(plain.busy ? { busy: true } : {}),
          ...(typeof plain.error === 'string' ? { error: plain.error } : {}),
          ...(plain.unknown ? { unknown: true } : {}),
        });
      }
      return;
    }
    if (plain.kind === 'receipt') {
      const out = outbound.get(plain.id);
      if (out && !isNative(out.device) && out.device.id === sender.id) {
        // a chunked message of ours (ADR-038): its transfer decides what the receipt means
        const request = plain.request === 'filed' || plain.request === 'dropped' ? plain.request : undefined;
        out.full = request === 'dropped' && plain.full === true;
        deliverAnswer(out, request ? { request } : plain.chunked ? { complete: true } : { legacy: true });
        return;
      }
      const m = opts.mailbox.getMessage(plain.id);
      // only the device the message went to can confirm it (after a restart: a device of that person)
      const expected = sentTo.get(plain.id);
      if (m && (expected ? expected === sender.id : Boolean(m.to.device && devicesFor(trust, m.to.device).some((t) => t.id === sender!.id)))) {
        const request = plain.request === 'filed' || plain.request === 'dropped' ? plain.request : undefined;
        const full = request === 'dropped' && plain.full === true; // (ADR-081 review F4) their message requests are full
        sentTo.delete(plain.id);
        // dropped = not kept over there: no receipt, it stays here (held) and goes again once they accept
        if (request !== 'dropped') opts.mailbox.markReceipt(plain.id);
        if (request === 'filed') opts.mailbox.markRequest(plain.id);
        if (request) awaitAccept(sender, full);
        else settleAccepted(sender, 'the other side confirmed a message to its inbox');
        receiptWaiters.get(plain.id)?.({ deviceId: sender.id, ...(request ? { request } : {}), ...(full ? { full } : {}) });
        log(`relay: receipt for ${plain.id.slice(0, 8)} from @${sender.name}${request === 'filed' ? ' — in their message requests (request pending)' : full ? ' — not kept (their message requests are full); held here' : request === 'dropped' ? ' — not kept (they have a request from you already); held here' : ''}`);
        opts.onChange?.();
      }
      return;
    }
    if (plain.kind === 'accepted') {
      settleAccepted(sender, 'they told us');
      return;
    }
    if (plain.kind === 'rekey') {
      // ADR-073: they could not open what we left in their mailbox — fresh prekey, send it again
      v3Peers.delete(sender.id);
      const m = typeof plain.ref === 'string' ? opts.mailbox.getMessage(plain.ref) : null;
      if (m && !m.receiptAt && m.to.device && opts.mailbox.markUndelivered(m.id, `@${sender.name} could not open it (an old key) — sending it again`, { retry: true })) {
        log(`relay: ${m.id.slice(0, 8)} → @${sender.name} is sent again with their new prekey`);
        opts.onChange?.();
      }
      return;
    }
    if (!isMessage(plain)) {
      log(`relay: dropped malformed message ${d.id} from @${sender.name}`);
      return;
    }
    // a chunked message counts once — its resumed offers and its chunks do not (ADR-038)
    const resuming = Boolean(plain.chunked) && incoming.has(sender.id, plain.id);
    if (!counted && !resuming && sender.tier !== 'owner' && !withinLimit(sender.name, 'relay')) return; // no receipt: the sender retries later
    settleAccepted(sender, 'they wrote to you');
    if (plain.chunked) {
      answerRelay(sender, plain.id, await onManifest(sender, plain, 'morse-relay'), false, path);
      return;
    }
    try {
      await fileMessage(sender, plain, 'morse-relay', undefined, d.via);
    } catch (e) {
      log(`${path}: could not file ${plain.id.slice(0, 8)} from @${sender.name}: ${e instanceof Error ? e.message : String(e)}`);
      return 'retry'; // no receipt → the sender retries, and the retry is not treated as a duplicate
    }
    // receipt (again, for a duplicate): the sender learns it arrived — over the path the message came on
    void sendReceipt(sender, plain.id, undefined, undefined, path);
  };

  /** LAN inbound (ADR-034): the peer API already pinned `peer` by mutual TLS. */
  const receiveDirect = async (peer: TrustedDevice, raw: unknown): Promise<{ status: number; body: unknown }> => {
    // (ADR-081 review F3) as on the relay path: never mail from a device that goes under an address-shaped name
    if (addressShapedHandle(peer.name)) return { status: 403, body: { error: 'this device is paired under a name with the shape of an address — not accepted' } };
    let body = raw;
    const sealed = (raw as { sealedV3?: unknown } | null)?.sealedV3;
    if (sealed !== undefined) {
      // ADR-073: a sealed v3 envelope on the LAN — it must be signed by this very device
      if (!addrKey || !prekeys) return { status: 503, body: { error: 'v3 is not set up here yet — send the plain message' } };
      if (!isEnvelopeV3(sealed)) return { status: 400, body: { error: 'not a v3 envelope' } };
      let o: OpenedV3;
      try {
        o = await openV3(sealed, { address: addrKey.address, keys: prekeys.keys });
      } catch (e) {
        if (e instanceof PrekeyUnknownError) return { status: 409, body: { error: 'none of our prekeys opens it — fetch the new one', rekey: true } };
        return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
      }
      if (deviceOfCert(o.cert, o.fromKey) !== peer.id) return { status: 403, body: { error: 'the envelope was not sealed by this device' } };
      senderAddresses.set(peer.id, o.from);
      const chunk = decodeChunk(o.body);
      if (chunk) {
        if (!trust.get(peer.id)) return { status: 403, body: { error: 'not paired — a message request takes no file chunks' } };
        return lanAnswer(await onChunk(peer, chunk.header, chunk.data, 'morse-lan'));
      }
      try {
        body = JSON.parse(o.body.toString('utf8')) as unknown;
      } catch {
        return { status: 400, body: { error: 'unreadable content' } };
      }
    }
    if (isLanChunk(body)) {
      // ADR-038: a chunk — only from a device paired here, for a transfer it offered first
      if (!trust.get(peer.id)) return { status: 403, body: { error: 'not paired — a message request takes no file chunks' } };
      const { data, ...header } = body;
      return lanAnswer(await onChunk(peer, header, Buffer.from(data, 'base64'), 'morse-lan'));
    }
    if (!isMessage(body)) return { status: 400, body: { error: 'expected a Morse message {kind:"message", id, from, to, text}' } };
    const resuming = Boolean(body.chunked) && incoming.has(peer.id, body.id);
    if (peer.tier !== 'owner' && !resuming && !withinLimit(peer.name, 'lan')) return { status: 429, body: { error: 'too many messages — try again later' } };
    if (!trust.get(peer.id)) {
      // admitted by admitDirect for a message request (ADR-037), not paired
      try {
        const r = await fileRequest({ id: peer.id, handle: peer.name.toLowerCase() }, body, 'morse-lan', verifiedNames.get(peer.id));
        // (ADR-081 review F4) full: not kept — said as "dropped" (what an older Morse understands) plus `full`
        return { status: 202, body: { ok: true, request: r === 'dropped' || r === 'full' ? 'dropped' : 'filed', ...(r === 'full' ? { full: true } : {}) } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`lan: could not file the message request from morse.im/${peer.name}: ${msg}`);
        return { status: 500, body: { error: msg } };
      }
    }
    settleAccepted(peer, 'they wrote to you');
    if (body.chunked) return lanAnswer(await onManifest(peer, body, 'morse-lan'));
    try {
      const r = await fileMessage(peer, body, 'morse-lan');
      return { status: r === 'filed' ? 201 : 200, body: { ok: true, ...(r === 'duplicate' ? { duplicate: true } : {}) } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`lan: could not file ${body.id.slice(0, 8)} from @${peer.name}: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  };

  /** ADR-073: an envelope we left in the relay's mailbox expired unread — the message failed. */
  const onUndeliverable = (n: Undeliverable) => {
    const m = opts.mailbox.getMessage(n.ref);
    if (!m || m.receiptAt || !m.to.device) return;
    if (!opts.mailbox.markUndelivered(m.id, `not delivered: ${m.to.device} did not come online within 7 days — the relay dropped it`)) return;
    log(`morse: ${m.id.slice(0, 8)} → ${m.to.device} was not fetched within 7 days — the relay dropped it (not delivered)`);
    opts.onChange?.();
  };

  /** ADR-073: a delivery over the v3 connection; a stored one is acked once handled. */
  const onV3Deliver = async (d: RelayDelivery): Promise<void> => {
    let r: 'retry' | void;
    try {
      r = await receive(d);
    } catch (e) {
      log(`relay: v3 delivery ${d.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      r = 'retry';
    }
    if (d.stored && r !== 'retry' && d.to) v3client?.ack?.(d.to, [d.id]);
  };

  const HOUSEKEEPING_MS = 3600_000;
  let rotateTimer: NodeJS.Timeout | null = null;
  /**
   * (ADR-083 review R4) Prekey rotation (weekly, ADR-073 §4) — per address, each at its own secret moments
   * (src/identity/prekey-schedule.ts), never for all of them in one tick: the moment a new prekey appears on the
   * relay is public, and one shared tick (or one daemon start, one wake-up, one login) made it the same for
   * every address of this computer.
   */
  const prekeyClock = opts.prekeyClock ?? systemClock;
  /** A new prekey's date: "now" less a random stretch (see ensurePrekeys) — exactly "now" on a test's clock. */
  const prekeyJitter = (): number => (opts.prekeyClock ? 0 : randomInt(0, PREKEY_JITTER_MS));
  let rotation: RotationSchedule | null = null;
  /**
   * Addresses whose current prekey is dated like another address's of this computer (made in one go by the
   * release before, and replaced in the same tick ever since): replaced at their next own moment, due or not.
   */
  const twins = new Set<string>();
  /** One address's own moment: replace its prekey if it is due (or a twin) and publish it — only while the relay is there. */
  const rotatePrekeyOf = (key: AddressKey) => {
    // not connected: the new prekey would go out with the next login — together with every other address
    // that waited. Left as it is; this address's next moment looks again.
    if (!v3client?.connected()) return;
    const own = Boolean(addrKey && key.address === addrKey.address);
    const h = own ? undefined : hosted.get(key.address);
    if (!own && !h) return;
    try {
      const next = ensurePrekeys(key, prekeyClock.now(), { jitterMs: prekeyJitter(), force: twins.has(key.address) });
      twins.delete(key.address);
      if (own) prekeys = next;
      else h!.prekeys = next;
      if (next.rotated) {
        void v3client.publishPrekey?.(key.address, next.current).catch((e: unknown) => log(`relay: v3 prekey not published yet (${e instanceof Error ? e.message : String(e)}) — it goes with the next login`));
      }
    } catch (e) {
      log(`morse: v3 prekeys${h ? ` of ${h.agent}` : ''}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  /** Dedupe-mark pruning (31 days) and the contact migration's retries, hourly — nothing of it shows outside this computer per address. */
  const maintainV3 = () => {
    if (!addrKey) return;
    try {
      opts.mailbox.pruneSeen(Date.now() - 31 * 24 * 3600_000);
    } catch {
      /* next hour */
    }
    // ADR-077: contacts the relay could not be asked about yet
    try {
      if (v3client?.connected() && opts.mailbox.contacts.pendingSplits().length) void migrateContacts();
    } catch {
      /* next hour */
    }
  };

  /** ADR-077: a contact made after the migration (a first exchange) is checked soon, not at the next login. */
  let lastKick = 0;
  const kickMigration = () => {
    if (Date.now() - lastKick < 10 * 60_000 || !client.connected()) return;
    lastKick = Date.now();
    try {
      if (opts.mailbox.contacts.pendingSplits().length) void migrateContacts();
    } catch {
      /* bookkeeping only */
    }
  };

  /** ADR-077: the online half of the contact migration — one run at a time. */
  let migrating: Promise<SplitOutcome> | null = null;
  let migrateTimer: NodeJS.Timeout | null = null;
  const migrateContacts = (): Promise<SplitOutcome> => {
    if (migrating) return migrating;
    const v3 = v3client;
    migrating = completeContactSplit({
      contacts: opts.mailbox.contacts,
      selfHandle: () => client.handle(),
      selfDeviceId: identity.id,
      trust,
      pinned: (id) => senderAddresses.get(id) ?? pinnedAddress(id),
      ...(v3?.connected() && v3.lookupAlias ? { lookupAlias: (name: string) => withTimeout(v3.lookupAlias!(name), 5000) } : {}),
      resolveAgent: (h, a) => withTimeout(client.resolveAgent(h, a), 5000),
      lookupHandle: (h) => withTimeout(client.lookupHandle(h), 5000),
      log,
    })
      .then((r) => {
        if (r.created.length || r.ownDevices) opts.onChange?.();
        return r;
      })
      .catch((e: unknown) => {
        log(`morse: contact migration: ${e instanceof Error ? e.message : String(e)} — tried again after the next relay login`);
        return { done: 0, created: [], pending: -1, ownDevices: 0 } satisfies SplitOutcome;
      })
      .finally(() => {
        migrating = null;
      });
    return migrating;
  };

  /**
   * Open the v3 connection (unless v3 is switched off). (ADR-091) At start — it no longer waits for a v2 login to
   * announce protocol 3: a computer installed since v2 was removed never logs in the v2 way at all.
   */
  const startV3 = () => {
    if (v3client || opts.v3 === false) return;
    try {
      addrKey = loadPrimaryAddress(home, identity);
      // (ADR-083 review R4) a start replaces nobody's prekey: the one that is there logs in, due or not — each
      // address replaces its own at its own moment (`rotatePrekeyOf`). Only an address without any gets one now.
      prekeys = ensurePrekeys(addrKey, prekeyClock.now(), { jitterMs: prekeyJitter(), rotate: false });
    } catch (e) {
      log(`morse: v3 off — cannot set up your address here: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const key = addrKey;
    // ADR-077: every agent added after the first has an address of its own — logged in on the same connection
    try {
      for (const a of ensureAgentAddresses(home, identity)) {
        if (a.primary || a.key.address === key.address || hosted.size >= 31) continue;
        hosted.set(a.key.address, { key: a.key, prekeys: ensurePrekeys(a.key, prekeyClock.now(), { jitterMs: prekeyJitter(), rotate: false }), agent: a.agent });
      }
    } catch (e) {
      // (ADR-081 review F1) NOT "this computer has only its first address": what was written from another one stays unsent
      hostedBroken = e instanceof Error ? e.message : String(e);
      log(`morse: the addresses of this computer's other agents are not set up: ${hostedBroken} — ONLY this computer's first address is online. Mail to its other addresses is not received, and nothing written from them is sent (it is refused, not sent from the first address) until this is fixed and the daemon restarted.`);
    }
    v3client = (opts.client ?? startRelayClient)({
      url: opts.url,
      identity,
      bundle: makeKeyBundle(identity, enc),
      // ADR-081: every address is published with what this client can do for it (`addr1`)
      v3: { logins: () => [{ key, prekey: (prekeys ?? ensurePrekeys(key, prekeyClock.now(), { jitterMs: prekeyJitter(), rotate: false })).current, caps }, ...[...hosted.values()].map((h) => ({ key: h.key, prekey: h.prekeys.current, caps }))] },
      onDeliver: onV3Deliver,
      onUndeliverable,
      // (ADR-091) direct links by address are signaled over this connection
      ...(directByAddress ? { onSignal: (sig: { from: string; blob: string }) => direct?.onSignal(sig.from, sig.blob) } : {}),
      onConnected: () => {
        if (directByAddress) direct?.resetSignaling();
        if (migrateTimer) clearTimeout(migrateTimer);
        // (ADR-077) the contacts by old name still to be checked with the relay — only while there is a v2 side
        if (v2On) void migrateContacts();
      },
      log,
    });
    // (ADR-083 review R4) prekeys dated like another address's of this computer — what the release before left
    // behind (a millisecond apart, public): all but the first of each group are replaced at their next own moment
    const all = [{ key, prekeys: prekeys! }, ...hosted.values()];
    for (const a of twinsOf(all.map((x) => ({ address: x.key.address, createdAt: x.prekeys.current.createdAt })))) twins.add(a);
    rotation = startRotationSchedule({ keys: all.map((x) => x.key), onSlot: rotatePrekeyOf, clock: prekeyClock });
    rotateTimer = setInterval(maintainV3, HOUSEKEEPING_MS);
    rotateTimer.unref?.();
    maintainV3();
  };

  // (ADR-091, stage 2) no v2 connection at all: nothing is sent the v2 way any more — no v2 login, no v1 envelope, no
  // handle / agent / key-bundle lookup. What someone not updated yet sends the old way still arrives over the v3
  // connection (a v3 envelope with their certificate) and is taken by address. Only a client with v3 switched off
  // (`v3: false`: the tests' stand-in for a Morse from before v3) still logs in the v2 way.
  const v2On = opts.v3 === false;
  client = !v2On
    ? offlineV2(opts.url)
    : (opts.client ?? startRelayClient)({
    url: opts.url,
    identity,
    bundle: makeKeyBundle(identity, enc),
    onDeliver: async (d) => {
      await receive(d);
    },
    ...(directByAddress ? {} : { onSignal: (sig: { from: string; blob: string }) => direct?.onSignal(sig.from, sig.blob) }),
    onConnected: () => {
      if (!directByAddress) direct?.resetSignaling();
      startV3();
      // ADR-077: the contact migration asks the relay's alias table over the v3 connection — when the
      // relay speaks v3, wait for that connection (its login runs it); if it does not come up, the v2
      // directory after a while; a relay without v3: the v2 directory now
      void syncOwnDevices().finally(() => {
        if (!v3client) return void migrateContacts();
        if (migrateTimer) clearTimeout(migrateTimer);
        migrateTimer = setTimeout(() => void migrateContacts(), 30_000);
        migrateTimer.unref?.();
      });
    },
    // ADR-065: nicknames the relay still announces (old clients' profiles) are ignored
    log,
  });

  // ADR-069: direct links, signaled over the relay; only with paired / contact devices
  // (ADR-091) by address: between this computer's FIRST address and a contact of it — signals are v3 envelopes over
  // the v3 connection; another address of this computer never has a link (what it sends goes through the relay)
  let directSeq = 0;
  if (opts.direct) {
    const firstKey = (): AddressKey => {
      if (!addrKey || !prekeys) throw new Error('this address is not online yet');
      return addrKey;
    };
    direct = startDirect({
      ...opts.direct,
      ...(directByAddress
        ? {
            byAddress: {
              self: firstAddress ?? identity.id,
              seal: async (to: string, bytes: Buffer) => {
                const me = firstKey();
                const peer = await lookupNative(me.address, to, false);
                if (!peer.ok) throw new Error(peer.error);
                return JSON.stringify(await sealNative(me.address, to, peer.prekey, bytes));
              },
              open: async (from: string, blob: string) => {
                const me = firstKey();
                const env = JSON.parse(blob) as unknown;
                if (!isEnvelopeV3(env)) throw new Error('not a v3 envelope');
                const o = await openV3(env, { address: me.address, keys: prekeys!.keys });
                if (o.from !== from) throw new Error('signed by another address than the one it came from');
                return { plaintext: o.body, nonce: createHash('sha256').update(blob).digest('hex') };
              },
            },
          }
        : { identity, enc, recipientKey }),
      isPeer: directByAddress
        ? (address) => {
            const me = addrKey?.address;
            if (!me) return false;
            const c = contactOfAddress(address, me);
            return Boolean(c) && !addressBlocked(address, c, me);
          }
        : (id) => {
            const t = trust.get(id);
            return Boolean(t) && !isBlocked(handleOf(t!.name), home);
          },
      signal: {
        send: (to, blob) => {
          const via = directByAddress ? v3client : client;
          return via?.signal ? via.signal(to, blob) : Promise.reject(new Error('relay: unknown request'));
        },
      },
      onMessage: (from, blob) => void receive({ id: `direct-${++directSeq}`, from, blob, ts: Date.now(), via: 'direct' }).catch((e: unknown) => log(`direct: inbound failed: ${e instanceof Error ? e.message : String(e)}`)),
      log,
    });
  }
  const directReceiptMs = opts.directReceiptMs ?? Math.min(receiptTimeout / 2, 5000);
  // (ADR-091) the v3 connection does not wait for anything
  startV3();

  /** message id → "the wait is over, nothing came" (what the timeout does; `expireReceiptWait` does it early, for tests). */
  const receiptExpiry = new Map<string, () => void>();
  const waitReceipt = (id: string, ms: number): Promise<ReceiptSeen | null> =>
    new Promise((resolve) => {
      const got = (r: ReceiptSeen) => {
        clearTimeout(t);
        if (receiptExpiry.get(id) === expire) receiptExpiry.delete(id);
        receiptWaiters.delete(id);
        resolve(r);
      };
      const expire = () => {
        clearTimeout(t);
        // (only its own wait: the timer of an earlier try of the same message must not end a later try's wait)
        if (receiptExpiry.get(id) === expire) receiptExpiry.delete(id);
        if (receiptWaiters.get(id) === got) receiptWaiters.delete(id);
        resolve(null);
      };
      const t = setTimeout(expire, ms);
      receiptExpiry.set(id, expire);
      receiptWaiters.set(id, got);
    });

  /** Where a message goes: one trusted device + what the recipient sees as `to`. */
  type Target =
    | { kind: 'device'; device: Peer; label: string; to: { agent: string; sessionId: string } }
    | { kind: 'self'; label: string; to: { agent: string; sessionId: string } };

  /** Where each agent address resolved last time (ADR-034): lets the LAN path work
   *  while the relay is unreachable. `handle/agent` ('' = default) → device ID + agent. */
  const lastSeen = new Map<string, { deviceId: string; agent: string }>();

  /** A paired device name with a concrete session, or a device ID: no directory needed. */
  const namedTarget = (to: string, message: Message): Target | MorseSendResult | null => {
    const explicitSession = Boolean(message.to.sessionId);
    const keep = { agent: message.to.agent, sessionId: message.to.sessionId };
    // ADR-077: a bare v3 address reaches the paired device whose certificate hashes to it (a contact without
    // an old name, e.g. a computer of yours paired by device ID) — never read as a handle
    const asAddress = normalizeAddress(to);
    if (asAddress) {
      const hit = trust.list().find((d) => (senderAddresses.get(d.id) ?? pinnedAddress(d.id)) === asAddress);
      return hit ? { kind: 'device', device: hit, label: `morse.im/${asAddress}`, to: keep } : { ok: false, error: `no paired device has the address ${asAddress} (morse contact)` };
    }
    const addr = parseMorseAddress(to);
    const named = !to.includes('/') && (explicitSession || !addr) ? devicesFor(trust, to) : [];
    if (named.length === 1) return { kind: 'device', device: named[0]!, label: `@${to}`, to: keep };
    if (named.length > 1) return { ok: false, error: `"${to}" is ${named.length} devices — address one agent: morse.im/${to}/<agent>` };
    if (!addr) return { ok: false, error: `"${to}" is not paired (morse pair add ${to})` };
    return null;
  };

  const wantedAgent = (to: string, message: Message): { handle: string; wanted: string | undefined } | null => {
    const addr = parseMorseAddress(to);
    if (!addr) return null;
    const explicitSession = Boolean(message.to.sessionId);
    return { handle: addr.handle, wanted: addr.agent ?? (!explicitSession && message.to.agent !== INBOX_AGENT ? message.to.agent : undefined) };
  };

  const theirTo = (message: Message, agent: string) =>
    message.to.sessionId ? { agent: message.to.agent, sessionId: message.to.sessionId } : { agent, sessionId: '' };

  /** Relay unreachable: the device this address resolved to last time, if still trusted. */
  const cachedTarget = (to: string, message: Message): Extract<Target, { kind: 'device' }> | null => {
    const named = namedTarget(to, message);
    if (named && 'kind' in named) return named.kind === 'device' ? named : null;
    const w = wantedAgent(to, message);
    const hit = w ? lastSeen.get(`${w.handle}/${w.wanted ?? ''}`) : undefined;
    const device = hit ? trust.get(hit.deviceId) : undefined;
    if (!w || !hit || !device) return null;
    return { kind: 'device', device, label: `morse.im/${w.handle}/${hit.agent}`, to: theirTo(message, hit.agent) };
  };

  // --- sending by address alone (ADR-081 §2, §6) ------------------------------------------------

  /**
   * Which of OUR addresses a message goes out from (§6; ADR-081 review F1) — decided by the ADDRESS the row
   * records (`messages.my_address`: `morse send --from`, a reply to mail written to an address, anything
   * that went by address before). The local name (`messages.agent`) is display only: an address may be
   * renamed and nothing changes. (ADR-081 review: legacy rows) a row WITHOUT an address is one the release before
   * queued — it goes from the first address, by the paths from before — when it is older than this
   * release's first daemon run on this database (`fromBefore`); a newer one is refused. No name is
   * ever resolved here: `ownAddressNamed` does that when a message is queued.
   *
   * `explicit` = an address other than this computer's first: such mail goes by address alone or not at
   * all. Whatever cannot be resolved to an address this daemon holds is refused (`ok: false`); nothing
   * ever falls back to the first address.
   */
  type Sender = { ok: true; address: string | null; explicit: boolean } | { ok: false; error: MorseSendResult };
  const nameOfAddress = (address: string): string => [...hosted.values()].find((h) => h.key.address === address)?.agent ?? (address === (addrKey?.address ?? firstAddress) ? (selfAgent() ?? '') : '');
  /** name → address as on disk; {} when it cannot be read (display only — never decides a sender). */
  const safeIndex = (): Record<string, string> => {
    try {
      return agentAddressIndex(home);
    } catch {
      return {};
    }
  };
  const goneLine = (address: string) => `this message was written from your address morse.im/${address}, which is no longer here (or its key is not loaded) — not sent`;
  /** (ADR-088) An address of this home as `morse address` shows it: its name in quotes — the address itself when it has none. */
  const shownAs = (address: string): string => {
    let name: string | null = null;
    try {
      name = shownNameOf(address, home);
    } catch {
      /* the names cannot be read: the address says it */
    }
    return name ? `"${name}"` : `morse.im/${address}`;
  };
  const restartLine = (address: string) => `your address ${shownAs(address)} is not online in this daemon yet — restart it: morse stop --restart`;
  /** The v3 connection is not there (yet): wait. */
  const noV3 = (to: string, _label: string = to): MorseSendResult => ({ ok: false, waiting: true, error: `relay ${opts.url} not connected — ${to} will get it when the relay is back` });
  /**
   * (ADR-081 review: legacy rows) From when every outbound row records its sending address: the moment a
   * daemon of this release first ran on this database (written now if this is it). Before this release
   * no address but the first could send, and until this moment the daemon of the release before may
   * have been queuing — so an outbound row WITHOUT a recorded address that is older than this goes out
   * from the first address by the paths from before, exactly as it would have. A newer one cannot exist.
   */
  const sendersRecordedSince: number = (() => {
    try {
      return opts.mailbox.sendersRecordedSince(true);
    } catch {
      return 0; // cannot tell: nothing counts as "from before" (fail closed)
    }
  })();
  const fromBefore = (message: Pick<Message, 'myAddress' | 'fromFirstAddress'> & { createdAt?: number }): boolean =>
    !message.myAddress && !message.fromFirstAddress && typeof message.createdAt === 'number' && message.createdAt < sendersRecordedSince;
  const nameGoneLine = (name: string) => `this message was queued from your address "${name}", which is no longer here under that name — send it again (morse send --from <name>; morse address lists them)`;
  /**
   * The address of OURS a local name (`morse address`) or an address stands for — for mail that is being
   * QUEUED (`morse send --from`), so that its row records the address: a name an address of this daemon
   * has; this computer's own agent name → its first address; a name on disk the daemon has not loaded
   * yet (added while it ran — `senderOf` then says "restart"). An address is returned as it is: whether
   * this daemon holds it is `senderOf`'s to say. null = no address of this computer has that name.
   */
  const ownAddressNamed = (from: string): { address: string } | { error: string } | null => {
    const asAddress = normalizeAddress(from);
    if (asAddress) return { address: asAddress };
    const name = from.trim().toLowerCase();
    const h = [...hosted.values()].find((x) => x.agent === name);
    if (h) return { address: h.key.address };
    const first = addrKey?.address ?? firstAddress;
    if (name && name === selfAgent() && first) return { address: first };
    try {
      const known = agentAddressIndex(home)[name];
      return known ? { address: known } : null;
    } catch (e) {
      return { error: `this message was queued from your address "${name}", but which address that is cannot be read (${e instanceof Error ? e.message : String(e)}) — not sent` };
    }
  };
  const senderOf = (message: Pick<Message, 'myAddress' | 'myAgent' | 'fromFirstAddress'> & { createdAt?: number }, to: string): Sender => {
    const first = addrKey?.address ?? firstAddress;
    const recorded = message.myAddress;
    if (recorded) {
      if (recorded === first) return { ok: true, address: recorded, explicit: false };
      if (signerFor(recorded)) return { ok: true, address: recorded, explicit: true };
      if (opts.v3 === false) return { ok: false, error: { ok: false, error: goneLine(recorded) } };
      // no address of ours is online yet (the relay is not there): it cannot be judged — nothing goes out meanwhile
      if (!addrKey) return { ok: false, error: noV3(to) };
      // on disk, added while this daemon ran: it signs after a restart; anything else is gone (or unreadable)
      try {
        const here = Object.values(agentAddressIndex(home)).includes(recorded);
        // (ADR-088) said by the name `morse address` shows — the address itself when it has none
        if (here && !hostedBroken) return { ok: false, error: { ok: false, waiting: true, error: restartLine(recorded) } };
      } catch {
        /* an unreadable index: the address cannot be loaded — refused below */
      }
      return { ok: false, error: { ok: false, error: goneLine(recorded) } };
    }
    // queued without naming an address of ours: the first address (the name in the row is display only)
    if (message.fromFirstAddress) return { ok: true, address: first, explicit: false };
    // (ADR-081 review: legacy rows) no address recorded, queued before this release's daemon first ran here: the
    // release before wrote it, and that one only ever sent from the first address — whatever the name
    // in the row is, renamed since or never registered. The paths from before, unchanged.
    if (fromBefore(message)) return { ok: true, address: first, explicit: false };
    // no address recorded on a row of THIS release: no writer leaves one out — it is not guessed (fail closed)
    const name = message.myAgent ?? '';
    try {
      agentAddressIndex(home);
    } catch (e) {
      return { ok: false, error: { ok: false, error: `this message was queued from your address "${name}", but which address that is cannot be read (${e instanceof Error ? e.message : String(e)}) — not sent` } };
    }
    return { ok: false, error: { ok: false, error: nameGoneLine(name) } };
  };

  type NativeRoute = { address: string; self: string; holdName: string; label: string } | { error: MorseSendResult };
  /**
   * Does this message go by address alone, and from which address of ours (`self`)? null = no: the paths
   * that existed before (the v2 directory, a paired device), untouched — only ever for mail from this
   * computer's first address.
   *
   *   - `to` is a bare address: yes — unless it is the address of a device paired here (ADR-077: the
   *     device path; a contact without an old name such as a computer of yours paired by ID) that never
   *     wrote to us by address, and the message is not explicitly from another address of ours;
   *   - the message is from an address of ours other than the first: yes, to the address of the contact
   *     it is for — such mail can only go by address (it has no certificate to show and must not carry
   *     the handle).
   */
  const nativeRoute = (to: string, message: Pick<Message, 'contactId'>, sender: Extract<Sender, { ok: true }>): NativeRoute | null => {
    const explicit = sender.explicit;
    if (!nativeOn) {
      // (ADR-081 review F1) mail from another address never takes the old path instead
      return explicit ? { error: { ok: false, error: `${to}: mail from your address morse.im/${sender.address} can only go by address, which this Morse does not do — not sent` } } : null;
    }
    const asAddress = normalizeAddress(to);
    // (ADR-091) a contact whose address is known goes by it — whatever it was called before, paired the old way or not;
    // only a contact by old name whose address nobody knows (or a session, or yourself) is left to the paths of before
    let byContact: Contact | null = null;
    if (!asAddress) {
      try {
        byContact = (message.contactId ? opts.mailbox.contacts.get(message.contactId) : null) ?? opts.mailbox.contacts.find(stripAddressHost(to));
      } catch {
        /* no contact: below */
      }
      // (a contact still by old name — `handle` set — is one whose address the migration could not tell: its `address`, if
      // any, is one computer's of that name, not "the contact". The old name's own paths reach it; the next open of the
      // mailbox makes it a contact by address once it is known, src/mailbox/migrate-v5.ts convertKnownHandles.)
      const usable = Boolean(byContact?.address && !byContact.handle && byContact.id !== SELF_CONTACT && !isOwnAddress(byContact.address));
      if (!usable && !explicit) return null;
    }
    // no address of ours is online: the relay is not there yet
    if (!addrKey) return { error: noV3(to, asAddress ?? to) };
    const self = sender.address ?? addrKey.address;
    if (!signerFor(self)) return { error: { ok: false, error: goneLine(self) } };
    if (asAddress) {
      if (isOwnAddress(asAddress)) return { error: { ok: false, error: `${asAddress} is one of your addresses here — to write to a session here use a session target (@<agent>:<session>)` } };
      return { address: asAddress, self, holdName: asAddress, label: `morse.im/${asAddress}` };
    }
    const contact = byContact;
    if (!contact?.address || contact.id === SELF_CONTACT || isOwnAddress(contact.address)) {
      return { error: { ok: false, error: `${to}: mail from your address ${shownAs(self)} can only go by address, and no address is known for this contact yet — send from your first address, or ask them for their address (morse address)` } };
    }
    return { address: contact.address, self, holdName: handleOf(to).toLowerCase(), label: `morse.im/${contact.address}` };
  };

  /** Keep the address a message goes out from with its row (once; a row that has one keeps it). */
  const recordSender = (message: Pick<Message, 'id' | 'myAddress'>, address: string): void => {
    if (message.myAddress) return;
    try {
      opts.mailbox.setMyAddress(message.id, address);
    } catch {
      /* bookkeeping: the next try records it */
    }
  };

  /** The v3 connection is up and the address can be reached by address alone (§2: the two one-line refusals). */
  const reachNative = async (address: string, /** the address of OURS that writes (ADR-083 review R1: its own lookup) */ self: string): Promise<{ ok: true } | { ok: false; waiting?: boolean; error: string }> => {
    // (ADR-091) the v3 connection is the one that counts — a v2 login is not needed for anything by address. What was
    // looked up a moment ago needs no relay at all: a LAN or a direct link may carry it while the relay is away.
    let look = await lookupNative(self, address, true);
    if (!look.ok && look.waiting && !v3client?.connected() && (await v3client?.waitConnected(connectWait))) look = await lookupNative(self, address, true);
    return look.ok ? { ok: true } : look;
  };

  /**
   * Find the ONE device for `to` (ADR-033). A device ID, or a paired device name with a
   * concrete session (a reply to a device paired by ID), goes straight to that device;
   * a person goes through the relay's agent directory — `handle/agent`, or the
   * message's agent, or (none) the person's default agent.
   */
  const target = async (to: string, message: Message): Promise<Target | MorseSendResult> => {
    // (ADR-081 review F1) first: WHICH address of ours this is from — an address this daemon does not hold sends nothing
    const sender = senderOf(message, to);
    if (!sender.ok) return sender.error;
    // ADR-081: by address alone — a bare address nobody is paired under, or mail from an address of ours other than the first
    const route = nativeRoute(to, message, sender);
    if (route) {
      if ('error' in route) return route.error;
      // the address it goes out from is recorded with the row before anything leaves: from here on a rename changes nothing
      recordSender(message, route.self);
      if (addressBlocked(route.address, contactOfAddress(route.address, route.self), route.self)) return { ok: false, error: `${route.label} is blocked here — nothing is sent to it (to undo: morse contact unblock ${route.address})` };
      const reach = await reachNative(route.address, route.self);
      if (!reach.ok) return reach;
      // (what their side sees as `to` names no agent of theirs: an address IS its agent)
      return { kind: 'device', device: nativePeer(route.address, route.self, route.holdName), label: route.label, to: { agent: message.to.agent, sessionId: '' } };
    }
    // the paths from before (a paired device, the v2 directory): this computer's first address, and only it
    if (sender.explicit) return { ok: false, error: `${to}: mail from your address morse.im/${sender.address ?? ''} can only go by address — not sent` };
    // (ADR-091) a computer without an old name has no v2 side: an old name it does not know an address for reaches nobody
    if (!v2On) return { ok: false, terminal: true, error: OLD_NAMES_LINE(to) };
    // (a row from before this release: from now on it says itself that it goes from the first address)
    if (!message.fromFirstAddress && sender.address && sender.address === (addrKey?.address ?? firstAddress)) recordSender(message, sender.address);
    const named = namedTarget(to, message);
    if (named) return named;
    const { handle, wanted } = wantedAgent(to, message)!;
    // (ADR-081 review F3) an address has no directory entry and no agents under it: never asked for as an old name
    if (addressShapedHandle(handle)) return { ok: false, error: `"${to}": ${handle} is an address, not an old name — write to morse.im/${handle}` };
    let loc: AgentLocation | null;
    try {
      loc = await client.resolveAgent(handle, wanted);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/bad agent name|bad handle/.test(msg)) return { ok: false, error: `"${to}": ${msg}` };
      return { ok: false, waiting: true, error: `cannot look up morse.im/${handle}${wanted ? `/${wanted}` : ''} right now (${msg}) — will retry` };
    }
    if (!loc) {
      lastSeen.delete(`${handle}/${wanted ?? ''}`);
      return { ok: false, error: wanted ? `no agent morse.im/${handle}/${wanted} on the relay` : `morse.im/${handle} has no agent on the relay (nobody called ${handle}, or they have not joined yet)` };
    }
    lastSeen.set(`${handle}/${wanted ?? ''}`, { deviceId: loc.device.id, agent: loc.agent });
    const label = `morse.im/${handle}/${loc.agent}`;
    if (loc.device.id === identity.id) return { kind: 'self', label, to: theirTo(message, loc.agent) };

    const me = client.handle();
    let device = trust.get(loc.device.id);
    if (!device) {
      // first contact with this person (or a device of theirs we have not met): pair them
      // by handle — every device of theirs; tier peer, or owner for our own handle (ADR-034)
      const p = await pairHandle(handle);
      if (!p.ok && p.waiting) return { ok: false, waiting: true, error: `${p.error} — will look up ${label} when the relay is back` };
      if (p.ok) log(`relay: paired morse.im/${handle} on first send (${p.devices.length} device(s), tier ${tierForHandle(handle, me)})`);
      device = trust.get(loc.device.id) ?? trustHandleDevices(handle, [loc.device], { trust, home, selfId: identity.id, selfHandle: me, keep: lowered })[0];
      if (!device) return { ok: false, error: `could not pair ${label}` };
    } else if (device.tier === 'peer' && tierForHandle(handle, me) === 'owner' && !isBlocked(handle, home) && !lowered(device.id)) {
      // the directory just placed this device under OUR handle: one of our own (ADR-034)
      device = trust.add({ id: device.id, name: device.name, tier: 'owner' });
      log(`relay: @${device.name} (${device.id.slice(0, 7)}) is under your own handle — upgraded from peer to owner`);
    }
    return { kind: 'device', device, label, to: theirTo(message, loc.agent) };
  };

  /** Our own agent (morse.im/<me>/<one of mine>): file it here, no relay round trip. */
  const deliverToSelf = async (t: Extract<Target, { kind: 'self' }>, message: Message): Promise<MorseSendResult> => {
    const to = await localSession(t.to, 'owner');
    const me = client.handle();
    const agent = selfAgent();
    const files = message.parts.flatMap((p) => p.files ?? []);
    opts.mailbox.send({
      from: { agent: message.from.agent, sessionId: message.from.sessionId, ...(me ? { device: agent ? `${me}/${agent}` : me } : {}) },
      to,
      text: message.parts.map((p) => p.text).join('\n'),
      via: 'morse-self',
      fromTier: 'owner',
      ...(message.contextId ? { contextId: message.contextId } : {}),
      ...(files.length ? { files } : {}),
    });
    opts.mailbox.markReceipt(message.id);
    log(`relay: ${message.id.slice(0, 8)} is for ${t.label} — here; filed locally → @${to.agent}:${to.sessionId.slice(0, 8)}`);
    opts.onChange?.();
    return { ok: true, via: 'self' };
  };

  /** The plaintext both paths carry (the relay path seals it, the LAN path relies on mutual TLS).
   *  With `chunked` (ADR-038) it carries the files' manifest instead of their bytes. */
  const plainFor = (message: Message, to: { agent: string; sessionId: string }, chunked?: ChunkedManifest, device?: Peer): Extract<Plain, { kind: 'message' }> => {
    // ADR-048: session ids are not load-bearing between people — only our own devices
    // (tier owner) get them; another person's side addresses replies to contact + agent
    const own = device?.tier === 'owner';
    const files: WireFile[] = [];
    for (const part of chunked ? [] : message.parts) {
      for (const f of part.files ?? []) {
        const data = readFileSync(f.path);
        files.push({ name: f.name, data: data.toString('base64'), sha256: sha256(data) });
      }
    }
    // ADR-081 §2: by address — no handle, no agent name (the address that signs it is the sender), and
    // `addr: 1`: answer to that address
    const native = Boolean(device && isNative(device));
    const me = native ? null : client.handle();
    const agent = selfAgent();
    return {
      kind: 'message',
      id: message.id,
      contextId: message.contextId,
      from: { agent: message.from.agent, sessionId: own ? message.from.sessionId : '' },
      to: own ? to : { agent: to.agent, sessionId: '' },
      ...(native ? { addr: 1 as const } : {}),
      ...(me ? { fromHandle: me } : {}),
      ...(me && agent ? { fromAgent: agent } : {}),
      text: message.parts.map((p) => p.text).join('\n'),
      ...(files.length ? { files } : {}),
      ...(chunked ? { chunked } : {}),
    };
  };

  // --- large files, sender side (ADR-038) -------------------------------------------------

  interface Outbound {
    tr: OutboundTransfer;
    device: Peer;
    plain: MessagePlain;
    /** set while the background run is going */
    running: Promise<void> | null;
    /** the first answer to an offer (manifest) is handed here instead of to the transfer */
    offerWaiter: ((a: TransferAnswer | null) => void) | null;
    /** (ADR-081 review F4) the last "not kept" said their message requests are full */
    full?: boolean;
  }
  const outbound = new Map<string, Outbound>();

  const deliverAnswer = (o: Outbound, a: TransferAnswer) => {
    if (o.offerWaiter) o.offerWaiter(a);
    else o.tr.answer(a);
  };

  /** Chunked or inline? Inline when everything fits one envelope (what older versions did). */
  const chunkPlan = (message: Message): { manifest: ChunkedManifest; paths: string[] } | null => {
    const files = message.parts.flatMap((p) => p.files ?? []);
    if (!files.length) return null;
    const maxBlob = relayLimits().maxBlobBytes;
    const textBytes = Buffer.byteLength(message.parts.map((p) => p.text).join('\n'));
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total + textBytes + 4096 <= maxAttachmentBytes(maxBlob)) return null;
    const manifest = manifestFor(
      files.map((f) => ({ name: safeFileName(f.name), size: f.size, sha256: f.sha256 })),
      chunkSizeFor(maxBlob, opts.chunkBytes ?? DEFAULT_CHUNK_BYTES),
    );
    return { manifest, paths: files.map((f) => f.path) };
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const rateBackoff = opts.rateBackoffMs ?? 2000;
  /** All chunk envelopes of this device share one bucket under the relay's per-device rate. */
  const throttle = new Throttle(() => opts.chunkRatePerMinute ?? chunkRateFor(relayLimits().ratePerMinute));

  /** client.send for transfers: waits out "rate limited"; offline / not connected → TransferStop. */
  const relaySend = async (to: string, blob: Sealed, label: string): Promise<'lan' | 'direct' | 'relay'> => {
    for (let i = 0; ; i++) {
      let r: 'sent' | 'offline' | 'stored';
      let via: 'lan' | 'direct' | 'relay';
      try {
        // ADR-069: a direct link when one opens; ADR-073: file data never waits in the relay's mailbox
        ({ r, via } = await sendBlob(to, blob, true, { store: false }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/rate limited/.test(msg) && i < 60) {
          await sleep(rateBackoff);
          continue;
        }
        if (/too large/.test(msg)) throw new TransferStop('fatal', `relay send to ${label}: ${msg}`);
        throw new TransferStop('offline', `${label}: ${msg}`);
      }
      if (r === 'offline') throw new TransferStop('offline', `${label} is offline`);
      return via;
    }
  };

  const relayIO = (o: Outbound): TransferIO => ({
    offer: async () => {
      const answer = new Promise<TransferAnswer | null>((resolve) => {
        const t = setTimeout(() => {
          o.offerWaiter = null;
          resolve(null);
        }, receiptTimeout);
        o.offerWaiter = (a) => {
          clearTimeout(t);
          o.offerWaiter = null;
          resolve(a);
        };
      });
      try {
        o.tr.via = await relaySend(o.device.id, await sealFor(isNative(o.device) ? o.device : o.device.id, o.plain), o.tr.label);
      } catch (e) {
        o.offerWaiter?.(null);
        if (e instanceof TransferStop) throw e;
        throw new TransferStop('fatal', `relay send to ${o.tr.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return answer;
    },
    send: async (h, data) => {
      let blob: Sealed;
      try {
        blob = await sealBytes(isNative(o.device) ? o.device : o.device.id, encodeChunk(h, data));
      } catch (e) {
        throw new TransferStop('fatal', `${o.tr.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
      o.tr.via = await relaySend(o.device.id, blob, o.tr.label);
    },
    throttle: () => throttle.take(),
  });

  /** A LAN answer (HTTP status + body) → what it means for the transfer; unreachable → TransferStop('link'). */
  const fromLan = (r: Awaited<ReturnType<LanMorseLink['deliver']>>, label: string): TransferAnswer => {
    const b = (r.body ?? {}) as { chunked?: unknown; transfer?: { have?: unknown; reset?: unknown }; busy?: unknown; error?: unknown; unknown?: unknown };
    if (r.ok) {
      if (r.request) return { request: r.request };
      if (b.chunked === true) return { complete: true };
      if (b.transfer && Array.isArray(b.transfer.have)) return { have: b.transfer.have as HaveRanges, ...(b.transfer.reset ? { reset: true } : {}) };
      return { legacy: true };
    }
    if (r.status === 503 && b.busy) return { busy: true };
    if (r.status === 409 && b.unknown) return { unknown: true };
    if (r.status === 413 && typeof b.error === 'string') return { error: b.error };
    throw new TransferStop('link', `${label} over the LAN: ${r.error ?? 'failed'}`);
  };

  /** Devices whose LAN side has no sealed route (an older Morse): plain for an hour. */
  const lanPlainOnly = new Map<string, number>();
  /**
   * ADR-073: hand something to a device on the LAN — sealed as a v3 envelope when that device
   * is on v3 (`bytes` = what the relay path would seal), else (or when it answers 404 / cannot
   * open it) the plain payload as before. `fromHandle` lets an unpaired recipient admit us.
   */
  const lanDeliver = async (deviceId: string, bytes: Buffer, plainPayload: unknown, timeoutMs?: number) => {
    const lan = opts.lan!;
    const t = timeoutMs ? { timeoutMs } : {};
    if (Date.now() - (lanPlainOnly.get(deviceId) ?? 0) > 3600_000) {
      try {
        const sealed = await sealBytes(deviceId, bytes);
        if (sealed.v3) {
          const fromHandle = (plainPayload as { fromHandle?: unknown } | null)?.fromHandle;
          const r = await lan.deliver(deviceId, { sealedV3: JSON.parse(sealed.blob) as unknown, ...(typeof fromHandle === 'string' ? { fromHandle } : {}) }, { ...t, sealed: true });
          if (r.status === 404 || r.status === 503 || (r.status === 409 && (r.body as { rekey?: unknown } | null)?.rekey)) {
            if (r.status === 404) lanPlainOnly.set(deviceId, Date.now());
            if (r.status === 409) v3Peers.delete(deviceId);
          } else return r;
        }
      } catch {
        /* sealing failed (e.g. relay lookups down): the plain payload below */
      }
    }
    return lan.deliver(deviceId, plainPayload, t);
  };

  const lanIO = (o: Outbound): TransferIO => ({
    offer: async () => {
      const r = await lanDeliver(o.device.id, Buffer.from(JSON.stringify(o.plain)), o.plain, 30_000);
      o.full = (r.body as { full?: unknown } | null | undefined)?.full === true;
      return fromLan(r, o.tr.label);
    },
    send: async (h, data) => fromLan(await lanDeliver(o.device.id, encodeChunk(h, data), { ...h, data: data.toString('base64') }, 120_000), o.tr.label),
    throttle: async () => undefined,
  });

  /** Run a transfer in the background: LAN when the device is there, else the relay; then settle the outbox. */
  const drive = async (o: Outbound): Promise<void> => {
    const tr = o.tr;
    const id8 = tr.msgId.slice(0, 8);
    for (let attempt = 0; attempt < 2; attempt++) {
      const lanUp = Boolean(opts.lan?.reachable(tr.deviceId)) && !tr.lanFailed;
      if (!lanUp && !relayUp()) {
        tr.state = 'waiting';
        tr.error = `relay ${opts.url} not connected — will try again`;
        break;
      }
      tr.via = lanUp ? 'lan' : 'relay';
      const m = tr.manifest;
      log(`morse: ${id8} → ${tr.label}: sending ${m.files.length} file(s), ${formatBytes(totalBytes(m))} in ${tr.total} chunks of ${formatBytes(m.chunkSize)} via ${tr.via}`);
      const r = await tr.run(lanUp ? lanIO(o) : relayIO(o), opts.transferTuning);
      if (r === 'link' && lanUp) {
        tr.lanFailed = true;
        log(`morse: ${id8} → ${tr.label}: ${tr.error ?? 'lan failed'} — continuing through the relay`);
        continue;
      }
      break;
    }
    const secs = ((Date.now() - tr.startedAt) / 1000).toFixed(1);
    switch (tr.state) {
      case 'done':
        opts.mailbox.markReceipt(tr.msgId);
        settleAccepted(o.device, 'the other side confirmed a message to its inbox');
        log(`morse: ${id8} → ${tr.label} delivered via ${tr.via} — ${tr.total}/${tr.total} chunks, ${formatBytes(totalBytes(tr.manifest))}, SHA-256 checked by the recipient (${secs} s, ${tr.sent} chunk envelope(s) sent)`);
        break;
      case 'request':
        opts.mailbox.markReceipt(tr.msgId);
        opts.mailbox.markRequest(tr.msgId);
        awaitAccept(o.device);
        log(`morse: ${id8} → ${tr.label} is in their message requests (request pending, via ${tr.via}) — no files sent; they go once they accept you`);
        break;
      case 'held':
        awaitAccept(o.device, Boolean(o.full));
        break;
      default:
        log(`morse: ${id8} → ${tr.label}: ${tr.error ?? tr.state} (${tr.acked()}/${tr.total} chunks confirmed)`);
    }
    // settled (delivered / request / held / failed): the outbox picks it up right away;
    // waiting (recipient away): the outbox's normal retry interval runs it again
    if (tr.state !== 'waiting') opts.mailbox.nudge(tr.msgId);
    opts.onChange?.();
  };

  const progressNote = (tr: OutboundTransfer): string =>
    `${tr.manifest.files.length} file(s), ${formatBytes(totalBytes(tr.manifest))}: ${tr.acked()}/${tr.total} chunks confirmed`;

  /** The outbox's view of a chunked message: start (or resume) its transfer, report how far it is. */
  const sendChunked = (t: Extract<Target, { kind: 'device' }>, message: Message, plan: { manifest: ChunkedManifest; paths: string[] }): MorseSendResult => {
    let o = outbound.get(message.id);
    if (o && !o.running && (o.device.id !== t.device.id || o.device.self !== t.device.self)) o = undefined; // the agent moved (or it goes from another address of ours): start over there
    if (o?.running) return { ok: false, waiting: true, error: `sending to ${o.tr.label} via ${o.tr.via ?? '…'} — ${progressNote(o.tr)}` };
    if (o) {
      if (o.tr.state === 'done') return { ok: true, ...(o.tr.via ? { via: o.tr.via } : {}) };
      if (o.tr.state === 'request') return { ok: true, ...(o.tr.via ? { via: o.tr.via } : {}), request: true };
      if (o.tr.state === 'failed') return { ok: false, error: o.tr.error ?? 'transfer failed' };
      // waiting, or held until they accepted us (holdFor above let it through): go again
    }
    // forget transfers nobody asked about for a day (dead / deleted messages)
    for (const [id, x] of outbound) if (!x.running && Date.now() - x.tr.updatedAt > 24 * 3600_000) outbound.delete(id);
    const tr = o?.tr ?? new OutboundTransfer({ msgId: message.id, deviceId: t.device.id, label: t.label, manifest: plan.manifest, paths: plan.paths });
    const entry: Outbound = { tr, device: t.device, plain: plainFor(message, t.to, plan.manifest, t.device), running: null, offerWaiter: null };
    outbound.set(message.id, entry);
    entry.running = drive(entry)
      .catch((e: unknown) => {
        tr.state = 'waiting';
        tr.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        entry.running = null;
      });
    return { ok: false, waiting: true, error: `sending to ${tr.label} — ${progressNote(tr)}` };
  };

  /**
   * ADR-069: hand the sealed envelope to the device over a direct WebRTC link (opening
   * one takes ≤ 3 s) and watch for its receipt. The receipt → done. The link drops, or
   * no receipt within `directReceiptMs` → drop the link and return null: the caller sends
   * the same envelope through the relay (the recipient dedupes by sender + message id).
   */
  const viaDirect = async (t: Extract<Target, { kind: 'device' }>, message: Message, blob: string, receipt: Promise<ReceiptSeen | null>): Promise<ReceiptSeen | null> => {
    // (ADR-091) a link is between this computer's FIRST address and a contact's address — the device way only without v3
    const linkId = directByAddress ? (isNative(t.device) && t.device.self === addrKey?.address ? t.device.id : null) : isNative(t.device) ? null : t.device.id;
    if (!direct || !linkId || !(await direct.send(linkId, blob, true))) return null;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      receipt.then((g) => g ?? ('slow' as const)),
      direct.whenDown(linkId).then(() => 'down' as const),
      new Promise<'slow'>((resolve) => {
        timer = setTimeout(() => resolve('slow'), directReceiptMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (typeof outcome === 'object') return outcome;
    const why = outcome === 'down' ? 'the link dropped before the receipt' : `no receipt within ${(directReceiptMs / 1000).toFixed(1)} s`;
    direct.drop(linkId, why, outcome === 'slow' ? 60_000 : undefined);
    log(`morse: ${message.id.slice(0, 8)} → ${t.label} direct failed (${why}) — falling back to relay`);
    return null;
  };

  /**
   * (ADR-091) The LAN by address: the other side's address is seen on the LAN → hand it the sealed envelope there and
   * watch for its receipt (which comes back as an envelope, over the LAN or the relay). No receipt within
   * `lanReceiptMs` → null: the same envelope goes on to a direct link or the relay (the recipient dedupes), and this
   * address is left to the relay for a while.
   */
  const lanReceiptMs = opts.lanReceiptMs ?? Math.min(receiptTimeout / 2, 5000);
  const viaLanAddress = async (t: Extract<Target, { kind: 'device' }>, message: Message, sealed: Sealed, receipt: Promise<ReceiptSeen | null>): Promise<ReceiptSeen | null> => {
    const lan = opts.lanAddress;
    const address = sealed.v3?.address;
    // (follow-up) only from this computer's FIRST address — the one announced there: a second address on the LAN
    // would tie it to this computer (ADR-083)
    const from = sealed.v3?.from;
    if (!lan || !address || !isNative(t.device) || (from && from !== addrKey?.address) || lanFailing(address) || !lan.reachable(address)) return null;
    if (!(await lan.send(address, sealed.blob))) {
      lanFailed.set(address, Date.now());
      log(`morse: ${message.id.slice(0, 8)} → ${t.label} lan failed (not taken) — falling back`);
      return null;
    }
    let timer: NodeJS.Timeout | undefined;
    const got = await Promise.race([
      receipt,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), lanReceiptMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (got) return got;
    lanFailed.set(address, Date.now());
    if (lanFailed.size > 1000) lanFailed.clear();
    log(`morse: ${message.id.slice(0, 8)} → ${t.label} lan: no receipt within ${(lanReceiptMs / 1000).toFixed(1)} s — falling back`);
    return null;
  };

  /**
   * LAN first (ADR-034): the device is paired and discovered on the LAN → hand it the
   * message over mutual TLS (end-to-end identity: both certificates pinned). Its
   * answer is the receipt. null = not on the LAN, or it failed → use the relay.
   */
  const viaLan = async (t: Extract<Target, { kind: 'device' }>, message: Message, plain: Extract<Plain, { kind: 'message' }>): Promise<MorseSendResult | null> => {
    if (isNative(t.device) || !opts.lan?.reachable(t.device.id)) return null; // (ADR-081: by address = through the relay)
    const r = await lanDeliver(t.device.id, Buffer.from(JSON.stringify(plain)), plain);
    if (r.ok && r.request === 'dropped') {
      awaitAccept(t.device, (r.body as { full?: unknown } | null | undefined)?.full === true);
      return heldResult(t.device);
    }
    if (r.ok) {
      opts.mailbox.markReceipt(message.id);
      if (r.request === 'filed') {
        opts.mailbox.markRequest(message.id);
        awaitAccept(t.device);
        log(`morse: ${message.id.slice(0, 8)} → ${t.label} is in their message requests (request pending, via lan) — they have not accepted you yet; later messages wait here until they do`);
        opts.onChange?.();
        return { ok: true, via: 'lan', request: true };
      }
      settleAccepted(t.device, 'the other side took a message into its inbox');
      lanFailures.forget(`${t.device.id}\0`);
      log(`morse: ${message.id.slice(0, 8)} → ${t.label} delivered via lan (direct mutual TLS, ${t.device.tier})`);
      opts.onChange?.();
      return { ok: true, via: 'lan' };
    }
    if (r.notPaired) {
      // their device does not take a direct message from us right now (older version,
      // relay unreachable on their side, strangers blocked): nothing is wrong — the
      // relay carries this one
      log(`morse: ${message.id.slice(0, 8)} → first contact with ${t.label} goes through the relay`);
      return null;
    }
    // ADR-046: the same failure to the same device is logged at growing intervals
    const line = lanFailures.pass(`${t.device.id}\0${r.error ?? ''}`, `morse: ${message.id.slice(0, 8)} → ${t.label} lan failed (${r.error ?? 'unknown error'}) — falling back to relay`);
    if (line) log(line);
    return null;
  };

  return {
    client,
    knows: (to) => devicesFor(trust, to).length > 0 || Boolean(normalizeAddress(to) && trust.list().some((d) => pinnedAddress(d.id) === normalizeAddress(to))),
    pairHandle: (handle) => pairHandle(handle),
    status: () => ({
      url: client.url ?? opts.url,
      connected: relayUp(),
      handle: client.handle(),
      agent: selfAgent(),
      limits: client.limits(),
      ...(client.state ? { state: client.state() } : {}),
      ...(direct ? { direct: direct.status() } : {}),
      ...(v3client && addrKey ? { v3: { connected: v3client.connected(), address: addrKey.address } } : {}),
    }),
    receive: async (d) => {
      await receive(d);
    },
    lanCheck: async (blob) => {
      try {
        const env = JSON.parse(blob) as unknown;
        if (!isEnvelopeV3(env) || !addrKey || !prekeys) return { ok: false };
        const other = hosted.get(env.to);
        if (!other && env.to !== addrKey.address) return { ok: false };
        const o = await openV3(env, other ? { address: other.key.address, keys: other.prekeys.keys } : { address: addrKey.address, keys: prekeys.keys });
        if (isOwnAddress(o.from)) return { ok: false };
        return { ok: true, from: o.from, known: Boolean(contactOfAddress(o.from, other ? other.key.address : addrKey.address)) };
      } catch {
        return { ok: false };
      }
    },
    lanSign: (address, message) => (addrKey && address === addrKey.address ? { publicKey: addrKey.publicKey, sig: signAs(addrKey, message) } : null),
    v3Client: () => v3client,
    reloadAddresses: () => {
      if (!v3client || !addrKey) return { added: [], removed: [] }; // (not connected by address yet: `startV3` reads them all when it is)
      const before = new Set(hosted.keys());
      let now: Set<string>;
      try {
        now = new Set(ensureAgentAddresses(home, identity).filter((a) => !a.primary && a.key.address !== addrKey!.address).map((a) => a.key.address));
      } catch (e) {
        log(`morse: the addresses here changed, and cannot be read: ${e instanceof Error ? e.message : String(e)} — nothing was changed in this daemon`);
        return { added: [], removed: [] };
      }
      const added = [...now].filter((a) => !before.has(a));
      const removed = [...before].filter((a) => !now.has(a));
      if (!added.length && !removed.length) return { added, removed };
      // the connection by address logs in a fixed set of addresses: it is opened again with the new set (what was
      // on its way is sent again by the outbox, as after any reconnect)
      v3client.close();
      v3client = null;
      rotation?.stop();
      rotation = null;
      if (rotateTimer) clearInterval(rotateTimer);
      rotateTimer = null;
      hosted.clear();
      hostedBroken = null;
      startV3();
      log(`morse: addresses reloaded —${added.length ? ` online now: ${added.map((a) => a.slice(0, 7)).join(', ')}` : ''}${removed.length ? ` no longer logged in: ${removed.map((a) => a.slice(0, 7)).join(', ')}` : ''}`);
      return { added, removed };
    },
    address: () => addrKey?.address ?? null,
    addresses: () => (addrKey ? [{ address: addrKey.address, agent: selfAgent() }, ...[...hosted.values()].map((h) => ({ address: h.key.address, agent: h.agent }))] : []),
    migrateContacts,
    ownAddress: (from) => {
      const own = ownAddressNamed(from);
      if (!own || 'error' in own) return null;
      return { address: own.address, name: nameOfAddress(own.address) || Object.entries(safeIndex()).find(([, a]) => a === own.address)?.[0] || null };
    },
    addressRoute: async (to, from) => {
      const refusal = (e: MorseSendResult) => ({ ok: false as const, ...(e.waiting ? { waiting: true } : {}), error: e.error ?? `cannot send to ${to}` });
      // (ADR-081 review: legacy rows) a name is resolved to its ADDRESS here, when the message is queued — never later
      const own = from ? ownAddressNamed(from) : null;
      if (from && !own) return refusal({ ok: false, error: nameGoneLine(from.trim().toLowerCase()) });
      if (own && 'error' in own) return refusal({ ok: false, error: own.error });
      const sender = senderOf(own ? { myAddress: own.address } : { fromFirstAddress: true }, to);
      if (!sender.ok) return refusal(sender.error);
      const route = nativeRoute(to, {}, sender);
      if (!route) return null;
      if ('error' in route) return refusal(route.error);
      const reach = await reachNative(route.address, route.self);
      return reach.ok ? { ok: true, address: route.address, from: route.self } : reach;
    },
    acceptAddress: (raw, from) => {
      const address = normalizeAddress(raw);
      if (!address || !nativeOn) return null;
      try {
        // writing to an address yourself accepts it (ADR-037): unblocked, its waiting request moves in, a contact
        // (ADR-083) — of the address of mine that writes, and of no other
        const my = from ? mineKey(normalizeAddress(from) ?? '') : '';
        opts.mailbox.contacts.unblockAt(address, my);
        if (opts.mailbox.requests.get(address, my)) acceptPending(address, 'you wrote to them', my);
        const c = opts.mailbox.contacts.ensureAddress(address, my);
        if (!my && c.handle && c.origin !== OWN_DEVICE) unblockHandle(c.handle, home);
        if (c.state === 'blocked') opts.mailbox.contacts.set(c.id, { state: 'active' });
        return c.id;
      } catch (e) {
        log(`morse: could not make morse.im/${address} a contact: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    receiveDirect,
    admitDirect,
    syncOwnDevices,
    notifyAccepted,
    transfer: (id) => outbound.get(id)?.tr.progress(),
    transfers: () => [...outbound.values()].map((o) => o.tr.progress()),
    incoming: () => incoming.list(),
    prekeySlots: () => rotation?.next() ?? [],
    expireReceiptWait: (id) => {
      const expire = receiptExpiry.get(id);
      if (!expire) return false;
      expire();
      return true;
    },
    ready: () => direct?.ready() ?? Promise.resolve(),
    async send(to, message) {
      // a late receipt already confirmed an earlier attempt
      if (message.receiptAt) {
        const o = outbound.get(message.id);
        if (o && !o.running) outbound.delete(message.id); // a finished chunked transfer: forget it
        return { ok: true, ...(o?.tr.via ? { via: o.tr.via } : {}), ...(message.request ? { request: true } : {}) };
      }

      // (ADR-081 review F1) from an address of ours this daemon cannot sign as: nothing goes out, by any path
      const sender = senderOf(message, to);
      if (!sender.ok && !sender.error.waiting) return sender.error;
      // (ADR-091) by address: the v3 connection, the LAN and direct links — the v2 login is not waited for
      const byAddress = sender.ok && Boolean(nativeRoute(to, message, sender));

      if (!byAddress && v2On && !client.connected()) {
        // the LAN needs no relay: a device we can name, or where this address resolved last time
        // (only for mail from this computer's first address: the LAN and direct links are between devices)
        const cached = (opts.lan || direct) && sender.ok && !sender.explicit ? cachedTarget(to, message) : null;
        if (cached && direct?.isOpen(cached.device.id) && !holdFor(cached.device) && !chunkPlan(message)) {
          // ADR-069: a direct link is still open — it needs no relay
          try {
            const receipt = waitReceipt(message.id, receiptTimeout);
            sentTo.set(message.id, cached.device.id);
            const got = await viaDirect(cached, message, (await sealFor(cached.device.id, plainFor(message, cached.to, undefined, cached.device))).blob, receipt);
            if (got && !got.request) {
              log(`morse: ${message.id.slice(0, 8)} → ${cached.label} delivered via direct (relay down; ${cached.device.tier})`);
              return { ok: true, via: 'direct' };
            }
            if (got?.request === 'filed') return { ok: true, via: 'direct', request: true };
            if (got?.request === 'dropped') return heldResult(cached.device);
            receiptWaiters.delete(message.id);
          } catch {
            /* fall through: LAN, then wait for the relay */
          }
        }
        if (cached && opts.lan?.reachable(cached.device.id)) {
          const held = holdFor(cached.device);
          if (held) return held;
          const plan = chunkPlan(message);
          if (plan) return sendChunked(cached, message, plan);
          let plain: Extract<Plain, { kind: 'message' }> | null = null;
          try {
            plain = plainFor(message, cached.to, undefined, cached.device);
          } catch {
            /* attachments unreadable: reported below on the normal path */
          }
          const r = plain ? await viaLan(cached, message, plain) : null;
          if (r) return r;
        }
        if (!(await client.waitConnected(connectWait))) {
          return { ok: false, waiting: true, error: `relay ${opts.url} not connected — ${to} will get it when the relay is back` };
        }
      }
      const t = await target(to, message);
      if (!('kind' in t)) return t;
      if (t.kind === 'self') return deliverToSelf(t, message);
      // that device has not accepted our message request yet: hold it — but for a probe now and then
      const held = holdFor(t.device);
      if (held) return held;
      // ADR-038: too big for one envelope → a chunked transfer in the background
      const plan = chunkPlan(message);
      if (plan) return sendChunked(t, message, plan);

      let plain: Extract<Plain, { kind: 'message' }>;
      try {
        plain = plainFor(message, t.to, undefined, t.device);
      } catch (e) {
        return { ok: false, error: `cannot read attachments: ${e instanceof Error ? e.message : String(e)}` };
      }
      const lan = await viaLan(t, message, plain);
      if (lan) return lan;

      // ONE sealed copy, for the one device that hosts the agent
      const receipt = waitReceipt(message.id, receiptTimeout);
      sentTo.set(message.id, t.device.id);
      let r: 'sent' | 'offline' | 'stored';
      /** ADR-069: direct first; the receipt that came back while we watched the link; (ADR-091) the LAN before that */
      let via: 'lan' | 'direct' | 'relay' = 'relay';
      let early: ReceiptSeen | undefined;
      let v3 = false;
      try {
        const sealed = await sealFor(isNative(t.device) ? t.device : t.device.id, plain);
        v3 = Boolean(sealed.v3);
        const l = await viaLanAddress(t, message, sealed, receipt);
        const d = l ? null : await viaDirect(t, message, sealed.blob, receipt);
        if (l) {
          via = 'lan';
          early = l;
          r = 'sent';
        } else if (d) {
          via = 'direct';
          early = d;
          r = 'sent';
        } else r = await sendRelay(t.device.id, sealed, { ref: message.id });
      } catch (e) {
        receiptWaiters.delete(message.id);
        // (ADR-081 review F1) the address it is from stopped being held between the route and the seal: refused, not retried under another
        if (e instanceof NoSignerError) return { ok: false, error: goneLine(e.address) };
        const msg = e instanceof Error ? e.message : String(e);
        if (/too large|does not belong|signature invalid|not an X25519/.test(msg)) return { ok: false, error: `relay send to ${t.label}: ${msg}` };
        return { ok: false, waiting: true, error: `${t.label}: ${msg} — kept in the outbox, will retry` };
      }
      if (r === 'offline') {
        receiptWaiters.delete(message.id);
        return { ok: false, waiting: true, error: `${t.label} is offline — kept in the outbox, will retry` };
      }
      if (r === 'stored') {
        // ADR-073: they are offline; the relay keeps it (sealed) up to 7 days — their receipt comes when they fetch it
        receiptWaiters.delete(message.id);
        noteAddress(message.contactId, t.device.id);
        log(`morse: ${message.id.slice(0, 8)} → ${t.label} is offline — left in the relay's offline mailbox (v3, kept up to 7 days; their receipt comes when they fetch it)`);
        return { ok: true, via: 'relay' };
      }
      const got = early ?? (await receipt);
      if (got?.request === 'dropped') return heldResult(t.device);
      if (got?.request === 'filed') {
        log(`morse: ${message.id.slice(0, 8)} → ${t.label} is in their message requests (request pending, via ${via}) — they have not accepted you yet; later messages wait here until they do`);
        return { ok: true, via, request: true };
      }
      if (got) {
        noteAddress(message.contactId, t.device.id);
        kickMigration();
        log(`morse: ${message.id.slice(0, 8)} → ${t.label} delivered via ${via} (${via === 'direct' ? 'WebRTC data channel, ' : ''}${v3 ? 'v3, ' : ''}${t.device.tier})`);
        return { ok: true, via };
      }
      return { ok: false, waiting: true, error: `${t.label}: forwarded but no receipt within ${receiptTimeout / 1000}s — will retry` };
    },
    stop: () => {
      clearInterval(cleanupTimer);
      if (rotateTimer) clearInterval(rotateTimer);
      rotation?.stop();
      if (migrateTimer) clearTimeout(migrateTimer);
      v3client?.close();
      for (const a of acks.values()) if (a.timer) clearTimeout(a.timer);
      direct?.close();
      client.close();
    },
  };
}

/** Result of a handle lookup for pairing. */
export interface HandleLookup {
  handle: string;
  /** This device's own handle on the relay — the same as `handle` = your own devices (ADR-034). */
  self: string | null;
  devices: Array<{ id: string; name: string; keyPinned: boolean }>;
}

/**
 * `morse pair add <handle>`: ask the relay which devices belong to a person. Each
 * device's key bundle is verified against ITS OWN device ID (the signature proves
 * the device holds the key) and pinned. What the relay vouches for here is the
 * handle → device-ID mapping — pairing by handle trusts the relay operator for
 * that; pairing by device ID does not.
 */
export async function lookupHandle(handle: string, opts: { url: string; home?: string; timeoutMs?: number; log?: (l: string) => void }): Promise<HandleLookup> {
  // (ADR-081 review F3) an address is not an old name: there is no directory entry to pair from
  if (addressShapedHandle(handle.replace(/^@/, ''))) throw new Error(`"${handleOf(handle.replace(/^@/, '')).toLowerCase()}" is an address, not an old name — there is nothing to pair (morse contact add morse.im/${handleOf(handle.replace(/^@/, '')).toLowerCase()})`);
  const home = opts.home ?? morseHome();
  const identity = loadOrCreateIdentity(home);
  const client = startRelayClient({
    url: opts.url,
    identity,
    bundle: makeKeyBundle(identity, loadOrCreateEncKey(home)),
    onDeliver: async () => undefined,
    passive: true,
    ...(opts.log ? { log: opts.log } : {}),
  });
  try {
    if (!(await client.waitConnected(opts.timeoutMs ?? 8000))) throw new Error(`cannot log in to the relay ${opts.url} (is this device on its allowlist?)`);
    const found = await client.lookupHandle(handle);
    const devices = found.map((d) => {
      let keyPinned = false;
      if (d.bundle) {
        try {
          verifyKeyBundle(d.bundle, d.id);
          pinKeyBundle(d.bundle, home);
          keyPinned = true;
        } catch {
          keyPinned = false; // a bad bundle is ignored, never pinned
        }
      }
      return { id: d.id, name: d.name, keyPinned };
    });
    return { handle: handle.toLowerCase().replace(/^@/, ''), self: client.handle(), devices };
  } finally {
    client.close();
  }
}

/**
 * Largest total attachment size that still fits one relay envelope: file bytes are
 * base64'd into the JSON plaintext, and the ciphertext is base64'd again (×16/9),
 * plus headroom for the envelope itself.
 */
export function maxAttachmentBytes(maxBlob: number = DEFAULT_RELAY_LIMITS.maxBlobBytes): number {
  return Math.floor(((maxBlob - 16 * 1024) * 9) / 16);
}

/**
 * Copy files to send into ~/.morse/outbox-files/<uuid>/ (0600) so the queued message owns
 * its bytes. `limit` caps each file and all of them together (ADR-038: `morse.maxFileBytes`,
 * default 100 MB — anything bigger than one relay envelope goes in chunks).
 */
export function stageOutboxFiles(paths: string[], home: string = morseHome(), limit = fileLimitsFrom(readMachineConfig().morse).maxFileBytes): MessageFile[] {
  let total = 0;
  for (const p of paths) {
    const size = statSync(p).size;
    if (size > limit) throw new Error(`file too large: ${basename(p)} is ${size} bytes (${formatBytes(size)}) > ${limit} (${formatBytes(limit)}, morse.maxFileBytes)`);
    total += size;
    if (total > limit) throw new Error(`attachments too large: ${total} bytes (${formatBytes(total)}) in one message > ${limit} (${formatBytes(limit)}, morse.maxFileBytes)`);
  }
  const dir = join(dataDir(home), 'outbox-files', randomUUID());
  const staged: MessageFile[] = [];
  try {
    for (const p of paths) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const name = safeFileName(p);
      let path = join(dir, name);
      for (let i = 1; existsSync(path); i++) path = join(dir, `${i}-${name}`);
      copyFileSync(p, path);
      chmodSync(path, 0o600);
      const size = statSync(path).size;
      if (size > limit) throw new Error(`file too large: ${name} grew to ${size} bytes while it was copied`);
      staged.push({ name, path, size, sha256: sha256FileSync(path) });
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return staged;
}
