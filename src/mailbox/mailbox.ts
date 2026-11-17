import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SENDERS_RECORDED_MARK, type Db } from './db.js';
import { createRequestStore, type RequestStore } from './requests.js';
import { createContactStore, SELF_CONTACT, type Contact, type ContactContext, type ContactStore, type Direction } from './contacts.js';
import { normalizeAddress } from '../identity/address.js';

export interface SessionRef {
  agent: string;
  sessionId: string;
  /** The device the session lives on; absent for a session on this computer. */
  device?: string;
}

/** A file carried with a message (Morse). On the sending device `path` is the
 *  outbox copy; on the receiving device it is the 0600 file in the inbox dir. */
export interface MessageFile {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface MessagePart {
  type: 'text';
  text: string;
  via?: string;
  files?: MessageFile[];
}

/** Trust tier of the device a message came FROM (Morse). Unset = local / owner. */
export type FromTier = 'owner' | 'peer';

export type MessageStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead';

/**
 * ADR-089: who holds a delivery. Asked for at claim time (`ClaimOptions.lease`); every later report on the
 * row — delivered, failed, handed back, extended — names the holder, and only the current holder's counts.
 */
export interface Lease {
  /** A random id per claim. */
  holder: string;
  /** The process the lease lives and dies with (the claiming plugin; then the agent CLI it started). */
  pid: number | null;
  since: number;
  expiresAt: number;
  /** The holder said it is starting an agent turn for this claim (`extend … started`): only then is a takeover a possible repeat. */
  started?: boolean;
}

/** A report on a row by somebody who is not (or no longer) its holder: refused, nothing changed (ADR-089). */
export class LeaseLostError extends Error {}

/** How long a lease lasts without being renewed. The holder renews at a third of it while its turn runs. */
export const LEASE_TTL_MS = 45_000;
/**
 * Only where the process behind a pid cannot be identified (no start time on record, or the system does not
 * tell — Windows): a lease this long past its expiry is dead whatever its pid says (it may be another
 * program's by now). Where the start time is known, the pid + start time decide, however long it takes.
 */
export const LEASE_ORPHAN_MAX_MS = 2 * 3_600_000;

/**
 * When the process `pid` was started, as a string that is the same every time it is asked for the same
 * process and different for another process that later got the same pid; null = not running, or the system
 * does not tell. Linux: the start time in /proc/<pid>/stat (clock ticks since boot). macOS / BSD: `ps -o lstart=`
 * (in the C locale and UTC, so that every caller reads the same text). Windows: null.
 */
export function processStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // "pid (comm) state ppid … starttime …": comm may contain spaces and parentheses — count from the last ')'
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return rest[19] ? `t${rest[19]}` : null;
    }
    const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/bin:/usr/bin' } }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export interface Message {
  id: string;
  conversationId: string;
  contextId: string;
  from: SessionRef;
  to: SessionRef;
  parts: MessagePart[];
  status: MessageStatus;
  attempts: number;
  lastError?: string;
  /** Morse: 'failed' only because the recipient is not reachable yet; keeps being retried. */
  waiting?: boolean;
  /** True when the message ran as a turn of the target's own open session rather than a separate headless run. */
  deliveredInSession?: boolean;
  /** 'peer' = sent by someone else's agent: pull-only, NOT your operator's instruction. */
  fromTier?: FromTier;
  /** The recipient device's end-to-end receipt (Morse relay), epoch ms. */
  receiptAt?: number;
  /** Morse (ADR-037), sender side: it reached the recipient's message requests —
   *  they have not accepted you yet (not their inbox). */
  request?: boolean;
  /** ADR-071: another person's reply in a thread we started (to that very address):
   *  `to` is the session that started it (or our own inbox when the CLI did). */
  ownThread?: boolean;
  /** ADR-049: in = received from a person (another one, or our own device) · out = sent
   *  to one · internal = between sessions on this computer. */
  direction?: Direction;
  /** The one contact it belongs to ('self' for our own sessions and devices). */
  contactId?: string;
  /** My agent: it was addressed to (in / internal) or sent from (out). A local NAME — display only. */
  myAgent?: string;
  /**
   * ADR-081: WHICH of this computer's addresses it belongs to, as the address itself — sent from it
   * (out, when it was sent "as" an address) or written to it (in, mail that came by address alone).
   * This, never the name in `myAgent`, decides which key signs an answer or the message itself.
   */
  myAddress?: string;
  /**
   * ADR-081, outbound: it was queued without naming an address of yours (no `--from`, not a reply to
   * mail written to one) — it goes from this computer's first address, whatever `myAgent` says.
   * Unset on a row that names an address, and on a row the release before wrote (`my_address` NULL:
   * that release could only send from the first address — see `sendersRecordedSince`).
   */
  fromFirstAddress?: boolean;
  /** Their agent (in / out). */
  peerAgent?: string;
  /** ADR-089: held under a lease right now ('delivering', claimed with one). */
  lease?: Lease;
  /**
   * ADR-089: an earlier delivery of this message was interrupted before it was confirmed (its holder was
   * gone, or a restart set it aside) — whoever gets it now is told that it may already have been handled.
   */
  possibleRepeat?: boolean;
  /** Received messages: when it was marked processed, and by whom. Unset = to process. */
  processedAt?: number;
  processedBy?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary {
  id: string;
  a: SessionRef;
  b: SessionRef;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  lastMessage?: Message;
}

export interface SendInput {
  from: SessionRef;
  to: SessionRef;
  text: string;
  contextId?: string;
  via?: string;
  /** File into this existing conversation rather than the one of the (from, to) pair, so that a
   *  third party (e.g. the human joining an agent pair) stays in that single thread. */
  conversationId?: string;
  /** Inbound cross-device mail: the trust tier of the sending device. Unset with a
   *  `from.device` = treated as another person's (ADR-048: unknown is never trusted). */
  fromTier?: FromTier;
  /** Files attached to the message (Morse). */
  files?: MessageFile[];
  /**
   * ADR-077: inbound mail only — the contact the transport found for the sender's VERIFIED address
   * (ContactStore.filingContact). Never taken from anything the sender wrote. Ignored for mail that
   * is not another person's (owner tier, outbound, internal).
   */
  contactId?: string;
  /**
   * ADR-081: outbound mail only — the local name (`morse address`) of the address of yours it is sent
   * FROM, kept in `messages.agent`. Display only, and only together with `myAddress`: a name without
   * the address is refused (ADR-081 review: every outbound row records its address). Ignored for mail
   * that is not outbound.
   */
  myAgent?: string;
  /**
   * ADR-081: the ADDRESS of yours this message belongs to — outbound: the one it is sent from (`morse
   * send --from`, a reply to mail written to an address); inbound mail by address: the one it was
   * written to. Kept in `messages.my_address`. Ignored for mail between sessions of this computer.
   * Outbound without one: the address the contact knows you by (ADR-081 review N2), else '' = this
   * computer's first address.
   */
  myAddress?: string;
  /**
   * (ADR-081 review N2) outbound only: this goes out from this computer's FIRST address whatever the
   * contact knows you by — an answer to mail that reached you the old way (written to the first
   * address), the files of such a message sent again. Ignored when `myAddress` is given.
   */
  firstAddress?: boolean;
}

export interface InboxQuery {
  toSession?: string;
  /** Mark the listed messages delivered (pull mode). Needs `toSession`, and only ever
   *  touches messages received HERE (to_device NULL) — never an outbound message that
   *  waits for a retry (ADR-048). */
  take?: boolean;
  /** Only messages to this agent (with toSession 'inbox': that agent's Morse mailbox). */
  toAgent?: string;
  /** Leave out messages from other people (from a device, tier not owner) — what may be
   *  injected into a session (ADR-048). */
  excludeForeign?: boolean;
  all?: boolean;
  /** Just status 'pending' — nothing being delivered right now, nothing awaiting a retry. */
  pendingOnly?: boolean;
  /** Just the dead messages, whose push delivery was given up. The prompt hook uses it as a
   *  fallback so such mail still reaches its session; with `take` they become delivered. */
  undeliveredOnly?: boolean;
  /**
   * Only messages a restart found mid-delivery and set aside (`recoverStale`): 'failed', with that note.
   * A pull takes them too — the session that asks for its mail gets it, instead of waiting for a retry
   * that never comes for a session the dispatcher does not deliver to (ADR-087 follow-up 5).
   */
  strandedOnly?: boolean;
  /**
   * (ADR-089) Only messages still 'delivering' whose lease is DEAD — expired, and the process it was tied to
   * gone: the holder will not report any more. A pull by the session takes them (as a possible repeat). A row
   * whose lease is live is never returned by a `take`, whatever the query.
   */
  deadLeaseOnly?: boolean;
}

