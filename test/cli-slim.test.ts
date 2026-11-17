import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerRelay } from '../src/cluster/join.js';
import { loadPrimaryAddress } from '../src/identity/address-key.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { describeRelease, readInstalledRelease } from '../src/update/updater.js';
import { type FakeRelay, startFakeRelay } from './helpers/fake-relay.js';
import { countSpawn, enforceSpawnBudget, spawnBudget } from './helpers/spawn-budget.js';

/**
 * ADR-074: `morse --help` lists six commands (address, agent, contact, message, send,
 * reply); ten more are hidden but listed by `morse help --all`; every older command name
 * keeps working as a hidden alias with the same behaviour; `collab` and `flush` are gone.
 * Run as the real CLI against a temp HOME (and a fake relay for the address / agents).
 */

const repo = resolve(__dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'morse-cli-slim-'));
const emptyDir = join(home, 'nowhere');
let relay: FakeRelay;
let handle: string;
let ids: { bob: string };

// every test here starts the real CLI: its timeout is spawnBudget(<how many times>) — one rule, checked after each test
enforceSpawnBudget();

const cliAt = (at: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    countSpawn();
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: repo,
      env: { ...process.env, MORSE_HOME: at, ANYTOANY_HOME: at, HOME: at },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err }));
  });
const cli = (...args: string[]) => cliAt(home, ...args);
const json = async (...args: string[]) => {
  const r = await cli(...args, '--json');
  expect(r.code, `${args.join(' ')}: ${r.err}`).toBe(0);
  return JSON.parse(r.out) as any;
};
/** The command names in a commander help text's "Commands:" section. */
const commandsIn = (help: string): string[] => {
  const at = help.indexOf('Commands:');
  if (at < 0) return [];
  return help
    .slice(at)
    .split('\n')
    .slice(1)
    .filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]!.replace(/\|.*$/, ''));
};
const open = (): Mailbox => {
  const ctx = homeContactContext(home);
  return createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
};
const fileRequest = (mb: Mailbox, who: string) =>
  mb.requests.file({ handle: who, deviceId: `D-${who}`, msgId: `r-${who}`, from: { agent: 'claude', sessionId: '' }, to: { agent: 'mini', sessionId: 'inbox' }, text: `hello from ${who}`, droppedFiles: 0, via: 'morse-relay' });

beforeAll(async () => {
  relay = await startFakeRelay();
  handle = (await registerRelay({ url: relay.url, home, agent: 'mini', probe: false })).handle;
  mkdirSync(emptyDir, { recursive: true });
  loadPrimaryAddress(home); // a v3 address on this computer (ADR-073)
  const mb = open();
  const bob = mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'can you look at the API?', fromTier: 'peer' });
  mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'mbp', sessionId: '', device: 'bob/mbp' }, text: 'earlier question', contextId: bob.contextId });
  for (const who of ['zed', 'yan', 'amy', 'ben', 'cat', 'dan']) fileRequest(mb, who);
  ids = { bob: bob.id };
});
afterAll(async () => {
  await relay.close();
  rmSync(home, { recursive: true, force: true });
});

const VISIBLE = ['read', 'send', 'reply', 'contact', 'address']; // ADR-077 (K): `agent` folded into `address`; ADR-090: `message` became `read`
const HIDDEN = ['message', 'start', 'stop', 'status', 'update', 'setup', 'hook', 'list', 'done', 'connect', 'plugin']; // ADR-090: `message` is listed among the hidden

