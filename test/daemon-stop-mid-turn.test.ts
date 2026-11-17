import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { POSSIBLE_REPEAT_LINE, REPLY_MARKER } from '../src/envelope.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { stopProcess } from './helpers/stop-process.js';

/**
 * ADR-089, the review's own method: a REAL daemon (`morse start`, a temp MORSE_HOME + HOME, its own port, no
 * relay, no LAN), the REAL dispatch plugin it supervises, and a stub `claude` on PATH that takes a few seconds
 * per turn. The daemon is stopped — and, in the second test, killed — in the middle of a turn.
 *
 * None of the in-process tests could see what the review found here: the daemon's shutdown signalled its
 * plugins twice, and the dispatch plugin gave up its turn on the second signal (F1); a plugin whose daemon
 * was killed went on claiming (F3).
 */

const repo = resolve(__dirname, '..');
const TSX = join(repo, 'node_modules/tsx/dist/loader.mjs');
const SID = 'aaaa1111-0000-4000-8000-00000000000a';
const SID2 = 'bbbb2222-0000-4000-8000-00000000000b';

const homes: string[] = [];
const started: ChildProcess[] = [];
const strayPids = new Set<number>();
const alive = (pid: number): boolean => {
  try {
    return process.kill(pid, 0), true;
  } catch {
    return false;
  }
};
afterAll(async () => {
  for (const c of started) await stopProcess(c, { signal: 'SIGKILL', graceMs: 1000 });
  for (const pid of strayPids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};

interface Home {
  home: string;
  env: NodeJS.ProcessEnv;
  calls: () => Array<{ at: number; pid: number; prompt: string }>;
  ends: () => number;
  open: () => Mailbox;
  log: () => string;
}

/** A home with two Claude sessions of the owner's and a stub `claude` that needs `turnMs` per turn. */
function newHome(turnMs: number, launch?: unknown[]): Home {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'morse-stop-turn-')));
  homes.push(home);
  const work = join(home, 'work');
  mkdirSync(join(home, '.morse'), { recursive: true });
  mkdirSync(work, { recursive: true });
  // no relay (nothing leaves this computer); only the dispatch plugin
  writeFileSync(join(home, '.morse', 'config.json'), JSON.stringify({ plugins: { attendant: { enabled: false }, ...(launch ? { dispatch: { launch } } : {}) } }));
  const proj = join(home, '.claude', 'projects', '-work');
  mkdirSync(proj, { recursive: true });
  for (const sid of [SID, SID2]) writeFileSync(join(proj, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', cwd: work, message: { content: `session ${sid.slice(0, 4)}` } })}\n`);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const callsFile = join(home, 'claude-calls.jsonl');
  const endsFile = join(home, 'claude-ends.log');
  writeFileSync(
    join(bin, 'claude'),
    `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ at: Date.now(), pid: process.pid, prompt: a[a.length - 1] }) + '\\n');
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(endsFile)}, process.pid + '\\n');
  console.log('worked on it\\n${REPLY_MARKER} DONE finished the job');
}, ${turnMs});
`,
  );
  chmodSync(join(bin, 'claude'), 0o755);
  const env = { ...process.env, HOME: home, USERPROFILE: home, MORSE_HOME: home, ANYTOANY_HOME: home, MORSE_NOTIFY: '0', PATH: `${bin}:${process.env['PATH']}`, MORSE_DISPATCH_INTERVAL_MS: '300' };
  delete (env as Record<string, unknown>)['MORSE_CMD_JSON'];
  delete (env as Record<string, unknown>)['MORSE_DAEMON_PID'];
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
  return {
    home,
    env,
    calls: () => lines(callsFile).map((l) => JSON.parse(l) as { at: number; pid: number; prompt: string }),
    ends: () => lines(endsFile).length,
    open: () => {
      const ctx = homeContactContext(home);
      return createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
    },
    log: () => '',
  };
}

/** `morse start` in the foreground, on its own port. Resolves once the dispatch plugin is up. */
async function startDaemon(h: Home): Promise<{ child: ChildProcess; pid: number; out: () => string; exited: () => boolean; pluginPid: () => number }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', TSX, join(repo, 'src/cli.ts'), 'start', '--no-lan', '--no-notify', '--port', String(port)], { env: h.env, cwd: h.home, stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(child);
  let out = '';
  child.stdout!.on('data', (d) => (out += String(d)));
  child.stderr!.on('data', (d) => (out += String(d)));
  let exited = false;
  child.on('exit', () => (exited = true));
  await until(() => /morse-plugin-dispatch started/.test(out) || exited, 60_000, `the daemon and its dispatch plugin\n${out}`);
  expect(exited, out).toBe(false);
  // the listener is this daemon's own: daemon.json of THIS home names this process and this port
  const info = JSON.parse(readFileSync(join(h.home, '.morse', 'daemon.json'), 'utf8')) as { pid: number; port: number };
  expect(info).toMatchObject({ pid: child.pid, port });
  const pluginPid = () => Number([...out.matchAll(/plugin dispatch: started \(pid (\d+)\)/g)].pop()?.[1] ?? 0);
  strayPids.add(pluginPid());
  return { child, pid: child.pid!, out: () => out, exited: () => exited, pluginPid };
}

