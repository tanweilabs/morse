import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { buildV2Home, type V2Home } from './helpers/v2-home.js';
import { registerRelay } from '../src/cluster/join.js';
import { agentAddressIndex } from '../src/identity/agent-addresses.js';
import { loadPrimaryAddress } from '../src/identity/address-key.js';
import { updateMachineConfig } from '../src/machine-config.js';

/**
 * ADR-077 through the real CLI (temp HOME): the first command after the update migrates the
 * contacts of a v2 home, says so once with the backup path, and everything a v2 user did
 * with `morse contact` / `morse message` still answers; `agent add` gives the new agent an
 * address of its own; `agent default` is a hidden no-op.
 */

const repo = resolve(__dirname, '..');
const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const cliAt = (at: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: repo, env: { ...process.env, MORSE_HOME: at, ANYTOANY_HOME: at, HOME: at } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err }));
  });

describe('identity v3 phase 2 through the CLI (ADR-077)', () => {
  let h: V2Home;
  beforeAll(() => {
    h = buildV2Home(homes);
  });

  it('the first command migrates (said once, with the backup); contacts, permissions, history, requests and blocks answer as before', async () => {
    const first = await cliAt(h.home, 'contact', '--json');
    expect(first.code, first.err).toBe(0);
    expect(first.err).toMatch(/contacts upgraded to one per address — 2 of your own computer\(s\) are now contacts in group self; 4 contact\(s\) are checked with the relay when the daemon is next online; nothing was deleted, backup: .*\/\.morse\/backups\/identity-v3-p2-\d{8}T\d{6}Z/);
    // (ADR-091) …and on, in the same command, to every contact by address: said in one more line, with its own backup
    expect(first.err).toMatch(/^morse: old names are gone — every contact is reached by its address now; 3 contact\(s\) need their new address .*; 2 contact\(s\) — your own computers paired the old way, and any you had put in group self — are in group mine: .*backup: .*\/\.morse\/backups\/remove-v2-\d{8}T\d{6}Z$/m);
    const dir = readdirSync(join(h.morseDir, 'backups')).filter((d) => d.startsWith('identity-v3-p2-'));
    expect(dir).toHaveLength(1);
    expect(existsSync(join(h.morseDir, 'backups', dir[0]!, 'contacts.sqlite'))).toBe(true);
    expect(existsSync(join(h.morseDir, 'backups', dir[0]!, 'mailbox.db'))).toBe(false); // the contact tables only, not a copy of every message
    const list = JSON.parse(first.out) as { contacts: Array<Record<string, any>>; requests: number };
    expect(list.requests).toBe(1);
    const by = (id: string) => list.contacts.find((c) => c.id === id)!;
    // (ADR-091) bob's address was known (his certificate is pinned): a contact by address that keeps his old name
    expect(by('c:bob')).toMatchObject({ handle: null, oldName: 'bob', address: null, remark: 'Bobby', group: 'colleague', state: 'active', addresses: [h.bob.address], agent: null, needsAddress: false });
    // alice has two computers, and which one is "alice" was never told: she needs her new address
    expect(by('c:alice')).toMatchObject({ handle: 'alice', remark: 'alice', group: 'friend', agents: expect.arrayContaining(['mini', 'air']), needsAddress: true });
    expect(by('c:eve')).toMatchObject({ state: 'blocked', needsAddress: true });
    // your own computers paired the old way: ordinary contacts in group mine
    expect(list.contacts.filter((c) => c.origin === 'own-device')).toEqual([]);
    expect(list.contacts.filter((c) => c.group === 'mine').map((c) => c.addresses[0]).sort()).toEqual([h.myAir.address, h.studio.address].sort());

    // the second command says nothing and takes no second backup
    const again = await cliAt(h.home, 'contact');
    expect(again.err).toBe('');
    expect(readdirSync(join(h.morseDir, 'backups')).filter((d) => d.startsWith('identity-v3-p2-'))).toHaveLength(1);
    // an unnamed contact is shown as before — its handle is not said twice; a remark by remark (by its address now)
    expect(again.out).toMatch(/^morse\.im\/alice {2}\[friend\].* — needs their new address/m);
    expect(again.out).toContain(`Bobby (morse.im/${h.bob.address})  [colleague]`);
    expect(again.out).toMatch(/1 message request/);

    // <who> = a remark, an address, an old handle
    for (const who of ['Bobby', h.bob.address, 'bob', 'morse.im/bob']) {
      const r = await cliAt(h.home, 'contact', who, '--json');
      expect(r.code, r.err).toBe(0);
      const v = JSON.parse(r.out) as { contact: { id: string }; attendant: { tools?: string[] } };
      expect(v.contact.id).toBe('c:bob');
      expect(v.attendant).toMatchObject({ tools: ['Read'] }); // the settings `morse contact set Bobby …` wrote before
    }
    const hist = JSON.parse((await cliAt(h.home, 'message', 'Bobby', '--json')).out) as { messages: Array<{ id: string }> };
    expect(hist.messages.map((m) => m.id)).toEqual([h.ids['toBob'], h.ids['fromBob'], h.ids['waiting']]);
    expect((await cliAt(h.home, 'message', '--id', h.ids['fromAliceAir']!, '--json')).out).toContain('from her air');
    const status = await cliAt(h.home, 'status');
    expect(status.out).toMatch(/contacts: one per address/);
    // v2 files are where they were
    for (const f of ['trusted-devices.json', 'peer-keys.json', 'morse-blocked.json', 'config.json']) expect(existsSync(join(h.morseDir, f))).toBe(true);
    expect(JSON.parse(readFileSync(join(h.morseDir, 'morse-blocked.json'), 'utf8'))).toEqual({ handles: ['eve'] });
  }, 120_000);

  it('(ADR-091) your own computers paired the old way are ordinary contacts: blocked, removed and added again like anyone', async () => {
    const r = await cliAt(h.home, 'contact', 'block', 'studio');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^blocked studio \(morse\.im\/[a-z0-9]{26}\)/);
    expect((await cliAt(h.home, 'contact', 'unblock', 'studio')).code).toBe(0);
    const rm = await cliAt(h.home, 'contact', 'remove', 'studio');
    expect(rm.code, rm.err).toBe(0);
    expect(rm.out).not.toMatch(/one of your own|paired with this computer/);
    const add = await cliAt(h.home, 'contact', 'add', h.studio.address, '--name', 'studio', '--group', 'mine', '--json');
    expect(add.code, add.err).toBe(0);
    expect(JSON.parse(add.out)).toMatchObject({ contact: { origin: null, group: 'mine', remark: 'studio' } });
    // group self is you — never a group of contacts
    const self = await cliAt(h.home, 'contact', 'set', 'studio', '--group', 'self');
    expect(self.code).toBe(1);
    expect(self.err).toContain('group "self" is you, not a group of contacts');
  }, 60_000);

  it('a bare address nobody here has is a contact by itself (ADR-081); `agent` is gone (ADR-091)', async () => {
    const stranger = '23456789abcdefghjkmnpqrstv';
    const r = await cliAt(h.home, 'contact', 'add', stranger);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe(`contact: morse.im/${stranger}  [other]`);
    // …and the contacts this home had before are what they were
    const list = JSON.parse((await cliAt(h.home, 'contact', '--json')).out) as { contacts: Array<Record<string, any>> };
    expect(list.contacts.find((c) => c.id === `a:${stranger}`)).toMatchObject({ handle: null, addresses: [stranger], group: 'other', origin: null });
    expect(list.contacts.find((c) => c.id === 'c:bob')).toMatchObject({ handle: null, oldName: 'bob', remark: 'Bobby', group: 'colleague' });
    const d = await cliAt(h.home, 'agent', 'default', 'mini');
    expect(d.code).toBe(1);
    expect(d.err).toContain("unknown command 'agent'");
  }, 60_000);
});

