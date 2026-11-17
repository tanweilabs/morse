import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * src/plugin/cli-client.ts — how a plugin process stops: no new `morse` command, and the
 * ones in flight finish before it exits. A command that outlived its plugin kept reading
 * and writing the Morse home with nobody to take its answer (in tests: it re-created
 * files in a temp home that was being removed).
 */

const dir = mkdtempSync(join(tmpdir(), 'morse-cli-client-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for `morse`: waits `ms`, writes a file (so we can see it finished), prints its last argument. */
const slow = (ms: number, mark: string) => [
  process.execPath,
  '-e',
  `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(join(dir, mark))}, ''); console.log(process.argv.at(-1)); }, ${ms})`,
  '--',
];

type Client = typeof import('../src/plugin/cli-client.js');
let client: Client;
beforeEach(async () => {
  vi.resetModules(); // "stopping" is for the life of a plugin process: a fresh module per test
  client = await import('../src/plugin/cli-client.js');
});

describe('a plugin that is stopping', () => {
  it('finishCommands waits for the commands in flight, and they complete', async () => {
    const first = client.runMorse(['one'], slow(300, 'first'));
    const second = client.runMorse(['two'], slow(600, 'second'));
    const t0 = Date.now();
    await client.finishCommands(5000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect(existsSync(join(dir, 'first'))).toBe(true);
    expect(existsSync(join(dir, 'second'))).toBe(true);
    expect(await first).toMatchObject({ code: 0, out: 'one\n' });
    expect(await second).toMatchObject({ code: 0, out: 'two\n' });
  });

  it('starts no new command once it is stopping', async () => {
    await client.finishCommands(1000); // nothing in flight: at once
    const r = await client.runMorse(['late'], slow(0, 'late'));
    expect(r).toEqual({ code: 1, out: '', err: client.STOPPING });
    await new Promise((res) => setTimeout(res, 300));
    expect(existsSync(join(dir, 'late'))).toBe(false);
    // the typed client reports it as the command's error
    await expect(client.createCliClient({ cmd: slow(0, 'late-claim') }).claimNext()).rejects.toThrow(/stopping/);
    expect(existsSync(join(dir, 'late-claim'))).toBe(false);
  });

  it('a command that is still running after the timeout is stopped — none outlives the plugin', async () => {
    const hang = client.runMorse(['hang'], slow(1500, 'hang'));
    const t0 = Date.now();
    await client.finishCommands(300);
    expect(Date.now() - t0).toBeLessThan(1200);
    expect((await hang).code).not.toBe(0); // it was stopped, not finished
    await new Promise((res) => setTimeout(res, 1500));
    expect(existsSync(join(dir, 'hang'))).toBe(false); // it never got to write
  });

  it('watchEvents tells the watch command who reads it (MORSE_WATCH_PARENT)', async () => {
    const lines: string[] = [];
    const exited = new Promise<void>((resolve) => {
      // the stand-in prints what it was told and exits
      client.watchEvents((e) => lines.push(JSON.stringify(e)), {
        cmd: [process.execPath, '-e', 'console.log(JSON.stringify({ type: "request", parent: process.env.MORSE_WATCH_PARENT, args: process.argv.slice(1) }))', '--'],
        onExit: () => resolve(),
      });
    });
    await exited;
    await new Promise((res) => setTimeout(res, 50));
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ type: 'request', parent: String(process.pid), args: ['plugin', 'watch', '--json'] }]);
  });
});
