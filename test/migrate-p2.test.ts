import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { buildV2Home, fakeDevice, T0, type V2Home } from './helpers/v2-home.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import { BackupError, backupForP2, migrateToV3, P2_BACKUP_FILES, type MigrationReportV3 } from '../src/mailbox/migrate-v3.js';
import { profileFor, parseAttendantConfig } from '../src/plugins/attendant/config.js';
import { resolveSendTarget } from '../src/commands/messaging.js';

/**
 * ADR-077 — the local half of the identity v3 phase 2 migration, from a realistic v2
 * ~/.morse (test/helpers/v2-home.ts): contacts go from one per handle to one per address
 * without touching a single message, request, block or v2 file; ONE small backup is taken by
 * the process that migrates; running it twice, opening the database from several processes at
 * once, or killing it inside the transaction loses and duplicates nothing.
 */

const repo = resolve(__dirname, '..');
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const NOW = T0 + 86_400_000;
const STAMP = 'identity-v3-p2-20261102T080000Z';
const KEPT = ['messages', 'conversations', 'morse_requests', 'inbound_seen'] as const;
const CONTACT_TABLES = ['contacts', 'contact_agents', 'contact_addresses'] as const;
const rowsOf = (path: string, tables: readonly string[]) => {
  const db = new Database(path, { readonly: true });
  const out = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]));
  db.close();
  return out;
};
/** Everything the migration must not change, as one comparable value. */
const dump = (path: string) => rowsOf(path, KEPT);
const contactsOf = (path: string) => {
  const db = new Database(path, { readonly: true });
  const version = db.pragma('user_version', { simple: true });
  const columns = (db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>).map((c) => c.name);
  db.close();
  return { ...rowsOf(path, CONTACT_TABLES), version, columns };
};
const backups = (morseDir: string) => (existsSync(join(morseDir, 'backups')) ? readdirSync(join(morseDir, 'backups')).sort() : []);
const open = (h: { home: string; morseDir: string; dbPath: string }, reports: MigrationReportV3[] = []) => {
  const ctx = homeContactContext(h.home);
  const db = createDb(h.dbPath, { upTo: 4, ctx, morseDir: h.morseDir, now: () => NOW, onMigrateV3: (r) => reports.push(r) });
  return { db, mailbox: createMailbox(db, { ctx, now: () => NOW }) };
};
/** Contacts with the per-fixture random addresses masked, in a stable order. */
const shape = (path: string) =>
  (contactsOf(path).contacts as Array<Record<string, unknown>>)
    .map((r) => ({ ...r, address: Boolean(r['address']), id: String(r['id']).replace(/^a:.*/, 'a:*'), created_at: 0, updated_at: 0 }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const child = (...args: string[]) => {
  const p = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/p2-open-child.ts', ...args], { cwd: repo });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += String(d)));
  p.stderr.on('data', (d) => (err += String(d)));
  return { p, done: new Promise<{ code: number | null; out: string; err: string }>((r) => p.on('close', (code) => r({ code, out, err }))) };
};
const until = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('identity v3 phase 2: the local migration (ADR-077)', () => {
  it('backs up first, then moves contacts to one per address — messages, requests, blocks and every v2 file untouched', () => {
    const h = buildV2Home(homes);
    const before = dump(h.dbPath);
    const beforeContacts = contactsOf(h.dbPath);
    const files = Object.fromEntries(P2_BACKUP_FILES.map((f) => [f, readFileSync(join(h.morseDir, f), 'utf8')]));
    expect(beforeContacts.version).toBe(2);

    const reports: MigrationReportV3[] = [];
    const { db, mailbox } = open(h, reports);
    expect(db.pragma('user_version', { simple: true })).toBe(4); // v3 (ADR-077), then straight on to v4 (ADR-083)
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r).toMatchObject({ from: 2, to: 3, ownDevices: 2 });

    // the backup: ONE timestamped directory under ~/.morse/backups — only what the migration rewrites
    // (the contact tables, as a small SQLite file) plus the small JSON files it reads; no messages
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(r.backup).toBe(join(h.morseDir, 'backups', STAMP));
    expect(statSync(r.backup!).mode & 0o777).toBe(0o700);
    expect(readdirSync(r.backup!).sort()).toEqual(['MANIFEST.json', 'contacts.sqlite', ...P2_BACKUP_FILES].sort());
    for (const f of readdirSync(r.backup!)) expect(statSync(join(r.backup!, f)).mode & 0o777, f).toBe(0o600);
    const saved = contactsOf(join(r.backup!, 'contacts.sqlite'));
    expect(saved).toEqual(beforeContacts); // the v2 rows, the v2 table shape, version 2
    const inBackup = new Database(join(r.backup!, 'contacts.sqlite'), { readonly: true });
    expect((inBackup.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name)).toEqual(['contact_addresses', 'contact_agents', 'contacts']);
    inBackup.close();
    expect(statSync(join(r.backup!, 'contacts.sqlite')).size).toBeLessThan(200_000);
    for (const f of P2_BACKUP_FILES) expect(readFileSync(join(r.backup!, f), 'utf8')).toBe(files[f]);
    const manifest = JSON.parse(readFileSync(join(r.backup!, 'MANIFEST.json'), 'utf8')) as { migration: string; fromUserVersion: number; files: Record<string, number> };
    expect(manifest).toMatchObject({ migration: 'identity-v3-p2', fromUserVersion: 2 });
    expect(Object.keys(manifest.files).sort()).toEqual(['contacts.sqlite', ...P2_BACKUP_FILES].sort());
    expect(mailbox.contacts.mark('p2.backup')).toBe(r.backup);

    // nothing the migration reads was rewritten, no message / request / dedupe mark changed
    for (const f of P2_BACKUP_FILES) expect(readFileSync(join(h.morseDir, f), 'utf8')).toBe(files[f]);
    db.pragma('wal_checkpoint(TRUNCATE)');
    expect(dump(h.dbPath)).toEqual(before);

    // bob: one computer, certificate pinned → his address is known at once; remark, group kept
    const bob = mailbox.contacts.find('Bobby')!;
    expect(bob).toMatchObject({ id: 'c:bob', handle: 'bob', agent: null, address: h.bob.address, remark: 'Bobby', group: 'colleague', state: 'active', split: 'pending' });
    expect(mailbox.contacts.find(h.bob.address)!.id).toBe('c:bob');
    // alice: two computers → which one is "alice" is the relay's to say; shown as before (her handle is the remark)
    expect(mailbox.contacts.find('alice')).toMatchObject({ id: 'c:alice', address: null, remark: 'alice', group: 'friend', split: 'pending', agents: expect.arrayContaining(['mini', 'air']) });
    // eve stays blocked; dave (we wrote, a request over there) is a contact as before
    expect(mailbox.contacts.find('eve')).toMatchObject({ state: 'blocked', remark: 'eve' });
    expect(mailbox.contacts.get('c:dave')).toMatchObject({ split: 'pending' });
    // my own other computers: contacts in group self, no confirmation. One paired by device ID under a
    // name of its own keeps that name as its remark only — never as a handle
    expect(mailbox.contacts.byAddress(h.myAir.address)).toMatchObject({ id: `a:${h.myAir.address}`, group: 'self', origin: 'own-device', handle: null, split: 'done' });
    expect(mailbox.contacts.byAddress(h.studio.address)).toMatchObject({ group: 'self', origin: 'own-device', handle: null, remark: 'studio' });
    expect(mailbox.contacts.ownDeviceOf(h.studio.id)!.address).toBe(h.studio.address);
    expect(mailbox.contacts.pendingSplits().map((c) => c.id).sort()).toEqual(['c:alice', 'c:bob', 'c:dave', 'c:eve']);

    // everything readable before is readable the same way after
    expect(mailbox.history('c:bob').map((m) => m.id)).toEqual([h.ids['toBob'], h.ids['fromBob'], h.ids['waiting']]);
    expect(mailbox.history('c:alice').map((m) => m.id)).toEqual([h.ids['fromAliceMini'], h.ids['fromAliceAir'], h.ids['toAliceAir']]);
    expect(mailbox.history('self').map((m) => m.id)).toEqual([h.ids['fromMyAir'], h.ids['internal']]);
    expect(mailbox.getMessage(h.ids['fromEve']!)!.parts[0]!.text).toBe('spam');
    expect(mailbox.getMessage(h.ids['toBob']!)!.receiptAt).toBeTruthy();
    expect(mailbox.getMessage(h.ids['waiting']!)).toMatchObject({ status: 'failed', waiting: true });
    expect(mailbox.getMessage(h.ids['request']!)!.request).toBe(true);
    expect(mailbox.requestPendingHandles()).toEqual(['dave']);
    expect(mailbox.requests.get('carol')).toMatchObject({ handle: 'carol', msgId: 'req-1', fromAgent: 'pro', text: 'may I?' });
    expect(mailbox.hasSeen(h.bob.id, 'seen-1')).toBe(true);

    // permissions set with `morse contact set` still apply: bob's own entry (by remark), his group's
    const settings = parseAttendantConfig(JSON.parse(files['config.json']!).plugins.attendant, { home: h.home, morseDir: h.morseDir });
    expect(profileFor(settings, bob)).toMatchObject({ tools: ['Read'], group: 'colleague' });
    // new mail is sorted exactly as before
    expect(mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'again', fromTier: 'peer' }).contactId).toBe('c:bob');
    expect(mailbox.send({ from: { agent: 'claude', sessionId: 's-9', device: 'me/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'own', fromTier: 'owner' }).contactId).toBe('self');
    // local remark resolution: a remark, an address; a computer of mine without an old name by its ADDRESS —
    // its remark is never handed on as if it were a handle
    // (ADR-091) a contact still known by its old name cannot be written to — by its remark or its address
    expect(() => resolveSendTarget(mailbox, 'Bobby', 'me')).toThrow('Bobby: old names no longer work');
    expect(() => resolveSendTarget(mailbox, h.bob.address, 'me')).toThrow('Bobby: old names no longer work');
    expect(resolveSendTarget(mailbox, 'studio', 'me')).toBe(`morse.im/${h.studio.address}`);
    expect(mailbox.send({ from: { agent: 'claude', sessionId: 's-1' }, to: { agent: 'user', sessionId: '', device: `morse.im/${h.studio.address}` }, text: 'to my studio' })).toMatchObject({ contactId: 'self', direction: 'out' });

    // a stranger whose relay handle happens to be "studio" is NOT my computer: their own contact, peer tier
    const stranger = fakeDevice(homes);
    const theirs = mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'studio/x' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'hi, i am studio', fromTier: 'peer' });
    expect(theirs).toMatchObject({ contactId: 'c:studio', fromTier: 'peer' });
    expect(mailbox.contacts.filingContact({ address: stranger.address, deviceId: stranger.id }, 'studio', 'peer')).toBeUndefined();
    expect(mailbox.contacts.byAddress(h.studio.address)!.id).not.toBe('c:studio');
    db.close();
  });

  it('is idempotent: a second open changes nothing and takes no second backup', () => {
    const h = buildV2Home(homes);
    open(h).db.close();
    const after = { contacts: contactsOf(h.dbPath), rest: dump(h.dbPath), backups: backups(h.morseDir) };
    const reports: MigrationReportV3[] = [];
    const again = open(h, reports);
    expect(reports).toHaveLength(0);
    again.db.pragma('wal_checkpoint(TRUNCATE)');
    again.db.close();
    expect({ contacts: contactsOf(h.dbPath), rest: dump(h.dbPath), backups: backups(h.morseDir) }).toEqual(after);
    // running the migration function itself again is a no-op too — and takes no backup
    const raw = new Database(h.dbPath);
    expect(migrateToV3(raw, homeContactContext(h.home), { now: NOW, backup: { morseDir: h.morseDir, dbPath: h.dbPath } })).toBeNull();
    raw.close();
    expect(contactsOf(h.dbPath)).toEqual(after.contacts);
    expect(backups(h.morseDir)).toEqual(after.backups);
  });

  it('fails inside the transaction: rolled back to the exact v2 state, its backup removed again; the next run finishes with the same result', () => {
    const reference = buildV2Home(homes);
    open(reference).db.close();
    for (const failAt of ['backup', 'rebuild', 'contacts'] as const) {
      const h = buildV2Home(homes);
      const before = { contacts: contactsOf(h.dbPath), rest: dump(h.dbPath) };
      const raw = new Database(h.dbPath);
      expect(() =>
        migrateToV3(raw, homeContactContext(h.home), {
          now: NOW,
          backup: { morseDir: h.morseDir, dbPath: h.dbPath },
          hook: (stage) => {
            if (stage === failAt) throw new Error('interrupted (test)');
          },
        }),
      ).toThrow(/interrupted/);
      raw.pragma('wal_checkpoint(TRUNCATE)');
      raw.close();
      // exactly the v2 database again: old table shape, old rows, version 2 — and no half-used backup left
      expect({ contacts: contactsOf(h.dbPath), rest: dump(h.dbPath) }).toEqual(before);
      expect(before.contacts.columns).not.toContain('agent');
      expect(backups(h.morseDir)).toEqual([]);
      // the next open runs it again from the start
      const reports: MigrationReportV3[] = [];
      const { db } = open(h, reports);
      expect(reports).toHaveLength(1);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      expect(dump(h.dbPath)).toEqual(before.rest);
      expect(shape(h.dbPath)).toEqual(shape(reference.dbPath));
      expect(backups(h.morseDir)).toEqual([STAMP]);
    }
  });

  it('a real process killed (SIGKILL) inside the transaction: the database is the v2 one, the next open migrates, one backup remains', async () => {
    const h = buildV2Home(homes);
    const before = { contacts: contactsOf(h.dbPath), rest: dump(h.dbPath) };
    const marker = join(h.home, 'in-transaction');
    const c = child('pause', h.home, h.morseDir, h.dbPath, marker);
    await until(() => existsSync(marker));
    // it holds the write lock, has taken its backup, rebuilt the table and written the contact rows — uncommitted
    expect(backups(h.morseDir)).toHaveLength(1);
    expect(existsSync(join(h.morseDir, 'backups', backups(h.morseDir)[0]!, 'IN-PROGRESS'))).toBe(true);
    c.p.kill('SIGKILL');
    expect((await c.done).code).not.toBe(0);

    expect({ contacts: contactsOf(h.dbPath), rest: dump(h.dbPath) }).toEqual(before);
    const reports: MigrationReportV3[] = [];
    const { db, mailbox } = open(h, reports);
    expect(reports).toHaveLength(1);
    expect(db.pragma('user_version', { simple: true })).toBe(4); // (ADR-083: on to v4 in the same open)
    // the dead run's half-used backup was cleared away: exactly one, complete, the one the database names
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(existsSync(join(reports[0]!.backup!, 'IN-PROGRESS'))).toBe(false);
    expect(contactsOf(join(reports[0]!.backup!, 'contacts.sqlite'))).toEqual(before.contacts);
    expect(mailbox.contacts.find('Bobby')).toMatchObject({ id: 'c:bob', address: h.bob.address });
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    expect(dump(h.dbPath)).toEqual(before.rest);
  }, 60_000);

  it('six processes open the mailbox at the same moment: one migrates and takes the one backup, the others wait and find it done', async () => {
    const h = buildV2Home(homes);
    const before = dump(h.dbPath);
    const results = await Promise.all(Array.from({ length: 6 }, () => child('open', h.home, h.morseDir, h.dbPath).done));
    for (const r of results) expect(r.code, r.err).toBe(0);
    const told = results.map((r) => JSON.parse(r.out) as { migrated: boolean; backup: string | null });
    expect(told.filter((t) => t.migrated)).toHaveLength(1);
    expect(backups(h.morseDir)).toHaveLength(1);
    expect(told.find((t) => t.migrated)!.backup).toBe(join(h.morseDir, 'backups', backups(h.morseDir)[0]!));
    expect(readdirSync(join(h.morseDir, 'backups', backups(h.morseDir)[0]!))).not.toContain('IN-PROGRESS');
    expect(readdirSync(h.morseDir).filter((f) => f.includes('.bak'))).toEqual([]);
    expect(contactsOf(h.dbPath).version).toBe(4); // (ADR-083)
    expect(dump(h.dbPath)).toEqual(before);
    const reference = buildV2Home(homes);
    open(reference).db.close();
    expect(shape(h.dbPath)).toEqual(shape(reference.dbPath));
  }, 120_000);

  it('~/.morse/backups cannot be written: the contact tables go next to the database (0600) — still before anything changes', () => {
    const g = buildV2Home(homes);
    const before = contactsOf(g.dbPath);
    writeFileSync(join(g.morseDir, 'backups'), 'not a directory');
    const reports: MigrationReportV3[] = [];
    open(g, reports).db.close();
    const target = `${g.dbPath}.v2-contacts.bak`;
    expect(reports[0]!.backup).toBe(target);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(contactsOf(target)).toEqual(before);
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(contactsOf(g.dbPath).version).toBe(4); // (ADR-083)
  });

  it('no backup can be written anywhere: one clear error, nothing changed, nothing left behind — and it works once there is room', () => {
    const g = buildV2Home(homes);
    const before = { contacts: contactsOf(g.dbPath), rest: dump(g.dbPath) };
    writeFileSync(join(g.morseDir, 'backups'), 'not a directory');
    mkdirSync(`${g.dbPath}.v2-contacts.bak.partial`); // the fallback's file cannot be created either
    writeFileSync(join(`${g.dbPath}.v2-contacts.bak.partial`, 'x'), 'in the way');
    let error: unknown;
    try {
      open(g);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BackupError);
    expect((error as Error).message).toMatch(/cannot back up your contacts before upgrading them to one per address .* free some disk space or make .*\.morse writable \(tried .*backups\/identity-v3-p2-.* and .*mailbox\.db\.v2-contacts\.bak\)\. Nothing was changed/);
    expect((error as Error).message.split('\n')).toHaveLength(1);
    expect({ contacts: contactsOf(g.dbPath), rest: dump(g.dbPath) }).toEqual(before);
    expect(existsSync(`${g.dbPath}.v2-contacts.bak`)).toBe(false);
    // the obstacle goes away: the next open migrates
    rmSync(join(g.morseDir, 'backups'));
    rmSync(`${g.dbPath}.v2-contacts.bak.partial`, { recursive: true });
    open(g).db.close();
    expect(contactsOf(g.dbPath).version).toBe(4); // (ADR-083)
    expect(backups(g.morseDir)).toEqual([STAMP]);
  });

  it('a backup directory left IN-PROGRESS by an earlier run is cleared, never mistaken for the backup', () => {
    const h = buildV2Home(homes);
    const raw = new Database(h.dbPath);
    const left = backupForP2(raw, { morseDir: h.morseDir, dbPath: h.dbPath }, NOW - 5000); // "killed" right after it
    raw.close();
    expect(existsSync(join(left.path, 'IN-PROGRESS'))).toBe(true);
    const reports: MigrationReportV3[] = [];
    open(h, reports).db.close();
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(reports[0]!.backup).toBe(join(h.morseDir, 'backups', STAMP));
  });

  it('a crash between the commit and the end of the backup bookkeeping is tidied on the next open (N3)', () => {
    const h = buildV2Home(homes);
    const reports: MigrationReportV3[] = [];
    open(h, reports).db.close();
    writeFileSync(join(reports[0]!.backup!, 'IN-PROGRESS'), 'left by a crash');
    open(h).db.close();
    expect(readdirSync(reports[0]!.backup!)).not.toContain('IN-PROGRESS');
    // the beside-the-database copy: still under its .partial name
    const g = buildV2Home(homes);
    writeFileSync(join(g.morseDir, 'backups'), 'not a directory');
    open(g).db.close();
    const target = `${g.dbPath}.v2-contacts.bak`;
    renameSync(target, `${target}.partial`);
    open(g).db.close();
    expect(existsSync(target)).toBe(true);
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('a fresh install has nothing to back up and starts at the current schema (v4, ADR-083)', () => {
    const h = buildV2Home(homes);
    for (const f of readdirSync(h.morseDir)) if (f.startsWith('mailbox.db')) rmSync(join(h.morseDir, f));
    const reports: MigrationReportV3[] = [];
    const { db, mailbox } = open(h, reports);
    expect(db.pragma('user_version', { simple: true })).toBe(4); // (ADR-083: a fresh install starts at the current schema, v4)
    expect(backups(h.morseDir)).toEqual([]);
    // own computers are known from the trust list even on an empty mailbox
    expect(mailbox.contacts.byAddress(h.myAir.address)).toMatchObject({ group: 'self' });
    db.close();
  });

  it('an older morse still running after the migration: what it writes is read fine, and its new contact counts as unchecked', () => {
    const h: V2Home = buildV2Home(homes);
    const { db, mailbox } = open(h);
    mailbox.contacts.applySplit('c:bob', []);
    for (const c of mailbox.contacts.pendingSplits()) mailbox.contacts.applySplit(c.id, []);
    expect(mailbox.contacts.pendingSplits()).toEqual([]);
    // the statements the previous release runs (src/mailbox/contacts.ts @ d4dd6ee): no split / address columns
    const old = new Database(h.dbPath);
    old.prepare(`INSERT INTO contacts (id, handle, remark, nickname, group_label, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('c:zed', 'zed', null, null, 'other', 'active', NOW, NOW);
    old.prepare(`INSERT INTO contact_agents (contact_id, agent, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(contact_id, agent) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`).run('c:zed', 'pro', NOW);
    expect((old.prepare('SELECT * FROM contacts WHERE handle = ?').get('bob') as { id: string }).id).toBe('c:bob');
    old.prepare('UPDATE contacts SET remark = ?, updated_at = ? WHERE id = ?').run('Zed', NOW, 'c:zed');
    expect(Number(old.pragma('user_version', { simple: true }))).toBe(4); // (it only asks "< 2", so it never migrates back; ADR-083: the schema is v4 now)
    old.close();
    // the new code: the row is a contact like any other, and it is NOT taken for checked
    expect(mailbox.contacts.find('Zed')).toMatchObject({ id: 'c:zed', handle: 'zed', split: null, agents: ['pro'] });
    expect(mailbox.contacts.pendingSplits().map((c) => c.id)).toEqual(['c:zed']);
    expect(mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'zed/pro' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'via the old daemon', fromTier: 'peer' }).contactId).toBe('c:zed');
    mailbox.contacts.applySplit('c:zed', []);
    expect(mailbox.contacts.pendingSplits()).toEqual([]);
    db.close();
  });
});
