import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { startOnMessageHook } from '../src/plugin/on-message.js';
import { stopProcess } from './helpers/stop-process.js';

/**
 * ADR-051: the plugin interface — `morse watch --json` (events, resumable), the
 * on_message exec hook, and the example plugin (plugins/examples/auto-ack.mjs) run end
 * to end against a temp HOME: it answers your own agents and nobody else.
 */

const repo = resolve(__dirname, '..');
const MORSE_CMD = `${process.execPath} --import ${join(repo, 'node_modules/tsx/dist/loader.mjs')} ${join(repo, 'src/cli.ts')}`;
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function newHome(): { home: string; open: () => Mailbox } {
  const home = mkdtempSync(join(tmpdir(), 'morse-plugin-'));
  homes.push(home);
  mkdirSync(join(home, '.morse'), { recursive: true });
  writeFileSync(join(home, '.morse', 'config.json'), JSON.stringify({ relay: { url: 'ws://127.0.0.1:9', handle: 'me', agent: 'mini', agents: ['mini'] } }));
  const open = () => {
    const ctx = homeContactContext(home);
    return createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
  };
  return { home, open };
}

const cli = (home: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const [bin, ...pre] = MORSE_CMD.split(' ');
    const p = spawn(bin!, [...pre, ...args], { env: { ...process.env, MORSE_HOME: home } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err }));
  });

const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

