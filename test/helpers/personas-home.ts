import { ownAddressByName } from '../../src/daemon/own-address.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeRelay, type FakeRelay } from './fake-relay.js';
import { agentRequest } from '../../src/cluster/agents.js';
import { loadOrCreateIdentity } from '../../src/cluster/identity.js';
import { startMorse, INBOX_AGENT, type Morse, type MorseSendResult } from '../../src/cluster/morse.js';
import { startConsoleServer } from '../../src/daemon/server.js';
import { loadPrimaryAddress, type AddressKey } from '../../src/identity/address-key.js';
import { ensureAgentAddresses } from '../../src/identity/agent-addresses.js';
import { updateMachineConfig } from '../../src/machine-config.js';
import { createDb, type Db } from '../../src/mailbox/db.js';
import { homeContactContext } from '../../src/mailbox/home-context.js';
import { createMailbox, type Mailbox, type Message } from '../../src/mailbox/mailbox.js';
import { countSpawn } from './spawn-budget.js';
import { daemonJson, realServerOn, TEST_TOKEN, withPortOf } from './local-api.js';

/**
 * (ADR-083) Shared by test/cli-personas.test.ts and test/plugin-personas.test.ts: a computer in a temp
 * home (never the real one), the real CLI spawned against it, this release's daemon in this process on
 * the in-memory fake relay — and the ONE-address home whose command output must not change.
 *
 * `seedOneAddressHome` + `oneAddressSteps` + `normaliser` are exactly what produced the "before"
 * strings in test/cli-personas.test.ts from the released code (commit af4ca40: this file was copied
 * into an extracted tree of that commit and run there). So everything in this file uses only what
 * that release already had — no `--from` on a contact command, no `myAddress` on a store call.
 */

export const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const homes: string[] = [];
/** A temp directory used as MORSE_HOME + HOME (realpath: what the commands print is what we compare). */
export const freshHome = (prefix = 'morse-personas-'): string => {
  const h = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  homes.push(h);
  return h;
};
export const removeHomes = (): void => homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true }));

export interface Ran {
  code: number | null;
  out: string;
  err: string;
}
/** `morse <args>` — the real CLI of this tree, with MORSE_HOME + ANYTOANY_HOME + HOME set to `home`. */
export const cliAt = (home: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> => withPortOf(home, args, () => cliRaw(home, args, env));
/** …exactly as given: the home's daemon.json is not touched (a test of what a command does WITHOUT one). */
export const cliRaw = (home: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> =>
  new Promise((done) => {
    countSpawn(); // (test/helpers/spawn-budget.ts: a test's timeout is proportional to the times it starts the CLI)
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: REPO, env: { ...process.env, ...env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err }));
  });

export const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const until = async (cond: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
};

export interface Computer {
  home: string;
  /** The device ID. */
  id: string;
  handle: string;
  /** The name of its first address. */
  agent: string;
  /** Its first address (the device key's). */
  address: string;
}
/** A computer that joined Morse: its config says who it is; `more` = addresses added later (each its own key). */
export const computer = (handle: string, agent: string, more: string[] = []): Computer => {
  const home = freshHome();
  const identity = loadOrCreateIdentity(home);
  updateMachineConfig((cfg) => {
    cfg['relay'] = { handle, agent, agents: [agent, ...more] };
  }, join(home, '.morse', 'config.json'));
  const c = { home, id: identity.id, handle, agent, address: loadPrimaryAddress(home, identity).address };
  ensureAgentAddresses(home); // every address has its key (and agents.json names it) before a command asks
  storeOf(home); // the database exists before the first command (which would say so on stderr)
  return c;
};
/** The key (and `.address`) of the address named `name`. */
export const addressOf = (c: Computer, name: string): AddressKey => ensureAgentAddresses(c.home).find((a) => a.agent === name)!.key;
/** An address somebody else holds (a key in a home of its own); nobody is online there. */
export const someone = (): string => loadPrimaryAddress(freshHome()).address;
/**
 * `n` such addresses that begin with a digit, ascending. `morse contact` sorts by remark, old name or
 * address: these come before every name (a letter), in this order — so a listing reads the same every run.
 */
