import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { blockedHandles } from '../src/cluster/blocklist.js';
import { pinnedBundles } from '../src/cluster/morse.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { withFileLock, writeFileAtomic } from '../src/file-lock.js';
import { readMachineConfig } from '../src/machine-config.js';
import { createDispatchState } from '../src/plugins/dispatch/state.js';
import { listRegistered } from '../src/registry/external.js';
import { readUpdateState } from '../src/update/updater.js';

/**
 * The small JSON stores under ~/.morse are changed by read-modify-write from several
 * morse processes at once (the daemon, every CLI call, plugins). Every change happens
 * under the file's lock and is written atomically — nothing may be lost, and a reader
 * never sees a half-written file.
 */

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'morse-lock-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('withFileLock', () => {
  it('runs the function, returns its value and leaves no lock behind', () => {
    const file = join(fresh(), 'deep', 'store.json');
    expect(withFileLock(file, () => (existsSync(`${file}.lock`) ? 'held' : 'not held'))).toBe('held');
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('releases the lock when the function throws', () => {
    const file = join(fresh(), 'store.json');
    expect(() =>
      withFileLock(file, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(withFileLock(file, () => 1)).toBe(1);
  });

  it('is re-entrant in one process', () => {
    const file = join(fresh(), 'store.json');
    expect(withFileLock(file, () => withFileLock(file, () => 'inner'))).toBe('inner');
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('takes over a lock left behind by a process that died', () => {
    const file = join(fresh(), 'store.json');
    writeFileSync(`${file}.lock`, '999999999 left-behind\n'); // no such pid
    const t0 = Date.now();
    expect(withFileLock(file, () => 'mine')).toBe('mine');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('takes over a lock far older than any write takes, even if its pid is alive', () => {
    const file = join(fresh(), 'store.json');
    writeFileSync(`${file}.lock`, `${process.ppid} hung\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    expect(withFileLock(file, () => 'mine')).toBe('mine');
  });

  it('waits for a live holder: the lock is taken when it is released, not before', async () => {
    const dir = fresh();
    const file = join(dir, 'store.json');
    // another process holds the lock for a while, then releases it
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(`${file}.lock`)}, process.pid + ' holder\\n', { flag: 'wx' });
      fs.writeFileSync(${JSON.stringify(join(dir, 'holding'))}, '');
      setTimeout(() => { fs.writeFileSync(${JSON.stringify(join(dir, 'released'))}, ''); fs.rmSync(${JSON.stringify(`${file}.lock`)}); }, 400);
    `]);
    const exited = new Promise((done) => holder.on('close', done));
    while (!existsSync(join(dir, 'holding'))) await new Promise((r) => setTimeout(r, 5));
    expect(withFileLock(file, () => existsSync(join(dir, 'released')))).toBe(true);
    await exited;
  });
});

describe('writeFileAtomic', () => {
  it('replaces the content, keeps the mode of an existing file and leaves no temp file', () => {
    const dir = fresh();
    const file = join(dir, 'config.json');
    writeFileSync(file, 'old', { mode: 0o640 });
    writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(statSync(file).mode & 0o777).toBe(0o640);
    writeFileAtomic(file, 'private', { mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('creates the directory and the file', () => {
    const file = join(fresh(), 'a', 'b', 'new.json');
    writeFileAtomic(file, '{}', { mode: 0o600 });
    expect(readFileSync(file, 'utf8')).toBe('{}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('a symlinked file stays a symlink: what it points to is replaced', () => {
    const dir = fresh();
    mkdirSync(join(dir, 'dotfiles'));
    writeFileSync(join(dir, 'dotfiles', 'config.json'), 'old');
    symlinkSync(join(dir, 'dotfiles', 'config.json'), join(dir, 'config.json'));
    writeFileAtomic(join(dir, 'config.json'), 'new');
    expect(readFileSync(join(dir, 'dotfiles', 'config.json'), 'utf8')).toBe('new');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('new');
  });
});

describe('several morse processes change the stores of one home at the same moment', () => {
  const repo = resolve(__dirname, '..');
  const WRITERS = 6;
  const COUNT = 25;

  const start = (home: string, id: string) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/store-writer.ts', home, id, String(COUNT)], { cwd: repo, env: { ...process.env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home } });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    return new Promise<{ code: number | null; err: string }>((done) => p.on('close', (code) => done({ code, err })));
  };

  it('nothing is lost, nobody reads a half-written file, and a fresh home gets ONE identity', async () => {
    const home = fresh();
    const ids = Array.from({ length: WRITERS }, (_, i) => String(i));
    const writers = ids.map((id) => start(home, id));
    const reader = start(home, 'reader');
    // every process is loaded and waiting: let them all go at the same moment
    while (![...ids, 'reader'].every((id) => existsSync(join(home, `ready-${id}`)))) await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(home, 'go'), '');
    for (const w of await Promise.all(writers)) expect(w.code, w.err).toBe(0);
    writeFileSync(join(home, 'stop'), '');
    const r = await reader;
    expect(r.code, r.err).toBe(0);

    const names = ids.flatMap((id) => Array.from({ length: COUNT }, (_, k) => `w${id}-${k}`));
    // blocklist: every block is there, every unblock happened
    expect(blockedHandles(home).sort()).toEqual(names.map((n) => `${n}-keep`).sort());
    // trusted devices
    expect(createTrustStore(home).list().map((d) => d.name).sort()).toEqual([...names].sort());
    // config.json
    const seen = (readMachineConfig(join(home, '.morse', 'config.json')) as { seen?: Record<string, number> }).seen ?? {};
    expect(Object.keys(seen).sort()).toEqual([...names].sort());
    // pinned keys
    expect(Object.keys(pinnedBundles(home)).sort()).toEqual(names.map((n) => `DEVICE-${n}`).sort());
    // update state: every key every process merged in
    const update = readUpdateState(join(home, '.morse', 'update.json')) as Record<string, unknown>;
    expect(Object.keys(update).filter((k) => k.startsWith('k-')).sort()).toEqual(names.map((n) => `k-${n}`).sort());
    // dispatch plugin state
    const dispatch = createDispatchState(join(home, '.morse', 'plugins', 'dispatch'));
    expect(names.filter((n) => !dispatch.mark(n))).toEqual([]);
    // the external registration all of them refreshed is one readable entry
    expect(listRegistered({ home }).map((s) => s.sessionId)).toEqual(['shared']);
    // one device identity, the same for all
    expect(new Set(ids.map((id) => readFileSync(join(home, `identity-${id}`), 'utf8'))).size).toBe(1);
    // no lock or temp file left behind
    const left = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? left(join(dir, e.name)) : /\.(lock|tmp|stale)$/.test(e.name) ? [e.name] : []));
    expect(left(join(home, '.morse'))).toEqual([]);
  }, 60_000);
});
