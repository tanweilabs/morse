import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPromptHook } from '../src/hooks/prompt-hook.js';
import { agentAddressIndex } from '../src/identity/agent-addresses.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { daemonJson } from './helpers/local-api.js';
import type { FakeRelay } from './helpers/fake-relay.js';
import { addressOf, cliAt, computer, mailboxOf, removeHomes, REPO, someone, startDaemon, until, world, type Computer, type Daemon } from './helpers/personas-home.js';

/**
 * ADR-088 through the real CLI (temp MORSE_HOME + HOME, a fake relay, isolated ports). Two nouns: an ADDRESS is
 * mine, a CONTACT is everyone else.
 *
 *   §1  my name for one of my addresses is given like a contact's remark (`address set --name`), local only;
 *   §3  with one address no name is shown anywhere;
 *   §4  MORSE_ADDRESS=<name|address>: the address a process uses when the command names none — nothing is told
 *       from which program runs the command;
 *   §5  `--from <name>` (the address) and `--session` (where the answer comes back to) are two things;
 *   §6  a new address is online without restarting the daemon;
 *   §7  a name is on one side: not a contact's remark and the name of an address of mine at once;
 *   §8  nothing is renamed by an upgrade.
 */

const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];
const servers: Server[] = [];
afterAll(async () => {
  daemons.forEach((d) => d.stop());
  await Promise.all(relays.map((r) => r.close()));
  await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
  removeHomes();
});
/** The marks agent programs leave in the environment: they change nothing (ADR-088 §4). */
const MARKS: NodeJS.ProcessEnv = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_SANDBOX: 'seatbelt', CODEX_THREAD_ID: 't', KIMI_CLI: '1', MORSE_AGENT: 'codex' };
/** A home on a relay (what `morse address add` needs). */
const onRelay = async (c: Computer): Promise<FakeRelay> => {
  const relay = await world([c]);
  relays.push(relay);
  updateMachineConfig((cfg) => {
    (cfg['relay'] as Record<string, unknown>)['url'] = relay.url;
  }, join(c.home, '.morse', 'config.json'));
  return relay;
};
const lines = (out: string): string[] => out.split('\n').filter(Boolean);

