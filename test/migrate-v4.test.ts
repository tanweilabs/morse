import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { startMorse } from '../src/cluster/morse.js';
import { loadPrimaryAddress, type AddressKey } from '../src/identity/address-key.js';
import { ensureAgentAddresses } from '../src/identity/agent-addresses.js';
import { sealV3 } from '../src/identity/envelope.js';
import { ensurePrekeys } from '../src/identity/prekeys.js';
import { seenKeyFor, type ContactContext } from '../src/mailbox/contacts.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import { BackupErrorV4, backupForV4, MigrationRefusedV4, migrateToV4, P4_BACKUP_MARK, P4_BACKUP_TABLES, P4_BLOCKS_ADOPTED_MARK, P4_BLOCKS_SEEN_MARK, P4_REPOINTED_TABLE, type MigrationReportV4, type MigrationStageV4 } from '../src/mailbox/migrate-v4.js';
import { startFakeRelay } from './helpers/fake-relay.js';
import { keyMaterialIn, materialiseP3Home } from './helpers/p3-fixture.js';

/**
 * (ADR-083) The mailbox migration `user_version` 3 → 4 — contacts, message requests and blocks per
 * address of mine — on a ~/.morse that the RELEASED code wrote (test/fixtures/p3-home, built by commit
 * af4ca40's own modules: see its README): three local addresses, contacts that know different ones,
 * one person with history at several of them, requests waiting at different addresses, blocks,
 * tombstones, own computers, contacts by old handle, an outbox.
 *
 * The fixture holds NO key. The device key (= my first address), the keys of the two other addresses and
 * the certificate are generated when this file runs, into a temp home, and the three addresses the
 * committed files were written with are replaced by the ones those keys give (test/helpers/p3-fixture.ts,
 * which also checks that nothing else changed). So `F`, `W`, `L` below differ from run to run.
 *
 * Every (my address, peer) pair that had dealings keeps a contact of its own; not one message, request,
 * block or tombstone is lost; ONE small backup is taken by the process that migrates; running it
 * twice, opening the database from several processes at once, or killing it inside the transaction
 * loses and duplicates nothing; and a morse of the release before that is still running afterwards
 * writes nothing that is then read as another address's.
 */

const repo = resolve(__dirname, '..');
const FIXTURE = join(repo, 'test', 'fixtures', 'p3-home');
/** The fixture with keys generated for this run, its identifiers replaced by theirs (once for the whole file). */
const P3HOME = materialiseP3Home();
const fx = P3HOME.fx;
const { first: F, work: W, lab: L } = fx.mine;
const P = fx.peers;
const D = fx.devices;
const M = fx.messages;

const homes: string[] = [P3HOME.home];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const NOW = fx.t0 + 2 * 86_400_000;
const STAMP = 'contacts-per-address-20261112T080000Z';
const BAK = '.v3-contacts.bak';

interface Home {
  home: string;
  morseDir: string;
  dbPath: string;
}
/** A fresh copy of the fixture (with this run's keys) as somebody's home — the fixture itself is never opened (opening migrates). */
const p3Home = (): Home => {
  const home = mkdtempSync(join(tmpdir(), 'morse-v4-home-'));
  homes.push(home);
  const morseDir = join(home, '.morse');
  cpSync(P3HOME.morseDir, morseDir, { recursive: true });
  // (the keys are private files, as on a real computer)
  for (const d of [morseDir, join(morseDir, 'identity'), join(morseDir, 'addresses'), join(morseDir, 'addresses', W), join(morseDir, 'addresses', L)]) chmodSync(d, 0o700);
  for (const f of [join('identity', 'key.pem'), join('addresses', W, 'key.pem'), join('addresses', L, 'key.pem'), 'mailbox.db']) chmodSync(join(morseDir, f), 0o600);
  return { home, morseDir, dbPath: join(morseDir, 'mailbox.db') };
};

type Row = Record<string, unknown>;
const TABLES = ['contacts', 'contact_agents', 'contact_addresses', 'morse_requests', 'migration_marks', 'address_blocks', 'messages', 'conversations', 'inbound_seen', 'sessions_cache'] as const;
/** The whole database as one comparable value: version, schema, every row of every table. */
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
  const out = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all() as Row[]]));
  db.close();
  return out;
};
const ddlOf = (path: string, tables: readonly string[]) => {
  const db = new Database(path, { readonly: true });
  const out = Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) as { sql: string } | undefined)?.sql]));
  db.close();
  return out;
};
/**
 * (ADR-089) The lease of a delivery: the columns this release adds to `messages` once the mailbox is at the
 * current version — additive, at their defaults (the release before does not know them and works as ever).
 * They are not part of what the migration does; a restore to v3 leaves them where they are.
 */
const LEASE_DEFAULTS: Row = { lease_holder: null, lease_pid: null, lease_at: null, lease_expires_at: null, takeovers: 0, lease_pid_start: null, lease_started_at: null, interrupted: 0, lease_hard_until: null };
const LEASE_DDL =
  ', lease_holder TEXT, lease_pid INTEGER, lease_at INTEGER, lease_expires_at INTEGER, takeovers INTEGER NOT NULL DEFAULT 0, lease_pid_start TEXT, lease_started_at INTEGER, interrupted INTEGER NOT NULL DEFAULT 0, lease_hard_until INTEGER';
const sansLeaseRow = (r: Row): Row => Object.fromEntries(Object.entries(r).filter(([k]) => !(k in LEASE_DEFAULTS)));
/** A snapshot without the lease columns — after checking that they are there, exactly these, at their defaults. */
const sansLease = (s: ReturnType<typeof snapshot>): ReturnType<typeof snapshot> => {
  const ddl = s.schema.find((x) => x['type'] === 'table' && x['name'] === 'messages')!['sql'] as string;
  expect(ddl).toContain(LEASE_DDL);
  for (const m of s.rows['messages']!) expect(m).toMatchObject(LEASE_DEFAULTS);
  return {
    ...s,
    schema: s.schema.map((x) => (x['type'] === 'table' && x['name'] === 'messages' ? { ...x, sql: ddl.replace(LEASE_DDL, '') } : x)),
    rows: { ...s.rows, messages: s.rows['messages']!.map(sansLeaseRow) },
  };
};
/** What the migration must leave exactly as it was: every message but for its contact (and the lease columns, above), every conversation and dedupe mark. */
const untouched = (path: string) => {
  const all = rowsOf(path, ['messages', 'conversations', 'inbound_seen', 'sessions_cache']);
  return { ...all, messages: all['messages']!.map(({ contact_id: _contact, ...rest }) => sansLeaseRow(rest)) };
};
const messageContacts = (path: string) => Object.fromEntries(rowsOf(path, ['messages'])['messages']!.map((m) => [m['id'] as string, m['contact_id'] as string | null]));
const backups = (morseDir: string) => (existsSync(join(morseDir, 'backups')) ? readdirSync(join(morseDir, 'backups')).sort() : []);
const besides = (morseDir: string) => readdirSync(morseDir).filter((f) => f.includes('.bak'));
const open = (h: Home, reports: MigrationReportV4[] = [], ctx: ContactContext = homeContactContext(h.home)) => {
  const db = createDb(h.dbPath, { upTo: 4, ctx, morseDir: h.morseDir, now: () => NOW, onMigrateV4: (r) => reports.push(r) });
  return { db, mailbox: createMailbox(db, { ctx, now: () => NOW }) };
};
/** The migrated database of a home, comparable with another home's (the backup path names the home). */
const result = (h: Home) => JSON.parse(JSON.stringify(snapshot(h.dbPath)).split(h.home).join('<home>')) as ReturnType<typeof snapshot>;
/** What a single, undisturbed run makes of the fixture (computed once). */
let referenceResult: ReturnType<typeof snapshot> | null = null;
const reference = () => {
  if (!referenceResult) {
    const h = p3Home();
    const { db } = open(h);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    referenceResult = result(h);
  }
  return referenceResult;
};
const child = (...args: string[]) => {
  const p = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/v4-open-child.ts', ...args], { cwd: repo });
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
const freePort = () =>
  new Promise<number>((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => done(port));
    });
  });
const cliAt = (at: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: repo, env: { ...process.env, MORSE_HOME: at, ANYTOANY_HOME: at, HOME: at } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err }));
  });
/** A throw-away correspondent nobody in the fixture has: a fresh home, its key and the address that key gives. */
const strangerKey = (): AddressKey => {
  const home = mkdtempSync(join(tmpdir(), 'morse-v4-peer-'));
  homes.push(home);
  return loadPrimaryAddress(home, loadOrCreateIdentity(home));
};
/** …when only its address is needed. */
const stranger = (): string => strangerKey().address;
/**
 * (ADR-083 review R8) The restore of docs/guides/restore-contacts-backup.zh-CN.md, statement for statement (the guide
 * pipes the same SQL into the sqlite3 command): the five tables and their indexes as the backup holds them, every
 * re-pointed message back under the contact it had, no `address_blocks`, `user_version` 3.
 */
const restoreV3 = (dbPath: string, backupFile: string): void => {
  const bak = new Database(backupFile, { readonly: true });
  const ddl = (type: string) => (bak.prepare(`SELECT sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL AND name != ? ORDER BY name`).all(type, P4_REPOINTED_TABLE) as Array<{ sql: string }>).map((r) => r.sql);
  const [tables, indexes] = [ddl('table'), ddl('index')];
  bak.close();
  const db = new Database(dbPath);
  db.exec(`ATTACH DATABASE '${backupFile}' AS bak`);
  db.exec(
    [
      'BEGIN IMMEDIATE',
      'DROP TABLE IF EXISTS main.address_blocks',
      ...P4_BACKUP_TABLES.map((t) => `DROP TABLE IF EXISTS main.${t}`),
      ...tables,
      ...P4_BACKUP_TABLES.map((t) => `INSERT INTO main.${t} SELECT * FROM bak.${t}`),
      ...indexes,
      `UPDATE main.messages SET contact_id = (SELECT r.contact_id FROM bak.${P4_REPOINTED_TABLE} r WHERE r.id = messages.id) WHERE id IN (SELECT id FROM bak.${P4_REPOINTED_TABLE})`,
      'PRAGMA main.user_version = 3',
      'COMMIT',
    ].join(';\n'),
  );
  db.exec('DETACH DATABASE bak');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
};

/** Contact ids: the ones the released code made (kept), and the ones the migration makes. */
const a = (peer: string) => `a:${peer}`;
const at = (peer: string, my: string) => `a:${peer}~${my}`;
/** id → the address of mine it must belong to ('' = the first) after the migration (ADR-083 item 11). */
const OWNERS: Record<string, string> = {
  // yourself, your own computers, every contact by old handle: the first address — whatever was recorded
  self: '',
  [a(D.myAir.address)]: '',
  [a(D.studio.address)]: '',
  'c:bob': '',
  'c:alice': '',
  'c:alice/air': '',
  'c:erin': '', // (the release before had recorded `work` for her: an old handle is the first address's all the same)
  'c:dave': '',
  'c:eve': '',
  'c:lee': '', // a blocked old handle whose address is known
  'c:mel': '', // a blocked old handle: removed (the tombstone names her address), then blocked — the row made again has no address
  // contacts with only an address: the first address, unless the release before recorded another one
  [a(P.ann)]: '', // known_as = the literal first address
  [a(P.abe)]: '', // known_as = ''
  [a(P.nina)]: '', // known_as NULL: nothing exchanged yet
  [a(P.bart)]: '',
  [a(P.bea)]: '',
  [a(P.una)]: '',
  [a(P.wendy)]: W,
  [a(P.tess)]: W,
  [a(P.wanda)]: W,
  [a(P.lou)]: L,
};
/** The rows made for a (my address, peer) pair that had history under another address's contact: id → [my, peer, group, blocked]. */
const CREATED: Record<string, { my: string; peer: string; group: string; state: 'active' | 'blocked'; from: string; messages: string[] }> = {
  [at(P.tess, F)]: { my: '', peer: P.tess, group: 'colleague', state: 'active', from: a(P.tess), messages: [M['tessAtFirst']!, M['toTessFromFirst']!, M['toTessFromFirstUnnamed']!] },
  [at(P.tess, L)]: { my: L, peer: P.tess, group: 'colleague', state: 'active', from: a(P.tess), messages: [M['toTessFromLab']!] },
  [at(D.bob.address, W)]: { my: W, peer: D.bob.address, group: 'colleague', state: 'active', from: 'c:bob', messages: [M['toBobFromWork']!, M['bobAtWork']!] },
  [at(D.erin.address, W)]: { my: W, peer: D.erin.address, group: 'other', state: 'active', from: 'c:erin', messages: [M['toErinFromWork']!] },
  // (an own computer's group — self, or the one it was moved to — is not handed to another address: `other`)
  [at(D.studio.address, L)]: { my: L, peer: D.studio.address, group: 'other', state: 'active', from: a(D.studio.address), messages: [M['toStudioFromLab']!] },
  [at(P.bea, W)]: { my: W, peer: P.bea, group: 'other', state: 'blocked', from: a(P.bea), messages: [M['toBeaFromWork']!] },
};
/**
 * (ADR-083 review R3) The messages of a REMOVED contact (no row any more) that ran over another address of mine
 * than the first: re-pointed to the id their pairing has — no contact is made. new id → [the id they had, the messages].
 */
const ORPHANS: Record<string, { from: string; messages: string[] }> = {
  [at(P.kim, W)]: { from: a(P.kim), messages: [M['kimAtWork']!, M['kimAtWork2']!, M['toKimFromWork']!] },
};
const MOVED = Object.entries(OWNERS).filter(([, my]) => my).length;
/** Every message whose contact the migration changes: new id → { the id it had, the messages }. */
const REPOINTED = { ...Object.fromEntries(Object.entries(CREATED).map(([id, c]) => [id, { from: c.from, messages: c.messages }])), ...ORPHANS };
/**
 * address_blocks after the migration: [my address, their address]. (ADR-083 review R2) A block from before the
 * upgrade was the whole computer's: it stays at EVERY address this computer has — my first, `work` and `lab`.
 */
const EVERYWHERE = ['', W, L];
const BLOCKS = [
  // blocked by address (morse-blocked.json names the address): at every address of mine
  ...[P.bart /* a blocked contact of the first address */, P.wanda /* a blocked contact of `work` */, P.bea /* had dealings with two of my addresses */, P.zed /* rejected at the first address: nobody's contact */, P.fay /* rejected while her request waited at `work` */].flatMap((theirs) => EVERYWHERE.map((my) => [my, theirs])),
  // a blocked OLD HANDLE whose address is known: at the first address morse-blocked.json keeps deciding the handle
  // (no row); at the others, which know no handle, the address is written down
  ...[D.lee.address /* the address on the contact row */, D.mel.address /* known from the tombstone of the removed contact only */].flatMap((theirs) => [W, L].map((my) => [my, theirs])),
  // (eve and mallory are blocked old handles nobody knows an address for: nothing to write)
].map(([my, theirs]) => `${my}|${theirs}`).sort();
const REPORT = { from: 3, to: 4, contacts: Object.keys(OWNERS).length + Object.keys(CREATED).length, moved: MOVED, created: Object.keys(CREATED).length, elsewhere: MOVED + Object.values(CREATED).filter((c) => c.my).length, repointed: Object.values(REPOINTED).flatMap((c) => c.messages).length, requests: 2, blocks: BLOCKS.length };

