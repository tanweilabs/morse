import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { hasOtherAddressKeys } from '../src/identity/address-key.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { cliAt, freePort, removeHomes, type Ran } from './helpers/personas-home.js';
import { materialiseP3Home } from './helpers/p3-fixture.js';
import { materialiseV4Home } from './helpers/v4-fixture.js';
import { enforceSpawnBudget, spawnBudget } from './helpers/spawn-budget.js';

/**
 * (ADR-083 review N1) The upgrade to contacts per address, through the real CLI (temp MORSE_HOME + HOME),
 * when the record of which address each agent has (`addresses/agents.json`) cannot be read:
 *
 *   - a computer with several addresses and someone blocked: the upgrade is refused — every command that
 *     opens the mailbox says ONE line (what is wrong, which file, that nothing was changed) and ends with
 *     exit 1. No stack trace, not a byte of the database changed, no backup left behind;
 *   - a computer with ONE address: there is no other address to carry a block to — it is upgraded like any
 *     other, exactly as with an intact file, and goes on working with its first address.
 */

enforceSpawnBudget();

const P3 = materialiseP3Home();
const { first: F, work: W, lab: L } = P3.fx.mine;
const homes: string[] = [P3.home];
afterAll(() => {
  removeHomes();
  homes.forEach((h) => rmSync(h, { recursive: true, force: true }));
});

const file = (home: string, ...name: string[]) => join(home, '.morse', ...name);
/** A copy of the home the release before wrote (schema v3): three addresses, people blocked by address and by old handle. */
const p3Home = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'morse-refused-p3-'));
  homes.push(home);
  cpSync(P3.morseDir, join(home, '.morse'), { recursive: true });
  return home;
};
/**
 * The same home as a computer that never had a second address: no key but the device's, one agent in its
 * config, and nothing in the database names another address of its own.
 */
