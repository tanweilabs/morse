import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import type { Db } from './db.js';
import { MINE_GROUP, OWN_DEVICE, SCHEMA_BLOCKS, SELF_CONTACT, SELF_GROUP, type ContactContext } from './contacts.js';
import { looksLikeAddress, normalizeAddress } from '../identity/address.js';

/**
 * Mailbox schema v5 (ADR-091): v2 is removed — every contact is a contact BY ADDRESS. Run when the database is
 * opened, with the discipline of the v3 and v4 steps (ADR-077, ADR-083):
 *
 * - a contact by old handle (`c:<handle>[/<agent>]`, your own computers paired the old way) whose address is
 *   known — recorded on the row (the relay's answer, checked against the device's certificate, ADR-077), seen
 *   for it (`contact_addresses`), the signer of mail filed under it, or (one device only) the certificate pinned
 *   for the device the trust list names by that handle: a computer's first address IS its device key's —
 *   becomes a contact by address: `handle` / `agent` are cleared and the old way of writing it is kept in
 *   `old_name` (shown, and a key the attendant finds per-contact settings by). Its id, remark, group, state and
 *   history do not change. When another contact of the same address of mine already has that address, the
 *   two are one person: the old-handle row's history moves to the address contact and the row goes.
 * - a contact by old handle whose address cannot be told stays as it is: it "needs their new address".
 * - every contact in group `self` (your own computers paired the old way, and anyone put there by hand) is in
 *   group `mine`, with no `own-device` mark: an ordinary contact, with no authority of its own (owner decision:
 *   permissions are per contact, given by you). Their mail from before, filed under yourself (`self`), moves to
 *   their contact.
 * - message requests by old handle from a device whose certificate is pinned here become requests by address.
 * - a block by old handle (morse-blocked.json, left as it is) blocks every address known for that handle at the
 *   first address (`address_blocks`); so does a blocked contact with an address.
 * - an outbound message not confirmed yet that was written to an old name is written to the contact's address.
 *
 * One IMMEDIATE transaction that re-checks the version inside: killed halfway = rolled back = run again on the
 * next open; a second run is a no-op; processes that open the database at the same moment wait for the one that
 * migrates and then find nothing to do. The ONE backup is taken inside that transaction, by the process that
 * migrates: the rewritten tables and the (id, contact_id, to_device) of every message it changes.
 */

export const SCHEMA_VERSION_V5 = 5;
export const P5_BACKUP_MARK = 'p5.backup';
/** The tables the migration rewrites — copied whole into the backup. */
export const P5_BACKUP_TABLES = ['contacts', 'contact_addresses', 'morse_requests', 'address_blocks', 'migration_marks'] as const;
/** In the backup: what each changed message was before (its contact, where it was written to). */
export const P5_CHANGED_TABLE = 'changed_messages';
const IN_PROGRESS = 'IN-PROGRESS';
const DIR_PREFIX = 'remove-v2-';
const BESIDE_SUFFIX = '.v4-contacts.bak';

export interface MigrationReportV5 {
  from: number;
  to: number;
  /** Contacts by old handle that are contacts by address now. */
  converted: number;
  /** Contacts by old handle whose address is not known: they stay, and need their new address. */
  needAddress: number;
  /** Contacts that were in group `self` and are in group `mine` now (your own computers paired the old way among them). */
  mine: number;
  /** Old-handle contacts that were the same address as an address contact: merged into it. */
  merged: number;
  /** Requests by old handle that are requests by address now. */
  requests: number;
  /** Blocks by address added for blocks by old handle. */
  blocks: number;
  /** Messages whose contact or recipient changed. */
  messages: number;
  backup: string | null;
}

/** The upgrade could not be done safely and was not done: nothing was changed, it runs again on the next open. One line for the user. */
export class MigrationRefusedV5 extends Error {}
/** No backup could be written anywhere: the migration did not start, nothing was changed. */
export class BackupErrorV5 extends MigrationRefusedV5 {}

