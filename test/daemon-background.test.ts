import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startInBackground, waitUntilUp } from '../src/daemon/background.js';
import { startConsoleServer } from '../src/daemon/server.js';
import { requestShutdown, stopWithoutSignals, type StopDeps } from '../src/daemon/stop.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import { TEST_TOKEN } from './helpers/local-api.js';

/**
 * ADR-080: a daemon that runs without a service manager and stops without a signal.
 *   - `morse start --background` puts the daemon in the background itself (Windows has no
 *     launchd / systemd; a scheduled task runs this at logon);
 *   - `POST /api/shutdown` is the orderly stop (on Windows SIGTERM kills at once: no cleanup,
 *     plugins left behind) — loopback only AND a token only this user can read;
 *   - `morse stop` on Windows: that request, wait, and only then end the process tree.
 * On macOS / Linux `morse stop` still sends SIGTERM, with the same output as before.
 */

const repo = resolve(__dirname, '..');
const roots: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-bg-'));
  roots.push(h);
  return h;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
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
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(50);
  return cond();
};

describe('POST /api/shutdown — the orderly stop that needs no signal', () => {
  const start = async (shutdown?: { token: string; run: () => void }) => {
    const port = await freePort();
    // (ADR-087) the stop request is authorised like every other route: by the daemon token
    const server = startConsoleServer({ token: shutdown?.token ?? TEST_TOKEN, mailbox: createMailbox(createDb(':memory:')), directory: async () => [], port, changePollMs: 60_000, ...(shutdown ? { shutdown: { run: shutdown.run } } : {}) });
    await sleep(50);
    return { port, server, url: `http://127.0.0.1:${port}/api/shutdown` };
  };

  it('with the token: answers 202 with the pid, then runs the shutdown once', async () => {
    let ran = 0;
    const s = await start({ token: 'secret-token-1', run: () => ran++ });
    try {
      const r = await fetch(s.url, { method: 'POST', headers: { 'x-morse-token': 'secret-token-1' } });
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ ok: true, pid: process.pid });
      expect(await until(() => ran === 1, 2000)).toBe(true);
    } finally {
      s.server.close();
    }
  });

  it('without the token, with a wrong one, or of another length: 401, nothing runs — a web page cannot stop the daemon', async () => {
    let ran = 0;
    const s = await start({ token: 'secret-token-1', run: () => ran++ });
    try {
      for (const headers of [{}, { 'x-morse-token': 'secret-token-2' }, { 'x-morse-token': 'secret' }, { 'x-morse-token': '' }] as Array<Record<string, string>>) {
        const r = await fetch(s.url, { method: 'POST', headers });
        expect(r.status).toBe(401);
      }
      // the token in the URL or the body is not accepted: only the header (a custom header makes a browser ask first)
      expect((await fetch(`${s.url}?token=secret-token-1`, { method: 'POST', body: 'secret-token-1' })).status).toBe(401);
      // a browser's preflight gets no permission
      const pre = await fetch(s.url, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-morse-token' } });
      expect(pre.headers.get('access-control-allow-origin')).toBeNull();
      expect(pre.status).toBe(404);
      expect((await fetch(s.url)).status).toBe(401); // (GET, no token)
      expect((await fetch(s.url, { headers: { 'x-morse-token': 'secret-token-1' } })).status).toBe(404); // (GET with it: no such route)
      await sleep(100);
      expect(ran).toBe(0);
    } finally {
      s.server.close();
    }
  });

  it('a daemon started without the option has no such endpoint', async () => {
    const s = await start();
    try {
      expect((await fetch(s.url, { method: 'POST', headers: { 'x-morse-token': TEST_TOKEN } })).status).toBe(404);
    } finally {
      s.server.close();
    }
  });

  it('requestShutdown: ok with the right token; says why otherwise (refused, nobody listening)', async () => {
    let ran = 0;
    const s = await start({ token: 'tok', run: () => ran++ });
    try {
      expect(await requestShutdown(s.port, 'nope')).toEqual({ ok: false, reason: 'the daemon refused the stop request (401)' });
      expect(await requestShutdown(s.port, 'tok')).toEqual({ ok: true });
    } finally {
      s.server.close();
    }
    const dead = await freePort();
    expect(await requestShutdown(dead, 'tok')).toMatchObject({ ok: false, reason: expect.stringContaining('did not answer') });
  });
});