const oneAddressHome = (): string => {
  const home = p3Home();
  for (const a of [W, L]) rmSync(file(home, 'addresses', a), { recursive: true });
  const db = new Database(file(home, 'mailbox.db'));
  db.prepare('UPDATE messages SET my_address = NULL WHERE my_address IN (?, ?)').run(W, L);
  db.prepare('UPDATE contacts SET known_as = NULL WHERE known_as IN (?, ?)').run(W, L);
  db.prepare('UPDATE morse_requests SET to_address = ? WHERE to_address IN (?, ?)').run(F, W, L);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const config = JSON.parse(readFileSync(file(home, 'config.json'), 'utf8')) as { relay: { agents: string[] } };
  config.relay.agents = ['mini'];
  writeFileSync(file(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(file(home, 'addresses', 'agents.json'), `${JSON.stringify({ v: 1, agents: { mini: F } })}\n`);
  return home;
};
const damage = (home: string): void => writeFileSync(file(home, 'addresses', 'agents.json'), '{ not json');
const versionOf = (home: string) => {
  const db = new Database(file(home, 'mailbox.db'), { readonly: true });
  try {
    return db.pragma('user_version', { simple: true });
  } finally {
    db.close();
  }
};
/** Every row of every table, and the schema. */
const dump = (home: string): string => {
  const db = new Database(file(home, 'mailbox.db'), { readonly: true });
  try {
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
    return JSON.stringify(
      {
        version: db.pragma('user_version', { simple: true }),
        schema: db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all(),
        rows: Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT * FROM "${t}"`).all() as unknown[]).map((r) => JSON.stringify(r)).sort()])),
      },
      null,
      1,
    );
  } finally {
    db.close();
  }
};
/** What the upgrade decides (no time of day in it: two homes upgraded a moment apart compare equal). */
const decided = (home: string) => {
  const db = new Database(file(home, 'mailbox.db'), { readonly: true });
  try {
    const all = (sql: string) => (db.prepare(sql).all() as unknown[]).map((r) => JSON.stringify(r)).sort();
    return {
      version: db.pragma('user_version', { simple: true }),
      contacts: all('SELECT id, my_address, address, handle, remark, group_label, state FROM contacts'),
      requests: all('SELECT my_address, handle, text FROM morse_requests'),
      blocks: all('SELECT my_address, address FROM address_blocks'),
      messages: all('SELECT id, contact_id, my_address, direction, status FROM messages'),
    };
  } finally {
    db.close();
  }
};
const blocksOf = (home: string): string[] => {
  const db = new Database(file(home, 'mailbox.db'), { readonly: true });
  try {
    return (db.prepare('SELECT my_address, address FROM address_blocks').all() as Array<{ my_address: string; address: string }>).map((r) => `${r.my_address}|${r.address}`).sort();
  } finally {
    db.close();
  }
};
/** The files a refused upgrade must not leave: a backup directory, a copy beside the database. */
const leftBehind = (home: string): string[] => [...(existsSync(file(home, 'backups')) ? readdirSync(file(home, 'backups')) : []), ...readdirSync(file(home)).filter((f) => f.includes('.bak'))];

const NOTICE = /^morse: contacts and message requests are now kept per address of yours — \d+ contact\(s\) belong to an address other than your first; people you had blocked stay blocked at all your addresses; nothing was deleted, backup: .+$/;
/** The address-shaped entries of the block list: the people blocked by address before the upgrade. */
const blockedByAddress = (home: string): string[] => (JSON.parse(readFileSync(file(home, 'morse-blocked.json'), 'utf8')) as { handles: string[] }).handles.filter((h) => /^[2-9a-z]{26}$/.test(h));

describe('several addresses, someone blocked, agents.json unreadable: the upgrade is refused in one line (ADR-083 review N1)', () => {
  const refused = (r: Ran, home: string): void => {
    expect(r.code).toBe(1);
    const said = r.err.split('\n').filter(Boolean);
    expect(said, r.err).toHaveLength(1);
    // what is wrong, which file, that nothing was changed
    expect(said[0]).toBe(
      `error: cannot tell which addresses are here (${file(home, 'addresses', 'agents.json')} is damaged (not JSON) — it holds the names of your addresses here. Fix it or move it away (the keys in ${file(home, 'addresses')} are untouched); nothing was changed.) — the people you blocked could not be kept blocked at each of them; your contacts were not changed; the upgrade runs again the next time morse starts`,
    );
    expect(r.err).not.toMatch(/^\s+at /m); // (no stack trace)
    expect(r.err).not.toContain('node:internal');
  };

  it('every command that opens the mailbox says the one line and ends with exit 1 — nothing is changed, no backup is left', async () => {
    const home = p3Home();
    damage(home);
    expect(blockedByAddress(home).length).toBeGreaterThan(0);
    const before = dump(home);
    const dead = String(await freePort());
    for (const args of [['contact'], ['contact', '--json'], ['message'], ['requests'], ['send', `morse.im/${P3.fx.peers.ann}`, 'hello', '--port', dead], ['contact', 'block', P3.fx.peers.ann]]) {
      const r = await cliAt(home, args);
      refused(r, home);
      expect(r.out, args.join(' ')).toBe('');
      expect(dump(home), args.join(' ')).toBe(before);
      expect(leftBehind(home), args.join(' ')).toEqual([]);
    }
    expect(versionOf(home)).toBe(3);
  }, spawnBudget(6));

  it('`morse start` is refused the same way: the one line, no daemon, no pid file', async () => {
    const home = p3Home();
    damage(home);
    const before = dump(home);
    const r = await cliAt(home, ['start', '--no-web', '--no-lan', '--no-notify']);
    refused(r, home);
    expect(dump(home)).toBe(before);
    expect(leftBehind(home)).toEqual([]);
    expect(existsSync(file(home, 'daemon.pid'))).toBe(false);
    expect(existsSync(file(home, 'daemon.json'))).toBe(false);
  }, spawnBudget(1));

  it('once the file is readable again the next command upgrades the mailbox — the blocks at every address', async () => {
    const home = p3Home();
    const good = readFileSync(file(home, 'addresses', 'agents.json'));
    damage(home);
    refused(await cliAt(home, ['contact']), home);
    writeFileSync(file(home, 'addresses', 'agents.json'), good);
    const r = await cliAt(home, ['contact']);
    expect(r.code, r.err).toBe(0);
    // (ADR-091) …and the v5 step follows in the same open
    expect(r.err.split('\n').filter(Boolean)).toEqual([expect.stringMatching(NOTICE), expect.stringMatching(/^morse: old names are gone — every contact is reached by its address now/)]);
    expect(versionOf(home)).toBe(5);
    const blocks = blocksOf(home);
    for (const theirs of blockedByAddress(home)) for (const my of ['', W, L]) expect(blocks, `${my}|${theirs}`).toContain(`${my}|${theirs}`);
  }, spawnBudget(2));
});

describe('ONE address, someone blocked, agents.json unreadable: upgraded like any other (ADR-083 review N1)', () => {
  it('(the home: no key but the device’s — with several keys the damaged file is an error, with one it is not asked)', () => {
    const several = p3Home();
    damage(several);
    expect(hasOtherAddressKeys(several)).toBe(true);
    expect(() => homeContactContext(several).ownAddresses!()).toThrow(/agents\.json is damaged \(not JSON\)/);
    const one = oneAddressHome();
    expect(homeContactContext(one).ownAddresses!()).toEqual([F]);
    damage(one);
    expect(hasOtherAddressKeys(one)).toBe(false);
    expect(homeContactContext(one).ownAddresses!()).toEqual([]);
    // (no addresses directory at all: one address, too)
    rmSync(file(one, 'addresses'), { recursive: true });
    expect(hasOtherAddressKeys(one)).toBe(false);
    expect(homeContactContext(one).ownAddresses!()).toEqual([]);
  });

  it('the first command upgrades the mailbox exactly as with an intact file — blocks at the first address, nothing refused — and the commands go on working', async () => {
    const intact = oneAddressHome();
    const ok = await cliAt(intact, ['contact']);
    expect(ok.code, ok.err).toBe(0);

    const home = oneAddressHome();
    damage(home);
    expect(blockedByAddress(home).length).toBeGreaterThan(0);
    expect(versionOf(home)).toBe(3);
    const r = await cliAt(home, ['contact']);
    expect(r.code, r.err).toBe(0);
    // (said once, as on any upgrade — and no contact belongs to another address: there is none)
    expect(r.err.split('\n').filter(Boolean)).toEqual([expect.stringMatching(/^morse: contacts and message requests are now kept per address of yours; people you had blocked stay blocked at all your addresses; nothing was deleted, backup: .+$/), expect.stringMatching(/^morse: old names are gone — every contact is reached by its address now/)]);
    expect(r.out).toBe(ok.out);
    expect(versionOf(home)).toBe(5);
    // what the upgrade decided is what it decides on the home whose file was never damaged
    expect(decided(home)).toEqual(decided(intact));
    const blocks = blocksOf(home);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b.startsWith('|'), b).toBe(true); // (every block is the first address's: there is no other)
    for (const theirs of blockedByAddress(home)) expect(blocks).toContain(`|${theirs}`);

    // …and it goes on working with its first address, damaged file and all
    const again = await cliAt(home, ['contact']);
    expect(again).toEqual({ code: 0, err: '', out: ok.out });
    const inbox = await cliAt(home, ['message', '--json']);
    expect({ code: inbox.code, err: inbox.err }).toEqual({ code: 0, err: '' });
    const block = await cliAt(home, ['contact', 'block', P3.fx.peers.ann]);
    expect({ code: block.code, err: block.err }).toEqual({ code: 0, err: '' });
    expect(blocksOf(home)).toContain(`|${P3.fx.peers.ann}`);
  }, spawnBudget(5));
});

describe('(ADR-091 follow-up) the v5 upgrade cannot take its backup: one line, exit 1 — no stack trace', () => {
  it('no room for the backup anywhere: the command says what is wrong in one line and the database stays at v4', { timeout: spawnBudget(2) }, async () => {
    const V4 = materialiseV4Home();
    const home = mkdtempSync(join(tmpdir(), 'morse-refused-v4-'));
    homes.push(home);
    cpSync(V4.morseDir, join(home, '.morse'), { recursive: true });
    writeFileSync(file(home, 'backups'), 'not a directory'); // ~/.morse/backups cannot be made
    writeFileSync(file(home, 'mailbox.db.v4-contacts.bak'), 'in the way'); // nor the copy beside the database
    const r: Ran = await cliAt(home, ['contact']);
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toMatch(/^error: /);
    expect(r.err).not.toMatch(/\n\s+at /);
    const db = new Database(file(home, 'mailbox.db'), { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    db.close();
  });
});
