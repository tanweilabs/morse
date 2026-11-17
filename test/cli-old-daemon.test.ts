import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { daemonStub, killStubs, unrelatedStub } from './helpers/stub-process.js';
import { registerRelay } from '../src/cluster/join.js';
import { startMorse, INBOX_AGENT, type Morse } from '../src/cluster/morse.js';
import { startConsoleServer } from '../src/daemon/server.js';
import { loadPrimaryAddress } from '../src/identity/address-key.js';
import { agentAddressIndex } from '../src/identity/agent-addresses.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox, type Message } from '../src/mailbox/mailbox.js';
import { authedFetch as fetch, daemonJson, noDaemonJson, realServerOn, TEST_TOKEN, withPortOf } from './helpers/local-api.js';

/**
 * ADR-081 review N1 / N2 / N3 through the real CLI (temp MORSE_HOME + HOME, a fake relay):
 *
 *  N1  right after an update the daemon of the RELEASE BEFORE may still be running. It ignores a
 *      sending address — so a command that needs one asks first, and hands it nothing. The old
 *      daemon here is a stub of the released API: it accepts POST /api/send, ignores `fromAddress`,
 *      answers ok — with no `sentFrom` echo and no `capabilities` in GET /api/peers.
 *  N2  a contact is written to from the address of yours it knows you by; `--from` another one is
 *      said in one line; `morse contact <who>` shows it.
 *  N3  `morse contact reject --all`.
 *
 * (ADR-083) N2 is now "a contact BELONGS to one address of yours": mail to it goes out from that address;
 * `--from` another one with the contact's remark is refused with the one line that says how (to their
 * address — a separate contact); an old-handle contact is the first address's alone.
 *
 * The "new" daemon is the real console server and transport of this release, in this process, on
 * the same home the commands use.
 */

const OLD = 'error: the running Morse daemon is older than this command — restart it: morse stop --restart';
/**
 * (ADR-083) What EVERY command says — and all a sending or contact-changing one says before it refuses — while
 * the daemon this home's pid file names does not say `contacts-per-address` (test/cli-older-daemon.test.ts).
 * That check reads the files next to the mailbox; the one above (N1) asks the port a command posts to.
 */
const OLDER = 'the running Morse daemon is older than this version — restart it: morse stop --restart';

const repo = resolve(__dirname, '..');
const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-cli-old-'));
  homes.push(h);
  return h;
};
// (ADR-087 follow-up 2) a command given `--port <p>` talks to it only when it is the port its home's daemon.json names
const cliAt = (at: string, ...args: string[]) => withPortOf(at, args, () => spawnCli(at, ...args));
const spawnCli = (at: string, ...args: string[]) =>
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
};

let relay: FakeRelay;
let home: string;
let mine: string;
let work: string;
let ben: string;
let benMorse: Morse;
let morse: Morse;
let daemonMailbox: Mailbox;
let newPort: string;
let nobody: string;
const servers: Server[] = [];
const closers: Array<() => void> = [];
const cli = (...args: string[]) => cliAt(home, ...args);
const mailbox = (): Mailbox => {
  const ctx = homeContactContext(home);
  return createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
};
const outbound = () => mailbox().inbox({ all: true }).filter((m) => m.direction === 'out');
const row = (id: string) => mailbox().getMessage(id)!;
const session = { agent: 'claude', sessionId: 's-1' };
const dataFile = (name: string) => join(home, '.morse', name);

/**
 * The daemon of the release before, as far as a command can tell: the released HTTP API. `lies` = it
 * answers the capability question like this release but queues like the old one (what the echo check is for).
 */