export const strangers = (n: number): string[] => {
  const out: string[] = [];
  while (out.length < n) {
    const a = someone();
    if (/^\d/.test(a)) out.push(a);
  }
  return out.sort();
};

const stores = new Map<string, { db: Db; mailbox: Mailbox }>();
/** The home's database and mailbox, as a command opens them (one connection per home for the whole file). */
export const storeOf = (home: string): { db: Db; mailbox: Mailbox } => {
  let s = stores.get(home);
  if (!s) {
    const ctx = homeContactContext(home);
    const db = createDb(join(home, '.morse', 'mailbox.db'), { ctx });
    s = { db, mailbox: createMailbox(db, { ctx }) };
    stores.set(home, s);
  }
  return s;
};
export const mailboxOf = (home: string): Mailbox => storeOf(home).mailbox;

/** The fake relay with these computers on it (each under its own old name, its first address in the directory). */
export const world = async (computers: Computer[]): Promise<FakeRelay> => {
  const relay = await startFakeRelay({ port: 0, host: '127.0.0.1', v3: true, allowlist: computers.map((c) => ({ id: c.id, handle: c.handle })), log: () => undefined });
  for (const c of computers) await agentRequest({ url: relay.url, op: 'add', agent: c.agent, home: c.home });
  return relay;
};

export interface Daemon {
  morse: Morse;
  mailbox: Mailbox;
  /** The console port (`--port`). */
  port: string;
  logs: string[];
  /** What the outbox does: everything that is due goes to the transport, the outcome is recorded. */
  flush(): Promise<MorseSendResult[]>;
  stop(): void;
}
/**
 * This release's daemon for a computer, in this process: the real transport on the fake relay and the
 * real console server (`morse send` posts there), wired as `morse start` wires them. `memory`: a peer
 * whose mailbox no command reads. There is no outbox loop: a queued message stays `pending` until `flush()`.
 */
export const startDaemon = async (c: Computer, relay: FakeRelay, o: { memory?: boolean } = {}): Promise<Daemon> => {
  const ctx = homeContactContext(c.home);
  const mailbox = createMailbox(createDb(o.memory ? ':memory:' : join(c.home, '.morse', 'mailbox.db'), { ctx }), { ctx });
  const logs: string[] = [];
  const morse = startMorse({ url: relay.url, home: c.home, mailbox, receiptTimeoutMs: 1500, connectWaitMs: 1000, log: (l) => logs.push(l) });
  await until(() => Boolean(morse.v3Client?.()?.connected()));
  await until(() => ensureAgentAddresses(c.home).every((a) => relay.onlineAddresses().includes(a.key.address)));
  const port = await freePort();
  const server = startConsoleServer({ token: TEST_TOKEN, 
    mailbox,
    directory: async () => [],
    port,
    changePollMs: 60_000,
    knowsDevice: (d) => morse.knows(d),
    pairPerson: async (handle) => morse.pairHandle(handle),
    addressRoute: (target, from) => morse.addressRoute!(target, from),
    ownAddress: ownAddressByName((from) => morse.ownAddress!(from), c.home), // as `morse start` wires it (ADR-088)
    acceptAddress: (address, from) => morse.acceptAddress!(address, from),
    reloadAddresses: () => morse.reloadAddresses!(), // (ADR-088 §6) as `morse start` wires it
  });
  // (ADR-087) this home's daemon.json: a command run with this home talks to this server — and to no other
  realServerOn(port);
  if (!o.memory) daemonJson(c.home, port);
  const deliver = async (m: Message): Promise<MorseSendResult> => {
    const r = await morse.send(m.to.device!, m);
    if (r.ok) mailbox.markDelivered(m.id);
    else mailbox.markFailed(m.id, r.error ?? 'failed', r.waiting ? { waiting: true } : undefined);
    return r;
  };
  return {
    morse,
    mailbox,
    port: String(port),
    logs,
    async flush() {
      const out: MorseSendResult[] = [];
      for (let m = mailbox.claimNextPending({ scope: 'outbound' }); m; m = mailbox.claimNextPending({ scope: 'outbound' })) out.push(await deliver(m));
      return out;
    },
    stop() {
      server.close();
      morse.stop();
    },
  };
};

