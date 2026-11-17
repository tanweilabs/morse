import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import type { Db } from './db.js';
import { CONTACT_INDEXES, CONTACTS_TABLE, DEFAULT_GROUP, OWN_DEVICE, SCHEMA_BLOCKS, SELF_CONTACT, SELF_GROUP, contactIdForAddress, type ContactContext } from './contacts.js';
import { REQUESTS_TABLE } from './requests.js';
import { isAddress, normalizeAddress } from '../identity/address.js';

/**
 * Mailbox schema v4 (ADR-083): contacts, message requests and blocks per LOCAL address — "nothing a
 * peer can observe at my address B depends on state that exists because of my address A". Run when the
 * database is opened, with the discipline of the v3 step (ADR-077):
 *
 * - `contacts` is rebuilt with `my_address` ('' = this computer's first address) and uniqueness per
 *   (my address, their address) / (my address, handle, agent). Who belongs to whom: the first address,
 *   unless the release before recorded another one — a contact that has only an address and a
 *   `known_as` naming another address of mine becomes that address's contact (it keeps its id, remark,
 *   group and permissions). Yourself, your own computers and every contact by old handle are the first
 *   address's.
 * - one contact per (my address, peer) pair that has message history: where mail with a contact ran
 *   over another address of mine than the one the contact now belongs to, that pair gets a row of its
 *   own (same group, no remark) and its messages are re-pointed to it — so whoever was a contact at B
 *   before still is, and every message stays readable.
 * - `morse_requests` is rebuilt with the key (my address, handle): a request that came by address
 *   belongs to the address it was written to (`to_address`), any other to the first.
 * - `address_blocks` (new), per (my address, their address). (ADR-083 review R2) Before this step a block
 *   was the whole computer's, so every block that exists NOW keeps blocking that peer at EVERY address
 *   this computer has at this moment: the address-shaped entries of morse-blocked.json (the file itself
 *   is not touched), the blocked contacts, and — at the addresses other than the first — every address
 *   known for a blocked old handle (at the first address morse-blocked.json keeps deciding the handle).
 *   Nobody who was blocked becomes reachable by upgrading, and nothing new is revealed: they could
 *   already see they were blocked everywhere. A block made AFTER this step is one address's alone, and
 *   an address ADDED later starts with no blocks at all — it is a new persona.
 * - (ADR-083 review R3) the messages of a contact that was removed before (no row any more) that ran
 *   over another address of mine than the first are re-pointed to the id that pairing has
 *   (`a:<theirs>~<mine>`): no id is then shared by two pairings, and no contact is made for them.
 *
 * One IMMEDIATE transaction that re-checks the version inside: killed halfway = rolled back = run again
 * on the next open; a second run is a no-op; processes that open the database at the same moment wait
 * for the one that migrates and then find nothing to do. The ONE backup is taken inside that
 * transaction, by the process that migrates: only what is rewritten (the tables below and the
 * (id, contact_id) of the re-pointed messages).
 */

export const SCHEMA_VERSION_V4 = 4;
export const P4_BACKUP_MARK = 'p4.backup';
/**
 * The address-shaped entries of morse-blocked.json that were already taken into `address_blocks` (a JSON
 * list). New code never writes an address into that file — so one that shows up there later was put by
 * a morse of the release before, still running: `adoptOlderWrites` takes it over, for the address of mine
 * the contact it blocked belongs to (ADR-083 review R7).
 */
export const P4_BLOCKS_SEEN_MARK = 'p4.blocks.seen';
/**
 * (ADR-083 review R7) The blocks `adoptOlderWrites` took over from morse-blocked.json AFTER the migration
 * (a morse of the release before, still running, wrote them): JSON `{ <their address>: { my: [<my
 * address>, …], at } }`. When such an entry leaves the file again — that morse unblocked them — exactly
 * these blocks are lifted. The blocks that were there at the migration are not in this list.
 */
export const P4_BLOCKS_ADOPTED_MARK = 'p4.blocks.adopted';
/** The tables the migration rewrites — copied whole into the backup. */
export const P4_BACKUP_TABLES = ['contacts', 'contact_agents', 'contact_addresses', 'morse_requests', 'migration_marks'] as const;
/** In the backup: the contact each re-pointed message belonged to before. */
export const P4_REPOINTED_TABLE = 'repointed_messages';
const IN_PROGRESS = 'IN-PROGRESS';
const DIR_PREFIX = 'contacts-per-address-';
const BESIDE_SUFFIX = '.v3-contacts.bak';

export interface MigrationReportV4 {
  from: number;
  to: number;
  contacts: number;
  /** Contacts that now belong to an address of yours other than the first (the release before had recorded it). */
  moved: number;
  /** Contacts made for a (my address, peer) pair that had message history under another address's contact. */
  created: number;
  /** Contacts (kept or made) that belong to an address of yours other than the first. */
  elsewhere: number;
  /** Messages whose contact is one of those new rows now. */
  repointed: number;
  /** Message requests that wait at an address other than the first. */
  requests: number;
  /** Blocks by address taken into address_blocks. */
  blocks: number;
  backup: string | null;
}

/**
 * The upgrade could not be done safely and was not done: nothing was changed, and it runs again on the next
 * open. The message is ONE line for the user — what is wrong, which file, that nothing was changed; a command
 * prints it (`error: …`) and ends (ADR-083 review N1: a plain Error would reach the user as a stack trace).
 */
