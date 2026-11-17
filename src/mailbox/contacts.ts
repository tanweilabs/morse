import { nameAsKept, sameName } from '../name-key.js';
import type { Db } from './db.js';
import { looksLikeAddress, normalizeAddress } from '../identity/address.js';

/**
 * Contacts (ADR-049): one row per PERSON — their address (handle), a local remark name,
 * a free-form group label, their state (active / blocked) and the agents of theirs we
 * have seen. The owner is the contact `self` (group `self`); anyone accepted or added
 * gets group `other` until the owner labels them. The core stores the group label and
 * never decides anything by it — that is for plugins (docs/PLUGINS.md).
 *
 * Every message belongs to exactly one contact (messages.contact_id): another person's
 * for mail to / from them, `self` for mail between our own sessions and devices.
 */

export const SELF_CONTACT = 'self';
export const SELF_GROUP = 'self';
export const DEFAULT_GROUP = 'other';
/** ADR-077: `contacts.origin` of a contact the migration made from one of your own paired computers. */
export const OWN_DEVICE = 'own-device';
/**
 * (ADR-091) The group your own computers paired the old way are in since v2 was removed (they were in `self`):
 * ordinary contacts, with no authority but the permissions you give the contact or the group.
 */
export const MINE_GROUP = 'mine';

export type ContactState = 'active' | 'blocked';

export interface Contact {
  id: string;
  /**
   * (ADR-083) WHICH of this computer's addresses this contact belongs to: '' = its first address (every
   * contact by old handle, yourself, your own computers — and everything a computer with one address
   * has), else the 26-character address. The same person can be a contact of two of your addresses:
   * two rows that share nothing (remark, group, permissions, history, block).
   */
  myAddress: string;
  /** Bare lowercase v2 handle (morse.im/<handle>) — since ADR-077 a frozen old name that several
   *  contacts may share (one per agent / address of that person); null for an address-only contact
   *  and for `self` before joining Morse. */
  handle: string | null;
  /** ADR-077: the old agent name under `handle` this contact IS (null = the handle itself / its default agent). */
  agent: string | null;
  /** ADR-077: this contact's identity-v3 address, once known. */
  address: string | null;
  /** The owner's local name for them (unique, case-insensitive). */
  remark: string | null;
  /** Legacy (ADR-036): no longer written or shown — names are your remarks (ADR-065). */
  nickname: string | null;
  group: string;
  state: ContactState;
  /** Their agents we have exchanged messages with (or added by hand), most recent first. */
  agents: string[];
  /** ADR-073: their identity-v3 addresses we have seen (one per computer of theirs), most recent first. */
  addresses: string[];
  /** ADR-077: `pending` = the agents under this handle were not checked with the relay yet. */
  split: 'pending' | 'done' | null;
  /** ADR-077: `own-device` = made by the migration from one of your own paired computers. */
  origin: string | null;
  /** ADR-077: the remark of the contact this one was split from (per-remark settings still apply to it). */
  inherits: string | null;
  /**
   * (ADR-091) How this contact was written in v2 (`handle` or `handle/agent`) — kept when it became a contact by
   * address: shown, and a key per-contact settings written by old name are found by. Never an address to send to.
   */
  oldName: string | null;
  /**
   * (ADR-091 follow-up) Further keys per-contact settings may have been written under before the upgrade, looked at
   * after the contact's own: the handle of its old name, a remark it lost when an old row was merged into it.
   */
  oldKeys: string[];
  createdAt: number;
  updatedAt: number;
}

/** ADR-077: one device from the v2 trust list, with the v3 address of its key when its certificate is pinned. */
export interface KnownDevice {
  id: string;
  name: string;
  tier: 'owner' | 'peer';
  address: string | null;
}

/** ADR-077: one agent of a handle, as the relay's alias table (or the v2 directory) names it. */
export interface SplitEntry {
  agent: string;
  address: string;
  default?: boolean;
  deviceId?: string | null;
}

/** Who we are, for sorting messages into contacts. Everything optional: tests and a fresh install know nothing. */
export interface ContactContext {
  /** Our own handle (relay.handle), lowercase. */
  selfHandle?: () => string | null;
  /** Tier of a LAN-era device name from trusted-devices.json — owner devices are `self`. */
  deviceTier?: (name: string) => 'owner' | 'peer' | undefined;
  /** This computer's own Morse agent (relay.agent). */
  primaryAgent?: () => string | null;
  /** Is this handle blocked (morse-blocked.json — what the transport obeys). */
  isBlocked?: (handle: string) => boolean;
  /** For the v2 migration: every blocked handle, peer device names (handles). */
  blockedHandles?: () => string[];
  peerNames?: () => string[];
  /** ADR-077: the v2 trust list with each device's v3 address (null = certificate not pinned here). */
  devices?: () => KnownDevice[];
  /** (ADR-083) This computer's first address (the device key's); null = no key yet. Stored as ''. */
  firstAddress?: () => string | null;
  /** (ADR-091) The address of a device whose certificate is pinned here (peer-keys.json), trusted or not; null = none. */
  pinnedAddress?: (deviceId: string) => string | null;
  /**
   * (ADR-083 review R2) Every address this computer has right now (`morse address`: its first and the ones of
   * its other agents), read only — nothing is created. THROWS when that cannot be read (a damaged
   * agents.json) — unless this computer holds no key but the device's: it has one address then, and none
   * needs listing (review N1). Only the v4 migration asks: a block from before it is kept at each of them.
   */
  ownAddresses?: () => string[];
}

/**
 * ADR-077: the contacts table since schema v3 — `handle` is no longer unique (see CONTACT_INDEXES).
 * (ADR-083, schema v4) `my_address`: the address of THIS computer the row belongs to — '' = its first
 * address (what a row written without it means: a morse of the release before, still running), else
 * the 26-character address. `known_as` is no longer read: it is kept, equal to `my_address`, only so
 * that a daemon of the release before does not fail on a missing column.
 */
export const CONTACTS_TABLE = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  my_address TEXT NOT NULL DEFAULT '',
  handle TEXT,
  agent TEXT,
  address TEXT,
  remark TEXT,
  nickname TEXT,
  group_label TEXT NOT NULL DEFAULT 'other',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'blocked')),
  split TEXT,
  origin TEXT,
  inherits TEXT,
  known_as TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