const fromBob = (mb: Mailbox, text: string) => mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: { agent: 'mini', sessionId: 'inbox' }, text, fromTier: 'peer' });
const fromMyLaptop = (mb: Mailbox, text: string) => mb.send({ from: { agent: 'claude', sessionId: 's9', device: 'me/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text, fromTier: 'owner' });

describe('morse watch --json (ADR-051)', () => {
  it('one line per received message (in + internal, never outbound) and per new request — resumable with --since', async () => {
    const { home, open } = newHome();
    const mb = open();
    const t0 = new Date(Date.now() - 1000).toISOString();
    const a = fromBob(mb, 'hello from bob');
    mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'mbp', sessionId: '', device: 'bob/mbp' }, text: 'outbound' });
    const b = mb.send({ from: { agent: 'claude', sessionId: 's1' }, to: { agent: 'codex', sessionId: 's2' }, text: 'between my sessions' });
    mb.requests.file({ handle: 'zed', deviceId: 'D', msgId: 'r1', from: { agent: 'claude', sessionId: '' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'SECRET request text', droppedFiles: 0, via: 'morse-relay' });
    const r = await cli(home, 'watch', '--json', '--once', '--since', t0);
    expect(r.code, r.err).toBe(0);
    const events = r.out.trim().split('\n').map((l) => JSON.parse(l));
    expect(events.map((e) => [e.type, e.id ?? e.handle])).toEqual([
      ['message', a.id],
      ['message', b.id],
      ['request', 'zed'],
    ]);
    expect(events[0]).toMatchObject({ direction: 'in', contact: { id: 'c:bob', handle: 'bob', group: 'other', self: false }, agent: 'mini', peerAgent: 'mbp', hasFiles: false, foreign: true, text: 'hello from bob', contextId: a.contextId });
    expect(events[1]).toMatchObject({ direction: 'internal', contact: { id: 'self', group: 'self' } });
    expect(r.out).not.toContain('SECRET request text');
    // resume after a: only b (the request is time-scoped, filed after t0 too)
    const r2 = await cli(home, 'watch', '--json', '--once', '--since', a.id);
    expect(r2.out.trim().split('\n').map((l) => JSON.parse(l).id ?? 'req')).toEqual([b.id, 'req']);
  });
});

describe('on_message exec hook (ADR-051)', () => {
  it('runs the command per event with the JSON on stdin, keeps a cursor across restarts, kills a slow one', async () => {
    const { home, open } = newHome();
    const mb = open();
    const outFile = join(home, 'events.jsonl');
    const cursorFile = join(home, '.morse', 'on-message.cursor');
    const logs: string[] = [];
    let cfg: { command: string; timeoutSec?: number } | null = { command: `cat >> '${outFile}'` };
    const hook = startOnMessageHook({ mailbox: mb, config: () => cfg, cursorFile, log: (l) => logs.push(l), intervalMs: 60_000 });
    const m1 = fromBob(mb, 'one');
    hook.tick();
    await hook.idle();
    hook.stop();
    expect(readFileSync(outFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id)).toEqual([m1.id]);

    // a restart: what arrived while it was down comes, nothing twice
    const m2 = fromMyLaptop(mb, 'two');
    const again = startOnMessageHook({ mailbox: mb, config: () => cfg, cursorFile, log: (l) => logs.push(l), intervalMs: 60_000 });
    again.tick();
    await again.idle();
    expect(readFileSync(outFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id)).toEqual([m1.id, m2.id]);

    // a hook that hangs is killed after its timeout; delivery never waited for it
    cfg = { command: 'sleep 5', timeoutSec: 0.3 };
    fromBob(mb, 'three');
    const t = Date.now();
    again.tick();
    expect(Date.now() - t).toBeLessThan(200);
    await again.idle();
    again.stop();
    expect(logs.join('\n')).toMatch(/on_message: killed after 0.3 s/);
  });
});

describe('the example plugin, end to end (docs/PLUGINS.md)', () => {
  it('auto-ack answers your own agents (group self) and never another person', async () => {
    const { home, open } = newHome();
    const mb = open();
    const since = new Date(Date.now() - 1000).toISOString();
    const plugin = spawn(process.execPath, [join(repo, 'plugins/examples/auto-ack.mjs'), '--since', since], { env: { ...process.env, MORSE_HOME: home, MORSE_CMD } });
    let err = '';
    plugin.stderr.on('data', (d) => (err += String(d)));
    try {
      const bob = fromBob(mb, 'hi from bob');
      const mine = fromMyLaptop(mb, 'note from my laptop');
      const loop = fromMyLaptop(mb, '[auto] received');
      // even when bob is labelled a colleague, only "self" is answered
      mb.contacts.set('c:bob', { group: 'colleague' });
      await until(() => mb.getMessage(mine.id)?.processedAt !== undefined);
      await new Promise((r) => setTimeout(r, 1500)); // give it time to (wrongly) handle the others
      const replies = mb.inbox({ all: true }).filter((m) => m.direction === 'out');
      expect(replies.map((m) => [m.parts[0]!.text, m.to.device, m.contextId])).toEqual([['[auto] received', 'me/air', mine.contextId]]);
      expect(mb.getMessage(mine.id)).toMatchObject({ processedBy: 'plugin:auto-ack' });
      expect(mb.getMessage(bob.id)?.processedAt).toBeUndefined();
      expect(mb.getMessage(loop.id)?.processedAt).toBeUndefined();
      expect(err).toContain(`answered ${mine.id}`);
    } finally {
      // the example plugin has no shutdown code: its `morse plugin watch` ends by itself once it is gone
      await stopProcess(plugin);
    }
  }, 30_000);
});

describe('morse plugin watch stops when nobody reads it any more', () => {
  const [bin, ...pre] = MORSE_CMD.split(' ');
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** A "plugin": starts `morse plugin watch --json` the way plugins do, prints its pid and every line it reads, and lives on. */
  const reader = (home: string, tellPid: boolean) =>
    spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         const env = { ...process.env${tellPid ? ', MORSE_WATCH_PARENT: String(process.pid)' : ''} };
         const w = spawn(${JSON.stringify(bin)}, ${JSON.stringify([...pre, 'plugin', 'watch', '--json', '--since', '2020-01-01T00:00:00Z', '--interval', '100'])}, { stdio: ['ignore', 'pipe', 'inherit'], env });
         console.log('pid ' + w.pid);
         w.stdout.on('data', (d) => process.stdout.write(d));
         setInterval(() => {}, 1000);`,
      ],
      { env: { ...process.env, MORSE_HOME: home } },
    );

  it('its reader was killed (and could not stop it): it ends within a moment instead of polling for ever', async () => {
    const { home, open } = newHome();
    fromBob(open(), 'one');
    const plugin = reader(home, false);
    let out = '';
    plugin.stdout.on('data', (d) => (out += String(d)));
    try {
      // it printed the event: it is past start-up, in its polling loop
      await until(() => /^pid \d+$/m.test(out) && out.includes('"type":"message"'));
      const pid = Number(/^pid (\d+)$/m.exec(out)![1]);
      expect(alive(pid)).toBe(true);
      plugin.kill('SIGKILL');
      await until(() => !alive(pid), 10_000);
    } finally {
      await stopProcess(plugin, { signal: 'SIGKILL' });
    }
  }, 30_000);

  it('told who reads it (MORSE_WATCH_PARENT, as the built-in plugins do): also when that process dies while it is still starting', async () => {
    const { home } = newHome();
    const plugin = reader(home, true);
    let out = '';
    plugin.stdout.on('data', (d) => (out += String(d)));
    try {
      await until(() => /^pid \d+$/m.test(out));
      const pid = Number(/^pid (\d+)$/m.exec(out)![1]);
      plugin.kill('SIGKILL'); // at once: `morse` is still loading
      await until(() => !alive(pid), 10_000);
    } finally {
      await stopProcess(plugin, { signal: 'SIGKILL' });
    }
  }, 30_000);
});