export class MigrationRefusedV4 extends Error {}

/** No backup could be written anywhere: the migration did not start, nothing was changed. */
export class BackupErrorV4 extends MigrationRefusedV4 {}

const userVersion = (db: Db): number => Number(db.pragma('user_version', { simple: true })) || 0;
const columns = (db: Db, table: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
const hasTable = (db: Db, table: string): boolean => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export interface BackupPlanV4 {
  /** ~/.morse — the backup goes to `<morseDir>/backups/contacts-per-address-<UTC stamp>/`. */
  morseDir?: string;
  /** The database file — the fallback is `<dbPath>.v3-contacts.bak` next to it. */
  dbPath?: string;
}

interface Taken {
  path: string;
  discard(): void;
  keep(): void;
}

type Repointed = Array<{ id: string; contact_id: string | null }>;

/**
 * Copy the rewritten tables (schema + rows) and the re-pointed messages' old contact into a new small SQLite file (0600).
 * (ADR-083 review R8) Their indexes too, as they are defined before the rewrite: the backup's own
 * `sqlite_master` then holds every CREATE TABLE and CREATE INDEX a restore needs (docs/guides/restore-contacts-backup.zh-CN.md).
 */
function copyTables(db: Db, target: string, repointed: Repointed): { rows: Record<string, number>; schema: string[] } {
  const counts: Record<string, number> = {};
  const schema: string[] = [];
  const out = new Database(target);
  try {
    chmodSync(target, 0o600);
    out.exec('BEGIN');
    const copied: string[] = [];
    for (const table of P4_BACKUP_TABLES) {
      const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string } | undefined)?.sql;
      if (!ddl) continue;
      out.exec(ddl);
      schema.push(ddl);
      copied.push(table);
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      counts[table] = rows.length;
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]!);
      const insert = out.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const r of rows) insert.run(...cols.map((c) => r[c]));
    }
    // (after the rows: a unique index is then checked once, against rows that satisfied it where they came from)
    for (const table of copied) {
      const indexes = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`).all(table) as Array<{ sql: string }>;
      for (const ix of indexes) {
        out.exec(ix.sql);
        schema.push(ix.sql);
      }
    }
    out.exec(`CREATE TABLE ${P4_REPOINTED_TABLE} (id TEXT PRIMARY KEY, contact_id TEXT)`);
    const put = out.prepare(`INSERT INTO ${P4_REPOINTED_TABLE} (id, contact_id) VALUES (?, ?)`);
    for (const r of repointed) put.run(r.id, r.contact_id);
    counts[P4_REPOINTED_TABLE] = repointed.length;
    out.exec('COMMIT');
    out.pragma(`user_version = ${userVersion(db)}`);
  } finally {
    out.close();
  }
  return { rows: counts, schema };
}

/**
 * The ONE backup of this computer's v4 migration (see the file comment). Directory 0700, files 0600,
 * an IN-PROGRESS marker while the migration is not committed; a directory a killed run left (still
 * marked) is removed first. When ~/.morse/backups cannot be written: `<db>.v3-contacts.bak` (written
 * as `.partial`, renamed once committed); when that fails too: BackupErrorV4, nothing written.
 */
export function backupForV4(db: Db, plan: BackupPlanV4, repointed: Repointed, now: number = Date.now()): Taken {
  const errors: string[] = [];
  const tried: string[] = [];
  if (plan.morseDir) {
    const root = join(plan.morseDir, 'backups');
    let dir: string | null = null;
    tried.push(join(root, `${DIR_PREFIX}${stamp(now)}`));
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(root)) if (name.startsWith(DIR_PREFIX) && existsSync(join(root, name, IN_PROGRESS))) rmSync(join(root, name), { recursive: true, force: true });
      dir = join(root, `${DIR_PREFIX}${stamp(now)}`);
      for (let i = 1; existsSync(dir); i++) dir = join(root, `${DIR_PREFIX}${stamp(now)}-${i}`);
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
      const made = dir;
      writeFileSync(join(made, IN_PROGRESS), `${process.pid}\n`, { mode: 0o600 });
      const { rows, schema } = copyTables(db, join(made, 'tables.sqlite'), repointed);
      writeFileSync(
        join(made, 'MANIFEST.json'),
        `${JSON.stringify(
          {
            migration: 'contacts-per-address',
            adr: 'ADR-083',
            createdAt: new Date(now).toISOString(),
            fromUserVersion: userVersion(db),
            tables: [...P4_BACKUP_TABLES, P4_REPOINTED_TABLE],
            rows,
            // (ADR-083 review R8) the CREATE TABLE / CREATE INDEX statements of those tables, as they were — tables.sqlite itself was made with them
            schema,
            files: { 'tables.sqlite': statSync(join(made, 'tables.sqlite')).size },
            note: `tables.sqlite holds the contact, request and bookkeeping tables (rows, table and index definitions) as they were before contacts became per address, and in ${P4_REPOINTED_TABLE} the contact each re-pointed message belonged to (no message text was changed, and none is copied here). To put them back: docs/guides/restore-contacts-backup.zh-CN.md.`,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      return {
        path: made,
        discard: () => rmSync(made, { recursive: true, force: true }),
        keep: () => rmSync(join(made, IN_PROGRESS), { force: true }),
      };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      if (dir) rmSync(dir, { recursive: true, force: true }); // never leave a half-written backup
    }
  }
  if (plan.dbPath) {
    const target = `${plan.dbPath}${BESIDE_SUFFIX}`;
    const partial = `${target}.partial`;
    tried.push(target);
    try {
      rmSync(partial, { force: true });
      if (existsSync(target)) throw new Error(`${target} already exists`);
      copyTables(db, partial, repointed);
      return {
        path: target,
        discard: () => rmSync(partial, { force: true }),
        keep: () => {
          renameSync(partial, target);
          chmodSync(target, 0o600);
        },
      };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      try {
        rmSync(partial, { force: true });
      } catch {
        /* nothing was written */
      }
    }
  }
  throw new BackupErrorV4(
    `cannot back up your contacts before giving each of your addresses its own (${errors.join('; ')}) — free some disk space or make ${plan.morseDir ?? dirname(plan.dbPath ?? '.')} writable (tried ${tried.join(' and ')}). Nothing was changed; the upgrade runs again the next time morse starts.`,
  );
}

/** A crash between the commit and the end of the backup's `keep()`: finish the marking on a later open (cosmetic). */
export function settleBackupMarkV4(db: Db): void {
  try {
    if (!hasTable(db, 'migration_marks')) return;
    const path = (db.prepare('SELECT value FROM migration_marks WHERE key = ?').get(P4_BACKUP_MARK) as { value: string | null } | undefined)?.value;
    if (!path) return;
    if (existsSync(join(path, IN_PROGRESS))) rmSync(join(path, IN_PROGRESS), { force: true });
    if (path.endsWith(BESIDE_SUFFIX) && !existsSync(path) && existsSync(`${path}.partial`)) {
      renameSync(`${path}.partial`, path);
      chmodSync(path, 0o600);
    }
  } catch {
    /* cosmetic only */
  }
}

export type MigrationStageV4 = 'backup' | 'contacts' | 'requests' | 'messages';

interface OldContact {
  id: string;
  handle: string | null;
  agent: string | null;
  address: string | null;
  remark: string | null;
  group_label: string;
  state: string;
  origin: string | null;
  known_as?: string | null;
  created_at: number;
}

/**
 * Run the v4 migration (see the file comment). null = already at v4 (nothing done, no backup).
 * `backup`: where the one backup goes; null = none (a database this very open created). `hook` is for
 * tests (called after each stage, inside the transaction).
 */
export function migrateToV4(db: Db, ctx: ContactContext, opts: { now?: number; backup?: BackupPlanV4 | null; hook?: (stage: MigrationStageV4) => void } = {}): MigrationReportV4 | null {
  const now = opts.now ?? Date.now();
  let taken: Taken | null = null;
  const run = db.transaction((): MigrationReportV4 | null => {
    const from = userVersion(db);
    if (from >= SCHEMA_VERSION_V4) return null;
    const first = ctx.firstAddress?.() ?? null;
    const contactCols = hasTable(db, 'contacts') ? columns(db, 'contacts') : new Set<string>();
    const rebuildContacts = contactCols.size > 0 && !contactCols.has('my_address');
    const requestCols = hasTable(db, 'morse_requests') ? columns(db, 'morse_requests') : new Set<string>();
    const rebuildRequests = requestCols.size > 0 && !requestCols.has('my_address');
    const messageCols = hasTable(db, 'messages') ? columns(db, 'messages') : new Set<string>();

    /** '' for this computer's first address (or nothing recorded), else the address. */
    const mine = (a: string | null | undefined): string => {
      const n = a ? normalizeAddress(a) : null;
      if (!n) return '';
      if (first === null) {
        // an address of mine is recorded, and which of mine is the first cannot be told: nothing is guessed
        throw new MigrationRefusedV4("cannot tell which of your addresses here is the first one (its key could not be read) — your contacts were not changed; the upgrade runs again the next time morse starts");
      }
      return n === first ? '' : n;
    };

    // ---- 1. who belongs to which address of mine (read only) -----------------------------------
    const old: OldContact[] = rebuildContacts ? (db.prepare('SELECT * FROM contacts').all() as OldContact[]) : [];
    const byId = new Map(old.map((r) => [r.id, r]));
    const owner = new Map<string, string>();
    const history = messageCols.has('contact_id') && messageCols.has('my_address') && messageCols.has('direction');
    // (ADR-083 review R6) nothing recorded (`known_as` NULL: a row from before that column, or one an older
    // process wrote): what the release before would have recorded the next time it looked — the address of
    // the OLDEST mail with this contact (a row without one came the old way: the first address). Its own rule,
    // its own statement (src/mailbox/contacts.ts `knownAs` at af4ca40). No mail at all: the first address.
    const oldestMail = history ? db.prepare(`SELECT my_address AS a FROM messages WHERE contact_id = ? AND direction IN ('in', 'out') ORDER BY created_at ASC, rowid ASC LIMIT 1`) : null;
    for (const r of old) {
      // yourself, your own computers, a contact by old handle: the first address — whatever was recorded
      const addressOnly = r.id !== SELF_CONTACT && !r.handle && r.origin !== OWN_DEVICE && Boolean(r.address);
      if (!addressOnly) owner.set(r.id, '');
      else if (contactCols.has('known_as') && r.known_as !== null && r.known_as !== undefined) owner.set(r.id, mine(r.known_as));
      else owner.set(r.id, mine((oldestMail?.get(r.id) as { a: string | null } | undefined)?.a));
    }
    /** (my address, their address) → the contact of that pair. */
    const pairs = new Map<string, string>();
    for (const r of old) if (r.address) pairs.set(`${owner.get(r.id)}\n${r.address}`, r.id);
    const usedIds = new Set(old.map((r) => r.id));
    const blockedList = new Set((ctx.blockedHandles?.() ?? []).map((h) => h.toLowerCase()));
    // What the release before OBEYED for a contact was morse-blocked.json, not the row: a row could keep
    // `state = 'blocked'` after the person was unblocked (writing to them lifted the block in the file only).
    // So with the file at hand it alone says who is blocked; the row counts only where there is no file (tests).
    const fileDecides = Boolean(ctx.blockedHandles);
    const isBlockedContact = (r: OldContact): boolean =>
      r.origin !== OWN_DEVICE && (fileDecides ? Boolean(r.handle && blockedList.has(r.handle)) || Boolean(r.address && blockedList.has(r.address)) : r.state === 'blocked');
    const created: Array<{ id: string; my: string; address: string; group: string; blocked: boolean; at: number }> = [];
    const repointed: Array<{ id: string; contact_id: string | null; to: string }> = [];
    /** Messages whose contact has no row any more (it was removed; its history stays). */
    const orphans: Array<{ id: string; contact_id: string; direction: string; from_device: string | null; to_device: string | null; my_address: string | null }> = [];
    /** Bookkeeping as it is now: the tombstones of removed contacts are read below (never rewritten). */
    const marks: Array<{ key: string; value: string | null }> = hasTable(db, 'migration_marks') ? (db.prepare(`SELECT key, value FROM migration_marks WHERE key LIKE 'removed:%'`).all() as Array<{ key: string; value: string | null }>) : [];
    /** `removed:<their address>` → what the tombstone says the contact was. */
    const tombstones: Array<{ address: string; id: string | null; handle: string | null; origin: string | null }> = marks.flatMap((m) => {
      const address = isAddress(m.key.slice('removed:'.length)) ? m.key.slice('removed:'.length) : null;
      if (!address) return []; // (`removed:c:<handle>/<agent>` names an address as its value; `removed:<mine>:<theirs>` is this release's)
      try {
        const v = JSON.parse(m.value ?? 'null') as { id?: unknown; handle?: unknown; origin?: unknown } | null;
        return [{ address, id: typeof v?.id === 'string' ? v.id : null, handle: typeof v?.handle === 'string' && v.handle ? v.handle.toLowerCase() : null, origin: typeof v?.origin === 'string' ? v.origin : null }];
      } catch {
        return [];
      }
    });
    if (rebuildContacts && messageCols.has('contact_id') && messageCols.has('my_address')) {
      const rows = db
        .prepare(`SELECT id, contact_id, direction, from_device, to_device, my_address, created_at FROM messages WHERE direction IN ('in', 'out') AND contact_id IS NOT NULL AND contact_id != ? ORDER BY created_at ASC, rowid ASC`)
        .all(SELF_CONTACT) as Array<{ id: string; contact_id: string; direction: string; from_device: string | null; to_device: string | null; my_address: string | null; created_at: number }>;
      for (const m of rows) {
        const c = byId.get(m.contact_id);
        if (!c) {
          orphans.push(m);
          continue;
        }
        const my = mine(m.my_address);
        if (my === owner.get(c.id)) continue;
        // the peer of this exchange: the address the mail came from / went to, else the contact's own
        const peer = normalizeAddress((m.direction === 'in' ? m.from_device : m.to_device) ?? '') ?? c.address;
        if (!peer) continue;
        let id = pairs.get(`${my}\n${peer}`);
        if (!id) {
          id = contactIdForAddress(peer, my);
          if (usedIds.has(id)) id = contactIdForAddress(peer, my || first || 'first');
          for (let i = 1; usedIds.has(id); i++) id = `${contactIdForAddress(peer, my || first || 'first')}-${i}`;
          usedIds.add(id);
          pairs.set(`${my}\n${peer}`, id);
          // the same group (so the same group permissions), no remark; a blocked person stays blocked there too
          const group = c.origin === OWN_DEVICE || c.group_label === SELF_GROUP ? DEFAULT_GROUP : c.group_label;
          created.push({ id, my, address: peer, group, blocked: isBlockedContact(c) || blockedList.has(peer), at: m.created_at });
        }
        if (id !== m.contact_id) repointed.push({ id: m.id, contact_id: m.contact_id, to: id });
      }
      // (ADR-083 review R3) A REMOVED contact's messages keep its id — and that id (`a:<theirs>`) is the one the
      // first address gives a contact of that peer made later: mail that ran over `work` would then show under
      // the first address's contact. So what a removed contact exchanged over another address of mine than the
      // first is given to ITS pairing, by the message's own address: the id that pairing has (the contact the
      // pair has now, else the one a contact of it made later gets — `a:<theirs>~<mine>`). No row is made: the
      // contact stays removed. Mail of the first address keeps its id (that IS its pairing's). After all rows
      // above, so that the result does not depend on the order of the messages.
      const orphanIds = new Map<string, string>();
      for (const m of orphans) {
        const my = mine(m.my_address);
        if (!my) continue;
        const peer = normalizeAddress((m.direction === 'in' ? m.from_device : m.to_device) ?? '') ?? tombstones.find((t) => t.id === m.contact_id)?.address ?? null;
        if (!peer) continue; // (it cannot be told who it was with: left as it is — every reader also goes by the message's own address)
        const key = `${my}\n${peer}`;
        let id = pairs.get(key) ?? orphanIds.get(key);
        if (!id) {
          id = contactIdForAddress(peer, my);
          for (let i = 1; usedIds.has(id); i++) id = `${contactIdForAddress(peer, my)}-${i}`; // (a row of ANOTHER pairing has it: cannot happen with ids this code makes)
          orphanIds.set(key, id);
        }
        if (id !== m.contact_id) repointed.push({ id: m.id, contact_id: m.contact_id, to: id });
      }
    }

    // ---- 2. the backup: what is about to be rewritten -------------------------------------------
    const plan = opts.backup;
    const worthIt = P4_BACKUP_TABLES.some((t) => hasTable(db, t) && (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n > 0);
    if (plan && worthIt && (rebuildContacts || rebuildRequests)) taken = backupForV4(db, plan, repointed.map(({ id, contact_id }) => ({ id, contact_id })), now);
    const backupPath = (taken as Taken | null)?.path ?? null;
    opts.hook?.('backup');

    // ---- 3. contacts ----------------------------------------------------------------------------
    let moved = 0;
    if (rebuildContacts) {
      // (index names are global: the old ones go with the old table)
      for (const ix of ['contacts_remark', 'contacts_handle_agent', 'contacts_address']) db.exec(`DROP INDEX IF EXISTS ${ix}`);
      db.exec('ALTER TABLE contacts RENAME TO contacts_v3_old');
      db.exec(CONTACTS_TABLE);
      const keep = ['id', 'handle', 'agent', 'address', 'remark', 'nickname', 'group_label', 'state', 'split', 'origin', 'inherits', 'known_as', 'created_at', 'updated_at'].filter((c) => contactCols.has(c));
      db.exec(`INSERT INTO contacts (${keep.join(', ')}) SELECT ${keep.join(', ')} FROM contacts_v3_old`);
      db.exec('DROP TABLE contacts_v3_old');
      // an address-only contact's row now says itself whether it is blocked (see `fileDecides` above)
      if (fileDecides) {
        const setState = db.prepare('UPDATE contacts SET state = ? WHERE id = ?');
        for (const r of old) if (r.address && !r.handle && r.origin !== OWN_DEVICE && r.id !== SELF_CONTACT) setState.run(blockedList.has(r.address) ? 'blocked' : 'active', r.id);
      }
      const move = db.prepare('UPDATE contacts SET my_address = ?, known_as = ? WHERE id = ?');
      for (const [id, my] of owner) {
        if (!my) continue;
        move.run(my, my, id);
        // (the addresses seen under a contact are kept for the first address's contacts only)
        db.prepare('DELETE FROM contact_addresses WHERE contact_id = ?').run(id);
        moved++;
      }
      const insert = db.prepare(
        `INSERT INTO contacts (id, my_address, handle, agent, address, remark, group_label, state, split, origin, known_as, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?, 'done', NULL, ?, ?, ?)`,
      );
      for (const c of created) {
        insert.run(c.id, c.my, c.address, c.group, c.blocked ? 'blocked' : 'active', c.my, c.at, now);
        if (!c.my && hasTable(db, 'contact_addresses')) {
          db.prepare(
            `INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, ?, NULL, ?, ?)
             ON CONFLICT(address) DO NOTHING`,
          ).run(c.address, c.id, c.at, now);
        }
      }
      db.exec(CONTACT_INDEXES);
    } else if (!contactCols.size) {
      db.exec(CONTACTS_TABLE);
      db.exec(CONTACT_INDEXES);
    }
    opts.hook?.('contacts');

    // ---- 4. message requests: one per (my address, sender) ---------------------------------------
    let elsewhere = 0;
    if (rebuildRequests) {
      db.exec('ALTER TABLE morse_requests RENAME TO morse_requests_v3_old');
      db.exec(REQUESTS_TABLE);
      const want = columns(db, 'morse_requests');
      const keep = [...requestCols].filter((c) => want.has(c));
      db.exec(`INSERT INTO morse_requests (${keep.join(', ')}) SELECT ${keep.join(', ')} FROM morse_requests_v3_old`);
      db.exec('DROP TABLE morse_requests_v3_old');
      if (requestCols.has('to_address')) {
        const rows = db.prepare(`SELECT handle, to_address FROM morse_requests WHERE to_address IS NOT NULL AND to_address != ''`).all() as Array<{ handle: string; to_address: string }>;
        for (const r of rows) {
          // only a request that really came by address (keyed by one) belongs to the address it was written to
          const my = isAddress(r.handle) ? mine(r.to_address) : '';
          if (!my) continue;
          db.prepare(`UPDATE morse_requests SET my_address = ? WHERE handle = ? AND my_address = ''`).run(my, r.handle);
          elsewhere++;
        }
      }
    } else if (!requestCols.size) db.exec(REQUESTS_TABLE);
    opts.hook?.('requests');

    // ---- 5. blocks by address ---------------------------------------------------------------------
    // (ADR-083 review R2) Until now a block was the whole computer's. So every block that exists at this moment
    // keeps blocking that peer at EVERY address this computer has at this moment — not only where a contact or
    // a request happened to be recorded: someone rejected while their request waited at `work` would otherwise
    // be blocked at the first address and free to ask again at `work`. Nothing new is revealed by it (they
    // could already see they were blocked everywhere), and nobody who was blocked becomes reachable by
    // upgrading. A block made AFTER this step is one address's alone, and an address added later starts with
    // no blocks: it is a new persona.
    db.exec(SCHEMA_BLOCKS);
    let blocks = 0;
    const block = db.prepare('INSERT INTO address_blocks (my_address, address, at) VALUES (?, ?, ?) ON CONFLICT(my_address, address) DO NOTHING');
    if (rebuildContacts) {
      /** their address → blocked at every address of mine (true), or at every one BUT the first (false). */
      const carry = new Map<string, boolean>();
      const everywhere = (a: string | null | undefined) => {
        const n = a ? normalizeAddress(a) : null;
        if (n) carry.set(n, true);
      };
      const elsewhere = (a: string | null | undefined) => {
        const n = a ? normalizeAddress(a) : null;
        if (n && !carry.has(n)) carry.set(n, false);
      };
      const person = (r: OldContact): boolean => r.id !== SELF_CONTACT && r.origin !== OWN_DEVICE;
      // (a) blocked by address: the address-shaped entries of morse-blocked.json — or, where there is no file
      //     to ask (tests), the address-only contacts whose row says so
      if (fileDecides) for (const h of blockedList) everywhere(normalizeAddress(h));
      else for (const r of old) if (person(r) && !r.handle && r.state === 'blocked') everywhere(r.address);
      // (b) one of your own computers whose row says blocked (the release before obeyed the row for those)
      for (const r of old) if (r.origin === OWN_DEVICE && r.state === 'blocked') everywhere(r.address);
      // (c) a blocked OLD HANDLE: every address known for it — its contacts' own addresses, the addresses seen
      //     under them, its paired computers whose certificate is pinned, the tombstones of its removed contacts.
      //     At the first address morse-blocked.json keeps deciding the handle (as before: unblocking the handle
      //     lifts it there, and a computer with one address gets no row at all); the other addresses know no
      //     handle, so there the block is written down by address.
      const blockedHandle = new Set(fileDecides ? [...blockedList].filter((h) => !normalizeAddress(h)) : old.filter((r) => person(r) && r.handle && r.state === 'blocked').map((r) => r.handle!.toLowerCase()));
      if (blockedHandle.size) {
        const theirs = old.filter((r) => person(r) && r.handle && blockedHandle.has(r.handle.toLowerCase()));
        for (const r of theirs) elsewhere(r.address);
        if (hasTable(db, 'contact_addresses')) {
          const seen = db.prepare('SELECT address FROM contact_addresses WHERE contact_id = ?');
          for (const r of theirs) for (const x of seen.all(r.id) as Array<{ address: string }>) elsewhere(x.address);
        }
        for (const d of ctx.devices?.() ?? []) if (d.tier !== 'owner' && d.address && blockedHandle.has(d.name.toLowerCase())) elsewhere(d.address);
        for (const t of tombstones) if (t.handle && t.origin !== OWN_DEVICE && blockedHandle.has(t.handle)) elsewhere(t.address);
      }
      if (carry.size) {
        // every address this computer has now: its first (''), the ones its agents have (`morse address`), and
        // any the database itself names
        const others = new Set<string>();
        const named = [
          ...(messageCols.has('my_address') ? (db.prepare(`SELECT DISTINCT my_address AS a FROM messages WHERE my_address IS NOT NULL AND my_address != ''`).all() as Array<{ a: string }>) : []),
          ...(contactCols.has('known_as') ? old.map((r) => ({ a: r.known_as ?? '' })) : []),
          ...(requestCols.has('to_address') ? (db.prepare(`SELECT DISTINCT to_address AS a FROM morse_requests WHERE to_address IS NOT NULL AND to_address != ''`).all() as Array<{ a: string }>) : []),
        ];
        for (const { a } of named) if (a && mine(a)) others.add(mine(a));
        if (ctx.ownAddresses) {
          let listed: string[];
          try {
            listed = [...new Set(ctx.ownAddresses().flatMap((a) => normalizeAddress(a) ?? []))];
          } catch (e) {
            // which addresses this computer has cannot be read: a block would be left out at one of them — nothing is guessed
            throw new MigrationRefusedV4(
              `cannot tell which addresses are here (${e instanceof Error ? e.message : String(e)}) — the people you blocked could not be kept blocked at each of them; your contacts were not changed; the upgrade runs again the next time morse starts`,
            );
          }
          // (one address listed and the key unreadable: that one is the first — there is no other to carry anything to)
          if (first !== null || listed.length > 1) for (const a of listed) if (mine(a)) others.add(mine(a));
        }
        const everyAddress = ['', ...[...others].sort()];
        for (const [theirs, alsoFirst] of carry) {
          if (theirs === first || others.has(theirs)) continue; // (an address of this computer is nobody to block)
          for (const my of everyAddress) if (my || alsoFirst) blocks += block.run(my, theirs, now).changes;
        }
      }
      // the rows made above for a blocked person
      for (const c of created) if (c.blocked) blocks += block.run(c.my, c.address, now).changes;
      // …and every contact with only an address says itself that it is blocked where it is (a row is never made for a block)
      db.prepare(
        `UPDATE contacts SET state = 'blocked' WHERE state != 'blocked' AND handle IS NULL AND address IS NOT NULL AND id != ? AND COALESCE(origin, '') != ?
           AND EXISTS (SELECT 1 FROM address_blocks b WHERE b.my_address = contacts.my_address AND b.address = contacts.address)`,
      ).run(SELF_CONTACT, OWN_DEVICE);
    }

    // ---- 6. messages of the new rows --------------------------------------------------------------
    const point = db.prepare('UPDATE messages SET contact_id = ? WHERE id = ?');
    for (const r of repointed) point.run(r.to, r.id);
    opts.hook?.('messages');

    if (!hasTable(db, 'migration_marks')) db.exec('CREATE TABLE IF NOT EXISTS migration_marks (key TEXT PRIMARY KEY, value TEXT, at INTEGER NOT NULL)');
    if (backupPath) db.prepare('INSERT INTO migration_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(P4_BACKUP_MARK, backupPath, now);
    if (ctx.blockedHandles) {
      db.prepare('INSERT INTO migration_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(P4_BLOCKS_SEEN_MARK, JSON.stringify([...blockedList].filter((h) => isAddress(h)).sort()), now);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION_V4}`);
    const contacts = (db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
    return { from, to: SCHEMA_VERSION_V4, contacts, moved, created: created.length, elsewhere: moved + created.filter((c) => c.my).length, repointed: repointed.length, requests: elsewhere, blocks, backup: backupPath };
  });
  let report: MigrationReportV4 | null;
  try {
    report = run.immediate();
  } catch (e) {
    try {
      (taken as Taken | null)?.discard(); // rolled back: the backup of a migration that did not happen goes too
    } catch {
      /* best effort */
    }
    throw e;
  }
  (taken as Taken | null)?.keep();
  return report;
}

/**
 * (ADR-083 §13) Rows a morse of the release before — still running after the migration — wrote: it knows
 * nothing of `my_address`, so its rows say '' = the first address. Two kinds of them say themselves that
 * they are another address's, in what that release DID record: a request that came by address
 * (`to_address`), and a contact with only an address whose first mail ran over another address
 * (`known_as`, the column that release keeps writing). Those are handed to the address they name, so
 * that nothing which exists because of one address is ever read as the first address's. Everything
 * else such a process writes is the first address's — which is exactly what it meant. Cheap, idempotent,
 * run on every open; without the first address known nothing is touched.
 */
export function adoptOlderWrites(db: Db, ctx: ContactContext): number {
  let n = 0;
  // (ADR-083 review R7) An address a morse of the release before blocked since (it only knows morse-blocked.json,
  // and marks the ONE contact row it found for that address `blocked`): blocked at the address of mine THAT
  // contact belongs to, and nowhere else — a block made after the upgrade is one address's. Nobody's contact
  // (a rejected request): the first address, whose business that file was. Entries that were there at the
  // migration are not read again. And when that morse unblocks them again — the entry leaves the file — the
  // blocks taken over from it are lifted: only those (`P4_BLOCKS_ADOPTED_MARK`); a block that was there at
  // the migration, or one made with this release, is not touched by what the file says later.
  try {
    if (ctx.blockedHandles && hasTable(db, 'migration_marks') && hasTable(db, 'address_blocks')) {
      const listed = ctx.blockedHandles().map((h) => h.toLowerCase()).filter((h) => isAddress(h));
      const read = <T>(key: string, fallback: T): T => {
        try {
          const v = JSON.parse((db.prepare('SELECT value FROM migration_marks WHERE key = ?').get(key) as { value: string | null } | undefined)?.value ?? 'null') as T | null;
          return v ?? fallback;
        } catch {
          return fallback; // an unreadable mark: every listed address is taken (blocking is the safe side)
        }
      };
      const seenRaw = read<unknown>(P4_BLOCKS_SEEN_MARK, []);
      const seen = Array.isArray(seenRaw) ? seenRaw.filter((x): x is string => typeof x === 'string') : [];
      const adoptedRaw = read<unknown>(P4_BLOCKS_ADOPTED_MARK, {});
      const adopted: Record<string, { my: string[]; at: number }> = {};
      if (adoptedRaw && typeof adoptedRaw === 'object' && !Array.isArray(adoptedRaw)) {
        for (const [address, v] of Object.entries(adoptedRaw as Record<string, { my?: unknown; at?: unknown } | null>)) {
          if (isAddress(address) && v && Array.isArray(v.my) && typeof v.at === 'number') adopted[address] = { my: v.my.filter((x): x is string => typeof x === 'string'), at: v.at };
        }
      }
      const fresh = listed.filter((a) => !seen.includes(a));
      const lifted = Object.keys(adopted).filter((a) => !listed.includes(a));
      if (fresh.length || lifted.length) {
        const at = Date.now();
        const put = db.prepare('INSERT INTO migration_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        db.transaction(() => {
          for (const a of fresh) {
            const rows = db.prepare(`SELECT id, my_address, state FROM contacts WHERE address = ? AND handle IS NULL AND origin IS NULL AND id != ?`).all(a, SELF_CONTACT) as Array<{ id: string; my_address: string | null; state: string }>;
            const has = (my: string): boolean => Boolean(db.prepare('SELECT 1 FROM address_blocks WHERE my_address = ? AND address = ?').get(my, a));
            // the row it marked: `blocked`, and no block of this release says why
            let at_: string[] = rows.filter((r) => r.state === 'blocked' && !has(r.my_address ?? '')).map((r) => r.my_address ?? '');
            if (!at_.length && rows.length === 1) at_ = [rows[0]!.my_address ?? ''];
            if (!at_.length && rows.length > 1) {
              // (several contacts have that address and none is marked: the one that release's own lookup finds —
              // its statement, src/mailbox/contacts.ts `rowByAddress` at af4ca40)
              const found = db.prepare('SELECT * FROM contacts WHERE address = ?').get(a) as { my_address: string | null } | undefined;
              at_ = [found?.my_address ?? ''];
            }
            if (!rows.length) at_ = [''];
            const took: string[] = [];
            for (const my of at_) {
              if (db.prepare(`INSERT INTO address_blocks (my_address, address, at) VALUES (?, ?, ?) ON CONFLICT(my_address, address) DO NOTHING`).run(my, a, at).changes) {
                took.push(my);
                n++;
              }
              db.prepare(`UPDATE contacts SET state = 'blocked' WHERE my_address = ? AND address = ? AND handle IS NULL AND origin IS NULL`).run(my, a);
            }
            if (took.length) adopted[a] = { my: took, at };
          }
          for (const a of lifted) {
            const was = adopted[a]!;
            for (const my of was.my) {
              // (only the block that was taken over: one made again since, with this release, has another time)
              if (db.prepare('DELETE FROM address_blocks WHERE my_address = ? AND address = ? AND at = ?').run(my, a, was.at).changes) {
                db.prepare(`UPDATE contacts SET state = 'active' WHERE my_address = ? AND address = ? AND handle IS NULL AND origin IS NULL`).run(my, a);
                n++;
              }
            }
            delete adopted[a];
          }
          // (an entry that left the file is forgotten: blocked there again later, it is taken over again)
          const stillSeen = [...new Set([...seen, ...fresh])].filter((a) => !lifted.includes(a));
          put.run(P4_BLOCKS_SEEN_MARK, JSON.stringify(stillSeen.sort().slice(-5000)), at);
          put.run(P4_BLOCKS_ADOPTED_MARK, JSON.stringify(Object.fromEntries(Object.entries(adopted).sort(([x], [y]) => (x < y ? -1 : 1)))), at);
        }).immediate();
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code !== 'SQLITE_READONLY') throw e;
  }
  const first = ctx.firstAddress?.() ?? null;
  if (!first) return n;
  try {
    if (!columns(db, 'contacts').has('known_as') || !columns(db, 'morse_requests').has('to_address')) return 0;
    const run = db.transaction(() => {
      const requests = db
        .prepare(`SELECT handle, to_address FROM morse_requests WHERE my_address = '' AND to_address IS NOT NULL AND to_address != '' AND to_address != ?`)
        .all(first) as Array<{ handle: string; to_address: string }>;
      for (const r of requests) {
        if (!isAddress(r.handle) || !isAddress(r.to_address)) continue;
        if (db.prepare('SELECT 1 FROM morse_requests WHERE my_address = ? AND handle = ?').get(r.to_address, r.handle)) db.prepare(`DELETE FROM morse_requests WHERE my_address = '' AND handle = ?`).run(r.handle);
        else db.prepare(`UPDATE morse_requests SET my_address = ? WHERE my_address = '' AND handle = ?`).run(r.to_address, r.handle);
        n++;
      }
      const contacts = db
        .prepare(
          `SELECT id, address, known_as FROM contacts WHERE my_address = '' AND handle IS NULL AND origin IS NULL AND id != ? AND address IS NOT NULL
             AND known_as IS NOT NULL AND known_as != '' AND known_as != ?`,
        )
        .all(SELF_CONTACT, first) as Array<{ id: string; address: string; known_as: string }>;
      for (const c of contacts) {
        if (!isAddress(c.known_as)) continue;
        if (db.prepare('SELECT 1 FROM contacts WHERE my_address = ? AND address = ?').get(c.known_as, c.address)) continue; // that pair has its contact already
        db.prepare('UPDATE contacts SET my_address = ? WHERE id = ?').run(c.known_as, c.id);
        db.prepare('DELETE FROM contact_addresses WHERE contact_id = ?').run(c.id);
        n++;
      }
    });
    if (
      db.prepare(`SELECT 1 FROM morse_requests WHERE my_address = '' AND to_address IS NOT NULL AND to_address != '' AND to_address != ? LIMIT 1`).get(first) ||
      db.prepare(`SELECT 1 FROM contacts WHERE my_address = '' AND handle IS NULL AND origin IS NULL AND known_as IS NOT NULL AND known_as != '' AND known_as != ? LIMIT 1`).get(first)
    )
      run.immediate();
  } catch (e) {
    if ((e as { code?: string }).code !== 'SQLITE_READONLY') throw e;
  }
  return n;
}