describe('MORSE_ADDRESS: the address a process uses when the command names none (ADR-088 §4)', () => {
  let ann: Computer;
  let codex: string;
  let P: { c: string; x: string };
  const as = (env: NodeJS.ProcessEnv, ...args: string[]) => cliAt(ann.home, args, env);
  const names = (out: string): string[] => (JSON.parse(out) as { contacts: Array<{ remark: string | null }> }).contacts.flatMap((c) => (c.remark ? [c.remark] : [])).sort(); // (the row for yourself has no remark)
  const hook = (home: string, env: NodeJS.ProcessEnv): Promise<{ out: string; err: string; code: number | null }> =>
    new Promise((done) => {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'hook', 'claude-prompt-submit'], { cwd: REPO, env: { ...process.env, ...env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home } });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('close', (code) => done({ out, err, code }));
      p.stdin.end(JSON.stringify({ session_id: `s-${Math.random()}`, prompt: 'hi' }));
    });

  beforeAll(() => {
    ann = computer('ann', 'macmini', ['codex']);
    codex = addressOf(ann, 'codex').address;
    P = { c: someone(), x: someone() };
    const mb = mailboxOf(ann.home);
    mb.contacts.set(mb.contacts.ensureAddress(P.c, '').id, { remark: 'cat' }); // a contact of the first address
    mb.contacts.set(mb.contacts.ensureAddress(P.x, codex).id, { remark: 'xin' }); // a contact of `codex`
    mb.send({ from: { agent: 'claude', sessionId: '', device: P.c }, to: { agent: 'macmini', sessionId: 'inbox' }, text: 'cat to the first', fromTier: 'peer', myAddress: ann.address });
    mb.send({ from: { agent: 'claude', sessionId: '', device: P.x }, to: { agent: 'codex', sessionId: 'inbox' }, text: 'xin to codex', fromTier: 'peer', myAddress: codex });
  });

  it('not set: every address, whoever runs the command — the marks of agent programs (and MORSE_AGENT) change nothing', async () => {
    for (const args of [['contact'], ['contact', '--json'], ['message'], ['message', '--json'], ['address']]) {
      const plain = await as({}, ...args);
      expect(plain.code, args.join(' ')).toBe(0);
      expect(await as(MARKS, ...args), args.join(' ')).toEqual(plain);
    }
    expect(names((await as({}, 'contact', '--json')).out)).toEqual(['cat', 'xin']);
  }, 120_000);

  it('set to a name or an address: that address\'s contacts and mail; --all-addresses everything; --from as written', async () => {
    expect(names((await as({ MORSE_ADDRESS: 'codex' }, 'contact', '--json')).out)).toEqual(['xin']);
    expect(names((await as({ MORSE_ADDRESS: `morse.im/${codex}` }, 'contact', '--json')).out)).toEqual(['xin']);
    expect(names((await as({ MORSE_ADDRESS: 'macmini' }, 'contact', '--json')).out)).toEqual(['cat']);
    expect(names((await as({ MORSE_ADDRESS: 'codex' }, 'contact', '--all-addresses', '--json')).out)).toEqual(['cat', 'xin']);
    expect(names((await as({ MORSE_ADDRESS: 'codex' }, 'contact', '--from', 'macmini', '--json')).out)).toEqual(['cat']);
    const texts = async (env: NodeJS.ProcessEnv, ...more: string[]) => (JSON.parse((await as(env, 'message', '--json', ...more)).out) as { messages: Array<{ text: string }> }).messages.map((m) => m.text).sort();
    expect(await texts({})).toEqual(['cat to the first', 'xin to codex']);
    expect(await texts({ MORSE_ADDRESS: 'macmini' })).toEqual(['cat to the first']);
    expect(await texts({ MORSE_ADDRESS: 'codex' })).toEqual(['xin to codex']);
    expect(await texts({ MORSE_ADDRESS: 'codex' }, '--all-addresses')).toEqual(['cat to the first', 'xin to codex']);
    // a contact of another address is not this one's
    expect((await as({ MORSE_ADDRESS: 'macmini' }, 'contact', 'xin')).code).toBe(1);
    expect((await as({ MORSE_ADDRESS: 'codex' }, 'contact', 'xin')).code).toBe(0);
    expect((await as({}, 'contact', 'xin')).code).toBe(0);
  }, 120_000);

  it('a contact of ANOTHER address than the one named: `contact <who>` / `message <who>` say whose it is and name that address — "add one" only for a contact of none', async () => {
    const before = mailboxOf(ann.home).contacts.findAll(P.c).map((c) => c.myAddress ?? '');
    for (const cmd of ['contact', 'message']) {
      // named by the environment
      expect(await as({ MORSE_ADDRESS: 'codex' }, cmd, 'cat'), cmd).toEqual({ code: 1, out: '', err: 'error: "cat" is a contact of your address macmini, not of codex — add --from macmini, or unset MORSE_ADDRESS\n' });
      // named on the command — by name or by the contact's address
      expect(await as({}, cmd, 'cat', '--from', 'codex'), cmd).toEqual({ code: 1, out: '', err: 'error: "cat" is a contact of your address macmini, not of codex — --from macmini, or leave --from out\n' });
      expect(await as({}, cmd, P.c, '--from', 'codex'), cmd).toEqual({ code: 1, out: '', err: `error: "${P.c}" is a contact of your address macmini, not of codex — --from macmini, or leave --from out\n` });
      expect(await as({ MORSE_ADDRESS: 'macmini' }, cmd, 'xin'), cmd).toEqual({ code: 1, out: '', err: 'error: "xin" is a contact of your address codex, not of macmini — add --from codex, or unset MORSE_ADDRESS\n' });
      // what the line says works
      expect((await as({ MORSE_ADDRESS: 'codex' }, cmd, 'cat', '--from', 'macmini')).code, cmd).toBe(0);
      expect((await as({}, cmd, 'cat')).code, cmd).toBe(0);
    }
    // a contact of none of my addresses: as before
    expect(await as({ MORSE_ADDRESS: 'codex' }, 'contact', 'nobody')).toEqual({ code: 1, out: '', err: 'error: no contact "nobody" of your address codex — morse contact lists them (add one: morse contact add morse.im/<address>)\n' });
    expect(await as({}, 'contact', 'nobody')).toEqual({ code: 1, out: '', err: 'error: no contact "nobody" — morse contact lists them (add one: morse contact add morse.im/<address>)\n' });
    expect(mailboxOf(ann.home).contacts.findAll(P.c).map((c) => c.myAddress ?? '')).toEqual(before); // nobody became a contact of another address
  }, 180_000);

  it('`morse address` marks the address MORSE_ADDRESS selects for this session (several addresses only); naming none is said, not fatal', async () => {
    const two = async (env: NodeJS.ProcessEnv) => lines((await as(env, 'address')).out).slice(0, 2);
    expect(await two({})).toEqual([`address: morse.im/${ann.address}   macmini`, `         morse.im/${codex}   codex`]);
    expect(await two({ MORSE_ADDRESS: 'codex' })).toEqual([`address: morse.im/${ann.address}   macmini`, `         morse.im/${codex}   codex   ← this session (MORSE_ADDRESS)`]);
    expect(await two({ MORSE_ADDRESS: ann.address })).toEqual([`address: morse.im/${ann.address}   macmini   ← this session (MORSE_ADDRESS)`, `         morse.im/${codex}   codex`]);
    const wrong = await as({ MORSE_ADDRESS: 'nosuch' }, 'address');
    expect({ code: wrong.code, err: wrong.err }).toEqual({ code: 0, err: 'warning: MORSE_ADDRESS="nosuch" is not one of your addresses here — morse address lists them\n' });
    expect(lines(wrong.out).slice(0, 2)).toEqual(await two({}));
  }, 120_000);

  it('naming no address here: one clear line for a command — and nothing at all for the hook (it counts as if unset)', async () => {
    for (const args of [['contact'], ['message'], ['contact', 'cat']]) {
      expect(await as({ MORSE_ADDRESS: 'nosuch' }, ...args), args.join(' ')).toEqual({ code: 1, out: '', err: 'error: MORSE_ADDRESS="nosuch" is not one of your addresses here — morse address lists them\n' });
    }
    // said outright, the command's own word wins over the environment
    expect((await as({ MORSE_ADDRESS: 'nosuch' }, 'contact', '--all-addresses')).code).toBe(0);
    expect((await as({ MORSE_ADDRESS: 'nosuch' }, 'contact', '--from', 'codex')).code).toBe(0);
    const unset = await hook(ann.home, {});
    const wrong = await hook(ann.home, { MORSE_ADDRESS: 'nosuch' });
    expect(unset.out).toMatch(/2 new message/);
    expect(wrong).toMatchObject({ code: 0, err: '' });
    expect(wrong.out).toMatch(/2 new message/);
  }, 120_000);

  it('the prompt hook\'s one line counts what was written to that address only', async () => {
    const mb = mailboxOf(ann.home);
    const line = (mineOnly?: string) => processPromptHook(mb, { session_id: `s-${Math.random()}` }, { home: ann.home, ...(mineOnly ? { mineOnly } : {}) }).hookSpecificOutput?.additionalContext ?? '';
    expect(line()).toMatch(/2 new message/);
    expect(line(ann.address)).toMatch(/1 new message/);
    expect(line(ann.address)).toContain('cat');
    expect(line(ann.address)).not.toContain('xin');
    expect(line(codex)).toMatch(/1 new message/);
    // …and the hook of a session started with MORSE_ADDRESS=codex counts codex's mail; the marks of the program change nothing
    const asCodex = await hook(ann.home, { MORSE_ADDRESS: 'codex' });
    expect(asCodex.out).toMatch(/1 new message/);
    expect(asCodex.out).toContain('xin');
    expect((await hook(ann.home, MARKS)).out).toMatch(/2 new message/);
  }, 60_000);

  it('a home with one address: the same output with it named, and whoever runs the command', async () => {
    const one = computer('uno', 'mini');
    const mb = mailboxOf(one.home);
    mb.contacts.set(mb.contacts.ensureAddress(P.c, '').id, { remark: 'cat' });
    for (const args of [['contact'], ['contact', '--json'], ['message'], ['address']]) {
      const plain = await cliAt(one.home, args);
      expect(await cliAt(one.home, args, MARKS), args.join(' ')).toEqual(plain);
      if (args[0] !== 'address') expect(await cliAt(one.home, args, { MORSE_ADDRESS: one.address }), args.join(' ')).toEqual(plain);
    }
  }, 120_000);
});

