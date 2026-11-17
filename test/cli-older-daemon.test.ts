import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAP_CONTACTS_PER_ADDRESS, CAP_FROM_ADDRESS, changesContactsOrSends, DAEMON_CAPABILITIES, OLDER_DAEMON_LINE } from '../src/daemon/capabilities.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { addressOf, cliAt, computer, freePort, mailboxOf, removeHomes, REPO, someone, storeOf, strangers, T0, until, type Computer, type Ran } from './helpers/personas-home.js';
import { materialiseP3Home } from './helpers/p3-fixture.js';
import { stopProcess } from './helpers/stop-process.js';
import { daemonStub, isRunning, killStub, killStubs, unrelatedStub } from './helpers/stub-process.js';

/**
 * (ADR-083) After the upgrade a daemon of the release before may still be running — on a mailbox this
 * release keeps per address (`user_version` 4). Through the real CLI (temp MORSE_HOME + HOME):
 *
 *   - every command says ONE line on stderr, and otherwise does what it does with no daemon;
 *   - a command that changes contacts, message requests or blocks, or queues mail, refuses: exit 1,
 *     not a row changed, nothing queued;
 *   - `morse stop` says nothing (it is the fix); `start`, `update`, `status` are not refused;
 *   - a daemon of this release (it says `contacts-per-address`), or no daemon: no line, everything works;
 *   - the upgrade of the mailbox itself is not held back.
 *
 * The "older daemon" is what a command can tell of one: a LIVE pid in daemon.pid whose process reads like a
 * Morse daemon (a process of this test that only sleeps, started as `node -e … /stub/anytoany/dist/cli.js
 * start` — `morse stop` signals it) with no daemon.json, or one that lacks the capability.
 *
 * (review N3) A live pid that is ANOTHER program's — a pid file left over from a crash or a reboot, its pid
 * given away since — is no daemon at all: nothing is said, nothing is refused, `morse stop` signals nobody,
 * `morse start` starts. The last block.
 */

const LINE = 'the running Morse daemon is older than this version — restart it: morse stop --restart';
const SAID = `${LINE}\n`;

const sleepers: ChildProcess[] = [];
/** A process that does nothing and reads like a Morse daemon: the pid a daemon.pid names while a daemon runs. */
const sleeper = async (): Promise<number> => {
  const p = await daemonStub();
  sleepers.push(p);
  return p.pid!;
};
const alive = isRunning;
const extraHomes: string[] = [];
afterAll(async () => {
  await killStubs();
  removeHomes();
  extraHomes.forEach((h) => rmSync(h, { recursive: true, force: true }));
});

const file = (home: string, name: string) => join(home, '.morse', name);
type Stub = 'none' | 'no daemon.json' | 'daemon.json without the capability' | "another pid's daemon.json" | 'the release before local-api-auth' | 'this release';
/** What the files next to the mailbox say about the running daemon. */
const daemonIs = (home: string, pid: number | null, how: Stub): void => {
  rmSync(file(home, 'daemon.pid'), { force: true });
  rmSync(file(home, 'daemon.json'), { force: true });
  if (how === 'none' || pid === null) return;
  writeFileSync(file(home, 'daemon.pid'), String(pid));
  if (how === 'daemon.json without the capability') writeFileSync(file(home, 'daemon.json'), JSON.stringify({ pid, port: null, capabilities: [CAP_FROM_ADDRESS] }));
  // (ADR-087) the release before this one: contacts per address, but a local API that asks nobody for a token
  if (how === 'the release before local-api-auth') writeFileSync(file(home, 'daemon.json'), JSON.stringify({ pid, port: null, capabilities: [CAP_FROM_ADDRESS, CAP_CONTACTS_PER_ADDRESS] }));
  if (how === "another pid's daemon.json") writeFileSync(file(home, 'daemon.json'), JSON.stringify({ pid: pid + 1, port: null, capabilities: [...DAEMON_CAPABILITIES] }));
  if (how === 'this release') writeFileSync(file(home, 'daemon.json'), JSON.stringify({ pid, port: null, capabilities: [...DAEMON_CAPABILITIES] }));
};
/** Everything a command could have changed: every table of the database, the block list, the trust list, the attendant's settings. */
const dump = (home: string): string => {
  const { db } = storeOf(home);
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = (db.prepare(`SELECT * FROM "${t}"`).all() as unknown[]).map((r) => JSON.stringify(r)).sort();
  for (const f of ['morse-blocked.json', 'trusted-devices.json', 'config.json']) out[f] = existsSync(file(home, f)) ? readFileSync(file(home, f), 'utf8') : null;
  return JSON.stringify(out, null, 1);
};

