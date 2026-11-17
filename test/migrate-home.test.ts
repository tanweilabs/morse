import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { morseHome, dataDir } from '../src/home.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import { migrateDataDir } from '../src/migrate-home.js';

/** ADR-035: ~/.anytoany → ~/.morse, one atomic rename + a symlink back; never loses data. */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-migrate-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const env = { MORSE_HOME: process.env['MORSE_HOME'], ANYTOANY_HOME: process.env['ANYTOANY_HOME'] };
afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** An install from before ADR-035: ~/.anytoany with an identity, a mailbox and a trust list. */
const oldLayout = (home: string, messages = 3) => {
  mkdirSync(join(home, '.anytoany'), { recursive: true });
  expect(dataDir(home)).toBe(join(home, '.anytoany')); // un-migrated: the old dir is used
  const id = loadOrCreateIdentity(home).id;
  createTrustStore(home).add({ id: 'X'.repeat(52), name: 'air' });
  const db = createDb(join(home, '.anytoany', 'mailbox.db'));
  const mb = createMailbox(db);
  for (let i = 0; i < messages; i++) mb.send({ from: { agent: 'claude', sessionId: 'a' }, to: { agent: 'codex', sessionId: 'b' }, text: `m${i}` });
  db.close();
  return id;
};
const count = (home: string) => {
  const db = createDb(join(dataDir(home), 'mailbox.db'));
  try {
    return createMailbox(db).inbox().length;
  } finally {
    db.close();
  }
};

describe('data directory ~/.morse (ADR-035)', () => {
  it('MORSE_HOME wins over ANYTOANY_HOME; a fresh home uses .morse', async () => {
    process.env['ANYTOANY_HOME'] = '/tmp/a';
    process.env['MORSE_HOME'] = '/tmp/m';
    expect(morseHome()).toBe('/tmp/m');
    delete process.env['MORSE_HOME'];
    expect(morseHome()).toBe('/tmp/a');
    const home = freshHome();
    expect(dataDir(home)).toBe(join(home, '.morse'));
    expect(await migrateDataDir({ home })).toMatchObject({ status: 'fresh' });
  });

  it('moves ~/.anytoany to ~/.morse: same device ID, same mailbox, a symlink at the old path; idempotent', async () => {
    const home = freshHome();
    const id = oldLayout(home);
    expect(count(home)).toBe(3);
    const logs: string[] = [];
    const r = await migrateDataDir({ home, log: (l) => logs.push(l) });
    expect(r).toMatchObject({ status: 'migrated', dir: join(home, '.morse') });
    expect(lstatSync(join(home, '.anytoany')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, '.anytoany'))).toBe('.morse');
    expect(lstatSync(join(home, '.morse')).isDirectory()).toBe(true);
    expect(dataDir(home)).toBe(join(home, '.morse'));
    expect(loadOrCreateIdentity(home).id).toBe(id);
    expect(count(home)).toBe(3);
    expect(createTrustStore(home).byName('air')).toBeTruthy();
    // old tools that still say ~/.anytoany/… find the same files
    expect(existsSync(join(home, '.anytoany', 'mailbox.db'))).toBe(true);
    expect(existsSync(join(home, '.anytoany', 'identity', 'key.pem'))).toBe(true);
    expect(logs.join('\n')).toMatch(/moved ~\/\.anytoany → ~\/\.morse/);
    // again: nothing to do
    expect(await migrateDataDir({ home })).toMatchObject({ status: 'done' });
    expect(loadOrCreateIdentity(home).id).toBe(id);
  });

  it('an empty ~/.morse is no obstacle; a non-empty one is: nothing moves, the old dir stays in use', async () => {
    const a = freshHome();
    oldLayout(a, 1);
    mkdirSync(join(a, '.morse'));
    expect(await migrateDataDir({ home: a })).toMatchObject({ status: 'migrated' });

    const b = freshHome();
    const id = oldLayout(b, 2);
    mkdirSync(join(b, '.morse'));
    writeFileSync(join(b, '.morse', 'something'), 'x');
    const r = await migrateDataDir({ home: b });
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/both/);
    expect(lstatSync(join(b, '.anytoany')).isDirectory()).toBe(true);
    expect(dataDir(b)).toBe(join(b, '.anytoany'));
    expect(loadOrCreateIdentity(b).id).toBe(id);
    expect(count(b)).toBe(2);
  });

  it('the symlink cannot be made → everything is moved back, nothing lost', async () => {
    const home = freshHome();
    const id = oldLayout(home, 4);
    const r = await migrateDataDir({
      home,
      symlink: () => {
        throw new Error('EPERM: not allowed');
      },
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/moved back/);
    expect(lstatSync(join(home, '.anytoany')).isDirectory()).toBe(true);
    expect(existsSync(join(home, '.morse'))).toBe(false);
    expect(loadOrCreateIdentity(home).id).toBe(id);
    expect(count(home)).toBe(4);
  });

  it('a running daemon: left alone at daemon start (skipped); stopped first by setup, then moved', async () => {
    const home = freshHome();
    const id = oldLayout(home);
    writeFileSync(join(home, '.anytoany', 'daemon.pid'), '424242\n');
    let alive = true;
    const isDaemon = () => 'yes' as const;
    expect(await migrateDataDir({ home, isAlive: () => alive, isDaemon })).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/daemon is running/) });
    expect(lstatSync(join(home, '.anytoany')).isDirectory()).toBe(true);
    const killed: number[] = [];
    const r = await migrateDataDir({
      home,
      stopDaemon: true,
      isAlive: () => alive,
      isDaemon,
      kill: (pid) => {
        killed.push(pid);
        alive = false;
      },
    });
    expect(killed).toEqual([424242]);
    expect(r).toMatchObject({ status: 'migrated', stoppedDaemon: true });
    expect(loadOrCreateIdentity(home).id).toBe(id);
    // a daemon that will not stop: nothing moves
    const h2 = freshHome();
    oldLayout(h2, 1);
    writeFileSync(join(h2, '.anytoany', 'daemon.pid'), '424243\n');
    expect(await migrateDataDir({ home: h2, stopDaemon: true, isAlive: () => true, isDaemon, kill: () => undefined, stopWaitMs: 200 })).toMatchObject({ status: 'skipped' });
    expect(lstatSync(join(h2, '.anytoany')).isDirectory()).toBe(true);
  });

  it('(ADR-083 review N3) a left-over pid file whose pid is another program’s by now: no daemon — nobody is signalled, the directory moves', async () => {
    for (const stopDaemon of [false, true]) {
      const home = freshHome();
      const id = oldLayout(home);
      writeFileSync(join(home, '.anytoany', 'daemon.pid'), '424244\n');
      const killed: number[] = [];
      const r = await migrateDataDir({ home, stopDaemon, isAlive: () => true, isDaemon: () => 'no', kill: (pid) => void killed.push(pid) });
      expect(r.status).toBe('migrated');
      expect(r.stoppedDaemon).toBeFalsy();
      expect(killed).toEqual([]);
      expect(loadOrCreateIdentity(home).id).toBe(id);
    }
    // where it cannot be told what the process is, the pid file is believed — as before
    const home = freshHome();
    oldLayout(home);
    writeFileSync(join(home, '.anytoany', 'daemon.pid'), '424245\n');
    expect(await migrateDataDir({ home, isAlive: () => true, isDaemon: () => 'unknown' })).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/daemon is running/) });
  });
});
