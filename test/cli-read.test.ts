import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerRelay } from '../src/cluster/join.js';
import { loadPrimaryAddress } from '../src/identity/address-key.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { type FakeRelay, startFakeRelay } from './helpers/fake-relay.js';
import { countSpawn, enforceSpawnBudget, spawnBudget } from './helpers/spawn-budget.js';

/**
 * ADR-090: `morse read` is what `morse message` was (to process / <contact> / --id / --pull / --wait), byte for
 * byte; `morse message` stays as a hidden alias; the old hidden `read <id>` keeps working (a message id or a
 * unique prefix → that message; else a contact → the conversation; both → the message, with a note on stderr);
 * reading never changes any state. Run as the real CLI against a temp HOME (and an in-memory fake relay).
 */

const repo = resolve(__dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'morse-cli-read-'));
const emptyDir = join(home, 'nowhere');
let relay: FakeRelay;
let ids: { bob: string; earlier: string; carol: string };

enforceSpawnBudget();

const cli = (...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    countSpawn();
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: repo,
      env: { ...process.env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err }));
  });
const commandsIn = (help: string): string[] => {
  const at = help.indexOf('Commands:');
  if (at < 0) return [];
  const rows: string[] = [];
  for (const l of help.slice(at).split('\n').slice(1)) {
    if (/^\S/.test(l)) break; // the next section
    if (/^ {2}\S/.test(l)) rows.push(l.trim().split(/\s+/)[0]!);
  }
  return rows;
};
const open = (): Mailbox => {
  const ctx = homeContactContext(home);
  return createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
};
/** Every message's processed_at (undefined = still to process). */
const processed = (): Record<string, number | undefined> => {
  const mb = open();
  return Object.fromEntries(mb.inbox({ all: true }).map((m) => [m.id, m.processedAt]));
};
/** A string of `shape` that is no message id's prefix (ids are random). */
const notAPrefix = (candidates: string[]): string => {
  const all = Object.keys(processed());
  return candidates.find((c) => !all.some((id) => id.startsWith(c)))!;
};

