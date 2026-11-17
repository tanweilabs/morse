import { existsSync } from 'node:fs';
import type { Db } from './db.js';
import { createContactStore, INDEXES_V2, MESSAGE_COLUMNS_V2, SCHEMA_V2, SELF_CONTACT, type ContactContext } from './contacts.js';

/**
 * Mailbox schema v2 (ADR-049): contacts + message direction / contact / processed state,
 * versioned with PRAGMA user_version. v0/v1 = the additive-columns schema every
 * earlier release made (user_version was never set). Migrating keeps every row:
 *
 * - direction: from_device set → in · to_device set → out · neither → internal
 * - contact: the handle part of from_device / to_device; our own handle and owner-tier
 *   device names (LAN era, trusted-devices.json) → self; internal → self
 * - agent: ours (to for in, the computer's agent for out); peer_agent: theirs (the /agent suffix)
 * - processed: in / internal rows that are delivered, or older than 14 days, get
 *   processed_by='migration'; the rest stay to-process
 * - every peer device name and blocked handle becomes a contact (cached self-chosen
 *   nicknames are not copied into remarks — names are the owner's remarks, ADR-065)
 */

export const SCHEMA_VERSION = 2;
const PROCESS_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export interface MigrationReport {
  from: number;
  to: number;
  rows: number;
  byDirection: Record<string, number>;
  contactsCreated: number;
  unprocessed: number;
  backup: string | null;
}

export function userVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true })) || 0;
}

const columns = (db: Db, table: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));

interface Row {
  id: string;
  from_agent: string;
  from_device: string | null;
  to_agent: string;
  to_session: string;
  to_device: string | null;
  from_tier: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

/**
 * Fill direction / contact / agent for rows that have none (all of them during the
 * migration; afterwards only rows an older `morse` wrote). `markOld` applies the
 * processed rule above with `by`.
 */
export function backfillRows(db: Db, ctx: ContactContext, opts: { now: number; by: string }): number {
  const store = createContactStore(db, { now: () => opts.now, ctx });
  const rows = db.prepare(`SELECT id, from_agent, from_device, to_agent, to_session, to_device, from_tier, status, created_at, updated_at FROM messages WHERE direction IS NULL`).all() as Row[];
  const update = db.prepare(
    `UPDATE messages SET direction = ?, contact_id = ?, agent = ?, peer_agent = ?, from_tier = COALESCE(from_tier, ?),
       processed_at = CASE WHEN ? THEN COALESCE(processed_at, ?) ELSE processed_at END,
       processed_by = CASE WHEN ? THEN COALESCE(processed_by, ?) ELSE processed_by END
     WHERE id = ?`,
  );
  for (const r of rows) {
    const c = store.classify(r);
    if (c.peerAgent && c.direction !== 'internal') store.seenAgent(c.contactId, c.peerAgent, r.created_at);
    const done = c.direction !== 'out' && (r.status === 'delivered' || r.created_at < opts.now - PROCESS_AFTER_MS) ? 1 : 0;
    update.run(c.direction, c.contactId, c.agent, c.peerAgent, c.direction === 'in' ? c.fromTier : null, done, r.updated_at, done, opts.by, r.id);
  }
  return rows.length;
}

/** Run the v2 migration inside one IMMEDIATE transaction (re-checks the version inside). */
export function migrateToV2(db: Db, ctx: ContactContext, opts: { now?: number; backup?: string | null } = {}): MigrationReport | null {
  const now = opts.now ?? Date.now();
  const run = db.transaction((): MigrationReport | null => {
    const from = userVersion(db);
    if (from >= SCHEMA_VERSION) return null;
    const have = columns(db, 'messages');
    for (const [name, type] of MESSAGE_COLUMNS_V2) if (!have.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
    db.exec(SCHEMA_V2);
    db.exec(INDEXES_V2);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
    const store = createContactStore(db, { now: () => now, ctx });
    store.self();
    const rows = backfillRows(db, ctx, { now, by: 'migration' });
    for (const h of ctx.peerNames?.() ?? []) if (h) store.ensure(h);
    for (const h of ctx.blockedHandles?.() ?? []) {
      const c = store.ensure(h);
      if (c.id !== SELF_CONTACT) store.set(c.id, { state: 'blocked' });
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    const byDirection = Object.fromEntries((db.prepare('SELECT direction AS d, COUNT(*) AS n FROM messages GROUP BY direction').all() as Array<{ d: string; n: number }>).map((r) => [r.d, r.n]));
    const after = (db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
    const unprocessed = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction != 'out' AND processed_at IS NULL`).get() as { n: number }).n;
    return { from, to: SCHEMA_VERSION, rows, byDirection, contactsCreated: after - before, unprocessed, backup: opts.backup ?? null };
  });
  return run.immediate();
}

/** `VACUUM INTO` a copy next to the database before migrating it (never overwrites one). */
export function backupBeforeMigrate(db: Db, path: string, now: number = Date.now()): string {
  let target = `${path}.v1.bak`;
  if (existsSync(target)) target = `${path}.v1.${now}.bak`;
  db.prepare('VACUUM INTO ?').run(target);
  return target;
}