describe('help (ADR-074)', () => {
  it('morse --version: the package version with the release stamp of what is installed (ADR-075)', { timeout: spawnBudget(1) }, async () => {
    const r = await cli('--version');
    expect(r.code).toBe(0);
    // a git checkout has no release number; an installed signed release prints `0.0.1 (release <stamp>)`
    expect(r.out.trim()).toBe(describeRelease(readInstalledRelease(repo)));
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+ \((release \d{14}|development build — no release number)\)$/);
  });

  it('morse --help lists exactly the five commands', { timeout: spawnBudget(2) }, async () => {
    const r = await cli('--help');
    expect(r.code).toBe(0);
    expect(commandsIn(r.out).sort()).toEqual([...VISIBLE].sort());
    const bare = await cli('help');
    expect(commandsIn(bare.out).sort()).toEqual([...VISIBLE].sort());
  });

  it('morse help --all lists those five and the eleven hidden ones — 16, no aliases', { timeout: spawnBudget(1) }, async () => {
    const r = await cli('help', '--all');
    expect(r.code).toBe(0);
    const names = commandsIn(r.out);
    expect(names.sort()).toEqual([...VISIBLE, ...HIDDEN].sort());
    expect(names).toHaveLength(16);
    for (const alias of ['agent', 'agents', 'inbox', 'history', 'messages', 'contacts', 'requests', 'pull', 'monitor', 'doctor', 'register', 'claim', 'watch', 'collab', 'flush', 'join', 'pair']) {
      expect(names).not.toContain(alias);
    }
  });

  it('morse help <command> shows that command, with its verbs and options', { timeout: spawnBudget(3) }, async () => {
    const m = await cli('help', 'message');
    expect(m.out).toContain('--pull');
    expect(m.out).toContain('--wait');
    expect(m.out).toContain('--id <id>');
    const c = await cli('contact', '--help');
    expect(commandsIn(c.out)).toEqual(expect.arrayContaining(['add', 'set', 'remove', 'accept', 'reject', 'block', 'unblock']));
    const p = await cli('plugin', '--help');
    expect(commandsIn(p.out)).toEqual(expect.arrayContaining(['list', 'dispatch', 'attendant', 'ilink', 'claim', 'ack', 'nack', 'watch']));
  });
});

