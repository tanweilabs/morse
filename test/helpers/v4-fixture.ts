import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadOrCreateIdentity } from '../../src/cluster/identity.js';
import { addressOfKey } from '../../src/identity/address.js';

/**
 * (ADR-091) test/fixtures/v4-home — a ~/.morse written by the release before v2 was removed (origin/main 1afe17e,
 * schema v4) — holds NO key, like test/fixtures/p3-home (see test/helpers/p3-fixture.ts, whose procedure this is,
 * for two addresses: `first` and `work`). `materialiseV4Home()` copies it into a temp home, generates a device
 * identity and a key for `work`, replaces the identifiers the committed files were written with by the ones
 * the new keys give (every text column of every table, the dead bytes of the database file, every other file)
 * and checks itself. Copy `morseDir` for every case; never open the database in it.
 */

const FIXTURE = fileURLToPath(new URL('../fixtures/v4-home', import.meta.url)).replace(/\/$/, '');

export interface V4Fixture {
  builtBy: string;
  userVersion: number;
  t0: number;
  lastAt: number;
  /** My two addresses and my device ID — in the committed file: the ones the builder's (discarded) keys gave. */
  mine: { first: string; work: string; device: string };
  peers: Record<'ann' | 'nina' | 'rob', string>;
  devices: Record<'myAir' | 'myWin' | 'studio' | 'bob' | 'aliceMini' | 'aliceAir' | 'erin' | 'carl' | 'lee' | 'carol' | 'gail', { id: string; address: string }>;
  contacts: Record<string, string>;
  messages: Record<string, string>;
}
type Identifier = keyof V4Fixture['mine'];
export interface Substitution {
  /** The identifier the committed fixture was written with. */
  old: string;
  /** The one the key generated for this run gives. */
  now: string;
  /** How many values of the database held it. */
  database: number;
  /** How many dead copies of it (in space no row uses any more) the database file held. */
  slack: number;
  /** How many times the other files held it. */
  files: number;
}
export interface MaterialisedV4 {
  /** The temp home the copy lives in (remove it when the test file is done). */
  home: string;
  /** Its `.morse`: schema v3, keys and all. Copy it for every case; never open its database. */
  morseDir: string;
  /** fixture.json as it reads for THIS run's keys. */
  fx: V4Fixture;
  /** fixture.json as committed. */
  committed: V4Fixture;
  substituted: Record<Identifier, Substitution>;
}

type Dump = { version: unknown; schema: unknown[]; rows: Record<string, unknown[]> };
const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const tablesOf = (db: Database.Database): string[] => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
const dumpOf = (db: Database.Database): Dump => ({
  version: db.pragma('user_version', { simple: true }),
  schema: db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all(),
  rows: Object.fromEntries(tablesOf(db).map((t) => [t, db.prepare(`SELECT rowid AS "(rowid)", * FROM ${q(t)} ORDER BY rowid`).all()])),
});
/** Every file under `dir`, as paths relative to it (`dirs`: the directories too, each ending in `/`). */
const walk = (dir: string, rel = '', dirs = false): string[] =>
  readdirSync(join(dir, rel))
    .sort()
    .flatMap((name) => (statSync(join(dir, rel, name)).isDirectory() ? [...(dirs ? [`${join(rel, name)}/`] : []), ...walk(dir, join(rel, name), dirs)] : [join(rel, name)]));
const count = (text: string, part: string): number => text.split(part).length - 1;

/** The files of the committed fixture that are key material (a .pem, or a PEM private-key block in any file) — there must be none. */
export const keyMaterialIn = (dir: string = FIXTURE): string[] =>
  walk(dir).filter((f) => /\.pem$/i.test(f) || readFileSync(join(dir, f)).toString('latin1').includes(['PRIVATE', 'KEY'].join(' ')));

let made: MaterialisedV4 | null = null;

export function materialiseV4Home(): MaterialisedV4 {
  if (made) return made;
  const committed = JSON.parse(readFileSync(join(FIXTURE, 'fixture.json'), 'utf8')) as V4Fixture;
  // (the whole directory is checked — the builder script and the README too)
  const keys = keyMaterialIn();
  if (keys.length) throw new Error(`test/fixtures/v4-home must not hold key material: ${keys.join(', ')}`);

  const home = mkdtempSync(join(tmpdir(), 'morse-v4-fixture-'));
  try {
    made = materialise(home, committed);
  } catch (e) {
    rmSync(home, { recursive: true, force: true }); // (no keys are left lying around when it fails)
    throw e;
  }
  return made;
}

