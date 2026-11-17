import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_APPROVALS, parseAttendantConfig, type ConfigContext } from '../src/plugins/attendant/config.js';
import { contactKey, describePermissions, editPermissions, hasPermissionFlags, parseRateFlag, permissionLines, splitList, updateConfigFile } from '../src/plugins/attendant/permissions.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

/**
 * ADR-070: a contact's or a group's attendant permissions, set with `morse contact set`
 * (no new command) — validated with the plugin's own checks, written atomically, every
 * other key kept; `morse contacts <who>` shows what actually applies.
 */

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function env(): { root: string; work: string; other: string; ctx: ConfigContext } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'perms-')));
  roots.push(root);
  const home = join(root, 'home');
  const work = join(root, 'work', 'shared');
  const other = join(root, 'work', 'other');
  for (const d of [home, work, other]) mkdirSync(d, { recursive: true });
  return { root, work, other, ctx: { home, morseDir: join(home, '.morse') } };
}
const alice = { id: 'c:k7f3a9xq', handle: 'k7f3a9xq', remark: 'Alice', group: 'colleague' };
const att = (root: Record<string, any>) => root['plugins']['attendant'];

describe('flag parsing', () => {
  it('lists keep commas inside a rule; rates are 10/h, 50/day, both, or none', () => {
    expect(splitList('Read, Grep,Glob')).toEqual(['Read', 'Grep', 'Glob']);
    expect(splitList('Bash(git log:*),Bash(npm run a,b:*)')).toEqual(['Bash(git log:*)', 'Bash(npm run a,b:*)']);
    expect(parseRateFlag('10/h')).toEqual({ perHour: 10 });
    expect(parseRateFlag('50/day')).toEqual({ perDay: 50 });
    expect(parseRateFlag('6/h,30/day')).toEqual({ perHour: 6, perDay: 30 });
    expect(parseRateFlag('6/h 30/d')).toEqual({ perHour: 6, perDay: 30 });
    expect(parseRateFlag('none')).toBeNull();
    expect(() => parseRateFlag('5/week')).toThrow(/10\/h/);
    expect(() => parseRateFlag('0/h')).toThrow(/whole number/);
    expect(hasPermissionFlags({})).toBe(false);
    expect(hasPermissionFlags({ reset: false })).toBe(false);
    expect(hasPermissionFlags({ rate: 'none' })).toBe(true);
  });

  it('a contact entry is found by remark, address or id — else named by the remark, else the address', () => {
    expect(contactKey({ alice: {} }, alice)).toBe('alice');
    expect(contactKey({ K7F3A9XQ: {} }, alice)).toBe('K7F3A9XQ');
    expect(contactKey({}, alice)).toBe('Alice');
    expect(contactKey({}, { ...alice, remark: null })).toBe('k7f3a9xq');
  });
});