export interface Mailbox {
  send(input: SendInput): Message;
  reply(messageId: string, text: string, via?: string): Message;
  inbox(query?: InboxQuery): Message[];
  getMessage(id: string): Message | null;
  listConversations(): ConversationSummary[];
  listMessages(conversationId: string): Message[];
  /** Take the oldest due message and set it to 'delivering'. With `skip` a caller passes over targets it
   *  decides on at claim time (e.g. a session following its own mail with `morse message --wait`,
   *  which must be left pending rather than resumed headlessly). */
  claimNextPending(opts?: ClaimOptions): Message | null;
  /** ADR-052: claim THIS message if it is due (same rules as claimNextPending, scope local:
   *  own-agent mail for a session here, never another person's). null = not due / taken. */
  claimById(id: string, lease?: LeaseRequest): Message | null;
  /** ADR-052: hand a claimed message back untouched (no attempt counted). ADR-089: a row held under a lease
   *  only by its holder (false otherwise). */
  release(id: string, holder?: string): boolean;
  /** ADR-089: `holder` — the lease this report is made under; a row held under a lease takes only its holder's
   *  report (LeaseLostError otherwise, nothing changed). */
  markDelivered(id: string, opts?: { inSession?: boolean; holder?: string; /** who delivered it (recorded as the one that processed it; default: the dispatcher) */ by?: string }): Message;
  /** terminal = never auto-retry. waiting = the recipient is not reachable yet
   *  (Morse): retry every `waitRetryMs` until `waitMaxMs` after creation, then dead. */
  markFailed(id: string, error: string, opts?: { terminal?: boolean; waiting?: boolean; holder?: string }): Message;
  /** ADR-089: the holder is still at it — the lease lasts another `ttlMs` from now, and (pid) lives and dies
   *  with that process from now on. false = not the holder (any more). */
  extendLease(id: string, holder: string, opts?: { ttlMs?: number; pid?: number; started?: boolean; maxMs?: number }): boolean;
  /** ADR-089: the rows being delivered under a lease that is live (a turn is running for them). */
  liveLeases(): Message[];
  retry(id: string): Message;
  /** ADR-048: a local message whose target session is gone goes to that agent's mailbox
   *  (`<agent>/inbox`, pull-only) instead of dead-lettering. false = not a local message. */
  toMailbox(id: string, note?: string, holder?: string): boolean;
  /** After a crash: move rows left in 'delivering' (claimed without a lease) to 'failed' so they are retried. Returns how many. */
  recoverStale(onlyLocal?: boolean): number;
  /** All traffic touching a session (either direction) since a timestamp — for visibility digests.
   *  "Sent by this session" never includes another person's mail: the session id a sender
   *  writes as its own is its claim, not one of our sessions (ADR-082). */
  recentActivity(sessionId: string, sinceMs: number, limit?: number): Message[];
  /** Messages from other people received here and not taken yet, newer than `sinceMs`
   *  (the prompt hook's one-line count — never their text, ADR-048). */
  foreignWaiting(sinceMs: number): Message[];
  /** Record the recipient device's end-to-end receipt. false = no such message. */
  markReceipt(id: string, at?: number): boolean;
  /** Inbound dedupe (Morse relay is at-least-once): true the first time a (sender, id) is seen. */
  firstSeen(fromId: string, msgId: string): boolean;
  /** Undo firstSeen when filing failed, so the sender's retry is accepted. */
  forgetSeen(fromId: string, msgId: string): void;
  /** Whether (sender, id) was filed already — without marking it (ADR-038: a chunked message is filed only when complete). */
  hasSeen(fromId: string, msgId: string): boolean;
  /** ADR-073: forget dedupe marks older than `beforeMs` (envelopes older than 31 days are refused anyway). */
  pruneSeen(beforeMs: number): number;
  /** ADR-073: an outbound message the relay had taken into its offline mailbox (already
   *  'delivered', no receipt yet) comes back — `retry`: due again right away (the recipient
   *  needs it sealed to a new key); else dead (expired unread). false = not such a message. */
  markUndelivered(id: string, error: string, opts?: { retry?: boolean }): boolean;
  /** A waiting message becomes due right away (its background work finished — ADR-038). */
  nudge(id: string): boolean;
  /** Sender side (ADR-037/038): messages of ours waiting in `handle`'s message requests —
   *  (ADR-083) with `my`: only the ones sent from that address of mine ('' = the first). */
  requestMessages(handle: string, my?: string | null): Message[];
  /** Morse message requests from people not paired here (ADR-037) — never in inbox/pull. */
  requests: RequestStore;
  /** Sender side (ADR-037): this message is waiting in the recipient's message requests. */
  markRequest(id: string): boolean;
  /** Sender side (ADR-037): `handle` accepted us — clear the request marks on what we
   *  sent them and retry what we held back right away. Returns how many were held.
   *  (ADR-083) with `my`: only what was sent from that address of mine ('' = the first) — they accepted
   *  THAT address; what another address of mine holds for them stays held. */
  requestAccepted(handle: string, my?: string | null): number;
  /** Sender side (ADR-037): handles whose request area holds a message of ours. */
  requestPendingHandles(): string[];
  /** (ADR-083) The same per pair: who it waits at, and which of my addresses sent it ('' = the first). */
  requestPending(): Array<{ to: string; my: string }>;
  /** ADR-081: has mail from exactly this sender (`from_device`, e.g. a bare address) ever been filed here?
   *  (ADR-083 review R1) with `my`: only mail written to THAT address of mine ('' = the first) — what one address
   *  of this computer received never decides how another one sends. */
  hasInboundFrom(device: string, my?: string | null): boolean;
  /**
   * ADR-081: which of MY addresses mail from exactly this sender was written to — one entry per
   * distinct (address, local name) on the rows filed from it (`myAddress` unset = a row from before
   * addresses were recorded: only the name is known).
   */
  inboundTargets(device: string): Array<{ myAddress?: string; myAgent?: string }>;
  /**
   * (ADR-081 review: legacy rows) Epoch ms from which every outbound row of this database records its
   * sending address (`SENDERS_RECORDED_MARK`, src/mailbox/db.ts). An outbound row WITHOUT one that was
   * created before it is from the release before, which could only send from the first address; one
   * created after it cannot exist. `daemonStarting`: a daemon of this release starts on this database —
   * the moment is written now if it was not yet (once; later calls and other processes read the same).
   * 0 = not written yet and not starting: nothing counts as "from before".
   */
  sendersRecordedSince(daemonStarting?: boolean): number;
  /**
   * (ADR-081 review N1) Take back an outbound message nobody has started sending: dead, with `reason`.
   * false = it is no longer pending (a daemon holds or sent it), or it is not outbound.
   */
  withdraw(id: string, reason: string): boolean;
  /** ADR-081: record the address an OUTBOUND message goes out from, once (a row that has one keeps it). */
  setMyAddress(id: string, address: string): boolean;
  /** ADR-049: the people (and `self`). */
  contacts: ContactStore;
  /**
   * To process: received messages (in / internal, received here) not yet processed, oldest first.
   * (ADR-083 review R3) With `contactId`: only that contact's — the rows of the address of mine the contact
   * BELONGS to (see `history`).
   */
  todo(query?: TodoQuery): Message[];
  /**
   * Unprocessed received messages per contact id. (ADR-083 review R3) A row counts for the contact whose id
   * it carries only when it belongs to the same address of mine as that contact (a row whose id names
   * another address's contact counts for nobody). With `my`: only the mail of that address of mine
   * ('' = the first; mail between my own sessions and computers is the first address's).
   */
  unread(my?: string | null): Record<string, number>;
  /**
   * Every message with a contact (both directions), oldest first; `limit` keeps the newest.
   * (ADR-083 review R3) Read by the PAIR, never by the bare id: when a contact has this id, only the rows of
   * the address of mine it belongs to — an id can be given to a contact of another address of mine once
   * the contact that had it was removed, and that one must not find the other's mail under it. `self` is
   * not narrowed; an id no contact has (a removed contact) reads as before.
   */
  history(contactId: string, query?: HistoryQuery): Message[];
  /**
   * (ADR-083 review R3) THE way from a message to its contact: the contact whose id the row carries — only
   * when that contact belongs to the address of mine the message belongs to (`self` as it is). null =
   * no contact has that id (removed), or the one that has it is another address's (then the id says
   * nothing about this message). Every reader goes through here; nobody reads `contacts.get(m.contactId)`.
   */
  contactOf(m: Pick<Message, 'contactId' | 'myAddress' | 'direction'>): Contact | null;
  /**
   * (ADR-083 review R3) Which of my addresses a message belongs to, as the stores key it ('' = the first):
   * its contact's when it has one (yourself: the first), else the address the row itself records.
   */
  addressOf(m: Pick<Message, 'contactId' | 'myAddress' | 'direction'>): string;
  /** Mark received messages processed. Only rows received here (in / internal,
   *  to_device NULL) — never one we sent. Returns the ids it changed. */
  markProcessed(ids: string[], by: string): string[];
  /** Received messages (in / internal) newer than a rowid cursor — `morse plugin watch`. */
  receivedAfter(seq: number, limit?: number): Array<Message & { seq: number }>;
  /** The rowid cursor of the newest message received at or before `ms` (0 = none). */
  seqAt(ms: number): number;
  /** The rowid cursor of one message (0 = unknown). */
  seqOf(id: string): number;
}

/** ADR-089: ask for a lease with a claim. */
export interface LeaseRequest {
  /** The process the lease lives and dies with (default: this process). */
  pid?: number;
  ttlMs?: number;
}

/** What claimNextPending passes over (ADR-044). */
export interface ClaimOptions {
  /** ADR-089: claim under a lease (the returned message carries it). Without: the semantics of before. */
  lease?: LeaseRequest;
  /** Local sessions (to_device NULL) that are always pull-only — filtered in SQL. */
  pullOnlySessions?: string[];
  /** Anything decided at claim time (live / monitored sessions) — checked page by page. */
  skip?: (toSession: string, toDevice: string | null) => boolean;
  /** ADR-052: 'outbound' = what the core daemon delivers itself (to another device, or to
   *  the human's own inbox); 'local' = mail for a session on this computer — only the
   *  dispatch plugin claims those. Default: both (tests). */
  scope?: 'all' | 'outbound' | 'local';
  /** Local session ids to pass over (filtered in SQL). */
  skipSessions?: string[];
  /** Message ids to pass over (filtered in SQL) — e.g. one a plugin just handed back. */
  skipIds?: string[];
}