describe('no room for the backup (ADR-077)', () => {
  it('the command fails with one clear line, the mailbox is untouched, and it works once the obstacle is gone', async () => {
    const g = buildV2Home(homes);
    writeFileSync(join(g.morseDir, 'backups'), 'not a directory');
    mkdirSync(`${g.dbPath}.v2-contacts.bak.partial`);
    writeFileSync(join(`${g.dbPath}.v2-contacts.bak.partial`, 'x'), 'in the way');
    const r = await cliAt(g.home, 'contact');
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toMatch(/^error: cannot back up your contacts before upgrading them to one per address .*free some disk space or make .*\.morse writable .*Nothing was changed/);
    const db = new Database(g.dbPath, { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    db.close();
    rmSync(join(g.morseDir, 'backups'));
    rmSync(`${g.dbPath}.v2-contacts.bak.partial`, { recursive: true });
    const ok = await cliAt(g.home, 'contact');
    expect(ok.code, ok.err).toBe(0);
    expect(readdirSync(join(g.morseDir, 'backups')).filter((d) => d.startsWith('identity-v3-p2-'))).toHaveLength(1);
  }, 60_000);
});

describe('agents added after the first get their own address (ADR-077)', () => {
  let relay: FakeRelay;
  let home: string;
  beforeAll(async () => {
    relay = await startFakeRelay();
    home = buildV2Home(homes).home; // only for a throwaway HOME with an identity
    rmSync(join(home, '.morse', 'config.json'));
    rmSync(join(home, '.morse', 'trusted-devices.json'));
    await registerRelay({ url: relay.url, home, agent: 'mini', probe: false });
    updateMachineConfig((cfg) => {
      (cfg['relay'] as Record<string, unknown>)['url'] = relay.url;
    }, join(home, '.morse', 'config.json'));
  });
  afterAll(() => relay.close());

  it('address add prints the new address; rename keeps it; remove drops only the entry; morse address lists them (ADR-091: `agent` is gone)', async () => {
    const add = await cliAt(home, 'address', 'add', 'codex');
    expect(add.code, add.err).toBe(0);
    const index = agentAddressIndex(home);
    expect(index['mini']).toBe(loadPrimaryAddress(home).address);
    expect(index['codex']).toMatch(/^[23456789abcdefghjkmnpqrstvwxyz]{26}$/);
    expect(index['codex']).not.toBe(index['mini']);
    expect(add.out).toContain(`added: codex — morse.im/${index['codex']}   (its own key)`);
    expect(add.out).toContain('restart the daemon to bring this address online: morse stop --restart');
    expect(existsSync(join(home, '.morse', 'addresses', index['codex']!, 'key.pem'))).toBe(true);

    expect((await cliAt(home, 'address', 'rename', 'codex', 'helper')).code).toBe(0);
    // (ADR-088) the name is a local label: the address and its key stay what they were
    expect(agentAddressIndex(home)['codex']).toBe(index['codex']);
    const address = await cliAt(home, 'address');
    expect(address.out).toContain(`address: morse.im/${index['mini']}   mini`);
    expect(address.out).toContain(`         morse.im/${index['codex']}   helper`);

    expect((await cliAt(home, 'address', 'remove', 'helper')).code).toBe(0);
    expect(Object.values(agentAddressIndex(home))).toEqual([index['mini']]);
    expect((await cliAt(home, 'address')).out).not.toContain(index['codex']!);
    expect(existsSync(join(home, '.morse', 'addresses', index['codex']!, 'key.pem'))).toBe(true); // nothing is deleted
  }, 120_000);
});
