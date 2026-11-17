import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTrustStore } from '../src/cluster/trust.js';

const dirs: string[] = [];
const home = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'morse-trust-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ALICE = 'AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAA';
const BOB = 'BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBB';
const CAROL = 'CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCC';
const fileOf = (h: string) => join(h, '.morse', 'trusted-devices.json');

describe('trust list file', () => {
  it('starts empty when there is no file', () => {
    const store = createTrustStore(home());
    expect(store.list()).toEqual([]);
    expect(store.get(ALICE)).toBeUndefined();
    expect(store.remove(ALICE)).toBe(false);
  });

  it('is written as {"devices": [...]}, two-space indented with a final newline, mode 600', () => {
    const h = home();
    const before = Date.now();
    const row = createTrustStore(h).add({ id: ALICE, name: 'studio' });
    expect(row.tier).toBe('owner');
    expect(row.addedAt).toBeGreaterThanOrEqual(before);
    const text = readFileSync(fileOf(h), 'utf8');
    expect(text).toBe(`${JSON.stringify({ devices: [{ id: ALICE, name: 'studio', tier: 'owner', addedAt: row.addedAt }] }, null, 2)}\n`);
    if (process.platform !== 'win32') expect(statSync(fileOf(h)).mode & 0o777).toBe(0o600);
  });

  it('re-adding an ID renames / re-tiers it, keeps addedAt and moves it last', () => {
    const h = home();
    const store = createTrustStore(h);
    const first = store.add({ id: ALICE, name: 'a' });
    store.add({ id: BOB, name: 'b', tier: 'peer' });
    const again = store.add({ id: ALICE, name: 'Alice', tier: 'peer' });
    expect(again).toEqual({ id: ALICE, name: 'Alice', tier: 'peer', addedAt: first.addedAt });
    expect(store.list().map((d) => d.id)).toEqual([BOB, ALICE]);
  });

  it('finds by name ignoring case; removes by ID first, then by name', () => {
    const store = createTrustStore(home());
    store.add({ id: ALICE, name: 'Mini' });
    store.add({ id: BOB, name: CAROL }); // a name that looks like another device's ID
    store.add({ id: CAROL, name: 'carol' });
    expect(store.byName('mINI')?.id).toBe(ALICE);
    expect(store.remove(CAROL)).toBe(true); // the ID wins over BOB's name
    expect(store.list().map((d) => d.id)).toEqual([ALICE, BOB]);
    expect(store.remove('MINI')).toBe(true);
    expect(store.list().map((d) => d.id)).toEqual([BOB]);
    expect(store.remove('nobody')).toBe(false);
  });

  it('drops rows without a string id / name or with an unknown tier', () => {
    const h = home();
    mkdirSync(join(h, '.morse'), { recursive: true });
    writeFileSync(
      fileOf(h),
      JSON.stringify({
        devices: [
          { id: ALICE, name: 'ok', tier: 'peer', addedAt: 5 },
          { id: BOB, name: 'no tier' },
          { id: 7, name: 'x', tier: 'owner' },
          { id: CAROL, name: null, tier: 'owner' },
          { id: CAROL, name: 'admin', tier: 'admin' },
          null,
          'junk',
        ],
      }),
    );
    expect(createTrustStore(h).list()).toEqual([{ id: ALICE, name: 'ok', tier: 'peer', addedAt: 5 }]);
  });

  it('trusts nobody when the file is not valid JSON or has no device array', () => {
    const h = home();
    mkdirSync(join(h, '.morse'), { recursive: true });
    for (const body of ['{oops', 'null', '{"devices": {"id": 1}}', '{}', '[]']) {
      writeFileSync(fileOf(h), body);
      const t = new Date(Date.now() + Math.random() * 1e6);
      utimesSync(fileOf(h), t, t);
      expect(createTrustStore(h).list()).toEqual([]);
    }
  });

  it('sees a change another process wrote (mtime moved) without being re-created', () => {
    const h = home();
    const daemon = createTrustStore(h);
    expect(daemon.list()).toEqual([]);
    createTrustStore(h).add({ id: ALICE, name: 'from-cli' });
    const later = new Date(Date.now() + 5000);
    utimesSync(fileOf(h), later, later);
    expect(daemon.get(ALICE)?.name).toBe('from-cli');
  });

  it('two stores of one home never lose each other\'s rows', () => {
    const h = home();
    const one = createTrustStore(h);
    const two = createTrustStore(h);
    one.list(); // warm one's cache
    two.add({ id: BOB, name: 'b' });
    one.add({ id: ALICE, name: 'a' }); // must re-read the file, not its stale cache
    expect(createTrustStore(h).list().map((d) => d.id).sort()).toEqual([ALICE, BOB]);
  });
});