describe('editing plugins.attendant (ADR-070)', () => {
  it('a group profile: directory, tools, allowed commands, rate — and what it means for a member', () => {
    const e = env();
    const { root, where } = editPermissions({}, { kind: 'group', group: 'colleague' }, { cwd: e.work, tools: 'Read,Grep,Glob,Bash', allow: 'Bash(git status:*),Bash(git log:*)', rate: '6/h,30/day' }, e.ctx);
    expect(where).toBe('plugins.attendant.groups.colleague');
    expect(att(root).groups.colleague).toEqual({ cwd: e.work, tools: ['Read', 'Grep', 'Glob', 'Bash'], allowedTools: ['Bash(git status:*)', 'Bash(git log:*)'], rateLimit: { perHour: 6, perDay: 30 } });
    const s = parseAttendantConfig(att(root), e.ctx);
    expect(s.errors).toEqual([]);
    const v = describePermissions(s, alice, true);
    expect(v).toMatchObject({ mode: 'profile', source: 'plugins.attendant.groups.colleague', cwd: e.work, tools: ['Read', 'Grep', 'Glob', 'Bash'], allowedTools: ['Bash(git status:*)', 'Bash(git log:*)'], rateLimit: { perHour: 6, perDay: 30 } });
    const lines = permissionLines(v).join('\n');
    expect(lines).toContain(`works in: ${e.work}`);
    expect(lines).toContain('runs without asking: Bash(git status:*), Bash(git log:*)');
    expect(lines).toContain('waits for your approval: the default list');
    expect(lines).toContain('rate: 6/h 30/day');
  });

  it('a contact on top of their group: only what changed; the rest comes from the group', () => {
    const e = env();
    const start = { plugins: { attendant: { groups: { colleague: { cwd: e.work, rateLimit: { perHour: 6, perDay: 30 } } } } } };
    const { root, where } = editPermissions(start, { kind: 'contact', contact: alice }, { tools: 'Read,Grep', rate: 'none' }, e.ctx);
    expect(where).toBe('plugins.attendant.contacts.Alice');
    expect(att(root).contacts).toEqual({ Alice: { group: 'colleague', tools: ['Read', 'Grep'], rateLimit: { perHour: 0, perDay: 0 } } });
    expect(start.plugins.attendant).not.toHaveProperty('contacts'); // the input is not touched
    const v = describePermissions(parseAttendantConfig(att(root), e.ctx), alice, true);
    expect(v).toMatchObject({ mode: 'profile', source: 'plugins.attendant.contacts.Alice', note: 'on top of plugins.attendant.groups.colleague', cwd: e.work, tools: ['Read', 'Grep'], rateLimit: { perHour: null, perDay: null } });
    // editing again finds the same entry (by remark, case-insensitively) and keeps its other keys
    const again = editPermissions(root, { kind: 'contact', contact: { ...alice, remark: 'ALICE' } }, { allow: 'Bash(make test:*)' }, e.ctx);
    expect(att(again.root).contacts.Alice).toEqual({ group: 'colleague', tools: ['Read', 'Grep'], rateLimit: { perHour: 0, perDay: 0 }, allowedTools: ['Bash(make test:*)'] });
    expect(editPermissions(again.root, { kind: 'contact', contact: alice }, { allow: 'none' }, e.ctx).root['plugins']['attendant'].contacts.Alice).not.toHaveProperty('allowedTools');
  });

  it('a contact whose group has no profile needs its own directory; then it stands alone', () => {
    const e = env();
    const bob = { id: 'c:bob', handle: 'bob', remark: null, group: 'other' };
    expect(() => editPermissions({}, { kind: 'contact', contact: bob }, { tools: 'Read' }, e.ctx)).toThrow(/no group profile to build on \(group "other"\) — give --cwd/);
    expect(() => editPermissions({}, { kind: 'group', group: 'friends' }, { tools: 'Read' }, e.ctx)).toThrow(/needs a directory first/);
    const { root } = editPermissions({}, { kind: 'contact', contact: bob }, { cwd: e.other }, e.ctx);
    expect(att(root).contacts).toEqual({ bob: { cwd: e.other } });
    expect(describePermissions(parseAttendantConfig(att(root), e.ctx), bob, true)).toMatchObject({ mode: 'profile', source: 'plugins.attendant.contacts.bob', note: null, tools: ['Read', 'Grep', 'Glob'], approvals: DEFAULT_APPROVALS });
  });

  it('refuses what the plugin would refuse — and says why', () => {
    const e = env();
    const g = { kind: 'group', group: 'colleague' } as const;
    expect(() => editPermissions({}, g, { cwd: e.work, allow: 'Bash' }, e.ctx)).toThrow(/plugins\.attendant\.groups\.colleague: .*Bash/);
    expect(() => editPermissions({}, g, { cwd: e.ctx.home }, e.ctx)).toThrow(/home directory/);
    expect(() => editPermissions({}, g, { cwd: join(e.root, 'nope') }, e.ctx)).toThrow(/no such directory/);
    expect(() => editPermissions({}, g, { cwd: e.work, tools: 'Read;rm' }, e.ctx)).toThrow(/tool names/);
    expect(() => editPermissions({}, { kind: 'group', group: 'self' }, { cwd: e.work }, e.ctx)).toThrow(/your own mail/);
    expect(() => editPermissions({}, { kind: 'group', group: '!' }, { cwd: e.work }, e.ctx)).toThrow(/group label/);
    expect(() => editPermissions({}, g, { reset: true, tools: 'Read' }, e.ctx)).toThrow(/--reset goes alone/);
    expect(() => editPermissions({}, g, { reset: true }, e.ctx)).toThrow(/nothing to reset/);
    expect(() => editPermissions({ plugins: { attendant: { groups: [] } } }, g, { cwd: e.work }, e.ctx)).toThrow(/not an object/);
    // an error that was already there (another entry) does not block this edit
    const broken = { plugins: { attendant: { groups: { old: { cwd: '/nope/nope' } } } } };
    expect(() => editPermissions(broken, g, { cwd: e.work }, e.ctx)).not.toThrow();
  });

  it('relative directories are made absolute; ~/… is kept as written', () => {
    const e = env();
    expect(att(editPermissions({}, { kind: 'group', group: 'colleague' }, { cwd: 'shared' }, e.ctx, join(e.root, 'work')).root).groups.colleague.cwd).toBe(e.work);
    mkdirSync(join(e.root, 'x'));
    const { root } = editPermissions({}, { kind: 'contact', contact: { ...alice, group: 'other' } }, { cwd: '~/x' }, { ...e.ctx, home: e.root }, '/');
    expect(att(root).contacts.Alice).toEqual({ cwd: '~/x' });
  });

  it('--reset removes the entry: the contact is back on the group, the group back on the default', () => {
    const e = env();
    const start = { plugins: { attendant: { groups: { colleague: { cwd: e.work } }, contacts: { Alice: { group: 'colleague', tools: ['Read'] } } } } };
    const r1 = editPermissions(start, { kind: 'contact', contact: alice }, { reset: true }, e.ctx).root;
    expect(att(r1).contacts).toEqual({});
    expect(describePermissions(parseAttendantConfig(att(r1), e.ctx), alice, true).source).toBe('plugins.attendant.groups.colleague');
    const r2 = editPermissions(r1, { kind: 'group', group: 'colleague' }, { reset: true }, e.ctx).root;
    expect(describePermissions(parseAttendantConfig(att(r2), e.ctx), alice, true)).toMatchObject({ mode: 'conversation', tools: [] });
  });

  it('describes every case: yourself, blocked, plugin off, switched off, default off, conversation only, codex', () => {
    const e = env();
    const s = parseAttendantConfig({ groups: { quiet: { enabled: false }, ops: { agent: 'codex', allowUnscopedReads: true, cwd: e.work } }, contacts: { bob: { enabled: false } } }, e.ctx);
    const lines = (c: object, on = true) => permissionLines(describePermissions(s, { id: 'c:x', handle: 'x', remark: null, group: 'other', ...c }, on)).join('\n');
    expect(lines({ id: 'self', self: true })).toMatch(/your own mail/);
    expect(lines({ state: 'blocked' })).toMatch(/blocked/);
    expect(lines({}, false)).toMatch(/plugin is off/);
    expect(lines({ group: 'quiet' })).toMatch(/group "quiet" is switched off/);
    expect(lines({ handle: 'bob' })).toMatch(/contacts\.bob is off/);
    expect(lines({})).toMatch(/conversation only \(the default\) — no tools.*model sonnet · rate no limit/);
    expect(lines({ group: 'ops' })).toMatch(/sandbox: read-only/);
    const none = parseAttendantConfig({ defaultProfile: false, groups: { bad: { cwd: '/nope/nope' } } }, e.ctx);
    const bad = permissionLines(describePermissions(none, { id: 'c:x', handle: 'x', group: 'bad' }, true)).join('\n');
    expect(bad).toMatch(/group "bad" is switched off/);
    expect(bad).toMatch(/! plugins\.attendant\.groups\.bad: "cwd" \/nope\/nope: no such directory$/m);
    expect(permissionLines(describePermissions(none, { id: 'c:x', handle: 'x', group: 'other' }, true)).join('\n')).toMatch(/default is off/);
  });
});