let ann: Computer;
let work: string;
let pid: number;
let dead: string;
let P: { x: string; y: string; z: string; fresh: string; r1: string; r2: string };
const ids: Record<string, string> = {};
const cli = (...args: string[]): Promise<Ran> => cliAt(ann.home, args, { MORSE_SITE: `http://127.0.0.1:${dead}` });

beforeAll(async () => {
  ann = computer('ann', 'mini', ['work']);
  // (no command of this file may reach a relay: the one configured is a port nobody listens on)
  updateMachineConfig((cfg) => {
    (cfg['relay'] as Record<string, unknown>)['url'] = 'ws://127.0.0.1:9';
  }, file(ann.home, 'config.json'));
  work = addressOf(ann, 'work').address;
  dead = String(await freePort());
  pid = await sleeper();
  const [r1, r2] = strangers(2) as [string, string];
  P = { x: someone(), y: someone(), z: someone(), fresh: someone(), r1, r2 };
  let t = T0;
  const ctx = homeContactContext(ann.home);
  const { createMailbox } = await import('../src/mailbox/mailbox.js');
  const mb = createMailbox(createDb(file(ann.home, 'mailbox.db'), { ctx }), { ctx, now: () => (t += 60_000) });
  mb.contacts.set(mb.contacts.ensureAddress(P.x, '').id, { remark: 'xin', group: 'friend' });
  mb.contacts.set(mb.contacts.ensureAddress(P.y, work).id, { remark: 'yan' });
  mb.contacts.set(mb.contacts.ensureAddress(P.z, '').id, { remark: 'zed', state: 'blocked' });
  mb.contacts.blockAt(P.z, '');
  mb.contacts.set(mb.contacts.ensure('kai').id, { remark: 'Kai' });
  ids['toMini'] = mb.send({ from: { agent: 'claude', sessionId: '', device: P.x }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'xin to mini', fromTier: 'peer', myAddress: ann.address }).id;
  ids['toWork'] = mb.send({ from: { agent: 'claude', sessionId: '', device: P.y }, to: { agent: 'work', sessionId: 'inbox' }, text: 'yan to work', fromTier: 'peer', myAddress: work }).id;
  ids['oldWay'] = mb.send({ from: { agent: 'claude', sessionId: '', device: 'kai/mbp' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'kai, the old way', fromTier: 'peer' }).id;
  const request = (from: string, at: string, text: string) =>
    mb.requests.file({ handle: from, deviceId: from, msgId: `r-${from.slice(0, 6)}`, from: { agent: 'claude', sessionId: '' }, to: { agent: at ? 'work' : 'mini', sessionId: 'inbox' }, toAddress: at || ann.address, ...(at ? { myAddress: at } : {}), text, droppedFiles: 0, via: 'morse-relay' });
  request(P.r1, '', 'r1 to mini');
  request(P.r2, work, 'r2 to work');
  expect(new Database(file(ann.home, 'mailbox.db'), { readonly: true }).pragma('user_version', { simple: true })).toBe(5);
}, 120_000);

/** Commands that only show something — each prints the same with and without the older daemon. */
const reading = (): string[][] => [
  ['contact'],
  ['contacts'],
  ['contact', '--json'],
  ['contact', '--from', 'work'],
  ['contact', 'xin'],
  ['contact', 'yan', '--json'],
  ['requests'],
  ['message'],
  ['message', '--json'],
  ['message', '--all'],
  ['inbox', '--all', '--json'],
  ['message', 'xin'],
  ['history', 'yan', '--json'],
  ['message', '--id', ids['toWork']!],
  ['read', ids['toMini']!, '--json'],
  ['conversations'],
  ['address'],
  ['plugin', 'list'],
  ['help'],
  ['help', '--all'],
  ['help', 'contact'],
];
/** Commands that change contacts, message requests or blocks, or queue mail — each would succeed (see the last block). */
const changing = (): string[][] => [
  ['send', 'xin', 'hello', '--port', dead],
  ['send', `morse.im/${P.y}`, 'hello', '--from', 'work', '--port', dead],
  ['send', '@claude:s-1', 'to a session here', '--port', dead],
  ['reply', ids['toMini']!, 'an answer'],
  ['reply', ids['toWork']!, 'an answer from work'],
  ['reply', ids['oldWay']!, 'an answer the old way'],
  ['contact', 'add', P.fresh, '--name', 'new', '--port', dead],
  ['contact', 'add', P.r1, '--port', dead],
  ['contact', 'set', 'xin', '--group', 'vip'],
  ['contact', 'set', 'yan', '--name', 'yanyan'],
  ['contact', 'set', '--group', 'friend', '--rate', '5/h'],
  ['contact', 'remove', 'xin'],
  ['contact', 'accept', P.r1, '--port', dead],
  ['contact', 'accept', P.r2, '--from', 'work', '--port', dead],
  ['contact', 'reject', P.r1],
  ['contact', 'reject', '--all'],
  ['contact', 'block', 'xin'],
  ['contact', 'block', P.fresh, '--from', 'work'],
  ['contact', 'unblock', 'zed'],
  // the names from before ADR-074
  ['block', 'yan'],
  ['unblock', 'zed'],
  ['requests', 'accept', P.r1, '--port', dead],
  ['requests', 'reject', P.r2],
  ['requests', 'reject', '--all'],
  ['requests', 'block', P.r1],
  ['requests', 'decline', P.r2],
];

describe('the names: the capability, the line, which commands change something (ADR-083)', () => {
  it('this release says `contacts-per-address` next to `from-address`; the line is the one line', () => {
    expect(CAP_CONTACTS_PER_ADDRESS).toBe('contacts-per-address');
    expect([...DAEMON_CAPABILITIES]).toEqual(['from-address', 'contacts-per-address', 'local-api-auth', 'listener-proof', 'addresses-only']);
    expect(OLDER_DAEMON_LINE).toBe(LINE);
  });

  it('`contact` / `requests` with a verb, `send`, `reply`, the old `block` / `unblock` change something; listing, reading, the daemon and the update do not', () => {
    for (const args of changing()) {
      const path = args[0] === 'contact' || args[0] === 'requests' ? args.slice(0, 2) : args.slice(0, 1);
      expect(changesContactsOrSends(path), path.join(' ')).toBe(true);
    }
    for (const path of [['contact'], ['contacts'], ['requests'], ['message'], ['messages'], ['inbox'], ['history'], ['read'], ['done'], ['address'], ['address', 'add'], ['agent', 'list'], ['status'], ['start'], ['stop'], ['update'], ['help'], ['hook'], ['plugin', 'claim'], ['plugin', 'ack'], ['claim'], ['pair', 'add']]) {
      expect(changesContactsOrSends(path), path.join(' ')).toBe(false);
    }
  });
});

describe('an older daemon is running on a mailbox kept per address (ADR-083)', () => {
  const baseline: Record<string, Ran> = {};

  beforeAll(async () => {
    daemonIs(ann.home, null, 'none');
    for (const args of reading()) baseline[args.join(' ')] = await cli(...args);
  }, 300_000);

  it('(with no daemon every reading command works and says nothing on stderr)', () => {
    for (const [name, r] of Object.entries(baseline)) expect({ code: r.code, err: r.err }, name).toEqual({ code: 0, err: '' });
  });

  /** (every command for the plain case; a few of each kind for the other ways a daemon can be older — the check is one and the same) */
  const some = <T,>(how: Stub, all: T[]): T[] => (how === 'no daemon.json' ? all : all.filter((_, i) => i % 5 === 0));

  it.each(['no daemon.json', 'daemon.json without the capability', "another pid's daemon.json", 'the release before local-api-auth'] as Stub[])('%s: every reading command says the one line on stderr — and prints what it prints with no daemon', async (how) => {
    daemonIs(ann.home, pid, how);
    const before = dump(ann.home);
    for (const args of some(how, reading())) {
      const r = await cli(...args);
      expect({ code: r.code, err: r.err, out: r.out }, args.join(' ')).toEqual({ code: 0, err: SAID, out: baseline[args.join(' ')]!.out });
    }
    expect(dump(ann.home)).toBe(before);
  }, 300_000);

  it.each(['no daemon.json', 'daemon.json without the capability', "another pid's daemon.json", 'the release before local-api-auth'] as Stub[])('%s: every command that changes contacts, requests or blocks, or sends, refuses — exit 1, the one line, not a row changed, nothing queued', async (how) => {
    daemonIs(ann.home, pid, how);
    const before = dump(ann.home);
    for (const args of some(how, changing())) {
      const r = await cli(...args);
      expect(r, args.join(' ')).toEqual({ code: 1, err: SAID, out: '' });
      // --json: the same line is also the error a plugin reads on stdout (`requests decline` has no --json)
      if (how !== 'no daemon.json' || args.slice(0, 2).join(' ') === 'requests decline') continue;
      const j = await cli(...args, '--json');
      expect({ code: j.code, err: j.err, out: JSON.parse(j.out) }, `${args.join(' ')} --json`).toEqual({ code: 1, err: SAID, out: { error: LINE } });
    }
    expect(dump(ann.home)).toBe(before);
    expect(mailboxOf(ann.home).inbox({ all: true }).filter((m) => m.direction === 'out')).toEqual([]);
  }, 600_000);

  it("a plugin's path — `morse reply <id> … --by plugin:attendant --via attendant --json`, `morse send … --from @<agent>:<session> --json` — is refused the same way", async () => {
    daemonIs(ann.home, pid, 'no daemon.json');
    const before = dump(ann.home);
    for (const args of [
      ['reply', ids['toWork']!, 'the attendant answers', '--by', 'plugin:attendant', '--via', 'attendant', '--json'],
      ['send', '@ilink:owner', 'a note for the owner', '--from', '@attendant:attendant', '--json'],
      ['send', `morse.im/${P.x}`, 'from WeChat', '--from', '@ilink:owner', '--port', dead, '--json'],
    ]) {
      const r = await cli(...args);
      expect({ code: r.code, err: r.err, out: JSON.parse(r.out) }, args.join(' ')).toEqual({ code: 1, err: SAID, out: { error: LINE } });
    }
    expect(dump(ann.home)).toBe(before);
    // what a plugin may still do: read, and mark what it handled
    const todo = await cli('message', '--json');
    expect({ code: todo.code, err: todo.err }).toEqual({ code: 0, err: SAID });
    expect((JSON.parse(todo.out) as { messages: unknown[] }).messages).toHaveLength(3);
  }, 120_000);

  it('morse status works, says the line, and shows the daemon as running', async () => {
    daemonIs(ann.home, pid, 'no daemon.json');
    const r = await cli('status', '--port', dead);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: SAID });
    const lines = r.out.split('\n');
    expect(lines[0]).toBe(`daemon: running (pid ${pid})`);
    expect(lines).toContain('contacts: kept per address of yours — each address has its own contacts, message requests and blocks');
    expect(lines.some((l) => l.startsWith('mailbox: 3 messages'))).toBe(true);
  }, 60_000);

  it('morse start is not refused by this — it says the line, then what it always said of a daemon that is already running', async () => {
    daemonIs(ann.home, pid, 'no daemon.json');
    expect(alive(pid)).toBe(true);
    const before = dump(ann.home);
    const r = await cli('start', '--no-web', '--no-lan', '--no-notify');
    expect(r).toEqual({ code: 1, out: '', err: `${SAID}daemon already running (pid ${pid}) — stop it first with morse stop\n` });
    expect(dump(ann.home)).toBe(before);
    // (the files of the daemon that IS running were not touched)
    expect(readFileSync(file(ann.home, 'daemon.pid'), 'utf8')).toBe(String(pid));
    expect(existsSync(file(ann.home, 'daemon.json'))).toBe(false);
  }, 60_000);

  it('morse update is not refused by this — it says the line and goes on to look for a release (here: a site nobody serves)', async () => {
    daemonIs(ann.home, pid, 'no daemon.json');
    const r = await cli('update', '--check');
    expect(r.code).toBe(1);
    const said = r.err.split('\n').filter(Boolean);
    expect(said[0]).toBe(LINE);
    expect(said).toHaveLength(2);
    expect(said[1]).toMatch(/^✗ /); // (its own error: the check could not reach the site)
    expect(r.out).toMatch(/^installed: /);
  }, 60_000);

  it('a daemon of this release (its daemon.json says `contacts-per-address`): no line — reading and changing work', async () => {
    daemonIs(ann.home, pid, 'this release');
    for (const args of some('this release', reading())) {
      const r = await cli(...args);
      expect({ code: r.code, err: r.err, out: r.out }, args.join(' ')).toEqual({ code: 0, err: '', out: baseline[args.join(' ')]!.out });
    }
    const set = await cli('contact', 'set', 'xin', '--group', 'vip');
    expect(set).toEqual({ code: 0, err: '', out: `contact: xin (morse.im/${P.x})  [vip]\n` });
    const back = await cli('contact', 'set', 'xin', '--group', 'friend');
    expect(back).toEqual({ code: 0, err: '', out: `contact: xin (morse.im/${P.x})  [friend]\n` });
    const st = await cli('status', '--port', dead);
    expect({ code: st.code, err: st.err }).toEqual({ code: 0, err: '' });
  }, 300_000);

  it('a pid file that names a process that is gone, or no pid file: no line', async () => {
    const gone = await sleeper();
    await killStub(sleepers.at(-1)!);
    expect(alive(gone)).toBe(false);
    daemonIs(ann.home, gone, 'no daemon.json');
    for (const args of [['contact'], ['message'], ['status', '--port', dead], ['help']]) {
      const r = await cli(...args);
      expect({ code: r.code, err: r.err }, args.join(' ')).toEqual({ code: 0, err: '' });
    }
    daemonIs(ann.home, null, 'none');
    const r = await cli('contact');
    expect({ code: r.code, err: r.err, out: r.out }).toEqual({ code: 0, err: '', out: baseline['contact']!.out });
  }, 120_000);

  it('morse stop says nothing of it, stops the daemon — and from then on no command says the line or refuses', async () => {
    const old = await sleeper();
    daemonIs(ann.home, old, 'no daemon.json');
    expect((await cli('contact', 'set', 'xin', '--group', 'vip')).err).toBe(SAID);
    const stop = await cli('stop');
    expect(stop).toEqual({ code: 0, err: '', out: `sent SIGTERM to daemon (pid ${old})\n` });
    await until(() => !alive(old));
    expect(existsSync(file(ann.home, 'daemon.pid'))).toBe(false);

    // no daemon: everything works, on the mailbox directly, and nothing is said
    const before = mailboxOf(ann.home).contacts.find('xin')!;
    expect(before.group).toBe('friend'); // (the refused command above changed nothing)
    expect(await cli('contact', 'set', 'xin', '--group', 'vip')).toEqual({ code: 0, err: '', out: `contact: xin (morse.im/${P.x})  [vip]\n` });
    expect(await cli('contact', 'reject', P.r1)).toEqual({ code: 0, err: '', out: `rejected morse.im/${P.r1} — request deleted (not blocked; to block: morse contact block ${P.r1})  via mini\n` });
    expect((await cli('contact', 'accept', P.r2, '--port', dead)).code).toBe(0);
    expect((await cli('contact', 'block', 'yan')).code).toBe(0);
    expect((await cli('contact', 'unblock', 'zed')).code).toBe(0);
    expect((await cli('contact', 'add', P.fresh, '--name', 'new', '--port', dead)).code).toBe(0);
    expect((await cli('contact', 'remove', 'new')).code).toBe(0);
    const reply = await cli('reply', ids['toMini']!, 'an answer', '--json');
    expect({ code: reply.code, err: reply.err }).toEqual({ code: 0, err: '' });
    expect((JSON.parse(reply.out) as { sent: boolean }).sent).toBe(true);
    const sent = mailboxOf(ann.home).inbox({ all: true }).filter((m) => m.direction === 'out');
    expect(sent.map((m) => [m.parts[0]!.text, m.status])).toEqual([['an answer', 'pending']]);
    const contacts = mailboxOf(ann.home).contacts;
    expect([contacts.find('xin')!.group, contacts.find('yan')!.state, contacts.find('zed')!.state, contacts.find('new')]).toEqual(['vip', 'blocked', 'active', null]);
    expect(mailboxOf(ann.home).requests.count()).toBe(0);
  }, 300_000);
});

