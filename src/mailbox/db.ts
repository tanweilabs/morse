import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../home.js';
import Database from 'better-sqlite3';
import type { ContactContext } from './contacts.js';
import { homeContactContext } from './home-context.js';
import { backfillRows, backupBeforeMigrate, migrateToV2, SCHEMA_VERSION, userVersion, type MigrationReport } from './migrate-v2.js';
import { migrateToV3, SCHEMA_VERSION_V3, settleBackupMark, type MigrationReportV3 } from './migrate-v3.js';
import { adoptOlderWrites, migrateToV4, SCHEMA_VERSION_V4, settleBackupMarkV4, type MigrationReportV4 } from './migrate-v4.js';
import { convertKnownHandles, migrateToV5, SCHEMA_VERSION_V5, settleBackupMarkV5, type MigrationReportV5 } from './migrate-v5.js';
import { repairAfterV5, type RepairReportV5 } from './repair-v5.js';
import { REQUESTS_TABLE } from './requests.js';

export type Db = Database.Database;

/** Where the mailbox lives unless a caller names another file: `<data>/mailbox.db`. */
export function defaultDbPath(): string {
  return join(dataDir(), 'mailbox.db');
}

// ---------------------------------------------------------------------------------------------
// Base schema. Each table is listed as data and rendered to its CREATE statement below; the
// rendered text is what SQLite keeps in sqlite_master (and what the contact backups copy), so the
// column order and wording here are part of the on-disk format — append, never edit.
// ---------------------------------------------------------------------------------------------

/** `[column name, type and constraints]` */
type ColumnDef = readonly [string, string];

interface TableDef {
  name: string;
  columns: readonly ColumnDef[];
  /** table-level constraints, rendered after the columns */
  constraints?: readonly string[];
}

const CONVERSATIONS_TABLE: TableDef = {
  name: 'conversations',
  columns: [
    ['id', 'TEXT PRIMARY KEY'],
    ['pair_key', 'TEXT NOT NULL UNIQUE'],
    ['a_agent', 'TEXT NOT NULL'],
    ['a_session', 'TEXT NOT NULL'],
    ['a_device', 'TEXT'],
    ['b_agent', 'TEXT NOT NULL'],
    ['b_session', 'TEXT NOT NULL'],
    ['b_device', 'TEXT'],
    ['created_at', 'INTEGER NOT NULL'],
    ['last_message_at', 'INTEGER NOT NULL'],
  ],
};

const MESSAGES_TABLE: TableDef = {
  name: 'messages',
  columns: [
    ['id', 'TEXT PRIMARY KEY'],
    ['conversation_id', 'TEXT NOT NULL REFERENCES conversations(id)'],
    ['context_id', 'TEXT NOT NULL'],
    ['from_agent', 'TEXT NOT NULL'],
    ['from_session', 'TEXT NOT NULL'],
    ['from_device', 'TEXT'],
    ['to_agent', 'TEXT NOT NULL'],
    ['to_session', 'TEXT NOT NULL'],
    ['to_device', 'TEXT'],
    ['parts', 'TEXT NOT NULL'],
    ['status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_error', 'TEXT'],
    ['created_at', 'INTEGER NOT NULL'],
    ['updated_at', 'INTEGER NOT NULL'],
  ],
};

/** Ids of inbound cross-device messages already accepted, so a resend is not filed twice. */
const INBOUND_SEEN_TABLE: TableDef = {
  name: 'inbound_seen',
  columns: [
    ['from_id', 'TEXT NOT NULL'],
    ['msg_id', 'TEXT NOT NULL'],
    ['seen_at', 'INTEGER NOT NULL'],
  ],
  constraints: ['PRIMARY KEY (from_id, msg_id)'],
};

const SESSIONS_CACHE_TABLE: TableDef = {
  name: 'sessions_cache',
  columns: [
    ['agent', 'TEXT NOT NULL'],
    ['session_id', 'TEXT NOT NULL'],
    ['title', 'TEXT NOT NULL'],
    ['cwd', 'TEXT NOT NULL'],
    ['last_active_at', 'INTEGER NOT NULL'],
  ],
  constraints: ['PRIMARY KEY (agent, session_id)'],
};