describe('morse stop without signals (the Windows path, run here against fakes)', () => {
  const world = (o: { pid?: number | null; alive?: boolean; info?: { port: number | null; token?: string } | null; shutdown?: 'ok' | 'refuse' | 'ignore'; kill?: boolean } = {}) => {
    const lines: string[] = [];
    const state = { alive: o.alive ?? true, pidFile: o.pid === undefined ? 4242 : o.pid, killed: 0, asked: [] as Array<[number, string]> };
    const deps: StopDeps = {
      readPid: () => state.pidFile,
      isAlive: () => state.alive,
      clearPid: () => {
        state.pidFile = null;
      },
      readInfo: () => (o.info === null ? null : { pid: 4242, port: 7433, capabilities: [], token: 'tok', ...o.info }),
      request: async (port, token) => {
        state.asked.push([port, token]);
        if (o.shutdown === 'refuse') return { ok: false, reason: 'the daemon refused the stop request (401)' };
        if (o.shutdown !== 'ignore') state.alive = false;
        return { ok: true };
      },
      killTree: () => {
        state.killed++;
        if (o.kill === false) return { ok: false, detail: 'ERROR: Access is denied.' };
        state.alive = false;
        return { ok: true, detail: '' };
      },
      sleep: async () => undefined,
      log: (l) => lines.push(l),
      graceMs: 200,
    };
    return { deps, lines, state };
  };

  it('nothing to stop: no pid file — it does not go looking for processes', async () => {
    const w = world({ pid: null });
    expect(await stopWithoutSignals(w.deps)).toBe('not-running');
    expect(w.lines).toEqual(['daemon not running (no pid file)']);
    expect(w.state.killed).toBe(0);
  });

  it('a pid file of a process that is gone is cleaned up', async () => {
    const w = world({ alive: false });
    expect(await stopWithoutSignals(w.deps)).toBe('not-running');
    expect(w.lines).toEqual(['daemon pid 4242 not alive — cleaning pid file']);
    expect(w.state.pidFile).toBeNull();
  });

  it('orderly: asks the daemon on its own port with its token, waits until the process is gone', async () => {
    const w = world({ info: { port: 7500, token: 'abc' } });
    expect(await stopWithoutSignals(w.deps)).toBe('stopped');
    expect(w.state.asked).toEqual([[7500, 'abc']]);
    expect(w.state.killed).toBe(0);
    expect(w.lines).toEqual(['daemon stopped (pid 4242)']);
    expect(w.state.pidFile).toBeNull();
  });

  it('the daemon took the request but does not go: after the grace period the whole process tree is ended, and it says so', async () => {
    const w = world({ shutdown: 'ignore' });
    expect(await stopWithoutSignals(w.deps)).toBe('killed');
    expect(w.state.killed).toBe(1);
    expect(w.lines.join('\n')).toMatch(/did not stop within .* — ending the process/);
    expect(w.lines.join('\n')).toContain('daemon killed (pid 4242)');
    expect(w.state.pidFile).toBeNull();
  });

  it('no console port, no token (an older daemon), another daemon\'s record, or a refused request: no orderly stop is possible — the process is ended, with the reason', async () => {
    for (const [info, shutdown, reason] of [
      [{ port: null }, undefined, 'it runs without a console (--no-web)'],
      [{ port: 7433, token: undefined }, undefined, 'it has no stop token'],
      [null, undefined, 'it left no daemon.json'],
      [{ port: 7433, pid: 1 }, undefined, 'daemon.json is another process\'s'],
      [{ port: 7433 }, 'refuse', 'the daemon refused the stop request (401)'],
    ] as Array<[Parameters<typeof world>[0] extends infer W ? (W extends { info?: infer I } ? I : never) : never, 'refuse' | undefined, string]>) {
      const w = world({ info: info as never, ...(shutdown ? { shutdown } : {}) });
      expect(await stopWithoutSignals(w.deps), reason).toBe('killed');
      expect(w.lines.join('\n'), reason).toContain(reason);
      expect(w.state.killed, reason).toBe(1);
    }
  });

  it('when the process cannot be ended either, it fails loudly and keeps the pid file', async () => {
    const w = world({ shutdown: 'ignore', kill: false });
    expect(await stopWithoutSignals(w.deps)).toBe('failed');
    expect(w.lines.join('\n')).toContain('Access is denied');
    expect(w.lines.join('\n')).toContain('Task Manager');
    expect(w.state.pidFile).toBe(4242);
  });
});

describe('startInBackground / waitUntilUp', () => {
  it('the child outlives the call, detached, with stdout and stderr appended to the log file', async () => {
    const dir = freshHome();
    const log = join(dir, 'sub', 'daemon.log');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(log, 'earlier line\n');
    const child = startInBackground({ argv: [process.execPath, '-e', 'console.log("out " + process.pid); console.error("err"); setTimeout(() => {}, 300)'], logFile: log, cwd: dir });
    expect(child.pid).toBeGreaterThan(0);
    expect(await until(() => readFileSync(log, 'utf8').includes('err'), 5000)).toBe(true);
    const text = readFileSync(log, 'utf8');
    expect(text.startsWith('earlier line\n')).toBe(true);
    expect(text).toContain(`out ${child.pid}`);
    await until(() => !alive(child.pid!), 5000);
  });

  it('waitUntilUp: up once the pid file names the child; exited when it died first; timeout otherwise', async () => {
    const quick = { sleep: async () => undefined, intervalMs: 1 };
    expect(await waitUntilUp({ child: { pid: 7, exitCode: null }, readPid: () => 7, ...quick })).toBe('up');
    expect(await waitUntilUp({ child: { pid: 7, exitCode: 1 }, readPid: () => null, ...quick })).toBe('exited');
    // another daemon's pid in the file is not ours coming up
    expect(await waitUntilUp({ child: { pid: 7, exitCode: null }, readPid: () => 8, timeoutMs: 5, ...quick })).toBe('timeout');
  });
});

