import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import type { ContactContext } from '../src/mailbox/contacts.js';
import type { MigrationReport } from '../src/mailbox/migrate-v2.js';

/**
 * ADR-049: the v1 → v2 mailbox migration on a synthetic database shaped like a real
 * one (internal session mail, LAN-era device names, relay mail with /agent suffixes,
 * a waiting outbound message, a request-pending one, own-handle traffic).
 */

const dir = mkdtempSync(join(tmpdir(), 'morse-migrate-v2-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** The v1 schema exactly as every earlier release left it (user_version never set). */
const V1 = `
CREATE TABLE conversations (id TEXT PRIMARY KEY, pair_key TEXT NOT NULL UNIQUE, a_agent TEXT NOT NULL, a_session TEXT NOT NULL, a_device TEXT,
  b_agent TEXT NOT NULL, b_session TEXT NOT NULL, b_device TEXT, created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), context_id TEXT NOT NULL,
  from_agent TEXT NOT NULL, from_session TEXT NOT NULL, from_device TEXT, to_agent TEXT NOT NULL, to_session TEXT NOT NULL, to_device TEXT,
  parts TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, delivered_in_session INTEGER, from_tier TEXT, receipt_at INTEGER,
  waiting INTEGER NOT NULL DEFAULT 0, request INTEGER NOT NULL DEFAULT 0);
CREATE TABLE inbound_seen (from_id TEXT NOT NULL, msg_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (from_id, msg_id));
`;

interface Fixture {
  id: string;
  from: [agent: string, session: string, device: string | null];
  to: [agent: string, session: string, device: string | null];
  status: string;
  age: number;
  tier?: string;
  waiting?: number;
  request?: number;
}

const rows: Fixture[] = [
  { id: 'internal-done', from: ['claude', 's1', null], to: ['codex', 's2', null], status: 'delivered', age: 1 * DAY },
  { id: 'internal-pending', from: ['claude', 's1', null], to: ['codex', 's2', null], status: 'pending', age: 0.01 * DAY },
  { id: 'lan-own', from: ['claude', 'x1', 'mini'], to: ['codex', 's2', null], status: 'delivered', age: 30 * DAY },
  { id: 'lan-peer-old', from: ['claude', 'b1', 'bob'], to: ['user', 'inbox', null], status: 'pending', age: 20 * DAY, tier: 'peer' },
  { id: 'relay-in', from: ['claude', '', 'carol/mbp'], to: ['user', 'inbox', null], status: 'pending', age: 2 * DAY, tier: 'peer' },
  { id: 'relay-out-waiting', from: ['claude', 's1', null], to: ['mbp', '', 'carol/mbp'], status: 'failed', age: 1 * DAY, waiting: 1 },
  { id: 'relay-out-request', from: ['user', 'cli', null], to: ['user', '', 'dave'], status: 'delivered', age: 3 * DAY, request: 1 },
  { id: 'own-out', from: ['user', 'cli', null], to: ['air', '', 'me/air'], status: 'delivered', age: 1 * DAY },
  { id: 'own-in', from: ['claude', 'a9', 'me/air'], to: ['mini', 'inbox', null], status: 'pending', age: 1 * DAY },
];

function buildV1(path: string): void {
  const db = new Database(path);
  db.exec(V1);
  db.prepare(`INSERT INTO conversations VALUES ('c1', 'k', 'a', 's', NULL, 'b', 't', NULL, 0, 0)`).run();
  const ins = db.prepare(
    `INSERT INTO messages (id, conversation_id, context_id, from_agent, from_session, from_device, to_agent, to_session, to_device, parts, status, from_tier, waiting, request, created_at, updated_at)
     VALUES (?, 'c1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    const at = NOW - r.age;
    ins.run(r.id, r.id, ...r.from, ...r.to, JSON.stringify([{ type: 'text', text: `text of ${r.id}` }]), r.status, r.tier ?? null, r.waiting ?? 0, r.request ?? 0, at, at);
  }
  db.close();
}

const ctx: ContactContext = {
  selfHandle: () => 'me',
  deviceTier: (n) => ({ mini: 'owner', bob: 'peer', carol: 'peer', frank: 'peer' } as Record<string, 'owner' | 'peer'>)[n],
  primaryAgent: () => 'mini',
  isBlocked: (h) => h === 'eve',
  blockedHandles: () => ['eve'],
  peerNames: () => ['bob', 'carol', 'frank'],
};

describe('mailbox v2 migration (ADR-049)', () => {
  it('keeps every row, sorts it into direction + contact, marks old / delivered received mail processed, backs up first', () => {
    const path = join(dir, 'mailbox.db');
    buildV1(path);
    const reports: MigrationReport[] = [];
    const db = createDb(path, { upTo: 4, ctx, now: () => NOW, onMigrate: (r) => reports.push(r) });
    expect(db.pragma('user_version', { simple: true })).toBe(4); // v2 (ADR-049), then straight on to v3 (ADR-077) and v4 (ADR-083)
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r).toMatchObject({ from: 0, to: 2, rows: rows.length, byDirection: { internal: 2, in: 4, out: 3 } });
    // the backup holds the untouched v1 database
    expect(r.backup).toBe(`${path}.v1.bak`);
    const bak = new Database(r.backup!, { readonly: true });
    expect((bak.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(rows.length);
    expect(bak.pragma('user_version', { simple: true })).toBe(0);
    bak.close();

    const got = Object.fromEntries(
      (db.prepare('SELECT id, direction, contact_id, agent, peer_agent, from_tier, processed_by FROM messages').all() as Array<Record<string, string | null>>).map((x) => [x['id'], x]),
    );
    expect(Object.keys(got).sort()).toEqual(rows.map((x) => x.id).sort());
    expect(got['internal-done']).toMatchObject({ direction: 'internal', contact_id: 'self', agent: 'codex', peer_agent: 'claude', processed_by: 'migration' });
    expect(got['internal-pending']).toMatchObject({ direction: 'internal', contact_id: 'self', processed_by: null });
    expect(got['lan-own']).toMatchObject({ direction: 'in', contact_id: 'self', from_tier: 'owner', processed_by: 'migration' });
    expect(got['lan-peer-old']).toMatchObject({ direction: 'in', contact_id: 'c:bob', from_tier: 'peer', agent: 'mini', processed_by: 'migration' }); // > 14 days
    expect(got['relay-in']).toMatchObject({ direction: 'in', contact_id: 'c:carol', agent: 'mini', peer_agent: 'mbp', processed_by: null });
    expect(got['relay-out-waiting']).toMatchObject({ direction: 'out', contact_id: 'c:carol', agent: 'mini', peer_agent: 'mbp', processed_by: null });
    expect(got['relay-out-request']).toMatchObject({ direction: 'out', contact_id: 'c:dave' });
    expect(got['own-out']).toMatchObject({ direction: 'out', contact_id: 'self' });
    expect(got['own-in']).toMatchObject({ direction: 'in', contact_id: 'self', from_tier: 'owner', agent: 'mini', processed_by: null });
    expect(r.unprocessed).toBe(3); // internal-pending, relay-in, own-in

    // transport state untouched: the waiting outbound message still waits
    expect(db.prepare(`SELECT status, waiting FROM messages WHERE id = 'relay-out-waiting'`).get()).toEqual({ status: 'failed', waiting: 1 });

    const mailbox = createMailbox(db, { ctx, now: () => NOW });
    const contacts = mailbox.contacts.list();
    expect(contacts.map((c) => [c.id, c.handle, c.group, c.state])).toEqual([
      ['self', 'me', 'self', 'active'],
      ['c:bob', 'bob', 'other', 'active'],
      ['c:carol', 'carol', 'other', 'active'],
      ['c:dave', 'dave', 'other', 'active'],
      ['c:eve', 'eve', 'other', 'blocked'],
      ['c:frank', 'frank', 'other', 'active'],
    ]);
    // ADR-065: self-chosen nicknames are never turned into remarks — names are the owner's remarks
    // (ADR-077: the v3 step writes the old handle as the remark of an unnamed contact — what was shown stays shown)
    expect(contacts.filter((c) => c.remark && c.remark !== c.handle)).toHaveLength(0);
    expect(mailbox.contacts.get('c:carol')!.agents).toEqual(['mbp']);
    expect(r.contactsCreated).toBe(6);
    expect(mailbox.unread()).toEqual({ self: 2, 'c:carol': 1 });
    db.close();

    // a second open: nothing migrates, no second backup
    const again: MigrationReport[] = [];
    createDb(path, { upTo: 4, ctx, now: () => NOW, onMigrate: (x) => again.push(x) }).close();
    expect(again).toHaveLength(0);
    expect(readdirSync(dir).filter((f) => f.includes('.bak'))).toEqual(['mailbox.db.v1.bak']);
  });

  it('a fresh database is created at v2 with no backup; rows an older morse writes later are sorted on the next open', () => {
    const path = join(dir, 'fresh.db');
    const reports: MigrationReport[] = [];
    createDb(path, { upTo: 4, ctx, onMigrate: (r) => reports.push(r) }).close();
    expect(reports[0]?.backup).toBeNull();
    expect(existsSync(`${path}.v1.bak`)).toBe(false);
    // an old writer (no direction column known to it)
    const raw = new Database(path);
    raw.prepare(`INSERT INTO conversations VALUES ('c1', 'k', 'a', 's', NULL, 'b', 't', NULL, 0, 0)`).run();
    raw.prepare(
      `INSERT INTO messages (id, conversation_id, context_id, from_agent, from_session, from_device, to_agent, to_session, parts, created_at, updated_at, from_tier)
       VALUES ('old', 'c1', 'old', 'claude', '', 'zed/pro', 'mini', 'inbox', '[]', 1, 1, 'peer')`,
    ).run();
    raw.close();
    const db = createDb(path, { upTo: 4, ctx, now: () => NOW });
    expect(db.prepare(`SELECT direction, contact_id FROM messages WHERE id = 'old'`).get()).toEqual({ direction: 'in', contact_id: 'c:zed' });
    db.close();
  });
});