const oldDaemon = async (o: { lies?: boolean; takes?: boolean } = {}) => {
  const posts: Array<Record<string, unknown>> = [];
  const gets: string[] = [];
  const queued: string[] = [];
  const server: Server = createHttpServer((req, res) => {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET') {
      gets.push(req.url ?? '');
      if (req.url === '/api/peers') return answer(200, { lan: false, self: null, peers: [], ...(o.lies ? { capabilities: ['from-address'] } : {}) });
      return answer(404, { error: 'not found' });
    }
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { target?: string; text?: string };
      posts.push({ url: req.url, ...body });
      // queued as the release before did: `fromAddress` is not read, the row names no address
      const mb = mailbox();
      const m = mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: INBOX_AGENT, sessionId: '', device: String(body.target).replace(/^morse\.im\//, '') }, text: String(body.text), via: 'cli', firstAddress: true });
      queued.push(m.id);
      // `takes`: its outbox picked the message up before it answered
      if (o.takes) createDb(join(home, '.morse', 'mailbox.db')).prepare(`UPDATE messages SET status = 'delivering' WHERE id = ?`).run(m.id);
      answer(201, { message: m, resolvedTarget: { device: m.to.device, agent: INBOX_AGENT, sessionId: '', title: 'inbox', cwd: '', lastActiveAt: 0 } });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  servers.push(server);
  return { port: String((server.address() as { port: number }).port), posts, gets, queued };
};
const startDaemon = async () => {
  const ctx = homeContactContext(home);
  daemonMailbox = createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
  morse = startMorse({ url: relay.url, home, mailbox: daemonMailbox, receiptTimeoutMs: 1500, connectWaitMs: 1000, log: () => undefined });
  await until(() => Boolean(morse.v3Client?.()?.connected()));
};
/** A message ben wrote to one of this computer's addresses, by address — filed as the transport files it. */
const fromBen = (text: string, to: 'work' | 'mini'): Message =>
  mailbox().send({ from: { agent: 'claude', sessionId: '', device: ben }, to: { agent: to, sessionId: 'inbox' }, text, fromTier: 'peer', myAddress: to === 'work' ? work : mine });

beforeAll(async () => {
  relay = await startFakeRelay({ v3: true });
  home = freshHome();
  await registerRelay({ url: relay.url, home, agent: 'mini', probe: false });
  updateMachineConfig((cfg) => {
    (cfg['relay'] as Record<string, unknown>)['url'] = relay.url;
  }, join(home, '.morse', 'config.json'));
  mine = loadPrimaryAddress(home).address;
  expect((await cli('address', 'add', 'work')).code).toBe(0);
  work = agentAddressIndex(home)['work']!;
  // ben: another computer, online, reachable by address alone
  const benHome = freshHome();
  await registerRelay({ url: relay.url, home: benHome, agent: 'ben-pc', probe: false });
  ben = loadPrimaryAddress(benHome).address;
  const benCtx = homeContactContext(benHome);
  benMorse = startMorse({ url: relay.url, home: benHome, mailbox: createMailbox(createDb(':memory:', { ctx: benCtx }), { ctx: benCtx }), log: () => undefined });
  await until(() => Boolean(benMorse.v3Client?.()?.connected()));
  // this computer's daemon of THIS release: the real console server over the real transport
  await startDaemon();
  await until(() => relay.onlineAddresses().includes(work));
  newPort = String(await freePort());
  const server = startConsoleServer({ token: TEST_TOKEN, 
    mailbox: daemonMailbox,
    directory: async () => [],
    port: Number(newPort),
    changePollMs: 60_000,
    knowsDevice: (d) => morse.knows(d),
    pairPerson: async (handle) => morse.pairHandle(handle),
    addressRoute: (target, from) => morse.addressRoute!(target, from),
    ownAddress: (from) => morse.ownAddress!(from),
    acceptAddress: (address, from) => morse.acceptAddress!(address, from), // (ADR-083) as `morse start` wires it: the address of mine that writes
  });
  closers.push(() => server.close());
  // (ADR-087) a command talks only to the daemon its own home's daemon.json describes: this home's is the new one.
  // A command given `--port <another>` asks THAT port, with this home's token — which is how the stubs of an older
  // daemon below are reached ("what answers on the port is believed over what daemon.json says it can do").
  realServerOn(newPort);
  daemonJson(home, newPort);
  nobody = String(await freePort());
  // ben is a contact who wrote to `work` (so that is what he knows this computer by); kai an old-handle contact
  fromBen('hello work', 'work');
  expect((await cli('contact', 'set', ben, '--name', 'ben')).code).toBe(0);
  mailbox().contacts.ensure('kai');
}, 120_000);
afterAll(async () => {
  await killStubs();
  closers.forEach((c) => c());
  morse?.stop();
  benMorse?.stop();
  await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
  await relay.close();
  homes.forEach((h) => rmSync(h, { recursive: true, force: true }));
});

describe('N1 — the daemon of the release before is still running', () => {
  it('morse send --from <name|address>: asked first — exit 1 with the one line, and the old daemon is handed NOTHING', async () => {
    const old = await oldDaemon();
    const before = outbound().length;
    // (ADR-083) a contact by old name is the first address's alone: `--from work` to it is refused by the command
    // itself, with its own line — before any daemon is asked
    const FIRST_ONLY = 'error: morse.im/kai is a contact of your first address, by its old name, not of work — write to them from the address they belong to: --from mini, or leave --from out';
    for (const [args, line] of [
      [['send', `morse.im/${ben}`, 'hello', '--from', 'work'], OLD],
      [['send', 'morse.im/kai', 'hello', '--from', 'work'], FIRST_ONLY],
      [['send', ben, 'hello', '--from', work], OLD],
      // the first address by name is a named address too: an old daemon is not handed it either
      [['send', 'morse.im/kai', 'hello', '--from', 'mini'], OLD],
    ] as Array<[string[], string]>) {
      const r = await cli(...args, '--port', old.port);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err.trim()).toBe(line);
      expect(r.out).toBe('');
    }
    expect(old.posts).toEqual([]);
    expect(old.gets).toEqual(['/api/peers', '/api/peers', '/api/peers']);
    expect(outbound()).toHaveLength(before);
  }, 120_000);

  it('morse send <contact> with no --from, to a contact who knows another address of yours: the same refusal; to anyone else the old daemon is used as before', async () => {
    const old = await oldDaemon();
    const before = outbound().length;
    // ben knows this computer as `work`
    for (const target of ['ben', `morse.im/${ben}`, ben]) {
      const r = await cli('send', target, 'hello', '--port', old.port);
      expect(r.code, target).toBe(1);
      expect(r.err.trim()).toBe(OLD);
    }
    expect(old.posts).toEqual([]);
    expect(outbound()).toHaveLength(before);
    // kai: nothing but the first address is involved — posted, as every release did
    const plain = await cli('send', 'morse.im/kai', 'the old way', '--port', old.port);
    expect(plain.code, plain.err).toBe(0);
    expect(plain.err).toBe('');
    expect(plain.out).toMatch(/^queued [0-9a-f-]{36}\n/);
    expect(old.posts).toEqual([{ url: '/api/send', target: 'morse.im/kai', from: { agent: 'user', sessionId: 'cli' }, text: 'the old way' }]);
    // (no question was asked for it either)
    expect(old.gets).toEqual(['/api/peers', '/api/peers', '/api/peers']);
  }, 120_000);

  it('belt and braces: a daemon that says it can but queues without the address — the echo is missing: the same error, and the message it queued is taken back', async () => {
    const liar = await oldDaemon({ lies: true });
    const r = await cli('send', `morse.im/${ben}`, 'hello', '--from', 'work', '--port', liar.port);
    expect(r.code).toBe(1);
    expect(liar.posts).toHaveLength(1);
    const id = liar.queued[0]!;
    expect(r.err.trimEnd().split('\n')).toEqual([OLD, `  the message it queued [${id.slice(0, 8)}] was taken back — nothing was sent`]);
    expect(row(id)).toMatchObject({ status: 'dead', lastError: `not sent: ${OLD.replace(/^error: /, '')}` });
    // when a daemon already took it, that is said instead (nothing can be taken back then)
    const again = await oldDaemon({ lies: true, takes: true });
    const t = await cli('send', 'ben', 'hello again', '--port', again.port);
    expect(t.code).toBe(1);
    const short = again.queued[0]!.slice(0, 8);
    expect(t.err.trimEnd().split('\n')).toEqual([OLD, `  it had already taken the message [${short}] — that one may have gone out from your first address: morse read --id ${short}`]);
    expect(row(again.queued[0]!).status).toBe('delivering');
    mailbox().markFailed(again.queued[0]!, 'test', { terminal: true });
  }, 120_000);

  it('morse reply to mail written to an address: refused while the old daemon runs, nothing queued, the original not marked — mail that came the old way is answered as before', async () => {
    const old = await oldDaemon();
    const toWork = fromBen('for work, please answer', 'work');
    const toFirst = fromBen('for the first address', 'mini');
    const before = outbound().length;
    for (const m of [toWork, toFirst]) {
      const r = await cli('reply', m.id, 'an answer', '--port', old.port);
      expect(r.code).toBe(1);
      expect(r.err.trim()).toBe(OLD);
      expect(r.out).toBe('');
      const j = await cli('reply', m.id, 'an answer', '--port', old.port, '--json');
      expect(j.code).toBe(1);
      expect(JSON.parse(j.out)).toEqual({ error: OLD.replace(/^error: /, '') });
      expect(row(m.id).processedAt).toBeUndefined();
    }
    expect(outbound()).toHaveLength(before);
    expect(old.posts).toEqual([]);

    // without --port the running daemon is the one this home's pid file names: a live pid that wrote no daemon.json is an old one
    // (ADR-083) — older than "contacts per address" too: the command is refused before it asks anything, with the
    // line every command says then
    // (the pid: a process that reads like a Morse daemon — a live pid that is another program's names no daemon, review N3)
    const { pid } = await daemonStub();
    writeFileSync(dataFile('daemon.pid'), String(pid));
    noDaemonJson(home);
    try {
      const byPid = await cli('reply', toWork.id, 'an answer');
      expect(byPid.code).toBe(1);
      expect(byPid.err.trim()).toBe(OLDER);
      // a daemon.json of ANOTHER pid (a stale file) changes nothing
      daemonJson(home, newPort, { pid: 1, token: null, capabilities: ['from-address', 'contacts-per-address'] });
      expect((await cli('reply', toWork.id, 'an answer')).err.trim()).toBe(OLDER);
      // …nor one of this pid that says only `from-address` (a daemon between the two releases)
      daemonJson(home, newPort, { pid: pid!, token: null, capabilities: ['from-address'] });
      expect((await cli('reply', toWork.id, 'an answer')).err.trim()).toBe(OLDER);
      // …nor one of the release before ADR-087: contacts per address, but a local API that asks for no token
      daemonJson(home, newPort, { pid: pid!, token: null, capabilities: ['from-address', 'contacts-per-address'] });
      expect((await cli('reply', toWork.id, 'an answer')).err.trim()).toBe(OLDER);
      expect(outbound()).toHaveLength(before);
      // this release's daemon wrote it (its pid, its port, its token, what it can do): asked there, and the reply is queued — from `work`
      daemonJson(home, newPort, { pid: pid! });
      const ok = await cli('reply', toWork.id, 'an answer from work', '--json');
      expect(ok.code, ok.err).toBe(0);
      const sent = JSON.parse(ok.out) as { sent: boolean; message: { id: string } };
      expect(sent.sent).toBe(true);
      expect(row(sent.message.id)).toMatchObject({ direction: 'out', myAddress: work, to: { device: ben } });
      // …and a daemon.json that names an OLD daemon on that port is not believed over what the port answers
      daemonJson(home, old.port, { pid: pid! });
      expect((await cli('reply', toFirst.id, 'an answer')).err.trim()).toBe(OLD);
    } finally {
      rmSync(dataFile('daemon.pid'), { force: true });
      daemonJson(home, newPort); // (as the file's beforeAll left it)
    }

    // (review N3) a pid file left over from a crash, its pid another program's by now: no daemon is running — the reply
    // is not refused, it is queued from `work`, and the stale file is gone
    const other = await unrelatedStub();
    writeFileSync(dataFile('daemon.pid'), String(other.pid));
    const stale = await cli('reply', toWork.id, 'an answer past a stale pid file', '--json');
    expect({ code: stale.code, err: stale.err }).toEqual({ code: 0, err: '' });
    const queued = JSON.parse(stale.out) as { sent: boolean; message: { id: string } };
    expect(queued.sent).toBe(true);
    expect(row(queued.message.id)).toMatchObject({ direction: 'out', myAddress: work, to: { device: ben } });
    expect(existsSync(dataFile('daemon.pid'))).toBe(false);

    // mail that came the old way (a handle, a device): its answer names no address — the old daemon sends it as it always did
    const oldWay = mailbox().send({ from: { agent: 'claude', sessionId: '', device: 'kai/kai-mini' }, to: { agent: 'user', sessionId: 'inbox' }, text: 'kai, the old way', fromTier: 'peer' });
    const r = await cli('reply', oldWay.id, 'answering kai', '--port', old.port, '--json');
    expect(r.code, r.err).toBe(0);
    const answered = row((JSON.parse(r.out) as { message: { id: string } }).message.id);
    expect(answered).toMatchObject({ direction: 'out', fromFirstAddress: true, to: { device: 'kai/kai-mini' } });
    expect(answered.myAddress).toBeUndefined();
    expect(old.gets).toEqual(['/api/peers', '/api/peers', '/api/peers', '/api/peers', '/api/peers']);
  }, 120_000);

  it('no daemon at all: a reply is queued for the next one (this release\'s) — and `send --from` says the daemon is not running', async () => {
    const m = fromBen('nobody is running', 'work');
    const r = await cli('reply', m.id, 'queued for later', '--json');
    expect(r.code, r.err).toBe(0);
    expect(row((JSON.parse(r.out) as { message: { id: string } }).message.id)).toMatchObject({ myAddress: work, status: 'pending' });
    const s = await cli('send', `morse.im/${ben}`, 'hello', '--from', 'work', '--port', nobody);
    expect(s.code).toBe(1);
    expect(s.err.trim()).toBe(`error: the daemon is not running — messages to other addresses (morse.im/${ben}) go through it: morse start`);
  }, 120_000);
});

describe('N1 + N2 — with this release\'s daemon', () => {
  it('GET /api/peers says what it can do; send --from and reply work, and the daemon echoes the address', async () => {
    const peers = (await (await fetch(`http://127.0.0.1:${newPort}/api/peers`)).json()) as { capabilities?: string[] };
    expect(peers.capabilities).toEqual(['from-address', 'contacts-per-address', 'local-api-auth', 'listener-proof', 'addresses-only']); // (ADR-083) …and that it keeps contacts per address
    const s = await cli('send', `morse.im/${ben}`, 'from work, through the new daemon', '--from', 'work', '--port', newPort, '--json');
    expect(s.code, s.err).toBe(0);
    expect(s.err).toBe('');
    const sent = JSON.parse(s.out) as { queued: boolean; message: { id: string } };
    expect(row(sent.message.id)).toMatchObject({ direction: 'out', myAddress: work, myAgent: 'work', to: { device: ben } });
    const original = fromBen('answer me through the new daemon', 'work');
    const r = await cli('reply', original.id, 'answered', '--port', newPort, '--json');
    expect(r.code, r.err).toBe(0);
    expect(row((JSON.parse(r.out) as { message: { id: string } }).message.id)).toMatchObject({ myAddress: work, to: { device: ben } });
    expect(row(original.id).processedAt).toBeTypeOf('number');
  }, 120_000);

  it('morse send <contact> with no --from goes out from the address they know; --from another one: one note on stderr, sent from it, nothing remembered changes', async () => {
    const plain = await cli('send', 'ben', 'a plain send', '--port', newPort, '--json');
    expect(plain.code, plain.err).toBe(0);
    expect(plain.err).toBe('');
    expect(row((JSON.parse(plain.out) as { message: { id: string } }).message.id)).toMatchObject({ myAddress: work, to: { device: ben } });

    // (ADR-083) `ben` names the contact of `work`: writing to him as another address of mine is not "this once" —
    // it is a separate contact. Refused with the one line that says how; nothing is queued
    const before = outbound().length;
    const other = await cli('send', 'ben', 'from my first address, this once', '--from', 'mini', '--port', newPort, '--json');
    expect(other.code).toBe(1);
    expect(other.err.trim()).toBe(`error: "ben" is a contact of your address work, not of mini — write to them from the address they belong to: --from work, or leave --from out`);
    expect(other.out).toBe('');
    expect(outbound()).toHaveLength(before);
    // …and doing what it says: sent from the first address, he is a contact of it too now — one note on stderr says so
    // (an earlier test of this file filed mail of his at the first address: that contact is removed first, so this is the first time)
    const had = mailbox().contacts.byAddress(ben);
    if (had) mailbox().contacts.remove(had.id);
    const byAddress = await cli('send', `morse.im/${ben}`, 'from my first address, to his address', '--from', 'mini', '--port', newPort);
    expect(byAddress.code, byAddress.err).toBe(0);
    expect(byAddress.err.trimEnd().split('\n')).toEqual([`note: morse.im/${ben} is now a contact of your address mini too — a separate contact from the one of work (its own name, group and history)`]);
    expect(outbound().find((m) => m.parts[0]!.text === 'from my first address, to his address')).toMatchObject({ myAddress: mine, myAgent: 'mini', contactId: `a:${ben}` });
    // the contact of `work` is as it was
    expect(mailbox().contacts.find('ben')).toMatchObject({ id: `a:${ben}~${work}`, myAddress: work, remark: 'ben' });
    expect(mailbox().contacts.findAll(ben).map((c) => [c.id, c.myAddress, c.remark])).toEqual([[`a:${ben}`, '', null], [`a:${ben}~${work}`, work, 'ben']]);
    // naming the one they know says nothing
    const same = await cli('send', 'ben', 'from work, said aloud', '--from', work, '--port', newPort);
    expect(same.code, same.err).toBe(0);
    expect(same.err).toBe('');
  }, 120_000);

  it('morse contact <who>: "knows you as: <name> (morse.im/<address>)", JSON knownAs — nothing for a contact nothing was exchanged with', async () => {
    const text = await cli('contact', 'ben');
    expect(text.code, text.err).toBe(0);
    expect(text.out.split('\n').slice(0, 2)).toEqual([`ben (morse.im/${ben})  [other]${text.out.split('\n')[0]!.replace(/^.*\[other\]/, '')}`, `knows you as: work (morse.im/${work})`]);
    const j = JSON.parse((await cli('contact', 'ben', '--json')).out) as { contact: { id: string; knownAs: unknown } };
    // (ADR-083) "knows you as" = the address of mine the contact BELONGS to; a contact of another address than the first is `a:<theirs>~<mine>`
    expect(j.contact).toMatchObject({ id: `a:${ben}~${work}`, knownAs: { name: 'work', address: work }, myAddress: { name: 'work', address: work } });
    // an old-handle contact that was written to the old way: this computer's first address
    mailbox().send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'lee' }, text: 'the old way' });
    expect((await cli('contact', 'morse.im/lee')).out.split('\n')[1]).toBe(`knows you as: mini (morse.im/${mine})`);
    expect((JSON.parse((await cli('contact', 'morse.im/lee', '--json')).out) as { contact: { knownAs: unknown } }).contact.knownAs).toEqual({ name: 'mini', address: mine });
    // nothing exchanged yet: (ADR-083) the contact belongs to an address of mine from the moment it is made — with
    // more than one address here the line is always shown, and knownAs is never null for a contact
    mailbox().contacts.ensure('zed');
    const fresh = await cli('contact', 'morse.im/zed');
    expect(fresh.code, fresh.err).toBe(0);
    expect(fresh.out.split('\n')[1]).toBe(`knows you as: mini (morse.im/${mine})`);
    expect((JSON.parse((await cli('contact', 'morse.im/zed', '--json')).out) as { contact: { knownAs: unknown } }).contact.knownAs).toEqual({ name: 'mini', address: mine });
    // the list (`morse contact`) and the other JSON shapes are unchanged
    const list = JSON.parse((await cli('contact', '--json')).out) as { contacts: Array<Record<string, unknown>> };
    for (const c of list.contacts) expect('knownAs' in c).toBe(false);
    expect((await cli('contact')).out).not.toContain('knows you as');
  }, 120_000);

  it('the address they know is removed from this computer: a plain send is refused with the one line, nothing is queued — and `contact <who>` says so', async () => {
    // (last in this file: `work` is gone afterwards) — the daemon is restarted, as after `morse address remove`
    morse.stop();
    const rm = await cli('address', 'remove', 'work');
    expect(rm.code, rm.err).toBe(0);
    await startDaemon();
    const before = outbound().length;
    const r = await cli('send', 'ben', 'after work was removed', '--port', newPort);
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe(`error: this message was written from your address morse.im/${work}, which is no longer here (or its key is not loaded) — not sent`);
    expect(outbound()).toHaveLength(before);
    expect((await cli('contact', 'ben')).out.split('\n')[1]).toBe(
      `knows you as: morse.im/${work} — an address that is no longer here: mail to them is not sent unless you name one (morse send … --from <name>)`,
    );
    expect((JSON.parse((await cli('contact', 'ben', '--json')).out) as { contact: { knownAs: unknown } }).contact.knownAs).toEqual({ name: null, address: work });
    // (ADR-083) naming an address you do have, with his REMARK: refused — `ben` is the contact of the address that is
    // gone; the one line says the way …
    const named = await cli('send', 'ben', 'from my first address then', '--from', 'mini', '--port', newPort);
    expect(named.code).toBe(1);
    expect(named.err.trim()).toBe(`error: "ben" is a contact of your address morse.im/${work}, not of mini — write to them from the address they belong to: --from ${work}, or leave --from out`);
    expect(outbound()).toHaveLength(before);
    // … to his address, as an address this computer has: sent — a contact of that address (made anew here), and one note says so
    const had = mailbox().contacts.byAddress(ben);
    if (had) mailbox().contacts.remove(had.id);
    const way = await cli('send', `morse.im/${ben}`, 'from my first address then', '--from', 'mini', '--port', newPort);
    expect(way.code, way.err).toBe(0);
    expect(way.err.trimEnd().split('\n')).toEqual([`note: morse.im/${ben} is now a contact of your address mini too — a separate contact from the one of morse.im/${work} (its own name, group and history)`]);
    expect(outbound().find((m) => m.parts[0]!.text === 'from my first address then')).toMatchObject({ myAddress: mine, contactId: `a:${ben}` });
  }, 120_000);
});