const userVersion = (db: Db): number => Number(db.pragma('user_version', { simple: true })) || 0;
const columns = (db: Db, table: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
const hasTable = (db: Db, table: string): boolean => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export interface BackupPlanV5 {
  /** ~/.morse — the backup goes to `<morseDir>/backups/remove-v2-<UTC stamp>/`. */
  morseDir?: string;
  /** The database file — the fallback is `<dbPath>.v4-contacts.bak` next to it. */
  dbPath?: string;
}

type Changed = Array<{ id: string; contact_id: string | null; to_device: string | null }>;
interface Taken {
  path: string;
  discard(): void;
  keep(): void;
}

/** Copy the rewritten tables (with their table and index definitions) and the changed messages' old values into a small SQLite file (0600). */
function copyTables(db: Db, target: string, changed: Changed): Record<string, number> {
  const counts: Record<string, number> = {};
  const out = new Database(target);
  try {
    chmodSync(target, 0o600);
    out.exec('BEGIN');
    const copied: string[] = [];
    for (const table of P5_BACKUP_TABLES) {
      const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string } | undefined)?.sql;
      if (!ddl) continue;
      out.exec(ddl);
      copied.push(table);
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      counts[table] = rows.length;
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]!);
      const insert = out.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const r of rows) insert.run(...cols.map((c) => r[c]));
    }
    for (const table of copied) {
      for (const ix of db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`).all(table) as Array<{ sql: string }>) out.exec(ix.sql);
    }
    out.exec(`CREATE TABLE ${P5_CHANGED_TABLE} (id TEXT PRIMARY KEY, contact_id TEXT, to_device TEXT)`);
    const put = out.prepare(`INSERT INTO ${P5_CHANGED_TABLE} (id, contact_id, to_device) VALUES (?, ?, ?)`);
    for (const r of changed) put.run(r.id, r.contact_id, r.to_device);
    counts[P5_CHANGED_TABLE] = changed.length;
    out.exec('COMMIT');
    out.pragma(`user_version = ${userVersion(db)}`);
  } finally {
    out.close();
  }
  return counts;
}

/**
 * The ONE backup of this computer's v5 migration. Directory 0700, files 0600, an IN-PROGRESS marker while the
 * migration is not committed; a directory a killed run left (still marked) is removed first. When
 * ~/.morse/backups cannot be written: `<db>.v4-contacts.bak` (written as `.partial`, renamed once committed);
 * when that fails too: BackupErrorV5, nothing written.
 */
export function backupForV5(db: Db, plan: BackupPlanV5, changed: Changed, now: number = Date.now()): Taken {
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
      const rows = copyTables(db, join(made, 'tables.sqlite'), changed);
      writeFileSync(
        join(made, 'MANIFEST.json'),
        `${JSON.stringify(
          {
            migration: 'remove-v2',
            adr: 'ADR-091',
            createdAt: new Date(now).toISOString(),
            fromUserVersion: userVersion(db),
            tables: [...P5_BACKUP_TABLES, P5_CHANGED_TABLE],
            rows,
            files: { 'tables.sqlite': statSync(join(made, 'tables.sqlite')).size },
            note: `tables.sqlite holds the contact, request, block and bookkeeping tables (rows, table and index definitions) as they were before every contact became a contact by address, and in ${P5_CHANGED_TABLE} the contact and recipient of every message the upgrade changed (no message text was changed, and none is copied here). morse-blocked.json, trusted-devices.json, peer-keys.json and config.json were not changed. To put them back: docs/guides/restore-contacts-backup.zh-CN.md.`,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      return { path: made, discard: () => rmSync(made, { recursive: true, force: true }), keep: () => rmSync(join(made, IN_PROGRESS), { force: true }) };
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
      copyTables(db, partial, changed);
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
  throw new BackupErrorV5(
    `cannot back up your contacts before turning every contact into a contact by address (${errors.join('; ')}) — free some disk space or make ${plan.morseDir ?? dirname(plan.dbPath ?? '.')} writable (tried ${tried.join(' and ')}). Nothing was changed; the upgrade runs again the next time morse starts.`,
  );
}

/** A crash between the commit and the end of the backup's `keep()`: finish the marking on a later open (cosmetic). */
export function settleBackupMarkV5(db: Db): void {
  try {
    if (!hasTable(db, 'migration_marks')) return;
    const path = (db.prepare('SELECT value FROM migration_marks WHERE key = ?').get(P5_BACKUP_MARK) as { value: string | null } | undefined)?.value;
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

export type MigrationStageV5 = 'backup' | 'contacts' | 'requests' | 'blocks' | 'messages';

interface Row {
  id: string;
  my_address: string | null;
  handle: string | null;
  agent: string | null;
  address: string | null;
  remark: string | null;
  group_label: string;
  state: string;
  origin: string | null;
  old_name?: string | null;
}

/** `handle[/agent]` — how the contact was written in v2. */
export const oldNameOf = (handle: string, agent: string | null | undefined): string => (agent ? `${handle}/${agent}` : handle);

/**
 * The plan for one contact by old handle: the address it is by, when that can be told from what this computer
 * verified (see the file comment), else null. Pure reads.
 */
function addressFor(db: Db, r: Row, ctx: ContactContext, opts: { mail: boolean }): string | null {
  const ok = (a: string | null | undefined): string | null => (a ? normalizeAddress(a) : null);
  if (ok(r.address)) return ok(r.address);
  const seen = db.prepare('SELECT address FROM contact_addresses WHERE contact_id = ? ORDER BY last_seen DESC').all(r.id) as Array<{ address: string }>;
  const fromSeen = [...new Set(seen.map((s) => ok(s.address)).filter((a): a is string => Boolean(a)))];
  if (fromSeen.length === 1) return fromSeen[0]!;
  if (opts.mail) {
    // mail by address filed under it: its sender is the address that signed it (from_device = the bare address)
    const signed = db.prepare(`SELECT DISTINCT from_device AS a FROM messages WHERE contact_id = ? AND direction = 'in' AND from_device IS NOT NULL`).all(r.id) as Array<{ a: string }>;
    const bare = [...new Set(signed.map((s) => (looksLikeAddress(s.a) ? ok(s.a) : null)).filter((a): a is string => Boolean(a)))];
    if (bare.length === 1) return bare[0]!;
  }
  // the trust list names this handle's computer(s): exactly one with a pinned certificate, for the handle itself
  if (r.handle && !r.agent) {
    const devices = (ctx.devices?.() ?? []).filter((d) => d.name.toLowerCase() === r.handle!.toLowerCase() && d.tier === 'peer' && d.address);
    const addrs = [...new Set(devices.map((d) => d.address!))];
    if (addrs.length === 1) return addrs[0]!;
  }
  return null;
}

/**
 * Run the v5 migration (see the file comment). null = already at v5 (nothing done, no backup). `backup`: where
 * the one backup goes; null = none (a database this very open created). `hook` is for tests (after each stage,
 * inside the transaction).
 */
export function migrateToV5(db: Db, ctx: ContactContext, opts: { now?: number; backup?: BackupPlanV5 | null; hook?: (stage: MigrationStageV5) => void } = {}): MigrationReportV5 | null {
  const now = opts.now ?? Date.now();
  let taken: Taken | null = null;
  const run = db.transaction((): MigrationReportV5 | null => {
    const from = userVersion(db);
    if (from >= SCHEMA_VERSION_V5) return null;
    const report: MigrationReportV5 = { from, to: SCHEMA_VERSION_V5, converted: 0, needAddress: 0, mine: 0, merged: 0, requests: 0, blocks: 0, messages: 0, backup: null };
    if (!hasTable(db, 'contacts')) {
      db.pragma(`user_version = ${SCHEMA_VERSION_V5}`);
      return report;
    }
    const first = ctx.firstAddress?.() ?? null;
    const messageCols = hasTable(db, 'messages') ? columns(db, 'messages') : new Set<string>();
    const mail = messageCols.has('contact_id') && messageCols.has('direction');
    const old = db.prepare('SELECT * FROM contacts').all() as Row[];

    // ---- what changes (read only) --------------------------------------------------------------------
    type Plan = { row: Row; address: string | null; merge: string | null };
    const plans: Plan[] = [];
    const holders = new Map<string, string>(); // (my, address) → contact id
    for (const r of old) if (r.address && normalizeAddress(r.address)) holders.set(`${r.my_address ?? ''}\n${normalizeAddress(r.address)}`, r.id);
    for (const r of old) {
      if (r.id === SELF_CONTACT || !r.handle) continue;
      const address = addressFor(db, r, ctx, { mail });
      if (!address) {
        plans.push({ row: r, address: null, merge: null });
        continue;
      }
      const holder = holders.get(`${r.my_address ?? ''}\n${address}`);
      const merge = holder && holder !== r.id ? holder : null;
      if (!merge) holders.set(`${r.my_address ?? ''}\n${address}`, r.id);
      plans.push({ row: r, address, merge });
    }
    const selfHandle = ctx.selfHandle?.() ?? null;
    /** Mail of yours with your own computers, filed under yourself before: the contact it belongs to now. */
    const ownMail: Array<{ id: string; to: string }> = [];
    if (mail) {
      const own = old.filter((r) => r.id !== SELF_CONTACT && (r.origin === OWN_DEVICE || r.group_label === SELF_GROUP));
      const byWritten = new Map<string, string>();
      for (const r of own) {
        if (r.address && normalizeAddress(r.address)) byWritten.set(normalizeAddress(r.address)!, r.id);
        if (r.handle) byWritten.set(oldNameOf(r.handle, r.agent).toLowerCase(), r.id);
        if (r.handle && selfHandle && r.handle.toLowerCase() === selfHandle && r.agent) byWritten.set(`${selfHandle}/${r.agent}`.toLowerCase(), r.id);
      }
      if (byWritten.size) {
        const rows = db.prepare(`SELECT id, direction, from_device, to_device FROM messages WHERE contact_id = ? AND direction IN ('in', 'out')`).all(SELF_CONTACT) as Array<{ id: string; direction: string; from_device: string | null; to_device: string | null }>;
        for (const m of rows) {
          const peer = (m.direction === 'in' ? m.from_device : m.to_device)?.toLowerCase();
          const to = peer ? (byWritten.get(normalizeAddress(peer) ?? peer) ?? null) : null;
          if (to) ownMail.push({ id: m.id, to });
        }
      }
    }
    // outbound mail not confirmed yet, to an old name: the contact's address from now on
    const converted = new Map(plans.filter((p) => p.address).map((p) => [p.row.id, p]));
    const outbound: Array<{ id: string; address: string; contact: string }> = [];
    if (mail && messageCols.has('to_device') && messageCols.has('receipt_at')) {
      const rows = db.prepare(`SELECT id, contact_id, to_device FROM messages WHERE direction = 'out' AND receipt_at IS NULL AND status != 'dead' AND to_device IS NOT NULL`).all() as Array<{ id: string; contact_id: string | null; to_device: string }>;
      for (const m of rows) {
        if (looksLikeAddress(m.to_device)) continue;
        const own = ownMail.find((o) => o.id === m.id);
        const contactId = own?.to ?? m.contact_id;
        const p = contactId ? converted.get(contactId) : undefined;
        const target = p ? (p.merge ?? p.row.id) : contactId;
        const address = p?.address ?? (contactId ? normalizeAddress(old.find((r) => r.id === contactId)?.address ?? '') : null);
        if (address && target) outbound.push({ id: m.id, address, contact: target });
      }
    }
    // the messages this changes, as they are now (the backup)
    const changedIds = new Set<string>([...ownMail.map((o) => o.id), ...outbound.map((o) => o.id)]);
    const mergedIds = plans.filter((p) => p.merge).map((p) => p.row.id);
    if (mail && mergedIds.length) for (const r of db.prepare(`SELECT id FROM messages WHERE contact_id IN (${mergedIds.map(() => '?').join(',')})`).all(...mergedIds) as Array<{ id: string }>) changedIds.add(r.id);
    const changed: Changed = mail ? [...changedIds].map((id) => db.prepare('SELECT id, contact_id, to_device FROM messages WHERE id = ?').get(id) as Changed[number]).filter(Boolean) : [];

    // ---- the backup, before anything is written --------------------------------------------------------
    if (opts.backup) {
      taken = backupForV5(db, opts.backup, changed, now);
      db.prepare(`INSERT INTO migration_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at`).run(P5_BACKUP_MARK, taken.path, now);
      report.backup = taken.path;
    }
    opts.hook?.('backup');
    // (after the backup: it holds the tables exactly as they were)
    if (!columns(db, 'contacts').has('old_name')) db.exec(`ALTER TABLE contacts ADD COLUMN old_name TEXT`);
    db.exec(SCHEMA_BLOCKS);

    // ---- contacts --------------------------------------------------------------------------------------
    const setAddress = db.prepare(`UPDATE contacts SET handle = NULL, agent = NULL, split = NULL, address = ?, old_name = ?, updated_at = ? WHERE id = ?`);
    for (const p of plans) {
      if (!p.address) {
        report.needAddress++;
        continue;
      }
      const name = oldNameOf(p.row.handle!, p.row.agent);
      if (p.merge) {
        // one person under two rows: the address contact keeps everything it has; the old row's history and what it knew go to it
        const keep = db.prepare('SELECT * FROM contacts WHERE id = ?').get(p.merge) as Row;
        if (mail) db.prepare('UPDATE messages SET contact_id = ? WHERE contact_id = ?').run(p.merge, p.row.id);
        db.prepare('UPDATE OR IGNORE contact_addresses SET contact_id = ? WHERE contact_id = ?').run(p.merge, p.row.id);
        db.prepare('DELETE FROM contact_addresses WHERE contact_id = ?').run(p.row.id);
        if (hasTable(db, 'contact_agents')) db.prepare('DELETE FROM contact_agents WHERE contact_id = ?').run(p.row.id);
        db.prepare('DELETE FROM contacts WHERE id = ?').run(p.row.id);
        // (after the old row is gone: a remark is unique on the whole computer)
        db.prepare(`UPDATE contacts SET old_name = COALESCE(old_name, ?), remark = COALESCE(remark, ?), updated_at = ? WHERE id = ?`).run(name, keep.remark ? null : p.row.remark, now, p.merge);
        report.merged++;
        continue;
      }
      setAddress.run(p.address, name, now, p.row.id);
      report.converted++;
    }
    // group self → mine; own computers are ordinary contacts
    report.mine = db.prepare(`UPDATE contacts SET group_label = ?, origin = NULL, updated_at = ? WHERE id != ? AND group_label = ?`).run(MINE_GROUP, now, SELF_CONTACT, SELF_GROUP).changes;
    // (one moved out of group self before keeps the group you gave it; only the mark goes)
    db.prepare(`UPDATE contacts SET origin = NULL, updated_at = ? WHERE id != ? AND origin = ?`).run(now, SELF_CONTACT, OWN_DEVICE);
    opts.hook?.('contacts');

    // ---- message requests by old handle from a device whose certificate is pinned here -------------------
    if (hasTable(db, 'morse_requests')) {
      const reqCols = columns(db, 'morse_requests');
      const rows = db.prepare(`SELECT my_address, handle, device_id FROM morse_requests WHERE ${reqCols.has('to_address') ? "(to_address IS NULL OR to_address = '') AND " : ''}COALESCE(my_address, '') = ''`).all() as Array<{ my_address: string | null; handle: string; device_id: string }>;
      for (const r of rows) {
        if (looksLikeAddress(r.handle)) continue;
        const address = ctx.pinnedAddress?.(r.device_id) ?? null;
        if (!address || !first) continue;
        if (db.prepare(`SELECT 1 FROM morse_requests WHERE COALESCE(my_address, '') = '' AND handle = ?`).get(address)) continue;
        db.prepare(`UPDATE morse_requests SET handle = ?, device_id = ?${reqCols.has('to_address') ? ', to_address = ?' : ''} WHERE COALESCE(my_address, '') = '' AND handle = ?`).run(address, address, ...(reqCols.has('to_address') ? [first] : []), r.handle);
        report.requests++;
      }
    }
    opts.hook?.('requests');

    // ---- blocks by old handle → by address, at the first address -----------------------------------------
    const block = db.prepare(`INSERT OR IGNORE INTO address_blocks (my_address, address, at) VALUES ('', ?, ?)`);
    const blockedHandles = new Set((ctx.blockedHandles?.() ?? []).map((h) => h.toLowerCase()));
    const known = new Set<string>();
    for (const p of plans) {
      const handle = p.row.handle!.toLowerCase();
      if (p.address && (blockedHandles.has(handle) || p.row.state === 'blocked') && (p.row.my_address ?? '') === '') known.add(p.address);
    }
    for (const d of ctx.devices?.() ?? []) if (d.address && blockedHandles.has(d.name.toLowerCase())) known.add(d.address);
    for (const r of old) if (r.state === 'blocked' && !r.handle && r.address && (r.my_address ?? '') === '' && normalizeAddress(r.address)) known.add(normalizeAddress(r.address)!);
    // a removed contact's tombstone names its handle
    for (const t of db.prepare(`SELECT key, value FROM migration_marks WHERE key LIKE 'removed:%'`).all() as Array<{ key: string; value: string }>) {
      const address = normalizeAddress(t.key.slice('removed:'.length));
      if (!address) continue;
      try {
        const was = JSON.parse(t.value) as { handle?: unknown } | null;
        if (was && typeof was.handle === 'string' && blockedHandles.has(was.handle.toLowerCase())) known.add(address);
      } catch {
        /* not a tombstone of an old handle */
      }
    }
    for (const a of known) report.blocks += block.run(a, now).changes;
    opts.hook?.('blocks');

    // ---- messages -----------------------------------------------------------------------------------------
    if (mail) {
      const point = db.prepare('UPDATE messages SET contact_id = ? WHERE id = ?');
      for (const o of ownMail) point.run(o.to, o.id);
      const write = db.prepare('UPDATE messages SET to_device = ?, contact_id = ? WHERE id = ?');
      for (const o of outbound) write.run(o.address, o.contact, o.id);
      report.messages = changed.length;
    }
    opts.hook?.('messages');
    db.pragma(`user_version = ${SCHEMA_VERSION_V5}`);
    return report;
  });
  try {
    const report = run.immediate();
    (taken as Taken | null)?.keep();
    return report;
  } catch (e) {
    (taken as Taken | null)?.discard();
    throw e;
  }
}

/**
 * (ADR-091) A contact by old handle that got its address after the migration — a morse of the release before,
 * still running, wrote it, or the relay's alias table named it (`contact-split.ts`, stage 1) — is turned into a
 * contact by address the same way, on every open. Idempotent; nothing else is touched.
 */
export function convertKnownHandles(db: Db, now: number = Date.now()): number {
  try {
    if (!hasTable(db, 'contacts') || !columns(db, 'contacts').has('old_name')) return 0;
    // (read first: most opens have nothing to do, and must not take the write lock for nothing)
    const rows = db.prepare(`SELECT id, my_address, handle, agent, address FROM contacts WHERE handle IS NOT NULL AND address IS NOT NULL AND id != ?`).all(SELF_CONTACT) as Array<Row>;
    const own = db.prepare(`SELECT 1 FROM contacts WHERE id != ? AND (group_label = ? OR origin = ?) LIMIT 1`).get(SELF_CONTACT, SELF_GROUP, OWN_DEVICE);
    if (!rows.length && !own) return 0;
    let n = 0;
    db.transaction(() => {
      for (const r of rows) {
        const address = normalizeAddress(r.address ?? '');
        if (!address) continue;
        n += db.prepare(`UPDATE contacts SET handle = NULL, agent = NULL, split = NULL, address = ?, old_name = ?, updated_at = ? WHERE id = ? AND handle IS NOT NULL`).run(address, oldNameOf(r.handle!, r.agent), now, r.id).changes;
      }
      if (own) {
        db.prepare(`UPDATE contacts SET group_label = ?, origin = NULL, updated_at = ? WHERE id != ? AND group_label = ?`).run(MINE_GROUP, now, SELF_CONTACT, SELF_GROUP);
        db.prepare(`UPDATE contacts SET origin = NULL, updated_at = ? WHERE id != ? AND origin = ?`).run(now, SELF_CONTACT, OWN_DEVICE);
      }
    }).immediate();
    return n;
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_READONLY' || (e as { code?: string }).code === 'SQLITE_BUSY') return 0; // the next process that can write does it
    throw e;
  }
}

/**
 * (ADR-091) The one line said when the mailbox is upgraded to schema v5: every contact by address, old names gone, your own
 * computers paired the old way ordinary contacts in group `mine` — with no authority of their own.
 */
export const upgradeLineV5 = (r: Pick<MigrationReportV5, 'converted' | 'needAddress' | 'mine' | 'backup'>): string =>
  `morse: old names are gone — every contact is reached by its address now${r.needAddress ? `; ${r.needAddress} contact(s) need their new address (ask them for it, then: morse contact add morse.im/<address>)` : ''}${r.mine ? `; ${r.mine} contact(s) — your own computers paired the old way, and any you had put in group self — are in group mine: ordinary contacts, their messages are no longer taken as your own instructions (to let one act for you: morse contact set <name> --cwd <dir> --tools <tools>)` : ''}; nothing was deleted, backup: ${r.backup}`;
