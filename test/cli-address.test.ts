import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { agentRequest } from '../src/cluster/agents.js';
import { registerRelay } from '../src/cluster/join.js';
import { loadPrimaryAddress } from '../src/identity/address-key.js';
import { agentAddressIndex } from '../src/identity/agent-addresses.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { daemonJson, noDaemonJson } from './helpers/local-api.js';

/**
 * ADR-081 through the real CLI (temp MORSE_HOME + HOME, a fake relay, no daemon): a bare
 * 26-character address is a contact by itself — `contact add | block | unblock | remove |
 * accept | reject` work on it, nothing is paired; `morse address` says the old name "still
 * reaches you"; `morse send --from <name|address>`; the hidden `agent remove` refuses the
 * first address like `address remove`. Every command that could talk to a daemon is given a
 * port nothing listens on.
 */

const repo = resolve(__dirname, '..');
const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-cli-addr-'));
  homes.push(h);
  return h;
};
const cliAt = (at: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: repo, env: { ...process.env, MORSE_HOME: at, ANYTOANY_HOME: at, HOME: at } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err }));
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
/** An address somebody else holds (a key in a home of its own). */
const someone = () => loadPrimaryAddress(freshHome()).address;

let relay: FakeRelay;
let home: string;
let handle: string;
let mine: string;
let port: string;
const cli = (...args: string[]) => cliAt(home, ...args);
const json = async (...args: string[]) => {
  const r = await cli(...args, '--json');
  expect(r.code, `${args.join(' ')}: ${r.err}`).toBe(0);
  return JSON.parse(r.out) as any;
};
const mailbox = (): Mailbox => {
  const ctx = homeContactContext(home);
  return createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
};
const blocked = () => {
  try {
    return (JSON.parse(readFileSync(join(home, '.morse', 'morse-blocked.json'), 'utf8')) as { handles: string[] }).handles;
  } catch {
    return [];
  }
};
/** (ADR-083) Blocks by address are kept in the mailbox, per address of mine (`address_blocks`; '' = the first) — morse-blocked.json keeps old handles only. */
const blockedAddresses = () => {
  const db = createDb(join(home, '.morse', 'mailbox.db'), { ctx: homeContactContext(home) });
  try {
    return (db.prepare('SELECT my_address AS my, address FROM address_blocks ORDER BY at, address').all() as Array<{ my: string; address: string }>).map((r) => (r.my ? `${r.address}@${r.my}` : r.address));
  } finally {
    db.close();
  }
};
const trustedDevices = () => {
  try {
    return (JSON.parse(readFileSync(join(home, '.morse', 'trusted-devices.json'), 'utf8')) as { devices: unknown[] }).devices;
  } catch {
    return [];
  }
};
// (ADR-081 review F3: `toAddress` — the address of this computer it was written to — is what marks a request as having arrived by address)
const request = (mb: Mailbox, address: string, text: string) =>
  mb.requests.file({ handle: address, deviceId: address, msgId: `r-${address.slice(0, 6)}`, from: { agent: 'claude', sessionId: '' }, to: { agent: 'mini', sessionId: 'inbox' }, toAddress: loadPrimaryAddress(home).address, text, droppedFiles: 0, via: 'morse-relay' });

beforeAll(async () => {
  relay = await startFakeRelay({ v3: true });
  home = freshHome();
  handle = (await registerRelay({ url: relay.url, home, agent: 'mini', probe: false })).handle;
  updateMachineConfig((cfg) => {
    (cfg['relay'] as Record<string, unknown>)['url'] = relay.url;
  }, join(home, '.morse', 'config.json'));
  mine = loadPrimaryAddress(home).address;
  port = String(await freePort()); // nothing listens here: no command of this file reaches a daemon
});
afterAll(async () => {
  await relay.close();
  homes.forEach((h) => rmSync(h, { recursive: true, force: true }));
});

