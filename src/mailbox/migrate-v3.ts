import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import type { Db } from './db.js';
import { checkRemark, CONTACT_INDEXES, CONTACTS_TABLE, createContactStore, OWN_DEVICE, SCHEMA_V2, SELF_CONTACT, type ContactContext } from './contacts.js';

/**
 * Mailbox schema v3 (ADR-077, identity v3 phase 2): contacts per ADDRESS instead of per
 * v2 handle. The local half of the migration, run when the database is opened:
 *
 * - the contacts table is rebuilt: `handle` (now a frozen old name) is no longer unique,
 *   new columns agent / address / split / origin / inherits; every existing row keeps its id,
 *   so no message row is touched;
 * - every contact by handle is marked `split = pending` (the daemon asks the relay which
 *   agents / addresses live under it — src/cluster/contact-split.ts) and, when exactly one
 *   of its paired devices is known with a pinned certificate, gets that device's address;
 * - a contact without a remark gets its old handle as remark (what was shown stays shown);
 * - each of YOUR OWN paired computers (trust tier owner) whose address is known becomes a
 *   contact in group `self`.
 *
 * One IMMEDIATE transaction that re-checks the version inside: killed halfway = rolled back
 * = run again on the next open; a second run is a no-op; processes that open the database at
 * the same moment wait for the one that migrates and then find nothing to do. The backup is
 * taken inside that transaction (backupForP2): one per computer, only what is rewritten. Messages, requests, the outbox,
 * blocks and every v2 file are left exactly as they are.
 */

export const SCHEMA_VERSION_V3 = 3;
export const P2_BACKUP_MARK = 'p2.backup';
/** Files of ~/.morse the migration reads (and the one it rewrites, mailbox.db) — all copied first. */
export const P2_BACKUP_FILES = ['config.json', 'trusted-devices.json', 'peer-keys.json', 'morse-blocked.json'] as const;

export interface MigrationReportV3 {
  from: number;
  to: number;
  contacts: number;
  /** Contacts by old handle that wait for the relay to say which agents they have. */
  pending: number;
  /** Contacts that got an address from a pinned device certificate. */
  addressed: number;
  /** Contacts made from your own paired computers (group self). */
  ownDevices: number;
  backup: string | null;
}

const userVersion = (db: Db): number => Number(db.pragma('user_version', { simple: true })) || 0;
const columns = (db: Db, table: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
const hasTable = (db: Db, table: string): boolean => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));

/** Bring an older `contacts` table (handle UNIQUE, no address columns) to the v3 shape, keeping every row. */
export function rebuildContacts(db: Db): boolean {
  if (!hasTable(db, 'contacts')) {
    db.exec(SCHEMA_V2);
    return false;
  }
  if (columns(db, 'contacts').has('agent')) {
    db.exec(SCHEMA_V2); // indexes / helper tables a partial earlier build may lack
    return false;
  }
  db.exec('DROP INDEX IF EXISTS contacts_remark');
  db.exec('ALTER TABLE contacts RENAME TO contacts_v2_old');
  db.exec(CONTACTS_TABLE);
  db.exec(
    `INSERT INTO contacts (id, handle, remark, nickname, group_label, state, created_at, updated_at)
       SELECT id, handle, remark, nickname, group_label, state, created_at, updated_at FROM contacts_v2_old`,
  );
  db.exec('DROP TABLE contacts_v2_old');
  db.exec(CONTACT_INDEXES);
  db.exec(SCHEMA_V2);
  return true;
}

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** The tables the migration rewrites or adds rows to — all it needs to copy of the database. */
export const P2_BACKUP_TABLES = ['contacts', 'contact_agents', 'contact_addresses'] as const;
const IN_PROGRESS = 'IN-PROGRESS';
const BESIDE_SUFFIX = '.v2-contacts.bak';

/** No backup could be written anywhere: the migration did not start, nothing was changed. */
export class BackupError extends Error {}

/** Copy the contact tables (schema + rows) of `db` into a new small SQLite file (0600). */
function copyContactTables(db: Db, target: string): void {
  const out = new Database(target);
  try {
    chmodSync(target, 0o600);
    out.exec('BEGIN');
    for (const table of P2_BACKUP_TABLES) {
      const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string } | undefined)?.sql;
      if (!ddl) continue;
      out.exec(ddl);
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]!);
      const insert = out.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const r of rows) insert.run(...cols.map((c) => r[c]));
    }
    out.exec('COMMIT');
    out.pragma(`user_version = ${userVersion(db)}`);
  } finally {
    out.close();
  }
}