describe('the upgrade of the mailbox is not held back by an older daemon (ADR-083)', () => {
  const P3 = materialiseP3Home();
  const NOTICE = /^morse: contacts and message requests are now kept per address of yours — \d+ contact\(s\) belong to an address other than your first; people you had blocked stay blocked at all your addresses; nothing was deleted, backup: .+$/;
  /** (ADR-091) the line the v5 step says, in the same open */
  const V5_NOTICE = /^morse: old names are gone — every contact is reached by its address now/;
  let stub: number;
  /** A copy of the home the release before wrote (schema v3), with that release's daemon "still running". */
  const p3Home = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'morse-older-p3-'));
    extraHomes.push(home);
    cpSync(P3.morseDir, join(home, '.morse'), { recursive: true });
    writeFileSync(file(home, 'daemon.pid'), String(stub));
    return home;
  };
  const versionOf = (home: string) => {
    const db = new Database(file(home, 'mailbox.db'), { readonly: true });
    try {
      return db.pragma('user_version', { simple: true });
    } finally {
      db.close();
    }
  };
  /** What the migration decides, and what a command could add to it. */
  const state = (home: string) => {
    const db = new Database(file(home, 'mailbox.db'), { readonly: true });
    try {
      const all = (sql: string) => (db.prepare(sql).all() as unknown[]).map((r) => JSON.stringify(r)).sort();
      return {
        contacts: all('SELECT id, my_address, address, handle, remark, group_label, state FROM contacts'),
        requests: all('SELECT my_address, handle, text FROM morse_requests'),
        blocks: all('SELECT my_address, address FROM address_blocks'),
        messages: all('SELECT id, contact_id, direction, status FROM messages'),
      };
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    extraHomes.push(P3.home);
    stub = await sleeper();
  });

  it('a reading command is the first after the update: it upgrades the mailbox (said once), prints its list — and says the line when it ends', async () => {
    const home = p3Home();
    expect(versionOf(home)).toBe(3);
    const r = await cliAt(home, ['contact']);
    expect(r.code, r.err).toBe(0);
    const said = r.err.split('\n').filter(Boolean);
    // (ADR-091: the v5 step follows in the same open, with its own line)
    expect(said).toHaveLength(3);
    expect(said[0]).toMatch(NOTICE);
    expect(said[1]).toMatch(V5_NOTICE);
    expect(said[2]).toBe(LINE);
    expect(r.out).toContain(`Wendy (morse.im/${P3.fx.peers.wendy})  [colleague]`);
    expect(versionOf(home)).toBe(5);
    // from then on: the line first, as on any mailbox kept per address
    const again = await cliAt(home, ['contact']);
    expect({ code: again.code, err: again.err, out: again.out }).toEqual({ code: 0, err: SAID, out: r.out });
  }, 120_000);

  it('a changing command is the first after the update: the mailbox is upgraded (said once), then the command refuses — nothing but the upgrade happened', async () => {
    const plain = p3Home();
    rmSync(file(plain, 'daemon.pid'));
    expect((await cliAt(plain, ['contact'])).code).toBe(0); // (the upgrade alone, no daemon: what to compare with)

    for (const args of [
      ['contact', 'block', P3.fx.peers.ann],
      ['contact', 'reject', '--all'],
      ['send', `morse.im/${P3.fx.peers.ann}`, 'hello', '--port', String(await freePort())],
      ['reply', P3.fx.messages['fromWendy2']!, 'an answer', '--json'],
    ]) {
      const home = p3Home();
      const r = await cliAt(home, args);
      expect(r.code, args.join(' ')).toBe(1);
      const said = r.err.split('\n').filter(Boolean);
      expect(said, args.join(' ')).toHaveLength(3);
      expect(said[0], args.join(' ')).toMatch(NOTICE);
      expect(said[1], args.join(' ')).toMatch(V5_NOTICE);
      expect(said[2], args.join(' ')).toBe(LINE);
      if (args.includes('--json')) expect(JSON.parse(r.out)).toEqual({ error: LINE });
      else expect(r.out).toBe('');
      expect(versionOf(home), args.join(' ')).toBe(5);
      expect(state(home), args.join(' ')).toEqual(state(plain));
    }
  }, 300_000);

  it('`morse stop` on a mailbox not upgraded yet: nothing is said, nothing is upgraded — the next start does that', async () => {
    const home = p3Home();
    const own = await sleeper();
    writeFileSync(file(home, 'daemon.pid'), String(own));
    const r = await cliAt(home, ['stop']);
    expect(r).toEqual({ code: 0, err: '', out: `sent SIGTERM to daemon (pid ${own})\n` });
    expect(versionOf(home)).toBe(3);
  }, 60_000);
});