describe('contacts by address through the CLI (ADR-081 §4)', () => {
  it('contact add morse.im/<address> --name x: a contact with only that address, no network, nothing paired; contact <who> finds it', async () => {
    const a = someone();
    const added = await json('contact', 'add', `morse.im/${a.toUpperCase()}`, '--name', 'x', '--port', port);
    expect(added).toMatchObject({ contact: { id: `a:${a}`, handle: null, address: null, agent: null, remark: 'x', group: 'other', state: 'active', self: false, addresses: [a], origin: null }, acceptedRequest: false });
    expect(added.restored).toBeUndefined();
    expect(trustedDevices()).toEqual([]);
    for (const who of ['x', a, `morse.im/${a}`]) expect((await json('contact', who)).contact.id).toBe(`a:${a}`);
    expect((await cli('contact', 'x')).out).toMatch(new RegExp(`^x \\(morse\\.im/${a}\\) {2}\\[other\\]`));
    expect((await cli('contact')).out).toMatch(new RegExp(`^x \\(morse\\.im/${a}\\) {2}\\[other\\]$`, 'm'));
    // again, bare, with a group: the same contact
    const again = await cli('contact', 'add', a, '--group', 'friend', '--port', port);
    expect(again.code, again.err).toBe(0);
    expect(again.out.trim()).toBe(`contact: x (morse.im/${a})  [friend]`);
    // without a name it is shown by its address
    const b = someone();
    expect((await cli('contact', 'add', `https://morse.im/${b}/`, '--port', port)).out.trim()).toBe(`contact: morse.im/${b}  [other]`);
    // one of this computer's own addresses is not a contact
    const own = await cli('contact', 'add', `morse.im/${mine}`, '--port', port);
    expect(own.code).toBe(1);
    expect(own.err.trim()).toBe(`error: ${mine} is one of your addresses here — not a contact of yours`);
    // history and the send target of such a contact
    expect((await json('message', 'x')).messages).toEqual([]);
    const send = await cli('send', 'x', 'hello', '--port', port);
    expect(send.code).toBe(1);
    expect(send.err.trim()).toBe(`error: the daemon is not running — messages to other addresses (morse.im/${a}) go through it: morse start`);
  }, 120_000);

  it('contact block / unblock by address (ADR-083: address_blocks holds the address, morse-blocked.json is not written); contact remove; adding it again', async () => {
    const a = someone();
    await json('contact', 'add', `morse.im/${a}`, '--name', 'yan', '--port', port);
    const block = await cli('contact', 'block', 'yan');
    expect(block.code, block.err).toBe(0);
    expect(block.out.trim()).toBe(`blocked yan (morse.im/${a}) — their messages are dropped (undo: morse contact unblock ${a})`);
    expect(blockedAddresses()).toEqual([a]);
    expect(blocked()).toEqual([]);
    expect((await json('contact', a)).contact.state).toBe('blocked');
    expect((await cli('contact')).out).toMatch(new RegExp(`^yan \\(morse\\.im/${a}\\) {2}\\[other\\] {2}BLOCKED$`, 'm'));
    const unblock = await cli('contact', 'unblock', `morse.im/${a}`);
    expect(unblock.out.trim()).toBe(`unblocked yan (morse.im/${a}) — their next message comes in again (as a request, unless you write to them first)`);
    expect(blockedAddresses()).toEqual([]);
    expect(blocked()).toEqual([]);
    expect((await json('contact', 'yan')).contact.state).toBe('active');
    // an address that is nobody's contact yet (one that sent a request) is blocked as itself; its request goes
    const stranger = someone();
    request(mailbox(), stranger, 'let me in');
    expect(await json('contact', 'block', stranger)).toMatchObject({ contact: { id: `a:${stranger}`, state: 'blocked', handle: null }, devices: 0 });
    expect(blockedAddresses()).toEqual([stranger]);
    expect(mailbox().requests.get(stranger)).toBeUndefined();
    // `contact add` of a blocked address is your word: unblocked
    expect(await json('contact', 'add', stranger, '--port', port)).toMatchObject({ contact: { id: `a:${stranger}`, state: 'active' } });
    expect(blockedAddresses()).toEqual([]);
    // your own address is not something to block
    const self = await cli('contact', 'block', mine);
    expect(self.code).toBe(1);
    expect(self.err.trim()).toBe('error: you cannot block yourself');

    // remove: nothing was paired, so nothing is untrusted; the address can be added again (no "restored")
    const rm = await cli('contact', 'remove', 'yan');
    expect(rm.code, rm.err).toBe(0);
    expect(rm.out.trim()).toBe(`removed yan (morse.im/${a}) — history kept; their next message is a message request again; to block them too: morse contact block ${a}`);
    expect((await cli('contact', 'yan')).code).toBe(1);
    expect((await cli('contact', a)).code).toBe(1);
    const back = await json('contact', 'add', a, '--port', port);
    expect(back).toMatchObject({ contact: { id: `a:${a}`, remark: null, group: 'other' }, acceptedRequest: false });
    expect(back.restored).toBeUndefined();
    // a blocked contact that is removed stays blocked, by address
    await cli('contact', 'block', a);
    expect(await json('contact', 'remove', a)).toEqual({ removed: `a:${a}`, devices: 0 });
    expect(blockedAddresses()).toEqual([a]);
    expect(blocked()).toEqual([]); // (ADR-083: nothing of this was written to morse-blocked.json)
    expect(trustedDevices()).toEqual([]);
  }, 120_000);

  it('contact accept / reject <address>: a request by address becomes the contact a:<address>; nothing in trusted-devices.json', async () => {
    const [a, b, c] = [someone(), someone(), someone()];
    const mb = mailbox();
    request(mb, a, 'please accept');
    request(mb, b, 'please do not');
    request(mb, c, 'accept by adding');
    const list = await cli('contact');
    expect(list.out).toMatch(new RegExp(`^ {2}morse\\.im/${a} {2}\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d$`, 'm')); // no "computer …"
    expect(list.out).toContain('"please accept"');
    const ok = await json('contact', 'accept', `morse.im/${a}`, '--port', port);
    expect(ok).toMatchObject({ accepted: a, contact: `a:${a}`, group: 'other', told: null });
    const text = await cli('contact', 'accept', `morse.im/${a}`, '--port', port);
    expect(text.code).toBe(1);
    expect(text.err.trim()).toBe(`error: no message request from morse.im/${a} (morse contact lists them)`);
    const m = (await json('message', '--id', ok.message)).message;
    expect(m).toMatchObject({ direction: 'in', contact: { id: `a:${a}`, handle: null, addresses: [a] }, from: { device: a }, foreign: true, text: 'please accept' });
    expect((await json('contact', a)).contact).toMatchObject({ id: `a:${a}`, group: 'other' });

    const no = await cli('contact', 'reject', b);
    expect(no.out.trim()).toBe(`rejected morse.im/${b} — request deleted (not blocked; to block: morse contact block ${b})`);
    expect(blocked()).not.toContain(b);
    expect(mailbox().contacts.find(b)).toBeNull();

    // adding an address whose request waits accepts it
    const add = await cli('contact', 'add', `morse.im/${c}`, '--name', 'cee', '--port', port);
    expect(add.out.trim()).toBe(`contact: cee (morse.im/${c})  [other] — their message request was accepted (morse read)`);
    expect(mailbox().requests.get(c)).toBeUndefined();
    expect(mailbox().history(`a:${c}`).map((x) => x.parts[0]!.text)).toEqual(['accept by adding']);
    // your name for the address is shown where its mail is shown
    expect((await cli('message', 'cee')).out).toContain(`来自 cee (${c}) 的 Agent`);
    expect((await cli('message', '--all')).out).toContain(`cee (@${c}/claude)`);
    // replying to mail that came by address goes back to the address
    const r = await json('reply', ok.message, 'welcome');
    expect(r).toMatchObject({ sent: true, message: { direction: 'out', to: { device: a }, contact: { id: `a:${a}` }, agent: 'mini' } });
    expect(trustedDevices()).toEqual([]);
    expect(existsSync(join(home, '.morse', 'trusted-devices.json'))).toBe(false);
  }, 120_000);
});

