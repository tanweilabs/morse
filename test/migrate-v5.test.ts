import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { MINE_GROUP } from '../src/mailbox/contacts.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import { BackupErrorV5, migrateToV5, P5_BACKUP_MARK, P5_BACKUP_TABLES, P5_CHANGED_TABLE, type MigrationReportV5, type MigrationStageV5 } from '../src/mailbox/migrate-v5.js';
import { parseAttendantConfig, profileFor } from '../src/plugins/attendant/config.js';
import { releasedTree } from './helpers/released-tree.js';
import { keyMaterialIn, materialiseV4Home } from './helpers/v4-fixture.js';

/**
 * (ADR-091) The mailbox migration `user_version` 4 → 5 — every contact a contact by address, your own computers
 * paired the old way ordinary contacts in group `mine` — on a ~/.morse the RELEASED code wrote
 * (test/fixtures/v4-home, built by origin/main 1afe17e's own modules: see its README). No key is in the fixture:
 * the device key and the second address's key are made when this file runs (test/helpers/v4-fixture.ts).
 */

const repo = resolve(__dirname, '..');
const FIXTURE = join(repo, 'test', 'fixtures', 'v4-home');
const V4 = materialiseV4Home();
const fx = V4.fx;
const { first: F, work: W } = fx.mine;
const D = fx.devices;
const P = fx.peers;
const M = fx.messages;
const homes: string[] = [V4.home];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const NOW = fx.t0 + 86_400_000;
const STAMP = 'remove-v2-20261116T080000Z';

