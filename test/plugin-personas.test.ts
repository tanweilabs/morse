import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryAdapter, ExecFn, SessionInfo } from '../src/adapters/types.js';
import type { FakeRelay } from './helpers/fake-relay.js';
import { createLocalCore } from './helpers/attendant-core.js';
import { addressOf, cliAt, computer, freshHome, mailboxOf, removeHomes, REPO, someone, startDaemon, until, world, type Computer, type Daemon } from './helpers/personas-home.js';
import { daemonStub, killStubs } from './helpers/stub-process.js';
import { daemonJson } from './helpers/local-api.js';
import { INBOX_AGENT } from '../src/cluster/morse.js';
import { loadPrimaryAddress } from '../src/identity/address-key.js';
import { openV3 } from '../src/identity/envelope.js';
import { ensurePrekeys } from '../src/identity/prekeys.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox, type Message } from '../src/mailbox/mailbox.js';
import { createCliClient, runMorse } from '../src/plugin/cli-client.js';
import type { PluginMessage } from '../src/plugin/contract.js';
import { createEventSource, type CoreEvent } from '../src/plugin/events.js';
import { createLocalClient, viewOf } from '../src/plugin/local-client.js';
import { createApprovalStore } from '../src/plugins/attendant/approvals.js';
import { parseAttendantConfig, profileFor, type AttendantSettings } from '../src/plugins/attendant/config.js';
import { createCliCore } from '../src/plugins/attendant/core.js';
import { createEngine, laneOf } from '../src/plugins/attendant/engine.js';
import { createAttendantState } from '../src/plugins/attendant/state.js';
import { dispatchStep, isOwnAgentMail } from '../src/plugins/dispatch/deliver.js';

/**
 * (ADR-083) The plugins on a computer with TWO addresses (`mini` first, `work`), where the same peer is a
 * contact of both — two rows that share nothing:
 *
 *   1  the attendant's permissions come from the ROW the mail belongs to (group, per-contact
 *      overrides, blocked, rate limits and sessions per contact id) — never the other address's row;
 *   2  a plugin answers through `morse reply` and so only FROM the address the mail was written to;
 *      its own `morse send <contact>` goes out from the row's address; an address that is a contact
 *      of both is refused, not guessed;
 *   3  the plugin JSON contract only gained `myAddress` (messages, request events); the same peer
 *      asking at two of my addresses is two request events;
 *   4  dispatch: own-agent mail is untouched (`myAddress: null`), and a thread is "mine" only at the
 *      address it was started from.
 *
 * `ann` is the computer under test. The in-process views (`viewOf`, the event source) name my
 * addresses by reading the Morse home of this process — so this file points MORSE_HOME at ann's
 * temp home (a test may set its own: test/helpers/isolate-home.ts); every `morse` command is run
 * with MORSE_HOME + ANYTOANY_HOME + HOME set to it, and `morse send` always with `--port` (never
 * the default port, where a real daemon may listen).
 */

const ann = computer('ann', 'mini', ['work']);
process.env['MORSE_HOME'] = ann.home;
const mine = ann.address;
const work = addressOf(ann, 'work').address;
const MINI = { name: 'mini', address: mine };
const WORK = { name: 'work', address: work };

const daemons: Daemon[] = [];
const relays: FakeRelay[] = [];
afterAll(async () => {
  await killStubs();
  daemons.forEach((d) => d.stop());
  await Promise.all(relays.map((r) => r.close()));
  removeHomes();
});

/** What the release before (commit af4ca40) put in a message view / a request event — every key must still be there. */
const P3_MESSAGE_KEYS = ['id', 'time', 'at', 'direction', 'contact', 'agent', 'peerAgent', 'from', 'to', 'contextId', 'conversationId', 'foreign', 'ownThread', 'status', 'attempts', 'processed', 'processedAt', 'processedBy', 'hasFiles', 'files', 'text'];
const P3_MESSAGE_CONTACT_KEYS = ['id', 'handle', 'remark', 'group', 'state', 'self', 'addresses', 'inherits'];
const P3_REQUEST_EVENT_KEYS = ['type', 'handle', 'address', 'nickname', 'time', 'at', 'droppedFiles'];

/** A message `from` wrote to one of my addresses, by address — filed as the transport files it. `at`: '' = my first address. */
const mail = (mb: Mailbox, from: string, at: string, text: string, more: { contextId?: string } = {}): Message =>
  mb.send({ from: { agent: 'claude', sessionId: '', device: from }, to: { agent: at ? 'work' : 'mini', sessionId: 'inbox' }, text, fromTier: 'peer', myAddress: at || mine, ...more });
const request = (mb: Mailbox, from: string, at: string, text: string) =>
  mb.requests.file({ handle: from, deviceId: from, msgId: `r-${from.slice(0, 8)}-${at ? 'work' : 'mini'}`, from: { agent: 'claude', sessionId: '' }, to: { agent: at ? 'work' : 'mini', sessionId: 'inbox' }, toAddress: at || mine, ...(at ? { myAddress: at } : {}), text, droppedFiles: 0, via: 'morse-relay' });
/** The same peer as a contact of BOTH of my addresses: `friend` at mini, `client` at work. */
const both = (mb: Mailbox, remarks?: [string, string]) => {
  const peer = someone();
  const a = mb.contacts.set(mb.contacts.ensureAddress(peer, '').id, { group: 'friend', ...(remarks ? { remark: remarks[0] } : {}) });
  const b = mb.contacts.set(mb.contacts.ensureAddress(peer, work).id, { group: 'client', ...(remarks ? { remark: remarks[1] } : {}) });
  expect([a.id, b.id]).toEqual([`a:${peer}`, `a:${peer}~${work}`]);
  return { peer, mini: a.id, work: b.id };
};

// =====================================================================================================