// --- the ONE-address home ----------------------------------------------------------------------------

/** The seeded mail is stamped from here on, a minute apart (nothing in it depends on when the test runs). */
export const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);

export interface OneAddressPeers {
  /** A contact by address with a remark (`xin`), online on the relay. */
  x: string;
  /** A contact by address without a remark. (`y` and `r` from `strangers`: y < r1 < … < r5.) */
  y: string;
  /** A blocked contact by address (`zed`). */
  z: string;
  /** Addresses whose message request waits (r1 … r5). */
  r: string[];
}
export interface OneAddressHome {
  /** placeholder → value, for `normaliser` (addresses, the home, the seeded message ids). */
  vars: Record<string, string>;
  /** What the commands that built it printed (name → result) — compared like every other step. */
  setup: Array<{ name: string; args: string[]; ran: Ran }>;
}

/**
 * The home of a computer with ONE address (`ann`, first address `mini`): an old-handle contact with a
 * remark and one that is blocked, contacts by address with and without a remark, a blocked one,
 * message requests the old way and by address, received / answered / unread mail. Commands first
 * (what they print is part of the comparison), then mail and requests through the store with a fixed
 * clock — the same calls in the release before and in this one.
 */
export async function seedOneAddressHome(c: Computer, p: OneAddressPeers, deadPort: string): Promise<OneAddressHome> {
  const setup: OneAddressHome['setup'] = [];
  const run = async (name: string, ...args: string[]) => setup.push({ name, args, ran: await cliAt(c.home, args) });
  await run('add x --name --group', 'contact', 'add', `morse.im/${p.x}`, '--name', 'xin', '--group', 'friend', '--port', deadPort);
  await run('add y (bare)', 'contact', 'add', p.y, '--port', deadPort);
  await run('add y again --json', 'contact', 'add', `morse.im/${p.y}`, '--port', deadPort, '--json');
  await run('add z --name', 'contact', 'add', p.z, '--name', 'zed', '--port', deadPort);
  await run('block zed', 'contact', 'block', 'zed');

  let t = T0;
  const ctx = homeContactContext(c.home);
  const mb = createMailbox(createDb(join(c.home, '.morse', 'mailbox.db'), { ctx }), { ctx, now: () => (t += 60_000) });
  const session = { agent: 'claude', sessionId: 's-1' };
  const inbox = { agent: c.agent, sessionId: 'inbox' };
  mb.contacts.set(mb.contacts.ensure('kai').id, { remark: 'Kai', group: 'colleague' });
  const kaiIn = mb.send({ from: { agent: 'claude', sessionId: '', device: 'kai/mbp' }, to: inbox, text: 'hi from kai, the old way', fromTier: 'peer' });
  const kaiOut = mb.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'kai' }, text: 'hello kai' });
  mb.claimNextPending({ scope: 'outbound' }); // (the outbox took it and it went out)
  mb.markDelivered(kaiOut.id);
  const byAddress = (text: string) => mb.send({ from: { agent: 'claude', sessionId: '', device: p.x }, to: inbox, text, fromTier: 'peer', myAddress: c.address });
  const xIn1 = byAddress('first from xin');
  const xOut = mb.reply(xIn1.id, 'an answer to xin');
  mb.markProcessed([xIn1.id], 'reply');
  const xIn2 = byAddress('second from xin\nwith two lines');
  const xIn3 = byAddress('third from xin');
  const request = (handle: string, text: string, more: Record<string, unknown> = {}) =>
    mb.requests.file({ handle, deviceId: handle, msgId: `r-${text.replace(/\W+/g, '-')}`, from: { agent: 'claude', sessionId: '' }, to: inbox, toAddress: c.address, text, droppedFiles: 0, via: 'morse-relay', ...more });
  request('oldname', 'let me in, the old way', { deviceId: 'OLDDEV7-AAAAAAA-BBBBBBB', deviceName: 'old-mbp', fromAgent: 'old-mbp', toAddress: undefined });
  request('othername', 'me too, the old way', { deviceId: 'OTHERD7-AAAAAAA-BBBBBBB', toAddress: undefined, droppedFiles: 2 });
  p.r.forEach((r, i) => request(r, `request ${i + 1} by address`));

  const vars: Record<string, string> = { HOME: c.home, MINE: c.address, X: p.x, Y: p.y, Z: p.z, DEVICE: c.id };
  p.r.forEach((r, i) => (vars[`R${i + 1}`] = r));
  for (const [k, m] of Object.entries({ kaiIn, kaiOut, xIn1, xOut, xIn2, xIn3 })) vars[`id:${k}`] = m.id;
  return { vars, setup };
}