export interface BackupPlan {
  /** ~/.morse — the backup goes to `<morseDir>/backups/identity-v3-p2-<UTC stamp>/`. */
  morseDir?: string;
  /** The database file — the fallback is `<dbPath>.v2-contacts.bak` next to it. */
  dbPath?: string;
}

export interface TakenBackup {
  path: string;
  /** Remove it again (the migration it was for did not happen). */
  discard(): void;
  /** The migration is committed: this backup is the one. */
  keep(): void;
}

/**
 * The ONE backup of this computer's migration, taken by the process that holds the database's
 * write lock and is about to migrate (so concurrent openers never make copies of their own).
 * Only what the migration rewrites: the contact tables as a small SQLite file (`contacts.sqlite`
 * — not the messages), plus the small JSON files it reads, and a MANIFEST.json. Directory 0700,
 * every file 0600. A directory left by a run that was killed mid-way (still marked IN-PROGRESS)
 * is removed first. When ~/.morse/backups cannot be written the contact tables go to
 * `<db>.v2-contacts.bak`; when that fails too: BackupError, nothing written, nothing changed.
 */
export function backupForP2(db: Db, plan: BackupPlan, now: number = Date.now()): TakenBackup {
  const errors: string[] = [];
  const tried: string[] = [];
  if (plan.morseDir) {
    const root = join(plan.morseDir, 'backups');
    let dir: string | null = null;
    tried.push(join(root, `identity-v3-p2-${stamp(now)}`));
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(root)) if (name.startsWith('identity-v3-p2-') && existsSync(join(root, name, IN_PROGRESS))) rmSync(join(root, name), { recursive: true, force: true });
      dir = join(root, `identity-v3-p2-${stamp(now)}`);
      for (let i = 1; existsSync(dir); i++) dir = join(root, `identity-v3-p2-${stamp(now)}-${i}`);
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
      const made = dir;
      writeFileSync(join(made, IN_PROGRESS), `${process.pid}\n`, { mode: 0o600 });
      const files: Record<string, number> = {};
      copyContactTables(db, join(made, 'contacts.sqlite'));
      files['contacts.sqlite'] = statSync(join(made, 'contacts.sqlite')).size;
      for (const name of P2_BACKUP_FILES) {
        const src = join(plan.morseDir, name);
        if (!existsSync(src)) continue;
        copyFileSync(src, join(made, name));
        chmodSync(join(made, name), 0o600);
        files[name] = statSync(join(made, name)).size;
      }
      writeFileSync(
        join(made, 'MANIFEST.json'),
        `${JSON.stringify(
          {
            migration: 'identity-v3-p2',
            adr: 'ADR-077',
            createdAt: new Date(now).toISOString(),
            fromUserVersion: userVersion(db),
            tables: P2_BACKUP_TABLES,
            files,
            note: 'contacts.sqlite holds the contact tables as they were before the migration (no message was changed by it); the JSON files are copies of what it read.',
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
      copyContactTables(db, partial);
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
  throw new BackupError(
    `cannot back up your contacts before upgrading them to one per address (${errors.join('; ')}) — free some disk space or make ${plan.morseDir ?? dirname(plan.dbPath ?? '.')} writable (tried ${tried.join(' and ')}). Nothing was changed; the upgrade runs again the next time morse starts.`,
  );
}

/**
 * A crash between the migration's commit and the end of the backup's `keep()` leaves the backup
 * complete but still marked unfinished (the IN-PROGRESS file, or the `.partial` name of the
 * beside-the-database copy). The database names its backup: on a later open, finish the marking.
 * Cosmetic — the copy itself was complete before the migration began.
 */
export function settleBackupMark(db: Db): void {
  try {
    if (!hasTable(db, 'migration_marks')) return;
    const path = (db.prepare('SELECT value FROM migration_marks WHERE key = ?').get(P2_BACKUP_MARK) as { value: string | null } | undefined)?.value;
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

export type MigrationStage = 'backup' | 'rebuild' | 'contacts';

/**
 * Run the v3 migration (see the file comment). null = already at v3 (nothing done, no backup).
 * `backup`: where the one backup goes — taken INSIDE the transaction, i.e. only by the process
 * that migrates, and removed again if the migration fails; a string = a copy this open already
 * took (v1 → v3 in one go). `hook` is for tests (called after each stage, inside the transaction).
 */
export function migrateToV3(db: Db, ctx: ContactContext, opts: { now?: number; backup?: BackupPlan | string | null; hook?: (stage: MigrationStage) => void } = {}): MigrationReportV3 | null {
  const now = opts.now ?? Date.now();
  let taken: TakenBackup | null = null;
  const run = db.transaction((): MigrationReportV3 | null => {
    const from = userVersion(db);
    if (from >= SCHEMA_VERSION_V3) return null;
    const plan = opts.backup;
    const worthIt = hasTable(db, 'contacts') && P2_BACKUP_TABLES.some((t) => hasTable(db, t) && (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n > 0);
    if (plan && typeof plan === 'object' && worthIt) taken = backupForP2(db, plan, now);
    const backupPath = typeof plan === 'string' ? plan : ((taken as TakenBackup | null)?.path ?? null);
    opts.hook?.('backup');
    rebuildContacts(db);
    opts.hook?.('rebuild');
    const store = createContactStore(db, { now: () => now, ctx });
    const me = ctx.selfHandle?.()?.toLowerCase() ?? null;
    const devices = ctx.devices?.() ?? [];
    const rows = db.prepare(`SELECT id, handle, remark, address FROM contacts WHERE id != ? AND handle IS NOT NULL AND agent IS NULL AND COALESCE(origin, '') != ?`).all(SELF_CONTACT, OWN_DEVICE) as Array<{
      id: string;
      handle: string;
      remark: string | null;
      address: string | null;
    }>;
    let pending = 0;
    let addressed = 0;
    for (const r of rows) {
      if (me && r.handle === me) continue;
      db.prepare(`UPDATE contacts SET split = COALESCE(split, 'pending') WHERE id = ?`).run(r.id);
      pending++;
      // "displayed by handle" stays displayed by handle: the old handle becomes the remark
      if (!r.remark) {
        let ok = true;
        try {
          checkRemark(r.handle);
        } catch {
          ok = false;
        }
        if (ok && !db.prepare('SELECT 1 FROM contacts WHERE lower(remark) = lower(?)').get(r.handle)) db.prepare('UPDATE contacts SET remark = ? WHERE id = ?').run(r.handle, r.id);
      }
      // one paired device, certificate pinned: its key IS the contact's address (spec §12.2)
      const theirs = devices.filter((d) => d.tier === 'peer' && d.name.toLowerCase() === r.handle);
      const only = theirs.length === 1 ? theirs[0]! : null;
      if (only?.address && !r.address && !db.prepare('SELECT 1 FROM contacts WHERE address = ?').get(only.address)) {
        db.prepare('UPDATE contacts SET address = ? WHERE id = ?').run(only.address, r.id);
        store.seenAddress(r.id, only.address, only.id, now);
        addressed++;
      }
    }
    opts.hook?.('contacts');
    // your own other computers → contacts in group self (owner decision 2026-11-14; no confirmation)
    let ownDevices = 0;
    for (const d of devices) {
      if (d.tier !== 'owner' || !d.address) continue;
      const name = d.name.toLowerCase();
      // paired by ID in the LAN era under a name of its own: that name is how its mail is labelled
      const before = store.ownDevice(d.address);
      // (a name of its own is only its remark — never a handle: someone else may hold that handle on the relay)
      const c = store.ensureOwnDevice({ deviceId: d.id, address: d.address, ...(me && name === me ? {} : { name: d.name }) });
      if (c && !before && c.origin === OWN_DEVICE) ownDevices++;
    }
    if (backupPath) store.setMark(P2_BACKUP_MARK, backupPath);
    db.pragma(`user_version = ${SCHEMA_VERSION_V3}`);
    const contacts = (db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
    return { from, to: SCHEMA_VERSION_V3, contacts, pending, addressed, ownDevices, backup: backupPath };
  });
  let report: MigrationReportV3 | null;
  try {
    report = run.immediate();
  } catch (e) {
    try {
      (taken as TakenBackup | null)?.discard(); // rolled back: the backup of a migration that did not happen goes too
    } catch {
      /* best effort */
    }
    throw e;
  }
  (taken as TakenBackup | null)?.keep();
  return report;
}
