import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBlocked } from '../src/cluster/blocklist.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { countSpawn, enforceSpawnBudget, spawnBudget } from './helpers/spawn-budget.js';

/**
 * ADR-050: the messaging commands, run as the real CLI against a temp HOME —
 * contacts / contact set / inbox (to process) / history / read / reply / done /
 * requests reject|block / block / send <remark>. Every one with --json.
 */

enforceSpawnBudget();
const repo = resolve(__dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'morse-core-cmds-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    countSpawn();
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: repo, env: { ...process.env, MORSE_HOME: home } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err }));
  });
const json = async (...args: string[]) => {
  const r = await cli(...args, '--json');
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out) as Record<string, any>;
};

let ids: { bob: string; own: string; out: string };
const open = (): Mailbox => {
  const ctx = homeContactContext(home);
  return createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
};

beforeAll(() => {
  mkdirSync(join(home, '.morse'), { recursive: true });
  writeFileSync(join(home, '.morse', 'config.json'), JSON.stringify({ relay: { url: 'ws://127.0.0.1:9', handle: 'me', agent: 'mini', agents: ['mini'] } }));
  const mb = open();
  const bob = mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'can you look at the API?', fromTier: 'peer' });
  const own = mb.send({ from: { agent: 'claude', sessionId: 'x', device: 'me/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'note to self', fromTier: 'owner' });
  const out = mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'mbp', sessionId: '', device: 'bob/mbp' }, text: 'earlier question', contextId: bob.contextId });
  mb.requests.file({ handle: 'zed', deviceId: 'D', msgId: 'r1', from: { agent: 'claude', sessionId: '' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'hello stranger', droppedFiles: 0, via: 'morse-relay' });
  ids = { bob: bob.id, own: own.id, out: out.id };
});

describe('messaging commands (ADR-050)', () => {
  it('contacts, labels, the to-process inbox, history and read', { timeout: spawnBudget(6) }, async () => {
    const c = await json('contacts');
    expect(c['requests']).toBe(1);
    expect(c['contacts'].map((x: any) => [x.id, x.group, x.unread, x.self])).toEqual([
      ['self', 'self', 1, true],
      ['c:bob', 'other', 1, false],
    ]);

    const set = await json('contact', 'set', 'morse.im/bob', '--name', 'Bob', '--group', 'colleague');
    expect(set['contact']).toMatchObject({ remark: 'Bob', group: 'colleague', address: 'morse.im/bob' });

    const inbox = await json('inbox');
    expect(inbox['requests']).toBe(1);
    expect(inbox['messages'].map((m: any) => [m.id, m.direction, m.contact.group, m.foreign, m.agent, m.peerAgent])).toEqual([
      [ids.bob, 'in', 'colleague', true, 'mini', 'mbp'],
      [ids.own, 'in', 'self', true, 'mini', 'air'], // (ADR-091 follow-up) from another computer: a peer's, whatever tier is stored
    ]);
    expect(inbox['unread']).toEqual(expect.arrayContaining([expect.objectContaining({ contact: 'c:bob', remark: 'Bob', count: 1 })]));

    const h = await json('history', 'bob'); // remark, any case
    expect(h['messages'].map((m: any) => [m.id, m.direction])).toEqual([
      [ids.bob, 'in'],
      [ids.out, 'out'],
    ]);
    const read = await json('read', ids.bob.slice(0, 8));
    expect(read['message']).toMatchObject({ id: ids.bob, text: 'can you look at the API?', processed: false });

    const plain = await cli('inbox');
    expect(plain.out).toMatch(/2 to process/);
    expect(plain.out).toMatch(/1 message request/);
  });

  it('reply goes to the contact + agent (no session id) and marks the original processed; done empties the inbox', { timeout: spawnBudget(5) }, async () => {
    const r = await json('reply', ids.bob, 'yes, looking now');
    expect(r['sent']).toBe(true);
    expect(r['message']).toMatchObject({ direction: 'out', to: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, contact: { id: 'c:bob' } });
    expect((await json('read', ids.bob))['message']).toMatchObject({ processed: true, processedBy: 'reply' });
    const d = await json('done', ids.own, 'nope-0000');
    expect(d).toEqual({ done: [ids.own], skipped: ['nope-0000'] });
    expect((await json('inbox'))['messages']).toEqual([]);
    // an outbound message is never "done"
    expect((await json('done', ids.out))['done']).toEqual([]);
  });

  it('requests reject (no block) vs block; block / unblock a contact', { timeout: spawnBudget(3) }, async () => {
    expect(await json('requests', 'reject', 'morse.im/zed')).toMatchObject({ rejected: true });
    expect(isBlocked('zed', home)).toBe(false);
    const b = await json('block', 'Bob');
    expect(b['contact']).toMatchObject({ id: 'c:bob', state: 'blocked' });
    expect(isBlocked('bob', home)).toBe(true);
    expect((await json('unblock', 'bob'))['contact']).toMatchObject({ state: 'active' });
    expect(isBlocked('bob', home)).toBe(false);
  });

  it('send by the remark of a contact known only by an old name: one line, ask for their address (ADR-091)', { timeout: spawnBudget(1) }, async () => {
    const { createServer } = await import('node:net');
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = String((srv.address() as { port: number }).port);
    await new Promise((r) => srv.close(r)); // nobody listens there now
    const r = await cli('send', 'Bob/mbp', 'hi', '--port', port);
    expect(r.code).toBe(1);
    expect(r.err).toContain('old names no longer work — ask for their 26-character address (morse address shows it)');
    expect(r.err.trim().split('\n')).toHaveLength(1);
  });

  it('a remark may not be a `contact` verb (ADR-074): add and set refuse it, any case, and change nothing', { timeout: spawnBudget(15) }, async () => {
    // every one is refused and changes nothing, so they do not depend on each other: run them
    // together (14 CLI processes one after the other do not fit the test timeout on a busy machine)
    await Promise.all(
      ['add', 'set', 'remove', 'accept', 'reject', 'block', 'unblock'].flatMap((verb) => [
        cli('contact', 'add', 'morse.im/23456789abcdefghjkmnpqrstv', '--name', verb.toUpperCase()).then((a) => {
          expect(a.code, verb).toBe(1);
          expect(a.err).toContain(`error: "${verb.toUpperCase()}" is a command word — pick another remark`);
        }),
        cli('contact', 'set', 'bob', '--name', ` ${verb} `).then((s) => {
          expect(s.code, verb).toBe(1);
          expect(s.err).toContain(`error: "${verb}" is a command word — pick another remark`);
        }),
      ]),
    );
    expect(open().contacts.find('morse.im/23456789abcdefghjkmnpqrstv')).toBeNull(); // the refused add created nothing
    expect(open().contacts.find('bob')?.remark).toBe('Bob');
    // a remark that only contains a verb is fine
    expect((await json('contact', 'add', 'morse.im/23456789abcdefghjkmnpqrstv', '--name', 'adder'))['contact']).toMatchObject({ remark: 'adder' });
  });
});