describe('writing config.json', () => {
  it('atomic, keeps unknown keys, order, indentation and mode; refuses a broken file', () => {
    const e = env();
    const path = join(e.root, 'config.json');
    writeFileSync(path, '{\n    "relay": { "url": "wss://x", "handle": "me" },\n    "zzz": [1, 2],\n    "plugins": { "ilink": { "enabled": true } }\n}\n', { mode: 0o640 });
    updateConfigFile(path, (root) => editPermissions(root, { kind: 'group', group: 'colleague' }, { cwd: e.work }, e.ctx));
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith('{\n    "relay": {')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    const back = JSON.parse(text);
    expect(Object.keys(back)).toEqual(['relay', 'zzz', 'plugins']);
    expect(back).toMatchObject({ relay: { url: 'wss://x', handle: 'me' }, zzz: [1, 2], plugins: { ilink: { enabled: true }, attendant: { groups: { colleague: { cwd: e.work } } } } });
    expect(statSync(path).mode & 0o777).toBe(0o640);
    // a failed edit changes nothing
    expect(() => updateConfigFile(path, (root) => editPermissions(root, { kind: 'group', group: 'x' }, { cwd: e.ctx.home }, e.ctx))).toThrow(/home directory/);
    expect(readFileSync(path, 'utf8')).toBe(text);
    writeFileSync(path, '{ broken');
    expect(() => updateConfigFile(path, (root) => ({ root }))).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ broken');
    writeFileSync(path, '[1]');
    expect(() => updateConfigFile(path, (root) => ({ root }))).toThrow(/not a JSON object/);
    // no file yet: created, 0600
    const fresh = join(e.root, 'new.json');
    updateConfigFile(fresh, (root) => ({ root: { ...root, a: 1 } }));
    expect(JSON.parse(readFileSync(fresh, 'utf8'))).toEqual({ a: 1 });
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });
});