describe('the real daemon: morse start --background, then stopped both ways (temp MORSE_HOME + HOME)', () => {
  const cliAt = (home: string, ...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: repo, env: { ...process.env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (out += String(d)));
      p.on('exit', (code) => done({ code, out }));
    });
  const prepare = () => {
    const home = freshHome();
    mkdirSync(join(home, '.morse'), { recursive: true });
    // no relay configured (nothing leaves this computer) and no plugins: only the core daemon
    writeFileSync(join(home, '.morse', 'config.json'), JSON.stringify({ plugins: { dispatch: { enabled: false }, attendant: { enabled: false } } }));
    return home;
  };
  const info = (home: string) => JSON.parse(readFileSync(join(home, '.morse', 'daemon.json'), 'utf8')) as { pid: number; port: number; token: string; capabilities: string[] };

  it('starts in the background, records a stop token, and stops in an orderly way over HTTP — then again, stopped by `morse stop` (SIGTERM here)', async () => {
    const home = prepare();
    const port = await freePort();
    const started = await cliAt(home, 'start', '--background', '--no-lan', '--no-notify', '--port', String(port));
    expect(started.out).toMatch(/daemon: started in the background \(pid \d+\) — log: .*daemon\.log/);
    expect(started.code).toBe(0);
    const d = info(home);
    try {
      expect(d.port).toBe(port);
      expect(d.token).toMatch(/^[0-9a-f]{48}$/);
      expect(alive(d.pid)).toBe(true);
      expect(readFileSync(join(home, '.morse', 'daemon.pid'), 'utf8')).toBe(String(d.pid));
      expect(readFileSync(join(home, '.morse', 'daemon.log'), 'utf8')).toContain('daemon starting');
      // a second start is not an error, and starts nothing
      const again = await cliAt(home, 'start', '--background', '--no-lan', '--port', String(port));
      expect(again.out).toContain(`daemon already running (pid ${d.pid})`);
      expect(again.code).toBe(0);
      // without the token the daemon stays
      expect(await requestShutdown(port, 'not-the-token')).toMatchObject({ ok: false });
      expect(alive(d.pid)).toBe(true);
      // the orderly stop: the same shutdown the signal handler runs
      expect(await requestShutdown(port, d.token)).toEqual({ ok: true });
      expect(await until(() => !alive(d.pid))).toBe(true);
      expect(readFileSync(join(home, '.morse', 'daemon.log'), 'utf8')).toContain('morse daemon stopping');
      expect(existsSync(join(home, '.morse', 'daemon.pid'))).toBe(false);
      expect(existsSync(join(home, '.morse', 'daemon.json'))).toBe(false);
    } finally {
      if (alive(d.pid)) process.kill(d.pid, 'SIGKILL');
    }

    // macOS / Linux: `morse stop` is unchanged — SIGTERM, the same line as before
    const second = await cliAt(home, 'start', '--background', '--no-wait', '--no-lan', '--no-notify', '--port', String(port));
    expect(second.out).toMatch(/daemon: starting in the background \(pid \d+\)/);
    expect(second.code).toBe(0);
    expect(await until(() => existsSync(join(home, '.morse', 'daemon.json')), 20_000)).toBe(true);
    const d2 = info(home);
    try {
      const stopped = await cliAt(home, 'stop');
      expect(stopped.out).toContain(`sent SIGTERM to daemon (pid ${d2.pid})`);
      expect(await until(() => !alive(d2.pid))).toBe(true);
    } finally {
      if (alive(d2.pid)) process.kill(d2.pid, 'SIGKILL');
    }
  }, 90_000);

  it('a daemon that cannot start says so, with the end of its log', async () => {
    const home = prepare();
    // something else holds the console port: the daemon refuses to start
    const blocker = createServer((socket) => socket.destroy());
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as { port: number }).port;
    try {
      const r = await cliAt(home, 'start', '--background', '--no-lan', '--no-notify', '--port', String(port));
      expect(r.code).toBe(1);
      expect(r.out).toContain('the daemon did not start');
      expect(r.out).toContain('daemon.log');
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  }, 60_000);
});