/** SQL: a message from another person — from a device whose tier is not owner (ADR-048). */
// (ADR-091 follow-up) mail from another computer, whatever tier is stored with it: no computer is your owner any more —
// a daemon of the release before may still file your old computer's mail as `owner`
export const FOREIGN_SQL = `(from_device IS NOT NULL)`;

/** SQL (ADR-071): another person's reply in a thread one of our sessions started, filed to that session. */
export const OWN_THREAD_TO_SESSION_SQL = `(own_thread = 1 AND to_device IS NULL AND to_agent != 'user' AND to_session != 'inbox')`;
/** SQL: another person's message that is NOT such a reply — ADR-048 still applies in full. */
const FOREIGN_NOT_OWN_SQL = `(${FOREIGN_SQL} AND NOT ${OWN_THREAD_TO_SESSION_SQL})`;

/** Ordinary reported failures before a message is dead; also the limit on interrupted turns in a row (ADR-089). */
const MAX_ATTEMPTS = 3;
/**
 * (ADR-089) Why a message is dead after its turns were cut off MAX_ATTEMPTS times in a row. The ilink bridge
 * recognises it by its wording ("deliveries in a row were interrupted") to tell the WeChat user what happened.
 */
export const GAVE_UP_INTERRUPTED = 'gave up: 3 deliveries in a row were interrupted before they were confirmed (the agent may have handled it — check the session)';
/** What `recoverStale` writes on a message it found mid-delivery after a restart. */
export const STRANDED_NOTE = 'daemon restarted mid-delivery (message may have been injected)';
/** Rows read per page while looking for a claimable message. */
const CLAIM_PAGE = 25;
/** How long an ordinary failure waits before it is claimable again. */
const RETRY_BACKOFF_MS = 30_000;
/** Morse outbox defaults: a message to an unreachable person is retried every 30 s for 30 days. */
export const DEFAULT_WAIT_RETRY_MS = 30_000;
export const DEFAULT_WAIT_MAX_MS = 30 * 24 * 60 * 60 * 1000;

export interface MailboxOptions {
  now?: () => number;
  /** ADR-089: is that process still running? (default: signal 0) — a lease is not dead while its process lives. */
  pidAlive?: (pid: number) => boolean;
  /** When a process was started (tests; default: `processStartTime` — none when `pidAlive` is injected). */
  pidStart?: (pid: number) => string | null;
  /** Morse: how often to retry a message whose recipient is not reachable. */
  waitRetryMs?: number;
  /** Morse: how long (from creation) to keep retrying before giving up (dead). */
  waitMaxMs?: number;
  /** Morse (ADR-037): how many message requests to keep (when full a NEW person is refused; nobody waiting is removed). */
  maxRequests?: number;
  /** ADR-049: who we are, to sort each new message into a contact. */
  ctx?: ContactContext;
}

/** ADR-049 views. */
export interface TodoQuery {
  /** Only messages of this contact. */
  contactId?: string;
  /** Only messages to this agent of mine. */
  agent?: string;
  limit?: number;
}
export interface HistoryQuery {
  limit?: number;
  /** Only messages older than this (paging back). */
  before?: number;
}

/** Columns every `messages` row has had since the first schema (`parts` is a JSON array of MessagePart). */
type BaseTextColumn = 'id' | 'conversation_id' | 'context_id' | 'from_agent' | 'from_session' | 'to_agent' | 'to_session' | 'parts';
type BaseNullableTextColumn = 'from_device' | 'to_device' | 'last_error';
type BaseIntColumn = 'attempts' | 'created_at' | 'updated_at';
type BaseMessageColumns = { [K in BaseTextColumn]: string } & { [K in BaseNullableTextColumn]: string | null } & { [K in BaseIntColumn]: number } & { status: MessageStatus };
/** Integer columns added by later migrations (absent on a row read before they existed). */
type AddedIntColumn =
  | 'delivered_in_session' | 'receipt_at' | 'waiting' | 'request' | 'own_thread' | 'processed_at'
  | 'lease_pid' | 'lease_at' | 'lease_expires_at' | 'takeovers' | 'lease_started_at' | 'interrupted' | 'lease_hard_until';
/** Text columns added by later migrations. */
type AddedTextColumn =
  | 'from_tier' | 'direction' | 'contact_id' | 'agent' | 'my_address' | 'peer_agent' | 'processed_by'
  | 'lease_holder' | 'lease_pid_start';
/** A `messages` row as the driver returns it. */
type MessageRow = BaseMessageColumns &
  { [K in AddedIntColumn]?: number | null } &
  { [K in AddedTextColumn]?: string | null };

/** The columns a new conversation row is written with. */
const CONVERSATION_COLUMNS = ['id', 'pair_key', 'a_agent', 'a_session', 'a_device', 'b_agent', 'b_session', 'b_device', 'created_at', 'last_message_at'] as const;

/** A `conversations` row with its message count. */
interface ConversationRow {
  id: string;
  a_agent: string;
  a_session: string;
  a_device: string | null;
  b_agent: string;
  b_session: string;
  b_device: string | null;
  created_at: number;
  last_message_at: number;
  message_count: number;
}

/** One end of a message or conversation, as stored in three columns. */
function endpoint(agent: string, sessionId: string, device: string | null): SessionRef {
  return device ? { agent, sessionId, device } : { agent, sessionId };
}

/**
 * Fields of a Message that only appear when the row says so, in the order they are added (the order
 * shows in JSON output). Each reader returns the fields it contributes, or nothing.
 */
const OPTIONAL_FIELDS: ReadonlyArray<(row: MessageRow) => Partial<Message> | undefined> = [
  (r) => (r.last_error !== null ? { lastError: r.last_error } : undefined),
  (r) => (r.delivered_in_session === 1 ? { deliveredInSession: true } : undefined),
  (r) => (r.from_tier === 'peer' || r.from_tier === 'owner' ? { fromTier: r.from_tier } : undefined),
  (r) => (typeof r.receipt_at === 'number' ? { receiptAt: r.receipt_at } : undefined),
  (r) => (r.waiting === 1 ? { waiting: true } : undefined),
  (r) => (r.request === 1 ? { request: true } : undefined),
  (r) => (r.own_thread === 1 ? { ownThread: true } : undefined),
  (r) => (r.direction === 'in' || r.direction === 'out' || r.direction === 'internal' ? { direction: r.direction } : undefined),
  (r) => (r.contact_id ? { contactId: r.contact_id } : undefined),
  (r) => (r.agent ? { myAgent: r.agent } : undefined),
  // ADR-081: a recorded address, or — for an outbound row written with '' — "the first address"
  (r) => (r.my_address ? { myAddress: r.my_address } : r.my_address === '' && r.direction === 'out' ? { fromFirstAddress: true } : undefined),
  (r) => (r.peer_agent ? { peerAgent: r.peer_agent } : undefined),
  (r) => (typeof r.processed_at === 'number' ? { processedAt: r.processed_at } : undefined),
  (r) => (r.processed_by ? { processedBy: r.processed_by } : undefined),
  // ADR-089: the lease, only while the row is being delivered under one
  (r) =>
    r.status === 'delivering' && r.lease_holder
      ? {
          lease: {
            holder: r.lease_holder,
            pid: r.lease_pid ?? null,
            since: r.lease_at ?? r.updated_at,
            expiresAt: r.lease_expires_at ?? 0,
            ...(r.lease_started_at != null ? { started: true } : {}),
          },
        }
      : undefined,
  (r) => ((r.takeovers ?? 0) > 0 ? { possibleRepeat: true } : undefined),
];

/** Turn a stored row into the Message callers see. */
function toMessage(row: MessageRow): Message {
  const { id, status, attempts, conversation_id: conversationId, context_id: contextId, created_at: createdAt, updated_at: updatedAt } = row;
  const from = endpoint(row.from_agent, row.from_session, row.from_device);
  const to = endpoint(row.to_agent, row.to_session, row.to_device);
  const parts = JSON.parse(row.parts) as MessagePart[];
  // key order is visible in JSON output: keep core fields first, in this order
  const message: Message = { id, conversationId, contextId, from, to, parts, status, attempts, createdAt, updatedAt };
  for (const read of OPTIONAL_FIELDS) Object.assign(message, read(row));
  return message;
}