describe('1 — the attendant: permissions, sessions and limits belong to the ROW (ADR-083 §1, §10)', () => {
  let clock = Date.now();
  const now = () => clock;
  let idn = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++idn).padStart(12, '0')}`;

  interface Call {
    cwd: string | undefined;
    prompt: string;
    system: string;
    session: string;
    resumed: boolean;
  }
  /** The attendant over an in-memory mailbox of ann's home (two addresses), with a fake `claude -p` that answers "answer <n>". */
  function setup(config: (dirs: { friend: string; client: string; own: string; other: string }) => Record<string, unknown>) {
    const root = freshHome('attendant-personas-');
    const h = join(root, 'home');
    const dirs = { friend: join(h, 'work', 'friend'), client: join(h, 'work', 'client'), own: join(h, 'work', 'own'), other: join(h, 'work', 'other') };
    const inbox = join(h, '.morse', 'inbox-files');
    for (const d of [...Object.values(dirs), inbox]) mkdirSync(d, { recursive: true });
    const settings: AttendantSettings = parseAttendantConfig({ coalesceSec: 0, ...config(dirs) }, { home: h, morseDir: join(h, '.morse') });
    expect(settings.errors).toEqual([]);
    const ctx = homeContactContext(ann.home);
    const mailbox = createMailbox(createDb(':memory:', { ctx }), { ctx, now });
    const core = createLocalCore(mailbox);
    const stateDir = join(h, '.morse', 'plugins', 'attendant');
    const state = createAttendantState(stateDir, now);
    const calls: Call[] = [];
    const exec: ExecFn = async (_cmd, args, opts) => {
      const resumed = args.includes('--resume');
      const session = resumed ? args[args.indexOf('--resume') + 1]! : args[args.indexOf('--session-id') + 1]!;
      calls.push({ cwd: opts.cwd, prompt: args[args.length - 1]!, system: args[args.indexOf('--append-system-prompt') + 1] ?? '', session, resumed });
      return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `answer ${calls.length}`, session_id: session, permission_denials: [] }) };
    };
    const logs: string[] = [];
    const os: string[] = [];
    const engine = createEngine({ core, exec, state, approvals: createApprovalStore(stateDir), settings: () => settings, ilinkEnabled: () => false, pluginArgv: ['/usr/bin/node', '/opt/morse/attendant/main.js'], stateDir, home: h, inboxFilesDir: inbox, now, newId, log: (l) => logs.push(l), osNotify: (t, b) => os.push(`${t} — ${b}`) });
    engine.recover(); // records when the attendant was first on
    clock += 1000;
    const turn = async () => {
      clock += 10_000;
      await engine.idle();
    };
    const write = (from: string, at: string, text: string) => {
      clock += 10;
      return mail(mailbox, from, at, text);
    };
    const sentTo = (contactId: string) => mailbox.history(contactId, { limit: 100 }).filter((m) => m.direction === 'out');
    return { dirs, settings, mailbox, core, state, engine, calls, logs, os, turn, write, sentTo };
  }

  it('profileFor: the same peer, `friend` at mini and `client` at work — each message gets the profile of the row it belongs to', () => {
    const t = setup((d) => ({ groups: { friend: { cwd: d.friend }, client: { cwd: d.client, tools: ['Read'] } } }));
    const p = both(t.mailbox, ['pat-home', 'pat-office']);
    const toMini = viewOf(t.mailbox, t.write(p.peer, '', 'to mini'));
    const toWork = viewOf(t.mailbox, t.write(p.peer, work, 'to work'));
    expect(toMini.contact).toMatchObject({ id: p.mini, remark: 'pat-home', group: 'friend', state: 'active' });
    expect(toWork.contact).toMatchObject({ id: p.work, remark: 'pat-office', group: 'client', state: 'active' });
    expect([toMini.myAddress, toWork.myAddress]).toEqual([MINI, WORK]);
    expect(profileFor(t.settings, toMini.contact as never)).toMatchObject({ group: 'friend', cwd: t.dirs.friend, where: 'plugins.attendant.groups.friend' });
    expect(profileFor(t.settings, toWork.contact as never)).toMatchObject({ group: 'client', cwd: t.dirs.client, tools: ['Read'], where: 'plugins.attendant.groups.client' });
    // the rows as the store has them say the same
    expect(profileFor(t.settings, t.mailbox.contacts.byAddress(p.peer, '')!)).toMatchObject({ cwd: t.dirs.friend });
    expect(profileFor(t.settings, t.mailbox.contacts.byAddress(p.peer, work)!)).toMatchObject({ cwd: t.dirs.client });
    // changing the group of one row changes nothing for the other
    t.mailbox.contacts.set(p.work, { group: 'friend' });
    t.mailbox.contacts.set(p.mini, { group: 'nobody-set-this-up' });
    expect(profileFor(t.settings, t.mailbox.contacts.get(p.work)!)).toMatchObject({ cwd: t.dirs.friend });
    expect(profileFor(t.settings, t.mailbox.contacts.get(p.mini)!)).toMatchObject({ conversationOnly: true, tools: [] }); // the default: no files, no tools
  });

  it('profileFor: a per-contact override keyed by REMARK or by CONTACT ID applies to that row only', () => {
    // by remark: `pat-office` is the row of `work`
    const byRemark = setup((d) => ({ groups: { friend: { cwd: d.friend }, client: { cwd: d.client } }, contacts: { 'pat-office': { cwd: d.own, model: 'opus' }, 'pat-home': { enabled: false } } }));
    const p = both(byRemark.mailbox, ['pat-home', 'pat-office']);
    expect(profileFor(byRemark.settings, byRemark.mailbox.contacts.get(p.work)!)).toMatchObject({ cwd: byRemark.dirs.own, launch: { model: 'opus' }, where: 'plugins.attendant.contacts.pat-office' });
    expect(profileFor(byRemark.settings, byRemark.mailbox.contacts.get(p.mini)!)).toBeNull(); // switched off — for that row
    // by contact id: `a:<peer>` is the first address's row, `a:<peer>~<work>` is work's — a key for one never matches the other
    const peer = someone();
    const byId = setup((d) => ({ groups: { friend: { cwd: d.friend }, client: { cwd: d.client } }, contacts: { [`a:${peer}`]: { cwd: d.own }, [`A:${peer}~${work}`.toUpperCase()]: { cwd: d.other } } }));
    const a = byId.mailbox.contacts.set(byId.mailbox.contacts.ensureAddress(peer, '').id, { group: 'friend' });
    const b = byId.mailbox.contacts.set(byId.mailbox.contacts.ensureAddress(peer, work).id, { group: 'client' });
    expect(profileFor(byId.settings, a)).toMatchObject({ cwd: byId.dirs.own, where: `plugins.attendant.contacts.a:${peer}` });
    expect(profileFor(byId.settings, b)).toMatchObject({ cwd: byId.dirs.other });
    const onlyMini = setup((d) => ({ groups: { friend: { cwd: d.friend }, client: { cwd: d.client } }, contacts: { [`a:${peer}`]: { cwd: d.own } } }));
    const a2 = onlyMini.mailbox.contacts.set(onlyMini.mailbox.contacts.ensureAddress(peer, '').id, { group: 'friend' });
    const b2 = onlyMini.mailbox.contacts.set(onlyMini.mailbox.contacts.ensureAddress(peer, work).id, { group: 'client' });
    expect(profileFor(onlyMini.settings, a2)).toMatchObject({ cwd: onlyMini.dirs.own });
    expect(profileFor(onlyMini.settings, b2)).toMatchObject({ cwd: onlyMini.dirs.client, where: 'plugins.attendant.groups.client' }); // the group's — not mini's override
    // the peer's ADDRESS alone is no key: it would mean both rows
    const byAddress = setup((d) => ({ groups: { friend: { cwd: d.friend }, client: { cwd: d.client } }, contacts: { [peer]: { cwd: d.own } } }));
    const a3 = byAddress.mailbox.contacts.set(byAddress.mailbox.contacts.ensureAddress(peer, '').id, { group: 'friend' });
    const b3 = byAddress.mailbox.contacts.set(byAddress.mailbox.contacts.ensureAddress(peer, work).id, { group: 'client' });
    expect([profileFor(byAddress.settings, a3)!.cwd, profileFor(byAddress.settings, b3)!.cwd]).toEqual([byAddress.dirs.friend, byAddress.dirs.client]);
  });

  it('the engine: mail written to `work` is answered within work\'s row\'s permissions, mail written to `mini` within mini\'s — own lane, own session, own history, own reply address', async () => {
    const t = setup((d) => ({ groups: { friend: { cwd: d.friend }, client: { cwd: d.client } } }));
    const p = both(t.mailbox, ['pat-home', 'pat-office']);
    const toMini = t.write(p.peer, '', 'SECRET-MINI: are we still on for Saturday?');
    const toWork = t.write(p.peer, work, 'SECRET-WORK: the invoice, please');
    expect([laneOf(viewOf(t.mailbox, toMini)), laneOf(viewOf(t.mailbox, toWork))]).toEqual([`mini/${p.mini}`, `work/${p.work}`]);
    await t.turn();
    expect(t.calls).toHaveLength(2);
    const atMini = t.calls.find((c) => c.prompt.includes('SECRET-MINI'))!;
    const atWork = t.calls.find((c) => c.prompt.includes('SECRET-WORK'))!;
    // each turn: its row's directory, its row's name and group — and nothing of the other row
    expect(atMini.cwd).toBe(t.dirs.friend);
    expect(atWork.cwd).toBe(t.dirs.client);
    expect(atMini.prompt).toContain(`from pat-home (${p.mini}, group "friend")`);
    expect(atWork.prompt).toContain(`from pat-office (${p.work}, group "client")`);
    expect(atMini.prompt).not.toMatch(/SECRET-WORK|pat-office|client/);
    expect(atWork.prompt).not.toMatch(/SECRET-MINI|pat-home|friend/);
    expect(atMini.session).not.toBe(atWork.session);
    expect(Object.keys(t.state.read().sessions).sort()).toEqual([`mini/${p.mini}`, `work/${p.work}`].sort());
    expect(t.state.read().sessions[`work/${p.work}`]).toMatchObject({ cwd: t.dirs.client, turns: 1 });
    expect(t.state.read().sessions[`mini/${p.mini}`]).toMatchObject({ cwd: t.dirs.friend, turns: 1 });
    // the answers: each in its own row, sent from the address the mail was written to
    const [fromMini, fromWork] = [t.sentTo(p.mini), t.sentTo(p.work)];
    expect(fromMini.map((m) => [m.myAddress, m.contactId, m.contextId, m.to.device])).toEqual([[mine, p.mini, toMini.contextId, p.peer]]);
    expect(fromWork.map((m) => [m.myAddress, m.contactId, m.contextId, m.to.device])).toEqual([[work, p.work, toWork.contextId, p.peer]]);
    expect(fromMini[0]!.parts[0]!.text.startsWith(`answer ${t.calls.indexOf(atMini) + 1}`)).toBe(true);
    expect(fromWork[0]!.parts[0]!.text.startsWith(`answer ${t.calls.indexOf(atWork) + 1}`)).toBe(true);
    expect([viewOf(t.mailbox, fromMini[0]!).myAddress, viewOf(t.mailbox, fromWork[0]!).myAddress]).toEqual([MINI, WORK]);
    for (const m of [toMini, toWork]) expect(t.mailbox.getMessage(m.id)?.processedBy).toBe('plugin:attendant');
    // the next message to `work` resumes work's session and is given work's history only
    t.write(p.peer, work, 'and the second invoice');
    await t.turn();
    expect(t.calls).toHaveLength(3);
    expect(t.calls[2]).toMatchObject({ cwd: t.dirs.client, resumed: true, session: atWork.session });
    expect(t.calls[2]!.prompt).not.toMatch(/SECRET-MINI|pat-home/);
    expect(t.sentTo(p.work).map((m) => m.myAddress)).toEqual([work, work]);
    expect(t.sentTo(p.mini)).toHaveLength(1);
  });

  it('a row blocked at one address is not answered there — the same peer at the other address is answered as before', async () => {
    const t = setup((d) => ({ groups: { friend: { cwd: d.friend }, client: { cwd: d.client } } }));
    const p = both(t.mailbox);
    t.mailbox.contacts.set(p.work, { state: 'blocked' });
    t.mailbox.contacts.blockAt(p.peer, work);
    const toWork = t.write(p.peer, work, 'to the blocked row');
    const toMini = t.write(p.peer, '', 'to the other row');
    expect(profileFor(t.settings, viewOf(t.mailbox, toWork).contact as never)).toBeNull();
    expect(profileFor(t.settings, viewOf(t.mailbox, toMini).contact as never)).toMatchObject({ cwd: t.dirs.friend });
    await t.turn();
    expect(t.calls.map((c) => c.cwd)).toEqual([t.dirs.friend]);
    expect(t.calls[0]!.prompt).not.toContain('to the blocked row');
    expect(t.sentTo(p.work)).toEqual([]);
    expect(t.sentTo(p.mini).map((m) => m.myAddress)).toEqual([mine]);
    expect(t.mailbox.getMessage(toWork.id)?.processedAt).toBeUndefined();
    // …and the other way round: blocked at mini, answered at work
    const u = setup((d) => ({ groups: { friend: { cwd: d.friend }, client: { cwd: d.client } } }));
    const q = both(u.mailbox);
    u.mailbox.contacts.set(q.mini, { state: 'blocked' });
    u.write(q.peer, '', 'to the blocked row');
    u.write(q.peer, work, 'to the other row');
    await u.turn();
    expect(u.calls.map((c) => c.cwd)).toEqual([u.dirs.client]);
    expect(u.sentTo(q.mini)).toEqual([]);
    expect(u.sentTo(q.work).map((m) => m.myAddress)).toEqual([work]);
  });

  it('rate limits are counted per contact id: the peer over the limit at `mini` is still answered at `work`; the "hit the limit" notice is per row too', async () => {
    const t = setup((d) => ({ groups: { friend: { cwd: d.friend, rateLimit: { perHour: 1 } }, client: { cwd: d.client, rateLimit: { perHour: 2 } } } }));
    const p = both(t.mailbox, ['pat-home', 'pat-office']);
    t.write(p.peer, '', 'mini one');
    await t.turn();
    const second = t.write(p.peer, '', 'mini two');
    await t.turn();
    expect(t.calls).toHaveLength(1); // the second is over mini's limit (1 an hour): left for the owner
    expect(t.mailbox.getMessage(second.id)?.processedAt).toBeUndefined();
    expect(t.logs.join('\n')).toMatch(new RegExp(`mini/${p.mini}: rate limit \\(1 an hour\\)`));
    expect(t.os.filter((l) => l.includes('rate limit'))).toEqual([expect.stringContaining('pat-home')]);
    // `work` has its own count: nothing was launched for that row yet
    for (const text of ['work one', 'work two']) {
      t.write(p.peer, work, text);
      await t.turn();
    }
    expect(t.calls.map((c) => c.cwd)).toEqual([t.dirs.friend, t.dirs.client, t.dirs.client]);
    const third = t.write(p.peer, work, 'work three');
    await t.turn();
    expect(t.calls).toHaveLength(3);
    expect(t.mailbox.getMessage(third.id)?.processedAt).toBeUndefined();
    expect(t.logs.join('\n')).toMatch(new RegExp(`work/${p.work.replace(/[~]/g, '\\$&')}: rate limit \\(2 an hour\\)`));
    const s = t.state.read();
    expect(Object.fromEntries(Object.entries(s.launches).map(([k, v]) => [k, v.length]))).toEqual({ [p.mini]: 1, [p.work]: 2 });
    expect(Object.keys(s.notices).sort()).toEqual([p.mini, p.work].sort());
    expect(t.os.filter((l) => l.includes('rate limit'))).toEqual([expect.stringContaining('pat-home'), expect.stringContaining('pat-office')]);
    expect(t.sentTo(p.mini).map((m) => m.myAddress)).toEqual([mine]);
    expect(t.sentTo(p.work).map((m) => m.myAddress)).toEqual([work, work]);
  });
});

// =====================================================================================================

describe('2 + 3 — through the `morse` command, as a plugin runs it (ADR-083 §10)', () => {
  let relay: FakeRelay;
  let ben: Computer;
  let daemon: Daemon;
  let benDaemon: Daemon;
  let port: string;
  const mb = () => mailboxOf(ann.home);
  /** The exact command a plugin runs (`MORSE_CMD_JSON`), against ann's temp home. */
  const cmd = ['/usr/bin/env', `MORSE_HOME=${ann.home}`, `ANYTOANY_HOME=${ann.home}`, `HOME=${ann.home}`, process.execPath, '--import', join(REPO, 'node_modules/tsx/dist/loader.mjs'), join(REPO, 'src/cli.ts')];
  const attendant = createCliCore({ cmd });
  const dispatch = createCliClient({ cmd, by: 'plugin:dispatch' });
  const row = (id: string) => mb().getMessage(id)!;
  const outbound = () => mb().inbox({ all: true }).filter((m) => m.direction === 'out');
  /** Everything queued goes out now; which address signed what the relay carried to ben since (opened with ben's keys). */
  const wire = async (): Promise<string[]> => {
    const since = relay.v3Log().length;
    expect((await daemon.flush()).length).toBeGreaterThan(0);
    const key = loadPrimaryAddress(ben.home);
    const signers: string[] = [];
    for (const e of relay.v3Log().slice(since)) {
      if (e.to !== ben.address) continue;
      const o = await openV3(JSON.parse(e.blob), { address: key.address, keys: ensurePrekeys(key).keys });
      expect(o.from).toBe(e.from);
      expect(o.cert).toBeUndefined();
      expect(o.body.toString('utf8')).not.toContain(o.from === work ? mine : work);
      signers.push(o.from);
    }
    return [...new Set(signers)];
  };
  let rows: { mini: string; work: string };

  beforeAll(async () => {
    ben = computer('ben', 'ben-pc');
    relay = await world([ann, ben]);
    relays.push(relay);
    benDaemon = await startDaemon(ben, relay, { memory: true });
    daemon = await startDaemon(ann, relay);
    daemons.push(benDaemon, daemon);
    port = daemon.port;
    // ben has both of my addresses as contacts already: what I send is delivered (not held behind a request)
    for (const a of [mine, work]) benDaemon.mailbox.contacts.ensureAddress(a);
    // this home's running daemon is this release's (a plugin's `morse reply` names no port: it asks the one the pid file names)
    // (the pid: a process that reads like a Morse daemon — the daemon of this test runs inside the test's own process)
    const { pid } = await daemonStub();
    writeFileSync(join(ann.home, '.morse', 'daemon.pid'), String(pid));
    daemonJson(ann.home, port, { pid: pid! });
    // ben: `friend` at mini (ben-home), `client` at work (ben-office) — made by the commands
    for (const args of [
      ['contact', 'add', ben.address, '--name', 'ben-home', '--group', 'friend'],
      ['contact', 'add', ben.address, '--from', 'work', '--name', 'ben-office', '--group', 'client'],
    ]) {
      const r = await cliAt(ann.home, [...args, '--port', port]);
      expect(r.code, r.err).toBe(0);
    }
    rows = { mini: `a:${ben.address}`, work: `a:${ben.address}~${work}` };
    expect(mb().contacts.findAll(ben.address).map((c) => [c.id, c.myAddress, c.group])).toEqual([
      [rows.mini, '', 'friend'],
      [rows.work, work, 'client'],
    ]);
  }, 180_000);

  it('2 — the attendant\'s path (`morse reply <id> … --by plugin:attendant --via attendant --json`): mail written to `work` is answered from `work`, mail written to `mini` from `mini` — signed by that address on the wire', async () => {
    const toWork = mail(mb(), ben.address, work, 'ben asks work');
    const toMini = mail(mb(), ben.address, '', 'ben asks mini');
    const w = await attendant.reply(toWork.id, 'the attendant answers at work');
    expect(w).toMatchObject({ ok: true });
    const wr = row((w as { id: string }).id);
    expect(wr).toMatchObject({ direction: 'out', myAddress: work, myAgent: 'work', contactId: rows.work, to: { device: ben.address }, contextId: toWork.contextId, parts: [{ text: 'the attendant answers at work', via: 'attendant' }] });
    expect(row(toWork.id).processedBy).toBe('plugin:attendant');
    expect(await wire()).toEqual([work]);
    const m = await attendant.reply(toMini.id, 'the attendant answers at mini');
    expect(m).toMatchObject({ ok: true });
    expect(row((m as { id: string }).id)).toMatchObject({ direction: 'out', myAddress: mine, contactId: rows.mini, to: { device: ben.address }, contextId: toMini.contextId });
    expect(await wire()).toEqual([mine]);
    // on ben's computer: two senders that share nothing
    const benGot = () => benDaemon.mailbox.inbox({ all: true }).filter((x) => x.direction === 'in');
    await until(() => benGot().length >= 2);
    const atBen = benGot();
    expect(Object.fromEntries(atBen.map((x) => [x.parts[0]!.text, [x.from.device, x.contactId]]))).toEqual({
      'the attendant answers at work': [work, `a:${work}`],
      'the attendant answers at mini': [mine, `a:${mine}`],
    });
  }, 90_000);

  it('2 — the dispatch client\'s path (`morse reply <id> … --via auto --json`) and a NOOP: the same rule; a reply never takes a `--from`', async () => {
    const toWork = mail(mb(), ben.address, work, 'again to work');
    const toMini = mail(mb(), ben.address, '', 'again to mini');
    const w = await dispatch.reply(toWork.id, 'auto from work', { via: 'auto' });
    expect(w).toMatchObject({ ok: true });
    expect(row((w as { id: string }).id)).toMatchObject({ myAddress: work, contactId: rows.work, parts: [{ via: 'auto' }] });
    expect(await wire()).toEqual([work]);
    const m = await dispatch.reply(toMini.id, 'auto from mini', { via: 'auto' });
    expect(row((m as { id: string }).id)).toMatchObject({ myAddress: mine, contactId: rows.mini });
    expect(await wire()).toEqual([mine]);
    // no way to answer mail written to `work` as `mini`: the command has no such option
    const x = mail(mb(), ben.address, work, 'one more to work');
    const before = outbound().length;
    const no = await runMorse(['reply', x.id, 'as mini?', '--from', 'mini', '--json'], cmd);
    expect(no.code).toBe(1);
    expect(no.err).toMatch(/unknown option '--from'/);
    expect(outbound()).toHaveLength(before);
    expect(row(x.id).processedAt).toBeUndefined();
    expect(await attendant.reply(x.id, 'NOOP')).toMatchObject({ ok: false, reason: 'noop' });
    expect(outbound()).toHaveLength(before);
  }, 90_000);

  it('2 — a plugin\'s own `morse send <contact>` goes out from the address the contact belongs to; `morse send morse.im/<peer>` with two rows is refused, not guessed', async () => {
    const send = (...args: string[]) => runMorse(['send', ...args, '--port', port, '--json'], cmd);
    const office = await send('ben-office', 'a notice for the client');
    expect({ code: office.code, err: office.err }).toEqual({ code: 0, err: '' });
    const ov = (JSON.parse(office.out) as { queued: boolean; message: PluginMessage }).message;
    expect(ov).toMatchObject({ direction: 'out', myAddress: WORK, agent: 'work', contact: { id: rows.work, remark: 'ben-office', group: 'client' } });
    expect(row(ov.id)).toMatchObject({ myAddress: work, contactId: rows.work });
    expect(await wire()).toEqual([work]);
    const home = await send('ben-home', 'a note for the friend');
    expect({ code: home.code, err: home.err }).toEqual({ code: 0, err: '' });
    const hv = (JSON.parse(home.out) as { message: PluginMessage }).message;
    expect(hv).toMatchObject({ myAddress: MINI, contact: { id: rows.mini, remark: 'ben-home', group: 'friend' } });
    expect(row(hv.id)).toMatchObject({ myAddress: mine, contactId: rows.mini });
    expect(await wire()).toEqual([mine]);
    // by the peer's address: which of the two? — one line, exit 1, nothing queued, no third contact
    const before = outbound().length;
    for (const target of [`morse.im/${ben.address}`, ben.address]) {
      const r = await send(target, 'to whom?');
      expect(r, target).toEqual({ code: 1, out: '', err: `error: morse.im/${ben.address} is a contact of 2 of your addresses (mini, work) — say which one: --from <name>\n` });
    }
    // the remark of one row with the other address named: refused too
    const wrong = await send('ben-office', 'as mini?', '--from', 'mini');
    expect(wrong).toEqual({ code: 1, out: '', err: `error: "ben-office" is a contact of your address work, not of mini — write to them from the address they belong to: --from work, or leave --from out\n` });
    expect(outbound()).toHaveLength(before);
    expect(mb().contacts.findAll(ben.address).map((c) => c.id)).toEqual([rows.mini, rows.work]);
    // with the address named it is that row
    const named = await send(`morse.im/${ben.address}`, 'named', '--from', 'work');
    expect(row((JSON.parse(named.out) as { message: PluginMessage }).message.id)).toMatchObject({ myAddress: work, contactId: rows.work });
    expect(await wire()).toEqual([work]);
  }, 90_000);

  it('3 — `morse message --json` / `morse message <contact id> --json` (what the attendant reads): `myAddress` on every message, every key of the release before still there; history by contact id is ONE row\'s', async () => {
    const toWork = mail(mb(), ben.address, work, 'for the contract check, to work');
    const toMini = mail(mb(), ben.address, '', 'for the contract check, to mini');
    const todo = await attendant.todo();
    const w = todo.find((m) => m.id === toWork.id)!;
    const m = todo.find((x) => x.id === toMini.id)!;
    expect(w).toMatchObject({ direction: 'in', myAddress: WORK, agent: 'work', foreign: true, contact: { id: rows.work, remark: 'ben-office', group: 'client', state: 'active', self: false } });
    expect(m).toMatchObject({ direction: 'in', myAddress: MINI, agent: 'mini', foreign: true, contact: { id: rows.mini, remark: 'ben-home', group: 'friend', state: 'active', self: false } });
    for (const v of [w, m]) {
      expect(Object.keys(v).sort()).toEqual([...P3_MESSAGE_KEYS, 'myAddress'].sort());
      expect(Object.keys(v.contact!).sort()).toEqual([...P3_MESSAGE_CONTACT_KEYS, 'oldName', 'oldKeys'].sort()); // (ADR-091: fields added)
    }
    expect([laneOf(w), laneOf(m)]).toEqual([`work/${rows.work}`, `mini/${rows.mini}`]);
    // the history the attendant gives its agent: by contact id — only that row's mail, never refused as ambiguous
    const hw = await attendant.history(rows.work, 50);
    const hm = await attendant.history(rows.mini, 50);
    expect(hw.length).toBeGreaterThan(0);
    expect(hm.length).toBeGreaterThan(0);
    expect([...new Set(hw.map((x) => (x.contact as { id: string }).id))]).toEqual([rows.work]);
    expect([...new Set(hm.map((x) => (x.contact as { id: string }).id))]).toEqual([rows.mini]);
    expect([...new Set(hw.map((x) => JSON.stringify(x.myAddress)))]).toEqual([JSON.stringify(WORK)]);
    expect([...new Set(hm.map((x) => JSON.stringify(x.myAddress)))]).toEqual([JSON.stringify(MINI)]);
    expect(hw.map((x) => x.id)).toContain(toWork.id);
    expect(hw.map((x) => x.id)).not.toContain(toMini.id);
    expect(hm.map((x) => x.id)).toContain(toMini.id);
    await attendant.done([toWork.id, toMini.id]);
  }, 60_000);

  it('3 — `morse plugin watch --json`: message events and request events carry `myAddress`; the same peer asking at two of my addresses is TWO request events', async () => {
    const since = Date.now() - 1;
    const stranger = someone();
    const toWork = mail(mb(), ben.address, work, 'an event, to work');
    const toMini = mail(mb(), ben.address, '', 'an event, to mini');
    expect(request(mb(), stranger, '', 'let me in at mini')).toEqual({ result: 'filed' });
    expect(request(mb(), stranger, work, 'let me in at work')).toEqual({ result: 'filed' });
    mb().requests.file({ handle: 'oldname', deviceId: 'OLDDEV7-AAAAAAA-BBBBBBB', msgId: 'r-old', from: { agent: 'claude', sessionId: '' }, to: { agent: 'mini', sessionId: 'inbox' }, fromAgent: 'old-mbp', text: 'the old way', droppedFiles: 2, via: 'morse-relay' });
    const r = await runMorse(['plugin', 'watch', '--json', '--once', '--since', String(since)], cmd);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    const events = r.out.trim().split('\n').map((l) => JSON.parse(l) as CoreEvent & Record<string, unknown>);
    const messages = events.filter((e) => e.type === 'message');
    expect(messages.map((e) => [e['id'], e['myAddress'], (e['contact'] as { id: string }).id])).toEqual([
      [toWork.id, WORK, rows.work],
      [toMini.id, MINI, rows.mini],
    ]);
    for (const e of messages) {
      expect(Object.keys(e).sort()).toEqual(['type', 'seq', ...P3_MESSAGE_KEYS, 'myAddress'].sort());
      expect(Object.keys(e['contact'] as object).sort()).toEqual([...P3_MESSAGE_CONTACT_KEYS, 'oldName', 'oldKeys'].sort()); // (ADR-091: fields added)
    }
    const requests = events.filter((e) => e.type === 'request');
    // (three requests filed in the same millisecond: their order is not part of the contract)
    const byText = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    expect(requests.map((e) => [e['handle'], e['address'], e['myAddress'], e['droppedFiles']]).sort(byText)).toEqual(
      [
        [stranger, `morse.im/${stranger}`, MINI, 0],
        [stranger, `morse.im/${stranger}`, WORK, 0],
        ['oldname', 'morse.im/oldname/old-mbp', MINI, 2],
      ].sort(byText),
    );
    for (const e of requests) {
      expect(Object.keys(e).sort()).toEqual([...P3_REQUEST_EVENT_KEYS, 'myAddress'].sort());
      expect(e['nickname']).toBeNull();
      expect(JSON.stringify(e)).not.toMatch(/let me in|the old way/); // a request's text never reaches a plugin
    }
    await attendant.done([toWork.id, toMini.id]);
    for (const [who, at] of [[stranger, ''], [stranger, work], ['oldname', '']] as const) mb().requests.remove(who, at);
  }, 60_000);

  it('3 — the event source in-process (what `watch` polls): one request event per (my address, sender); a request re-filed at one address is not said again for the other', () => {
    const ctx = homeContactContext(ann.home);
    const mailbox = createMailbox(createDb(':memory:', { ctx }), { ctx });
    const source = createEventSource(mailbox, { sinceSeq: 0, sinceMs: 0 });
    expect(source.poll()).toEqual([]);
    const peer = someone();
    request(mailbox, peer, work, 'at work first');
    expect(source.poll().map((e) => [e.type, (e as { handle: string }).handle, (e as { myAddress?: unknown }).myAddress])).toEqual([['request', peer, WORK]]);
    // the same peer now asks at my first address too: a second event — for that address
    request(mailbox, peer, '', 'at mini too');
    expect(source.poll().map((e) => [e.type, (e as { handle: string }).handle, (e as { myAddress?: unknown }).myAddress])).toEqual([['request', peer, MINI]]);
    expect(source.poll()).toEqual([]);
    // accepted at work: mail in work's row — the event names work; the request at mini still waits
    mailbox.requests.remove(peer, work);
    const m = mail(mailbox, peer, work, 'now a contact of work');
    const [e] = source.poll();
    expect(e).toMatchObject({ type: 'message', id: m.id, myAddress: WORK, contact: { id: `a:${peer}~${work}` } });
    expect(Object.keys(e!).sort()).toEqual(['type', 'seq', ...P3_MESSAGE_KEYS, 'myAddress'].sort());
    expect(mailbox.requests.find(peer).map((r) => r.myAddress)).toEqual(['']);
  });
});

// =====================================================================================================

describe('4 — dispatch: own-agent mail does not know about addresses; a thread is "mine" at the address it was started from (ADR-083)', () => {
  const SID = 'dddd0000-0000-4000-8000-00000000000d';
  const session: SessionInfo = { agent: 'codex', sessionId: SID, title: 'work', cwd: '/w', lastActiveAt: 1 };
  const counting = (): DeliveryAdapter & { delivered: string[] } => {
    const a = {
      agent: 'codex',
      delivered: [] as string[],
      listSessions: async () => [session],
      deliver: async (_s: SessionInfo, text: string) => {
        a.delivered.push(text);
        return { ok: true, output: '' };
      },
    };
    return a as unknown as DeliveryAdapter & { delivered: string[] };
  };
  const fresh = () => {
    const ctx = homeContactContext(ann.home);
    return createMailbox(createDb(':memory:', { ctx }), { ctx });
  };

  it('mail between my own sessions: the self contact, `myAddress: null`, delivered by dispatch as before — with two addresses on this computer; (ADR-091 follow-up) mail from another computer is not yours, even stored as owner', async () => {
    const mailbox = fresh();
    const p = both(mailbox);
    const internal = mailbox.send({ from: { agent: 'claude', sessionId: 'a' }, to: { agent: 'codex', sessionId: SID }, text: 'run the tests' });
    const own = mailbox.send({ from: { agent: 'claude', sessionId: 'x', device: 'ann/air' }, to: { agent: 'codex', sessionId: SID }, text: 'from my laptop', fromTier: 'owner' });
    // another person's mail to `work` and to `mini`: never the dispatch plugin's
    const toWork = mail(mailbox, p.peer, work, 'a peer, to work');
    const toMini = mail(mailbox, p.peer, '', 'a peer, to mini');
    const views = Object.fromEntries([internal, own, toWork, toMini].map((m) => [m.parts[0]!.text, viewOf(mailbox, mailbox.getMessage(m.id)!)]));
    expect(views['run the tests']).toMatchObject({ direction: 'internal', myAddress: null, foreign: false, contact: { id: 'self', self: true, group: 'self' } });
    expect(views['from my laptop']).toMatchObject({ direction: 'in', foreign: true });
    expect(views['a peer, to work']).toMatchObject({ myAddress: WORK, foreign: true, to: { sessionId: 'inbox' } });
    expect(views['a peer, to mini']).toMatchObject({ myAddress: MINI, foreign: true, to: { sessionId: 'inbox' } });
    for (const v of Object.values(views)) expect(Object.keys(v).sort()).toEqual([...P3_MESSAGE_KEYS, 'myAddress'].sort());
    expect(Object.values(views).map(isOwnAgentMail)).toEqual([true, false, false, false]);
    // own mail records no address of mine at all
    expect([mailbox.getMessage(internal.id)!.myAddress, mailbox.getMessage(own.id)!.myAddress]).toEqual([undefined, undefined]);
    const adapter = counting();
    const deps = { core: createLocalClient(mailbox), adapters: new Map([['codex', adapter as DeliveryAdapter]]), directory: async () => [session] };
    expect(await dispatchStep(deps)).toBe(true);
    expect(await dispatchStep(deps)).toBe(false); // nothing of the peer's — or of another computer — is claimable
    expect(adapter.delivered).toHaveLength(1);
    expect(adapter.delivered.join('\n')).not.toMatch(/a peer, to/);
    expect(mailbox.getMessage(internal.id)).toMatchObject({ status: 'delivered', processedBy: 'plugin:dispatch' });
    for (const m of [toWork, toMini]) {
      expect(mailbox.claimById(m.id)).toBeNull();
      expect(mailbox.getMessage(m.id)).toMatchObject({ status: 'pending', attempts: 0 });
    }
    // a session answering another session: internal, no address
    const back = await deps.core.reply(internal.id, 'tests pass', { via: 'auto' });
    expect(back).toMatchObject({ ok: true });
    const answer = mailbox.getMessage((back as { id: string }).id)!;
    expect(answer).toMatchObject({ direction: 'internal', contactId: 'self', to: { agent: 'claude', sessionId: 'a' } });
    expect(answer.myAddress).toBeUndefined();
    expect(viewOf(mailbox, answer).myAddress).toBeNull();
  });

  it('`morse plugin claim --next --json` (the dispatch plugin\'s command): own mail with `myAddress: null`, every key of the release before', async () => {
    const home = computer('ann', 'mini', ['work']);
    const mb = mailboxOf(home.home);
    const own = mb.send({ from: { agent: 'claude', sessionId: 'a' }, to: { agent: 'codex', sessionId: SID }, text: 'own mail' });
    mail(mb, someone(), addressOf(home, 'work').address, 'a peer, to work');
    const claim = await cliAt(home.home, ['plugin', 'claim', '--next', '--json']);
    expect({ code: claim.code, err: claim.err }).toEqual({ code: 0, err: '' });
    const message = (JSON.parse(claim.out) as { message: PluginMessage }).message;
    expect(message).toMatchObject({ id: own.id, direction: 'internal', myAddress: null, contact: { id: 'self', self: true } });
    expect(Object.keys(message).sort()).toEqual([...P3_MESSAGE_KEYS, 'myAddress'].sort());
    // nothing else is claimable: the peer's mail is not own-agent mail
    expect(JSON.parse((await cliAt(home.home, ['plugin', 'claim', '--next', '--json'])).out)).toEqual({ message: null });
  }, 60_000);

  it('a thread one of my sessions started FROM `work`: the peer\'s answer to `work` goes back to that session (and is answered from `work`) — the same thread id arriving at `mini` is just mail in mini\'s inbox', async () => {
    const mailbox = fresh();
    const peer = someone();
    // `morse send morse.im/<peer> … --from work` by a session of mine, as the daemon queues it
    const started = mailbox.send({ from: { agent: 'codex', sessionId: SID }, to: { agent: INBOX_AGENT, sessionId: '', device: peer }, text: 'a question from my session, as work', via: 'cli', myAddress: work, myAgent: 'work' });
    expect(started).toMatchObject({ direction: 'out', myAddress: work, contactId: `a:${peer}~${work}` });
    const back = mail(mailbox, peer, work, 'the answer, to work', { contextId: started.contextId });
    expect(back).toMatchObject({ ownThread: true, to: { agent: 'codex', sessionId: SID }, myAddress: work, contactId: `a:${peer}~${work}` });
    const view = viewOf(mailbox, back);
    expect(view).toMatchObject({ ownThread: true, foreign: true, myAddress: WORK, agent: 'work' });
    expect(isOwnAgentMail(view)).toBe(true);
    // the session's reply to it: from `work`, in work's row
    const reply = await createLocalClient(mailbox).reply(back.id, 'thanks', { via: 'auto' });
    expect(mailbox.getMessage((reply as { id: string }).id)).toMatchObject({ direction: 'out', myAddress: work, contactId: `a:${peer}~${work}`, to: { device: peer } });
    // the same context id, written to my FIRST address: nothing there was started by me — an ordinary
    // message in mini's inbox, in a row of its own; it does not reach the session
    const elsewhere = mail(mailbox, peer, '', 'the same thread id, to mini', { contextId: started.contextId });
    expect(elsewhere).toMatchObject({ to: { agent: 'mini', sessionId: 'inbox' }, myAddress: mine, contactId: `a:${peer}` });
    expect(elsewhere.ownThread).not.toBe(true);
    const other = viewOf(mailbox, elsewhere);
    expect(other).toMatchObject({ ownThread: false, foreign: true, myAddress: MINI });
    expect(isOwnAgentMail(other)).toBe(false);
    expect(mailbox.claimById(elsewhere.id)).toBeNull();
    expect(mailbox.contacts.findAll(peer).map((c) => [c.id, c.myAddress])).toEqual([
      [`a:${peer}`, ''],
      [`a:${peer}~${work}`, work],
    ]);
  });
});