describe('contacts per address of mine: the fixture the released code wrote (ADR-083)', () => {
  it('holds no key: what is committed is the database and the public files — the keys, and the addresses that follow from them, are made when the test runs', () => {
    // the committed directory: no .pem, no private key in any file (the builder and the README included), no identity
    expect(keyMaterialIn()).toEqual([]);
    const committed = (dir: string, rel = ''): string[] => readdirSync(join(dir, rel)).sort().flatMap((n) => (statSync(join(dir, rel, n)).isDirectory() ? committed(dir, join(rel, n)) : [join(rel, n)]));
    expect(committed(FIXTURE)).toEqual(['README.md', 'build.mjs', 'fixture.json', join('morse', 'addresses', 'agents.json'), join('morse', 'config.json'), join('morse', 'mailbox.db'), join('morse', 'morse-blocked.json'), join('morse', 'peer-keys.json'), join('morse', 'trusted-devices.json')]);
    // this run's keys give other addresses and another device ID than the ones the files were written with …
    const was = P3HOME.committed.mine;
    expect(new Set([F, W, L, fx.mine.device, was.first, was.work, was.lab, was.device]).size).toBe(8);
    // … which were replaced wherever they stood: who a contact knows me as, the address a message or a request
    // was written to, agents.json (the helper has checked that none is left and that nothing else changed)
    // [values of the database, dead copies in the database file's free space, occurrences in the other files]
    expect(Object.fromEntries(Object.entries(P3HOME.substituted).map(([n, s]) => [n, [s.database, s.slack, s.files]]))).toEqual({ first: [14, 0, 1], work: [18, 3, 1], lab: [5, 1, 1], device: [0, 0, 0] });
    expect({ ...fx, mine: was }).toEqual(P3HOME.committed); // (nobody else's address or device changed)
    const raw = readFileSync(join(P3HOME.morseDir, 'mailbox.db')).toString('latin1');
    for (const id of [was.first, was.work, was.lab]) expect(raw.includes(id), id).toBe(false);
    for (const id of [F, W, L]) expect(raw.includes(id), id).toBe(true);
  });

  it('is a schema v3 home with three addresses whose keys give exactly the addresses the database names', () => {
    const h = p3Home();
    expect(readdirSync(h.morseDir).sort()).toEqual(['addresses', 'config.json', 'identity', 'mailbox.db', 'morse-blocked.json', 'peer-keys.json', 'trusted-devices.json']);
    expect(readdirSync(join(h.morseDir, 'identity')).sort()).toEqual(['cert.pem', 'key.pem']);
    expect(readdirSync(join(h.morseDir, 'addresses')).sort()).toEqual([W, L, 'agents.json'].sort());
    expect(loadOrCreateIdentity(h.home).id).toBe(fx.mine.device);
    const s = snapshot(h.dbPath);
    expect(fx.builtBy).toBe('af4ca40');
    expect(s.version).toBe(3);
    const columns = (table: string) => String(s.schema.find((r) => r['type'] === 'table' && r['name'] === table)!['sql']);
    expect(columns('contacts')).not.toContain('my_address');
    expect(columns('contacts')).toContain('known_as');
    expect(columns('morse_requests')).toContain('handle TEXT PRIMARY KEY');
    expect(s.rows['address_blocks']).toBeUndefined();
    expect(s.rows['contacts']!.map((r) => r['id']).sort()).toEqual(Object.keys(OWNERS).sort());
    expect(s.rows['messages']).toHaveLength(Object.keys(M).length);
    // the keys of this run give exactly the addresses the database now names
    expect(homeContactContext(h.home).firstAddress?.()).toBe(F);
    expect(loadPrimaryAddress(h.home).address).toBe(F);
    const mine = ensureAgentAddresses(h.home);
    expect(mine.map((m) => [m.agent, m.key.address, m.primary])).toEqual([['mini', F, true], ['work', W, false], ['lab', L, false]]);
    // what the release before had recorded: which address a contact knows me by — '' and the literal first address both occur
    const known = Object.fromEntries(s.rows['contacts']!.map((r) => [r['id'], r['known_as']]));
    expect(known).toMatchObject({ [a(P.ann)]: F, [a(P.abe)]: '', [a(P.nina)]: null, [a(P.wendy)]: W, [a(P.tess)]: W, [a(P.lou)]: L, 'c:erin': W, 'c:bob': '' });
    // messages name my address as '' / the literal address / nothing (the old way)
    const forms = new Set(s.rows['messages']!.map((m) => m['my_address']));
    expect([...forms].sort((x, y) => String(x).localeCompare(String(y)))).toEqual([null, '', W, L, F].sort((x, y) => String(x).localeCompare(String(y))));
    expect(JSON.parse(readFileSync(join(h.morseDir, 'morse-blocked.json'), 'utf8'))).toEqual({ handles: ['eve', 'mallory', 'lee', 'mel', P.bart, P.wanda, P.bea, P.zed, P.fay] });
  });
});