describe('a stale pid file — its pid is another program’s by now — is no daemon at all (ADR-083 review N3)', () => {
  let other: ChildProcess;
  const base: Record<string, Ran> = {};
  const some = (): string[][] => [['contact'], ['contact', '--json'], ['message'], ['requests'], ['address'], ['help']];
  const pidFile = () => file(ann.home, 'daemon.pid');

  beforeAll(async () => {
    other = await unrelatedStub();
    daemonIs(ann.home, null, 'none');
    for (const args of some()) base[args.join(' ')] = await cli(...args);
  }, 120_000);

  it.each(['no daemon.json', 'daemon.json without the capability', "another pid's daemon.json"] as Stub[])('%s: no command says the line — each prints what it prints with no daemon — and the stale pid file is removed', async (how) => {
    const before = dump(ann.home);
    for (const args of some()) {
      daemonIs(ann.home, other.pid!, how);
      const r = await cli(...args);
      expect(r, args.join(' ')).toEqual({ code: 0, err: '', out: base[args.join(' ')]!.out });
      expect(existsSync(pidFile()), args.join(' ')).toBe(false);
    }
    expect(dump(ann.home)).toBe(before);
    expect(alive(other.pid!)).toBe(true);
  }, 120_000);

  it('a command that changes contacts or sends is not refused', async () => {
    const group = mailboxOf(ann.home).contacts.find('xin')!.group!;
    const to = group === 'vip' ? 'friend' : 'vip';
    daemonIs(ann.home, other.pid!, 'no daemon.json');
    expect(await cli('contact', 'set', 'xin', '--group', to)).toEqual({ code: 0, err: '', out: `contact: xin (morse.im/${P.x})  [${to}]\n` });
    expect(existsSync(pidFile())).toBe(false);
    daemonIs(ann.home, other.pid!, 'daemon.json without the capability');
    const reply = await cli('reply', ids['toMini']!, 'another answer', '--json');
    expect({ code: reply.code, err: reply.err }).toEqual({ code: 0, err: '' });
    expect((JSON.parse(reply.out) as { sent: boolean }).sent).toBe(true);
    daemonIs(ann.home, other.pid!, 'no daemon.json');
    expect(await cli('contact', 'set', 'xin', '--group', group)).toEqual({ code: 0, err: '', out: `contact: xin (morse.im/${P.x})  [${group}]\n` });
    expect(alive(other.pid!)).toBe(true);
  }, 60_000);

  it('morse status: the daemon is not running', async () => {
    daemonIs(ann.home, other.pid!, 'no daemon.json');
    const r = await cli('status', '--port', dead);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(r.out.split('\n')[0]).toBe('daemon: not running');
    expect(existsSync(pidFile())).toBe(false);
  }, 60_000);

  it('morse stop signals nobody: it says the daemon is not running and removes the stale file — the other program lives on', async () => {
    daemonIs(ann.home, other.pid!, 'no daemon.json');
    const r = await cli('stop');
    expect(r).toEqual({ code: 0, err: '', out: `daemon not running (the pid file named pid ${other.pid}, which is another program now — removed the stale pid file)\n` });
    expect(existsSync(pidFile())).toBe(false);
    await new Promise((done) => setTimeout(done, 300)); // (a signal would have ended it by now)
    expect(alive(other.pid!)).toBe(true);
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
  }, 60_000);

  it('morse start is not told "already running": it goes on past the pid file (here: to a console port something else serves)', async () => {
    // (something answers on the console port: what stops a start AFTER the pid file was looked at — no daemon is started by this test)
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => res.end('{}'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;
    try {
      daemonIs(ann.home, other.pid!, 'no daemon.json');
      const r = await cli('start', '--no-lan', '--no-notify', '--port', String(port));
      expect(r).toEqual({ code: 1, out: '', err: `port ${port} is already serving — another morse is running (morse stop first)\n` });
      expect(existsSync(pidFile())).toBe(false);
      expect(existsSync(file(ann.home, 'daemon.json'))).toBe(false);
      expect(alive(other.pid!)).toBe(true);
    } finally {
      await new Promise((done) => server.close(done));
    }
  }, 60_000);

  it('morse start starts — and the daemon it is reads like one: a second start, status and the older-daemon check go by its pid', async () => {
    // a computer of its own, nothing in its mailbox, its relay a port nobody listens on
    const sol = computer('sol', 'mini');
    updateMachineConfig((cfg) => {
      (cfg['relay'] as Record<string, unknown>)['url'] = 'ws://127.0.0.1:9';
    }, file(sol.home, 'config.json'));
    writeFileSync(file(sol.home, 'daemon.pid'), String(other.pid));
    const env = { ...process.env, MORSE_SITE: `http://127.0.0.1:${dead}`, MORSE_HOME: sol.home, ANYTOANY_HOME: sol.home, HOME: sol.home };
    const daemon = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'start', '--no-web', '--no-lan', '--no-notify', '--relay', 'ws://127.0.0.1:9'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    daemon.stdout!.on('data', (d) => (said += String(d)));
    daemon.stderr!.on('data', (d) => (said += String(d)));
    const at = (...args: string[]) => cliAt(sol.home, args, { MORSE_SITE: `http://127.0.0.1:${dead}` });
    try {
      await until(() => existsSync(file(sol.home, 'daemon.json')) && readFileSync(file(sol.home, 'daemon.pid'), 'utf8') === String(daemon.pid), 30_000);
      expect(JSON.parse(readFileSync(file(sol.home, 'daemon.json'), 'utf8'))).toEqual({ pid: daemon.pid, port: null, capabilities: [...DAEMON_CAPABILITIES], token: expect.stringMatching(/^[0-9a-f]{48}$/) }); // (ADR-087: the token is written with or without a console)
      expect(said).not.toContain('already running');
      expect(await at('start', '--no-web', '--no-lan', '--no-notify')).toEqual({ code: 1, out: '', err: `daemon already running (pid ${daemon.pid}) — stop it first with morse stop\n` });
      const st = await at('status', '--port', dead);
      expect({ code: st.code, err: st.err, first: st.out.split('\n')[0] }).toEqual({ code: 0, err: '', first: `daemon: running (pid ${daemon.pid})` });
      // (a daemon without its daemon.json would be an older one — and it is still taken for a daemon: the line)
      rmSync(file(sol.home, 'daemon.json'));
      expect((await at('contact')).err).toBe(SAID);
    } finally {
      // (stopped by this test itself, not by `morse stop`: with no pid file that command looks for a daemon by name)
      await stopProcess(daemon);
    }
    expect(existsSync(file(sol.home, 'daemon.pid'))).toBe(false); // (it removed its own pid file on the way out)
    expect(alive(other.pid!)).toBe(true);
  }, 120_000);
});
