import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { daemonJson } from './helpers/local-api.js';

/**
 * `morse send morse.talk/<handle>` printed `cannot resolve target … (invalid_target)` although
 * the daemon queued and delivered the message: a first contact makes the daemon ask the relay
 * (up to its 15 s request timeout), the CLI gave up after exactly 15 s, took that for "daemon
 * not running" and tried to resolve the address as a LOCAL session.
 */

const repo = resolve(__dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'morse-send-cli-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const cli = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; out: string }>((done) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: repo, env: { ...process.env, MORSE_HOME: home, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (out += String(d)));
    p.on('close', (code) => done({ code, out }));
  });

describe('morse send to a person', () => {
  it('a slow daemon answer is not mistaken for "daemon offline" (no invalid_target)', async () => {
    // a daemon that takes its time (asking the relay), then queues the message
    const server: Server = createServer((req, res) => {
      req.resume();
      setTimeout(() => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { id: 'm1', parts: [] }, resolvedTarget: { agent: 'inbox', title: 'inbox', sessionId: '', device: 'k7f3a9xq' } }));
      }, 1500);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = String((server.address() as { port: number }).port);
      daemonJson(home, port); // (ADR-087: this home's daemon listens there — a command talks to no other)
      const r = await cli(['send', 'morse.talk/k7f3a9xq', 'hello', '--port', port], { MORSE_SEND_TIMEOUT_MS: '300' });
      expect(r.out).not.toContain('invalid_target');
      expect(r.out).toContain('did not answer within');
      expect(r.out).toContain('may still have been queued');
      expect(r.code).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it('with no daemon running it says so, instead of resolving morse.talk/… as a local session', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = String((probe.address() as { port: number }).port);
    await new Promise<void>((r) => probe.close(() => r())); // nobody listens there now
    daemonJson(home, port); // (a daemon.json left behind: the daemon it names is gone)
    const r = await cli(['send', 'morse.talk/k7f3a9xq', 'hello', '--port', port]);
    expect(r.out).not.toContain('invalid_target');
    expect(r.out).toContain('the daemon is not running');
    expect(r.code).toBe(1);
  }, 30_000);
});