describe('the six commands and their old names (ADR-074)', () => {
  it('address: the address (one address: no name is shown, ADR-088) and the relay — no old name, no agents line, no device, no "v3" / "handle" (ADR-077 J, ADR-091)', { timeout: spawnBudget(7) }, async () => {
    const a = await cli('address');
    expect(a.code).toBe(0);
    const lines = a.out.trimEnd().split('\n');
    expect(lines).toEqual([`address: morse.im/${loadPrimaryAddress(home).address}`, `relay:   ${relay.url}`]);
    // (the links are random characters and may spell anything: look at the wording around them)
    expect(a.out.replace(/morse\.im\/\S+/g, '')).not.toMatch(/v3|handle|device|agents?:|old name/i);
    // the old forms are gone (ADR-091)
    for (const gone of ['relay', 'agent', 'agents', 'device', 'join', 'pair']) {
      expect((await cli(gone)).err, gone).toContain(`unknown command '${gone}'`);
    }
  });

  it('address add / set / remove: another address here with its own key; names are local labels, never a verb (`rename` = the hidden alias of `set --name`); `agent …` is gone (ADR-077 K, ADR-091)', async () => {
    const first = loadPrimaryAddress(home).address;
    const add = await cli('address', 'add', 'codex');
    expect(add.code, add.err).toBe(0);
    const made = /^added: codex — morse\.im\/([23456789abcdefghjkmnpqrstvwxyz]{26}) {3}\(its own key\)$/m.exec(add.out)?.[1];
    expect(made).toBeTruthy();
    expect(made).not.toBe(first);
    expect(add.out).toContain('restart the daemon to bring this address online: morse stop --restart');
    expect(existsSync(join(home, '.morse', 'addresses', made!, 'key.pem'))).toBe(true);
    // listed under the first one, aligned, with its name
    const listed = (await cli('address')).out.split('\n');
    expect(listed[0]).toBe(`address: morse.im/${first}   mini`);
    expect(listed[1]).toBe(`         morse.im/${made}   codex`);

    // named anew by name (the hidden `rename`), then by address (`set --name`): the address does not change
    const rn = await cli('address', 'rename', 'codex', 'helper');
    expect(rn.code, rn.err).toBe(0);
    expect(rn.out).toBe(`address: morse.im/${made}   helper\n`);
    const rn2 = await cli('address', 'set', `morse.im/${made}`, '--name', 'codex');
    expect(rn2.code, rn2.err).toBe(0);
    expect((await cli('address')).out).toContain(`morse.im/${made}   codex`);
    // a name may not be a verb; an address that is not ours is refused
    for (const verb of ['add', 'Set', 'Rename', 'remove']) {
      const bad = await cli('address', 'add', verb);
      expect(bad.code, verb).toBe(1);
      expect(bad.err).toContain(`error: "${verb}" is a command word — pick another name`);
    }
    expect((await cli('address', 'rename', 'codex', 'remove')).code).toBe(1);
    const stranger = await cli('address', 'remove', '23456789abcdefghjkmnpqrstv');
    expect(stranger.code).toBe(1);
    expect(stranger.err).toContain('is not one of your addresses here');

    // the first address cannot be removed — with several, it is said by its name
    const keep = await cli('address', 'remove', 'mini');
    expect(keep).toMatchObject({ code: 1, err: "error: mini is the first address here (it uses this install's own key) — it cannot be removed; remove the others, or rename it: morse address set mini --name <new name>\n" });
    // remove by address: gone from the list, the key stays on disk
    const rm = await cli('address', 'remove', made!);
    expect(rm.code, rm.err).toBe(0);
    expect(rm.out).toContain('removed: codex — it no longer receives; its key stays in ~/.morse/addresses/');
    expect(rm.out).toContain('restart the daemon so it stops logging this address in: morse stop --restart');
    // N6: the first address uses this install's own key — it cannot be removed, by name or by address; with one
    // address left no name is said (ADR-088 §3); a name may not look like an address
    for (const which of ['mini', first, `morse.im/${first}`]) {
      const no = await cli('address', 'remove', which);
      expect(no.code, which).toBe(1);
      expect(no.err).toBe("error: this is your only address here (it uses this install's own key) — it cannot be removed\n");
    }
    expect((await cli('address')).out.split('\n')[0]).toBe(`address: morse.im/${first}`);
    const like = await cli('address', 'add', '23456789abcdefghjkmnpqrstv');
    expect(like.code).toBe(1);
    expect(like.err).toContain('looks like an address (26 characters of the address alphabet) — pick another name');
    expect((await cli('address', 'rename', 'mini', 'ABCDEFGHJKMNPQRSTVWXYZ2345')).code).toBe(1);
    expect((await cli('address')).out).not.toContain(made!);
    expect(existsSync(join(home, '.morse', 'addresses', made!, 'key.pem'))).toBe(true);
    // help: `address` shows its verbs; `agent` is not listed anywhere
    const help = await cli('address', '--help');
    expect(commandsIn(help.out)).toEqual(expect.arrayContaining(['add', 'set', 'remove']));
    expect(commandsIn(help.out)).not.toContain('rename');
    expect((await cli('--help')).out).not.toMatch(/^ {2}agent\b/m);
  }, spawnBudget(22));

  it('address on a computer with no address yet creates one, here — no old name (ADR-074, ADR-091)', { timeout: spawnBudget(2) }, async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'morse-cli-slim-fresh-'));
    try {
      mkdirSync(join(fresh, '.morse'), { recursive: true });
      writeFileSync(join(fresh, '.morse', 'config.json'), JSON.stringify({ relay: { url: relay.url } }));
      const a = await cliAt(fresh, 'address');
      expect(a.code, a.err).toBe(0);
      const saved = JSON.parse(readFileSync(join(fresh, '.morse', 'config.json'), 'utf8')).relay;
      expect(saved.handle).toBeUndefined();
      expect(a.out).not.toContain('old name');
      expect(a.out).toMatch(/^address: morse\.im\/[23456789abcdefghjkmnpqrstvwxyz]{26}$/m); // (ADR-088 §3: one address, no name)
      expect(a.out).not.toContain('morse join');
      // the second time it only shows it
      const b = await cliAt(fresh, 'address');
      expect(b.code).toBe(0);
      expect(b.out).not.toContain('created:');
      expect(b.out.split('\n')[0]).toBe(a.out.split('\n').find((l) => l.startsWith('address: ')));
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('address with no address yet and the relay unreachable: made all the same — nothing needs the relay (ADR-091)', { timeout: spawnBudget(1) }, async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'morse-cli-slim-offline-'));
    try {
      mkdirSync(join(fresh, '.morse'), { recursive: true });
      writeFileSync(join(fresh, '.morse', 'config.json'), JSON.stringify({ relay: { url: 'ws://127.0.0.1:9' } }));
      const a = await cliAt(fresh, 'address');
      expect(a.code, a.err).toBe(0);
      expect(a.out).toMatch(/^created: your address is morse\.im\/[23456789abcdefghjkmnpqrstvwxyz]{26} — /m);
      expect(JSON.parse(readFileSync(join(fresh, '.morse', 'config.json'), 'utf8')).relay).toEqual({ url: 'ws://127.0.0.1:9', agent: expect.any(String), agents: [expect.any(String)] });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('message = inbox = messages; message <who> = history; message --id = read', { timeout: spawnBudget(11) }, async () => {
    const [m, i, ms] = await Promise.all([json('message'), json('inbox'), json('messages')]);
    expect(m.messages.map((x: any) => x.id)).toEqual([ids.bob]);
    expect(i).toEqual(m);
    expect(ms).toEqual(m);
    const [h, mh] = await Promise.all([json('history', 'bob'), json('message', 'bob')]);
    expect(mh.messages).toHaveLength(2);
    expect(h).toEqual(mh);
    const [rd, mid] = await Promise.all([json('read', ids.bob.slice(0, 8)), json('message', '--id', ids.bob.slice(0, 8))]);
    expect(mid.message.text).toBe('can you look at the API?');
    expect(rd).toEqual(mid);
    const [all, mall] = await Promise.all([json('inbox', '--all'), json('message', '--all')]);
    expect(all).toEqual(mall);
    // the text views agree too, and point at the new forms
    const [tm, ti] = await Promise.all([cli('message'), cli('inbox')]);
    expect(ti.out).toBe(tm.out);
    expect(tm.out).toContain('morse read --id <id>');
  });

  it('message takes one mode at a time', { timeout: spawnBudget(2) }, async () => {
    const r = await cli('message', 'bob', '--id', 'abcd');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/one of/);
    const w = await cli('message', '--pull', '--wait');
    expect(w.code).toBe(1);
  });

  it('message --pull = pull; message --wait = monitor', { timeout: spawnBudget(4) }, async () => {
    const [p, mp] = await Promise.all([cli('pull', '--inbox', '--history'), cli('message', '--pull', '--inbox', '--history')]);
    expect(p.code).toBe(0);
    expect(p.out).toContain('can you look at the API?');
    expect(mp.out).toBe(p.out);
    const [mo, mw] = await Promise.all([cli('monitor', '--cwd', emptyDir), cli('message', '--wait', '--cwd', emptyDir)]);
    expect(mo.out).toContain(`no session found for ${emptyDir}`);
    expect(mw.out).toBe(mo.out);
  });

  it('contact = contacts (+ the requests at the end); contact <who> = contacts <who>', { timeout: spawnBudget(6) }, async () => {
    const [c, cs] = await Promise.all([json('contact'), json('contacts')]);
    expect(c.contacts.map((x: any) => x.id)).toEqual(['self', 'c:bob']);
    expect(cs).toEqual(c);
    const [one, ones] = await Promise.all([json('contact', 'bob'), json('contacts', 'bob')]);
    expect(one.contact.id).toBe('c:bob');
    expect(ones).toEqual(one);
    const text = await cli('contact');
    expect(text.out).toContain('morse.im/zed');
    expect(text.out).toContain('morse contact accept <address>');
    const req = await json('requests');
    expect(Array.isArray(req)).toBe(true);
  });

  it('contact accept / reject / block / unblock = requests accept / reject / block and block / unblock', { timeout: spawnBudget(10) }, async () => {
    const [a1, a2] = await Promise.all([json('requests', 'accept', 'amy'), json('contact', 'accept', 'ben')]);
    expect(a1).toMatchObject({ accepted: 'amy', contact: 'c:amy' });
    expect(a2).toMatchObject({ accepted: 'ben', contact: 'c:ben' });
    const [r1, r2] = await Promise.all([json('requests', 'reject', 'zed'), json('contact', 'reject', 'yan')]);
    expect(r1).toEqual({ rejected: true, handle: 'zed' });
    expect(r2).toEqual({ rejected: true, handle: 'yan' });
    const b1 = await json('requests', 'block', 'cat');
    expect(b1).toEqual({ blocked: 'cat' });
    const b2 = await json('contact', 'block', 'dan');
    expect(b2.contact).toMatchObject({ id: 'c:dan', state: 'blocked' });
    expect(open().requests.count()).toBe(0);
    const [u1, u2] = await Promise.all([json('unblock', 'cat'), json('contact', 'unblock', 'dan')]);
    expect(u1.contact.state).toBe('active');
    expect(u2.contact.state).toBe('active');
    const [k1, k2] = await Promise.all([json('block', 'cat'), json('contact', 'block', 'dan')]);
    expect(k1.contact.state).toBe('blocked');
    expect(k2.contact.state).toBe('blocked');
  });

  it('status --check = doctor', { timeout: spawnBudget(2) }, async () => {
    const [d, s] = await Promise.all([cli('doctor'), cli('status', '--check')]);
    expect(s.out).toContain('daemon:');
    const checks = d.out.trim().split('\n');
    expect(checks.length).toBeGreaterThan(2);
    for (const l of checks) expect(s.out).toContain(l);
    expect(s.code).toBe(d.code);
  });

  it('connect = register / unregister', { timeout: spawnBudget(7) }, async () => {
    const r1 = await cli('register', '--agent', 'ext', '--session', 's-one', '--title', 'one');
    expect(r1.out).toContain('registered @ext:one  [s-one]');
    const r2 = await cli('connect', '--agent', 'ext', '--session', 's-two', '--title', 'two');
    expect(r2.out).toContain('registered @ext:two  [s-two]');
    const listed = (await json('list')).sessions.map((s: any) => s.sessionId);
    expect(listed).toEqual(expect.arrayContaining(['s-one', 's-two']));
    const u1 = await cli('unregister', '--agent', 'ext', '--session', 's-one');
    expect(u1.out).toContain('unregistered @ext:s-one');
    const u2 = await cli('connect', '--agent', 'ext', '--session', 's-two', '--uninstall');
    expect(u2.out).toContain('unregistered @ext:s-two');
    expect((await json('list')).sessions).toEqual([]);
    const bad = await cli('connect');
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/sds|--agent/);
  });

  it('list --conversations = conversations', { timeout: spawnBudget(2) }, async () => {
    const [c, l] = await Promise.all([json('conversations'), json('list', '--conversations')]);
    expect(l).toEqual(c);
  });

  it('plugin dispatch | attendant | ilink = dispatch | attendant | ilink', { timeout: spawnBudget(6) }, async () => {
    for (const [cmd, ...rest] of [['attendant', 'status'], ['ilink', 'status'], ['dispatch', 'session']] as const) {
      const [old, now] = await Promise.all([cli(cmd, ...rest, '--json'), cli('plugin', cmd, ...rest, '--json')]);
      expect(old.code, `${cmd}: ${old.err}`).toBe(0);
      expect(now.code).toBe(0);
      expect(JSON.parse(now.out)).toEqual(JSON.parse(old.out));
    }
  });

  it('plugin claim | ack | nack | watch = claim | ack | nack | watch; plugin = plugin list', { timeout: spawnBudget(10) }, async () => {
    const [c1, c2] = await Promise.all([json('claim', '--recover'), json('plugin', 'claim', '--recover')]);
    expect(c1).toEqual({ recovered: 0 });
    expect(c2).toEqual(c1);
    const [n1, n2] = await Promise.all([json('nack', 'nope', '--release'), json('plugin', 'nack', 'nope', '--release')]);
    expect(n2).toEqual(n1);
    const [w1, w2] = await Promise.all([cli('watch', '--once', '--json'), cli('plugin', 'watch', '--once', '--json')]);
    expect(w1.code).toBe(0);
    expect(w2.out).toBe(w1.out);
    const [a1, a2] = await Promise.all([cli('ack', 'nope', '--json'), cli('plugin', 'ack', 'nope', '--json')]);
    expect(a2.code).toBe(a1.code);
    const [p, pl] = await Promise.all([json('plugin'), json('plugin', 'list')]);
    expect(p).toEqual(pl);
    expect(p.plugins.map((x: any) => x.name)).toEqual(expect.arrayContaining(['dispatch', 'attendant', 'ilink']));
  });

  it('collab and flush are removed', { timeout: spawnBudget(3) }, async () => {
    for (const args of [['collab'], ['collab', 'show', 'x'], ['flush']]) {
      const r = await cli(...args);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/removed/);
    }
  });
});
