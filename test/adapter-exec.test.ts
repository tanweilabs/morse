import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { realExec, spawnWatch, type SpawnWatcher } from '../src/adapters/exec.js';

const NODE = process.execPath;
const node = (script: string) => [NODE, ['-e', script]] as const;
const dir = mkdtempSync(join(tmpdir(), 'morse-exec-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A watcher that writes down what it is told. */
function noting() {
  const spawned: Array<{ pid: number; timeoutMs: number }> = [];
  const ended: Array<{ pid: number; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> = [];
  const watcher: SpawnWatcher = {
    spawned: (pid, info) => spawned.push({ pid, ...info }),
    ended: (pid, how) => ended.push({ pid, ...how }),
  };
  return { watcher, spawned, ended };
}

describe('realExec: argv spawn that always resolves', () => {
  it('collects both streams and the exit code; arguments reach the child untouched by a shell', async () => {
    const [cmd, args] = node('process.stdout.write(process.argv[1]); process.stderr.write("warn"); process.exit(3)');
    const result = await realExec(cmd, [...args, '$(echo no) "q" ; |'], { timeoutMs: 10_000 });
    expect(result).toEqual({ stdout: '$(echo no) "q" ; |', stderr: 'warn', code: 3 });
  });

  it('runs in the given cwd, with the given environment as the WHOLE environment', async () => {
    const [cmd, args] = node('process.stdout.write(JSON.stringify([process.cwd(), process.env.ONLY_THIS, process.env.HOME ?? null]))');
    const result = await realExec(cmd, [...args], { cwd: dir, timeoutMs: 10_000, env: { ONLY_THIS: 'yes' } });
    expect(JSON.parse(result.stdout)).toEqual([realpathSync(dir), 'yes', null]);
  });

  it('stdin is closed, so a CLI waiting for piped input does not hang', async () => {
    const [cmd, args] = node('let n = 0; process.stdin.on("data", (d) => (n += d.length)); process.stdin.on("end", () => process.stdout.write("eof " + n))');
    expect(await realExec(cmd, [...args], { timeoutMs: 10_000 })).toEqual({ stdout: 'eof 0', stderr: '', code: 0 });
  });

  it('a command that cannot be started resolves with 127 and the reason', async () => {
    const result = await realExec(join(dir, 'no-such-cli'), [], { timeoutMs: 10_000 });
    expect(result.code).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ENOENT/);
  });

  it('past its time limit the child is killed and the call resolves 124 with what it had', async () => {
    const [cmd, args] = node('process.stdout.write("started"); setInterval(() => {}, 1000)');
    const t0 = Date.now();
    const result = await realExec(cmd, [...args], { timeoutMs: 400 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(result.code).toBe(124);
    expect(result.stderr.endsWith('\ntimeout after 400ms')).toBe(true);
  });
});

describe('realExec tells the spawnWatch watcher about the process (ADR-089)', () => {
  it('outside a watched call nothing is told and nothing breaks', async () => {
    const [cmd, args] = node('');
    expect((await realExec(cmd, [...args], { timeoutMs: 10_000 })).code).toBe(0);
  });

  it('a normal run: spawned with its time limit, ended with its exit code', async () => {
    const { watcher, spawned, ended } = noting();
    const [cmd, args] = node('process.exit(5)');
    const result = await spawnWatch.run(watcher, () => realExec(cmd, [...args], { timeoutMs: 8_000 }));
    expect(result.code).toBe(5);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.timeoutMs).toBe(8_000);
    expect(ended).toEqual([{ pid: spawned[0]!.pid, code: 5, signal: null, timedOut: false }]);
  });

  it('our own timeout kill is reported as timedOut', async () => {
    const { watcher, ended } = noting();
    const [cmd, args] = node('setInterval(() => {}, 1000)');
    await spawnWatch.run(watcher, () => realExec(cmd, [...args], { timeoutMs: 300 }));
    await expect.poll(() => ended.length).toBe(1);
    expect(ended[0]).toMatchObject({ signal: 'SIGKILL', timedOut: true });
  });

  it('a signal from someone else is reported as such, and the call resolves with exit 1', async () => {
    const { watcher, ended } = noting();
    const [cmd, args] = node('process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000)');
    const result = await spawnWatch.run(watcher, () => realExec(cmd, [...args], { timeoutMs: 10_000 }));
    expect(result.code).toBe(1);
    expect(ended[0]).toMatchObject({ code: null, signal: 'SIGTERM', timedOut: false });
  });

  it('a watcher without `ended` is fine', async () => {
    const spawnedOnly: SpawnWatcher = { spawned: () => undefined };
    const [cmd, args] = node('');
    expect((await spawnWatch.run(spawnedOnly, () => realExec(cmd, [...args], { timeoutMs: 10_000 }))).code).toBe(0);
  });
});