interface Home {
  home: string;
  morseDir: string;
  dbPath: string;
}
const v4Home = (): Home => {
  const home = mkdtempSync(join(tmpdir(), 'morse-v5-home-'));
  homes.push(home);
  const morseDir = join(home, '.morse');
  cpSync(V4.morseDir, morseDir, { recursive: true });
  for (const d of [morseDir, join(morseDir, 'identity'), join(morseDir, 'addresses'), join(morseDir, 'addresses', W)]) chmodSync(d, 0o700);
  for (const f of [join('identity', 'key.pem'), join('addresses', W, 'key.pem'), 'mailbox.db']) chmodSync(join(morseDir, f), 0o600);
  return { home, morseDir, dbPath: join(morseDir, 'mailbox.db') };
};
type Row = Record<string, unknown>;
const TABLES = ['contacts', 'contact_agents', 'contact_addresses', 'morse_requests', 'migration_marks', 'address_blocks', 'messages', 'conversations', 'inbound_seen'] as const;
const snapshot = (path: string) => {
  const db = new Database(path, { readonly: true });
  const have = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((t) => t.name));
  const out = {
    version: db.pragma('user_version', { simple: true }),
    schema: db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Row[],
    rows: Object.fromEntries(TABLES.filter((t) => have.has(t)).map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all() as Row[]])) as Record<string, Row[]>,
  };
  db.close();
  return out;
};
const rowsOf = (path: string, tables: readonly string[]) => {
  const db = new Database(path, { readonly: true });
  const have = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((t) => t.name));
  const out = Object.fromEntries(tables.filter((t) => have.has(t)).map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all() as Row[]]));
  db.close();
  return out;
};
const backups = (morseDir: string) => (existsSync(join(morseDir, 'backups')) ? readdirSync(join(morseDir, 'backups')).filter((n) => n.startsWith('remove-v2-')).sort() : []);
const open = (h: Home, reports: MigrationReportV5[] = [], o: { repair?: boolean } = {}) => {
  const ctx = homeContactContext(h.home);
  const db = createDb(h.dbPath, { ctx, morseDir: h.morseDir, now: () => NOW, onMigrateV5: (r) => reports.push(r), ...(o.repair === false ? { repairV5: false } : {}) });
  return { db, mailbox: createMailbox(db, { ctx, now: () => NOW }) };
};
const result = (h: Home) => JSON.parse(JSON.stringify(snapshot(h.dbPath)).split(h.home).join('<home>')) as ReturnType<typeof snapshot>;
let referenceResult: ReturnType<typeof snapshot> | null = null;
const reference = () => {
  if (!referenceResult) {
    const h = v4Home();
    const { db } = open(h);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    referenceResult = result(h);
  }
  return referenceResult;
};
const child = (...args: string[]) => {
  const p = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/v5-open-child.ts', ...args], { cwd: repo });
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

const REPORT: Omit<MigrationReportV5, 'backup'> = {
  from: 4,
  to: 5,
  // bob, carl, lee, air, win, alice, alice/air, erin
  converted: 8,
  // eve, dave
  needAddress: 2,
  // air, win, nina (put into self by hand) — studio was moved to colleague before: only its own-device mark goes
  mine: 3,
  merged: 0,
  // carol (her certificate is pinned); gail's is not
  requests: 1,
  // lee's address (a blocked old handle with a known address)
  blocks: 1,
  // fromAir, toAirWaiting, toWin (yours, filed under you before), waitingBob, toCarlWaiting
  messages: 5,
};

describe('every contact by address: the fixture the released code wrote (ADR-091)', () => {
  it('holds no key; it is a schema v4 home with two addresses', () => {
    expect(keyMaterialIn(FIXTURE)).toEqual([]);
    expect(fx.builtBy).toBe('1afe17e');
    expect(fx.userVersion).toBe(4);
    const db = new Database(join(V4.morseDir, 'mailbox.db'), { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    db.close();
    expect(JSON.parse(readFileSync(join(V4.morseDir, 'addresses', 'agents.json'), 'utf8'))).toMatchObject({ agents: { mini: F, work: W } });
  });
});

describe('every contact by address: the local migration (ADR-091)', () => {
  it('makes every contact by old handle whose address is known a contact by address — ids, remarks, groups, history and blocks kept; the rest wait for their new address', () => {
    const h = v4Home();
    const reports: MigrationReportV5[] = [];
    const { db, mailbox } = open(h, reports);
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(reports).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
    const c = (id: string) => mailbox.contacts.get(id)!;
    expect(c('c:bob')).toMatchObject({ handle: null, agent: null, address: D.bob.address, oldName: 'bob', remark: 'Bobby', group: 'colleague', state: 'active', split: null });
    expect(c('c:alice')).toMatchObject({ handle: null, address: D.aliceMini.address, oldName: 'alice', group: 'friend' });
    expect(c('c:alice/air')).toMatchObject({ handle: null, address: D.aliceAir.address, oldName: 'alice/air', remark: 'alice/air', group: 'friend' });
    expect(c('c:erin')).toMatchObject({ handle: null, address: D.erin.address, oldName: 'erin' });
    // carl's contact never had an address: the one the certificate pinned for his paired computer gives is his
    expect(c('c:carl')).toMatchObject({ handle: null, address: D.carl.address, oldName: 'carl', remark: 'Carl', split: null });
    // lee: blocked by old handle — blocked by address now
    expect(c('c:lee')).toMatchObject({ handle: null, address: D.lee.address, oldName: 'lee', state: 'blocked' });
    expect(mailbox.contacts.isBlockedAt(D.lee.address, '')).toBe(true);
    // dave and eve: nothing tells their address — they stay, and need it
    expect(c('c:dave')).toMatchObject({ handle: 'dave', address: null, oldName: null });
    expect(c('c:eve')).toMatchObject({ handle: 'eve', address: null, state: 'blocked' });
    // contacts by address stay exactly as they were
    expect(mailbox.contacts.byAddress(P.ann, '')).toMatchObject({ remark: 'Ann', group: 'friend', handle: null });
    expect(mailbox.contacts.self()).toMatchObject({ id: 'self', group: 'self' });
    // history: not one message changed contact but your own computers' (below); every message still there
    const all = (db.prepare('SELECT id, contact_id FROM messages').all() as Array<{ id: string; contact_id: string }>).map((m) => [m.id, m.contact_id]);
    expect(Object.fromEntries(all)).toMatchObject({ [M.toBob]: 'c:bob', [M.fromBob]: 'c:bob', [M.bobThreadReply]: 'c:bob', [M.fromAliceAir]: 'c:alice/air', [M.fromLee]: 'c:lee', [M.toDave]: 'c:dave', [M.internal]: 'self' });
    expect(all).toHaveLength(Object.keys(M).length);
    db.close();
  });

  it('your own computers paired the old way — and anyone you had put into group self — are ordinary contacts in group mine, with their mail of before', () => {
    const h = v4Home();
    const { db, mailbox } = open(h);
    const air = mailbox.contacts.byAddress(D.myAir.address, '')!;
    const win = mailbox.contacts.byAddress(D.myWin.address, '')!;
    const studio = mailbox.contacts.byAddress(D.studio.address, '')!;
    expect(air).toMatchObject({ remark: 'air', group: MINE_GROUP, origin: null, handle: null, oldName: 'me/air' });
    expect(win).toMatchObject({ remark: 'win', group: MINE_GROUP, origin: null, handle: null, oldName: 'me/win' });
    // (moved out of self before: its group is yours, only the own-device mark goes)
    expect(studio).toMatchObject({ remark: 'studio', group: 'colleague', origin: null });
    expect(mailbox.contacts.byAddress(P.nina, '')).toMatchObject({ remark: 'nina', group: MINE_GROUP });
    expect(mailbox.contacts.list().filter((x) => x.id !== 'self' && x.group === 'self')).toEqual([]);
    // their mail, filed under yourself before, is theirs; mail between your sessions stays yours
    const contactOf = (id: string) => (db.prepare('SELECT contact_id FROM messages WHERE id = ?').get(id) as { contact_id: string }).contact_id;
    expect([contactOf(M.fromAir), contactOf(M.toAirWaiting), contactOf(M.toWin), contactOf(M.internal)]).toEqual([air.id, air.id, win.id, 'self']);
    // what waits for my air goes to its address now
    expect((db.prepare('SELECT to_device FROM messages WHERE id = ?').get(M.toAirWaiting) as { to_device: string }).to_device).toBe(D.myAir.address);
    db.close();
  });

  it('what waits in the outbox for an old name goes to that contact\'s address; history and mail to someone without a known address stay as they were', () => {
    const h = v4Home();
    const { db } = open(h);
    const to = (id: string) => (db.prepare('SELECT to_device, contact_id, status FROM messages WHERE id = ?').get(id) as Row);
    expect(to(M.waitingBob)).toMatchObject({ to_device: D.bob.address, contact_id: 'c:bob', status: 'pending' });
    expect(to(M.toCarlWaiting)).toMatchObject({ to_device: D.carl.address, contact_id: 'c:carl' });
    expect(to(M.toDave)).toMatchObject({ to_device: 'dave', contact_id: 'c:dave' });
    // confirmed history keeps how it was addressed
    expect(to(M.toBob)).toMatchObject({ to_device: 'bob', status: 'delivered' });
    db.close();
  });

  it('a request by old handle from a computer whose certificate is pinned becomes a request by address; the others stay', () => {
    const h = v4Home();
    const { db, mailbox } = open(h);
    expect(mailbox.requests.get('carol', '')).toBeUndefined();
    expect(mailbox.requests.get(D.carol.address, '')).toMatchObject({ handle: D.carol.address, deviceId: D.carol.address, toAddress: F, text: 'may I?' });
    expect(mailbox.requests.get('gail', '')).toMatchObject({ handle: 'gail', deviceId: D.gail.id });
    expect(mailbox.requests.get(P.rob, W)).toMatchObject({ toAddress: W });
    db.close();
  });

  it('the permissions you gave stay with the contact: by remark, by old name, by group — and your own computers have none of their own beyond what you wrote for them', () => {
    const h = v4Home();
    const { db, mailbox } = open(h);
    // (the directories the fixture names are made here, inside the test home: a profile needs its directory to exist)
    let text = readFileSync(join(h.morseDir, 'config.json'), 'utf8');
    for (const d of ['bob', 'erin', 'air', 'colleague']) {
      const dir = join(h.home, 'work', d);
      mkdirSync(dir, { recursive: true });
      text = text.split(`/tmp/${d}"`).join(`${dir}"`);
    }
    const cfg = JSON.parse(text) as { plugins: { attendant: unknown } };
    const settings = parseAttendantConfig(cfg.plugins.attendant, { home: h.home, morseDir: h.morseDir });
    expect(settings.errors ?? []).toEqual([]);
    const ref = (id: string) => {
      const x = mailbox.contacts.get(id)!;
      return { id: x.id, handle: x.handle, remark: x.remark, inherits: x.inherits, oldName: x.oldName, group: x.group, state: x.state };
    };
    expect(profileFor(settings, ref('c:bob'))).toMatchObject({ cwd: realpathSync(join(h.home, 'work', 'bob')) });
    // written by old handle: found by the old name the contact keeps
    expect(profileFor(settings, ref('c:erin'))).toMatchObject({ cwd: realpathSync(join(h.home, 'work', 'erin')) });
    // my air: written for its remark — and nothing more (it is not "you" any more)
    expect(profileFor(settings, ref(mailbox.contacts.byAddress(D.myAir.address, '')!.id))).toMatchObject({ cwd: realpathSync(join(h.home, 'work', 'air')) });
    // my windows pc: nothing written for it or for group mine — the conversation-only default of any contact
    const winProfile = profileFor(settings, ref(mailbox.contacts.byAddress(D.myWin.address, '')!.id));
    expect(winProfile).toMatchObject({ group: MINE_GROUP });
    expect(winProfile?.tools ?? []).toEqual(settings.defaultProfile?.tools ?? []);
    // the configuration file itself is not touched
    expect(readFileSync(join(h.morseDir, 'config.json'), 'utf8')).toBe(readFileSync(join(V4.morseDir, 'config.json'), 'utf8'));
    db.close();
  });

  it('a contact by old handle that is the same address as a contact by address is one person: merged into the address contact, history and old name with it', () => {
    const h = v4Home();
    // (made by the released code's own store would need its tree; the same rows written directly, as it writes them)
    const raw = new Database(h.dbPath);
    raw.prepare(`UPDATE contacts SET address = NULL WHERE id = 'c:erin'`).run();
    raw.prepare(`INSERT INTO contacts (id, my_address, handle, agent, address, remark, group_label, state, created_at, updated_at) VALUES ('a:' || ?, '', NULL, NULL, ?, NULL, 'other', 'active', 1, 1)`).run(D.erin.address, D.erin.address);
    raw.prepare(`INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, 'c:erin', NULL, 1, 1) ON CONFLICT DO NOTHING`).run(D.erin.address);
    raw.close();
    const reports: MigrationReportV5[] = [];
    const { db, mailbox } = open(h, reports);
    expect(reports[0]).toMatchObject({ merged: 1, converted: REPORT.converted - 1 });
    expect(mailbox.contacts.get('c:erin')).toBeNull();
    expect(mailbox.contacts.byAddress(D.erin.address, '')).toMatchObject({ id: `a:${D.erin.address}`, oldName: 'erin' });
    expect((db.prepare('SELECT contact_id FROM messages WHERE id = ?').get(M.fromErin) as { contact_id: string }).contact_id).toBe(`a:${D.erin.address}`);
    db.close();
  });

  it('takes ONE backup before anything changes: the rewritten tables exactly as they were, the old contact and recipient of every changed message — 0700 / 0600', () => {
    const h = v4Home();
    const before = rowsOf(h.dbPath, P5_BACKUP_TABLES);
    const beforeMessages = Object.fromEntries((rowsOf(h.dbPath, ['messages'])['messages'] as Row[]).map((m) => [m['id'], m]));
    const reports: MigrationReportV5[] = [];
    const { db, mailbox } = open(h, reports);
    const dir = reports[0]!.backup!;
    expect(dir).toBe(join(h.morseDir, 'backups', STAMP));
    expect(mailbox.contacts.mark(P5_BACKUP_MARK)).toBe(dir);
    expect(readdirSync(dir).sort()).toEqual(['MANIFEST.json', 'tables.sqlite']);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of ['MANIFEST.json', 'tables.sqlite']) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    const kept = rowsOf(join(dir, 'tables.sqlite'), [...P5_BACKUP_TABLES, P5_CHANGED_TABLE]);
    for (const t of P5_BACKUP_TABLES) expect(kept[t], t).toEqual(before[t]);
    const changed = kept[P5_CHANGED_TABLE] as Array<{ id: string; contact_id: string; to_device: string }>;
    expect(changed.map((m) => m.id).sort()).toEqual([M.fromAir, M.toAirWaiting, M.toWin, M.waitingBob, M.toCarlWaiting].sort());
    for (const m of changed) expect(m).toEqual({ id: m.id, contact_id: beforeMessages[m.id]!['contact_id'], to_device: beforeMessages[m.id]!['to_device'] });
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Row;
    expect(manifest).toMatchObject({ migration: 'remove-v2', adr: 'ADR-091', fromUserVersion: 4 });
    // no message text in the backup
    expect(readFileSync(join(dir, 'tables.sqlite')).toString('latin1')).not.toContain('when you are back');
    db.close();
  });

  it('the backup puts the v4 contacts back: restored tables and messages, version 4 — and the next open migrates again to the same result', () => {
    const h = v4Home();
    const before = rowsOf(h.dbPath, [...P5_BACKUP_TABLES, 'messages']);
    const reports: MigrationReportV5[] = [];
    // (the v5 backup undoes the v5 step; what the follow-up repair changed is undone from its own changes.json)
    open(h, reports, { repair: false }).db.close();
    const dir = reports[0]!.backup!;
    // docs/guides/restore-contacts-backup.zh-CN.md, the v5 section, step by step
    const db = new Database(h.dbPath);
    db.exec(`ATTACH DATABASE '${join(dir, 'tables.sqlite')}' AS bak`);
    db.transaction(() => {
      for (const t of P5_BACKUP_TABLES) {
        db.exec(`DELETE FROM main.${t}`);
        const cols = (db.prepare(`PRAGMA bak.table_info(${t})`).all() as Array<{ name: string }>).map((x) => x.name).join(', ');
        db.exec(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM bak.${t}`);
      }
      db.exec(`UPDATE main.messages SET contact_id = (SELECT contact_id FROM bak.${P5_CHANGED_TABLE} c WHERE c.id = main.messages.id), to_device = (SELECT to_device FROM bak.${P5_CHANGED_TABLE} c WHERE c.id = main.messages.id) WHERE id IN (SELECT id FROM bak.${P5_CHANGED_TABLE})`);
      db.pragma('user_version = 4');
    })();
    db.exec('DETACH DATABASE bak');
    db.close();
    const restored = rowsOf(h.dbPath, [...P5_BACKUP_TABLES, 'messages']);
    // (the column the upgrade added stays, empty: the release before does not read it)
    const strip = (rows: Row[]) => rows.map(({ old_name: _o, ...r }) => r);
    for (const r of restored['contacts'] as Row[]) expect(r['old_name']).toBeNull();
    for (const t of P5_BACKUP_TABLES) expect(strip(restored[t] as Row[]), t).toEqual(before[t]);
    expect(restored['messages']).toEqual(before['messages']);
    rmSync(dir, { recursive: true, force: true });
    const again: MigrationReportV5[] = [];
    const { db: d2 } = open(h, again);
    expect(again).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
    d2.close();
  });

  it('is idempotent: a second open changes nothing, says nothing and takes no second backup', () => {
    const h = v4Home();
    const first: MigrationReportV5[] = [];
    open(h, first).db.close();
    const after = snapshot(h.dbPath);
    const second: MigrationReportV5[] = [];
    open(h, second).db.close();
    expect(second).toEqual([]);
    expect(snapshot(h.dbPath)).toEqual(after);
    expect(backups(h.morseDir)).toEqual([STAMP]);
  });

  it('fails inside the transaction, at every stage: rolled back to the exact v4 database, its backup removed again; the next run finishes with the same result', () => {
    for (const stage of ['backup', 'contacts', 'requests', 'blocks', 'messages'] as MigrationStageV5[]) {
      const h = v4Home();
      const before = snapshot(h.dbPath);
      const db = new Database(h.dbPath);
      const ctx = homeContactContext(h.home);
      expect(() =>
        migrateToV5(db, ctx, {
          now: NOW,
          backup: { morseDir: h.morseDir, dbPath: h.dbPath },
          hook: (s) => {
            if (s === stage) throw new Error(`killed at ${s}`);
          },
        }),
      ).toThrow(`killed at ${stage}`);
      db.close();
      expect(snapshot(h.dbPath), stage).toEqual(before);
      expect(backups(h.morseDir), stage).toEqual([]);
      open(h).db.close();
      expect(result(h), stage).toEqual(reference());
    }
  });

  it('a real process killed (SIGKILL) inside the transaction: the database is the v4 one, the next open migrates, one backup remains', async () => {
    const h = v4Home();
    const before = snapshot(h.dbPath);
    const marker = join(h.home, 'in-transaction');
    const c = child('pause', h.home, h.morseDir, h.dbPath, String(NOW - 60_000), marker);
    await until(() => existsSync(marker));
    expect(backups(h.morseDir)).toEqual(['remove-v2-20261116T075900Z']);
    expect(existsSync(join(h.morseDir, 'backups', backups(h.morseDir)[0]!, 'IN-PROGRESS'))).toBe(true);
    c.p.kill('SIGKILL');
    expect((await c.done).code).not.toBe(0);
    expect(snapshot(h.dbPath)).toEqual(before);
    const reports: MigrationReportV5[] = [];
    open(h, reports).db.close();
    expect(reports).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
    // the dead run's half-made backup was cleared away
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(result(h)).toEqual(reference());
  }, 60_000);

  it('six processes open the mailbox at the same moment: one migrates and takes the one backup, the others wait and find it done', async () => {
    const h = v4Home();
    const results = await Promise.all(Array.from({ length: 6 }, () => child('open', h.home, h.morseDir, h.dbPath, String(NOW)).done));
    for (const r of results) expect(r.code, r.err).toBe(0);
    const told = results.map((r) => JSON.parse(r.out) as { migrated: boolean; report: MigrationReportV5 | null });
    expect(told.filter((t) => t.migrated)).toHaveLength(1);
    expect(told.find((t) => t.migrated)!.report).toEqual({ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) });
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(result(h)).toEqual(reference());
  }, 120_000);

  it('~/.morse/backups cannot be written: the tables go next to the database (0600); nowhere at all: one clear line, nothing changed — and it works once there is room', () => {
    const h = v4Home();
    writeFileSync(join(h.morseDir, 'backups'), 'not a directory');
    const reports: MigrationReportV5[] = [];
    open(h, reports).db.close();
    expect(reports[0]!.backup).toBe(`${h.dbPath}.v4-contacts.bak`);
    expect(statSync(`${h.dbPath}.v4-contacts.bak`).mode & 0o777).toBe(0o600);

    const g = v4Home();
    const before = snapshot(g.dbPath);
    const db = new Database(g.dbPath);
    let error: unknown;
    try {
      writeFileSync(join(g.home, 'a-file'), 'not a directory');
      migrateToV5(db, homeContactContext(g.home), { now: NOW, backup: { morseDir: join(g.home, 'a-file', 'x'), dbPath: join(g.home, 'a-file', 'mailbox.db') } });
    } catch (e) {
      error = e;
    }
    db.close();
    expect(error).toBeInstanceOf(BackupErrorV5);
    expect((error as Error).message.split('\n')).toHaveLength(1);
    expect((error as Error).message).toContain('Nothing was changed');
    expect(snapshot(g.dbPath)).toEqual(before);
    open(g).db.close();
    expect(result(g)).toEqual(reference());
  });

  it('a fresh install starts at v5 with nothing to back up', () => {
    const home = mkdtempSync(join(tmpdir(), 'morse-v5-fresh-'));
    homes.push(home);
    const reports: MigrationReportV5[] = [];
    const db = createDb(join(home, 'mailbox.db'), { ctx: {}, morseDir: home, onMigrateV5: (r) => reports.push(r) });
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(reports[0]).toMatchObject({ converted: 0, backup: null });
    expect((db.prepare(`PRAGMA table_info(contacts)`).all() as Array<{ name: string }>).map((x) => x.name)).toContain('old_name');
    expect(backups(home)).toEqual([]);
    db.close();
  });
});

describe('every contact by address: a morse of the release before still running afterwards (ADR-091)', () => {
  const tree = releasedTree();

  it.skipIf(!tree)('its open runs and changes nothing; what it writes is read by the new code (a contact it pairs by old handle, once it has an address, becomes a contact by address on the next open)', async () => {
    const h = v4Home();
    open(h).db.close();
    const after = snapshot(h.dbPath);
    const old = (p: string) => import(pathToFileURL(join(tree!, p)).href);
    const { createDb: oldCreateDb } = (await old('src/mailbox/db.ts')) as { createDb: typeof createDb };
    const { createMailbox: oldCreateMailbox } = (await old('src/mailbox/mailbox.ts')) as { createMailbox: typeof createMailbox };
    const { homeContactContext: oldCtx } = (await old('src/mailbox/home-context.ts')) as { homeContactContext: typeof homeContactContext };
    const ctx = oldCtx(h.home);
    const odb = oldCreateDb(h.dbPath, { ctx, morseDir: h.morseDir });
    expect(odb.pragma('user_version', { simple: true })).toBe(5);
    odb.close();
    const sansLease = (s: ReturnType<typeof snapshot>) => s;
    expect(sansLease(snapshot(h.dbPath)).rows['contacts']).toEqual(after.rows['contacts']);
    // it reads the converted contacts as contacts by address, and can queue mail to them
    const odb2 = oldCreateDb(h.dbPath, { ctx, morseDir: h.morseDir });
    const omb = oldCreateMailbox(odb2, { ctx });
    expect(omb.contacts.byAddress(D.bob.address, '')).toMatchObject({ id: 'c:bob', handle: null, remark: 'Bobby' });
    const queued = omb.send({ from: { agent: 'claude', sessionId: 's-1' }, to: { agent: 'user', sessionId: '', device: D.bob.address }, text: 'from the old daemon', firstAddress: true });
    expect(queued.contactId).toBe('c:bob');
    // it pairs someone new by old handle (as the release before does) and the relay later names the address
    omb.contacts.ensure('zoe');
    omb.contacts.applySplit('c:zoe', [{ agent: 'mbp', address: P.rob, default: true }]);
    odb2.close();
    const { db, mailbox } = open(h);
    expect(mailbox.contacts.get('c:zoe')).toMatchObject({ handle: null, address: P.rob, oldName: 'zoe' });
    db.close();
  });
});

describe('(ADR-091 follow-up) what the v5 upgrade got wrong, put right once — on homes upgraded now and homes the release before upgraded', () => {
  /** The attendant settings of the review's reproduction (plus the fixture's own), every directory made in the home. */
  const settingsFor = (h: Home, extra: Record<string, unknown> = {}) => {
    const dirs = ['bob', 'erin', 'air', 'colleague', 'friend', 'erinold'];
    for (const d of dirs) mkdirSync(join(h.home, 'work', d), { recursive: true });
    const at = (d: string) => join(h.home, 'work', d);
    return parseAttendantConfig(
      {
        groups: { colleague: { tools: ['Read'], cwd: at('colleague') }, friend: { tools: ['Bash', 'Write'], cwd: at('friend') } },
        contacts: { alice: { enabled: false }, bobby: { tools: ['Read', 'Grep'], cwd: at('bob') }, erin: { tools: ['Read'], cwd: at('erin') }, air: { tools: ['Bash'], cwd: at('air') }, ...extra },
      },
      { home: h.home, morseDir: h.morseDir },
    );
  };
  /** every contact's effective profile (null = stored only), by id */
  const profiles = (mailbox: ReturnType<typeof createMailbox>, settings: ReturnType<typeof parseAttendantConfig>) =>
    Object.fromEntries(mailbox.contacts.list().map((c) => [c.id, JSON.stringify(profileFor(settings, { ...c, oldKeys: c.oldKeys }) ?? null)]));

  it('no contact\'s permissions become wider: settings for a bare old name (`contacts.alice` off) still cover the contacts split off it — every contact compared before and after', () => {
    const h = v4Home();
    const settings = settingsFor(h);
    const ctx = homeContactContext(h.home);
    const v4db = createDb(h.dbPath, { ctx, morseDir: h.morseDir, now: () => NOW, upTo: 4 });
    const before = profiles(createMailbox(v4db, { ctx, now: () => NOW }), settings);
    const ownBefore = new Set(createMailbox(v4db, { ctx }).contacts.list().filter((c) => c.group === 'self').map((c) => c.id));
    v4db.close();
    expect(before['c:alice/air']).toBe('null'); // what the review reproduced: off, by the old name it was split from
    const { db, mailbox } = open(h);
    const after = profiles(mailbox, settings);
    for (const [id, was] of Object.entries(before)) {
      // (your own computers were not answered by the attendant at all — they were you; that is the owner's decision)
      if (id === 'self' || ownBefore.has(id)) continue;
      expect(after[id], id).toBe(was);
    }
    db.close();
  });

  it('a remark the upgrade dropped when it merged an old contact into an address contact still finds the settings written for it', () => {
    const h = v4Home();
    const raw = new Database(h.dbPath);
    raw.prepare(`UPDATE contacts SET address = NULL, remark = 'erinold' WHERE id = 'c:erin'`).run();
    raw.prepare(`INSERT INTO contacts (id, my_address, handle, agent, address, remark, group_label, state, created_at, updated_at) VALUES ('a:' || ?, '', NULL, NULL, ?, 'E', 'other', 'active', 1, 1)`).run(D.erin.address, D.erin.address);
    raw.prepare(`INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, 'c:erin', NULL, 1, 1) ON CONFLICT DO NOTHING`).run(D.erin.address);
    raw.close();
    mkdirSync(join(h.home, 'work', 'erinold'), { recursive: true });
    // (only the remark the merge dropped has settings)
    const settings = parseAttendantConfig({ contacts: { erinold: { tools: ['Grep'], cwd: join(h.home, 'work', 'erinold') } } }, { home: h.home, morseDir: h.morseDir });
    const { db, mailbox } = open(h);
    const merged = mailbox.contacts.byAddress(D.erin.address, '')!;
    expect(merged).toMatchObject({ remark: 'E', oldName: 'erin' });
    expect(merged.oldKeys).toEqual(expect.arrayContaining(['erinold', 'erin']));
    expect(profileFor(settings, merged)).toMatchObject({ tools: ['Grep'] });
    db.close();
  });

  it('a home the release before upgraded: on the next open — once — old names become remarks, mail from your other computers is a contact\'s, mail to an old name "delivered" without a receipt is failed, your own leftover agents go; the old values are kept', () => {
    const h = v4Home();
    const ctx = homeContactContext(h.home);
    // the release before: the v5 upgrade, and nothing after it
    const first = createDb(h.dbPath, { ctx, morseDir: h.morseDir, now: () => NOW, repairV5: false });
    // …then it marked mail to the old name `dave` delivered without sending it (the agent rows of your other
    // computers under yourself — air, win — the fixture has already)
    first.prepare(`UPDATE messages SET status = 'delivered', receipt_at = NULL, updated_at = ? WHERE id = ?`).run(NOW + 60_000, M.toDave);
    expect((first.prepare(`SELECT from_tier FROM messages WHERE id = ?`).get(M.fromAir) as { from_tier: string }).from_tier).toBe('owner');
    first.close();
    const repaired: Array<import('../src/mailbox/repair-v5.js').RepairReportV5> = [];
    const db = createDb(h.dbPath, { ctx, morseDir: h.morseDir, now: () => NOW + 120_000, onRepairV5: (r) => repaired.push(r) });
    const mailbox = createMailbox(db, { ctx, now: () => NOW + 120_000 });
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ failed: 1, selfAgents: 2 });
    expect(repaired[0]!.remarks).toBeGreaterThanOrEqual(2); // alice, erin (no remark before; their old name is free)
    expect(repaired[0]!.tiers).toBeGreaterThanOrEqual(1);
    expect(mailbox.contacts.get('c:alice')).toMatchObject({ remark: 'alice', oldName: 'alice' });
    expect(mailbox.contacts.get('c:erin')).toMatchObject({ remark: 'erin' });
    expect(mailbox.getMessage(M.fromAir)).toMatchObject({ fromTier: 'peer' });
    expect(mailbox.getMessage(M.toDave)).toMatchObject({ status: 'dead', lastError: 'dave: old names no longer work — ask for their 26-character address (morse address shows it)' });
    expect(mailbox.contacts.get('self')?.agents ?? []).toEqual([]);
    // the old values, written before anything changed
    const saved = JSON.parse(readFileSync(join(repaired[0]!.backup!, 'changes.json'), 'utf8')) as { before: Record<string, unknown[]> };
    expect(saved.before['failed']).toEqual([expect.objectContaining({ message: M.toDave, status: 'delivered' })]);
    expect(statSync(join(repaired[0]!.backup!, 'changes.json')).mode & 0o777).toBe(0o600);
    db.close();
    // once: the next open says nothing and changes nothing
    const again: unknown[] = [];
    const db2 = createDb(h.dbPath, { ctx, morseDir: h.morseDir, now: () => NOW + 180_000, onRepairV5: (r) => again.push(r) });
    expect(again).toEqual([]);
    db2.close();
  });

  it('a home upgraded now gets the same in the same open — said as part of the upgrade, not on its own line', () => {
    const h = v4Home();
    const ctx = homeContactContext(h.home);
    const repaired: unknown[] = [];
    const db = createDb(h.dbPath, { ctx, morseDir: h.morseDir, now: () => NOW, onRepairV5: (r) => repaired.push(r) });
    const mailbox = createMailbox(db, { ctx, now: () => NOW });
    expect(repaired).toEqual([]);
    expect(mailbox.getMessage(M.fromAir)).toMatchObject({ fromTier: 'peer' });
    expect(mailbox.contacts.get('c:alice')).toMatchObject({ remark: 'alice' });
    db.close();
  });
});

describe('(ADR-091 follow-up) a contact whose old name could not become its remark', () => {
  it('is shown with its old name after the address, so you still know who it is', async () => {
    const { contactLabel } = await import('../src/commands/messaging.js');
    const h = v4Home();
    const raw = new Database(h.dbPath);
    raw.prepare(`UPDATE contacts SET remark = 'erin' WHERE id = 'a:' || ?`).run(P.ann); // Ann's remark is "erin" now: taken
    raw.close();
    const { db, mailbox } = open(h);
    const erin = mailbox.contacts.get('c:erin')!;
    expect(erin.remark).toBeNull();
    expect(contactLabel(erin)).toBe(`morse.im/${D.erin.address} (was erin)`);
    db.close();
  });
});