describe('addresses of this computer through the CLI (ADR-081 §5, §6, §9)', () => {
  it('morse address: the 26-character address and the relay — (ADR-091) no old name; the first address cannot be removed', async () => {
    const a = await cli('address');
    expect(a.code, a.err).toBe(0);
    expect(a.out.trimEnd().split('\n')).toEqual([`address: morse.im/${mine}`, `relay:   ${relay.url}`]);
    expect(a.out).not.toMatch(/old name|share this one|cannot be added/);
    // (ADR-088 §3) one address: no name is shown — not in the listing, not in a refusal
    expect(a.out).not.toContain('mini');
    const refusal = `error: this is your only address here (it uses this install's own key) — it cannot be removed`;
    for (const cmd of [['address', 'remove', 'mini'], ['address', 'remove', mine]]) {
      const r = await cli(...cmd);
      expect(r.code, cmd.join(' ')).toBe(1);
      expect(r.err.trim()).toBe(refusal);
    }
    expect(agentAddressIndex(home)).toEqual({ mini: mine });
    // the hidden `agent` is gone (ADR-091, stage 2)
    expect((await cli('agent', 'remove', 'mini')).err).toContain("unknown command 'agent'");
  }, 120_000);

  it('a new computer is told its 26-character address as the one to share (morse address / morse join) — made here, no old name registered (ADR-091)', async () => {
    for (const cmd of [['address']]) {
      const fresh = freshHome();
      mkdirSync(join(fresh, '.morse'), { recursive: true });
      writeFileSync(join(fresh, '.morse', 'config.json'), JSON.stringify({ relay: { url: relay.url } }));
      const r = await cliAt(fresh, ...cmd);
      expect(r.code, r.err).toBe(0);
      const address = loadPrimaryAddress(fresh).address;
      const saved = JSON.parse(readFileSync(join(fresh, '.morse', 'config.json'), 'utf8')).relay as { handle?: string; url: string };
      // (ADR-091) nothing was asked of the relay: no old name, the relay written for the daemon
      expect(saved.handle).toBeUndefined();
      expect(saved.url).toBe(relay.url);
      expect(r.out).toContain(`created: your address is morse.im/${address} — send it to your friends; next: morse start`);
      expect(r.out).not.toMatch(/old name|joined: you are|^agent:|another agent|this computer|another computer/m);
      expect(r.out).not.toMatch(/share this (one|link) for now/);
    }
    // `join` is gone (ADR-091, stage 2): `morse address` is the one way in
    expect((await cliAt(freshHome(), 'join')).err).toContain("unknown command 'join'");
  }, 120_000);

  it('morse send --from <name|address>: one of this computer\'s addresses, passed on by its name; anything else is refused before the daemon is asked', async () => {
    expect((await cli('address', 'add', 'codex')).code).toBe(0);
    const codex = agentAddressIndex(home)['codex']!;
    const to = someone();
    const bodies: Array<Record<string, unknown>> = [];
    const daemon: Server = createHttpServer((req, res) => {
      // (ADR-081 review N1) a daemon of this release: it says it can send from a named address — asked before anything is posted
      if (req.method === 'GET' && req.url === '/api/peers') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ lan: false, self: null, peers: [], capabilities: ['from-address'] }));
        return;
      }
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        bodies.push({ url: req.url, ...(JSON.parse(raw || '{}') as Record<string, unknown>) });
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'refused by the test daemon' }));
      });
    });
    await new Promise<void>((done) => daemon.listen(0, '127.0.0.1', () => done()));
    const fake = String((daemon.address() as { port: number }).port);
    daemonJson(home, fake); // (ADR-087: this home's daemon listens there — a command talks to no other)
    try {
      for (const from of ['codex', codex, `morse.im/${codex.toUpperCase()}`]) {
        const r = await cli('send', `morse.im/${to}`, 'hello', '--from', from, '--port', fake);
        expect(r.code).toBe(1);
        expect(r.err.trim()).toBe('error: refused by the test daemon'); // the daemon's one line, as it says it
      }
      expect(bodies).toHaveLength(3);
      for (const b of bodies) expect(b).toMatchObject({ url: '/api/send', target: `morse.im/${to}`, text: 'hello', fromAddress: codex, from: { agent: 'user', sessionId: 'cli' } }); // (ADR-088: the daemon is told the ADDRESS — a name is the command's business)
      // the first address by name: the same field (it is what a message without --from goes out as)
      await cli('send', to, 'hello', '--from', 'mini', '--port', fake);
      expect(bodies[3]).toMatchObject({ target: to, fromAddress: mine });
      await cli('send', to, 'hello', '--port', fake);
      expect(bodies[4]!['fromAddress']).toBeUndefined();
      // not an address of this computer: said here, the daemon is not asked
      for (const from of ['nosuch', someone()]) {
        const r = await cli('send', `morse.im/${to}`, 'hello', '--from', from, '--port', fake);
        expect(r.code).toBe(1);
        expect(r.err.trim()).toBe(`error: "${from}" is not one of your addresses here — morse address lists them (a session is written @<agent>:<session>)`);
      }
      expect(bodies).toHaveLength(5);
    } finally {
      await new Promise<void>((done) => daemon.close(() => done()));
      noDaemonJson(home);
    }
    // no daemon: an address target (with or without morse.im/) is said to need it — never "cannot resolve target"
    for (const target of [`morse.im/${to}`, to]) {
      const r = await cli('send', target, 'hello', '--port', port);
      expect(r.code).toBe(1);
      expect(r.err.trim()).toBe(`error: the daemon is not running — messages to other addresses (${target}) go through it: morse start`);
    }
  }, 120_000);
});