// (ADR-083) a remark stays unique on the whole computer; handle / address are unique per address of mine.
// The index names are the ones of schema v3 on purpose: an older morse's `CREATE … IF NOT EXISTS` is then a no-op.
export const CONTACT_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS contacts_remark ON contacts(lower(remark)) WHERE remark IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_handle_agent ON contacts(my_address, handle, COALESCE(agent, '')) WHERE handle IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_address ON contacts(my_address, address) WHERE address IS NOT NULL;
`;
/**
 * (ADR-083) Blocks by address, per address of mine: `my_address` ('' = this computer's first address)
 * no longer takes mail from `address`. Mail by address alone looks only here (and at the contact row);
 * morse-blocked.json keeps the old handles, which are the first address's business.
 */
export const SCHEMA_BLOCKS = `
CREATE TABLE IF NOT EXISTS address_blocks (
  my_address TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (my_address, address)
);
`;
export const SCHEMA_V2 = `
${CONTACTS_TABLE}
${CONTACT_INDEXES}
CREATE TABLE IF NOT EXISTS contact_agents (
  contact_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (contact_id, agent)
);
CREATE TABLE IF NOT EXISTS migration_marks (
  key TEXT PRIMARY KEY,
  value TEXT,
  at INTEGER NOT NULL
);
`;

/**
 * ADR-073 (identity v3 phase 1): the v3 addresses of a contact — one per computer of theirs
 * (in P1 an address is a device key's), recorded when a message from or to that device
 * goes through. Purely additive (a new table, created idempotently on every open like the
 * additive columns), so no user_version bump and no backup; splitting contacts by address
 * is the P2 migration.
 */
export const SCHEMA_ADDRESSES = `
CREATE TABLE IF NOT EXISTS contact_addresses (
  address TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  device_id TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_addresses ON contact_addresses(contact_id, last_seen);
`;

/**
 * The verbs `morse contact` dispatches on (ADR-074): `morse contact <who>` would run the verb
 * instead of showing a contact with such a remark. Keep in step with registerMessagingCommands.
 */
export const CONTACT_VERBS: readonly string[] = ['add', 'set', 'remove', 'accept', 'reject', 'block', 'unblock'];

/**
 * A remark may not look like an address (spec §3.2): then `<who>` can always be told apart;
 * nor be a `morse contact` verb, any case (ADR-074).
 */
export function checkRemark(remark: string): void {
  const r = remark.trim();
  if (CONTACT_VERBS.includes(r.toLowerCase())) throw new Error(`"${r}" is a command word — pick another remark`);
  if (looksLikeAddress(remark)) throw new Error(`the name "${r}" looks like an address (26 characters of the address alphabet) — pick another name`);
}

/** Columns v2 adds to messages (ADR-049). */
export const MESSAGE_COLUMNS_V2: Array<[string, string]> = [
  ['direction', 'TEXT'], // 'in' | 'out' | 'internal'
  ['contact_id', 'TEXT'],
  ['agent', 'TEXT'], // MY agent: it was to (in / internal) or from (out)
  ['peer_agent', 'TEXT'], // THEIR agent (in / out), the sending session's agent (internal)
  ['processed_at', 'INTEGER'],
  ['processed_by', 'TEXT'], // owner | agent:<name> | pull | dispatcher | plugin:<name> | migration
];

export const INDEXES_V2 = `
CREATE INDEX IF NOT EXISTS idx_msg_contact ON messages(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_todo ON messages(created_at) WHERE direction != 'out' AND processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_msg_direction ON messages(direction);
`;

export type Direction = 'in' | 'out' | 'internal';

export interface Classified {
  direction: Direction;
  contactId: string;
  agent: string | null;
  peerAgent: string | null;
  /** The handle of the person, when the contact is not self. */
  handle: string | null;
  /** The tier the row should carry (owner for own devices). */
  fromTier: 'owner' | 'peer' | null;
  /** (ADR-083) Which of my addresses the contact belongs to ('' = the first) — the default sender of mail to it. */
  myAddress?: string;
}

interface RowRefs {
  from_agent: string;
  from_device: string | null;
  to_agent: string;
  to_session: string;
  to_device: string | null;
  from_tier: string | null;
}

const split = (device: string): { handle: string; agent: string | null } => {
  const [h, ...rest] = device.trim().replace(/^@/, '').split('/');
  return { handle: (h ?? '').toLowerCase(), agent: rest.length ? rest.join('/') : null };
};

/** Sort one message into direction + contact (pure; the store creates the contact). */
export function classifyRefs(r: RowRefs, ctx: ContactContext, resolve: (handle: string, agent: string | null) => string = (h) => contactIdFor(h)): Classified {
  const me = ctx.selfHandle?.()?.toLowerCase() ?? null;
  const primary = ctx.primaryAgent?.() ?? null;
  const isSelf = (handle: string, tier: string | null): boolean => tier === 'owner' || (me !== null && handle === me) || ctx.deviceTier?.(handle) === 'owner';
  if (r.from_device) {
    const { handle, agent } = split(r.from_device);
    const self = isSelf(handle, r.from_tier) && r.from_tier !== 'peer';
    const mine = r.to_agent === 'user' && r.to_session === 'inbox' ? (primary ?? 'user') : r.to_agent;
    // ADR-077: the agent name is the sender's own claim — it never picks the contact. The transport
    // names the contact by the sender's VERIFIED address (SendInput.contactId); without one it is the
    // handle's base contact, as before contacts were split.
    return { direction: 'in', contactId: self ? SELF_CONTACT : resolve(handle, null), agent: mine, peerAgent: agent, handle: self ? null : handle, fromTier: self ? 'owner' : 'peer' };
  }
  if (r.to_device) {
    const { handle, agent } = split(r.to_device);
    const self = isSelf(handle, null);
    return { direction: 'out', contactId: self ? SELF_CONTACT : resolve(handle, agent), agent: primary ?? r.from_agent, peerAgent: agent, handle: self ? null : handle, fromTier: null };
  }
  return { direction: 'internal', contactId: SELF_CONTACT, agent: r.to_agent, peerAgent: r.from_agent, handle: null, fromTier: null };
}

/**
 * Contact ids: `self`; `c:<handle>` for a person's old v2 handle (= its default agent);
 * since ADR-077 also `c:<handle>/<agent>` (another agent of that handle, split off) and
 * `a:<address>` (an address with no old name).
 */
export const contactIdFor = (handle: string, agent?: string | null): string => `c:${handle.toLowerCase()}${agent ? `/${agent.toLowerCase()}` : ''}`;
/**
 * (ADR-083) `a:<their address>` for a contact of this computer's first address (as before), `a:<their
 * address>~<my address>` for one of another address of mine. Ids are opaque: a contact from before
 * contacts were per address keeps its id whichever address it belongs to — look rows up by
 * (my address, their address), never by taking an id apart.
 */
export const contactIdForAddress = (address: string, my: string = ''): string => (my ? `a:${address}~${my}` : `a:${address}`);

/**
 * (ADR-083) The dedupe key (`inbound_seen.from_id`) of mail that came by address alone: the sender's
 * address for mail written to this computer's first address (as before), `<sender>|<my address>` for
 * mail written to another one — the same message id sent to two of my addresses is two messages.
 */
export const seenKeyFor = (theirs: string, my: string = ''): string => (my ? `${theirs}|${my}` : theirs);

/** (ADR-083) A peer address is a contact (or has a request) at more than one of my addresses: say which. */
export class AmbiguousAddressError extends Error {
  constructor(
    readonly address: string,
    /** The addresses of mine it is a contact of ('' = the first). */
    readonly mine: string[],
  ) {
    super(`morse.im/${address} is a contact of ${mine.length} of your addresses — say which one: --from <name>`);
  }
}

interface ContactRow {
  id: string;
  my_address: string | null;
  handle: string | null;
  agent: string | null;
  address: string | null;
  split: 'pending' | 'done' | null;
  origin: string | null;
  inherits: string | null;
  old_name?: string | null;
  remark: string | null;
  nickname: string | null;
  group_label: string;
  state: ContactState;
  created_at: number;
  updated_at: number;
}

export interface ContactStore {
  list(): Contact[];
  get(id: string): Contact | null;
  /** `handle` or `handle/agent`: that agent's own contact when it was split off, else the handle's. */
  byHandle(handle: string): Contact | null;
  /**
   * A remark (case-insensitive), a v3 address, a contact id, or an old `handle[/agent]`.
   * (ADR-083) An address that is a contact of more than one of my addresses answers null unless `my`
   * says which (never a guess) — `findAll` gives every row.
   */
  find(who: string, my?: string | null): Contact | null;
  /** (ADR-083) Every contact `who` could mean: one, or — for a peer address — one per address of mine it is a contact of. */
  findAll(who: string): Contact[];
  /** (ADR-083) '' for this computer's first address (or nothing), else the address — how `my_address` is stored. */
  mine(address: string | null | undefined): string;
  /** (ADR-083) Tell the store this computer's first address (the transport knows it from the device key). */
  knowFirstAddress(address: string | null): void;
  /** (ADR-083) This computer's first address, when the store knows it. */
  firstAddress(): string | null;
  /** (ADR-083) Is `address` blocked at this address of mine (address_blocks)? */
  isBlockedAt(address: string, my?: string | null): boolean;
  /** (ADR-083) Block / unblock a peer address at one address of mine. `unblock` → true = it was blocked. */
  blockAt(address: string, my?: string | null): void;
  unblockAt(address: string, my?: string | null): boolean;
  /** The self contact (created on first use), its handle kept in step. */
  self(): Contact;
  /** Create the contact for a person if missing (group `other`); returns it. */
  ensure(handle: string, opts?: { group?: string; nickname?: string | null; remark?: string | null }): Contact;
  /**
   * ADR-081: the contact of a bare address — the one whose address it is (or under which it was seen),
   * else a new address-only contact `a:<address>` (no old name, group `other`). The address IS the
   * identity (its key hashes to it), so this needs no network. Only your own word gets here: `contact
   * add`, writing to the address, accepting its message request. Clears a tombstone you left for it.
   * (ADR-083) `my` = the address of mine it becomes a contact OF (default: the first). For another
   * address only the row of exactly that pair counts — what the first address knows is not looked at.
   */
  ensureAddress(address: string, my?: string | null): Contact;
  set(id: string, patch: { remark?: string | null; group?: string; nickname?: string | null; state?: ContactState }): Contact;
  remove(id: string): boolean;
  seenAgent(contactId: string, agent: string, at?: number): void;
  /** ADR-073: a v3 address of this contact (its device), seen now. */
  seenAddress(contactId: string, address: string, deviceId?: string | null, at?: number): void;
  /** ADR-073: the contact a v3 address belongs to — (ADR-083) at this address of mine (default: the first). */
  byAddress(address: string, my?: string | null): Contact | null;
  /** ADR-077: the contact whose OWN address this is (not merely an address seen under a handle). */
  ownerOfAddress(address: string): Contact | null;
  /**
   * ADR-077: the contact inbound mail from an AUTHENTICATED device (its verified address, or its device ID) is filed under,
   * when it is not simply the handle's base contact: the contact whose address it is — one of
   * your own computers moved out of group self, or a contact split off `handle`. undefined =
   * the default sorting (base contact of the handle; `self` for an owner).
   */
  filingContact(sender: { address?: string | null; deviceId?: string | null }, handle: string, tier: 'owner' | 'peer'): string | undefined;
  /** ADR-077: the own-device contact of a device ID (the ID is its certificate's fingerprint), if the migration made one. */
  ownDeviceOf(deviceId: string): Contact | null;
  /** Sort a message into direction + contact, creating the contact (ADR-049). */
  classify(r: RowRefs, opts?: { contactId?: string; /** (ADR-083) the address of mine the mail belongs to, when one is named */ myAddress?: string | null }): Classified;
  /**
   * ADR-077 (N1): is this device one of your own computers that you moved out of group `self`?
   * True while its contact is in another group — and it STAYS true after that contact is removed
   * (the lowered state is kept in migration_marks): removing a contact never raises trust. Only
   * putting the contact (re-added if need be) back into group `self` clears it.
   */
  isLowered(deviceId: string): boolean;
  /**
   * ADR-077 (N2): bring back a contact YOU removed — a split contact (by its address or its
   * `handle/agent`) or one of your own computers (by its address): the tombstone is cleared and the
   * contact made again with the default group, none of its old settings (an own computer that was
   * lowered stays lowered, in group `other`). null = nothing removed answers to `who`. Only an
   * explicit command calls this; nothing a sender does can.
   */
  restore(who: string): Contact | null;
  /** ADR-077: contacts by old handle whose agents were not checked with the relay yet. */
  pendingSplits(): Contact[];
  /**
   * ADR-077: what the relay says lives under this contact's handle — the default agent's
   * address goes on the contact itself, every other agent on ANOTHER address becomes a
   * contact of its own (same group and state, remark `<remark>/<agent>`). null / [] = the
   * relay knows nobody by that handle. One transaction; safe to repeat. Returns the ids created.
   */
  applySplit(contactId: string, entries: SplitEntry[] | null): string[];
  /**
   * ADR-077: one of YOUR OWN paired computers as a contact in group `self` (made once per
   * device — after you remove it, it is not made again; null then). Later calls only fill
   * in what was not known before (its handle / agent name, a remark).
   */
  ensureOwnDevice(d: { deviceId: string; address: string; handle?: string | null; agent?: string | null; name?: string | null }): Contact | null;
  /** ADR-077: the own-device contact of an address, if the migration made one. */
  ownDevice(address: string): Contact | null;
  /** ADR-077: this contact and every other contact sharing its old handle (one person in v2 terms). */
  family(contactId: string): string[];
  /**
   * (ADR-081 review N2) Which of MY addresses this contact knows me by: a 26-character address, '' =
   * this computer's first address, null = nothing was exchanged with it yet. It is whatever the FIRST
   * mail with the contact says — the address their mail was written to (by address: that address; the
   * old way: the first address), or the address I first wrote to them from — and never changes after
   * that: later mail to or from another address of mine does not switch it. Kept in
   * `contacts.known_as` the first time it can be told (also for a contact from before this was kept:
   * from its oldest message). Never for `self`.
   * (ADR-083) Replaced by the row itself: this is now simply the address of mine the contact BELONGS to
   * (`myAddress`: '' = the first) — null only for `self` and for an id nobody has.
   */
  knownAs(id: string): string | null;
  /** ADR-077: migration bookkeeping (backup path, devices already turned into contacts). */
  mark(key: string): string | null;
  setMark(key: string, value: string): void;
}

/** (ADR-091) `self` is you (your own sessions) — never a group of contacts: what `morse contact add|set --group self` says. */
export const SELF_GROUP_REFUSED = `group "self" is you, not a group of contacts — put your own Morse elsewhere in a group of its own, e.g. --group ${MINE_GROUP}, and give it permissions with morse contact set`;

export const normalizeGroup = (g: string): string => {
  const v = g.trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,31}$/u.test(v)) throw new Error(`group label "${g}": 1–32 letters, digits, space, _ . - (starting with a letter or digit)`);
  return v;
};

export function createContactStore(db: Db, opts: { now?: () => number; ctx?: ContactContext } = {}): ContactStore {
  const now = opts.now ?? Date.now;
  const ctx = opts.ctx ?? {};
  const agentsOf = db.prepare('SELECT agent FROM contact_agents WHERE contact_id = ? ORDER BY last_seen_at DESC');
  // (ADR-091 follow-up) written by the v5 repair; a database before it has none
  const oldKeysOf = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contact_old_keys'`).get() ? db.prepare('SELECT key FROM contact_old_keys WHERE contact_id = ? ORDER BY key') : null;
  db.exec(SCHEMA_ADDRESSES);
  try {
    db.exec(SCHEMA_BLOCKS);
  } catch (e) {
    // a database this process may only read: the table is made by the next process that can write
    if ((e as { code?: string }).code !== 'SQLITE_READONLY') throw e;
  }
  const addressesOf = db.prepare('SELECT address FROM contact_addresses WHERE contact_id = ? ORDER BY last_seen DESC');
  /** (ADR-083) This computer's first address, when known — rows of it are stored with my_address ''. */
  let learnedFirst: string | null = null;
  const firstAddress = (): string | null => learnedFirst ?? ctx.firstAddress?.() ?? null;
  const mine = (address: string | null | undefined): string => {
    const a = address ? normalizeAddress(address) : null;
    return !a || a === firstAddress() ? '' : a;
  };
  const hasBlock = (address: string, my: string): boolean => {
    try {
      return Boolean(db.prepare('SELECT 1 FROM address_blocks WHERE my_address = ? AND address = ?').get(my, address));
    } catch {
      return false; // (a read-only database without the table yet)
    }
  };
  const toContact = (row: ContactRow): Contact => {
    // what the transport obeys: for a contact by old handle morse-blocked.json (the first address's business, as
    // before); (ADR-083) for a contact with only an address, the block of exactly this (my address, their address)
    const my = row.my_address ?? '';
    const blocked =
      row.origin === OWN_DEVICE
        ? row.state === 'blocked'
        : row.handle
          ? ctx.isBlocked
            ? ctx.isBlocked(row.handle)
            : row.state === 'blocked'
          : row.state === 'blocked' || Boolean(row.address && hasBlock(row.address, my));
    const seen = (addressesOf.all(row.id) as Array<{ address: string }>).map((a) => a.address);
    return {
      id: row.id,
      myAddress: my,
      handle: row.handle,
      agent: row.agent ?? null,
      address: row.address ?? null,
      remark: row.remark,
      nickname: row.nickname,
      group: row.group_label,
      state: blocked ? 'blocked' : 'active',
      agents: (agentsOf.all(row.id) as Array<{ agent: string }>).map((a) => a.agent),
      addresses: row.address && !seen.includes(row.address) ? [row.address, ...seen] : seen,
      split: row.split ?? null,
      origin: row.origin ?? null,
      inherits: row.inherits ?? null,
      oldName: row.old_name ?? null,
      oldKeys: oldKeysOf ? (oldKeysOf.all(row.id) as Array<{ key: string }>).map((k) => k.key) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
  const getRow = (id: string) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  // (ADR-083) contacts by old handle, yourself and your own computers belong to the first address only:
  // every lookup of the handle / device rules reads the first address's rows and nothing else
  const rowFor = (handle: string, agent: string | null) =>
    db.prepare(`SELECT * FROM contacts WHERE handle = ? AND COALESCE(agent, '') = ? AND my_address = ''`).get(handle, agent ?? '') as ContactRow | undefined;
  /** The contact whose own address this is AT one address of mine ('' = the first). */
  const rowByAddress = (address: string, my: string = '') => db.prepare('SELECT * FROM contacts WHERE address = ? AND my_address = ?').get(address, my) as ContactRow | undefined;
  /** An id for a new contact of (my, their address) that no row has yet. */
  const freeAddressId = (address: string, my: string): string => {
    const id = contactIdForAddress(address, my);
    if (!getRow(id)) return id;
    // (a contact from before ADR-083 that belongs to another address kept the plain id)
    const spare = contactIdForAddress(address, my || firstAddress() || 'first');
    for (let i = 0; ; i++) if (!getRow(i ? `${spare}-${i}` : spare)) return i ? `${spare}-${i}` : spare;
  };
  /**
   * (ADR-083 review R3) The id for a NEW contact of the pair (my address, their address): the id the mail of
   * exactly this pair still carries from a contact that was removed — one of this address's ids
   * (`a:<their address>` / `a:<their address>~…`) on rows of this address of mine, that no contact has —
   * so adding them again at the SAME address of mine finds that history; else a free one. On a computer
   * with one address this is the id it always was (`a:<their address>`).
   */
  const idForPair = (address: string, my: string): string => {
    try {
      const plain = contactIdForAddress(address);
      const of = my ? { sql: 'my_address = ?', params: [my] } : { sql: `(my_address IS NULL OR my_address = '' OR my_address = ?)`, params: [firstAddress() ?? ''] };
      const kept = db
        .prepare(
          `SELECT contact_id AS c FROM messages m WHERE direction IN ('in', 'out') AND (contact_id = ? OR substr(contact_id, 1, ?) = ?) AND ${of.sql}
             AND NOT EXISTS (SELECT 1 FROM contacts k WHERE k.id = m.contact_id) ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(plain, plain.length + 1, `${plain}~`, ...of.params) as { c: string } | undefined;
      if (kept) return kept.c;
    } catch {
      /* a store without the messages table (or without `my_address` yet): a free id, as before */
    }
    return freeAddressId(address, my);
  };
  /**
   * (ADR-083 review R3) A contact of the pair (my address, their address) is about to be made with `id`: no
   * mail of ANOTHER address of mine may be left carrying that id (a removed contact of that address had
   * it — e.g. one that kept the plain id from before contacts were per address). Such rows go to their
   * own pair: its contact when there is one, else that pair's own id (`a:<theirs>~<mine>`; for the first
   * address the plain id, or `a:<theirs>~<first>` when the plain one is taken). So no id is ever shared
   * by two pairs. Runs inside the caller's transaction; a computer with one address has nothing to move.
   */
  const takeId = (id: string, address: string, my: string): void => {
    // (which of my addresses is the first one is not known: rows cannot be told apart — nothing is moved)
    if (!firstAddress()) return;
    let held: Array<{ a: string }>;
    try {
      held = db.prepare(`SELECT DISTINCT COALESCE(my_address, '') AS a FROM messages WHERE contact_id = ? AND direction IN ('in', 'out')`).all(id) as Array<{ a: string }>;
    } catch {
      return; // (no messages table / no `my_address` yet: nothing can carry another address's id)
    }
    for (const { a: raw } of held) {
      const its = mine(raw);
      if (its === my) continue;
      const live = rowByAddress(address, its);
      let to = live?.id ?? contactIdForAddress(address, its);
      if (to === id || (!live && getRow(to))) to = contactIdForAddress(address, its || firstAddress() || 'first');
      if (to === id) continue; // (cannot happen: two different addresses of mine never give the same id)
      db.prepare(`UPDATE messages SET contact_id = ? WHERE contact_id = ? AND COALESCE(my_address, '') = ? AND direction IN ('in', 'out')`).run(to, id, raw);
    }
  };
  /** The first address's contact an address was SEEN under (a computer of someone who is a contact by old name). */
  const seenUnder = (address: string): ContactRow | undefined => {
    const seen = db.prepare('SELECT contact_id FROM contact_addresses WHERE address = ?').get(address) as { contact_id: string } | undefined;
    const row = seen ? getRow(seen.contact_id) : undefined;
    return row && (row.my_address ?? '') === '' ? row : undefined;
  };
  /** The contact a `handle[/agent]` belongs to: that agent's own, else the handle's (which may not exist yet). */
  const resolve = (handle: string, agent: string | null): string => (agent ? rowFor(handle, agent)?.id : undefined) ?? rowFor(handle, null)?.id ?? contactIdFor(handle);
  /** `candidate` when it may be a remark and nobody has it, else null. */
  const freeRemark = (candidate: string | null | undefined, exceptId?: string): string | null => {
    const r = candidate?.trim();
    if (!r) return null;
    try {
      checkRemark(r);
    } catch {
      return null;
    }
    const clash = db.prepare('SELECT id FROM contacts WHERE lower(remark) = lower(?)').get(r) as { id: string } | undefined;
    return clash && clash.id !== exceptId ? null : r;
  };
  /**
   * ADR-077 (C): the remark of a contact split off `row` for its agent — `<remark>/<agent>`, unless that
   * string already means something in a command today (another contact's remark, or the `handle/agent`
   * path of ANOTHER handle): a split never changes what `morse send <string>` reaches. Then the old path
   * `<handle>/<agent>`, then numbered names; null (shown by its address) when nothing is free.
   */
  const splitRemark = (row: ContactRow, agent: string): string | null => {
    const means = (candidate: string): boolean => {
      const head = candidate.split('/')[0]!.toLowerCase();
      // `head/agent` typed today reaches the contact with remark `head`, else the handle `head`
      const byRemark = db.prepare('SELECT id FROM contacts WHERE lower(remark) = ?').get(head) as { id: string } | undefined;
      if (byRemark) return byRemark.id !== row.id;
      const byHandle = db.prepare('SELECT 1 FROM contacts WHERE handle = ? LIMIT 1').get(head);
      return Boolean(byHandle) && head !== row.handle;
    };
    const candidates = [`${row.remark ?? row.handle}/${agent}`, `${row.handle}/${agent}`, ...[2, 3, 4, 5].map((n) => `${row.remark ?? row.handle}/${agent}-${n}`)];
    for (const c of candidates) if (!means(c) && freeRemark(c)) return c;
    return null;
  };
  const getMark = (key: string): string | null => (db.prepare('SELECT value FROM migration_marks WHERE key = ?').get(key) as { value: string | null } | undefined)?.value ?? null;
  const hasMark = (key: string): boolean => Boolean(db.prepare('SELECT 1 FROM migration_marks WHERE key = ?').get(key));
  const dropMark = (key: string) => db.prepare('DELETE FROM migration_marks WHERE key = ?').run(key);
  /** The device IDs recorded for a contact's own address (an own computer has exactly one). */
  const devicesOf = (row: ContactRow): string[] =>
    row.address ? (db.prepare('SELECT device_id FROM contact_addresses WHERE address = ? AND device_id IS NOT NULL').all(row.address) as Array<{ device_id: string }>).map((r) => r.device_id) : [];
  const putMark = (key: string, value: string) =>
    db.prepare('INSERT INTO migration_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value, now());

  const store: ContactStore = {
    list() {
      store.self();
      const rows = db.prepare(`SELECT * FROM contacts ORDER BY id = 'self' DESC, lower(COALESCE(remark, handle, address)) ASC, id ASC`).all() as ContactRow[];
      return rows.map(toContact);
    },
    mine,
    firstAddress,
    knowFirstAddress(address) {
      learnedFirst = address ? normalizeAddress(address) : null;
    },
    isBlockedAt: (address, my) => {
      const a = normalizeAddress(address);
      return Boolean(a && hasBlock(a, mine(my)));
    },
    blockAt(address, my) {
      const a = normalizeAddress(address);
      if (a) db.prepare('INSERT INTO address_blocks (my_address, address, at) VALUES (?, ?, ?) ON CONFLICT(my_address, address) DO NOTHING').run(mine(my), a, now());
    },
    unblockAt(address, my) {
      const a = normalizeAddress(address);
      return Boolean(a) && db.prepare('DELETE FROM address_blocks WHERE my_address = ? AND address = ?').run(mine(my), a).changes > 0;
    },
    get(id) {
      const r = getRow(id);
      return r ? toContact(r) : null;
    },
    byHandle(handle) {
      // ADR-081: a sender known only by its address is found by it (so your remark for it is shown like any other)
      const asAddress = normalizeAddress(handle);
      if (asAddress) {
        // (ADR-083: the first address's contact, else the only one there is — a label, never a decision)
        const all = store.findAll(asAddress);
        const c = store.byAddress(asAddress) ?? (all.length === 1 ? all[0]! : null);
        return c && c.id !== SELF_CONTACT ? c : null;
      }
      const { handle: h, agent } = split(handle.replace(/^(?:[a-z]+:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\//i, ''));
      if (!h) return null;
      const exact = agent ? rowFor(h, agent.toLowerCase()) : undefined;
      if (exact) return toContact(exact);
      const me = ctx.selfHandle?.()?.toLowerCase();
      if (me && h === me && !agent) return store.self();
      const r = rowFor(h, null);
      if (r && !agent) return toContact(r);
      // (ADR-091) a contact by old name that became a contact by address: found by how it was written (the first address's)
      const was = (n: string) => {
        try {
          return db.prepare(`SELECT * FROM contacts WHERE lower(old_name) = lower(?) AND my_address = ''`).get(n) as ContactRow | undefined;
        } catch {
          return undefined; // (a mailbox from before the column)
        }
      };
      const old = (agent ? was(`${h}/${agent}`) : undefined) ?? was(h);
      if (old) return toContact(old);
      if (me && h === me) return store.self();
      return r ? toContact(r) : null;
    },
    findAll(who) {
      const addr = normalizeAddress(who.trim());
      if (!addr) {
        const c = store.find(who);
        return c ? [c] : [];
      }
      const rows = db.prepare(`SELECT * FROM contacts WHERE address = ? ORDER BY my_address = '' DESC, my_address ASC`).all(addr) as ContactRow[];
      const under = seenUnder(addr);
      if (under && !rows.some((r) => (r.my_address ?? '') === '')) rows.unshift(under);
      return rows.map(toContact);
    },
    find(who, my) {
      const w = who.trim();
      if (!w) return null;
      if (w === SELF_CONTACT || w === 'me') return store.self();
      const addr = normalizeAddress(w);
      if (addr) {
        if (my !== undefined && my !== null) return store.byAddress(addr, my);
        const all = store.findAll(addr);
        return all.length === 1 ? all[0]! : null;
      }
      const byRemark =
        (db.prepare('SELECT * FROM contacts WHERE lower(remark) = lower(?)').get(w) as ContactRow | undefined) ??
        // (ADR-088 §7) typed in another Unicode form, or another case of a letter SQLite does not fold
        (/[^\x00-\x7f]/.test(w) ? (db.prepare('SELECT * FROM contacts WHERE remark IS NOT NULL').all() as ContactRow[]).find((r) => sameName(r.remark!, w)) : undefined);
      if (byRemark) return toContact(byRemark);
      const byId = getRow(w);
      if (byId) return toContact(byId);
      return store.byHandle(w);
    },
    self() {
      const me = ctx.selfHandle?.()?.toLowerCase() ?? null;
      const row = getRow(SELF_CONTACT);
      const t = now();
      // a stale row of another contact holding our handle (joined after it was created) gives it up
      const release = () => db.prepare(`UPDATE contacts SET handle = NULL, agent = NULL WHERE handle = ? AND agent IS NULL AND id != ?`).run(me, SELF_CONTACT);
      if (!row) {
        if (me) release();
        db.prepare(`INSERT INTO contacts (id, handle, group_label, state, created_at, updated_at) VALUES (?, ?, 'self', 'active', ?, ?)`).run(SELF_CONTACT, me, t, t);
      } else if (me && row.handle !== me) {
        release();
        db.prepare('UPDATE contacts SET handle = ?, updated_at = ? WHERE id = ?').run(me, t, SELF_CONTACT);
      }
      return toContact(getRow(SELF_CONTACT)!);
    },
    ensure(handle, o = {}) {
      const { handle: h, agent } = split(handle);
      if (!h) throw new Error(`"${handle}" is not an address`);
      const me = ctx.selfHandle?.()?.toLowerCase();
      if (me && h === me) return store.self();
      const id = resolve(h, agent ? agent.toLowerCase() : null);
      const existing = getRow(id);
      const t = now();
      if (!existing) {
        let remark = o.remark ?? null;
        if (remark) checkRemark(remark);
        if (remark && db.prepare('SELECT 1 FROM contacts WHERE lower(remark) = lower(?)').get(remark)) remark = null;
        // ADR-077: a contact by old handle starts unchecked — the daemon asks the relay which agents / addresses it has
        db.prepare(`INSERT INTO contacts (id, handle, remark, nickname, group_label, state, split, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
          id,
          h,
          remark,
          o.nickname ?? null,
          normalizeGroup(o.group ?? DEFAULT_GROUP),
          ctx.isBlocked?.(h) ? 'blocked' : 'active',
          t,
          t,
        );
      } else if (o.nickname && o.nickname !== existing.nickname) {
        db.prepare('UPDATE contacts SET nickname = ?, updated_at = ? WHERE id = ?').run(o.nickname, t, id);
      }
      return toContact(getRow(id)!);
    },
    ensureAddress(address, myAddress) {
      const a = normalizeAddress(address);
      if (!a) throw new Error(`"${address}" is not an address`);
      const my = mine(myAddress);
      const run = db.transaction((): Contact => {
        const own = rowByAddress(a, my);
        if (own) return toContact(own);
        const t = now();
        if (my) {
          // (ADR-083) a contact of another address of mine: its own row, whatever the first address knows about them
          const id = idForPair(a, my);
          takeId(id, a, my);
          db.prepare(
            `INSERT INTO contacts (id, my_address, handle, agent, address, remark, group_label, state, split, origin, known_as, created_at, updated_at)
             VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?, 'done', NULL, ?, ?, ?)`,
          ).run(id, my, a, DEFAULT_GROUP, hasBlock(a, my) ? 'blocked' : 'active', my, t, t);
          dropMark(`removed:${my}:${a}`);
          return toContact(getRow(id)!);
        }
        const under = seenUnder(a);
        if (under && under.id !== SELF_CONTACT) return toContact(under); // a computer of someone who already is a contact
        const id = idForPair(a, '');
        takeId(id, a, '');
        db.prepare(
          `INSERT INTO contacts (id, handle, agent, address, remark, group_label, state, split, origin, created_at, updated_at)
           VALUES (?, NULL, NULL, ?, NULL, ?, ?, 'done', NULL, ?, ?)`,
        ).run(id, a, DEFAULT_GROUP, hasBlock(a, '') ? 'blocked' : 'active', t, t);
        // (an address P1 filed under `self`, or left behind by a removed contact, is this contact's now)
        db.prepare(
          `INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(address) DO UPDATE SET contact_id = excluded.contact_id`,
        ).run(a, id, t, t);
        dropMark(`removed:${a}`);
        return toContact(getRow(id)!);
      });
      return run.immediate();
    },
    set(id, patch) {
      const row = getRow(id);
      if (!row) throw new Error(`no contact ${id}`);
      const t = now();
      if (patch.remark !== undefined) {
        // (ADR-088 §7) kept NFC-normalised, and compared that way: a precomposed and a decomposed "café" are one name
        const remark = (patch.remark ? nameAsKept(patch.remark) : '') || null;
        if (remark) {
          checkRemark(remark);
          const clash =
            (db.prepare('SELECT id FROM contacts WHERE lower(remark) = lower(?) AND id != ?').get(remark, id) as { id: string } | undefined) ??
            (db.prepare('SELECT id, remark FROM contacts WHERE remark IS NOT NULL AND id != ?').all(id) as Array<{ id: string; remark: string }>).find((r) => sameName(r.remark, remark));
          if (clash) throw new Error(`the name "${remark}" is already used for another contact`);
        }
        db.prepare('UPDATE contacts SET remark = ?, updated_at = ? WHERE id = ?').run(remark, t, id);
      }
      if (patch.group !== undefined) {
        const group = normalizeGroup(patch.group);
        db.prepare('UPDATE contacts SET group_label = ?, updated_at = ? WHERE id = ?').run(group, t, id);
        // ADR-077 (N1): the lowered state of an own computer is kept apart from the row, so it survives the row
        if (row.origin === OWN_DEVICE) for (const d of devicesOf(row)) group === SELF_GROUP ? dropMark(`demoted:${d}`) : putMark(`demoted:${d}`, id);
      }
      if (patch.nickname !== undefined) db.prepare('UPDATE contacts SET nickname = ?, updated_at = ? WHERE id = ?').run(patch.nickname, t, id);
      if (patch.state !== undefined) db.prepare('UPDATE contacts SET state = ?, updated_at = ? WHERE id = ?').run(patch.state, t, id);
      return toContact(getRow(id)!);
    },
    remove(id) {
      if (id === SELF_CONTACT) throw new Error('the self contact cannot be removed');
      // ADR-077: a contact you removed is never made again by the migration or by what a sender claims
      const gone = getRow(id);
      // (ADR-083) a tombstone is the business of the address of mine the contact belonged to: the first address's
      // key is the one from before (`removed:<their address>`), another address's carries it (`removed:<mine>:<theirs>`)
      if (gone?.address && gone.my_address) putMark(`removed:${gone.my_address}:${gone.address}`, JSON.stringify({ id, my: gone.my_address }));
      else if (gone?.address) putMark(`removed:${gone.address}`, JSON.stringify({ id, handle: gone.handle, agent: gone.agent, origin: gone.origin, devices: devicesOf(gone) }));
      if (gone?.handle && gone.agent && gone.address) putMark(`removed:${contactIdFor(gone.handle, gone.agent)}`, gone.address);
      // (an own computer outside group self stays lowered: its `demoted:` mark is not touched)
      if (gone?.origin === OWN_DEVICE && gone.group_label !== SELF_GROUP) for (const d of devicesOf(gone)) putMark(`demoted:${d}`, id);
      db.prepare('DELETE FROM contact_agents WHERE contact_id = ?').run(id);
      db.prepare('DELETE FROM contact_addresses WHERE contact_id = ?').run(id);
      return db.prepare('DELETE FROM contacts WHERE id = ?').run(id).changes > 0;
    },
    seenAgent(contactId, agent, at) {
      db.prepare(
        `INSERT INTO contact_agents (contact_id, agent, last_seen_at) VALUES (?, ?, ?)
         ON CONFLICT(contact_id, agent) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
      ).run(contactId, agent, at ?? now());
    },
    seenAddress(contactId, address, deviceId, at) {
      const a = normalizeAddress(address);
      const of = getRow(contactId);
      if (!a || !of || of.my_address) return; // (ADR-083: seen addresses are kept for the first address's contacts only)
      // ADR-077: an address that IS a contact (split off, or one of your own computers) stays with it,
      // and an address recorded for one contact is not handed to another by seeing it again
      const t = at ?? now();
      const known = db.prepare('SELECT contact_id FROM contact_addresses WHERE address = ?').get(a) as { contact_id: string } | undefined;
      const owner = rowByAddress(a);
      if (known || owner) {
        db.prepare('UPDATE contact_addresses SET device_id = COALESCE(?, device_id), last_seen = MAX(last_seen, ?) WHERE address = ?').run(deviceId ?? null, t, a);
        return;
      }
      db.prepare(`INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`).run(a, contactId, deviceId ?? null, t, t);
      // a VERIFIED address of theirs we did not know when the handle was checked with the relay: check again
      // (it may be another agent of theirs and then becomes a contact of its own — unless you removed that one)
      db.prepare(`UPDATE contacts SET split = 'pending' WHERE id = ? AND split = 'done' AND handle IS NOT NULL AND agent IS NULL AND COALESCE(origin, '') != ? AND id != ?`).run(contactId, OWN_DEVICE, SELF_CONTACT);
    },
    byAddress(address, myAddress) {
      const a = normalizeAddress(address);
      if (!a) return null;
      const my = mine(myAddress);
      const own = rowByAddress(a, my);
      if (own) return toContact(own);
      if (my) return null; // (ADR-083) another address of mine knows only its own contacts
      const under = seenUnder(a);
      return under ? toContact(under) : null;
    },
    ownerOfAddress(address) {
      const a = normalizeAddress(address);
      const row = a ? rowByAddress(a) : undefined;
      return row ? toContact(row) : null;
    },
    ownDeviceOf(deviceId) {
      const row = db
        .prepare(`SELECT c.* FROM contact_addresses a JOIN contacts c ON c.id = a.contact_id AND c.address = a.address WHERE a.device_id = ? AND c.origin = ?`)
        .get(deviceId, OWN_DEVICE) as ContactRow | undefined;
      return row ? toContact(row) : null;
    },
    filingContact(sender, handle, tier) {
      if (tier === 'owner') return undefined;
      const a = sender.address ? normalizeAddress(sender.address) : null;
      const row = (a ? rowByAddress(a) : undefined) ?? (sender.deviceId ? (getRow(store.ownDeviceOf(sender.deviceId)?.id ?? '') ?? undefined) : undefined);
      if (!row || row.id === SELF_CONTACT) return undefined;
      if (row.origin === OWN_DEVICE) return row.id; // one of your computers, moved out of group self
      // a contact split off this very handle; an address filed under another name is not followed
      return row.handle && row.handle === handle.trim().toLowerCase().split('/')[0] ? row.id : undefined;
    },
    classify(r, o = {}) {
      // ADR-081: mail FROM a bare address (it came by address alone): the contact the transport named, else
      // the one that address belongs to — made if there is none. Always another person's: nothing that
      // arrives by address is `self` or carries owner tier, whatever tier is passed in.
      const fromAddress = r.from_device ? normalizeAddress(r.from_device) : null;
      if (fromAddress) {
        const named = o.contactId && o.contactId !== SELF_CONTACT ? getRow(o.contactId) : undefined;
        const agent = r.to_agent === 'user' && r.to_session === 'inbox' ? (ctx.primaryAgent?.() ?? 'user') : r.to_agent;
        // (ADR-083) …the contact of exactly (the address of mine it was written to, the sender)
        const row = named ?? getRow(store.ensureAddress(fromAddress, o.myAddress ?? null).id)!;
        return { direction: 'in', contactId: row.id, agent, peerAgent: null, handle: null, fromTier: 'peer', myAddress: row.my_address ?? '' };
      }
      // ADR-077: mail to a bare address (a contact that has no old name, e.g. a computer of yours paired by ID);
      // ADR-081: any address you write to is a contact — one with only that address when nobody has it yet
      const toAddress = !r.from_device && r.to_device ? normalizeAddress(r.to_device) : null;
      // (ADR-083) WHICH contact: the one of the address of mine that is named; with none named the one there is —
      // more than one is never guessed — else a new contact of the first address
      let target: ContactRow | undefined;
      if (toAddress && o.myAddress !== undefined && o.myAddress !== null) target = getRow(store.ensureAddress(toAddress, o.myAddress).id) ?? undefined;
      else if (toAddress) {
        const all = store.findAll(toAddress);
        if (all.length > 1) throw new AmbiguousAddressError(toAddress, all.map((x) => x.myAddress));
        target = getRow(all[0]?.id ?? store.ensureAddress(toAddress).id) ?? undefined;
      }
      if (target) {
        const own = target.origin === OWN_DEVICE && target.group_label === SELF_GROUP;
        if (own) store.self();
        return { direction: 'out', contactId: own ? SELF_CONTACT : target.id, agent: ctx.primaryAgent?.() ?? r.from_agent, peerAgent: target.agent, handle: null, fromTier: null, myAddress: target.my_address ?? '' };
      }
      const c = classifyRefs(r, ctx, resolve);
      // ADR-077: another person's mail whose contact the transport found by the sender's verified address —
      // that contact, and no contact is made for the name the mail came under (N5b)
      if (o.contactId && c.direction === 'in' && c.fromTier === 'peer' && getRow(o.contactId)) return { ...c, contactId: o.contactId };
      if (c.contactId === SELF_CONTACT) store.self();
      else if (c.handle && !getRow(c.contactId)) store.ensure(c.handle);
      return c;
    },
    isLowered(deviceId) {
      if (hasMark(`demoted:${deviceId}`)) return true;
      const c = store.ownDeviceOf(deviceId);
      return Boolean(c && c.group !== SELF_GROUP);
    },
    restore(who) {
      const run = db.transaction((): Contact | null => {
        const w = who.trim();
        let address = normalizeAddress(w);
        if (!address) {
          const { handle, agent } = split(w.replace(/^(?:[a-z]+:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\//i, ''));
          address = handle && agent ? getMark(`removed:${contactIdFor(handle, agent)}`) : null;
        }
        const raw = address ? getMark(`removed:${address}`) : null;
        if (!address || !raw || rowByAddress(address)) return null;
        let was: { id?: string; handle?: string | null; agent?: string | null; origin?: string | null; devices?: string[] };
        try {
          was = JSON.parse(raw) as typeof was;
        } catch {
          return null;
        }
        const t = now();
        const own = was.origin === OWN_DEVICE;
        const devices = Array.isArray(was.devices) ? was.devices : [];
        const pair = was.handle && !rowFor(was.handle, was.agent ?? null) ? { handle: was.handle, agent: was.agent ?? null } : { handle: null, agent: null };
        if (!own && !pair.handle) return null; // its handle now has that agent again some other way
        const id = own ? contactIdForAddress(address) : contactIdFor(pair.handle!, pair.agent);
        if (getRow(id)) return null;
        // the default group, none of the old settings; an own computer is back as it stands: self, or lowered
        const lowered = own && devices.some((d) => hasMark(`demoted:${d}`));
        const base = !own && pair.handle ? rowFor(pair.handle, null) : undefined;
        if (own) takeId(id, address, ''); // (ADR-083 review R3) an id of the `a:` kind: no other address's mail stays under it
        db.prepare(
          `INSERT INTO contacts (id, handle, agent, address, remark, group_label, state, split, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 'done', ?, ?, ?)`,
        ).run(id, pair.handle, pair.agent, address, base && pair.agent ? splitRemark(base, pair.agent) : null, own && !lowered ? SELF_GROUP : DEFAULT_GROUP, own ? OWN_DEVICE : null, t, t);
        db.prepare(
          `INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(address) DO UPDATE SET contact_id = excluded.contact_id, device_id = COALESCE(excluded.device_id, device_id)`,
        ).run(address, id, devices[0] ?? null, t, t);
        if (pair.agent) store.seenAgent(id, pair.agent, t);
        dropMark(`removed:${address}`);
        if (was.handle && was.agent) dropMark(`removed:${contactIdFor(was.handle, was.agent)}`);
        return toContact(getRow(id)!);
      });
      return run.immediate();
    },
    pendingSplits() {
      const me = ctx.selfHandle?.()?.toLowerCase() ?? '';
      const rows = db
        // split IS NULL: a row an older morse (still running after the migration) wrote — unchecked too
        .prepare(`SELECT * FROM contacts WHERE COALESCE(split, 'pending') = 'pending' AND handle IS NOT NULL AND agent IS NULL AND id != ? AND handle != ? AND COALESCE(origin, '') != ? ORDER BY created_at ASC, id ASC`)
        .all(SELF_CONTACT, me, OWN_DEVICE) as ContactRow[];
      return rows.map(toContact);
    },
    applySplit(contactId, entries) {
      const run = db.transaction((): string[] => {
        const row = getRow(contactId);
        if (!row?.handle || row.agent || row.id === SELF_CONTACT) return [];
        const t = now();
        const done = () => db.prepare(`UPDATE contacts SET split = 'done', updated_at = ? WHERE id = ?`).run(t, row.id);
        const family = new Set((db.prepare('SELECT id FROM contacts WHERE handle = ?').all(row.handle) as Array<{ id: string }>).map((r) => r.id));
        /** An address already recorded for a contact outside this handle is never taken from it. */
        const elsewhere = (address: string): boolean => {
          const owner = rowByAddress(address);
          if (owner) return !family.has(owner.id);
          const seen = db.prepare('SELECT contact_id FROM contact_addresses WHERE address = ?').get(address) as { contact_id: string } | undefined;
          return Boolean(seen && !family.has(seen.contact_id));
        };
        const list = (entries ?? []).flatMap((e) => {
          const address = normalizeAddress(e.address);
          const agent = e.agent.trim().toLowerCase();
          return address && agent && !elsewhere(address) ? [{ ...e, agent, address }] : [];
        });
        if (!list.length) {
          done();
          return [];
        }
        /** The address is this contact's from now on (it may have been listed under the handle's base contact). */
        const attach = (id: string, e: { address: string; deviceId?: string | null }) =>
          db
            .prepare(
              `INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(address) DO UPDATE SET contact_id = excluded.contact_id, device_id = COALESCE(excluded.device_id, device_id)`,
            )
            .run(e.address, id, e.deviceId ?? null, t, t);
        const def = list.find((e) => e.default) ?? null;
        if (def && !rowByAddress(def.address)) {
          if (!row.address) db.prepare('UPDATE contacts SET address = ?, updated_at = ? WHERE id = ?').run(def.address, t, row.id);
          attach(row.id, def);
        }
        const base = getRow(row.id)!;
        const created: string[] = [];
        const taken = new Set<string>(base.address ? [base.address] : []);
        for (const e of list.filter((x) => x !== def).sort((a, b) => a.agent.localeCompare(b.agent))) {
          if (taken.has(e.address)) continue; // another agent on the same computer: one address, one contact
          taken.add(e.address);
          const id = contactIdFor(row.handle, e.agent);
          const existing = rowFor(row.handle, e.agent);
          if (existing) {
            if (!existing.address && !rowByAddress(e.address)) {
              db.prepare('UPDATE contacts SET address = ?, updated_at = ? WHERE id = ?').run(e.address, t, existing.id);
              attach(existing.id, e);
            }
            continue;
          }
          // that address already is a contact, or you removed the contact it would be: never made again
          if (rowByAddress(e.address) || getRow(id) || hasMark(`removed:${e.address}`) || hasMark(`removed:${id}`)) continue;
          db.prepare(
            `INSERT INTO contacts (id, handle, agent, address, remark, nickname, group_label, state, split, inherits, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'done', ?, ?, ?)`,
          ).run(id, row.handle, e.agent, e.address, splitRemark(row, e.agent), row.group_label, row.state, row.remark, t, t);
          attach(id, e);
          store.seenAgent(id, e.agent, t);
          created.push(id);
        }
        done();
        return created;
      });
      return run.immediate();
    },
    ensureOwnDevice(d) {
      const address = normalizeAddress(d.address);
      if (!address) return null;
      const run = db.transaction((): Contact | null => {
        const key = `own:${d.deviceId}`;
        const t = now();
        const handle = d.handle?.trim().toLowerCase() || null;
        const agent = d.agent?.trim().toLowerCase() || null;
        let row = rowByAddress(address);
        if (!row) {
          if (hasMark(key) || hasMark(`removed:${address}`)) return null; // made before, removed by the owner since
          // an address recorded for someone else's contact is never moved (only from `self`, where P1 filed it)
          const seen = db.prepare('SELECT contact_id FROM contact_addresses WHERE address = ?').get(address) as { contact_id: string } | undefined;
          if (seen && seen.contact_id !== SELF_CONTACT) return null;
          const pair = handle && !rowFor(handle, agent) ? { handle, agent } : { handle: null, agent: null };
          const id = idForPair(address, ''); // (ADR-083: your own computers are the first address's)
          takeId(id, address, '');
          db.prepare(
            `INSERT INTO contacts (id, handle, agent, address, remark, group_label, state, split, origin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', 'done', ?, ?, ?)`,
          ).run(id, pair.handle, pair.agent, address, freeRemark(agent ?? d.name), hasMark(`demoted:${d.deviceId}`) ? DEFAULT_GROUP : SELF_GROUP, OWN_DEVICE, t, t);
          putMark(key, id);
          row = getRow(id)!;
        } else if (row.origin === OWN_DEVICE) {
          if (!row.handle && handle && !rowFor(handle, agent)) db.prepare('UPDATE contacts SET handle = ?, agent = ?, updated_at = ? WHERE id = ?').run(handle, agent, t, row.id);
          if (!row.remark) {
            const remark = freeRemark(agent ?? d.name, row.id);
            if (remark) db.prepare('UPDATE contacts SET remark = ?, updated_at = ? WHERE id = ?').run(remark, t, row.id);
          }
          if (!hasMark(key)) putMark(key, row.id);
        } else {
          if (!hasMark(key)) putMark(key, row.id); // that address already is someone's contact: leave it
          return toContact(row);
        }
        // its address moves from `self` (where P1 recorded it) to its own contact
        db.prepare(
          `INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(address) DO UPDATE SET contact_id = excluded.contact_id, device_id = COALESCE(excluded.device_id, device_id)`,
        ).run(address, row.id, d.deviceId, t, t);
        return toContact(getRow(row.id)!);
      });
      return run.immediate();
    },
    ownDevice(address) {
      const a = normalizeAddress(address);
      const row = a ? rowByAddress(a) : undefined;
      return row && row.origin === OWN_DEVICE ? toContact(row) : null;
    },
    family(contactId) {
      const row = getRow(contactId);
      if (!row?.handle) return [contactId];
      const ids = (db.prepare('SELECT id FROM contacts WHERE handle = ?').all(row.handle) as Array<{ id: string }>).map((r) => r.id);
      return ids.includes(contactId) ? ids : [contactId, ...ids];
    },
    knownAs(id) {
      if (id === SELF_CONTACT) return null;
      const row = getRow(id);
      return row ? (row.my_address ?? '') : null;
    },
    mark: getMark,
    setMark: putMark,
  };
  return store;
}
