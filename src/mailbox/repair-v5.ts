import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from './db.js';
import { CONTACT_VERBS, SELF_CONTACT } from './contacts.js';
import { P5_BACKUP_MARK, SCHEMA_VERSION_V5 } from './migrate-v5.js';
import { looksLikeAddress, normalizeAddress } from '../identity/address.js';
import { OLD_NAMES_LINE } from '../cluster/address.js';

/**
 * (ADR-091 「第 2 期发布后的修补」) What the v5 upgrade got wrong, put right ONCE on every home at v5 — homes that
 * were upgraded by the release before and homes upgraded now alike (it runs right after the v5 step). Marked done
 * in `migration_marks` (`p5.repair.1`); one IMMEDIATE transaction that re-checks the mark inside; the old value of
 * everything it changes is kept in the mark itself and written (best effort) to `<morseDir>/backups/repair-remove-v2-<stamp>/changes.json`.
 *
 * - settings keys: a remark the upgrade threw away when it merged an old contact into an address contact (from the
 *   v5 backup, when there is one) and the old handle of every converted contact go into `contact_old_keys` — the
 *   attendant finds settings written for them (after the contact's own keys): no permission becomes wider.
 * - a contact with no remark gets its old name as remark, when that name is free and could be a remark.
 * - mail from your other computers that the upgrade moved to their contact still said `from_tier = owner`: peer.
 * - mail to an old name the release before marked "delivered" without sending it (no receipt, written after the
 *   upgrade): failed for good, with the one line.
 * - the `contact_agents` rows of yourself (`self`): agents of your other computers, left over — gone.
 */

export const P5_REPAIR_MARK = 'p5.repair.1';
const REPAIR_DIR_PREFIX = 'repair-remove-v2-';

export interface RepairReportV5 {
  /** settings keys kept for contacts (old handles, remarks a merge had dropped) */
  keys: number;
  /** contacts named by their old name */
  remarks: number;
  /** messages from your other computers now marked as a contact's */
  tiers: number;
  /** messages to an old name marked failed (they were never sent) */
  failed: number;
  /** leftover agent rows of yourself removed */
  selfAgents: number;
  backup: string | null;
}

export const OLD_KEYS_TABLE = `
CREATE TABLE IF NOT EXISTS contact_old_keys (
  contact_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (contact_id, key)
);`;

const hasTable = (db: Db, table: string): boolean => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
const columns = (db: Db, table: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** The handle part of an old name (`alice/air` → `alice`). */
export const oldHandleOf = (oldName: string): string => oldName.split('/')[0]!.trim().toLowerCase();

/** Can `name` be a remark here (not a verb, not address-like, free on the whole computer)? */
const freeRemark = (db: Db, name: string): boolean => {
  const n = name.trim();
  if (!n || CONTACT_VERBS.includes(n.toLowerCase()) || looksLikeAddress(n)) return false;
  return !db.prepare('SELECT 1 FROM contacts WHERE lower(remark) = lower(?)').get(n);
};

interface BackupContact {
  id: string;
  my_address: string | null;
  handle: string | null;
  agent: string | null;
  address: string | null;
  remark: string | null;
}

/** The contacts of the v5 backup that are gone now (merged away): where they went (by address), and what they were called. */
function droppedByMerge(db: Db, backupPath: string | null): Array<{ to: string; remark: string | null; handle: string | null }> {
  if (!backupPath) return [];
  const file = existsSync(join(backupPath, 'tables.sqlite')) ? join(backupPath, 'tables.sqlite') : backupPath;
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return [];
  } catch {
    return [];
  }
  let b: Database.Database | null = null;
  try {
    b = new Database(file, { readonly: true, fileMustExist: true });
    const rows = b.prepare('SELECT id, my_address, handle, agent, address, remark FROM contacts').all() as BackupContact[];
    const seen = (id: string) => (b!.prepare('SELECT address FROM contact_addresses WHERE contact_id = ?').all(id) as Array<{ address: string }>).map((r) => r.address);
    const out: Array<{ to: string; remark: string | null; handle: string | null }> = [];
    for (const r of rows) {
      if (db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(r.id)) continue;
      const candidates = [r.address, ...seen(r.id)].map((a) => normalizeAddress(a ?? '')).filter((a): a is string => Boolean(a));
      const address = [...new Set(candidates)].length === 1 ? candidates[0]! : null;
      if (!address) continue;
      const to = db.prepare(`SELECT id FROM contacts WHERE address = ? AND COALESCE(my_address, '') = ? AND id != ?`).get(address, r.my_address ?? '', SELF_CONTACT) as { id: string } | undefined;
      if (to) out.push({ to: to.id, remark: r.remark, handle: r.handle });
    }
    return out;
  } catch {
    return []; // an unreadable backup: nothing to recover from it
  } finally {
    b?.close();
  }
}