describe('contacts per address of mine: the local migration (ADR-083)', () => {
  it('gives every contact, request and block to the address of mine it belongs to — ids kept, a row per (my address, peer) pair with history, tombstones and blocked file untouched', () => {
    const h = p3Home();
    const before = snapshot(h.dbPath);
    const beforeRest = untouched(h.dbPath);
    const beforeContact = messageContacts(h.dbPath);
    const files = Object.fromEntries(['morse-blocked.json', 'config.json', 'trusted-devices.json', 'peer-keys.json', join('addresses', 'agents.json')].map((f) => [f, readFileSync(join(h.morseDir, f))]));

    const reports: MigrationReportV4[] = [];
    const { db, mailbox } = open(h, reports);
    const { contacts, requests } = mailbox;
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(reports).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const after = snapshot(h.dbPath);

    // ---- contacts: every row from before is still there, unchanged but for the address it belongs to ----
    const rowOf = (id: string) => after.rows['contacts']!.find((r) => r['id'] === id)!;
    for (const old of before.rows['contacts']!) {
      const { my_address: my, state, ...rest } = rowOf(old['id'] as string);
      const { state: was, ...same } = old;
      expect(my, String(old['id'])).toBe(OWNERS[old['id'] as string]);
      expect(rest, String(old['id'])).toEqual(same); // id, remark, group, split, origin — and known_as, which stays a column
      // (who is blocked has a test of its own below: una's row said `blocked` while the release before did not block her)
      if (old['id'] !== a(P.una)) expect(state, String(old['id'])).toBe(was);
    }
    // (the column an older morse still reads says the same as the row for whatever belongs to another address)
    for (const r of after.rows['contacts']!) if (r['my_address']) expect(r['known_as'], String(r['id'])).toBe(r['my_address']);
    // …and exactly the new rows: one per (my address, peer) pair that had mail under another address's contact
    const made = after.rows['contacts']!.filter((r) => !before.rows['contacts']!.some((o) => o['id'] === r['id']));
    expect(made.map((r) => r['id']).sort()).toEqual(Object.keys(CREATED).sort());
    for (const r of made) {
      const want = CREATED[r['id'] as string]!;
      expect(r, String(r['id'])).toMatchObject({ my_address: want.my, address: want.peer, handle: null, agent: null, remark: null, nickname: null, group_label: want.group, state: want.state, split: 'done', origin: null, inherits: null, known_as: want.my });
      expect(contacts.byAddress(want.peer, want.my || null)).toMatchObject({ id: r['id'], myAddress: want.my, address: want.peer, remark: null, group: want.group, state: want.state });
    }
    expect(after.rows['contacts']).toHaveLength(REPORT.contacts);
    // one contact per (my address, their address), one per (my address, old handle, agent)
    const pairs = after.rows['contacts']!.filter((r) => r['address']).map((r) => `${r['my_address']}|${r['address']}`);
    expect(new Set(pairs).size).toBe(pairs.length);

    // ---- messages: only the contact of the re-pointed ones changed ----
    expect(untouched(h.dbPath)).toEqual(beforeRest);
    const afterContact = messageContacts(h.dbPath);
    const repointed = Object.fromEntries(Object.entries(REPOINTED).flatMap(([id, c]) => c.messages.map((m) => [m, { from: c.from, to: id }])));
    expect(Object.keys(repointed)).toHaveLength(REPORT.repointed);
    for (const [id, contact] of Object.entries(beforeContact)) {
      if (repointed[id]) expect([contact, afterContact[id]], id).toEqual([repointed[id]!.from, repointed[id]!.to]);
      else expect(afterContact[id], id).toBe(contact);
    }

    // ---- who is a contact of which address of mine ----
    // ann knew my first address (the release before recorded the literal address), abe too (recorded as ''), nina nothing yet
    expect(contacts.byAddress(P.ann)).toMatchObject({ id: a(P.ann), myAddress: '', remark: 'Ann', group: 'friend', state: 'active' });
    expect(contacts.byAddress(P.abe)).toMatchObject({ id: a(P.abe), myAddress: '' });
    expect(contacts.byAddress(P.nina)).toMatchObject({ id: a(P.nina), myAddress: '', group: 'other' });
    for (const p of [P.ann, P.abe, P.nina]) for (const my of [W, L]) expect(contacts.byAddress(p, my), `${p} at ${my}`).toBeNull();
    // wendy only ever wrote to `work`: its contact, with the id, remark and group she had — and nobody at my first address
    expect(contacts.byAddress(P.wendy, W)).toMatchObject({ id: a(P.wendy), myAddress: W, remark: 'Wendy', group: 'colleague', state: 'active' });
    expect(contacts.byAddress(P.wendy)).toBeNull();
    expect(contacts.byAddress(P.wendy, L)).toBeNull();
    expect(contacts.find('Wendy')!.id).toBe(a(P.wendy));
    expect(contacts.find(P.wendy)!.id).toBe(a(P.wendy)); // (the only one there is)
    expect(contacts.knownAs(a(P.wendy))).toBe(W);
    // lou: I wrote to him first, from `lab`
    expect(contacts.byAddress(P.lou, L)).toMatchObject({ id: a(P.lou), myAddress: L, remark: 'Lou' });
    expect(contacts.byAddress(P.lou)).toBeNull();
    // tess had mail with three of my addresses: three contacts — the one she was (of `work`) keeps id, remark, group
    expect(contacts.findAll(P.tess).map((c) => c.myAddress).sort()).toEqual(['', W, L].sort());
    expect(contacts.find(P.tess)).toBeNull(); // never a guess
    expect(contacts.find(P.tess, W)).toMatchObject({ id: a(P.tess), remark: 'Tess', group: 'colleague' });
    expect(contacts.find(P.tess, F)).toMatchObject({ id: at(P.tess, F), myAddress: '', remark: null, group: 'colleague' });
    expect(contacts.find(P.tess, L)).toMatchObject({ id: at(P.tess, L), myAddress: L, remark: null, group: 'colleague' });
    expect(contacts.find('Tess')!.id).toBe(a(P.tess));
    expect(mailbox.history(a(P.tess)).map((m) => m.id)).toEqual([M['tessAtWork'], M['toTessFromWork']]);
    expect(mailbox.history(at(P.tess, F)).map((m) => m.id)).toEqual([M['tessAtFirst'], M['toTessFromFirst'], M['toTessFromFirstUnnamed']]);
    expect(mailbox.history(at(P.tess, L)).map((m) => m.id)).toEqual([M['toTessFromLab']]);
    // contacts by old handle are the first address's alone; mail that went to their ADDRESS from `work` is work's contact
    expect(contacts.find('Bobby')).toMatchObject({ id: 'c:bob', myAddress: '', handle: 'bob', address: D.bob.address, group: 'colleague' });
    expect(contacts.byAddress(D.bob.address)!.id).toBe('c:bob');
    expect(contacts.byAddress(D.bob.address, W)).toMatchObject({ id: at(D.bob.address, W), handle: null, remark: null, group: 'colleague' });
    expect(mailbox.history('c:bob').map((m) => m.id)).toEqual([M['toBob'], M['fromBob'], M['bobThread'], M['bobThreadReply'], M['waitingBob']]);
    expect(mailbox.history(at(D.bob.address, W)).map((m) => m.id)).toEqual([M['toBobFromWork'], M['bobAtWork']]);
    expect(contacts.get('c:erin')).toMatchObject({ myAddress: '', handle: 'erin', address: D.erin.address });
    expect(mailbox.history('c:erin')).toEqual([]);
    expect(mailbox.history(at(D.erin.address, W)).map((m) => m.id)).toEqual([M['toErinFromWork']]);
    expect(contacts.get('c:alice')).toMatchObject({ myAddress: '', group: 'friend', address: D.aliceMini.address });
    expect(contacts.get('c:alice/air')).toMatchObject({ myAddress: '', handle: 'alice', agent: 'air', address: D.aliceAir.address, remark: 'alice/air' });
    expect(contacts.get('c:dave')).toMatchObject({ myAddress: '', split: 'pending' });
    expect(contacts.get('c:eve')).toMatchObject({ myAddress: '', state: 'blocked' });
    expect(contacts.pendingSplits().map((c) => c.id).sort()).toEqual(['c:dave', 'c:eve', 'c:mel']);
    // my own computers: the first address's — the one in group self, and the one I moved out of it (still lowered)
    expect(contacts.ownDevice(D.myAir.address)).toMatchObject({ id: a(D.myAir.address), myAddress: '', group: 'self', origin: 'own-device' });
    expect(contacts.ownDevice(D.studio.address)).toMatchObject({ id: a(D.studio.address), myAddress: '', group: 'colleague', origin: 'own-device', remark: 'studio' });
    expect(contacts.ownDeviceOf(D.studio.id)!.id).toBe(a(D.studio.address));
    expect(contacts.isLowered(D.studio.id)).toBe(true);
    expect(contacts.isLowered(D.myAir.id)).toBe(false);
    // …what `lab` wrote to that computer's address is lab's contact: an ordinary one, not one of my own computers
    expect(contacts.byAddress(D.studio.address, L)).toMatchObject({ id: at(D.studio.address, L), origin: null, group: 'other', remark: null });
    expect(mailbox.history(a(D.studio.address)).map((m) => m.id)).toEqual([M['toStudio']]);
    expect(mailbox.history('self').map((m) => m.id)).toEqual([M['fromMyAir'], M['internal']]);
    // the addresses seen under a contact are kept for the first address's contacts only
    const seen = Object.fromEntries(after.rows['contact_addresses']!.map((r) => [r['address'], r['contact_id']]));
    for (const [id, my] of Object.entries(OWNERS)) if (my) expect(Object.values(seen), id).not.toContain(id);
    expect(seen[P.tess]).toBe(at(P.tess, F));
    expect(seen).toMatchObject({ [P.ann]: a(P.ann), [D.myAir.address]: a(D.myAir.address), [D.aliceAir.address]: 'c:alice/air' });
    expect(after.rows['contact_agents']).toEqual(before.rows['contact_agents']);

    // ---- message requests: the address they were written to; the old way: the first ----
    expect(after.rows['morse_requests']!.map(({ my_address: _my, ...r }) => r).sort((x, y) => String(x['handle']).localeCompare(String(y['handle'])))).toEqual(
      [...before.rows['morse_requests']!].sort((x, y) => String(x['handle']).localeCompare(String(y['handle']))),
    );
    expect(requests.get(P.rob)).toMatchObject({ myAddress: '', toAddress: F, text: 'rob, to your first address' });
    expect(requests.get(P.rita)).toBeUndefined();
    expect(requests.get(P.rita, W)).toMatchObject({ myAddress: W, toAddress: W, text: 'rita, to work', to: { agent: 'work', sessionId: 'inbox' } });
    expect(requests.get(P.ruth)).toBeUndefined();
    expect(requests.get(P.ruth, L)).toMatchObject({ myAddress: L, toAddress: L });
    expect(requests.get('carol')).toMatchObject({ myAddress: '', deviceId: D.carol.id, fromAgent: 'pro', text: 'may I?' });
    expect(requests.get('carol')!.toAddress).toBeUndefined();
    expect(requests.list('').map((r) => r.handle).sort()).toEqual(['carol', P.rob].sort());
    expect([requests.count(), requests.count(''), requests.count(W), requests.count(L)]).toEqual([4, 2, 1, 1]);
    expect(requests.find(P.rita).map((r) => r.myAddress)).toEqual([W]);

    // ---- blocks by address: per (my address, their address); morse-blocked.json is not touched ----
    expect(after.rows['address_blocks']!.map((r) => `${r['my_address']}|${r['address']}`).sort()).toEqual(BLOCKS);
    for (const r of after.rows['address_blocks']!) expect(r['at']).toBe(NOW);
    // (ADR-083 review R2) whoever was blocked before the upgrade — then a block of the whole computer — is blocked at every address of mine
    for (const p of [P.bart, P.wanda, P.bea, P.zed, P.fay]) expect([contacts.isBlockedAt(p), contacts.isBlockedAt(p, W), contacts.isBlockedAt(p, L)], p).toEqual([true, true, true]);
    expect(contacts.byAddress(P.bart)).toMatchObject({ id: a(P.bart), state: 'blocked' });
    expect(contacts.byAddress(P.wanda, W)).toMatchObject({ id: a(P.wanda), state: 'blocked' });
    expect(contacts.byAddress(P.wanda)).toBeNull(); // a contact of `work` only (no row is made for a block) — and blocked at my first address too
    expect(contacts.byAddress(P.bea)).toMatchObject({ id: a(P.bea), state: 'blocked' });
    expect(contacts.byAddress(P.bea, W)).toMatchObject({ id: at(P.bea, W), state: 'blocked' });
    expect(contacts.byAddress(P.zed)).toBeNull();
    // the old handles in morse-blocked.json (eve, a contact; mallory, nobody's) make no row: the file keeps deciding them
    for (const f of Object.keys(files)) expect(readFileSync(join(h.morseDir, f)).equals(files[f]!), f).toBe(true);
    expect(after.rows['address_blocks']!.some((r) => r['address'] === 'eve' || r['address'] === 'mallory')).toBe(false);

    // ---- tombstones and the other bookkeeping: not one key rewritten; the backup's path is the only new one ----
    expect(after.rows['migration_marks']!.filter((r) => r['key'] !== P4_BACKUP_MARK && r['key'] !== P4_BLOCKS_SEEN_MARK)).toEqual(before.rows['migration_marks']);
    // (the address entries of morse-blocked.json that were taken over are remembered: one that appears there later was written by an older morse)
    expect(JSON.parse(mailbox.contacts.mark(P4_BLOCKS_SEEN_MARK)!)).toEqual(JSON.parse(readFileSync(join(h.morseDir, 'morse-blocked.json'), 'utf8')).handles.filter((x: string) => /^[23456789abcdefghjkmnpqrstvwxyz]{26}$/.test(x)).sort());
    expect(contacts.mark(`removed:${P.gus}`)).toContain(a(P.gus));
    expect(contacts.mark(`removed:${D.alicePro.address}`)).toContain('c:alice/pro');
    expect(contacts.mark('removed:c:alice/pro')).toBe(D.alicePro.address);
    for (const my of [null, W, L]) expect(contacts.byAddress(P.gus, my)).toBeNull();
    expect(contacts.byAddress(D.alicePro.address)).toBeNull();
    expect(mailbox.history(a(P.gus)).map((m) => m.id)).toEqual([M['fromGus']]); // (history of a removed contact stays, as before)
    expect(after.rows['migration_marks']!.filter((r) => String(r['key']).startsWith('removed:')).map((r) => r['key']).sort()).toEqual([`removed:${P.gus}`, `removed:${P.kim}`, `removed:${D.mel.address}`, `removed:${D.alicePro.address}`, 'removed:c:alice/pro'].sort());

    // ---- the table shapes ----
    const sql = (name: string) => String(after.schema.find((r) => r['name'] === name)!['sql']);
    expect(sql('contacts')).toMatch(/my_address TEXT NOT NULL DEFAULT ''/);
    expect(sql('contacts')).toContain('known_as TEXT');
    expect(sql('contacts_address')).toContain('contacts(my_address, address)');
    expect(sql('contacts_handle_agent')).toContain(`contacts(my_address, handle, COALESCE(agent, ''))`);
    expect(sql('contacts_remark')).toContain('contacts(lower(remark))');
    expect(sql('morse_requests')).toContain('PRIMARY KEY (my_address, handle)');
    expect(sql('address_blocks')).toContain('PRIMARY KEY (my_address, address)');
    expect(after.schema.map((r) => r['name'])).not.toContain('contacts_v3_old');
    expect(after.schema.map((r) => r['name'])).not.toContain('morse_requests_v3_old');
    db.close();
  });

  it('new mail after the migration is sorted by (my address, sender) — also where a moved contact kept the plain id', () => {
    const h = p3Home();
    const { db, mailbox } = open(h);
    const native = (from: string, to: string, text: string) => mailbox.send({ from: { agent: 'claude', sessionId: '', device: from }, to: { agent: 'mini', sessionId: 'inbox' }, text, via: 'morse-relay', fromTier: 'peer', myAddress: to });
    // wendy writes to `work` again: her contact there, as before
    expect(native(P.wendy, W, 'to work again')).toMatchObject({ contactId: a(P.wendy), myAddress: W });
    // …and to my first address for the first time: a contact of its own (the plain id is taken by work's)
    const firstTime = native(P.wendy, F, 'to your first address');
    expect(firstTime.contactId).toBe(at(P.wendy, F));
    expect(mailbox.contacts.get(firstTime.contactId!)).toMatchObject({ myAddress: '', address: P.wendy, remark: null, group: 'other' });
    expect(mailbox.contacts.get(a(P.wendy))).toMatchObject({ myAddress: W, remark: 'Wendy', group: 'colleague' });
    // I write to lou naming nothing: from `lab`, the address he is a contact of
    expect(mailbox.send({ from: { agent: 'claude', sessionId: 's-1' }, to: { agent: 'user', sessionId: '', device: P.lou }, text: 'lou?' })).toMatchObject({ contactId: a(P.lou), myAddress: L });
    // to ann: from my first address
    expect(mailbox.send({ from: { agent: 'claude', sessionId: 's-1' }, to: { agent: 'user', sessionId: '', device: P.ann }, text: 'ann?' })).toMatchObject({ contactId: a(P.ann), fromFirstAddress: true });
    // to tess, who is a contact of three of my addresses: not guessed
    expect(() => mailbox.send({ from: { agent: 'claude', sessionId: 's-1' }, to: { agent: 'user', sessionId: '', device: P.tess }, text: 'tess?' })).toThrow(/is a contact of 3 of your addresses/);
    expect(mailbox.send({ from: { agent: 'claude', sessionId: 's-1' }, to: { agent: 'user', sessionId: '', device: P.tess }, text: 'tess?', myAddress: L, myAgent: 'lab' })).toMatchObject({ contactId: at(P.tess, L), myAddress: L });
    // old handles as before
    expect(mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'again', fromTier: 'peer' }).contactId).toBe('c:bob');
    expect(mailbox.send({ from: { agent: 'claude', sessionId: 's-9', device: 'me/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'own', fromTier: 'owner' }).contactId).toBe('self');
    db.close();
  });

  it('whoever was blocked before the upgrade is blocked after it, and nobody else — also someone I had blocked and then wrote to again', () => {
    const h = p3Home();
    const before = snapshot(h.dbPath).rows['contacts']!;
    // what the release before obeyed (its `toContact`): morse-blocked.json by old handle, else by address — never the
    // row's own `state` column, which it left behind when writing to a blocked address unblocked it
    const file = new Set((JSON.parse(readFileSync(join(h.morseDir, 'morse-blocked.json'), 'utf8')) as { handles: string[] }).handles);
    const wasBlocked = (r: Row): boolean => (r['origin'] === 'own-device' ? r['state'] === 'blocked' : file.has(String(r['handle'] ?? r['address'])));
    const una = before.find((r) => r['address'] === P.una)!;
    expect([una['state'], wasBlocked(una)]).toEqual(['blocked', false]); // (the stale column, and what counted)
    const { db, mailbox } = open(h);
    const wrong = before.filter((r) => mailbox.contacts.get(r['id'] as string)!.state !== (wasBlocked(r) ? 'blocked' : 'active')).map((r) => ({ id: r['id'], was: wasBlocked(r) ? 'blocked' : 'active', is: mailbox.contacts.get(r['id'] as string)!.state }));
    expect(wrong).toEqual([]);
    expect(mailbox.contacts.byAddress(P.una)).toMatchObject({ id: a(P.una), myAddress: '', state: 'active' });
    expect(mailbox.contacts.isBlockedAt(P.una)).toBe(false);
    expect(mailbox.history(a(P.una)).map((m) => m.id)).toEqual([M['fromUna'], M['toUna']]);
    db.close();
  });

  it('takes ONE backup before anything changes: the five rewritten tables exactly as they were, the old contact of every re-pointed message — 0700 / 0600', () => {
    const h = p3Home();
    const before = rowsOf(h.dbPath, P4_BACKUP_TABLES);
    const beforeDdl = ddlOf(h.dbPath, P4_BACKUP_TABLES);
    const beforeContact = messageContacts(h.dbPath);
    const v3Indexes = snapshot(h.dbPath).schema.filter((r) => r['type'] === 'index' && (P4_BACKUP_TABLES as readonly string[]).includes(String(r['tbl_name']))).map((r) => ({ name: String(r['name']), tbl_name: String(r['tbl_name']), sql: String(r['sql']) }));
    const reports: MigrationReportV4[] = [];
    const { db, mailbox } = open(h, reports);
    const dir = reports[0]!.backup!;
    expect(dir).toBe(join(h.morseDir, 'backups', STAMP));
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(besides(h.morseDir)).toEqual([]);
    expect(mailbox.contacts.mark(P4_BACKUP_MARK)).toBe(dir);
    expect(P4_BACKUP_MARK).toBe('p4.backup');
    // permissions: nobody else reads who your contacts are
    expect(statSync(join(h.morseDir, 'backups')).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).sort()).toEqual(['MANIFEST.json', 'tables.sqlite']); // no IN-PROGRESS left
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);
    // tables.sqlite: the five tables — schema and rows — as the release before left them, at its version
    const saved = join(dir, 'tables.sqlite');
    const inBackup = new Database(saved, { readonly: true });
    expect((inBackup.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name)).toEqual([...P4_BACKUP_TABLES, P4_REPOINTED_TABLE].sort());
    expect(inBackup.pragma('user_version', { simple: true })).toBe(3);
    const repointedRows = inBackup.prepare(`SELECT id, contact_id FROM ${P4_REPOINTED_TABLE} ORDER BY id`).all() as Array<{ id: string; contact_id: string }>;
    inBackup.close();
    expect([...P4_BACKUP_TABLES]).toEqual(['contacts', 'contact_agents', 'contact_addresses', 'morse_requests', 'migration_marks']);
    expect(P4_REPOINTED_TABLE).toBe('repointed_messages');
    expect(rowsOf(saved, P4_BACKUP_TABLES)).toEqual(before);
    expect(ddlOf(saved, P4_BACKUP_TABLES)).toEqual(beforeDdl);
    expect(ddlOf(saved, ['contacts'])['contacts']).not.toContain('my_address');
    // (ADR-083 review R8) …and their INDEX definitions, as they were before the rewrite: the backup's own sqlite_master
    // holds every CREATE TABLE and CREATE INDEX a restore needs
    const indexesIn = (path: string) => {
      const d = new Database(path, { readonly: true });
      const rows = d.prepare(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${P4_BACKUP_TABLES.map(() => '?').join(', ')}) ORDER BY name`).all(...P4_BACKUP_TABLES) as Array<{ name: string; tbl_name: string; sql: string }>;
      d.close();
      return rows;
    };
    expect(indexesIn(saved)).toEqual(v3Indexes);
    expect(v3Indexes.map((i) => i.name)).toEqual(['contacts_address', 'contacts_handle_agent', 'contacts_remark', 'idx_contact_addresses']);
    expect(v3Indexes.find((i) => i.name === 'contacts_address')!.sql).toBe('CREATE UNIQUE INDEX contacts_address ON contacts(address) WHERE address IS NOT NULL'); // (the v3 shape: one contact per address)
    expect(indexesIn(h.dbPath).find((i) => i.name === 'contacts_address')!.sql).toContain('contacts(my_address, address)');
    // …and the contact every re-pointed message belonged to: with it, the old state can be put back exactly
    const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1);
    const moved = Object.values(REPOINTED).flatMap((c) => c.messages.map((id) => ({ id, contact_id: c.from })));
    expect([...repointedRows].sort(byId)).toEqual(moved.sort(byId));
    const now = messageContacts(h.dbPath);
    expect(Object.fromEntries(Object.entries(now).map(([id, c]) => [id, repointedRows.find((r) => r.id === id)?.contact_id ?? c]))).toEqual(beforeContact);
    // small: no message text is copied
    expect(statSync(saved).size).toBeLessThan(200_000);
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      migration: 'contacts-per-address',
      adr: 'ADR-083',
      createdAt: new Date(NOW).toISOString(),
      fromUserVersion: 3,
      tables: [...P4_BACKUP_TABLES, P4_REPOINTED_TABLE],
      rows: { ...Object.fromEntries(P4_BACKUP_TABLES.map((t) => [t, before[t]!.length])), [P4_REPOINTED_TABLE]: REPORT.repointed },
      files: { 'tables.sqlite': statSync(saved).size },
      // (ADR-083 review R8) the statements themselves: every table of the five, then their indexes
      schema: [...P4_BACKUP_TABLES.map((t) => beforeDdl[t]), ...[...v3Indexes].sort((x, y) => P4_BACKUP_TABLES.indexOf(x.tbl_name as (typeof P4_BACKUP_TABLES)[number]) - P4_BACKUP_TABLES.indexOf(y.tbl_name as (typeof P4_BACKUP_TABLES)[number]) || (x.name < y.name ? -1 : 1)).map((i) => i.sql)],
    });
    db.close();
  });

  it('(review R8) the backup puts the v3 database back EXACTLY — tables, indexes, every re-pointed message, version — from either place it can be in; the next open migrates again', () => {
    for (const beside of [false, true]) {
      const h = p3Home();
      const before = snapshot(h.dbPath);
      if (beside) writeFileSync(join(h.morseDir, 'backups'), 'not a directory');
      const reports: MigrationReportV4[] = [];
      const first = open(h, reports);
      // (something written after the upgrade, which a restore does not keep: a block of this release)
      first.mailbox.contacts.blockAt(P.ann, W);
      first.db.pragma('wal_checkpoint(TRUNCATE)');
      first.db.close();
      const file = beside ? `${h.dbPath}${BAK}` : join(reports[0]!.backup!, 'tables.sqlite');
      expect(reports[0]!.backup).toBe(beside ? file : join(h.morseDir, 'backups', STAMP));
      expect(snapshot(h.dbPath).version).toBe(4);
      restoreV3(h.dbPath, file);
      // the database the release before left: every table, every row, every index definition, user_version 3
      // (ADR-089: `messages` keeps the lease columns this release added after the upgrade — nothing else differs)
      expect(sansLease(snapshot(h.dbPath)), String(beside)).toEqual(before);
      expect(new Database(h.dbPath, { readonly: true }).pragma('integrity_check', { simple: true })).toBe('ok');
      // …and this release migrates it again like the first time (the beside-the-database copy must be moved away first:
      // a second one is never written over it — the guide says so)
      if (beside) renameSync(file, `${file}.restored`);
      const again: MigrationReportV4[] = [];
      const second = open(h, again);
      expect(again).toEqual([{ ...REPORT, backup: beside ? file : join(h.morseDir, 'backups', `${STAMP}-1`) }]);
      expect(second.mailbox.contacts.isBlockedAt(P.ann, W)).toBe(false); // (what was written after the first upgrade is gone)
      second.db.pragma('wal_checkpoint(TRUNCATE)');
      second.db.close();
      const same = (x: ReturnType<typeof snapshot>) => ({ ...x, rows: { ...x.rows, migration_marks: x.rows['migration_marks']!.filter((r) => r['key'] !== P4_BACKUP_MARK) } });
      expect(same(result(h)), String(beside)).toEqual(same(reference()));
    }
  });

  it('(review R2) a block from before the upgrade keeps blocking at EVERY address of mine: fay, rejected while her request waited at `work`; bart, a blocked contact of the first address; lee and mel, blocked old handles — an address added later starts with none', () => {
    const h = p3Home();
    const { db, mailbox } = open(h);
    const { contacts, requests } = mailbox;
    const blockedAt = (theirs: string, c = contacts) => EVERYWHERE.map((my) => c.isBlockedAt(theirs, my));
    // fay: nobody's contact, no request left — before the upgrade the whole computer dropped her mail, and it still does
    expect(contacts.findAll(P.fay)).toEqual([]);
    expect(requests.find(P.fay)).toEqual([]);
    expect(blockedAt(P.fay)).toEqual([true, true, true]);
    // bart: a blocked contact of my first address — no contact row is made at the others, the block is there
    expect(contacts.findAll(P.bart).map((c) => [c.myAddress, c.state])).toEqual([['', 'blocked']]);
    expect(blockedAt(P.bart)).toEqual([true, true, true]);
    // wanda: a blocked contact of `work` — blocked at my first address and at `lab` too
    expect(contacts.findAll(P.wanda).map((c) => [c.myAddress, c.state])).toEqual([[W, 'blocked']]);
    expect(blockedAt(P.wanda)).toEqual([true, true, true]);
    // lee: a blocked OLD HANDLE whose address is known. My first address: morse-blocked.json keeps deciding the handle
    // (no row — the contact says blocked); the others know no handle: there the address is blocked
    expect(contacts.byAddress(D.lee.address)).toMatchObject({ id: 'c:lee', handle: 'lee', state: 'blocked' });
    expect(blockedAt(D.lee.address)).toEqual([false, true, true]);
    // mel: a blocked old handle whose contact was removed — her address is known from the tombstone only
    expect(contacts.byAddress(D.mel.address)).toBeNull();
    expect(JSON.parse(contacts.mark(`removed:${D.mel.address}`)!)).toMatchObject({ id: 'c:mel', handle: 'mel' });
    expect(blockedAt(D.mel.address)).toEqual([false, true, true]);
    // nobody who was not blocked is: ann, wendy, una (whose stale row said `blocked`), bob
    for (const p of [P.ann, P.wendy, P.una, P.kim, P.gus, D.bob.address, D.studio.address]) expect(blockedAt(p), p).toEqual([false, false, false]);
    // an address this computer gets LATER has no blocks: it is a new persona
    const later = stranger();
    for (const p of [P.fay, P.bart, P.wanda, D.lee.address, D.mel.address]) expect(contacts.isBlockedAt(p, later), p).toBe(false);
    // from now on a block is one address's: lifting fay's at `work` leaves the two others, also after the next open
    expect(contacts.unblockAt(P.fay, W)).toBe(true);
    expect(blockedAt(P.fay)).toEqual([true, false, true]);
    db.close();
    const again = open(h);
    expect(blockedAt(P.fay, again.mailbox.contacts)).toEqual([true, false, true]);
    again.db.close();
  });

  it('(review R2) which blocks, and where: without morse-blocked.json the rows decide; a paired computer of a blocked handle; one of my own computers that is blocked; the addresses the database names when nothing lists them', () => {
    const h = p3Home();
    const v3 = new Database(h.dbPath);
    // (`contacts.set(<id>, { state: 'blocked' })` of the release before — its statement; no command of it blocks an own computer)
    v3.prepare('UPDATE contacts SET state = ?, updated_at = ? WHERE id = ?').run('blocked', NOW - 1000, a(D.studio.address));
    v3.pragma('wal_checkpoint(TRUNCATE)');
    v3.close();
    const evesComputer = stranger();
    // no blocked file to ask, nothing that lists my addresses: only the first address is known
    const ctx: ContactContext = { firstAddress: () => F, devices: () => [{ id: 'EVES-COMPUTER', name: 'Eve', tier: 'peer', address: evesComputer }, { id: 'MINE', name: 'eve', tier: 'owner', address: stranger() }] };
    const reports: MigrationReportV4[] = [];
    const { db } = open(h, reports, ctx);
    const got = (db.prepare('SELECT my_address, address FROM address_blocks').all() as Array<{ my_address: string; address: string }>).map((r) => `${r.my_address}|${r.address}`).sort();
    const want = [
      // the rows that say `blocked` (una's too: with no file, her row is all there is), and my own blocked computer: everywhere —
      // `work` and `lab` are known from the messages, the contacts and the requests alone
      ...[P.bart, P.wanda, P.bea, P.una, D.studio.address].flatMap((theirs) => EVERYWHERE.map((my) => `${my}|${theirs}`)),
      // the blocked old handles (eve, lee, mel by their rows): lee's own address, mel's from her tombstone, eve's paired
      // computer (not the one of mine that happens to be called the same) — at the addresses other than the first
      ...[D.lee.address, D.mel.address, evesComputer].flatMap((theirs) => [W, L].map((my) => `${my}|${theirs}`)),
    ].sort();
    expect(got).toEqual(want);
    expect(reports[0]!.blocks).toBe(want.length);
    db.close();
  });

  it('(review R2) which addresses this computer has cannot be read (a damaged agents.json) while someone is blocked: refused in one line, nothing changed — and migrates once it can', () => {
    const h = p3Home();
    const before = snapshot(h.dbPath);
    const index = join(h.morseDir, 'addresses', 'agents.json');
    const good = readFileSync(index);
    writeFileSync(index, '{ not json');
    let error: unknown;
    try {
      open(h);
    } catch (e) {
      error = e;
    }
    expect((error as Error | undefined)?.message).toMatch(/^cannot tell which addresses are here \(.*agents\.json is damaged \(not JSON\).*\) — the people you blocked could not be kept blocked at each of them; your contacts were not changed; the upgrade runs again the next time morse starts$/);
    expect((error as Error).message.split('\n')).toHaveLength(1);
    // (review N1) the type a command catches: it says the one line and ends — no stack trace
    expect(error).toBeInstanceOf(MigrationRefusedV4);
    expect(error).not.toBeInstanceOf(BackupErrorV4);
    expect(snapshot(h.dbPath)).toEqual(before);
    expect(backups(h.morseDir)).toEqual([]);
    expect(besides(h.morseDir)).toEqual([]);
    writeFileSync(index, good);
    const reports: MigrationReportV4[] = [];
    const { db } = open(h, reports);
    expect(reports).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    expect(result(h)).toEqual(reference());
  });

  it('(review R3) a removed contact\'s history does not resurface under another address of mine: kim, a contact of `work`, removed — added again at my first address she has no history; added again at `work` she has hers', () => {
    const h = p3Home();
    const kims = ORPHANS[at(P.kim, W)]!.messages;
    const v3 = messageContacts(h.dbPath);
    for (const id of kims) expect(v3[id]).toBe(a(P.kim)); // (the id the first address would give a contact of kim made now)
    const { db, mailbox } = open(h);
    const { contacts } = mailbox;
    // still nobody's contact, her tombstone as it was
    expect(contacts.findAll(P.kim)).toEqual([]);
    expect(JSON.parse(contacts.mark(`removed:${P.kim}`)!)).toMatchObject({ id: a(P.kim), handle: null });
    // what she exchanged with `work` belongs to that pairing: the id a contact of (work, kim) has
    for (const id of kims) expect(mailbox.getMessage(id)).toMatchObject({ contactId: at(P.kim, W), myAddress: W });
    expect(mailbox.history(a(P.kim))).toEqual([]);
    // `morse contact add <kim>`: a contact of my first address — with the plain id, and nothing of what `work` exchanged
    const atFirst = contacts.ensureAddress(P.kim);
    expect(atFirst).toMatchObject({ id: a(P.kim), myAddress: '' });
    expect(mailbox.history(atFirst.id)).toEqual([]);
    expect(mailbox.todo({ contactId: atFirst.id })).toEqual([]);
    expect(mailbox.unread()[atFirst.id]).toBeUndefined();
    // `morse contact add <kim> --from work`: the contact of `work` — and the history that IS work's
    const atWork = contacts.ensureAddress(P.kim, W);
    expect(atWork).toMatchObject({ id: at(P.kim, W), myAddress: W });
    expect(mailbox.history(atWork.id).map((m) => m.id)).toEqual(kims);
    expect(mailbox.todo({ contactId: atWork.id }).map((m) => m.id)).toEqual([M['kimAtWork'], M['kimAtWork2']]);
    expect(mailbox.unread()[atWork.id]).toBe(2);
    expect(mailbox.history(atFirst.id)).toEqual([]);
    // gus was a contact of my FIRST address when he was removed: his id is that pairing's — added again there he has
    // his history (as before); at `work` he has none
    expect(mailbox.getMessage(M['fromGus']!)).toMatchObject({ contactId: a(P.gus) });
    const gusAtWork = contacts.ensureAddress(P.gus, W);
    expect(gusAtWork.id).toBe(at(P.gus, W));
    expect(mailbox.history(gusAtWork.id)).toEqual([]);
    expect(mailbox.history(contacts.ensureAddress(P.gus).id).map((m) => m.id)).toEqual([M['fromGus']]);
    db.close();
  });

  it('every message is still readable the same way; the outbox is still pending and goes out from the same address', () => {
    const h = p3Home();
    const v3 = new Database(h.dbPath, { readonly: true });
    const raw = v3.prepare('SELECT * FROM messages ORDER BY created_at ASC, rowid ASC').all() as Array<Record<string, string | number | null>>;
    v3.close();
    const { db, mailbox } = open(h);
    const ref = (agent: unknown, sessionId: unknown, device: unknown) => ({ agent, sessionId, ...(device ? { device } : {}) });
    expect(raw).toHaveLength(Object.keys(M).length);
    for (const r of raw) {
      const m = mailbox.getMessage(r['id'] as string)!;
      expect(m, String(r['id'])).toMatchObject({ direction: r['direction'], status: r['status'], attempts: r['attempts'], createdAt: r['created_at'], updatedAt: r['updated_at'] });
      expect(m.parts, String(r['id'])).toEqual(JSON.parse(r['parts'] as string));
      expect(m.from, String(r['id'])).toEqual(ref(r['from_agent'], r['from_session'], r['from_device']));
      expect(m.to, String(r['id'])).toEqual(ref(r['to_agent'], r['to_session'], r['to_device']));
      expect([m.myAddress ?? null, Boolean(m.fromFirstAddress), m.myAgent ?? null], String(r['id'])).toEqual([r['my_address'] || null, r['my_address'] === '' && r['direction'] === 'out', r['agent']]);
      expect([Boolean(m.waiting), Boolean(m.request), Boolean(m.ownThread), m.receiptAt ?? null, m.processedAt ?? null, m.processedBy ?? null], String(r['id'])).toEqual([r['waiting'] === 1, r['request'] === 1, r['own_thread'] === 1, r['receipt_at'], r['processed_at'], r['processed_by']]);
    }
    expect(mailbox.getMessage(M['fromWendy']!)!.parts[0]!.text).toBe('hello work, I am wendy');
    expect(mailbox.getMessage(M['bobThreadReply']!)).toMatchObject({ ownThread: true, to: { agent: 'claude', sessionId: 's-1' }, contactId: 'c:bob' });
    expect(mailbox.getMessage(M['toDave']!)).toMatchObject({ request: true, contactId: 'c:dave' });
    expect(mailbox.requestPending()).toEqual([{ to: 'dave', my: '' }]);

    // every message with a person is in exactly one contact's history — none lost, none twice
    // (the ids the messages have NOW: the history of a removed contact that ran over `work` is under that pairing's id)
    const ids = [...new Set([...mailbox.contacts.list().map((c) => c.id), ...Object.values(messageContacts(h.dbPath)).map((c) => c as string)])];
    const listed = ids.flatMap((id) => mailbox.history(id, { limit: 1000 }).map((m) => m.id));
    expect([...listed].sort()).toEqual(raw.map((r) => r['id'] as string).sort());
    // …and under a contact of the very address of mine it was exchanged over
    let checked = 0;
    for (const id of ids) {
      const c = mailbox.contacts.get(id);
      if (!c || id === 'self') continue;
      for (const m of mailbox.history(id, { limit: 1000 })) {
        expect(mailbox.contacts.mine(m.myAddress), `${m.id} under ${id}`).toBe(c.myAddress);
        checked++;
      }
    }
    expect(checked).toBe(raw.length - 2 - 1 - ORPHANS[at(P.kim, W)]!.messages.length); // (all but my own two and the ones of the two removed contacts, gus and kim)
    // what was to process still is — per contact, the re-pointed one under its new contact
    const todo = raw.filter((r) => (r['direction'] === 'in' || r['direction'] === 'internal') && r['to_device'] === null && r['processed_at'] === null).map((r) => r['id']);
    expect(mailbox.todo().map((m) => m.id).sort()).toEqual([...todo].sort());
    expect(mailbox.unread()).toMatchObject({ [at(P.tess, F)]: 1, [a(P.wendy)]: 1, 'c:bob': 1, self: 1, [at(P.kim, W)]: 2 }); // (kim's two messages to `work` were never read: under her pairing's id)
    expect(mailbox.unread()[a(P.tess)]).toBeUndefined();
    expect(mailbox.hasSeen(D.bob.id, 'seen-1')).toBe(true);

    // the outbox: the same three rows are due, oldest first, each from the address it was queued from
    const waiting = raw.filter((r) => r['direction'] === 'out' && (r['status'] === 'pending' || (r['status'] === 'failed' && r['waiting'] === 1)));
    expect(waiting.map((r) => [r['id'], r['my_address'], r['to_device']])).toEqual([
      [M['toAbe'], '', P.abe],
      [M['toLou'], L, P.lou],
      [M['waitingBob'], '', 'bob'],
    ]);
    const claimed = [];
    for (let m = mailbox.claimNextPending({ scope: 'outbound' }); m; m = mailbox.claimNextPending({ scope: 'outbound' })) claimed.push(m);
    expect(claimed.map((m) => m.id)).toEqual([M['toAbe'], M['toLou'], M['waitingBob']]);
    expect(claimed[0]).toMatchObject({ status: 'delivering', fromFirstAddress: true, to: { device: P.abe }, contactId: a(P.abe), waiting: true });
    expect(claimed[0]!.myAddress).toBeUndefined();
    expect(claimed[1]).toMatchObject({ status: 'delivering', myAddress: L, myAgent: 'lab', to: { device: P.lou }, contactId: a(P.lou) });
    expect(claimed[1]!.fromFirstAddress).toBeUndefined();
    expect(claimed[2]).toMatchObject({ status: 'delivering', fromFirstAddress: true, to: { device: 'bob' }, contactId: 'c:bob' });
    expect(mailbox.contacts.get(claimed[1]!.contactId!)!.myAddress).toBe(L); // sender and contact agree
    db.close();
  });

  it('is idempotent: a second open changes nothing, says nothing and takes no second backup', () => {
    const h = p3Home();
    const first = open(h);
    first.db.pragma('wal_checkpoint(TRUNCATE)');
    first.db.close();
    const after = { db: snapshot(h.dbPath), backups: backups(h.morseDir), files: readdirSync(join(h.morseDir, 'backups', STAMP)).sort() };
    const reports: MigrationReportV4[] = [];
    const again = open(h, reports);
    expect(reports).toHaveLength(0);
    again.db.pragma('wal_checkpoint(TRUNCATE)');
    again.db.close();
    expect({ db: snapshot(h.dbPath), backups: backups(h.morseDir), files: readdirSync(join(h.morseDir, 'backups', STAMP)).sort() }).toEqual(after);
    // running the migration function itself again is a no-op too — and takes no backup
    const raw = new Database(h.dbPath);
    expect(migrateToV4(raw, homeContactContext(h.home), { now: NOW + 60_000, backup: { morseDir: h.morseDir, dbPath: h.dbPath } })).toBeNull();
    raw.pragma('wal_checkpoint(TRUNCATE)');
    raw.close();
    expect(snapshot(h.dbPath)).toEqual(after.db);
    expect(backups(h.morseDir)).toEqual(after.backups);
    expect(besides(h.morseDir)).toEqual([]);
    expect(result(h)).toEqual(reference());
  });

  it('fails inside the transaction, at every stage: rolled back to the exact v3 database, its backup removed again; the next run finishes with the same result', () => {
    const stages: MigrationStageV4[] = ['backup', 'contacts', 'requests', 'messages'];
    for (const failAt of stages) {
      const h = p3Home();
      const before = snapshot(h.dbPath);
      const raw = new Database(h.dbPath);
      const reached: string[] = [];
      expect(() =>
        migrateToV4(raw, homeContactContext(h.home), {
          now: NOW,
          backup: { morseDir: h.morseDir, dbPath: h.dbPath },
          hook: (stage) => {
            reached.push(stage);
            if (stage === failAt) {
              // (the backup was taken before this point, and marked as not yet valid)
              expect(backups(h.morseDir), failAt).toEqual([STAMP]);
              expect(existsSync(join(h.morseDir, 'backups', STAMP, 'IN-PROGRESS')), failAt).toBe(true);
              throw new Error('interrupted (test)');
            }
          },
        }),
      ).toThrow(/interrupted/);
      expect(reached).toEqual(stages.slice(0, stages.indexOf(failAt) + 1));
      raw.pragma('wal_checkpoint(TRUNCATE)');
      raw.close();
      // exactly the v3 database again: old table shapes, old rows, version 3 — and no half-used backup left
      expect(snapshot(h.dbPath), failAt).toEqual(before);
      expect(before.version).toBe(3);
      expect(backups(h.morseDir), failAt).toEqual([]);
      expect(besides(h.morseDir), failAt).toEqual([]);
      // the next open runs it again from the start
      const reports: MigrationReportV4[] = [];
      const { db } = open(h, reports);
      expect(reports, failAt).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      expect(result(h), failAt).toEqual(reference());
      expect(backups(h.morseDir), failAt).toEqual([STAMP]);
    }
  });

  it('a real process killed (SIGKILL) inside the transaction: the database is the v3 one, the next open migrates, one backup remains', async () => {
    const h = p3Home();
    const before = snapshot(h.dbPath);
    const beforeTables = rowsOf(h.dbPath, P4_BACKUP_TABLES);
    const marker = join(h.home, 'in-transaction');
    // (it runs "a minute earlier": the backup directory it leaves behind is not the one the next run makes)
    const c = child('pause', h.home, h.morseDir, h.dbPath, String(NOW - 60_000), marker);
    await until(() => existsSync(marker));
    // it holds the write lock, has taken its backup, rebuilt both tables, written the blocks and re-pointed the messages — uncommitted
    expect(backups(h.morseDir)).toEqual(['contacts-per-address-20261112T075900Z']);
    expect(existsSync(join(h.morseDir, 'backups', backups(h.morseDir)[0]!, 'IN-PROGRESS'))).toBe(true);
    c.p.kill('SIGKILL');
    expect((await c.done).code).not.toBe(0);

    expect(snapshot(h.dbPath)).toEqual(before);
    const reports: MigrationReportV4[] = [];
    const { db, mailbox } = open(h, reports);
    expect(reports).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    // the dead run's half-used backup was cleared away: exactly one, complete, the one the database names
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(readdirSync(reports[0]!.backup!).sort()).toEqual(['MANIFEST.json', 'tables.sqlite']);
    expect(rowsOf(join(reports[0]!.backup!, 'tables.sqlite'), P4_BACKUP_TABLES)).toEqual(beforeTables);
    expect(mailbox.contacts.mark(P4_BACKUP_MARK)).toBe(reports[0]!.backup);
    expect(mailbox.contacts.byAddress(P.wendy, W)).toMatchObject({ id: a(P.wendy), remark: 'Wendy' });
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    expect(result(h)).toEqual(reference());
  }, 60_000);

  it('six processes open the mailbox at the same moment: one migrates and takes the one backup, the others wait and find it done', async () => {
    const h = p3Home();
    const results = await Promise.all(Array.from({ length: 6 }, () => child('open', h.home, h.morseDir, h.dbPath, String(NOW)).done));
    for (const r of results) expect(r.code, r.err).toBe(0);
    const told = results.map((r) => JSON.parse(r.out) as { migrated: boolean; backup: string | null; report: MigrationReportV4 | null });
    expect(told.filter((t) => t.migrated)).toHaveLength(1);
    expect(told.find((t) => t.migrated)!.report).toEqual({ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) });
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(readdirSync(join(h.morseDir, 'backups', STAMP)).sort()).toEqual(['MANIFEST.json', 'tables.sqlite']);
    expect(besides(h.morseDir)).toEqual([]);
    // the same database a single run makes
    expect(result(h)).toEqual(reference());
  }, 120_000);

  it('~/.morse/backups cannot be written: the tables go next to the database (0600) — still before anything changes', () => {
    const h = p3Home();
    const before = rowsOf(h.dbPath, P4_BACKUP_TABLES);
    writeFileSync(join(h.morseDir, 'backups'), 'not a directory');
    const reports: MigrationReportV4[] = [];
    const { db, mailbox } = open(h, reports);
    const target = `${h.dbPath}${BAK}`;
    expect(reports).toEqual([{ ...REPORT, backup: target }]);
    expect(mailbox.contacts.mark(P4_BACKUP_MARK)).toBe(target);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(rowsOf(target, P4_BACKUP_TABLES)).toEqual(before);
    expect(rowsOf(target, [P4_REPOINTED_TABLE])[P4_REPOINTED_TABLE]).toHaveLength(REPORT.repointed);
    expect(besides(h.morseDir)).toEqual([`mailbox.db${BAK}`]); // no .partial left
    expect(readFileSync(join(h.morseDir, 'backups'), 'utf8')).toBe('not a directory');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    // the migration itself is the same one
    const same = (s: ReturnType<typeof snapshot>) => ({ ...s, rows: { ...s.rows, migration_marks: s.rows['migration_marks']!.filter((r) => r['key'] !== P4_BACKUP_MARK) } });
    expect(same(result(h))).toEqual(same(reference()));
  });

  it('no backup can be written anywhere: one clear error, nothing changed, nothing left behind — and it works once there is room', () => {
    const h = p3Home();
    const before = snapshot(h.dbPath);
    writeFileSync(join(h.morseDir, 'backups'), 'not a directory');
    mkdirSync(`${h.dbPath}${BAK}.partial`); // the fallback's file cannot be created either
    writeFileSync(join(`${h.dbPath}${BAK}.partial`, 'x'), 'in the way');
    let error: unknown;
    try {
      open(h);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BackupErrorV4);
    expect((error as Error).message).toMatch(
      /^cannot back up your contacts before giving each of your addresses its own \(.+\) — free some disk space or make .*\.morse writable \(tried .*backups\/contacts-per-address-\d{8}T\d{6}Z and .*mailbox\.db\.v3-contacts\.bak\)\. Nothing was changed; the upgrade runs again the next time morse starts\.$/,
    );
    expect((error as Error).message.split('\n')).toHaveLength(1);
    expect(snapshot(h.dbPath)).toEqual(before);
    expect(before.version).toBe(3);
    expect(existsSync(`${h.dbPath}${BAK}`)).toBe(false);
    expect(readdirSync(`${h.dbPath}${BAK}.partial`)).toEqual(['x']); // (what was in the way is not ours to remove)
    // a second try fails the same way and still changes nothing
    expect(() => open(h)).toThrow(BackupErrorV4);
    expect(snapshot(h.dbPath)).toEqual(before);
    // the obstacle goes away: the next open migrates
    rmSync(join(h.morseDir, 'backups'));
    rmSync(`${h.dbPath}${BAK}.partial`, { recursive: true });
    const reports: MigrationReportV4[] = [];
    const { db } = open(h, reports);
    expect(reports).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(besides(h.morseDir)).toEqual([]);
    expect(result(h)).toEqual(reference());
  });

  it('a backup directory left IN-PROGRESS by an earlier run is cleared, never mistaken for the backup', () => {
    const h = p3Home();
    const raw = new Database(h.dbPath);
    const left = backupForV4(raw, { morseDir: h.morseDir, dbPath: h.dbPath }, [], NOW - 5000); // "killed" right after it
    raw.close();
    expect(left.path).toBe(join(h.morseDir, 'backups', 'contacts-per-address-20261112T075955Z'));
    expect(existsSync(join(left.path, 'IN-PROGRESS'))).toBe(true);
    const reports: MigrationReportV4[] = [];
    open(h, reports).db.close();
    expect(backups(h.morseDir)).toEqual([STAMP]);
    expect(reports[0]!.backup).toBe(join(h.morseDir, 'backups', STAMP));
  });

  it('a crash between the commit and the end of the backup bookkeeping is tidied on the next open', () => {
    const h = p3Home();
    const reports: MigrationReportV4[] = [];
    open(h, reports).db.close();
    writeFileSync(join(reports[0]!.backup!, 'IN-PROGRESS'), 'left by a crash');
    const again: MigrationReportV4[] = [];
    open(h, again).db.close();
    expect(again).toEqual([]);
    expect(readdirSync(reports[0]!.backup!).sort()).toEqual(['MANIFEST.json', 'tables.sqlite']);
    expect(backups(h.morseDir)).toEqual([STAMP]); // (finished, not cleared away as a dead run's)
    // the beside-the-database copy: still under its .partial name
    const g = p3Home();
    const before = rowsOf(g.dbPath, P4_BACKUP_TABLES);
    writeFileSync(join(g.morseDir, 'backups'), 'not a directory');
    open(g).db.close();
    const target = `${g.dbPath}${BAK}`;
    renameSync(target, `${target}.partial`);
    chmodSync(`${target}.partial`, 0o644);
    open(g).db.close();
    expect(existsSync(target)).toBe(true);
    expect(existsSync(`${target}.partial`)).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(rowsOf(target, P4_BACKUP_TABLES)).toEqual(before);
  });

  it('a fresh install has nothing to back up and starts at v4', () => {
    const h = p3Home();
    for (const f of readdirSync(h.morseDir)) if (f.startsWith('mailbox.db')) rmSync(join(h.morseDir, f));
    const reports: MigrationReportV4[] = [];
    const { db, mailbox } = open(h, reports);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    expect(backups(h.morseDir)).toEqual([]);
    expect(besides(h.morseDir)).toEqual([]);
    for (const r of reports) expect(r.backup).toBeNull();
    expect(mailbox.contacts.mark(P4_BACKUP_MARK)).toBeNull();
    const s = snapshot(h.dbPath);
    expect(String(s.schema.find((r) => r['name'] === 'contacts')!['sql'])).toContain('my_address');
    expect(String(s.schema.find((r) => r['name'] === 'morse_requests')!['sql'])).toContain('PRIMARY KEY (my_address, handle)');
    expect(s.rows['address_blocks']).toEqual([]);
    // own computers are known from the trust list even on an empty mailbox — the first address's
    expect(mailbox.contacts.byAddress(D.myAir.address)).toMatchObject({ group: 'self', origin: 'own-device', myAddress: '' });
    expect(mailbox.contacts.firstAddress()).toBe(F);
    db.close();
    // a second open: nothing to do
    const again: MigrationReportV4[] = [];
    open(h, again).db.close();
    expect(again).toEqual([]);
  });

  it('cannot tell which address is the first (the device key cannot be read) while addresses of mine are recorded: refuses, changes nothing — and migrates once it can', () => {
    const h = p3Home();
    const before = snapshot(h.dbPath);
    const { firstAddress: _unknown, ...blind } = homeContactContext(h.home);
    for (const ctx of [blind, { ...blind, firstAddress: () => null }]) {
      let error: unknown;
      try {
        open(h, [], ctx);
      } catch (e) {
        error = e;
      }
      expect((error as Error | undefined)?.message).toBe(
        "cannot tell which of your addresses here is the first one (its key could not be read) — your contacts were not changed; the upgrade runs again the next time morse starts",
      );
      expect(error).toBeInstanceOf(MigrationRefusedV4);
      expect(error).not.toBeInstanceOf(BackupErrorV4);
      expect(snapshot(h.dbPath)).toEqual(before);
      expect(backups(h.morseDir)).toEqual([]);
      expect(besides(h.morseDir)).toEqual([]);
    }
    const reports: MigrationReportV4[] = [];
    const { db } = open(h, reports);
    expect(reports).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    expect(result(h)).toEqual(reference());
  });
});

/**
 * The statements the release before (af4ca40) runs — copied verbatim from its src/mailbox/db.ts,
 * src/mailbox/contacts.ts, src/mailbox/requests.ts and src/mailbox/mailbox.ts. It knows nothing of
 * `my_address`, `address_blocks` or user_version 4.
 */
const P3 = {
  // src/mailbox/db.ts: SCHEMA, run on every open
  schema: `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  pair_key TEXT NOT NULL UNIQUE,
  a_agent TEXT NOT NULL,
  a_session TEXT NOT NULL,
  a_device TEXT,
  b_agent TEXT NOT NULL,
  b_session TEXT NOT NULL,
  b_device TEXT,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  context_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_device TEXT,
  to_agent TEXT NOT NULL,
  to_session TEXT NOT NULL,
  to_device TEXT,
  parts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_context ON messages(context_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_session, status);
CREATE TABLE IF NOT EXISTS inbound_seen (
  from_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, msg_id)
);
-- Morse message requests (ADR-037): the first message of a person who is not paired
-- here waits in this table — never in messages, so no inbox, pull or agent sees it —
-- until the operator accepts (moved into messages) or declines (deleted + blocked).
-- One row per person (handle); later messages only bump count / last_at.
CREATE TABLE IF NOT EXISTS morse_requests (
  handle TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT,
  nickname TEXT,
  msg_id TEXT NOT NULL,
  context_id TEXT,
  from_agent TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_morse_agent TEXT,
  to_agent TEXT NOT NULL,
  to_session TEXT NOT NULL,
  text TEXT NOT NULL,
  dropped_files INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions_cache (
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  last_active_at INTEGER NOT NULL,
  PRIMARY KEY (agent, session_id)
);
`,
  // src/mailbox/db.ts: MIGRATIONS (each in a try / catch: "column already exists — idempotent by design"),
  // MY_ADDRESS_COLUMN and KNOWN_AS_COLUMN (each only when the column is missing)
  additive: [
    `ALTER TABLE conversations ADD COLUMN a_device TEXT`,
    `ALTER TABLE conversations ADD COLUMN b_device TEXT`,
    `ALTER TABLE messages ADD COLUMN from_device TEXT`,
    `ALTER TABLE messages ADD COLUMN to_device TEXT`,
    `ALTER TABLE messages ADD COLUMN delivered_in_session INTEGER`,
    `ALTER TABLE messages ADD COLUMN from_tier TEXT`,
    `ALTER TABLE messages ADD COLUMN receipt_at INTEGER`,
    `ALTER TABLE messages ADD COLUMN waiting INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN request INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE morse_requests ADD COLUMN dropped_file_list TEXT`,
    `ALTER TABLE messages ADD COLUMN own_thread INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE morse_requests ADD COLUMN to_address TEXT`,
  ],
  myAddressColumn: `ALTER TABLE messages ADD COLUMN my_address TEXT`,
  knownAsColumn: `ALTER TABLE contacts ADD COLUMN known_as TEXT`,
  // src/mailbox/contacts.ts: SCHEMA_V2 (CONTACTS_TABLE + CONTACT_INDEXES + …), SCHEMA_ADDRESSES, INDEXES_V2
  schemaV2: `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_remark ON contacts(lower(remark)) WHERE remark IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_handle_agent ON contacts(handle, COALESCE(agent, '')) WHERE handle IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_address ON contacts(address) WHERE address IS NOT NULL;

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
`,
  schemaAddresses: `
CREATE TABLE IF NOT EXISTS contact_addresses (
  address TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  device_id TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_addresses ON contact_addresses(contact_id, last_seen);
`,
  indexesV2: `
CREATE INDEX IF NOT EXISTS idx_msg_contact ON messages(contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_todo ON messages(created_at) WHERE direction != 'out' AND processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_msg_direction ON messages(direction);
`,
  // src/mailbox/contacts.ts — createContactStore
  agentsOf: 'SELECT agent FROM contact_agents WHERE contact_id = ? ORDER BY last_seen_at DESC',
  addressesOf: 'SELECT address FROM contact_addresses WHERE contact_id = ? ORDER BY last_seen DESC',
  getRow: 'SELECT * FROM contacts WHERE id = ?',
  rowFor: `SELECT * FROM contacts WHERE handle = ? AND COALESCE(agent, '') = ?`,
  rowByAddress: 'SELECT * FROM contacts WHERE address = ?',
  list: `SELECT * FROM contacts ORDER BY id = 'self' DESC, lower(COALESCE(remark, handle, address)) ASC, id ASC`,
  seenUnder: 'SELECT contact_id FROM contact_addresses WHERE address = ?',
  // …ensure (a contact by old handle)
  ensureInsert: `INSERT INTO contacts (id, handle, remark, nickname, group_label, state, split, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  // …ensureAddress (a contact with only an address)
  ensureAddressInsert: `INSERT INTO contacts (id, handle, agent, address, remark, group_label, state, split, origin, created_at, updated_at)
           VALUES (?, NULL, NULL, ?, NULL, ?, ?, 'done', NULL, ?, ?)`,
  ensureAddressSeen: `INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(address) DO UPDATE SET contact_id = excluded.contact_id`,
  dropMark: 'DELETE FROM migration_marks WHERE key = ?',
  // …set
  setRemark: 'UPDATE contacts SET remark = ?, updated_at = ? WHERE id = ?',
  setState: 'UPDATE contacts SET state = ?, updated_at = ? WHERE id = ?',
  // …remove (the tombstone, then the rows)
  putMark: 'INSERT INTO migration_marks (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  removeAgents: 'DELETE FROM contact_agents WHERE contact_id = ?',
  removeAddresses: 'DELETE FROM contact_addresses WHERE contact_id = ?',
  removeContact: 'DELETE FROM contacts WHERE id = ?',
  // …applySplit (the relay named the address of a handle's default agent)
  applySplitAddress: 'UPDATE contacts SET address = ?, updated_at = ? WHERE id = ?',
  applySplitAttach: `INSERT INTO contact_addresses (address, contact_id, device_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(address) DO UPDATE SET contact_id = excluded.contact_id, device_id = COALESCE(excluded.device_id, device_id)`,
  applySplitDone: `UPDATE contacts SET split = 'done', updated_at = ? WHERE id = ?`,
  // …knownAs
  knownAsRead: 'SELECT known_as AS k FROM contacts WHERE id = ?',
  knownAsFirstMail: `SELECT my_address AS a FROM messages WHERE contact_id = ? AND direction IN ('in', 'out') ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  knownAsWrite: 'UPDATE contacts SET known_as = ? WHERE id = ? AND known_as IS NULL',
  // src/mailbox/requests.ts — createRequestStore
  requestGet: 'SELECT * FROM morse_requests WHERE handle = ?',
  requestCount: 'SELECT COUNT(*) AS n FROM morse_requests',
  requestList: 'SELECT * FROM morse_requests ORDER BY last_at DESC, rowid DESC',
  requestInsert: `INSERT INTO morse_requests (handle, device_id, device_name, nickname, msg_id, context_id, from_agent, from_session, from_morse_agent, to_agent, to_session, text, dropped_files, dropped_file_list, to_address, via, count, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  requestBump: 'UPDATE morse_requests SET count = count + 1, last_at = ? WHERE handle = ?',
  requestRemove: 'DELETE FROM morse_requests WHERE handle = ?',
  // src/mailbox/mailbox.ts — insertMessage, firstSeen
  conversationInsert: `INSERT INTO conversations (id, pair_key, a_agent, a_session, a_device, b_agent, b_session, b_device, created_at, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  messageInsert: `INSERT INTO messages (id, conversation_id, context_id, from_agent, from_session, from_device, to_agent, to_session, to_device, parts, status, attempts, from_tier, direction, contact_id, agent, my_address, peer_agent, own_thread, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  firstSeen: 'INSERT OR IGNORE INTO inbound_seen (from_id, msg_id, seen_at) VALUES (?, ?, ?)',
  // src/mailbox/migrate-v2.ts — backfillRows, run on every open of a database that is not being migrated
  backfill: `SELECT id, from_agent, from_device, to_agent, to_session, to_device, from_tier, status, created_at, updated_at FROM messages WHERE direction IS NULL`,
} as const;

describe('contacts per address of mine: a morse of the release before still running afterwards (ADR-083 item 13)', () => {
  /** What that release's `createDb` + `createMailbox` do to a database that is already at a later version. */
  const openAsP3 = (path: string) => {
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    old.pragma('foreign_keys = ON');
    old.pragma('busy_timeout = 5000');
    old.exec(P3.schema);
    const refused: string[] = [];
    for (const migration of P3.additive) {
      try {
        old.exec(migration);
      } catch (e) {
        refused.push((e as Error).message);
      }
    }
    const version = Number(old.pragma('user_version', { simple: true }));
    const hasColumn = (table: string, column: string) => (old.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
    return { old, refused, version, hasColumn };
  };
  /** That release's `ensureAddress`, statement for statement. */
  const p3EnsureAddress = (old: Database.Database, peer: string, t: number): string => {
    const own = old.prepare(P3.rowByAddress).get(peer) as { id: string } | undefined;
    if (own) return own.id;
    const seen = old.prepare(P3.seenUnder).get(peer) as { contact_id: string } | undefined;
    if (seen && seen.contact_id !== 'self' && old.prepare(P3.getRow).get(seen.contact_id)) return seen.contact_id;
    const id = `a:${peer}`;
    old.prepare(P3.ensureAddressInsert).run(id, peer, 'other', 'active', t, t);
    old.prepare(P3.ensureAddressSeen).run(peer, id, t, t);
    old.prepare(P3.dropMark).run(`removed:${peer}`);
    return id;
  };
  /** That release's `requests.file` for a first message (no row yet). */
  const p3FileRequest = (old: Database.Database, r: { handle: string; deviceId: string; msgId: string; toAgent: string; toAddress: string | null; text: string }, t: number) => {
    expect(old.prepare(P3.requestGet).get(r.handle)).toBeUndefined();
    old.prepare(P3.requestInsert).run(r.handle, r.deviceId, null, null, r.msgId, null, 'claude', '', null, r.toAgent, 'inbox', r.text, 0, null, r.toAddress, 'morse-relay', t, t);
  };
  /** That release filing a message that came by address (acceptRequest → mailbox.send → knownAs). */
  const p3FileNative = (old: Database.Database, m: { id: string; from: string; contactId: string; toAgent: string; myAddress: string; text: string }, t: number) => {
    old.prepare(P3.conversationInsert).run(`conv-${m.id}`, `pair-${m.id}`, 'claude', '', m.from, m.toAgent, 'inbox', null, t, t);
    old.prepare(P3.messageInsert).run(m.id, `conv-${m.id}`, m.id, 'claude', '', m.from, m.toAgent, 'inbox', null, JSON.stringify([{ type: 'text', text: m.text, via: 'morse-relay' }]), 'peer', 'in', m.contactId, m.toAgent, m.myAddress, null, 0, t, t);
    // (the first mail with a contact settles which of my addresses it knows me by)
    const known = (old.prepare(P3.knownAsRead).get(m.contactId) as { k: string | null }).k;
    if (known === null) {
      const first = old.prepare(P3.knownAsFirstMail).get(m.contactId) as { a: string | null };
      old.prepare(P3.knownAsWrite).run(first.a ?? '', m.contactId);
    }
  };

  it('its open sequence runs and changes nothing: every CREATE … IF NOT EXISTS is a no-op, every ALTER is refused as a duplicate, it never migrates back', () => {
    const h = p3Home();
    const first = open(h);
    first.db.pragma('wal_checkpoint(TRUNCATE)');
    first.db.close();
    const before = snapshot(h.dbPath);
    const { old, refused, version, hasColumn } = openAsP3(h.dbPath);
    // (it only asks "< 2" and "< 3": a later version is nothing it acts on)
    expect(version).toBe(4);
    expect(refused).toHaveLength(P3.additive.length);
    for (const r of refused) expect(r).toMatch(/duplicate column name/);
    // the two columns it adds when they are missing are there: it does not try
    expect(hasColumn('messages', 'my_address')).toBe(true);
    expect(hasColumn('contacts', 'known_as')).toBe(true);
    expect(() => old.exec(P3.myAddressColumn)).toThrow(/duplicate column name/);
    expect(() => old.exec(P3.knownAsColumn)).toThrow(/duplicate column name/);
    // the schema its migrations would create (never run at this version — and harmless if they were)
    old.exec(P3.schemaV2);
    old.exec(P3.schemaAddresses);
    old.exec(P3.indexesV2);
    expect(old.prepare(P3.backfill).all()).toEqual([]);
    expect(old.prepare(`SELECT value FROM migration_marks WHERE key = 'p3.my_address'`).get()).toBeTruthy();
    // what it reads: every contact, each with its agents and addresses; the requests
    const listed = old.prepare(P3.list).all() as Array<{ id: string }>;
    expect(listed).toHaveLength(REPORT.contacts);
    for (const c of listed) {
      old.prepare(P3.agentsOf).all(c.id);
      old.prepare(P3.addressesOf).all(c.id);
      expect((old.prepare(P3.getRow).get(c.id) as { id: string }).id).toBe(c.id);
    }
    expect((old.prepare(P3.rowFor).get('bob', '') as { id: string }).id).toBe('c:bob');
    expect((old.prepare(P3.rowByAddress).get(P.wendy) as { id: string }).id).toBe(a(P.wendy));
    expect((old.prepare(P3.requestCount).get() as { n: number }).n).toBe(4);
    expect((old.prepare(P3.requestList).all() as unknown[]).length).toBe(4);
    expect((old.prepare(P3.requestGet).get(P.rita) as { to_address: string }).to_address).toBe(W);
    expect((old.prepare(P3.knownAsRead).get(a(P.lou)) as { k: string }).k).toBe(L); // what it sends from by default: still `lab`
    old.pragma('wal_checkpoint(TRUNCATE)');
    old.close();
    // nothing changed: the uniqueness per address of mine, the request key, the blocks, the version
    expect(snapshot(h.dbPath)).toEqual(before);
  });

  it('what it writes without `my_address` is the first address\'s — a contact, a request, a block mark, a tombstone', () => {
    const h = p3Home();
    const { db, mailbox } = open(h);
    const { contacts, requests } = mailbox;
    const { old } = openAsP3(h.dbPath);
    const t = NOW + 1000;
    const [pia, quinn] = [stranger(), stranger()];
    // `morse contact add <address>` there
    expect(p3EnsureAddress(old, pia, t)).toBe(a(pia));
    old.prepare(P3.setRemark).run('Pia', t, a(pia));
    expect(contacts.byAddress(pia)).toMatchObject({ id: a(pia), myAddress: '', remark: 'Pia', group: 'other', state: 'active', split: 'done' });
    for (const my of [W, L]) expect(contacts.byAddress(pia, my)).toBeNull();
    expect(contacts.knownAs(a(pia))).toBe('');
    // a contact by old handle there
    expect(old.prepare(P3.rowFor).get('zed', '')).toBeUndefined();
    old.prepare(P3.ensureInsert).run('c:zed', 'zed', null, null, 'other', 'active', t, t);
    expect(contacts.find('zed')).toMatchObject({ id: 'c:zed', myAddress: '', handle: 'zed', split: 'pending' });
    // a request the old way, and one by address written to my first address
    p3FileRequest(old, { handle: 'zoe', deviceId: D.carol.id, msgId: 'old-1', toAgent: 'mini', toAddress: null, text: 'zoe, the old way' }, t);
    p3FileRequest(old, { handle: quinn, deviceId: quinn, msgId: 'old-2', toAgent: 'mini', toAddress: F, text: 'quinn, to your first address' }, t);
    expect(requests.get('zoe')).toMatchObject({ myAddress: '', text: 'zoe, the old way' });
    expect(requests.get(quinn)).toMatchObject({ myAddress: '', toAddress: F });
    expect(requests.count('')).toBe(4);
    expect([requests.count(W), requests.count(L)]).toEqual([1, 1]);
    // one more message from someone whose request waits: it finds the row and counts
    expect(old.prepare(P3.requestGet).get(quinn)).toBeTruthy();
    old.prepare(P3.requestBump).run(t + 1, quinn);
    expect(requests.get(quinn)).toMatchObject({ count: 2, lastAt: t + 1 });
    // `morse contact block` there writes the state on the row (and morse-blocked.json — not a row)
    old.prepare(P3.setState).run('blocked', t, a(pia));
    expect(contacts.byAddress(pia)!.state).toBe('blocked');
    old.prepare(P3.setState).run('active', t, a(pia));
    // `morse contact remove` there: the tombstone is the first address's key, as it always was
    const nina = old.prepare(P3.getRow).get(a(P.nina)) as { id: string; address: string; handle: null; agent: null; origin: null };
    old.prepare(P3.putMark).run(`removed:${nina.address}`, JSON.stringify({ id: nina.id, handle: nina.handle, agent: nina.agent, origin: nina.origin, devices: [] }), t);
    old.prepare(P3.removeAgents).run(nina.id);
    old.prepare(P3.removeAddresses).run(nina.id);
    expect(old.prepare(P3.removeContact).run(nina.id).changes).toBe(1);
    expect(contacts.byAddress(P.nina)).toBeNull();
    expect(contacts.mark(`removed:${P.nina}`)).toContain(a(P.nina));
    expect(contacts.mark(`removed:${W}:${P.nina}`)).toBeNull();
    // …a contact of another address of mine does not clear it; the first address's own does
    contacts.ensureAddress(P.nina, W);
    expect(contacts.mark(`removed:${P.nina}`)).toContain(a(P.nina));
    expect(contacts.ensureAddress(P.nina)).toMatchObject({ id: a(P.nina), myAddress: '' });
    expect(contacts.mark(`removed:${P.nina}`)).toBeNull();
    old.close();
    db.close();

    // the next open of this release leaves all of it with the first address
    const reports: MigrationReportV4[] = [];
    const next = open(h, reports);
    expect(reports).toEqual([]);
    expect(next.mailbox.contacts.byAddress(pia)).toMatchObject({ id: a(pia), myAddress: '', remark: 'Pia' });
    expect(next.mailbox.contacts.find('zed')).toMatchObject({ id: 'c:zed', myAddress: '' });
    expect(next.mailbox.requests.get('zoe')).toMatchObject({ myAddress: '' });
    expect(next.mailbox.requests.get(quinn)).toMatchObject({ myAddress: '', toAddress: F });
    expect(next.mailbox.requests.find(quinn)).toHaveLength(1);
    expect(backups(h.morseDir)).toEqual([STAMP]);
    next.db.close();
  });

  it('a request it filed for mail written to `work`, and a contact it made of someone who wrote to `work`, are handed to `work` by the next open — neither is then anything at my first address', () => {
    const h = p3Home();
    const { db, mailbox } = open(h);
    const { old } = openAsP3(h.dbPath);
    const t = NOW + 1000;
    const [oscar, olga, ofelia] = [stranger(), stranger(), stranger()];
    // oscar writes to `work`: a message request, filed by the old daemon
    p3FileRequest(old, { handle: oscar, deviceId: oscar, msgId: 'w-1', toAgent: 'work', toAddress: W, text: 'oscar, to work' }, t);
    // olga writes to `work` and is accepted there (`morse contact accept`): contact, message, dedupe mark, request gone
    p3FileRequest(old, { handle: olga, deviceId: olga, msgId: 'w-2', toAgent: 'work', toAddress: W, text: 'olga, to work' }, t);
    const olgaId = p3EnsureAddress(old, olga, t + 1);
    expect(olgaId).toBe(a(olga));
    p3FileNative(old, { id: 'old-olga-1', from: olga, contactId: olgaId, toAgent: 'work', myAddress: W, text: 'olga, to work' }, t + 1);
    old.prepare(P3.firstSeen).run(olga, 'w-2', t + 1);
    old.prepare(P3.requestRemove).run(olga);
    old.prepare(P3.setRemark).run('Olga', t + 2, olgaId);
    expect((old.prepare(P3.knownAsRead).get(olgaId) as { k: string }).k).toBe(W);
    // ofelia: the old process wrote to her first, from `lab` (`morse send <address> --from lab`)
    const ofeliaId = p3EnsureAddress(old, ofelia, t + 3);
    old.prepare(P3.conversationInsert).run('conv-ofelia', 'pair-ofelia', 'user', 'cli', null, 'user', '', ofelia, t + 3, t + 3);
    old.prepare(P3.messageInsert).run('old-ofelia-1', 'conv-ofelia', 'old-ofelia-1', 'user', 'cli', null, 'user', '', ofelia, JSON.stringify([{ type: 'text', text: 'ofelia, this is lab', via: 'cli' }]), null, 'out', ofeliaId, 'lab', L, null, 0, t + 3, t + 3);
    old.prepare(P3.knownAsWrite).run((old.prepare(P3.knownAsFirstMail).get(ofeliaId) as { a: string }).a, ofeliaId);
    old.pragma('wal_checkpoint(TRUNCATE)');
    old.close();
    // until this release opens the database again, such a row says nothing of its own: the first address's
    expect(mailbox.requests.get(oscar)).toMatchObject({ myAddress: '', toAddress: W });
    expect(mailbox.contacts.byAddress(olga)).toMatchObject({ id: olgaId, myAddress: '' });
    db.close();

    const reports: MigrationReportV4[] = [];
    const next = open(h, reports);
    const { contacts, requests } = next.mailbox;
    expect(reports).toEqual([]); // (not a migration: no report, no second backup)
    expect(backups(h.morseDir)).toEqual([STAMP]);
    // oscar's request waits at `work`, with everything it said — and my first address has none from him
    expect(requests.get(oscar)).toBeUndefined();
    expect(requests.get(oscar, W)).toMatchObject({ myAddress: W, toAddress: W, text: 'oscar, to work', msgId: 'w-1', to: { agent: 'work', sessionId: 'inbox' } });
    expect(requests.find(oscar).map((r) => r.myAddress)).toEqual([W]);
    expect([requests.count(''), requests.count(W), requests.count(L)]).toEqual([2, 2, 1]);
    // olga is a contact of `work` — her id, remark and message kept — and a stranger to my first address
    expect(contacts.byAddress(olga)).toBeNull();
    expect(contacts.byAddress(olga, L)).toBeNull();
    expect(contacts.byAddress(olga, W)).toMatchObject({ id: olgaId, myAddress: W, remark: 'Olga', group: 'other', state: 'active' });
    expect(contacts.findAll(olga).map((c) => c.myAddress)).toEqual([W]);
    expect(contacts.find('Olga')).toMatchObject({ id: olgaId, myAddress: W });
    expect(next.mailbox.history(olgaId).map((m) => [m.id, m.myAddress, m.parts[0]!.text])).toEqual([['old-olga-1', W, 'olga, to work']]);
    expect(requests.find(olga)).toEqual([]);
    expect([contacts.isBlockedAt(olga), contacts.isBlockedAt(olga, W)]).toEqual([false, false]);
    // …the addresses seen under a contact are the first address's business: hers is no longer listed there
    expect(rowsOf(h.dbPath, ['contact_addresses'])['contact_addresses']!.some((r) => r['address'] === olga)).toBe(false);
    // ofelia is a contact of `lab`
    expect(contacts.byAddress(ofelia)).toBeNull();
    expect(contacts.byAddress(ofelia, L)).toMatchObject({ id: ofeliaId, myAddress: L });
    expect(next.mailbox.getMessage('old-ofelia-1')).toMatchObject({ direction: 'out', myAddress: L, myAgent: 'lab', contactId: ofeliaId, status: 'pending' });
    // nothing else moved: the rows of the migration are as they were
    expect(contacts.byAddress(P.ann)).toMatchObject({ id: a(P.ann), myAddress: '' });
    expect(contacts.byAddress(P.wendy, W)).toMatchObject({ id: a(P.wendy), myAddress: W });
    expect(contacts.get('c:erin')).toMatchObject({ myAddress: '' }); // (an old handle with `work` recorded stays the first address's)
    expect(contacts.ownDevice(D.studio.address)).toMatchObject({ myAddress: '' });
    // new mail from olga to my first address is a first contact there — a row of its own
    const fresh = next.mailbox.send({ from: { agent: 'claude', sessionId: '', device: olga }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'olga, to your first address', via: 'morse-relay', fromTier: 'peer', myAddress: F });
    expect(fresh.contactId).toBe(at(olga, F));
    expect(contacts.findAll(olga).map((c) => c.myAddress).sort()).toEqual(['', W].sort());
    // a third open has nothing left to hand over
    next.db.pragma('wal_checkpoint(TRUNCATE)');
    next.db.close();
    const settled = snapshot(h.dbPath);
    const third = open(h);
    third.db.pragma('wal_checkpoint(TRUNCATE)');
    third.db.close();
    expect(snapshot(h.dbPath)).toEqual(settled);
  });

  it('an ADDRESS it blocks afterwards (it only knows morse-blocked.json) is blocked at the first address by the next open — once: unblocking it here is not undone', () => {
    const h = p3Home();
    open(h).db.close();
    const file = join(h.morseDir, 'morse-blocked.json');
    const stranger = '23456789abcdefghjkmnpqrstv';
    const listed = (JSON.parse(readFileSync(file, 'utf8')) as { handles: string[] }).handles;
    // what the release before does for `morse contact block <address>`: the address goes into the file, nothing else
    writeFileSync(file, `${JSON.stringify({ handles: [...listed, stranger, P.nina] }, null, 2)}\n`);
    let { db, mailbox } = open(h);
    expect(mailbox.contacts.isBlockedAt(stranger)).toBe(true);
    expect(mailbox.contacts.isBlockedAt(stranger, W)).toBe(false); // the first address's business only
    expect(mailbox.contacts.isBlockedAt(P.nina)).toBe(true);
    expect(mailbox.contacts.byAddress(P.nina)).toMatchObject({ state: 'blocked' });
    // unblocked with this release: the file keeps the entry (nobody rewrites it), and it is not read again
    expect(mailbox.contacts.unblockAt(stranger)).toBe(true);
    db.close();
    ({ db, mailbox } = open(h));
    expect(mailbox.contacts.isBlockedAt(stranger)).toBe(false);
    expect(mailbox.contacts.isBlockedAt(P.nina)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain(stranger);
    db.close();
  });

  it('(the dedupe mark of mail the release before filed for `work` is the first address\'s key — what the migration leaves, stated)', () => {
    const h = p3Home();
    const { db, mailbox } = open(h);
    // the release before keyed every mail by address by the sender alone; this one by (sender, my address)
    expect(mailbox.hasSeen(seenKeyFor(P.ann, ''), `req-${P.ann.slice(0, 6)}`)).toBe(true);
    expect(seenKeyFor(P.wendy, '')).toBe(P.wendy);
    expect(seenKeyFor(P.wendy, W)).toBe(`${P.wendy}|${W}`);
    expect(rowsOf(h.dbPath, ['inbound_seen'])['inbound_seen']!.map((r) => r['from_id']).filter((id) => String(id).includes('|'))).toEqual([]);
    db.close();
  });

  // ---- (ADR-083 review) rows and files exactly as the release before writes them, BEFORE the upgrade -------------------

  /** src/cluster/blocklist.ts at af4ca40: `blockHandle` / `unblockHandle` rewrite the whole file as `{ handles }`. */
  const blockedFile = (h: Home) => {
    const path = join(h.morseDir, 'morse-blocked.json');
    const read = (): string[] => (JSON.parse(readFileSync(path, 'utf8')) as { handles: string[] }).handles;
    const write = (handles: string[]) => writeFileSync(path, `${JSON.stringify({ handles }, null, 2)}\n`, { mode: 0o600 });
    return { read, block: (x: string) => write([...read().filter((y) => y !== x), x]), unblock: (x: string) => write(read().filter((y) => y !== x)) };
  };

  it('(review R2) the daemon after the upgrade drops native mail from whoever was blocked before it at EVERY address of mine — a rejected request, a blocked contact, a blocked old handle — while a stranger gets a request at each', async () => {
    const h = p3Home();
    const [fay, eve, lee, sam] = [strangerKey(), strangerKey(), strangerKey(), strangerKey()];
    const v3 = new Database(h.dbPath);
    const t = NOW - 5000;
    const file = blockedFile(h);
    // fay: her request waited at `work` and was rejected (`declineRequest`: the request row deleted, `blockHandle(<address>)`):
    // all that is left of it is the entry in morse-blocked.json
    file.block(fay.address);
    // eve: a contact with only an address (of my first address), blocked (`morse contact block`: blockHandle + the row's state)
    v3.prepare(P3.ensureAddressInsert).run(a(eve.address), eve.address, 'other', 'active', t, t);
    v3.prepare(P3.ensureAddressSeen).run(eve.address, a(eve.address), t, t);
    v3.prepare(P3.setState).run('blocked', t, a(eve.address));
    file.block(eve.address);
    // lee: a contact by OLD HANDLE whose address the relay named (ensure + applySplit), blocked by that handle
    v3.prepare(P3.ensureInsert).run('c:leetwo', 'leetwo', null, null, 'other', 'active', t, t);
    v3.prepare(P3.applySplitAddress).run(lee.address, t, 'c:leetwo');
    v3.prepare(P3.applySplitAttach).run(lee.address, 'c:leetwo', null, t, t);
    v3.prepare(P3.applySplitDone).run(t, 'c:leetwo');
    v3.prepare(P3.setState).run('blocked', t, 'c:leetwo');
    file.block('leetwo');
    v3.pragma('wal_checkpoint(TRUNCATE)');
    v3.close();

    const { db, mailbox } = open(h);
    const relay = await startFakeRelay({ port: 0, host: '127.0.0.1', v3: true, allowlist: [{ id: fx.mine.device, handle: 'me' }], log: () => undefined });
    const logs: string[] = [];
    const morse = startMorse({ url: `ws://127.0.0.1:${relay.port}`, home: h.home, mailbox, receiptTimeoutMs: 500, connectWaitMs: 1000, strangers: () => 'request', log: (l) => logs.push(l) });
    try {
      await until(() => [F, W, L].every((mine) => relay.onlineAddresses().includes(mine)));
      const keys: Record<string, AddressKey> = Object.fromEntries(ensureAgentAddresses(h.home).map((m) => [m.key.address, m.key]));
      /** One message by address, signed by `from`, sealed to the current prekey of my address `to`, handed over as the relay does. */
      const write = async (from: AddressKey, to: string, id: string) => {
        const body = Buffer.from(JSON.stringify({ kind: 'message', id, contextId: id, from: { agent: 'claude', sessionId: '' }, to: { agent: 'user', sessionId: '' }, addr: 1, text: `hello, ${id}` }));
        const blob = JSON.stringify(await sealV3({ from, to, prekey: ensurePrekeys(keys[to]!).current, body }));
        await morse.receive({ id: `test-${id}`, from: from.address, blob, ts: Date.now(), to });
      };
      const mine = (to: string) => (to === F ? '' : to);
      for (const to of [F, W, L]) {
        for (const [name, key] of Object.entries({ fay, eve, lee, sam })) await write(key, to, `${name}-${to.slice(0, 6)}`);
      }
      // whoever was blocked before the upgrade: nothing is kept anywhere — no request, no message — and the log says why
      for (const blocked of [fay, eve, lee]) {
        for (const to of [F, W, L]) expect(mailbox.requests.get(blocked.address, mine(to)), `${blocked.address} at ${to}`).toBeUndefined();
        expect(mailbox.hasInboundFrom(blocked.address)).toBe(false);
        expect(logs.filter((l) => l === `relay: dropped message from morse.im/${blocked.address} — blocked here (to undo: morse contact unblock ${blocked.address})`)).toHaveLength(3);
      }
      // …while someone who was never blocked is a stranger at each address: one message request per address
      for (const to of [F, W, L]) expect(mailbox.requests.get(sam.address, mine(to))).toMatchObject({ handle: sam.address, toAddress: to, myAddress: mine(to) });
      expect(logs.filter((l) => l.includes(sam.address) && l.includes('blocked here'))).toEqual([]);
    } finally {
      morse.stop();
      await relay.close();
      db.close();
    }
  }, 30_000);

  it('(review R3) a removed contact by old handle whose mail went out from `work`: who it was with is told by the tombstone — re-pointed to the pairing (work, their address), no contact made', () => {
    const h = p3Home();
    const v3 = new Database(h.dbPath);
    // `morse contact remove erin` there (src/mailbox/contacts.ts `remove`): the tombstone, then the rows
    const erin = v3.prepare(P3.getRow).get('c:erin') as { id: string; handle: string; agent: null; address: string; origin: null };
    v3.prepare(P3.putMark).run(`removed:${erin.address}`, JSON.stringify({ id: erin.id, handle: erin.handle, agent: erin.agent, origin: erin.origin, devices: [] }), NOW - 1000);
    v3.prepare(P3.removeAgents).run(erin.id);
    v3.prepare(P3.removeAddresses).run(erin.id);
    expect(v3.prepare(P3.removeContact).run(erin.id).changes).toBe(1);
    v3.pragma('wal_checkpoint(TRUNCATE)');
    v3.close();
    const sent = M['toErinFromWork']!;
    const reports: MigrationReportV4[] = [];
    const { db, mailbox } = open(h, reports);
    // (the message names her old handle, not her address: `to_device` = erin)
    expect(mailbox.getMessage(sent)).toMatchObject({ to: { device: 'erin' }, myAddress: W, contactId: at(D.erin.address, W) });
    expect(mailbox.contacts.findAll(D.erin.address)).toEqual([]);
    expect(mailbox.contacts.find('erin')).toBeNull();
    // the same message was re-pointed before too (then to a contact MADE for the pair): one row and one contact less, nothing else
    expect(reports[0]).toMatchObject({ contacts: REPORT.contacts - 2, created: REPORT.created - 1, repointed: REPORT.repointed });
    const inBackup = new Database(join(reports[0]!.backup!, 'tables.sqlite'), { readonly: true });
    expect(inBackup.prepare(`SELECT contact_id FROM ${P4_REPOINTED_TABLE} WHERE id = ?`).get(sent)).toEqual({ contact_id: 'c:erin' });
    inBackup.close();
    // added again by her old handle — the first address's contact, same id as before: nothing of `work` shows under it
    expect(mailbox.contacts.ensure('erin').id).toBe('c:erin');
    expect(mailbox.history('c:erin')).toEqual([]);
    expect(mailbox.history(mailbox.contacts.ensureAddress(D.erin.address, W).id).map((m) => m.id)).toEqual([sent]);
    db.close();
  });

  it('(review R6) nothing recorded about which address a contact knows me by (`known_as` NULL, or no such column): the address of the OLDEST mail with it decides — as the release before would have recorded next', () => {
    const blank = (x: ReturnType<typeof snapshot>) => ({ ...x, rows: { ...x.rows, contacts: x.rows['contacts']!.map(({ known_as: _known, ...r }) => r) } });
    // (a) NULL — what `ALTER TABLE contacts ADD COLUMN known_as TEXT` (P3.knownAsColumn) leaves on every row that was
    // there before it, until that release looks at the contact again
    const h = p3Home();
    let v3 = new Database(h.dbPath);
    const forgotten = [a(P.wendy), a(P.tess), a(P.wanda), a(P.lou), a(P.ann), a(P.abe), a(P.bea), a(P.nina)];
    for (const id of forgotten) expect(v3.prepare('UPDATE contacts SET known_as = NULL WHERE id = ?').run(id).changes).toBe(1);
    // (what that release would write the next time: its own statements)
    const next = Object.fromEntries(forgotten.map((id) => [id, (v3.prepare(P3.knownAsFirstMail).get(id) as { a: string | null } | undefined)?.a]));
    expect(next).toEqual({ [a(P.wendy)]: W, [a(P.tess)]: W, [a(P.wanda)]: W, [a(P.lou)]: L, [a(P.ann)]: F, [a(P.abe)]: '', [a(P.bea)]: F, [a(P.nina)]: undefined });
    v3.pragma('wal_checkpoint(TRUNCATE)');
    v3.close();
    let reports: MigrationReportV4[] = [];
    let opened = open(h, reports);
    expect(reports).toEqual([{ ...REPORT, backup: join(h.morseDir, 'backups', STAMP) }]);
    for (const [id, my] of Object.entries(OWNERS)) expect(opened.mailbox.contacts.get(id)!.myAddress, id).toBe(my);
    // wendy only ever wrote to `work`: its contact — not the first address's, where her history would have followed her
    expect(opened.mailbox.contacts.byAddress(P.wendy)).toBeNull();
    expect(opened.mailbox.contacts.byAddress(P.wendy, W)).toMatchObject({ id: a(P.wendy), remark: 'Wendy' });
    opened.db.pragma('wal_checkpoint(TRUNCATE)');
    opened.db.close();
    // the same database as when it was recorded (but for the column nobody reads any more)
    expect(blank(result(h))).toEqual(blank(reference()));

    // (b) no such column at all: a database from before that release added it
    const g = p3Home();
    v3 = new Database(g.dbPath);
    v3.exec('ALTER TABLE contacts DROP COLUMN known_as');
    v3.pragma('wal_checkpoint(TRUNCATE)');
    v3.close();
    reports = [];
    opened = open(g, reports);
    expect(reports).toEqual([{ ...REPORT, backup: join(g.morseDir, 'backups', STAMP) }]);
    for (const [id, my] of Object.entries(OWNERS)) expect(opened.mailbox.contacts.get(id)!.myAddress, id).toBe(my);
    opened.db.pragma('wal_checkpoint(TRUNCATE)');
    opened.db.close();
    expect(blank(result(g))).toEqual(blank(reference()));
    for (const r of result(g).rows['contacts']!) if (r['my_address']) expect(r['known_as'], String(r['id'])).toBe(r['my_address']);
  });

  it('(review R7) an address it blocks afterwards is blocked at the address of mine the contact it marked belongs to — not also at my first; when it unblocks them, exactly that block is lifted', () => {
    const h = p3Home();
    open(h).db.close();
    const file = blockedFile(h);
    const { old } = openAsP3(h.dbPath);
    const t = NOW + 1000;
    /** `morse contact block <address>` there (src/commands/messaging.ts `blockAction` at af4ca40): the contact its lookup finds
     *  — `rowByAddress`, ONE row whatever address of mine it belongs to — blockHandle(<address>), requests.remove, the row's state. */
    const p3Block = (peer: string): string => {
      const row = old.prepare(P3.rowByAddress).get(peer) as { id: string; my_address: string };
      file.block(peer);
      old.prepare(P3.requestRemove).run(peer);
      old.prepare(P3.setState).run('blocked', t, row.id);
      return row.my_address;
    };
    /** `morse contact unblock <address>` there: unblockHandle(<address>), the row's state. */
    const p3Unblock = (peer: string) => {
      const row = old.prepare(P3.rowByAddress).get(peer) as { id: string };
      file.unblock(peer);
      old.prepare(P3.setState).run('active', t + 1, row.id);
    };
    // wendy is a contact of `work` only; tess of three of my addresses (that release's lookup finds one of them);
    // quinn is nobody's contact (a request it rejected: only the file entry is left)
    expect(p3Block(P.wendy)).toBe(W);
    const tessAt = p3Block(P.tess);
    const quinn = stranger();
    file.block(quinn);
    old.pragma('wal_checkpoint(TRUNCATE)');

    let { db, mailbox } = open(h);
    const blockedAt = (theirs: string) => EVERYWHERE.map((my) => mailbox.contacts.isBlockedAt(theirs, my));
    const others = (my: string) => EVERYWHERE.map((x) => x === my);
    expect(blockedAt(P.wendy)).toEqual([false, true, false]); // `work`, and only `work`
    expect(mailbox.contacts.byAddress(P.wendy, W)).toMatchObject({ state: 'blocked' });
    expect(blockedAt(P.tess)).toEqual(others(tessAt)); // the one contact it marked
    expect(mailbox.contacts.findAll(P.tess).filter((c) => c.state === 'blocked').map((c) => c.myAddress)).toEqual([tessAt]);
    expect(blockedAt(quinn)).toEqual([true, false, false]); // nobody's contact: the first address, whose business that file was
    const adopted = JSON.parse(mailbox.contacts.mark(P4_BLOCKS_ADOPTED_MARK)!) as Record<string, { my: string[]; at: number }>;
    expect(Object.fromEntries(Object.entries(adopted).map(([k, v]) => [k, v.my]))).toEqual({ [P.wendy]: [W], [P.tess]: [tessAt], [quinn]: [''] });
    // a block of THIS release at `lab` (lou), which that morse then "blocks" too: nothing is taken over — it is this release's
    mailbox.contacts.blockAt(P.lou, L);
    mailbox.contacts.set(a(P.lou), { state: 'blocked' });
    db.close();
    expect(p3Block(P.lou)).toBe(L);
    old.pragma('wal_checkpoint(TRUNCATE)');
    ({ db, mailbox } = open(h));
    expect(Object.keys(JSON.parse(mailbox.contacts.mark(P4_BLOCKS_ADOPTED_MARK)!) as object).sort()).toEqual([P.wendy, P.tess, quinn].sort());
    db.close();

    // it unblocks wendy, quinn and lou again, and "unblocks" bart, who was blocked before the upgrade
    p3Unblock(P.wendy);
    file.unblock(quinn);
    p3Unblock(P.lou);
    p3Unblock(P.bart);
    old.pragma('wal_checkpoint(TRUNCATE)');
    ({ db, mailbox } = open(h));
    // what was taken over from it is lifted — the block and the row's state
    expect(blockedAt(P.wendy)).toEqual([false, false, false]);
    expect(mailbox.contacts.byAddress(P.wendy, W)).toMatchObject({ state: 'active' });
    expect(blockedAt(quinn)).toEqual([false, false, false]);
    // …and nothing else: tess is still blocked where she was; lou's block is this release's; bart's is from before the
    // upgrade — kept at every address of mine, whatever the file says afterwards
    expect(blockedAt(P.tess)).toEqual(others(tessAt));
    expect(blockedAt(P.lou)).toEqual([false, false, true]);
    expect(mailbox.contacts.byAddress(P.lou, L)).toMatchObject({ state: 'blocked' });
    expect(blockedAt(P.bart)).toEqual([true, true, true]);
    expect(Object.keys(JSON.parse(mailbox.contacts.mark(P4_BLOCKS_ADOPTED_MARK)!) as object)).toEqual([P.tess]);
    // blocked there once more: taken over once more
    db.close();
    expect(p3Block(P.wendy)).toBe(W);
    old.pragma('wal_checkpoint(TRUNCATE)');
    old.close();
    ({ db, mailbox } = open(h));
    expect(blockedAt(P.wendy)).toEqual([false, true, false]);
    db.close();
  });
});

describe('contacts per address of mine through the real CLI (ADR-083)', () => {
  const NOTICE = /^morse: contacts and message requests are now kept per address of yours — (\d+) contact\(s\) belong to an address other than your first; people you had blocked stay blocked at all your addresses; nothing was deleted, backup: (.+)$/;

  it('`morse status`: the first command migrates and says so once, with the backup; the status line names it; a second command says nothing', async () => {
    const h = p3Home();
    const port = String(await freePort());
    const first = await cliAt(h.home, 'status', '--port', port);
    expect(first.code, first.err).toBe(0);
    // (ADR-091: the same command goes on to v5 — its own one line follows)
    const said = first.err.split('\n').filter(Boolean);
    expect(said).toHaveLength(2);
    expect(said[1]).toMatch(/^morse: old names are gone — every contact is reached by its address now/);
    const notice = NOTICE.exec(said[0]!);
    expect(notice, said[0]).not.toBeNull();
    // (ADR-091: the v5 step takes its own backup next to this one)
    const dirs = backups(h.morseDir).filter((d) => d.startsWith('contacts-per-address-'));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^contacts-per-address-\d{8}T\d{6}Z$/);
    const backup = join(h.morseDir, 'backups', dirs[0]!);
    expect(notice![2]).toBe(backup);
    expect(readdirSync(backup).sort()).toEqual(['MANIFEST.json', 'tables.sqlite']);
    expect(first.out.split('\n')).toContain(`contacts: kept per address of yours — each address has its own contacts, message requests and blocks; backup ${backup}`);
    expect(first.out).toMatch(/^daemon: not running$/m);
    expect(snapshot(h.dbPath).version).toBe(5);
    expect(JSON.parse(readFileSync(join(h.morseDir, 'morse-blocked.json'), 'utf8'))).toEqual({ handles: ['eve', 'mallory', 'lee', 'mel', P.bart, P.wanda, P.bea, P.zed, P.fay] });

    // the second command says nothing and takes no second backup — and still names the backup
    const again = await cliAt(h.home, 'status', '--port', port);
    expect(again.code, again.err).toBe(0);
    expect(again.err).toBe('');
    expect(again.out.split('\n')).toContain(`contacts: kept per address of yours — each address has its own contacts, message requests and blocks; backup ${backup}`);
    expect(backups(h.morseDir).filter((d) => d.startsWith('contacts-per-address-'))).toEqual(dirs);
    expect(besides(h.morseDir)).toEqual([]);
  }, 60_000);

  it('the number it says is the number of contacts that now belong to an address other than the first', async () => {
    const h = p3Home();
    const first = await cliAt(h.home, 'status', '--port', String(await freePort()));
    expect(first.code, first.err).toBe(0);
    const notice = NOTICE.exec(first.err.trim().split('\n')[0]!);
    expect(notice, first.err).not.toBeNull();
    const elsewhere = rowsOf(h.dbPath, ['contacts'])['contacts']!.filter((r) => r['my_address'] !== '');
    // (4 the release before had recorded for `work` / `lab`, 5 made for mail that ran over them — the row made
    // for tess AT the first address is not one of them)
    expect(elsewhere).toHaveLength(MOVED + Object.values(CREATED).filter((c) => c.my).length);
    expect(Number(notice![1])).toBe(elsewhere.length);
  }, 60_000);
});