function materialise(home: string, committed: V4Fixture): MaterialisedV4 {
  const morseDir = join(home, '.morse');
  cpSync(join(FIXTURE, 'morse'), morseDir, { recursive: true });
  chmodSync(morseDir, 0o700);
  const dbPath = join(morseDir, 'mailbox.db');

  // ---- the keys of this run ----
  const identity = loadOrCreateIdentity(home);
  const now: Record<Identifier, string> = { first: addressOfKey(createPrivateKey(identity.keyPem)), work: '', device: identity.id };
  mkdirSync(join(morseDir, 'addresses'), { recursive: true, mode: 0o700 });
  chmodSync(join(morseDir, 'addresses'), 0o700);
  for (const name of ['work'] as const) {
    const { privateKey } = generateKeyPairSync('ed25519');
    now[name] = addressOfKey(privateKey);
    const dir = join(morseDir, 'addresses', now[name]);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700); // (mkdir's mode is masked by umask)
    writeFileSync(join(dir, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  }
  const names = Object.keys(now) as Identifier[];
  const old = committed.mine;
  for (const n of names) if (typeof old[n] !== 'string' || !old[n]) throw new Error(`fixture.json does not say which ${n} the fixture was written with (mine.${n})`);
  if (new Set([...names.map((n) => old[n]), ...names.map((n) => now[n])]).size !== 2 * names.length) throw new Error('the generated identifiers are not distinct from the committed ones');
  /** `text` with every old identifier replaced, in one pass. */
  const swap = (text: string, from: Record<Identifier, string>, to: Record<Identifier, string>): string => text.replace(new RegExp(names.map((n) => from[n].replace(/[^A-Za-z0-9]/g, '\\$&')).join('|'), 'g'), (hit) => to[names.find((n) => from[n] === hit)!]);
  const substituted = Object.fromEntries(names.map((n) => [n, { old: old[n], now: now[n], database: 0, slack: 0, files: 0 }])) as Record<Identifier, Substitution>;

  // ---- the files that are text (everything but the database and the keys just made) ----
  const fresh = new Set([join('identity', 'key.pem'), join('identity', 'cert.pem'), join('addresses', now.work, 'key.pem')]);
  for (const f of walk(morseDir)) {
    if (f === 'mailbox.db' || fresh.has(f)) continue;
    const text = readFileSync(join(morseDir, f), 'utf8');
    for (const n of names) substituted[n].files += count(text, old[n]);
    const next = swap(text, old, now);
    if (next !== text) writeFileSync(join(morseDir, f), next);
  }

  // ---- the database: every text column of every table ----
  const db = new Database(dbPath);
  db.pragma('secure_delete = ON'); // what is overwritten leaves no copy in a free block of the file
  const before = dumpOf(db);
  const replaced = names.reduce((expr, n) => `replace(${expr}, @old_${n}, @now_${n})`, '%COLUMN%');
  const bind = Object.fromEntries(names.flatMap((n) => [[`old_${n}`, old[n]], [`now_${n}`, now[n]]]));
  db.transaction(() => {
    for (const table of tablesOf(db)) {
      for (const { name: column } of db.prepare(`PRAGMA table_info(${q(table)})`).all() as Array<{ name: string }>) {
        const c = q(column);
        for (const n of names) substituted[n].database += (db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)} WHERE typeof(${c}) = 'text' AND instr(${c}, ?) > 0`).get(old[n]) as { n: number }).n;
        db.prepare(`UPDATE ${q(table)} SET ${c} = ${replaced.replace('%COLUMN%', c)} WHERE typeof(${c}) = 'text' AND (${names.map((n) => `instr(${c}, @old_${n}) > 0`).join(' OR ')})`).run(bind);
      }
    }
  })();
  const after = dumpOf(db);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const fail = (why: string): never => {
    throw new Error(`test/helpers/v4-fixture.ts: ${why}`);
  };

  // ---- the database file: what no row uses any more ----
  // Every live value was replaced above, so an old identifier still in the file is a dead copy: a row the
  // released code rewrote (a message whose status changed …) left its earlier bytes in the page's free
  // space. Same length, overwritten where it stands — nothing SQLite reads moves.
  {
    const file = readFileSync(dbPath);
    for (const n of names) {
      if (old[n].length !== now[n].length) fail(`the new ${n} is not as long as the old one`);
      for (let at = file.indexOf(old[n], 0, 'latin1'); at >= 0; at = file.indexOf(old[n], at + 1, 'latin1')) {
        file.write(now[n], at, 'latin1');
        substituted[n].slack++;
      }
    }
    writeFileSync(dbPath, file);
  }
  // …and it is still the same database: sound, every row and the schema as after the SQL above
  const again = new Database(dbPath);
  const sound = again.pragma('integrity_check', { simple: true });
  const settled = dumpOf(again);
  again.pragma('wal_checkpoint(TRUNCATE)');
  again.close();

  // ---- the self-check ----
  if (sound !== 'ok') fail(`the database does not pass the integrity check after the substitution (${String(sound)})`);
  if (JSON.stringify(settled) !== JSON.stringify(after)) fail('overwriting the dead copies changed what the database says');
  for (const f of ['mailbox.db-wal', 'mailbox.db-shm']) if (existsSync(join(morseDir, f))) fail(`${f} is still there`);
  // (the device ID is also looked for without its dashes)
  const gone = [...names.map((n) => old[n]), old.device.replace(/-/g, '')];
  for (const f of walk(morseDir, '', true)) {
    const bytes = f.endsWith('/') ? '' : readFileSync(join(morseDir, f)).toString('latin1');
    for (const o of gone) if (f.includes(o) || bytes.includes(o)) fail(`${o} (an identifier of the keys the fixture was built with) is still in ${f}`);
  }
  for (const [table, rows] of Object.entries(after.rows)) {
    for (const row of rows as Array<Record<string, unknown>>) {
      for (const [column, value] of Object.entries(row)) {
        const text = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('latin1') : '';
        for (const o of gone) if (text.includes(o)) fail(`${o} is still in ${table}.${column}`);
      }
    }
  }
  // only identifiers changed: with the old ones put back it is the committed database, row for row
  const back = JSON.parse(swap(JSON.stringify(after), now, old)) as Dump;
  if (JSON.stringify(back) !== JSON.stringify(before)) fail('the substitution changed more than the identifiers');
  if (after.version !== committed.userVersion) fail(`the database is at user_version ${String(after.version)}, not ${committed.userVersion}`);

  const fx = JSON.parse(swap(JSON.stringify(committed), old, now)) as V4Fixture;
  for (const n of names) if (fx.mine[n] !== now[n]) fail(`fixture.json does not name the new ${n}`);
  return { home, morseDir, fx, committed, substituted };
}