const send = (mb: Mailbox, sid: string, text: string) => mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'claude', sessionId: sid }, text });
const repliesTo = (mb: Mailbox, sid: string) =>
  mb
    .inbox({ all: true })
    .filter((m) => m.from.sessionId === sid)
    .map((m) => m.parts[0]!.text);

describe('a real daemon stopped in the middle of an agent turn (ADR-089 review F1)', () => {
  it('SIGTERM one second into a 5 s turn: the daemon waits for the turn, the plugin acks, the answer is filed — one delivery, nothing to repeat', async () => {
    const h = newHome(5000);
    const mb = h.open();
    const d = await startDaemon(h);
    const m = send(mb, SID, 'tidy the changelog');
    await until(() => h.calls().length === 1, 30_000, `the turn to start\n${d.out()}`);
    await sleep(1000);
    const t0 = Date.now();
    process.kill(d.pid, 'SIGTERM');
    // it is NOT gone at once (it used to be, within 0.3 s — and the turn was left alone)
    await sleep(1500);
    expect(d.exited(), d.out()).toBe(false);
    expect(alive(d.pluginPid())).toBe(true);
    // a second SIGTERM while it waits (systemd signals the whole group; an impatient `morse stop`) changes nothing
    process.kill(d.pid, 'SIGTERM');
    process.kill(d.pluginPid(), 'SIGTERM');
    await sleep(500);
    expect(d.exited(), d.out()).toBe(false);
    expect(alive(d.pluginPid())).toBe(true);
    await until(() => d.exited(), 20_000, `the daemon to stop\n${d.out()}`);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThan(3000); // the rest of the turn
    expect(took).toBeLessThan(14_000); // …and no longer than the plugin's grace

    expect(h.calls()).toHaveLength(1);
    expect(h.ends()).toBe(1); // the turn ran to its end
    const after = mb.getMessage(m.id)!;
    expect(after, d.out()).toMatchObject({ status: 'delivered', processedBy: 'plugin:dispatch' });
    expect(after.lease).toBeUndefined();
    expect(after.possibleRepeat).toBeUndefined();
    expect(repliesTo(mb, SID)).toEqual(['DONE finished the job']);
    expect(d.out()).toMatch(/stopping: waiting up to 10 s for 1 running turn/);
    expect(alive(d.pluginPid())).toBe(false);
    expect(h.calls()[0]!.prompt).not.toContain(POSSIBLE_REPEAT_LINE);
  }, 120_000);
});

describe('a real daemon KILLED in the middle of a turn (ADR-089 review F3)', () => {
  it('its plugin stops claiming at once and finishes its turn; the next message is delivered by the new daemon, once, as a first delivery', async () => {
    const h = newHome(6000);
    const mb = h.open();
    const d1 = await startDaemon(h);
    const oldPlugin = d1.pluginPid();
    const first = send(mb, SID, 'first job');
    await until(() => h.calls().length === 1, 30_000, `the first turn to start\n${d1.out()}`);
    await sleep(500);
    process.kill(d1.pid, 'SIGKILL');
    await until(() => !alive(d1.pid), 5000, 'the daemon to be gone');
    // a message that arrives now must NOT be claimed by the plugin of the dead daemon (it polls every 300 ms)
    const second = send(mb, SID2, 'second job');
    await sleep(2500);
    expect(mb.getMessage(second.id)!.status).toBe('pending');
    expect(h.calls()).toHaveLength(1);
    expect(alive(oldPlugin)).toBe(true); // …it is still there: finishing its turn

    // the new daemon, started right away
    const d2 = await startDaemon(h);
    await until(() => mb.getMessage(first.id)!.status === 'delivered', 30_000, `the old plugin to report its turn\n${d1.out()}`);
    await until(() => mb.getMessage(second.id)!.status === 'delivered', 45_000, `the second message\n${d2.out()}`);
    await until(() => !alive(oldPlugin), 15_000, 'the old plugin to leave');
    // (the answer is filed right after the ack)
    await until(() => repliesTo(mb, SID).length > 0 && repliesTo(mb, SID2).length > 0, 15_000, `both answers\n${d2.out()}`);

    const calls = h.calls();
    expect(calls.map((c) => /first job/.test(c.prompt))).toEqual([true, false]); // two turns in all: one each
    expect(calls[1]!.prompt).toContain('second job');
    expect(calls[1]!.prompt).not.toContain(POSSIBLE_REPEAT_LINE);
    expect(mb.getMessage(first.id)!.possibleRepeat).toBeUndefined();
    expect(mb.getMessage(second.id)!.possibleRepeat).toBeUndefined();
    expect(repliesTo(mb, SID)).toEqual(['DONE finished the job']);
    expect(repliesTo(mb, SID2)).toEqual(['DONE finished the job']);
    // (what the old plugin logged about it went to the dead daemon's pipe: nobody reads it — its exit above is the evidence)

    process.kill(d2.pid, 'SIGTERM');
    await until(() => d2.exited(), 20_000, 'the second daemon to stop');
  }, 180_000);
});