describe('N3 — morse contact reject --all', () => {
  const someone = () => loadPrimaryAddress(freshHome()).address;
  const request = (handle: string, text: string, byAddress = true) =>
    mailbox().requests.file({ handle, deviceId: handle, msgId: `r-${handle.slice(0, 6)}`, from: { agent: 'claude', sessionId: '' }, to: { agent: 'mini', sessionId: 'inbox' }, ...(byAddress ? { toAddress: mine } : {}), text, droppedFiles: 0, via: 'morse-relay' });
  const blocked = () => {
    try {
      return (JSON.parse(readFileSync(dataFile('morse-blocked.json'), 'utf8')) as { handles: string[] }).handles;
    } catch {
      return [];
    }
  };

  it('rejects every waiting request (deleted, nobody blocked, no contact made) and says how many; --json; the hidden alias; nothing waiting; neither <who> nor --all', async () => {
    const [a, b] = [someone(), someone()];
    request(a, 'junk 1');
    request(b, 'junk 2');
    request('oldname', 'junk 3, the old way', false);
    expect(mailbox().requests.count()).toBe(3);
    const contacts = mailbox().contacts.list().length;
    const all = await cli('contact', 'reject', '--all');
    expect(all.code, all.err).toBe(0);
    expect(all.out.trim()).toBe('rejected 3 message request(s)');
    expect(mailbox().requests.count()).toBe(0);
    expect(blocked()).toEqual([]);
    expect(mailbox().contacts.list()).toHaveLength(contacts);
    // nothing waiting
    expect((await cli('contact', 'reject', '--all')).out.trim()).toBe('rejected 0 message request(s)');
    const none = await cli('contact', 'reject', '--all', '--json');
    expect(none.code).toBe(0);
    expect(JSON.parse(none.out)).toEqual({ rejected: 0 });
    // --json, and the hidden alias `requests reject --all`
    request(a, 'again');
    request(b, 'again');
    expect(JSON.parse((await cli('contact', 'reject', '--all', '--json')).out)).toEqual({ rejected: 2 });
    request(a, 'once more');
    const alias = await cli('requests', 'reject', '--all');
    expect(alias.code, alias.err).toBe(0);
    expect(alias.out.trim()).toBe('rejected 1 message request(s)');
    // a later message from one of them is a new request (nobody was blocked)
    request(a, 'a new request');
    expect(mailbox().requests.list().map((r) => r.handle)).toEqual([a]);
    // reject <who> is unchanged
    const one = await cli('contact', 'reject', a);
    expect(one.out.trim()).toBe(`rejected morse.im/${a} — request deleted (not blocked; to block: morse contact block ${a})`);
    // neither: the usage error a missing <address> always gave; both: refused
    for (const cmd of [['contact', 'reject'], ['requests', 'reject']]) {
      const r = await cli(...cmd);
      expect(r.code, cmd.join(' ')).toBe(1);
      expect(r.err.trim()).toBe("error: missing required argument 'address'");
    }
    request(b, 'still here');
    const both = await cli('contact', 'reject', b, '--all');
    expect(both.code).toBe(1);
    expect(both.err.trim()).toBe('error: give an address or --all, not both');
    expect(mailbox().requests.count()).toBe(1);
    expect((await cli('contact', 'reject', '--help')).out).toContain('--all');
  }, 120_000);
});