export interface Step {
  name: string;
  args: string[];
  /** The output is JSON: compared field by field (this release may only ADD fields). */
  json?: boolean;
}
/**
 * The commands whose output is compared, in this order (the later ones change things). `port` = the
 * running daemon's console, `dead` = a port nobody listens on.
 */
export function oneAddressSteps(v: Record<string, string>, port: string, dead: string): Step[] {
  const X = v['X']!;
  const Y = v['Y']!;
  const R = (n: number) => v[`R${n}`]!;
  const both = (name: string, ...args: string[]): Step[] => [
    { name, args },
    { name: `${name} --json`, args: [...args, '--json'], json: true },
  ];
  return [
    // reading
    ...both('contact', 'contact'),
    { name: 'contacts (alias)', args: ['contacts'] },
    ...both('contact Kai', 'contact', 'Kai'),
    { name: 'contact morse.im/kai', args: ['contact', 'morse.im/kai'] },
    ...both('contact xin', 'contact', 'xin'),
    { name: 'contact <x address>', args: ['contact', X] },
    ...both('contact morse.im/<y>', 'contact', `morse.im/${Y}`),
    ...both('contact zed', 'contact', 'zed'),
    ...both('contact me', 'contact', 'me'),
    ...both('contact nobody', 'contact', 'nobody'),
    ...both('message', 'message'),
    ...both('message --all', 'message', '--all'),
    { name: 'inbox (alias)', args: ['inbox'] },
    ...both('message Kai', 'message', 'Kai'),
    ...both('message xin', 'message', 'xin'),
    { name: 'message <x address> --limit 2', args: ['message', X, '--limit', '2'] },
    { name: 'history xin (alias)', args: ['history', 'xin'] },
    ...both('message <y> (nothing yet)', 'message', Y),
    ...both('message --id xIn2', 'message', '--id', v['id:xIn2']!),
    ...both('requests', 'requests'),
    // sending (this release's daemon, the fake relay)
    { name: 'send xin', args: ['send', 'xin', 'a message to xin', '--port', port] },
    { name: 'send xin --json', args: ['send', 'xin', 'another to xin', '--port', port, '--json'], json: true },
    { name: 'send morse.im/<x>', args: ['send', `morse.im/${X}`, 'to the address of xin', '--port', port] },
    { name: 'send <x> --from mini --json', args: ['send', X, 'from my address by name', '--from', 'mini', '--port', port, '--json'], json: true },
    { name: 'send morse.im/<y> (nobody published it)', args: ['send', `morse.im/${Y}`, 'to an address nobody holds', '--port', port] },
    { name: 'send --from nosuch', args: ['send', 'xin', 'hello', '--from', 'nosuch', '--port', port] },
    { name: 'send xin (no daemon)', args: ['send', 'xin', 'hello', '--port', dead] },
    { name: 'reply xIn2', args: ['reply', v['id:xIn2']!, 'answering the second', '--port', port] },
    { name: 'reply xIn3 --json', args: ['reply', v['id:xIn3']!, 'answering the third', '--port', port, '--json'], json: true },
    { name: 'reply kaiIn --json (the old way)', args: ['reply', v['id:kaiIn']!, 'answering kai', '--port', port, '--json'], json: true },
    ...both('message (after the replies)', 'message'),
    { name: 'message xin (after)', args: ['message', 'xin'] },
    // changing
    ...both('contact set xin --group', 'contact', 'set', 'xin', '--group', 'vip'),
    { name: 'contact set <y> --name why', args: ['contact', 'set', Y, '--name', 'why'] },
    { name: 'contact set why --name Kai (taken)', args: ['contact', 'set', 'why', '--name', 'Kai'] },
    { name: 'contact accept <r1>', args: ['contact', 'accept', `morse.im/${R(1)}`, '--port', dead] },
    { name: 'contact accept <r2> --json', args: ['contact', 'accept', R(2), '--port', dead, '--json'], json: true },
    { name: 'contact accept <r1> again', args: ['contact', 'accept', R(1), '--port', dead] },
    { name: 'contact add <r3> (accepts its request)', args: ['contact', 'add', R(3), '--name', 'three', '--port', dead] },
    { name: 'contact reject <r4>', args: ['contact', 'reject', R(4)] },
    { name: 'contact reject <r4> again --json', args: ['contact', 'reject', R(4), '--json'], json: true },
    { name: 'contact reject oldname --json', args: ['contact', 'reject', 'morse.im/oldname', '--json'], json: true },
    { name: 'contact block <r5> (a request)', args: ['contact', 'block', R(5)] },
    { name: 'contact (after accept / reject / block)', args: ['contact'] },
    { name: 'contact reject --all', args: ['contact', 'reject', '--all'] },
    { name: 'contact reject --all --json', args: ['contact', 'reject', '--all', '--json'], json: true },
    { name: 'contact unblock zed', args: ['contact', 'unblock', 'zed'] },
    { name: 'contact block zed --json', args: ['contact', 'block', 'zed', '--json'], json: true },
    { name: 'contact unblock <z> --json', args: ['contact', 'unblock', v['Z']!, '--json'], json: true },
    { name: 'contact block bad (an old name nobody has)', args: ['contact', 'block', 'bad'] },
    { name: 'contact remove why', args: ['contact', 'remove', 'why'] },
    { name: 'contact remove zed --json', args: ['contact', 'remove', 'zed', '--json'], json: true },
    { name: 'contact remove Kai', args: ['contact', 'remove', 'Kai'] },
    ...both('contact (at the end)', 'contact'),
    ...both('message (at the end)', 'message'),
  ];
}