beforeAll(async () => {
  relay = await startFakeRelay();
  await registerRelay({ url: relay.url, home, agent: 'mini', probe: false });
  mkdirSync(emptyDir, { recursive: true });
  loadPrimaryAddress(home);
  const mb = open();
  const bob = mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'can you look at the API?', fromTier: 'peer' });
  const earlier = mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'mbp', sessionId: '', device: 'bob/mbp' }, text: 'earlier question', contextId: bob.contextId });
  const carol = mb.send({ from: { agent: 'claude', sessionId: '', device: 'carol/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'lunch on friday?', fromTier: 'peer' });
  ids = { bob: bob.id, earlier: earlier.id, carol: carol.id };
});
afterAll(async () => {
  await relay.close();
  rmSync(home, { recursive: true, force: true });
});

describe('help (ADR-090)', () => {
  it('morse --help lists exactly read, send, reply, contact, address — in that order', { timeout: spawnBudget(2) }, async () => {
    for (const r of [await cli('--help'), await cli('help')]) {
      expect(r.code).toBe(0);
      expect(commandsIn(r.out)).toEqual(['read', 'send', 'reply', 'contact', 'address']);
    }
  });

  it('morse help --all lists `message` among the hidden ones (not `messages`)', { timeout: spawnBudget(1) }, async () => {
    const r = await cli('help', '--all');
    const hidden = r.out.slice(r.out.indexOf('Hidden commands'));
    expect(commandsIn(r.out)).toEqual(['read', 'send', 'reply', 'contact', 'address']);
    expect(hidden).toMatch(/^ {2}message\b/m);
    expect(hidden).not.toMatch(/^ {2}messages\b/m);
  });

  it('read --help: it only shows messages — a message waits until morse reply or morse done', { timeout: spawnBudget(2) }, async () => {
    const h = await cli('read', '--help');
    expect(h.code).toBe(0);
    expect(h.out.replace(/\s+/g, ' ')).toMatch(/only shows.*morse reply or morse done/);
    for (const o of ['--id <id>', '--all', '--from <name>', '--all-addresses', '--pull', '--wait', '--history', '--inbox', '--json', '--limit <n>', '--session <target>', '--take', '--agent <name>', '--cwd <dir>', '--quiet', '--timeout <s>', '--poll <ms>']) {
      expect(h.out, o).toContain(o);
    }
    // the hidden alias still has its own help
    expect((await cli('help', 'message')).out).toContain('--id <id>');
  });
});

describe('read = message, byte for byte (ADR-090 §1, §2)', () => {
  const same = async (...args: string[]) => {
    const [r, m] = await Promise.all([cli('read', ...args), cli('message', ...args)]);
    expect(r.code, `read ${args.join(' ')}: ${r.err}`).toBe(m.code);
    expect(r.out, `read ${args.join(' ')}`).toBe(m.out);
    expect(r.err, `read ${args.join(' ')}`).toBe(m.err);
    return r;
  };

  it('no argument, <contact>, --id, --all, and their --json', { timeout: spawnBudget(16) }, async () => {
    const plain = await same();
    expect(plain.out).toContain('can you look at the API?');
    // the footer of the to-process list points at read, reply and done
    expect(plain.out).toContain('read: morse read --id <id> · answer: morse reply <id> "…" · handled: morse done <id…> · everything incl. sent: morse read --all');
    expect(plain.out).not.toContain('morse message');
    await same('--json');
    expect((await same('bob')).out).toContain('earlier question');
    await same('bob', '--json');
    await same('--id', ids.bob.slice(0, 8));
    await same('--id', ids.bob, '--json');
    await same('--all');
    await same('--all', '--json');
  });

  it('--pull --inbox --history, --wait, and one mode at a time', { timeout: spawnBudget(6) }, async () => {
    expect((await same('--pull', '--inbox', '--history')).out).toContain('can you look at the API?');
    expect((await same('--wait', '--cwd', emptyDir)).out).toContain(`no session found for ${emptyDir}`);
    const two = await same('bob', '--id', 'abcd');
    expect(two.code).toBe(1);
    expect(two.err).toMatch(/one of/);
  });
});

describe('the old hidden `read <id>` keeps working (ADR-090 §3)', () => {
  it('read <id prefix> / read <full id> = message --id, text and --json', { timeout: spawnBudget(8) }, async () => {
    for (const id of [ids.bob.slice(0, 8), ids.bob]) {
      const [r, m] = await Promise.all([cli('read', id), cli('message', '--id', id)]);
      expect(r).toEqual(m);
      expect(r.out).toContain('can you look at the API?');
      const [rj, mj] = await Promise.all([cli('read', id, '--json'), cli('message', '--id', id, '--json')]);
      expect(rj).toEqual(mj);
      expect(JSON.parse(rj.out).message.id).toBe(ids.bob);
    }
  });

  it('id-shaped and no message: the old error (text and --json); not id-shaped and nobody: the contact error', { timeout: spawnBudget(4) }, async () => {
    const shaped = notAPrefix(['0f0f1', '1e1e2', '2d2d3']);
    const r = await cli('read', shaped);
    expect(r).toEqual({ code: 1, out: '', err: `error: no message ${shaped}\n` });
    const j = await cli('read', shaped, '--json');
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out)).toEqual({ error: `no message ${shaped}` });
    // (hex letters only, no digit: a name, not an id)
    const word = notAPrefix(['cafe', 'bead', 'face', 'dead']);
    const [n, m] = await Promise.all([cli('read', word), cli('message', word)]);
    expect(n).toEqual(m);
    expect(n.code).toBe(1);
    expect(n.err).toContain(`no contact "${word}"`);
  });

  it('a contact whose remark looks like hex and is no message: the conversation', { timeout: spawnBudget(2) }, async () => {
    const word = notAPrefix(['cafe', 'bead', 'face', 'dead']);
    open().contacts.set('c:carol', { remark: word });
    const [r, m] = await Promise.all([cli('read', word), cli('message', word)]);
    expect(r).toEqual(m);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('lunch on friday?');
  });

  it('both (a remark that is also a message id prefix): the message, with one note on stderr; `message <it>` is still the contact', { timeout: spawnBudget(4) }, async () => {
    const prefix = ids.earlier.slice(0, 6);
    open().contacts.set('c:carol', { remark: prefix });
    const [r, byId] = await Promise.all([cli('read', prefix), cli('message', '--id', prefix)]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(byId.out);
    expect(r.out).toContain('earlier question');
    expect(r.err).toMatch(new RegExp(`^note: "${prefix}" is also a contact — this is the message; everything with them: morse read morse\\.im/\\S+\\n$`));
    // the address in the note reads as the contact
    const addr = /morse read (morse\.im\/\S+)/.exec(r.err)![1]!;
    expect((await cli('read', addr)).out).toContain('lunch on friday?');
    // the hidden alias did not change: <who> is a contact
    expect((await cli('message', prefix)).out).toContain('lunch on friday?');
  });
});

describe('reading never changes any state (ADR-090 §1)', () => {
  it('read, read <contact>, read --id, read <id> leave processed_at untouched', { timeout: spawnBudget(7) }, async () => {
    const before = processed();
    expect(before[ids.bob]).toBeUndefined();
    expect(before[ids.carol]).toBeUndefined();
    for (const args of [[], ['--json'], ['bob'], ['--id', ids.bob.slice(0, 8)], [ids.carol.slice(0, 8)], ['--all']]) {
      const r = await cli('read', ...args);
      expect(r.code, `read ${args.join(' ')}: ${r.err}`).toBe(0);
    }
    expect(processed()).toEqual(before);
    const still = JSON.parse((await cli('read', '--json')).out);
    expect(still.messages.map((m: { id: string }) => m.id).sort()).toEqual([ids.bob, ids.carol].sort());
  });
});