// --- the real CLI -----------------------------------------------------------------------

describe('morse contact set / morse contacts <who> (ADR-070)', () => {
  const repo = resolve(__dirname, '..');
  const e = env();
  const home = e.root;
  const config = join(home, '.morse', 'config.json');
  const cli = (...args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((done) => {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: repo, env: { ...process.env, MORSE_HOME: home } });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('close', (code) => done({ code, out, err }));
    });

  beforeAll(() => {
    mkdirSync(join(home, '.morse'), { recursive: true });
    writeFileSync(config, JSON.stringify({ relay: { url: 'ws://127.0.0.1:9', handle: 'me', agent: 'mini', agents: ['mini'] }, custom: { keep: true } }, null, 2));
    const ctx = homeContactContext(home);
    const mb = createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
    mb.contacts.set(mb.contacts.ensure('k7f3a9xq').id, { remark: 'Alice' });
  });

  it('sets a group profile, puts a contact in it, overrides one thing for her, shows it, resets it', async () => {
    let r = await cli('contact', 'set', '--group', 'colleague', '--cwd', e.work, '--tools', 'Read,Grep,Glob,Bash', '--allow', 'Bash(git status:*)');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('group colleague: plugins.attendant.groups.colleague');
    expect(r.out).toContain(`works in: ${e.work}`);
    r = await cli('contact', 'set', 'alice', '--group', 'colleague', '--rate', '10/h', '--json');
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.contact).toMatchObject({ remark: 'Alice', group: 'colleague' });
    expect(j.attendant).toMatchObject({ mode: 'profile', source: 'plugins.attendant.contacts.Alice', note: 'on top of plugins.attendant.groups.colleague', rateLimit: { perHour: 10, perDay: null }, tools: ['Read', 'Grep', 'Glob', 'Bash'] });
    const cfg = JSON.parse(readFileSync(config, 'utf8'));
    expect(cfg.custom).toEqual({ keep: true });
    expect(cfg.relay.handle).toBe('me');
    expect(cfg.plugins.attendant.contacts).toEqual({ Alice: { group: 'colleague', rateLimit: { perHour: 10 } } });

    r = await cli('contacts', 'alice');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^Alice \(morse\.im\/k7f3a9xq\) {2}\[colleague\]/);
    expect(r.out).toContain('attendant: plugins.attendant.contacts.Alice (on top of plugins.attendant.groups.colleague)');
    expect(r.out).toContain('runs without asking: Bash(git status:*)');
    expect(r.out).toContain('rate: 10/h');

    r = await cli('contact', 'set', 'alice', '--reset');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('attendant: plugins.attendant.groups.colleague');
  });

  it('refuses bad values and says why — config.json unchanged; nothing to change is an error too', async () => {
    const before = readFileSync(config, 'utf8');
    // each of these is refused and changes nothing, so they run together (one CLI process
    // after the other does not fit the test timeout on a busy machine)
    const [allow, rate, tools, noContact, labelOnly, nothing, both] = await Promise.all([
      cli('contact', 'set', 'alice', '--allow', 'Bash'),
      cli('contact', 'set', 'alice', '--rate', '5/week', '--json'),
      cli('contact', 'set', '--group', 'friends', '--tools', 'Read'),
      cli('contact', 'set', '--cwd', e.work),
      cli('contact', 'set', '--group', 'colleague'),
      cli('contact', 'set', 'alice'),
      // a failed permission change does not change the label either
      cli('contact', 'set', 'alice', '--group', 'other', '--tools', 'Read'),
    ]);
    expect(allow.code).toBe(1);
    expect(allow.err).toMatch(/Bash/);
    expect(rate.code).toBe(1);
    expect(JSON.parse(rate.out).error).toMatch(/--rate/);
    expect(tools.code).toBe(1);
    expect(tools.err).toMatch(/needs a directory first/);
    expect(noContact.code).toBe(1);
    expect(noContact.err).toMatch(/give a contact/);
    expect(labelOnly.code).toBe(1);
    expect(nothing.code).toBe(1);
    expect(nothing.err).toMatch(/nothing to change/);
    expect(both.code).toBe(1);
    expect(both.err).toMatch(/give --cwd/);
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(JSON.parse((await cli('contacts', 'alice', '--json')).out).contact.group).toBe('colleague');
    const r = await cli('contacts', 'nobody');
    expect(r.code).toBe(1);
  });
});