describe('an agent turn ended by a signal while the plugin lives (ADR-089 review N1)', () => {
  it('SIGTERM to the agent CLI in the middle of its turn — ordinary session and `plain` profile alike: not a failure, not dead; delivered again with the repeat line, answered once', async () => {
    // SID2 is the owner's own channel (`prompt: "plain"`): its failures are final — an interruption must not be one
    const h = newHome(4000, [{ agent: 'claude', session: SID2, prompt: 'plain' }]);
    const mb = h.open();
    const d = await startDaemon(h);
    const a = send(mb, SID, 'job for the ordinary session');
    const b = send(mb, SID2, 'job for the plain session');
    await until(() => h.calls().length === 2, 30_000, `both turns to start\n${d.out()}`);
    await sleep(800);
    // what launchd does to a job's processes when its daemon is gone, what systemd does on a restart, what `kill` does
    for (const c of h.calls()) process.kill(c.pid, 'SIGTERM');
    await until(() => h.calls().length === 4, 30_000, `both to be delivered again\n${d.out()}`);
    for (const m of [a, b]) {
      const row = mb.getMessage(m.id)!;
      expect(row.status, d.out()).not.toBe('dead');
      expect(row.attempts).toBe(0); // no failure was reported
      expect(row.possibleRepeat).toBe(true);
    }
    const again = h.calls().slice(2);
    expect(again.map((c) => c.prompt.includes(POSSIBLE_REPEAT_LINE))).toEqual([true, true]);
    expect(again.map((c) => /job for the (ordinary|plain) session/.test(c.prompt))).toEqual([true, true]);
    await until(() => mb.getMessage(a.id)!.status === 'delivered' && mb.getMessage(b.id)!.status === 'delivered', 30_000, `both delivered\n${d.out()}`);
    await until(() => repliesTo(mb, SID).length > 0 && repliesTo(mb, SID2).length > 0, 15_000, 'both answers');
    expect(repliesTo(mb, SID)).toEqual(['DONE finished the job']);
    expect(repliesTo(mb, SID2)).toHaveLength(1);
    expect(h.calls()).toHaveLength(4);
    expect(d.out()).toMatch(/interrupted .* — the agent CLI was ended by a signal \(SIGTERM\) — not reported as a failure/);
    expect(d.out()).not.toMatch(/ failed [0-9a-f]{8} /);
    process.kill(d.pid, 'SIGTERM');
    await until(() => d.exited(), 20_000, 'the daemon to stop');
  }, 180_000);
});

describe('`morse stop --restart` (ADR-089 review N1) — in a temp home, where no service manager runs the daemon', () => {
  const cli = (h: Home, ...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const p = spawn(process.execPath, ['--import', TSX, join(repo, 'src/cli.ts'), ...args], { env: h.env, cwd: h.home, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout!.on('data', (x) => (out += String(x)));
      p.stderr!.on('data', (x) => (out += String(x)));
      p.on('close', (code) => done({ code, out }));
    });

  it('a daemon started by hand is stopped in its orderly way and the caller is told that nobody starts it again; no daemon: said, nothing started — never the service manager\'s job of another home', async () => {
    const h = newHome(100);
    const none = await cli(h, 'stop', '--restart');
    expect(none.out.trim()).toBe('daemon not running — start it: morse start');
    expect(none.code).toBe(0);
    const d = await startDaemon(h);
    const r = await cli(h, 'stop', '--restart');
    expect(r.out).toContain(`sent SIGTERM to daemon (pid ${d.pid})`);
    expect(r.out).toContain('the daemon was started by hand — nobody starts it again for you: morse start');
    expect(r.out).not.toMatch(/launchd|systemd/);
    await until(() => d.exited(), 20_000, `the daemon to stop\n${d.out()}`);
    expect(d.out()).toContain('morse daemon stopping');
    // `morse stop` without the option says what it always said
    const plain = await cli(h, 'stop');
    expect(plain.out).not.toContain('started by hand');
  }, 120_000);
});