const defaultPidAlive = (pid: number): boolean => {
  try {
    return pid > 0 && (process.kill(pid, 0), true);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The status part of an inbox query. The narrow selections are exclusive and checked in this order;
 * without one, every open message (pending, being delivered, or failed and awaiting a retry), or with
 * `all` no status condition at all (null).
 */
function inboxStatusFilter(q: InboxQuery): { sql: string; params: unknown[] } | null {
  if (q.undeliveredOnly) return { sql: `status = 'dead'`, params: [] };
  if (q.strandedOnly) return { sql: `status = 'failed' AND last_error = ?`, params: [STRANDED_NOTE] };
  // (ADR-089) candidates only: whether the lease is really dead (expired, its process gone) is decided per row
  if (q.deadLeaseOnly) return { sql: `status = 'delivering' AND lease_holder IS NOT NULL`, params: [] };
  if (q.pendingOnly) return { sql: `status = 'pending'`, params: [] };
  if (q.all) return null;
  return { sql: `status IN ('pending', 'delivering', 'failed')`, params: [] };
}

/**
 * Where a reported failure leaves a message. A terminal failure (e.g. a timeout whose turn already ran) is
 * final. A waiting one — nothing wrong with the message, the recipient is just unreachable — is never final on
 * its count, only on age (see claimNextPending). Any other failure is final on the MAX_ATTEMPTS-th report.
 */
function afterFailure(attempts: number, terminal: boolean, waiting: boolean): { status: MessageStatus; waiting: boolean } {
  if (terminal) return { status: 'dead', waiting: false };
  if (waiting) return { status: 'failed', waiting: true };
  return { status: attempts >= MAX_ATTEMPTS ? 'dead' : 'failed', waiting: false };
}

/** The conversation key of two ends: the same whichever end is the sender. */
function conversationKey(x: SessionRef, y: SessionRef): string {
  const label = (r: SessionRef): string => `${r.device ?? ''}/${r.agent}:${r.sessionId}`;
  const [p, q] = [label(x), label(y)];
  return p <= q ? `${p}|${q}` : `${q}|${p}`;
}

export function createMailbox(db: Db, opts: MailboxOptions = {}): Mailbox {
  const { now = Date.now } = opts;
  const pidAlive = opts.pidAlive ?? defaultPidAlive;
  const pidStart = opts.pidStart ?? (opts.pidAlive ? () => null : processStartTime);
  /**
   * What is known about a process: its start time, null (the system does not tell / it is not running), or
   * undefined = NOT LOOKED UP. Looking up may run `ps`; that is never done while a write transaction is open
   * (review N3) — inside one, only what `lookUp()` gathered just before is used, and "not looked up" decides
   * nothing: the lease counts as live for this round.
   */
  type Look = (pid: number) => string | null | undefined;
  /**
   * ADR-089: a lease is DEAD when it has expired AND its holder will not report any more:
   *   - the process it was tied to is gone — the pid is not running, or it is another program's now (another
   *     start time): dead at once;
   *   - the process is still running but has not renewed the lease:
   *       · no turn was started for the claim: dead one more lease-life after the expiry (review N2: a claim
   *         that is neither started nor renewed nor reported is a holder that failed in between);
   *       · a turn was started: dead once the turn's own time limit has passed (`lease_hard_until`, said by the
   *         holder with the agent's pid) — or, when none was given, LEASE_ORPHAN_MAX_MS after the expiry.
   * A holder that renews is never touched: the lease is simply not expired. Until a lease is dead nobody takes
   * the row.
   */
  const leaseDead = (
    r: { lease_holder?: string | null; lease_pid?: number | null; lease_pid_start?: string | null; lease_expires_at?: number | null; lease_started_at?: number | null; lease_hard_until?: number | null },
    t: number,
    look: Look = pidStart,
  ): boolean => {
    if (!r.lease_holder) return false;
    const expires = r.lease_expires_at ?? 0;
    if (expires > t) return false;
    if (r.lease_pid == null || !pidAlive(r.lease_pid)) return true;
    if (r.lease_pid_start) {
      const is = look(r.lease_pid);
      if (is === undefined) return false;
      if (is !== null && is !== r.lease_pid_start) return true;
    }
    if (r.lease_started_at == null) return t - expires > LEASE_TTL_MS;
    if (r.lease_hard_until != null) return t > r.lease_hard_until;
    return t - expires > LEASE_ORPHAN_MAX_MS;
  };
  /**
   * (review N3) The start times of the processes that expired leases are tied to — gathered BEFORE a write
   * transaction, so that the write lock is never held across a `ps`. A mailbox that holds no such lease reads
   * neither the clock nor the process table here.
   */
  const lookUp = (): Look => {
    const tied = db.prepare(`SELECT DISTINCT lease_pid AS pid, lease_expires_at AS expires FROM messages WHERE status = 'delivering' AND lease_holder IS NOT NULL AND lease_pid IS NOT NULL AND lease_pid_start IS NOT NULL`).all() as Array<{ pid: number; expires: number | null }>;
    const seen = new Map<number, string | null>();
    if (tied.length) {
      const t = now();
      for (const { pid, expires } of tied) if ((expires ?? 0) <= t && !seen.has(pid) && pidAlive(pid)) seen.set(pid, pidStart(pid));
    }
    return (pid) => (seen.has(pid) ? (seen.get(pid) as string | null) : undefined);
  };
  const leaseLive = (r: MessageRow, t: number, look: Look = pidStart): boolean => r.status === 'delivering' && Boolean(r.lease_holder) && !leaseDead(r, t, look);
  /** The lease columns of a fresh claim (all NULL without a lease: the semantics of before). */
  const leaseValues = (lease: (LeaseRequest & { pidStart?: string | null }) | undefined, t: number): [string | null, number | null, string | null, number | null, number | null] => {
    if (!lease) return [null, null, null, null, null];
    const pid = lease.pid ?? process.pid;
    return [randomUUID(), pid, lease.pidStart !== undefined ? lease.pidStart : pidStart(pid), t, t + (lease.ttlMs ?? LEASE_TTL_MS)];
  };
  /** The start time of the lease's process is looked up BEFORE the write transaction (it may run `ps`). */
  const withStart = (lease: LeaseRequest | undefined): (LeaseRequest & { pidStart: string | null }) | undefined => {
    if (!lease) return undefined;
    const pid = lease.pid ?? process.pid;
    return { ...lease, pid, pidStart: pidStart(pid) };
  };
  const CLEAR_LEASE = `lease_holder = NULL, lease_pid = NULL, lease_pid_start = NULL, lease_at = NULL, lease_expires_at = NULL, lease_started_at = NULL, lease_hard_until = NULL`;
  /** (ADR-089, review F5) `<agent>\0<session>` of every session here that a delivery under a live lease is running for. */
  const busySessions = (t: number, look: Look): Set<string> =>
    new Set(
      (db.prepare(`SELECT * FROM messages WHERE status = 'delivering' AND lease_holder IS NOT NULL AND to_device IS NULL`).all() as MessageRow[])
        .filter((r) => leaseLive(r, t, look))
        .map((r) => `${r.to_agent}\0${r.to_session}`),
    );
  /** A report under a lease: only the current holder's counts. (A row without a lease: `holder` must be absent.) */
  const holderOk = (m: Message, holder: string | undefined): boolean => (m.lease ? m.lease.holder === holder : holder === undefined);
  const lost = (id: string, what: string): LeaseLostError =>
    new LeaseLostError(`lease lost: ${what} of ${id} refused — it is not held by this caller (another delivery took it over, or it was already reported)`);
  const waitRetryMs = opts.waitRetryMs ?? DEFAULT_WAIT_RETRY_MS;
  const waitMaxMs = opts.waitMaxMs ?? DEFAULT_WAIT_MAX_MS;

  const selectMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
  /** ADR-071: the first message of a thread, when it is ours (sent from here) to this contact. */
  // ADR-077: "this contact" = the same contact or one sharing its old v2 handle (the same person in v2
  // terms — exactly who could answer before contacts were split per address)
  const threadStarter = db.prepare(
    `SELECT from_agent, from_session, my_address FROM messages WHERE id = ? AND direction = 'out' AND from_device IS NULL
       AND (contact_id = ? OR contact_id IN (SELECT id FROM contacts WHERE handle IS NOT NULL AND handle = (SELECT handle FROM contacts WHERE id = ?)))`,
  );
  const requests = createRequestStore(db, { now, ...(opts.maxRequests ? { max: opts.maxRequests } : {}) });
  const contacts = createContactStore(db, { now, ...(opts.ctx ? { ctx: opts.ctx } : {}) });
  /** ADR-049: received here and not processed — the to-process view. */
  const TODO = `direction IN ('in', 'internal') AND to_device IS NULL AND processed_at IS NULL`;
  const processedMark = db.prepare(
    `UPDATE messages SET processed_at = COALESCE(processed_at, ?), processed_by = COALESCE(processed_by, ?) WHERE id = ? AND direction IN ('in', 'internal') AND to_device IS NULL`,
  );
  /** Messages to a person: to_device is `<handle>` or `<handle>/<agent>`. */
  const toHandle = `(lower(to_device) = ? OR substr(lower(to_device), 1, length(?) + 1) = ? || '/')`;

  /**
   * Hold a row that may be held (decided by the caller): 'delivering', under a lease when one is asked for.
   * `takeover` (ADR-089): the row was still held, by a lease that is dead — its holder is gone.
   *   - No turn had been started for that claim (the holder died between the claim and the agent's start, or
   *     never said `started`): nothing happened to the message. It is handed out again as if it had never been
   *     claimed — not labelled, not counted (review F3).
   *   - A turn HAD been started: it was interrupted. The row is marked as a possible repeat (`takeovers`), and
   *     a message that kills every delivery is not redelivered for ever: the MAX_ATTEMPTS-th interrupted turn
   *     in a row makes it dead (returns null). `interrupted` goes back to 0 when a holder reports (nack).
   * A row a restart had set aside (claimed without a lease) is a possible repeat too — nobody can tell.
   * `attempts` — deliveries that REPORTED a failure — is not touched: a taken-over message that is handed back
   * (its session is open) is 'pending' again, for the session's own pull, as before.
   */
  const takeRow = (row: MessageRow, t: number, lease: LeaseRequest | undefined, takeover: boolean): Message | null => {
    const interruptedTurn = takeover && row.lease_started_at != null;
    if (interruptedTurn && (row.interrupted ?? 0) + 1 >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE messages SET status = 'dead', takeovers = takeovers + 1, interrupted = interrupted + 1, waiting = 0, last_error = ?, updated_at = ?, ${CLEAR_LEASE} WHERE id = ?`).run(
        GAVE_UP_INTERRUPTED,
        t,
        row.id,
      );
      return null;
    }
    const repeat = interruptedTurn || (row.status === 'failed' && row.last_error === STRANDED_NOTE);
    db.prepare(
      `UPDATE messages SET status = 'delivering', updated_at = ?, takeovers = takeovers + ?, interrupted = interrupted + ?,
         lease_holder = ?, lease_pid = ?, lease_pid_start = ?, lease_at = ?, lease_expires_at = ?, lease_started_at = NULL, lease_hard_until = NULL WHERE id = ?`,
    ).run(t, repeat ? 1 : 0, interruptedTurn ? 1 : 0, ...leaseValues(lease, t), row.id);
    return getMessage(row.id);
  };

  /** Set aside by `recoverStale` and not claimed again since: its earlier holder may still report on it. */
  const stranded = (m: Message): boolean => m.status === 'failed' && m.lastError === STRANDED_NOTE;
  function getMessage(id: string): Message | null {
    const row = selectMessage.get(id) as MessageRow | undefined;
    return row === undefined ? null : toMessage(row);
  }
  /** A message that has to be there; `missing` is the error otherwise. */
  const mustGet = (id: string, missing = `message not found: ${id}`): Message => {
    const found = getMessage(id);
    if (found === null) throw new Error(missing);
    return found;
  };

  // Conversations: one per unordered pair of ends, keyed by `conversationKey`.
  const conversationSql = {
    byKey: db.prepare('SELECT id FROM conversations WHERE pair_key = ?').pluck(),
    exists: db.prepare('SELECT 1 FROM conversations WHERE id = ?').pluck(),
    touch: db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?'),
    create: db.prepare(`INSERT INTO conversations (${CONVERSATION_COLUMNS.join(', ')}) VALUES (${CONVERSATION_COLUMNS.map((c) => `@${c}`).join(', ')})`),
  };
  /**
   * The conversation a message between `from` and `to` is filed in, with its activity time moved to `at`.
   * `chosen` names an existing conversation to use instead (it must exist); otherwise the pair's own one,
   * created on first use.
   */
  const conversationFor = (from: SessionRef, to: SessionRef, at: number, chosen?: string): string => {
    let id: string | undefined;
    if (chosen) {
      if (conversationSql.exists.get(chosen) === undefined) throw new Error(`conversation not found: ${chosen}`);
      id = chosen;
    } else {
      id = conversationSql.byKey.get(conversationKey(from, to)) as string | undefined;
    }
    if (id !== undefined) {
      conversationSql.touch.run(at, id);
      return id;
    }
    const fresh = randomUUID();
    const row: Record<(typeof CONVERSATION_COLUMNS)[number], string | number | null> = {
      id: fresh,
      pair_key: conversationKey(from, to),
      a_agent: from.agent,
      a_session: from.sessionId,
      a_device: from.device ?? null,
      b_agent: to.agent,
      b_session: to.sessionId,
      b_device: to.device ?? null,
      created_at: at,
      last_message_at: at,
    };
    conversationSql.create.run(row);
    return fresh;
  };

  const listConversationRows = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c ORDER BY c.last_message_at DESC`,
  );
  const newestInConversation = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1');
  const messagesInConversation = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC');

  /** A new row; status and attempts take the column defaults ('pending', 0). */
  const insertMessageRow = db.prepare(
    `INSERT INTO messages (id, conversation_id, context_id, from_agent, from_session, from_device, to_agent, to_session, to_device,
       parts, from_tier, direction, contact_id, agent, my_address, peer_agent, own_thread, created_at, updated_at)
     VALUES (@id, @conversation, @context, @fromAgent, @fromSession, @fromDevice, @toAgent, @toSession, @toDevice,
       @parts, @fromTier, @direction, @contact, @myAgent, @myAddress, @peerAgent, @ownThread, @at, @at)`,
  );

  /** (ADR-083) SQL + parameters: an outbound row sent from this address of mine ('' = the first; `undefined` = any). */
  const sentFrom = (my: string | null | undefined): { sql: string; params: string[] } => {
    if (my === undefined) return { sql: '', params: [] };
    const key = contacts.mine(my);
    // (a row of the first address says so with '' — or names it — or, from before addresses were recorded, with nothing)
    return key ? { sql: ' AND my_address = ?', params: [key] } : { sql: ` AND (my_address IS NULL OR my_address = '' OR my_address = ?)`, params: [contacts.firstAddress() ?? ''] };
  };

  /**
   * (ADR-083 review R3) The address of mine ('' = the first) the contact with this id belongs to — what its
   * mail is narrowed to. null = not narrowed: yourself, or an id no contact has.
   */
  const pairOf = (contactId: string): string | null => {
    if (contactId === SELF_CONTACT) return null;
    const row = db.prepare('SELECT my_address AS my FROM contacts WHERE id = ?').get(contactId) as { my: string | null } | undefined;
    return row ? (row.my ?? '') : null;
  };
  /** SQL + parameters: only the rows of the address of mine this contact belongs to (nothing for `self` / an id nobody has). */
  const ofPair = (contactId: string): { sql: string; params: string[] } => {
    const my = pairOf(contactId);
    return my === null ? { sql: '', params: [] } : sentFrom(my);
  };
  const contactOf = (m: Pick<Message, 'contactId' | 'myAddress' | 'direction'>): Contact | null => {
    if (!m.contactId) return null;
    const c = contacts.get(m.contactId);
    if (!c || c.id === SELF_CONTACT || m.direction === 'internal') return c;
    return contacts.mine(m.myAddress) === c.myAddress ? c : null;
  };

  const insertMessage = (input: SendInput, ts: number): Message => {
    // ADR-072: threads may run as deep and as fast as the agents like; nothing here limits them
    const id = randomUUID();
    const part: MessagePart = input.via ? { type: 'text', text: input.text, via: input.via } : { type: 'text', text: input.text };
    if (input.files?.length) part.files = input.files;
    // ADR-081: what came by address alone is another person's, whatever tier the caller passed
    const fromTier: FromTier | undefined = input.from.device && normalizeAddress(input.from.device) ? 'peer' : input.fromTier;
    // (ADR-083) the address of mine this mail belongs to, when the caller names one — it decides WHICH contact
    const namedAddress = input.myAddress ? normalizeAddress(input.myAddress) : null;
    // (ADR-083) a contact by old name, yourself and your own computers are the first address's alone: mail from
    // another address of mine never goes to an old name — to their address, where it is that address's contact
    if (namedAddress && contacts.mine(namedAddress) && !input.from.device && input.to.device && !normalizeAddress(input.to.device)) {
      throw new Error(`"${input.to.device}" is a contact of your first address — from another of your addresses, write to their address (morse.im/<their 26 characters>): they are then a contact of that address`);
    }
    // ADR-049: every message belongs to one contact
    const classify = (to: SessionRef) =>
      contacts.classify({
        from_agent: input.from.agent,
        from_device: input.from.device ?? null,
        to_agent: to.agent,
        to_session: to.sessionId,
        to_device: to.device ?? null,
        from_tier: fromTier ?? null,
      }, { ...(input.contactId ? { contactId: input.contactId } : {}), ...(namedAddress ? { myAddress: namedAddress } : input.firstAddress ? { myAddress: '' } : {}) });
    let to = input.to;
    const sort = classify;
    let c = sort(to);
    // ADR-082 — the ONE place this rule is enforced: another person's mail (from a device whose
    // tier is not owner; unknown counts, as in FOREIGN_SQL) is filed in a mailbox, whatever
    // session its caller names. The agent or session a sender writes never picks a session of
    // ours; the only way into one is the own-thread check right below, from our own records.
    // (The tier is the one the row is STORED with — a sender that is a bare address is a peer even
    // when its caller said `owner`.)
    if (input.from.device && (fromTier ?? c.fromTier) !== 'owner' && !to.device && to.sessionId !== 'inbox') {
      to = { agent: to.agent, sessionId: 'inbox' };
      c = sort(to);
    }
    // ADR-071: another person answering in a thread WE started, to the address we wrote
    // to — back to the session that started it. Decided from our own records only (the
    // thread's first message is ours); nothing they send picks the session.
    let ownThread = false;
    if (c.direction === 'in' && c.fromTier === 'peer' && input.contextId && !to.device) {
      const starter = threadStarter.get(input.contextId, c.contactId, c.contactId) as { from_agent: string; from_session: string; my_address: string | null } | undefined;
      // (ADR-083 review R3) …and it went out from the address of mine this mail came to: the pair, not the bare contact id
      if (starter && contacts.mine(starter.my_address) === (c.myAddress ?? '')) {
        ownThread = true;
        const session = starter.from_session;
        if (starter.from_agent !== 'user' && session && session !== 'inbox' && to.sessionId === 'inbox') {
          to = { agent: starter.from_agent, sessionId: session };
          // ADR-081: mail that came by address keeps WHICH of my addresses it was written to (the answer goes out from it)
          const writtenTo = c.agent;
          c = sort(to);
          if (input.from.device && normalizeAddress(input.from.device)) c = { ...c, agent: writtenTo };
        }
      }
    }
    const conversationId = conversationFor(input.from, to, ts, input.conversationId);
    if (c.peerAgent && c.direction !== 'internal') contacts.seenAgent(c.contactId, c.peerAgent, ts);
    // ADR-081 (ADR-081 review: legacy rows) — every OUTBOUND row records the address of mine it goes out from:
    // the one named; else (review N2) the one this contact knows me by; else '' = "none: this computer's
    // first address". Never NULL: a row without one is what the release before wrote, and nothing else.
    // Inbound: the address it was written to when it came by address, else NULL (the old way).
    const named = c.direction !== 'internal' ? namedAddress : null;
    if (c.direction === 'out' && input.myAgent && !named) throw new Error(`a sending address was named ("${input.myAgent}") without the address itself — nothing queued`);
    // (ADR-083) with none named: the address of mine the CONTACT belongs to (the row itself — what was `known_as`)
    const myAddress = c.direction === 'out' ? (named ?? (input.firstAddress || c.contactId === SELF_CONTACT ? '' : (c.myAddress ?? ''))) : named;
    insertMessageRow.run({
      id,
      conversation: conversationId,
      context: input.contextId ?? id,
      fromAgent: input.from.agent,
      fromSession: input.from.sessionId,
      fromDevice: input.from.device ?? null,
      toAgent: to.agent,
      toSession: to.sessionId,
      toDevice: to.device ?? null,
      parts: JSON.stringify([part]),
      fromTier: fromTier ?? (c.direction === 'in' ? c.fromTier : null),
      direction: c.direction,
      contact: c.contactId,
      // ADR-081: outbound — the address of mine it goes out from, when one was named (its local name: display only)
      myAgent: c.direction === 'out' && input.myAgent ? input.myAgent : c.agent,
      // …and the address itself (out: sent from it · in: written to it) — what every later decision goes by
      myAddress,
      peerAgent: c.peerAgent,
      ownThread: ownThread ? 1 : 0,
      at: ts,
    });
    return mustGet(id, 'insert failed');
  };

  return {
    send(input) {
      return insertMessage(input, now());
    },

    reply(messageId, text, via) {
      const original = mustGet(messageId);
      // The answer runs back along the same thread: ends swapped, same context, and the same
      // conversation — even when the original was a third party's aside in an agent pair's thread.
      const input: SendInput = {
        from: original.to,
        to: original.from,
        text,
        contextId: original.contextId,
        conversationId: original.conversationId,
        ...(via ? { via } : {}),
      };
      // ADR-081: mail that came by address alone is answered FROM the address it was written to —
      // by that ADDRESS (the name is display only: it may have been changed since; the address has not)
      const native = original.direction === 'in' && Boolean(original.from.device && normalizeAddress(original.from.device));
      if (original.direction === 'in' && original.myAddress) {
        input.myAddress = original.myAddress;
        if (native && original.myAgent) input.myAgent = original.myAgent;
      } else if (native) {
        // (only a row a development build filed before the address was recorded) — never answered from a guess
        throw new Error('this message does not record which of your addresses it was written to — write to them instead: morse send <who> "…" --from <name>');
      } else {
        // (ADR-081 review N2) it reached me the old way, i.e. at my first address: answered from it, whatever else they know
        input.firstAddress = true;
      }
      return insertMessage(input, now());
    },

    inbox(query = {}) {
      if (query.take && !query.toSession) throw new Error('inbox take needs a scope (a session) — refusing to mark every message delivered');
      const conditions: string[] = [];
      const values: unknown[] = [];
      const where = (sql: string, ...params: unknown[]): void => {
        conditions.push(sql);
        values.push(...params);
      };
      const status = inboxStatusFilter(query);
      if (status) where(status.sql, ...status.params);
      if (query.toSession) where('to_session = ?', query.toSession);
      if (query.toAgent) where('to_agent = ?', query.toAgent);
      if (query.excludeForeign) where(`NOT ${FOREIGN_NOT_OWN_SQL}`);
      // a pull only takes mail received here: an outbound row (to_device set) keeps its retries
      if (query.take) where('to_device IS NULL');
      const sql = `SELECT * FROM messages${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at ASC`;
      const rows = db.prepare(sql).all(...values) as MessageRow[];

      // The clock is read lazily, at most once: a mailbox without leases reads it only when it marks
      // something taken (as before ADR-089), and a caller's clock may count its readings.
      let clockRead: number | undefined;
      const at = (): number => (clockRead ??= now());
      // (ADR-089) a dead-lease query keeps only rows whose lease really is dead; a take never returns —
      // never marks — a row whose lease is live, since its holder's turn may still be running
      const kept = rows.filter((r) => (query.deadLeaseOnly ? leaseDead(r, at()) : !(query.take && r.lease_holder && leaseLive(r, at()))));
      // set aside by a restart, or taken over from a gone holder after it had started a turn: it may already
      // have been handled (a claim no turn was started for is no repeat — review F3)
      const maybeHandled = new Set(kept.filter((r) => query.strandedOnly || (query.deadLeaseOnly && r.lease_started_at != null)).map((r) => r.id));
      const messages = kept.map((r) => (maybeHandled.has(r.id) ? { ...toMessage(r), possibleRepeat: true } : toMessage(r)));
      if (!query.take || messages.length === 0) return messages;

      const markTaken = db.prepare(
        `UPDATE messages SET status = 'delivered', updated_at = ?, takeovers = takeovers + ?, ${CLEAR_LEASE} WHERE id = ? AND to_device IS NULL AND status IN ('pending', 'delivering', 'failed', 'dead')`,
      );
      const takenAt = at();
      for (const m of messages) {
        markTaken.run(takenAt, maybeHandled.has(m.id) ? 1 : 0, m.id);
        processedMark.run(takenAt, 'pull', m.id);
        delete m.lease;
      }
      return messages;
    },

    getMessage,

    listConversations() {
      return (listConversationRows.all() as ConversationRow[]).map((row) => {
        const { id, created_at: createdAt, last_message_at: lastMessageAt, message_count: messageCount } = row;
        const a = endpoint(row.a_agent, row.a_session, row.a_device);
        const b = endpoint(row.b_agent, row.b_session, row.b_device);
        const newest = newestInConversation.get(id) as MessageRow | undefined;
        const summary: ConversationSummary = { id, a, b, createdAt, lastMessageAt, messageCount };
        return newest === undefined ? summary : { ...summary, lastMessage: toMessage(newest) };
      });
    },

    listMessages(conversationId) {
      return (messagesInConversation.all(conversationId) as MessageRow[]).map(toMessage);
    },

    retry(id) {
      const { status } = mustGet(id);
      const retryable: MessageStatus[] = ['failed', 'dead'];
      if (!retryable.includes(status)) throw new Error(`only failed/dead messages can be retried (status: ${status})`);
      // a fresh start: no attempts counted, no longer waiting for an unreachable recipient
      db.prepare(`UPDATE messages SET status = 'pending', attempts = 0, waiting = 0, updated_at = ? WHERE id = ?`).run(now(), id);
      return mustGet(id, 'update failed');
    },

    toMailbox(id: string, note?: string, holder?: string): boolean {
      // (ADR-089) a row held under a lease is moved only by its holder; a caller that names a holder must be it
      // (review F6) checked and changed in one write transaction — and the holder is in the UPDATE itself
      return db
        .transaction((): boolean => {
          const held = getMessage(id);
          if (held && (held.lease || holder !== undefined) && !(held.status === 'delivering' && holderOk(held, holder))) return false;
          return (
            db
              .prepare(
                `UPDATE messages SET to_session = 'inbox', status = 'pending', attempts = 0, waiting = 0, last_error = ?, updated_at = ?, ${CLEAR_LEASE}
                 WHERE id = ? AND to_device IS NULL AND to_agent != 'user' AND lease_holder IS ?`,
              )
              .run(note ?? null, now(), id, holder ?? null).changes > 0
          );
        })
        .immediate();
    },

    recoverStale(onlyLocal?: boolean): number {
      // (ADR-089) a row held under a LEASE is not touched: whether its holder is still at it is the lease's to say
      // (live: nobody takes it; dead: the next claim, or a pull by its session, takes it over). What is set aside
      // here is what was claimed without one — the daemon's own outbound deliveries, a plugin that asks for none.
      // (the holder may still be running — a plugin of the run before finishing its turn: its ack / nack is still
      // taken afterwards, see `stranded`; a pull for the session takes the message too, see `strandedOnly`)
      const localOnly = onlyLocal ? ` AND to_device IS NULL AND to_agent != 'user'` : '';
      const setAside = db.prepare(`UPDATE messages SET status = 'failed', last_error = ?, updated_at = ? WHERE status = 'delivering' AND lease_holder IS NULL${localOnly}`);
      return setAside.run(STRANDED_NOTE, now()).changes;
    },

    recentActivity(sessionId, sinceMs, limit = 10) {
      // to the session, or sent by it — where "by it" can only be our own mail, never another person's claim
      const touching = db.prepare(
        `SELECT * FROM messages WHERE updated_at > @since AND (to_session = @session OR (from_session = @session AND NOT ${FOREIGN_SQL}))
         ORDER BY created_at ASC LIMIT @limit`,
      );
      return (touching.all({ session: sessionId, since: sinceMs, limit }) as MessageRow[]).map(toMessage);
    },

    foreignWaiting(sinceMs: number): Message[] {
      const rows = db
        .prepare(
          `SELECT * FROM messages WHERE ${FOREIGN_NOT_OWN_SQL} AND to_device IS NULL AND status IN ('pending', 'failed', 'dead') AND created_at > ?
           ORDER BY created_at ASC`,
        )
        .all(sinceMs) as MessageRow[];
      return rows.map(toMessage);
    },

    markReceipt(id: string, at?: number): boolean {
      return db.prepare('UPDATE messages SET receipt_at = ? WHERE id = ?').run(at ?? now(), id).changes > 0;
    },

    firstSeen(fromId: string, msgId: string): boolean {
      return db.prepare('INSERT OR IGNORE INTO inbound_seen (from_id, msg_id, seen_at) VALUES (?, ?, ?)').run(fromId, msgId, now()).changes > 0;
    },

    forgetSeen(fromId: string, msgId: string): void {
      db.prepare('DELETE FROM inbound_seen WHERE from_id = ? AND msg_id = ?').run(fromId, msgId);
    },

    hasSeen(fromId: string, msgId: string): boolean {
      return db.prepare('SELECT 1 FROM inbound_seen WHERE from_id = ? AND msg_id = ?').get(fromId, msgId) !== undefined;
    },

    markUndelivered(id: string, error: string, opts?: { retry?: boolean }): boolean {
      const retry = Boolean(opts?.retry);
      return (
        db
          .prepare(
            `UPDATE messages SET status = ?, waiting = ?, last_error = ?, updated_at = ?
             WHERE id = ? AND to_device IS NOT NULL AND receipt_at IS NULL AND status IN ('delivered', 'failed', 'pending')`,
          )
          .run(retry ? 'failed' : 'dead', retry ? 1 : 0, error, retry ? 0 : now(), id).changes > 0
      );
    },

    pruneSeen(beforeMs: number): number {
      return db.prepare('DELETE FROM inbound_seen WHERE seen_at < ?').run(beforeMs).changes;
    },

    nudge(id: string): boolean {
      return db.prepare(`UPDATE messages SET updated_at = 0 WHERE id = ? AND status = 'failed' AND waiting = 1`).run(id).changes > 0;
    },

    requestMessages(handle: string, my?: string | null): Message[] {
      const h = handle.trim().toLowerCase();
      const from = sentFrom(my);
      return (db.prepare(`SELECT * FROM messages WHERE request = 1 AND ${toHandle}${from.sql} ORDER BY created_at ASC`).all(h, h, h, ...from.params) as MessageRow[]).map(toMessage);
    },

    requests,

    markRequest(id: string): boolean {
      return db.prepare('UPDATE messages SET request = 1 WHERE id = ?').run(id).changes > 0;
    },

    requestAccepted(handle: string, my?: string | null): number {
      const h = handle.trim().toLowerCase();
      const from = sentFrom(my);
      db.prepare(`UPDATE messages SET request = 0 WHERE request = 1 AND ${toHandle}${from.sql}`).run(h, h, h, ...from.params);
      // held back while waiting for them: retry on the dispatcher's next tick
      return db
        .prepare(`UPDATE messages SET updated_at = 0 WHERE status = 'failed' AND waiting = 1 AND ${toHandle}${from.sql}`)
        .run(h, h, h, ...from.params).changes;
    },

    requestPending(): Array<{ to: string; my: string }> {
      const rows = db.prepare(`SELECT DISTINCT lower(to_device) AS d, COALESCE(my_address, '') AS m FROM messages WHERE request = 1 AND to_device IS NOT NULL`).all() as Array<{ d: string; m: string }>;
      const seen = new Set<string>();
      return rows.flatMap((r) => {
        const pair = { to: r.d.split('/')[0]!, my: contacts.mine(r.m) };
        const key = `${pair.to}\n${pair.my}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [pair];
      });
    },

    requestPendingHandles(): string[] {
      const rows = db.prepare('SELECT DISTINCT lower(to_device) AS d FROM messages WHERE request = 1 AND to_device IS NOT NULL').all() as Array<{ d: string }>;
      return [...new Set(rows.map((r) => r.d.split('/')[0]!))];
    },

    hasInboundFrom(device: string, my?: string | null): boolean {
      const at = sentFrom(my);
      return db.prepare(`SELECT 1 FROM messages WHERE from_device = ? AND direction = 'in'${at.sql} LIMIT 1`).get(device, ...at.params) !== undefined;
    },

    inboundTargets(device: string): Array<{ myAddress?: string; myAgent?: string }> {
      const rows = db.prepare(`SELECT DISTINCT my_address AS a, agent AS n FROM messages WHERE from_device = ? AND direction = 'in'`).all(device) as Array<{ a: string | null; n: string | null }>;
      return rows.map((r) => ({ ...(r.a ? { myAddress: r.a } : {}), ...(r.n ? { myAgent: r.n } : {}) }));
    },

    sendersRecordedSince(daemonStarting?: boolean): number {
      const read = (): number | null => {
        const v = contacts.mark(SENDERS_RECORDED_MARK);
        return v === null ? null : Number(v) || 0;
      };
      const have = read();
      if (have !== null || !daemonStarting) return have ?? 0;
      const t = now();
      db.prepare('INSERT INTO migration_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(SENDERS_RECORDED_MARK, String(t), t);
      return read() ?? 0;
    },

    withdraw(id: string, reason: string): boolean {
      return db.prepare(`UPDATE messages SET status = 'dead', waiting = 0, last_error = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND to_device IS NOT NULL`).run(reason, now(), id).changes > 0;
    },

    setMyAddress(id: string, address: string): boolean {
      const a = normalizeAddress(address);
      if (!a) return false;
      return db.prepare(`UPDATE messages SET my_address = ? WHERE id = ? AND (my_address IS NULL OR my_address = '') AND direction = 'out'`).run(a, id).changes > 0;
    },

    contacts,

    todo(q: TodoQuery = {}): Message[] {
      const clauses = [TODO];
      const params: unknown[] = [];
      if (q.contactId) {
        // (ADR-083 review R3) by the pair, never by the bare id
        const pair = ofPair(q.contactId);
        clauses.push(`contact_id = ?${pair.sql}`);
        params.push(q.contactId, ...pair.params);
      }
      if (q.agent) {
        clauses.push('agent = ?');
        params.push(q.agent);
      }
      const rows = db.prepare(`SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, rowid ASC${q.limit ? ` LIMIT ${Math.max(1, Math.floor(q.limit))}` : ''}`).all(...params) as MessageRow[];
      return rows.map(toMessage);
    },

    unread(my?: string | null): Record<string, number> {
      // (ADR-083 review R3) counted per (contact id, the address of mine the row records), then matched with the
      // contact that has the id: a row of another address of mine than its contact's counts for nobody
      const rows = db
        .prepare(
          `SELECT m.contact_id AS c, COALESCE(m.my_address, '') AS a, m.direction = 'internal' AS own, k.id AS kid, COALESCE(k.my_address, '') AS kmy, COUNT(*) AS n
             FROM messages m LEFT JOIN contacts k ON k.id = m.contact_id WHERE ${TODO} GROUP BY 1, 2, 3`,
        )
        .all() as Array<{ c: string | null; a: string; own: number; kid: string | null; kmy: string; n: number }>;
      const want = my === undefined ? undefined : contacts.mine(my);
      const out: Record<string, number> = {};
      for (const r of rows) {
        const id = r.c ?? SELF_CONTACT;
        const mine = contacts.mine(r.a);
        // yourself (and mail between your own sessions): the first address's; a removed contact's: the row's own address
        const at = id === SELF_CONTACT || r.own ? '' : r.kid === null ? mine : r.kmy;
        if (r.kid !== null && id !== SELF_CONTACT && !r.own && mine !== r.kmy) continue;
        if (want !== undefined && at !== want) continue;
        out[id] = (out[id] ?? 0) + r.n;
      }
      return out;
    },

    history(contactId: string, q: HistoryQuery = {}): Message[] {
      const limit = q.limit && q.limit > 0 ? Math.floor(q.limit) : 50;
      // (ADR-083 review R3) by the pair, never by the bare id
      const pair = ofPair(contactId);
      const rows = db
        .prepare(`SELECT * FROM messages WHERE contact_id = ?${pair.sql} ${q.before ? 'AND created_at < ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`)
        .all(contactId, ...pair.params, ...(q.before ? [q.before] : [])) as MessageRow[];
      return rows.reverse().map(toMessage);
    },

    contactOf,

    addressOf(m): string {
      if (m.direction === 'internal') return '';
      const c = contactOf(m);
      return c ? (c.id === SELF_CONTACT ? '' : c.myAddress) : m.contactId === SELF_CONTACT ? '' : contacts.mine(m.myAddress);
    },

    markProcessed(ids: string[], by: string): string[] {
      const ts = now();
      const done: string[] = [];
      const deliver = db.prepare(`UPDATE messages SET status = 'delivered', updated_at = ? WHERE id = ? AND to_device IS NULL AND status IN ('pending', 'failed', 'dead')`);
      db.transaction(() => {
        for (const id of ids) {
          const before = getMessage(id);
          if (!before || before.processedAt !== undefined) continue;
          if (processedMark.run(ts, by, id).changes > 0) {
            // handled: nothing delivers it later and pull / hooks do not show it again
            deliver.run(ts, id);
            done.push(id);
          }
        }
      })();
      return done;
    },

    receivedAfter(seq: number, limit = 100): Array<Message & { seq: number }> {
      const rows = db
        .prepare(`SELECT rowid AS seq, * FROM messages WHERE rowid > ? AND direction IN ('in', 'internal') AND to_device IS NULL ORDER BY rowid ASC LIMIT ?`)
        .all(seq, limit) as Array<MessageRow & { seq: number }>;
      return rows.map((r) => ({ ...toMessage(r), seq: r.seq }));
    },

    seqOf(id: string): number {
      const r = db.prepare('SELECT rowid AS s FROM messages WHERE id = ?').get(id) as { s: number } | undefined;
      return r?.s ?? 0;
    },

    seqAt(ms: number): number {
      const r = db.prepare('SELECT MAX(rowid) AS s FROM messages WHERE created_at <= ?').get(ms) as { s: number | null };
      return r.s ?? 0;
    },

    release(id: string, holder?: string): boolean {
      // (ADR-089) a row held under a lease is handed back only by its holder
      return db
        .transaction((): boolean => {
          const held = getMessage(id);
          if (held && (held.lease || holder !== undefined) && !(held.status === 'delivering' && holderOk(held, holder))) return false;
          return (
            db
              .prepare(
                `UPDATE messages SET status = CASE WHEN attempts = 0 THEN 'pending' ELSE 'failed' END, ${CLEAR_LEASE}
                 WHERE id = ? AND (status = 'delivering' OR (status = 'failed' AND last_error = ?)) AND lease_holder IS ?`,
              )
              .run(id, STRANDED_NOTE, holder ?? null).changes > 0
          );
        })
        .immediate();
    },

    claimById(id: string, wanted?: LeaseRequest): Message | null {
      const lease = withStart(wanted);
      const look = lookUp();
      // (review F6) a write transaction from its first statement: of several processes claiming one row at the
      // same moment one gets it and the others wait, look, and get null — never "database is locked"
      const claim = db.transaction((): Message | null => {
        const t = now();
        const row = db
          .prepare(`SELECT * FROM messages WHERE id = ? AND to_device IS NULL AND to_agent != 'user' AND to_session != 'inbox' AND NOT ${FOREIGN_NOT_OWN_SQL}`)
          .get(id) as MessageRow | undefined;
        if (!row) return null;
        const due = row.status === 'pending' || (row.status === 'failed' && !row.waiting && row.attempts < MAX_ATTEMPTS && row.updated_at <= t - RETRY_BACKOFF_MS);
        // (ADR-089) or: still 'delivering', and its lease is dead — taken over
        const takeover = row.status === 'delivering' && leaseDead(row, t, look);
        if (!due && !takeover) return null;
        // (review F5) one delivery per session at a time: a turn still running for this session — also one left
        // behind by a plugin that is gone — holds it
        if (lease && busySessions(t, look).has(`${row.to_agent}\0${row.to_session}`)) return null;
        return takeRow(row, t, lease, takeover);
      });
      return claim.immediate();
    },

    claimNextPending(opts: ClaimOptions = {}): Message | null {
      const lease = withStart(opts.lease);
      const opts2: ClaimOptions = lease ? { ...opts, lease } : opts;
      const look = lookUp();
      const claimOldestDue = (): Message | null => {
        const t = now();
        // Morse: a message that waited the whole window for an unreachable person gives up
        db.prepare(
          `UPDATE messages SET status = 'dead', waiting = 0, updated_at = ?,
             last_error = 'gave up: recipient unreachable for ' || ? || ' days — ' || COALESCE(last_error, '')
           WHERE status = 'failed' AND waiting = 1 AND created_at <= ?`,
        ).run(t, String(Math.round(waitMaxMs / 86_400_000)), t - waitMaxMs);
        // ADR-044: what the row alone decides is filtered in SQL (pull-only sessions);
        // the rest (live / monitored sessions) is checked page by page, oldest first, so
        // no number of passed-over rows can hide a later deliverable one.
        const pullOnly = [...(opts2.pullOnlySessions ?? []), ...(opts2.skipSessions ?? [])];
        const skipIds = opts2.skipIds ?? [];
        const scope =
          opts2.scope === 'outbound'
            ? `AND (to_device IS NOT NULL OR to_agent = 'user')`
            : opts2.scope === 'local'
              ? `AND to_device IS NULL AND to_agent != 'user'`
              : '';
        const page = db.prepare(
          `SELECT rowid AS seq, * FROM messages
           WHERE (status = 'pending'
              OR (status = 'failed' AND waiting = 0 AND attempts < ? AND updated_at <= ?)
              OR (status = 'failed' AND waiting = 1 AND updated_at <= ?)
              -- ADR-089: still 'delivering' under a lease that has expired — taken over once its process is gone too
              OR (status = 'delivering' AND lease_holder IS NOT NULL AND lease_expires_at <= ?))
             -- Morse (ADR-048): mail from another person — any device whose tier is not
             -- owner, unknown included — is never headless-delivered, resumed or woken;
             -- except (ADR-071) a reply in a thread one of our sessions started, to it
             AND NOT ${FOREIGN_NOT_OWN_SQL}
             ${scope}
             ${pullOnly.length ? `AND NOT (to_device IS NULL AND to_session IN (${pullOnly.map(() => '?').join(', ')}))` : ''}
             ${skipIds.length ? `AND id NOT IN (${skipIds.map(() => '?').join(', ')})` : ''}
             AND (created_at > ? OR (created_at = ? AND rowid > ?))
           ORDER BY created_at ASC, rowid ASC LIMIT ${CLAIM_PAGE}`,
        );
        let after = { created: Number.MIN_SAFE_INTEGER, seq: 0 };
        // (review F5) a claim under a lease never takes a message for a session another leased delivery is
        // running for — the lane lock of a plugin dies with the plugin, the turn it left behind does not
        const busy = opts2.lease ? busySessions(t, look) : null;
        for (;;) {
          const rows = page.all(MAX_ATTEMPTS, t - RETRY_BACKOFF_MS, t - waitRetryMs, t, ...pullOnly, ...skipIds, after.created, after.created, after.seq) as Array<MessageRow & { seq: number }>;
          for (const row of rows) {
            if (opts2.skip?.(row.to_session, row.to_device)) continue;
            const takeover = row.status === 'delivering';
            if (takeover && !leaseDead(row, t, look)) continue; // (ADR-089) its holder may still report
            if (busy?.has(`${row.to_agent}\0${row.to_session}`) && row.to_device === null) continue;
            // (the clock is read a second time here, as it always was: for the moment the row is taken)
            const got = takeRow(row, now(), opts2.lease, takeover);
            if (got) return got;
          }
          if (rows.length < CLAIM_PAGE) return null;
          const last = rows[rows.length - 1]!;
          after = { created: last.created_at, seq: last.seq };
        }
      };
      return db.transaction(claimOldestDue).immediate();
    },

    extendLease(id: string, holder: string, opts3: { ttlMs?: number; pid?: number; started?: boolean; maxMs?: number } = {}): boolean {
      const t = now();
      const start = opts3.pid !== undefined ? pidStart(opts3.pid) : null;
      return (
        db
          .prepare(
            `UPDATE messages SET lease_expires_at = ?,
               lease_pid = COALESCE(?, lease_pid), lease_pid_start = CASE WHEN ? IS NULL THEN lease_pid_start ELSE ? END,
               lease_started_at = CASE WHEN ? = 1 THEN COALESCE(lease_started_at, ?) ELSE lease_started_at END,
               lease_hard_until = COALESCE(?, lease_hard_until)
             WHERE id = ? AND status = 'delivering' AND lease_holder = ?`,
          )
          .run(t + (opts3.ttlMs ?? LEASE_TTL_MS), opts3.pid ?? null, opts3.pid ?? null, start, opts3.started ? 1 : 0, t, opts3.maxMs !== undefined ? t + opts3.maxMs : null, id, holder).changes > 0
      );
    },

    liveLeases(): Message[] {
      const t = now();
      const rows = db.prepare(`SELECT * FROM messages WHERE status = 'delivering' AND lease_holder IS NOT NULL ORDER BY created_at ASC`).all() as MessageRow[];
      return rows.filter((r) => leaseLive(r, t)).map(toMessage);
    },

    markDelivered(id: string, opts?: { inSession?: boolean; holder?: string; by?: string }): Message {
      // (review F6) the check and the change are one write transaction, and the holder is in the UPDATE itself
      return db.transaction((): Message => markDeliveredNow(id, opts)).immediate();
    },

    markFailed(id: string, error: string, opts?: { terminal?: boolean; waiting?: boolean; holder?: string }): Message {
      return db.transaction((): Message => markFailedNow(id, error, opts)).immediate();
    },
  };

  /**
   * The row `id`, provided `holder` may report its outcome now (otherwise throws, nothing changed).
   * (ADR-089) A row held under a lease takes reports from its current holder only, and a caller that names a
   * holder must be holding the row right now — so a holder that was taken over, or reports twice, is refused.
   * A row without a lease must be mid-delivery — or (ADR-087 follow-up 5) set aside by a restart while its
   * holder, a plugin of the previous run still finishing, kept going and nobody has claimed it since.
   */
  function reportable(id: string, holder: string | undefined, outcome: 'delivered' | 'failed'): Message {
    const current = mustGet(id);
    const underLease = current.lease !== undefined || holder !== undefined;
    if (underLease && (current.status !== 'delivering' || !holderOk(current, holder))) {
      throw lost(id, outcome === 'delivered' ? 'the ack' : 'the nack');
    }
    if (!underLease && current.status !== 'delivering' && !stranded(current)) {
      throw new Error(`illegal transition: ${current.status} -> ${outcome} (must claim first)`);
    }
    return current;
  }

  function markDeliveredNow(id: string, opts?: { inSession?: boolean; holder?: string; by?: string }): Message {
    reportable(id, opts?.holder, 'delivered');
    const done = db
      .prepare(`UPDATE messages SET status = 'delivered', delivered_in_session = ?, waiting = 0, interrupted = 0, updated_at = ?, ${CLEAR_LEASE} WHERE id = ? AND lease_holder IS ?`)
      .run(opts?.inSession ? 1 : null, now(), id, opts?.holder ?? null);
    if (done.changes === 0) throw lost(id, 'the ack');
    // a received message the dispatcher delivered into a session is processed (ADR-049)
    processedMark.run(now(), opts?.by ?? 'dispatcher', id);
    return mustGet(id, 'update failed');
  }

  function markFailedNow(id: string, error: string, opts?: { terminal?: boolean; waiting?: boolean; holder?: string }): Message {
    const { attempts } = reportable(id, opts?.holder, 'failed');
    const outcome = afterFailure(attempts + 1, Boolean(opts?.terminal), Boolean(opts?.waiting));
    // (review F4) a holder that REPORTS ends the run of interrupted turns: `interrupted` starts again at 0
    const done = db
      .prepare(`UPDATE messages SET status = ?, attempts = ?, last_error = ?, waiting = ?, interrupted = 0, updated_at = ?, ${CLEAR_LEASE} WHERE id = ? AND lease_holder IS ?`)
      .run(outcome.status, attempts + 1, error, outcome.waiting ? 1 : 0, now(), id, opts?.holder ?? null);
    if (done.changes === 0) throw lost(id, 'the nack');
    return mustGet(id, 'update failed');
  }
}