/** `[index name, table, column list]` */
const MESSAGE_INDEXES: ReadonlyArray<readonly [string, string, string]> = [
  ['idx_messages_status', 'messages', 'status, created_at'],
  ['idx_messages_context', 'messages', 'context_id, created_at'],
  ['idx_messages_to', 'messages', 'to_session, status'],
];

function createTableSql(table: TableDef): string {
  const body = [...table.columns.map(([col, type]) => `${col} ${type}`), ...(table.constraints ?? [])];
  return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${body.map((line) => `  ${line}`).join(',\n')}\n);`;
}

/**
 * Every statement that brings an empty file to the base layout, in order. The message-requests
 * table (ADR-037) is defined next to its code in requests.ts: a stranger's first message waits
 * there, outside `messages`, until the operator accepts or declines it — one row per
 * (my address, sender) since schema v4 (ADR-083).
 */
const BASE_SCHEMA: readonly string[] = [
  createTableSql(CONVERSATIONS_TABLE),
  createTableSql(MESSAGES_TABLE),
  ...MESSAGE_INDEXES.map(([name, table, cols]) => `CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${cols});`),
  createTableSql(INBOUND_SEEN_TABLE),
  REQUESTS_TABLE,
  createTableSql(SESSIONS_CACHE_TABLE),
];

/**
 * Columns added after the base layout, applied on every open (a database that already has one
 * simply rejects the ALTER). `[table, column, type]`; order matters for sqlite_master's text.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  // Phase 2: devices on both ends
  ['conversations', 'a_device', 'TEXT'],
  ['conversations', 'b_device', 'TEXT'],
  ['messages', 'from_device', 'TEXT'],
  ['messages', 'to_device', 'TEXT'],
  // 1 = the message ran inside the target's own live session (Codex queue, ZCode mailbox), so the
  // prompt-hook digest must not report that turn as background work
  ['messages', 'delivered_in_session', 'INTEGER'],
  // trust tier of the sending device for inbound cross-device mail; 'peer' = someone else's device
  // (pull-only, never carries operator authority)
  ['messages', 'from_tier', 'TEXT'],
  // when the recipient device confirmed receipt end to end over the relay
  ['messages', 'receipt_at', 'INTEGER'],
  // 1 = the recipient is just not reachable yet (offline, relay down, no receipt): retried for as
  // long as the outbox allows instead of dead-lettering after three local failures
  ['messages', 'waiting', 'INTEGER NOT NULL DEFAULT 0'],
  // ADR-037, sender side: 1 = it sits in the recipient's message requests until they accept us
  ['messages', 'request', 'INTEGER NOT NULL DEFAULT 0'],
  // ADR-038: JSON [{name,size}] of attachments a request did not keep; sent once it is accepted
  ['morse_requests', 'dropped_file_list', 'TEXT'],
  // ADR-071: 1 = another person's reply in a thread one of our sessions (or the CLI) began —
  // filed to that session, never given to the attendant
  ['messages', 'own_thread', 'INTEGER NOT NULL DEFAULT 0'],
  // ADR-081 (review F1, F3): which address of this computer a request was written to. Set = it came
  // by address, signed by the address in `handle`; NULL = the older device-to-device way.
  ['morse_requests', 'to_address', 'TEXT'],
];

/** Lay down the base tables and the additive columns. Safe to repeat on any existing mailbox. */
function applyBaseSchema(db: Db): void {
  db.exec(BASE_SCHEMA.join('\n'));
  for (const [table, column, type] of ADDED_COLUMNS) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      // already there (or a read-only open): either way nothing to add
    }
  }
}

/** Open the SQLite file (creating its folder), with the connection settings every caller relies on. */
function openSqlite(file: string): { db: Db; existed: boolean } {
  const inMemory = file === ':memory:';
  if (!inMemory) mkdirSync(dirname(file), { recursive: true });
  const existed = !inMemory && existsSync(file);
  const db = new Database(file);
  for (const setting of ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000']) db.pragma(setting);
  return { db, existed };
}

/**
 * ADR-089: a delivery belongs to its holder — the lease of a row that is 'delivering'. holder: a random id
 * per claim (NULL: claimed without a lease, the semantics of before); pid: the process the lease lives and
 * dies with (the plugin, then the agent CLI it started); at / expires_at: epoch ms; all NULL once reported.
 * takeovers: how often a STARTED turn for this row was interrupted and taken over (> 0: a later delivery may
 * be a repeat). Additive, no `user_version` step — the release before does not know them and works as ever.
 *
 * Added only to a mailbox that IS at the current schema version (after the migrations below): an upgrade
 * that is refused (ADR-083) leaves the database exactly as it was, these columns included.
 */
const LEASE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['lease_holder', `ALTER TABLE messages ADD COLUMN lease_holder TEXT`],
  ['lease_pid', `ALTER TABLE messages ADD COLUMN lease_pid INTEGER`],
  ['lease_at', `ALTER TABLE messages ADD COLUMN lease_at INTEGER`],
  ['lease_expires_at', `ALTER TABLE messages ADD COLUMN lease_expires_at INTEGER`],
  ['takeovers', `ALTER TABLE messages ADD COLUMN takeovers INTEGER NOT NULL DEFAULT 0`],
  // when the process `lease_pid` was started, as the system says it (a pid alone can be another program's by now)
  ['lease_pid_start', `ALTER TABLE messages ADD COLUMN lease_pid_start TEXT`],
  // epoch ms: the holder said it is starting an agent turn for this claim — only then can a takeover be a repeat
  ['lease_started_at', `ALTER TABLE messages ADD COLUMN lease_started_at INTEGER`],
  // interrupted turns in a row (no report in between): the third makes the message dead
  ['interrupted', `ALTER TABLE messages ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0`],
  // epoch ms: a started turn's own time limit, said by its holder — past it the lease is dead even if its process lives
  ['lease_hard_until', `ALTER TABLE messages ADD COLUMN lease_hard_until INTEGER`],
];
function addLeaseColumns(db: Db): void {
  const have = new Set((db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((c) => c.name));
  for (const [column, ddl] of LEASE_COLUMNS) {
    if (have.has(column)) continue;
    try {
      db.exec(ddl);
    } catch (e) {
      // another process opening the mailbox at the same moment added it first
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
}

/**
 * ADR-081 (ADR-081 review F1): WHICH of this computer's addresses a message belongs to, as the 26-character
 * address itself (the local name in `agent` is display only — it can be renamed or removed). Outbound:
 * the address it is sent from, when it was sent "as" one (`--from`, a reply to mail written to an
 * address, the address a contact knows you by, anything that goes by address alone). Inbound by
 * address: the address it was written to. '' (outbound) = queued without naming an address: this
 * computer's first address. NULL = not recorded: an inbound row that came the old way — or an outbound
 * row written by the release before (see the marks below).
 */
const MY_ADDRESS_COLUMN = `ALTER TABLE messages ADD COLUMN my_address TEXT`;
/**
 * (ADR-081 review, legacy rows) When this database got `messages.my_address` — epoch ms, written ONCE,
 * in the same transaction that adds the column (a brand-new database: its creation).
 */
export const MY_ADDRESS_MARK = 'p3.my_address';
/**
 * (ADR-081 review, legacy rows) From when every outbound row of this database records its sending
 * address — epoch ms, written ONCE: when a daemon of this release first runs on it (a brand-new
 * database: its creation). Until then the daemon of the release before may still be running and
 * queuing rows without one; before that release no address but the first could send. So an outbound
 * row with `my_address` NULL created BEFORE this moment goes out from the first address, as it always
 * would have; one created after it cannot exist and is refused (src/cluster/morse.ts `senderOf`).
 */
export const SENDERS_RECORDED_MARK = 'p3.my_address.daemon';
const hasColumn = (db: Db, table: string, column: string): boolean => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);

/**
 * Add `messages.my_address` and write its marks — one IMMEDIATE transaction that looks again inside,
 * so several processes opening the database at once add the column once and agree on one moment.
 * `fresh` = this open created the database: nothing older ever wrote to it.
 * A database that has the column but no mark (a development build of this release made it) gets 0:
 * no row of it counts as "from before" (fail closed).
 */
function addMyAddress(db: Db, fresh: boolean, now: number): void {
  const mark = (key: string): boolean => Boolean(db.prepare('SELECT 1 FROM migration_marks WHERE key = ?').get(key));
  if (hasColumn(db, 'messages', 'my_address') && mark(MY_ADDRESS_MARK)) return;
  const put = db.prepare('INSERT INTO migration_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING');
  db.transaction(() => {
    const had = hasColumn(db, 'messages', 'my_address');
    if (!had) db.exec(MY_ADDRESS_COLUMN);
    if (mark(MY_ADDRESS_MARK)) return;
    put.run(MY_ADDRESS_MARK, String(had ? 0 : now), now);
    if (had || fresh) put.run(SENDERS_RECORDED_MARK, String(had ? 0 : now), now);
  }).immediate();
}

export interface CreateDbOptions {
  /** Who we are, to sort existing messages into contacts (ADR-049). Default: read from
   *  the Morse home for the default database, nothing for any other path. */
  ctx?: ContactContext;
  /** Told once when this open migrated the database. */
  onMigrate?: (report: MigrationReport) => void;
  /** ADR-077: told once when this open moved the contacts to schema v3 (per address). */
  onMigrateV3?: (report: MigrationReportV3) => void;
  /** (ADR-083) told once when this open moved contacts, requests and blocks to schema v4 (per address of yours). */
  onMigrateV4?: (report: MigrationReportV4) => void;
  /** (ADR-091) told once when this open made every contact a contact by address (schema v5, v2 removed). */
  onMigrateV5?: (report: MigrationReportV5) => void;
  /** ADR-077: the Morse data directory (~/.morse) whose files are backed up with the database before
   *  the v3 migration. Default: the real one for the default database; none for any other path
   *  (then the copy goes next to the database). */
  morseDir?: string;
  now?: () => number;
  /**
   * (tests of an earlier migration, ADR-091) stop after the step to this schema version — what the release that
   * introduced it left. Nothing else ever passes it: every open brings the mailbox to CURRENT_SCHEMA_VERSION.
   */
  upTo?: number;
  /** (ADR-091 follow-up) told once when this open put right what the v5 upgrade got wrong (`repairAfterV5`). */
  onRepairV5?: (report: RepairReportV5) => void;
  /** (tests) false = leave the v5 repair out — a home exactly as the release before left it. */
  repairV5?: boolean;
}

/** The schema version this build's createDb leaves a mailbox at — raise it with every migration added below. */
export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION_V5;

/**
 * (ADR-083) The schema version (`user_version`) of the mailbox as it is on disk — read only: nothing is
 * created, nothing migrated. null = there is no mailbox yet, or it cannot be read.
 */
export function mailboxVersion(path: string = defaultDbPath()): number | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return Number(db.pragma('user_version', { simple: true })) || 0;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Open the mailbox database, creating it when missing, and bring it to CURRENT_SCHEMA_VERSION.
 * Tests pass ':memory:'.
 */
export function createDb(path: string = defaultDbPath(), opts: CreateDbOptions = {}): Db {
  const { db, existed } = openSqlite(path);
  applyBaseSchema(db);
  const ctx = opts.ctx ?? (path === defaultDbPath() ? homeContactContext() : {});
  const now = opts.now ?? Date.now;
  /** A copy this very open already took of the untouched database (v1 → v2 → v3 in one go needs one). */
  let earlier: string | null = null;
  const upTo = opts.upTo ?? CURRENT_SCHEMA_VERSION;
  /** (ADR-091 follow-up) a home the release before had upgraded already — only then is the repair said on its own */
  const atV5Before = userVersion(db) >= SCHEMA_VERSION_V5;
  if (userVersion(db) < SCHEMA_VERSION) {
    // ADR-049: a copy of the old database first (only one that already held messages)
    const hasRows = existed && (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n > 0;
    const backup = hasRows ? backupBeforeMigrate(db, path, now()) : null;
    const report = migrateToV2(db, ctx, { now: now(), backup });
    if (report) opts.onMigrate?.(report);
    earlier = backup;
  }
  let migratedV3 = false;
  if (userVersion(db) < SCHEMA_VERSION_V3 && upTo >= SCHEMA_VERSION_V3) {
    migratedV3 = true;
    // ADR-077: contacts per address. The backup is taken by migrateToV3 itself, inside its transaction —
    // so only the one process that migrates makes one; everyone else waits here and finds it done.
    const morseDir = opts.morseDir ?? (path === defaultDbPath() ? dataDir() : undefined);
    db.pragma('busy_timeout = 30000');
    try {
      const report = migrateToV3(db, ctx, { now: now(), backup: !existed ? null : (earlier ?? { ...(morseDir ? { morseDir } : {}), ...(path !== ':memory:' ? { dbPath: path } : {}) }) });
      if (report) opts.onMigrateV3?.(report);
    } finally {
      db.pragma('busy_timeout = 5000');
    }
  }
  const wasV3 = !migratedV3;
  if (userVersion(db) < SCHEMA_VERSION_V4 && upTo >= SCHEMA_VERSION_V4) {
    // (ADR-083) contacts, requests and blocks per address of mine — same discipline: the backup is taken by
    // migrateToV4 itself, inside its transaction; everyone else waits here and finds it done
    const morseDir = opts.morseDir ?? (path === defaultDbPath() ? dataDir() : undefined);
    db.pragma('busy_timeout = 30000');
    try {
      const report = migrateToV4(db, ctx, { now: now(), backup: !existed ? null : { ...(morseDir ? { morseDir } : {}), ...(path !== ':memory:' ? { dbPath: path } : {}) } });
      if (report) opts.onMigrateV4?.(report);
    } finally {
      db.pragma('busy_timeout = 5000');
    }
  } else if (userVersion(db) >= SCHEMA_VERSION_V4) {
    if (path !== ':memory:') settleBackupMarkV4(db);
    // (ADR-083 §13) rows a morse of the release before wrote since: handed to the address of mine they name
    adoptOlderWrites(db, ctx);
  }
  if (userVersion(db) < SCHEMA_VERSION_V5 && upTo >= SCHEMA_VERSION_V5) {
    // (ADR-091) every contact by address — same discipline: the backup is taken by migrateToV5 itself, inside its
    // transaction; everyone else waits here and finds it done
    const morseDir = opts.morseDir ?? (path === defaultDbPath() ? dataDir() : undefined);
    db.pragma('busy_timeout = 30000');
    try {
      const report = migrateToV5(db, ctx, { now: now(), backup: !existed ? null : { ...(morseDir ? { morseDir } : {}), ...(path !== ':memory:' ? { dbPath: path } : {}) } });
      if (report) opts.onMigrateV5?.(report);
    } finally {
      db.pragma('busy_timeout = 5000');
    }
  } else if (userVersion(db) >= SCHEMA_VERSION_V5) {
    if (path !== ':memory:') settleBackupMarkV5(db);
    // (ADR-091) a contact by old name that has an address now (written by a morse of the release before, still running)
    convertKnownHandles(db, now());
  }
  // (ADR-091 follow-up) what the v5 upgrade got wrong, put right once — on homes upgraded by the release before and now alike
  if (userVersion(db) >= SCHEMA_VERSION_V5 && upTo >= SCHEMA_VERSION_V5 && opts.repairV5 !== false) {
    const morseDir = opts.morseDir ?? (path === defaultDbPath() ? dataDir() : null);
    const r = repairAfterV5(db, { now: now(), morseDir: path === ':memory:' ? null : morseDir });
    // (an upgrade in this very open says its own line: the repair is part of it)
    if (r && atV5Before) opts.onRepairV5?.(r);
  }
  if (wasV3) {
    if (path !== ':memory:') settleBackupMark(db);
    // rows an older morse (still running somewhere) wrote without direction / contact
    backfillRows(db, ctx, { now: now(), by: 'backfill' });
  }
  // (ADR-081 review: legacy rows, N2) after the steps above — they make migration_marks and contacts
  try {
    addMyAddress(db, !existed, now());
  } catch (e) {
    // a database this process may only read (a sandboxed agent): like the additive columns above, it is
    // added by the next process that can write — reading works without it
    if ((e as { code?: string }).code !== 'SQLITE_READONLY') throw e;
  }
  // (ADR-089) the lease of a delivery — only here, on a mailbox the steps above brought to this version
  try {
    addLeaseColumns(db);
  } catch (e) {
    // read-only (a sandboxed agent): the next process that can write adds them; nothing it reads needs them
    if ((e as { code?: string }).code !== 'SQLITE_READONLY') throw e;
  }
  // (ADR-083) `known_as` is no longer read — the contact row itself says which address of mine it belongs to —
  // but a daemon of the release before, still running, reads and writes it: it stays part of the table
  if (!hasColumn(db, 'contacts', 'known_as')) {
    try {
      db.exec(`ALTER TABLE contacts ADD COLUMN known_as TEXT`);
    } catch {
      /* another process added it between the look and the ALTER, or the database is read-only */
    }
  }
  return db;
}