describe('`morse send`: the address it goes out from, and the session the answer comes back to (ADR-088 §4, §5)', () => {
  let ann: Computer;
  let codex: string;
  let bodies: Array<Record<string, unknown>>;
  let port: string;
  const send = (env: NodeJS.ProcessEnv, ...args: string[]) => cliAt(ann.home, ['send', ...args, '--port', port], env);
  const to = someone();

  beforeAll(async () => {
    ann = computer('ann', 'macmini', ['codex']);
    codex = addressOf(ann, 'codex').address;
    bodies = [];
    // the daemon as far as `send` can tell: it says what it can do, takes the message, echoes the address it goes out from
    const server = createHttpServer((req, res) => {
      const answer = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET') return answer(200, { lan: false, self: null, peers: [], capabilities: ['from-address', 'contacts-per-address', 'local-api-auth'] });
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        bodies.push(body);
        answer(201, { message: { id: `m${bodies.length}`, parts: [] }, resolvedTarget: { agent: 'inbox', title: 'inbox', sessionId: '', device: to }, sentFrom: body['fromAddress'] ?? '' });
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    servers.push(server);
    port = String((server.address() as { port: number }).port);
    daemonJson(ann.home, port);
    // a session of ann's that an answer can come back to
    expect((await cliAt(ann.home, ['connect', '--agent', 'notes', '--session', 'n-1', '--title', 'my notes'])).code).toBe(0);
  }, 60_000);

  it('to a new address: nothing named = the first address (nothing is told the daemon), whoever runs it; MORSE_ADDRESS names one; --from wins — the daemon is told the ADDRESS', async () => {
    bodies.length = 0;
    expect((await send({}, `morse.im/${to}`, 'plain')).code).toBe(0);
    expect((await send(MARKS, `morse.im/${to}`, 'from inside an agent program')).code).toBe(0);
    expect((await send({ MORSE_ADDRESS: 'codex' }, `morse.im/${to}`, 'as codex')).code).toBe(0);
    expect((await send({ MORSE_ADDRESS: codex }, `morse.im/${to}`, 'as codex, by address')).code).toBe(0);
    expect((await send({ MORSE_ADDRESS: 'codex' }, `morse.im/${to}`, 'the first, on purpose', '--from', 'macmini')).code).toBe(0);
    expect(bodies.map((b) => [b['text'], b['fromAddress']])).toEqual([
      ['plain', undefined],
      ['from inside an agent program', undefined],
      ['as codex', codex],
      ['as codex, by address', codex],
      ['the first, on purpose', ann.address],
    ]);
    // naming no address here: one line, nothing sent
    expect(await send({ MORSE_ADDRESS: 'nosuch' }, `morse.im/${to}`, 'x')).toEqual({ code: 1, out: '', err: 'error: MORSE_ADDRESS="nosuch" is not one of your addresses here — morse address lists them\n' });
    expect(bodies).toHaveLength(5);
  }, 60_000);

  it('`--from <name> --session @<agent>:<session>`: both — and `--from @…` alone still means the session', async () => {
    bodies.length = 0;
    expect((await send({}, `morse.im/${to}`, 'both', '--from', 'codex', '--session', '@notes:n-1')).code).toBe(0);
    expect((await send({}, `morse.im/${to}`, 'the old way', '--from', '@notes:n-1')).code).toBe(0);
    expect((await send({ MORSE_ADDRESS: 'codex' }, `morse.im/${to}`, 'codex, with a session', '--from', '@notes:n-1')).code).toBe(0);
    expect(bodies).toMatchObject([
      { text: 'both', fromAddress: codex, from: { agent: 'notes', sessionId: 'n-1' } },
      { text: 'the old way', from: { agent: 'notes', sessionId: 'n-1' } },
      { text: 'codex, with a session', fromAddress: codex, from: { agent: 'notes', sessionId: 'n-1' } },
    ]);
    expect(bodies[1]!['fromAddress']).toBeUndefined();
    const twice = await send({}, `morse.im/${to}`, 'x', '--from', '@notes:n-1', '--session', '@notes:n-1');
    expect(twice).toMatchObject({ code: 1, err: 'error: two sessions were named (--session and --from @…) — --from <name> is the address of yours it goes out from\n' });
    expect(bodies).toHaveLength(3);
  }, 60_000);

  it('a contact of ANOTHER address than the one named: refused with the address it belongs to — never "write to their address from the other one"', async () => {
    const cat = someone();
    const mb = mailboxOf(ann.home);
    mb.contacts.set(mb.contacts.ensureAddress(cat, '').id, { remark: 'cat' }); // a contact of the first address
    bodies.length = 0;
    // named by the environment: the way out is the owning address, or no MORSE_ADDRESS
    expect(await send({ MORSE_ADDRESS: 'codex' }, 'cat', 'hello')).toEqual({
      code: 1,
      out: '',
      err: 'error: "cat" is a contact of your address macmini, not of codex — MORSE_ADDRESS names another address: write to them from the one they belong to — add --from macmini, or unset MORSE_ADDRESS\n',
    });
    // named on the command
    const said = await send({}, 'cat', 'hello', '--from', 'codex');
    expect(said).toEqual({ code: 1, out: '', err: 'error: "cat" is a contact of your address macmini, not of codex — write to them from the address they belong to: --from macmini, or leave --from out\n' });
    for (const r of [said]) expect(r.err).not.toMatch(/use their address|morse\.im\//);
    expect(bodies).toHaveLength(0);
    // doing what the line says goes out from the address the contact belongs to — the second address is not shown to them
    expect((await send({ MORSE_ADDRESS: 'codex' }, 'cat', 'as the line says', '--from', 'macmini')).code).toBe(0);
    expect((await send({}, 'cat', 'no --from at all')).code).toBe(0);
    expect(bodies.map((b) => [b['text'], b['fromAddress']])).toEqual([
      ['as the line says', ann.address],
      ['no --from at all', undefined],
    ]);
    expect(mailboxOf(ann.home).contacts.findAll(cat).map((c) => c.myAddress ?? '')).toEqual(['']); // still a contact of the first address only
  }, 60_000);

  it('a session here (`@…`) is not written to "from an address": MORSE_ADDRESS is not named for it', async () => {
    bodies.length = 0;
    expect((await send({ MORSE_ADDRESS: 'codex' }, '@notes:n-1', 'to a session here')).code).toBe(0);
    expect(bodies[0]!['fromAddress']).toBeUndefined();
  }, 30_000);
});

describe('a new address is online without restarting the daemon (ADR-088 §6)', () => {
  it('`morse address add` tells the running daemon: the address logs in — and says so; `remove`: it is logged out', async () => {
    const ann = computer('ann', 'mini');
    const relay = await onRelay(ann);
    const daemon = await startDaemon(ann, relay);
    daemons.push(daemon);
    expect(relay.onlineAddresses()).toEqual([ann.address]);

    const added = await cliAt(ann.home, ['address', 'add', 'codex']);
    expect(added.code, added.err).toBe(0);
    const codex = agentAddressIndex(ann.home)['codex']!;
    expect(added.out.split('\n').filter(Boolean)).toEqual([`added: codex — morse.im/${codex}   (its own key)`, 'it is online now (the running daemon took it on)']);
    await until(() => relay.onlineAddresses().includes(codex) && relay.onlineAddresses().includes(ann.address));
    expect(daemon.logs.some((l) => l.includes('addresses reloaded') && l.includes(codex.slice(0, 7)))).toBe(true);

    const removed = await cliAt(ann.home, ['address', 'remove', 'codex']);
    expect(removed.out.split('\n').filter(Boolean)).toEqual(['removed: codex — it no longer receives; its key stays in ~/.morse/addresses/', 'the running daemon no longer logs it in']);
    await until(() => !relay.onlineAddresses().includes(codex) && relay.onlineAddresses().includes(ann.address));
  }, 120_000);

  it('no daemon running: it reads the addresses when it starts — the command says to start (restart) it, as before', async () => {
    const ann = computer('ann', 'mini');
    const relay = await onRelay(ann);
    const added = await cliAt(ann.home, ['address', 'add', 'codex']);
    expect(added.out.split('\n').filter(Boolean)[1]).toBe('restart the daemon to bring this address online: morse stop --restart');
  }, 60_000);
});

describe('my name for one of my addresses, given like a contact\'s remark (ADR-088 §1, §3)', () => {
  const agentsJson = (home: string): string => readFileSync(join(home, '.morse', 'addresses', 'agents.json'), 'utf8');
  const labelsJson = (home: string): unknown => JSON.parse(readFileSync(join(home, '.morse', 'addresses', 'labels.json'), 'utf8'));

  it('one address: no name anywhere; `address set --name` needs no selector — and the name still shows nowhere but in the answer', async () => {
    const uno = computer('uno', 'mini');
    const listed = await cliAt(uno.home, ['address']);
    expect(lines(listed.out)[0]).toBe(`address: morse.im/${uno.address}`);
    expect(listed.out).not.toContain('mini');
    const before = agentsJson(uno.home);
    expect(await cliAt(uno.home, ['address', 'set'])).toEqual({ code: 1, out: '', err: 'error: nothing to change — give --name\n' });
    expect(await cliAt(uno.home, ['address', 'set', '--name', 'Home Desk'])).toEqual({ code: 0, out: `address: morse.im/${uno.address}   Home Desk\n`, err: '' });
    expect(labelsJson(uno.home)).toEqual({ v: 1, labels: { [uno.address]: 'Home Desk' } });
    expect(agentsJson(uno.home)).toBe(before); // what the relay directory goes by is untouched
    expect((await cliAt(uno.home, ['address'])).out).toBe(listed.out);
    // the name, the name the directory has (hidden) and the address all say it
    for (const from of ['home desk', 'mini', uno.address]) expect((await cliAt(uno.home, ['contact', '--from', from])).code, from).toBe(0);
    // the hidden `rename` to the name it has: nothing is written (a home that never named anything has no labels.json)
    const due = computer('due', 'pro');
    expect((await cliAt(due.home, ['address', 'rename', 'pro', 'pro'])).code).toBe(0);
    expect((await cliAt(due.home, ['address', 'set', 'pro', '--name', 'pro'])).code).toBe(0);
    expect(existsSync(join(due.home, '.morse', 'addresses', 'labels.json'))).toBe(false);
    // the only address cannot be removed — said without a name
    expect(await cliAt(uno.home, ['address', 'remove', 'home desk'])).toEqual({ code: 1, out: '', err: "error: this is your only address here (it uses this install's own key) — it cannot be removed\n" });
  }, 120_000);

  it('several addresses: each is listed with its name; set by name or by address, "" clears, `rename` is the hidden alias', async () => {
    const ann = computer('ann', 'macmini', ['codex']);
    const B = addressOf(ann, 'codex').address;
    const before = agentsJson(ann.home);
    const mb = mailboxOf(ann.home);
    mb.contacts.set(mb.contacts.ensureAddress(someone(), B).id, { remark: 'xin' });
    const listing = async () => lines((await cliAt(ann.home, ['address'])).out).slice(0, 2);
    expect(await listing()).toEqual([`address: morse.im/${ann.address}   macmini`, `         morse.im/${B}   codex`]);
    expect(await cliAt(ann.home, ['address', 'set', '--name', 'work'])).toEqual({ code: 1, out: '', err: 'error: give one of your addresses (its name, or the address) — morse address lists them\n' });
    expect(await cliAt(ann.home, ['address', 'set', 'nosuch', '--name', 'work'])).toEqual({ code: 1, out: '', err: 'error: "nosuch" is not one of your addresses here — morse address lists them\n' });
    expect(await cliAt(ann.home, ['address', 'set', 'codex', '--name', '工作'])).toEqual({ code: 0, out: `address: morse.im/${B}   工作\n`, err: '' });
    expect(await listing()).toEqual([`address: morse.im/${ann.address}   macmini`, `         morse.im/${B}   工作`]);
    expect((await cliAt(ann.home, ['contact'])).out).toContain('via 工作');
    // by its name, by the name it had (hidden), by the address
    for (const from of ['工作', 'codex', `morse.im/${B}`]) expect((await cliAt(ann.home, ['contact', '--from', from, '--json'])).out, from).toContain('"xin"');
    expect(await cliAt(ann.home, ['address', 'set', `morse.im/${B}`, '--name', 'Side Project'])).toEqual({ code: 0, out: `address: morse.im/${B}   Side Project\n`, err: '' });
    expect(await cliAt(ann.home, ['address', 'rename', 'side project', 'lab'])).toEqual({ code: 0, out: `address: morse.im/${B}   lab\n`, err: '' });
    // refused, nothing changed: another address's name (any case), a command word, an address, a session
    for (const [name, err] of [
      ['MacMini', 'error: the name "MacMini" is already used for another address\n'],
      ['set', 'error: "set" is a command word — pick another name\n'],
      [ann.address, `error: the name "${ann.address}" looks like an address (26 characters of the address alphabet) — pick another name\n`],
      ['@codex:front', 'error: the name "@codex:front" looks like a session (@… or a colon) — pick another name\n'],
    ] as Array<[string, string]>)
      expect(await cliAt(ann.home, ['address', 'set', 'lab', '--name', name]), name).toEqual({ code: 1, out: '', err });
    expect(labelsJson(ann.home)).toEqual({ v: 1, labels: { [B]: 'lab' } });
    // "" clears it: the address is said by itself
    expect(await cliAt(ann.home, ['address', 'set', 'lab', '--name', ''])).toEqual({ code: 0, out: `address: morse.im/${B}   (name cleared — it is shown by its address)\n`, err: '' });
    // again, or a blank name: said as what it is — never taken for a name
    expect(await cliAt(ann.home, ['address', 'set', B, '--name', '   '])).toEqual({ code: 0, out: `address: morse.im/${B}   (it has no name)\n`, err: '' });
    expect(await listing()).toEqual([`address: morse.im/${ann.address}   macmini`, `         morse.im/${B}`]);
    expect((await cliAt(ann.home, ['contact'])).out).toContain(`via morse.im/${B}`);
    expect((await cliAt(ann.home, ['contact', '--from', B, '--json'])).out).toContain('"xin"');
    expect(agentsJson(ann.home)).toBe(before);
    // help: the documented verbs are add, set, remove — like `morse contact`
    const help = (await cliAt(ann.home, ['address', '--help'])).out;
    expect(help).toMatch(/^\s+add /m);
    expect(help).toMatch(/^\s+set /m);
    expect(help).toMatch(/^\s+remove /m);
    expect(help).not.toMatch(/^\s+rename /m);
  }, 180_000);

  it('`morse address add`: with a name, with a name the directory cannot keep, with none — the address is shown by itself until it is named', async () => {
    const ann = computer('ann', 'mini');
    await onRelay(ann);
    const index = () => (JSON.parse(agentsJson(ann.home)) as { agents: Record<string, string> }).agents;
    const work = await cliAt(ann.home, ['address', 'add', 'work']);
    expect(work.code, work.err).toBe(0);
    const W = index()['work']!;
    expect(lines(work.out)[0]).toBe(`added: work — morse.im/${W}   (its own key)`);
    const zh = await cliAt(ann.home, ['address', 'add', '工作']);
    expect(zh.code, zh.err).toBe(0);
    const Z = index()['address-3']!;
    expect(lines(zh.out)[0]).toBe(`added: 工作 — morse.im/${Z}   (its own key)`);
    const bare = await cliAt(ann.home, ['address', 'add']);
    expect(bare.code, bare.err).toBe(0);
    const N = index()['address-4']!;
    expect(lines(bare.out)[0]).toBe(`added: morse.im/${N}   (its own key)`);
    expect(labelsJson(ann.home)).toEqual({ v: 1, labels: { [Z]: '工作' }, unnamed: [N] });
    expect(lines((await cliAt(ann.home, ['address'])).out).slice(0, 4)).toEqual([`address: morse.im/${ann.address}   mini`, `         morse.im/${W}   work`, `         morse.im/${Z}   工作`, `         morse.im/${N}`]);
    // an address with no name is said by itself — and can be named
    expect((await cliAt(ann.home, ['contact', '--from', N])).code).toBe(0);
    expect((await cliAt(ann.home, ['contact', '--from', 'address-4'])).code).toBe(0); // (hidden: what the directory has)
    // …so a contact cannot be called that (ADR-088 §7): of the unnamed address, and of the one that is called 工作
    for (const hiddenName of ['address-4', 'Address-3'])
      expect(await cliAt(ann.home, ['contact', 'add', `morse.im/${someone()}`, '--name', hiddenName]), hiddenName).toEqual({ code: 1, out: '', err: `error: "${hiddenName}" is already the name of one of your addresses — pick another remark\n` });
    expect(mailboxOf(ann.home).contacts.list().filter((c) => c.id !== 'self')).toHaveLength(0);
    expect(await cliAt(ann.home, ['address', 'set', N, '--name', 'lab'])).toEqual({ code: 0, out: `address: morse.im/${N}   lab\n`, err: '' });
    // the same name again: as it always was for the address that has it; never a second address under one name
    expect(lines((await cliAt(ann.home, ['address', 'add', 'work'])).out)[0]).toBe(`already there: work — morse.im/${W}   (its own key)`);
    expect(await cliAt(ann.home, ['address', 'add', '工作'])).toEqual({ code: 1, out: '', err: 'error: the name "工作" is already used for another address\n' });
    expect(await cliAt(ann.home, ['address', 'add', 'LAB'])).toEqual({ code: 1, out: '', err: 'error: the name "LAB" is already used for another address\n' });
    expect(await cliAt(ann.home, ['address', 'add', 'remove'])).toEqual({ code: 1, out: '', err: 'error: "remove" is a command word — pick another name\n' });
    expect(Object.keys(index())).toEqual(['mini', 'work', 'address-3', 'address-4']);
    // removed by the name it is shown under; what was said about its name goes with it
    expect(lines((await cliAt(ann.home, ['address', 'remove', '工作'])).out)[0]).toBe('removed: 工作 — it no longer receives; its key stays in ~/.morse/addresses/');
    expect(lines((await cliAt(ann.home, ['address', 'remove', 'lab'])).out)[0]).toBe('removed: lab — it no longer receives; its key stays in ~/.morse/addresses/');
    expect(labelsJson(ann.home)).toEqual({ v: 1, labels: {} });
    expect(Object.keys(index())).toEqual(['mini', 'work']);
  }, 240_000);
});

describe('a message row keeps one stable name for my address; the name shown is the one it has now (ADR-088 §1)', () => {
  it('an address named anew: mail that came in before and mail sent after are listed under the same name — the one `via` says; the rows and JSON keep what the directory has', async () => {
    const ann = computer('ann', 'macmini', ['codex']);
    const B = addressOf(ann, 'codex').address;
    const xin = computer('xin', 'xin-pc');
    const relay = await world([ann, xin]);
    relays.push(relay);
    updateMachineConfig((cfg) => {
      (cfg['relay'] as Record<string, unknown>)['url'] = relay.url;
    }, join(ann.home, '.morse', 'config.json'));
    const daemon = await startDaemon(ann, relay);
    daemons.push(daemon, await startDaemon(xin, relay, { memory: true })); // (xin is online: its address is published)
    const peer = xin.address;
    const mb = mailboxOf(ann.home);
    mb.contacts.set(mb.contacts.ensureAddress(peer, B).id, { remark: 'xin' });
    mb.send({ from: { agent: 'claude', sessionId: '', device: peer }, to: { agent: 'codex', sessionId: 'inbox' }, text: 'xin to codex, before the name changed', fromTier: 'peer', myAddress: B });
    expect((await cliAt(ann.home, ['address', 'set', 'codex', '--name', '工作'])).code).toBe(0);
    // sent after: by the new name, and once by the name it had
    for (const from of ['工作', 'codex']) {
      const sent = await cliAt(ann.home, ['send', 'xin', `sent as ${from}`, '--from', from, '--port', daemon.port]);
      expect(sent.code, sent.err + sent.out).toBe(0);
    }
    const rows = mailboxOf(ann.home).history(`a:${peer}~${B}`);
    expect(rows.map((m) => [m.direction, m.myAddress, m.direction === 'out' ? m.myAgent : m.to.agent])).toEqual([
      ['in', B, 'codex'],
      ['out', B, 'codex'],
      ['out', B, 'codex'],
    ]);
    // listed: one name for my side on every row — never the two mixed
    const listed = lines((await cliAt(ann.home, ['message', 'xin'])).out).filter((l) => l.startsWith('['));
    expect(listed).toHaveLength(3);
    // (ADR-091) a contact's line names no agent: their address, my side as `via`
    expect(listed[0]).toMatch(/^\[\w+\] ← xin \(morse\.im\/\w{26}\) .* via 工作$/);
    for (const l of listed.slice(1)) expect(l).toMatch(/^\[\w+\] → xin \(morse\.im\/\w{26}\) .* via 工作$/);
    expect(listed.join('\n')).not.toContain('codex');
    // JSON: the stored name (stable for scripts), and the address with the name it has now
    const json = JSON.parse((await cliAt(ann.home, ['message', 'xin', '--json'])).out) as { messages: Array<{ agent: string; myAddress: unknown }> };
    expect(json.messages.map((m) => [m.agent, m.myAddress])).toEqual([
      ['codex', { name: '工作', address: B }],
      ['codex', { name: '工作', address: B }],
      ['codex', { name: '工作', address: B }],
    ]);
    // no name at all: the short form of the address, the same on every row
    expect((await cliAt(ann.home, ['address', 'set', '工作', '--name', ''])).code).toBe(0);
    const bare = lines((await cliAt(ann.home, ['message', 'xin'])).out).filter((l) => l.startsWith('['));
    expect(bare[0]).toMatch(/^\[\w+\] ← xin /);
    for (const l of bare) expect(l).toMatch(new RegExp(` via morse\\.im/${B}$`));
    expect(bare.join('\n')).not.toMatch(/codex|工作/);
  }, 180_000);
});

describe('a name is on one side: an address of mine, or a contact (ADR-088 §7)', () => {
  const remarks = (home: string): string[] =>
    mailboxOf(home)
      .contacts.list()
      .flatMap((c) => (c.remark ? [c.remark] : []))
      .sort();

  it('naming an address of mine: not a contact\'s remark (any case) — set, the hidden rename, add', async () => {
    const ann = computer('ann', 'macmini', ['codex']);
    await onRelay(ann);
    const mb = mailboxOf(ann.home);
    mb.contacts.set(mb.contacts.ensureAddress(someone(), '').id, { remark: 'Cat' });
    const refused = { code: 1, out: '', err: 'error: "cat" is already the remark of one of your contacts — pick another name\n' };
    const index = readFileSync(join(ann.home, '.morse', 'addresses', 'agents.json'), 'utf8');
    expect(await cliAt(ann.home, ['address', 'set', 'codex', '--name', 'cat'])).toEqual(refused);
    expect(await cliAt(ann.home, ['address', 'rename', 'codex', 'cat'])).toEqual(refused);
    expect(await cliAt(ann.home, ['address', 'add', 'cat'])).toEqual(refused);
    expect(readFileSync(join(ann.home, '.morse', 'addresses', 'agents.json'), 'utf8')).toBe(index);
    expect(existsSync(join(ann.home, '.morse', 'addresses', 'labels.json'))).toBe(false);
  }, 120_000);

  it('giving a contact a remark: not the name of one of my addresses (any case) — contact add --name, contact set --name; nothing is added or changed', async () => {
    const ann = computer('ann', 'macmini', ['codex']);
    const mb = mailboxOf(ann.home);
    mb.contacts.set(mb.contacts.ensureAddress(someone(), '').id, { remark: 'cat' });
    const refused = (name: string) => ({ code: 1, out: '', err: `error: "${name}" is already the name of one of your addresses — pick another remark\n` });
    expect(await cliAt(ann.home, ['contact', 'set', 'cat', '--name', 'CODEX'])).toEqual(refused('CODEX'));
    expect(await cliAt(ann.home, ['contact', 'add', `morse.im/${someone()}`, '--name', 'macmini'])).toEqual(refused('macmini'));
    expect(remarks(ann.home)).toEqual(['cat']);
    expect(mailboxOf(ann.home).contacts.list().filter((c) => c.id !== 'self')).toHaveLength(1);
    // a name I gave an address counts like any other — and so does the name it had before, hidden: `--from codex` still means it
    expect((await cliAt(ann.home, ['address', 'set', 'codex', '--name', 'Work'])).code).toBe(0);
    expect(await cliAt(ann.home, ['contact', 'set', 'cat', '--name', 'work'])).toEqual(refused('work'));
    expect(await cliAt(ann.home, ['contact', 'set', 'cat', '--name', 'Codex'])).toEqual(refused('Codex'));
    expect(await cliAt(ann.home, ['contact', 'add', `morse.im/${someone()}`, '--name', 'codex'])).toEqual(refused('codex'));
    // …also of an address that has no name at all now
    expect((await cliAt(ann.home, ['address', 'set', 'work', '--name', ''])).code).toBe(0);
    expect(await cliAt(ann.home, ['contact', 'set', 'cat', '--name', 'codex'])).toEqual(refused('codex'));
    expect(remarks(ann.home)).toEqual(['cat']);
    expect(mailboxOf(ann.home).contacts.list().filter((c) => c.id !== 'self')).toHaveLength(1);
  }, 120_000);

  it('one address: the name the directory has for it is shown nowhere and is nobody\'s — only a name I gave it counts', async () => {
    const uno = computer('uno', 'mini');
    const mb = mailboxOf(uno.home);
    mb.contacts.set(mb.contacts.ensureAddress(someone(), '').id, { remark: 'cat' });
    expect((await cliAt(uno.home, ['contact', 'set', 'cat', '--name', 'mini'])).code).toBe(0);
    expect((await cliAt(uno.home, ['address', 'set', '--name', 'desk'])).code).toBe(0);
    expect(await cliAt(uno.home, ['contact', 'set', 'mini', '--name', 'Desk'])).toEqual({ code: 1, out: '', err: 'error: "Desk" is already the name of one of your addresses — pick another remark\n' });
    expect(await cliAt(uno.home, ['address', 'set', '--name', 'MINI'])).toEqual({ code: 1, out: '', err: 'error: "MINI" is already the remark of one of your contacts — pick another name\n' });
    // the install-time name of an address whose name was cleared stays a way to say it (`--from pro`): not a remark
    const due = computer('due', 'pro');
    mailboxOf(due.home).contacts.set(mailboxOf(due.home).contacts.ensureAddress(someone(), '').id, { remark: 'cat' });
    expect((await cliAt(due.home, ['address', 'set', '--name', ''])).code).toBe(0);
    expect((await cliAt(due.home, ['contact', '--from', 'pro'])).code).toBe(0);
    expect(await cliAt(due.home, ['contact', 'set', 'cat', '--name', 'Pro'])).toEqual({ code: 1, out: '', err: 'error: "Pro" is already the name of one of your addresses — pick another remark\n' });
  }, 180_000);

  it('names are compared NFC-normalised on both sides: a precomposed and a decomposed "café" are one name', async () => {
    const [nfc, nfd] = ['caf\u00e9', 'cafe\u0301'];
    const ann = computer('ann', 'macmini', ['codex']);
    const B = addressOf(ann, 'codex').address;
    const mb = mailboxOf(ann.home);
    mb.contacts.set(mb.contacts.ensureAddress(someone(), '').id, { remark: 'cat' });
    mb.contacts.set(mb.contacts.ensureAddress(someone(), '').id, { remark: 'dog' });
    // my address, typed decomposed: kept precomposed; a contact cannot take either form
    expect(await cliAt(ann.home, ['address', 'set', 'codex', '--name', nfd])).toEqual({ code: 0, out: `address: morse.im/${B}   ${nfc}\n`, err: '' });
    for (const form of [nfc, nfd, nfd.toUpperCase()])
      expect(await cliAt(ann.home, ['contact', 'set', 'cat', '--name', form]), JSON.stringify(form)).toEqual({ code: 1, out: '', err: `error: "${form.normalize('NFC')}" is already the name of one of your addresses — pick another remark\n` });
    expect((await cliAt(ann.home, ['contact', '--from', nfd])).code).toBe(0);
    // the other way round: a contact's remark typed decomposed; my address cannot take either form, nor can another contact
    expect((await cliAt(ann.home, ['address', 'set', nfc, '--name', 'codex'])).code).toBe(0);
    expect((await cliAt(ann.home, ['contact', 'set', 'cat', '--name', nfd])).code).toBe(0);
    expect(remarks(ann.home)).toEqual([nfc, 'dog']);
    for (const form of [nfc, nfd])
      expect(await cliAt(ann.home, ['address', 'set', 'codex', '--name', form]), JSON.stringify(form)).toEqual({ code: 1, out: '', err: `error: "${nfc}" is already the remark of one of your contacts — pick another name\n` });
    expect(await cliAt(ann.home, ['contact', 'set', 'dog', '--name', nfc])).toMatchObject({ code: 1, err: `error: the name "${nfc}" is already used for another contact\n` });
    // found whichever way it is typed
    for (const form of [nfc, nfd]) expect((await cliAt(ann.home, ['contact', form])).code, JSON.stringify(form)).toBe(0);
  }, 180_000);

  it('a collision from before stays as it is: nothing is renamed, the listings are the same, each side still resolves its own — only NEW naming is checked', async () => {
    const ann = computer('ann', 'macmini', ['codex']);
    const B = addressOf(ann, 'codex').address;
    const peer = someone();
    const mb = mailboxOf(ann.home);
    mb.contacts.set(mb.contacts.ensureAddress(peer, '').id, { remark: 'codex' }); // (a home of a release before could have this)
    const contacts = await cliAt(ann.home, ['contact']);
    expect(contacts.code).toBe(0);
    expect(contacts.out).toContain(`codex (morse.im/${peer})`);
    expect(lines((await cliAt(ann.home, ['address'])).out).slice(0, 2)).toEqual([`address: morse.im/${ann.address}   macmini`, `         morse.im/${B}   codex`]);
    // the contact is found by its remark; the address by its name
    expect((await cliAt(ann.home, ['contact', 'codex'])).out).toContain(`morse.im/${peer}`);
    expect((await cliAt(ann.home, ['contact', '--from', 'codex'])).code).toBe(0);
    // changing something else, or saying the name it has: not refused
    expect((await cliAt(ann.home, ['contact', 'set', 'codex', '--group', 'friend'])).code).toBe(0);
    expect((await cliAt(ann.home, ['contact', 'set', 'codex', '--name', 'Codex'])).code).toBe(0);
    expect(await cliAt(ann.home, ['address', 'set', 'codex', '--name', 'codex'])).toEqual({ code: 0, out: `address: morse.im/${B}   codex\n`, err: '' });
    expect(remarks(ann.home)).toEqual(['Codex']);
    // a new name is checked as ever
    expect((await cliAt(ann.home, ['address', 'set', 'macmini', '--name', 'CODEX'])).code).toBe(1);
  }, 180_000);
});

describe('nothing is renamed by an upgrade (ADR-088 §8)', () => {
  it('a home of a release before — addresses called macmini / codex / helper, or one called win: after the daemon ran and the commands were used, by whatever program, the names are the same and nothing was written about them', async () => {
    for (const [first, more] of [['macmini', ['codex', 'helper']], ['win', []]] as Array<[string, string[]]>) {
      const old = computer(`old-${first}`, first, more);
      const relay = await onRelay(old);
      const files = ['addresses/agents.json', 'config.json'].map((f) => join(old.home, '.morse', f));
      const agentsOf = () => JSON.stringify((JSON.parse(readFileSync(files[1]!, 'utf8')) as { relay: { agents?: unknown } }).relay.agents);
      const before = [readFileSync(files[0]!, 'utf8'), agentsOf()];
      const daemon = await startDaemon(old, relay);
      daemons.push(daemon);
      for (const env of [{}, MARKS]) for (const args of [['address'], ['contact'], ['message']]) expect((await cliAt(old.home, args, env)).code, args.join(' ')).toBe(0);
      const listed = lines((await cliAt(old.home, ['address'], MARKS)).out);
      if (more.length) expect(listed.slice(0, 3).map((l) => l.trim().split(/\s+/).pop())).toEqual(['macmini', 'codex', 'helper']);
      else expect(listed[0]).toBe(`address: morse.im/${old.address}`);
      // there is no command that renames by itself
      expect((await cliAt(old.home, ['address', 'adopt'], MARKS)).code).not.toBe(0);
      daemon.stop();
      expect([readFileSync(files[0]!, 'utf8'), agentsOf()]).toEqual(before);
      expect(existsSync(join(old.home, '.morse', 'addresses', 'labels.json'))).toBe(false);
    }
  }, 240_000);
});