export function repairAfterV5(db: Db, opts: { now?: number; morseDir?: string | null } = {}): RepairReportV5 | null {
  const now = opts.now ?? Date.now();
  const version = Number(db.pragma('user_version', { simple: true })) || 0;
  if (version < SCHEMA_VERSION_V5 || !hasTable(db, 'contacts') || !hasTable(db, 'migration_marks')) return null;
  // (read first: almost every open has nothing to do and must not take the write lock)
  if (db.prepare('SELECT 1 FROM migration_marks WHERE key = ?').get(P5_REPAIR_MARK)) return null;
  const run = db.transaction((): RepairReportV5 | null => {
    if (db.prepare('SELECT 1 FROM migration_marks WHERE key = ?').get(P5_REPAIR_MARK)) return null;
    const report: RepairReportV5 = { keys: 0, remarks: 0, tiers: 0, failed: 0, selfAgents: 0, backup: null };
    const changes: Record<string, unknown[]> = { keys: [], remarks: [], tiers: [], failed: [], selfAgents: [] };
    db.exec(OLD_KEYS_TABLE);
    const cCols = columns(db, 'contacts');
    const mCols = hasTable(db, 'messages') ? columns(db, 'messages') : new Set<string>();
    const addKey = db.prepare('INSERT OR IGNORE INTO contact_old_keys (contact_id, key) VALUES (?, ?)');

    // ---- settings keys -------------------------------------------------------------------------------------
    const backupMark = db.prepare('SELECT value FROM migration_marks WHERE key = ?').get(P5_BACKUP_MARK) as { value: string } | undefined;
    for (const d of droppedByMerge(db, backupMark?.value ?? null)) {
      for (const k of [d.remark, d.handle].filter((x): x is string => Boolean(x)).map((x) => x.trim().toLowerCase())) {
        if (addKey.run(d.to, k).changes) {
          report.keys++;
          changes['keys']!.push({ contact: d.to, key: k });
        }
      }
    }
    if (cCols.has('old_name')) {
      for (const r of db.prepare(`SELECT id, old_name FROM contacts WHERE old_name IS NOT NULL AND id != ?`).all(SELF_CONTACT) as Array<{ id: string; old_name: string }>) {
        const k = oldHandleOf(r.old_name);
        if (k && addKey.run(r.id, k).changes) {
          report.keys++;
          changes['keys']!.push({ contact: r.id, key: k });
        }
      }
      // ---- a contact without a remark is called by its old name -----------------------------------------------
      for (const r of db.prepare(`SELECT id, old_name FROM contacts WHERE old_name IS NOT NULL AND remark IS NULL AND id != ? ORDER BY created_at, id`).all(SELF_CONTACT) as Array<{ id: string; old_name: string }>) {
        if (!freeRemark(db, r.old_name)) continue;
        db.prepare('UPDATE contacts SET remark = ?, updated_at = ? WHERE id = ? AND remark IS NULL').run(r.old_name.trim(), now, r.id);
        report.remarks++;
        changes['remarks']!.push({ contact: r.id, remark: null, now: r.old_name.trim() });
      }
    }

    // ---- mail from your other computers is a contact's mail ------------------------------------------------------
    if (mCols.has('from_tier') && mCols.has('direction')) {
      const rows = db.prepare(`SELECT id FROM messages WHERE direction = 'in' AND from_tier = 'owner' AND (COALESCE(contact_id, '') != ? OR from_device IS NOT NULL)`).all(SELF_CONTACT) as Array<{ id: string }>;
      for (const r of rows) {
        db.prepare(`UPDATE messages SET from_tier = 'peer' WHERE id = ?`).run(r.id);
        changes['tiers']!.push({ message: r.id, from_tier: 'owner' });
      }
      report.tiers = rows.length;
    }

    // ---- mail to an old name that was marked delivered without being sent -----------------------------------------
    const upgradedAt = (db.prepare('SELECT at FROM migration_marks WHERE key = ?').get(P5_BACKUP_MARK) as { at: number } | undefined)?.at ?? null;
    if (mCols.has('direction') && mCols.has('receipt_at') && upgradedAt !== null) {
      const rows = db
        .prepare(`SELECT id, to_device, status, last_error FROM messages WHERE direction = 'out' AND status = 'delivered' AND receipt_at IS NULL AND to_device IS NOT NULL AND updated_at >= ?`)
        .all(upgradedAt) as Array<{ id: string; to_device: string; status: string; last_error: string | null }>;
      for (const r of rows) {
        const to = r.to_device.trim();
        // an old name: not an address, not a session target
        if (!to || normalizeAddress(to) || to.startsWith('@') || to.includes(':')) continue;
        db.prepare(`UPDATE messages SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?`).run(OLD_NAMES_LINE(to), now, r.id);
        report.failed++;
        changes['failed']!.push({ message: r.id, status: r.status, last_error: r.last_error });
      }
    }

    // ---- yourself has no agents of other computers --------------------------------------------------------------
    if (hasTable(db, 'contact_agents')) {
      const rows = db.prepare('SELECT * FROM contact_agents WHERE contact_id = ?').all(SELF_CONTACT) as unknown[];
      if (rows.length) {
        db.prepare('DELETE FROM contact_agents WHERE contact_id = ?').run(SELF_CONTACT);
        report.selfAgents = rows.length;
        changes['selfAgents'] = rows;
      }
    }

    // ---- the old values, written before the commit ------------------------------------------------------------
    const changed = report.keys + report.remarks + report.tiers + report.failed + report.selfAgents;
    if (changed && opts.morseDir) {
      try {
        const root = join(opts.morseDir, 'backups');
        mkdirSync(root, { recursive: true, mode: 0o700 });
        let dir = join(root, `${REPAIR_DIR_PREFIX}${stamp(now)}`);
        for (let i = 1; existsSync(dir); i++) dir = join(root, `${REPAIR_DIR_PREFIX}${stamp(now)}-${i}`);
        mkdirSync(dir, { mode: 0o700 });
        chmodSync(dir, 0o700);
        writeFileSync(join(dir, 'changes.json'), `${JSON.stringify({ repair: P5_REPAIR_MARK, adr: 'ADR-091', at: new Date(now).toISOString(), before: changes }, null, 2)}\n`, { mode: 0o600 });
        report.backup = dir;
      } catch {
        /* no room for the file: the old values are in the mark below all the same */
      }
    }
    db.prepare(`INSERT INTO migration_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at`).run(P5_REPAIR_MARK, JSON.stringify({ report, before: changes }), now);
    return changed ? report : null;
  });
  try {
    return run.immediate();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'SQLITE_READONLY' || code === 'SQLITE_BUSY') return null; // the next process that can write does it
    throw e;
  }
}

/** The one line said when the repair changed something worth saying ('' = nothing to say). */
export const repairLineV5 = (r: RepairReportV5): string => {
  const said = [
    r.remarks ? `${r.remarks} contact(s) are named by their old name` : '',
    r.tiers ? `${r.tiers} message(s) from your other computers are marked as a contact's` : '',
    r.failed ? `${r.failed} message(s) to an old name are marked not sent (they never went out — ask for the address)` : '',
  ].filter(Boolean);
  return said.length ? `morse: follow-up to the address upgrade — ${said.join('; ')}${r.backup ? `; what it changed: ${r.backup}` : ''}` : '';
};