/**
 * Text with everything that differs from run to run replaced by a placeholder: the home, addresses and
 * seeded message ids by NAME ({X}, {id:xIn2}, {id8:xIn2}), then whatever is left — a new message's id
 * ({UUID}, [{ID8}]), relative times ({AGO}), minute stamps ({STAMP}), ISO times ({ISO}), the ports.
 */
export function normaliser(vars: Record<string, string>, ports: string[] = []): (text: string) => string {
  const named: Array<[string, string]> = [];
  for (const [k, value] of Object.entries(vars)) {
    named.push([value, `{${k}}`]);
    if (k.startsWith('id:')) named.push([value.slice(0, 8), `{id8:${k.slice(3)}}`]);
    if (k === 'HOME') named.push([value.replace(/[^A-Za-z0-9]/g, '-'), '{HOME-}']);
  }
  named.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let s = text;
    for (const [value, name] of named) s = s.split(value).join(name);
    for (const port of ports) s = s.replace(new RegExp(`\\b${port}\\b`, 'g'), '{PORT}');
    return s
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '{UUID}')
      .replace(/\[[0-9a-f]{8}\]/g, '[{ID8}]')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '{ISO}')
      .replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, '{STAMP}')
      .replace(/ {2}(?:just now|\d+[mhd] ago) {2}/g, '  {AGO}  ')
      .replace(/(\{[A-Za-z0-9:]+\})-[0-9a-f]{8}\b/g, '$1-{HASH}');
  };
}

/** A parsed JSON answer with the same placeholders in every string; a number that is "now" (after the seed) → '{NOW}'. */
export function normaliseJson(value: unknown, norm: (text: string) => string): unknown {
  if (typeof value === 'string') return norm(value);
  if (typeof value === 'number') return value > T0 + 86_400_000 ? '{NOW}' : value;
  if (Array.isArray(value)) return value.map((v) => normaliseJson(v, norm));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normaliseJson(v, norm)]));
  return value;
}
