import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { agentRequest } from '../src/cluster/agents.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { stageOutboxFiles, startMorse, INBOX_AGENT, type Morse, type MorseSendResult } from '../src/cluster/morse.js';
import { acceptRequest } from '../src/cluster/requests.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { startConsoleServer } from '../src/daemon/server.js';
import { loadPrimaryAddress, type AddressKey } from '../src/identity/address-key.js';
import { ensureAgentAddresses, renameAgentAddress } from '../src/identity/agent-addresses.js';
import { openV3 } from '../src/identity/envelope.js';
import { ensurePrekeys } from '../src/identity/prekeys.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { convertKnownHandles } from '../src/mailbox/migrate-v5.js';
import { createDb, MY_ADDRESS_MARK, SENDERS_RECORDED_MARK, type Db } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox, type Message } from '../src/mailbox/mailbox.js';
import { authedFetch as fetch, TEST_TOKEN } from './helpers/local-api.js';

/**
 * ADR-081 review — mail that was queued BEFORE the upgrade must go out as it would have:
 *
 *   - the release before could only send from the first address, and kept no sending address
 *     (`messages.my_address` did not exist; `messages.agent` held a display name such as `claude`);
 *   - so an outbound row without an address that is OLDER than this release's first daemon run on
 *     the database goes out from the first address, by the paths from before — whatever its name
 *     says, renamed since or never registered;
 *   - every row this release writes records its sending address ('' = none named: the first one);
 *     a row without one that is NEWER than that moment cannot exist and is refused.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-legacy-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
};

interface Dev {
  home: string;
  id: string;
  handle: string;
  agent: string | null;
  address: string;
  mailbox: Mailbox;
  db: Db;
  path: string;
  morse?: Morse;
  logs: string[];
}
const configOf = (d: { home: string }) => join(d.home, '.morse', 'config.json');
/** A computer on Morse; `agent: null` = it never registered an agent (only its old name). The database is a FILE (it is reopened). */
const dev = (handle: string, agent: string | null, more: string[] = []): Dev => {
  const home = freshHome();
  const identity = loadOrCreateIdentity(home);
  updateMachineConfig((cfg) => {
    cfg['relay'] = agent ? { handle, agent, agents: [agent, ...more] } : { handle };
  }, join(home, '.morse', 'config.json'));
  const ctx = homeContactContext(home);
  const path = join(home, 'mailbox.db');
  const db = createDb(path, { ctx });
  return { home, id: identity.id, handle, agent, address: loadPrimaryAddress(home, identity).address, mailbox: createMailbox(db, { ctx }), db, path, logs: [] };
};
const second = (d: Dev, name: string): AddressKey => ensureAgentAddresses(d.home).find((a) => a.agent === name)!.key;
const reopen = (d: Dev) => {
  const ctx = homeContactContext(d.home);
  d.db = createDb(d.path, { ctx });
  d.mailbox = createMailbox(d.db, { ctx });
};
const mark = (db: Db, key: string): string | null => (db.prepare('SELECT value FROM migration_marks WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const session = { agent: 'claude', sessionId: 's-1' };

/**
 * Turn this computer's database into one the RELEASE BEFORE left behind: no `messages.my_address`, no
 * `contacts.known_as`, none of this release's marks — with `rows` queued a minute ago under the display
 * name that release wrote. Then open it again with this release (the upgrade).
 */
const asBeforeTheUpgrade = (d: Dev, rows: Array<{ to: string; text: string; agent: string }>): string[] => {
  const ids = rows.map((r) => {
    const m = d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: r.to }, text: r.text });
    d.db.prepare('UPDATE messages SET agent = ?, created_at = created_at - 60000, updated_at = updated_at - 60000 WHERE id = ?').run(r.agent, m.id);
    return m.id;
  });
  d.db.exec('ALTER TABLE messages DROP COLUMN my_address');
  d.db.exec('ALTER TABLE contacts DROP COLUMN known_as');
  d.db.prepare(`DELETE FROM migration_marks WHERE key LIKE 'p3.%'`).run();
  d.db.close();
  reopen(d);
  return ids;
};
/** A row as the daemon of the release before queues it while it is still running after the update: no address column written. */
const asTheOldDaemon = (d: Dev, to: string, text: string, agent: string): string => {
  const m = d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: to }, text });
  d.db.prepare('UPDATE messages SET my_address = NULL, agent = ? WHERE id = ?').run(agent, m.id);
  return m.id;
};

let relay: FakeRelay | null = null;
const running: Morse[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
  closers.splice(0).forEach((c) => c());
  running.splice(0).forEach((m) => m.stop());
  await relay?.close();
  relay = null;
});
const url = () => `ws://127.0.0.1:${relay!.port}`;
const connect = (d: Dev, extra: Partial<Parameters<typeof startMorse>[0]> = {}) => {
  d.morse = startMorse({ url: url(), home: d.home, mailbox: d.mailbox, receiptTimeoutMs: 1500, connectWaitMs: 1000, log: (l) => d.logs.push(l), ...extra });
  running.push(d.morse);
  return d.morse;
};
const v3Online = (...ds: Dev[]) => until(() => ds.every((d) => Boolean(d.morse!.v3Client?.()?.connected())));
const online = (address: string) => until(() => relay!.onlineAddresses().includes(address));
const world = async (devs: Dev[]) => {
  relay = await startFakeRelay({ port: 0, host: '127.0.0.1', v3: true, allowlist: devs.map((d) => ({ id: d.id, handle: d.handle })), log: () => undefined });
  for (const d of devs) if (d.agent) await agentRequest({ url: url(), op: 'add', agent: d.agent, home: d.home });
};
/**
 * Paired the old way — and (ADR-091) what the v5 step leaves of it: each is the other's contact by old name, the
 * address known (the relay named it), turned into a contact by address that keeps the old name.
 */
const pair = (a: Dev, b: Dev) => {
  createTrustStore(a.home).add({ id: b.id, name: b.handle, tier: 'peer' });
  createTrustStore(b.home).add({ id: a.id, name: a.handle, tier: 'peer' });
  for (const [x, y] of [[a, b], [b, a]] as const) {
    x.mailbox.contacts.ensure(y.handle);
    x.mailbox.contacts.applySplit(`c:${y.handle}`, [{ agent: y.agent ?? 'mbp', address: y.address, default: true }]);
    convertKnownHandles(x.db);
  }
};
const deliver = async (d: Dev, c: Message): Promise<MorseSendResult> => {
  const r = await d.morse!.send(c.to.device!, c);
  if (r.ok) d.mailbox.markDelivered(c.id);
  else d.mailbox.markFailed(c.id, r.error ?? 'failed', r.waiting ? { waiting: true } : undefined);
  return r;
};
const flush = async (d: Dev): Promise<MorseSendResult[]> => {
  const out: MorseSendResult[] = [];
  for (let c = d.mailbox.claimNextPending({ scope: 'outbound' }); c; c = d.mailbox.claimNextPending({ scope: 'outbound' })) out.push(await deliver(d, c));
  return out;
};
const received = (d: Dev) => d.mailbox.inbox({ all: true }).filter((m) => m.direction === 'in');
const got = (d: Dev, text: string) => received(d).find((m) => m.parts[0]!.text === text)!;
const freePort = () =>
  new Promise<number>((done, fail) => {
    const srv = createNetServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => done(p));
    });
  });
/** Every envelope ann's FIRST address sent to `to` is by address — (ADR-091) no device certificate any more — and there is at least one. */
const wentFromTheFirstAddress = async (from: Dev, to: Dev) => {
  const envs = relay!.v3Log().filter((e) => e.from === from.address && e.to === to.address);
  expect(envs.length).toBeGreaterThan(0);
  const key = loadPrimaryAddress(to.home);
  for (const e of envs) expect((await openV3(JSON.parse(e.blob), { address: key.address, keys: ensurePrekeys(key).keys })).cert).toBeUndefined();
};
const NAME_GONE = (name: string) => `this message was queued from your address "${name}", which is no longer here under that name — send it again (morse send --from <name>; morse address lists them)`;

describe('the marks: when a database got my_address, and from when every outbound row records its sender', () => {
  it('a brand-new database: both moments are its creation — written once, the same on every later open', () => {
    const home = freshHome();
    const path = join(home, 'mailbox.db');
    const t0 = Date.now();
    const db = createDb(path);
    const [added, since] = [mark(db, MY_ADDRESS_MARK), mark(db, SENDERS_RECORDED_MARK)];
    expect(Number(added)).toBeGreaterThanOrEqual(t0);
    expect(Number(added)).toBeLessThanOrEqual(Date.now());
    expect(since).toBe(added);
    expect(createMailbox(db).sendersRecordedSince()).toBe(Number(added));
    db.close();
    // again, later, by several openers: nothing moves
    const opens = [createDb(path, { now: () => t0 + 5_000_000 }), createDb(path, { now: () => t0 + 9_000_000 })];
    for (const o of opens) {
      expect(mark(o, MY_ADDRESS_MARK)).toBe(added);
      expect(mark(o, SENDERS_RECORDED_MARK)).toBe(added);
      expect(createMailbox(o).sendersRecordedSince(true)).toBe(Number(added));
    }
    opens.forEach((o) => o.close());
  });

  it('a database of the release before: the column and its mark are added together at the first open; "every row records its sender" starts when this release\'s daemon first runs — once', () => {
    const ann = dev('ann', 'ann-mbp');
    asBeforeTheUpgrade(ann, [{ to: 'kai', text: 'queued before', agent: 'claude' }]);
    const added = Number(mark(ann.db, MY_ADDRESS_MARK));
    expect(added).toBeGreaterThan(0);
    expect((ann.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).some((c) => c.name === 'my_address')).toBe(true);
    expect((ann.db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string }>).some((c) => c.name === 'known_as')).toBe(true);
    // no daemon of this release has run yet: the daemon of the release before may still be queuing
    expect(mark(ann.db, SENDERS_RECORDED_MARK)).toBeNull();
    expect(ann.mailbox.sendersRecordedSince()).toBe(0);
    // a second process opening it meanwhile changes nothing
    const other = createDb(ann.path, { now: () => added + 777_000 });
    expect(mark(other, MY_ADDRESS_MARK)).toBe(String(added));
    expect(mark(other, SENDERS_RECORDED_MARK)).toBeNull();
    // the daemon starts: the moment is written — once; a later start (or another process) reads the same
    const since = ann.mailbox.sendersRecordedSince(true);
    expect(since).toBeGreaterThanOrEqual(added);
    expect(createMailbox(other, { now: () => since + 999_000 }).sendersRecordedSince(true)).toBe(since);
    expect(ann.mailbox.sendersRecordedSince(true)).toBe(since);
    expect(mark(ann.db, SENDERS_RECORDED_MARK)).toBe(String(since));
    other.close();
    // the user_version did not move and nothing was backed up for it (ADR-091: the schema version is 5 now)
    expect(ann.db.pragma('user_version', { simple: true })).toBe(5);
  });

  it('a database that has the column but no mark (a development build made it): nothing in it counts as "from before"', () => {
    const ann = dev('ann', 'ann-mbp');
    ann.db.prepare(`DELETE FROM migration_marks WHERE key LIKE 'p3.%'`).run();
    ann.db.close();
    reopen(ann);
    expect(mark(ann.db, MY_ADDRESS_MARK)).toBe('0');
    expect(mark(ann.db, SENDERS_RECORDED_MARK)).toBe('0');
    expect(ann.mailbox.sendersRecordedSince(true)).toBe(0);
  });
});

describe('mail queued before the upgrade goes out as it would have', () => {
  it('pending rows under a name like `claude`, and under the first agent\'s OLD name (renamed since): from the first address, the old way — and the row then says so itself', async () => {
    const [ann, kai] = [dev('ann', 'ann-mbp', ['work']), dev('kai', 'kai-mini')];
    await world([ann, kai]);
    const work = second(ann, 'work');
    pair(ann, kai);
    // the first agent was `ann-old` when the second row was queued; it has been renamed to `ann-mbp` since
    const [claude, renamed] = asBeforeTheUpgrade(ann, [
      { to: 'kai', text: 'queued under claude', agent: 'claude' },
      { to: 'kai', text: 'queued under the old first name', agent: 'ann-old' },
    ]);
    for (const id of [claude!, renamed!]) {
      const m = ann.mailbox.getMessage(id)!;
      expect(m.myAddress).toBeUndefined();
      expect(m.fromFirstAddress).toBeUndefined();
    }
    connect(ann);
    connect(kai);
    await v3Online(ann, kai);
    await online(work.address);
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }, { ok: true, via: 'relay' }]);
    // kai got both under his contact for her old name — (ADR-091) said as her address, decided by it
    for (const text of ['queued under claude', 'queued under the old first name']) expect(got(kai, text)).toMatchObject({ from: { device: ann.address }, contactId: 'c:ann', fromTier: 'peer' });
    // the same path and the same signer: her first address with the device certificate; her second address sent nothing
    await wentFromTheFirstAddress(ann, kai);
    expect(relay!.v3Log().filter((e) => e.from === work.address)).toEqual([]);
    // from now on the rows carry the address they went out from
    for (const id of [claude!, renamed!]) expect(ann.mailbox.getMessage(id)).toMatchObject({ status: 'delivered', myAddress: ann.address });
  }, 30_000);

  it('on a computer that never registered an agent: the pending row goes out, by the device path, under the old name alone', async () => {
    const [ann, kai] = [dev('ann', null), dev('kai', 'kai-mini')];
    await world([ann, kai]);
    pair(ann, kai);
    const [id] = asBeforeTheUpgrade(ann, [{ to: 'kai', text: 'no agent was ever registered here', agent: 'claude' }]);
    connect(ann);
    connect(kai);
    await v3Online(ann, kai);
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    expect(got(kai, 'no agent was ever registered here')).toMatchObject({ from: { device: ann.address }, contactId: 'c:ann' });
    await wentFromTheFirstAddress(ann, kai);
    expect(ann.mailbox.getMessage(id!)).toMatchObject({ status: 'delivered', myAddress: ann.address });
  }, 30_000);

  it('the first agent is renamed AFTER the upgrade, while the old row still waits: it goes out all the same', async () => {
    const [ann, kai] = [dev('ann', 'ann-mbp'), dev('kai', 'kai-mini')];
    await world([ann, kai]);
    pair(ann, kai);
    const [id] = asBeforeTheUpgrade(ann, [{ to: 'kai', text: 'waited across a rename', agent: 'ann-mbp' }]);
    ensureAgentAddresses(ann.home);
    updateMachineConfig((cfg) => {
      const r = cfg['relay'] as { agent: string; agents: string[] };
      r.agent = 'ann-new';
      r.agents = ['ann-new'];
    }, configOf(ann));
    renameAgentAddress('ann-mbp', 'ann-new', ann.home);
    connect(ann);
    connect(kai);
    await v3Online(ann, kai);
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    expect(got(kai, 'waited across a rename')).toMatchObject({ from: { device: ann.address } });
    expect(ann.mailbox.getMessage(id!)).toMatchObject({ myAddress: ann.address });
  }, 30_000);

  it('what the daemon of the release before queued AFTER the update, while it was still running, counts as "from before" too — until this release\'s daemon first starts', async () => {
    const [ann, kai] = [dev('ann', 'ann-mbp'), dev('kai', 'kai-mini')];
    await world([ann, kai]);
    pair(ann, kai);
    asBeforeTheUpgrade(ann, []);
    // the new command opened the database (the column is there); the old daemon keeps queuing without it
    const late = asTheOldDaemon(ann, 'kai', 'queued by the old daemon after the update', 'claude');
    expect(Number(mark(ann.db, MY_ADDRESS_MARK))).toBeLessThanOrEqual(ann.mailbox.getMessage(late)!.createdAt);
    await sleep(5);
    connect(ann);
    connect(kai);
    await v3Online(ann, kai);
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    expect(got(kai, 'queued by the old daemon after the update')).toMatchObject({ from: { device: ann.address } });
  }, 30_000);

  it('a row without a sending address made AFTER this release\'s daemon first ran is refused — nothing leaves, by any path', async () => {
    const [ann, ben, kai] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc'), dev('kai', 'kai-mini')];
    await world([ann, ben, kai]);
    second(ann, 'work');
    pair(ann, kai);
    const [old] = asBeforeTheUpgrade(ann, [{ to: 'kai', text: 'from before', agent: 'claude' }]);
    connect(ann);
    connect(ben);
    connect(kai);
    await v3Online(ann, ben, kai);
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    expect(ann.mailbox.getMessage(old!)!.status).toBe('delivered');
    const [v3Before, v2Before] = [relay!.v3Log().length, relay!.v2Sends().length];
    await sleep(5);
    // hand-made (no writer does this): the same names, an old-handle contact and a bare address
    const made = [asTheOldDaemon(ann, 'kai', 'hand-made, to kai', 'claude'), asTheOldDaemon(ann, 'kai', 'hand-made, first agent name', 'ann-mbp'), asTheOldDaemon(ann, ben.address, 'hand-made, to an address', 'work')];
    expect(await flush(ann)).toEqual([{ ok: false, error: NAME_GONE('claude') }, { ok: false, error: NAME_GONE('ann-mbp') }, { ok: false, error: NAME_GONE('work') }]);
    await sleep(200);
    expect(relay!.v3Log().length).toBe(v3Before);
    expect(relay!.v2Sends().length).toBe(v2Before);
    for (const id of made) expect(ann.mailbox.getMessage(id)).toMatchObject({ status: 'failed' });
    expect(received(kai).map((m) => m.parts[0]!.text)).toEqual(['from before']);
    expect(ben.mailbox.requests.count()).toBe(0);
    // …also after a restart of the daemon: the moment was written once
    running.splice(running.indexOf(ann.morse!), 1)[0]!.stop();
    connect(ann);
    await v3Online(ann);
    expect(await ann.morse!.send('kai', ann.mailbox.getMessage(made[0]!)!)).toEqual({ ok: false, error: NAME_GONE('claude') });
  }, 30_000);
});

describe('every writer of this release records the sending address when it queues', () => {
  it('sweep: the daemon (plain, bare address, --from by name and by address, the console), replies, the files sent again after an accept — no outbound row is left without one', async () => {
    const [ann, ben, kai] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc'), dev('kai', 'kai-mini')];
    await world([ann, ben, kai]);
    const work = second(ann, 'work');
    pair(ann, kai);
    connect(ann);
    connect(ben);
    connect(kai);
    await v3Online(ann, ben, kai);
    await online(work.address);
    const port = await freePort();
    const m = ann.morse!;
    const server = startConsoleServer({ token: TEST_TOKEN, 
      mailbox: ann.mailbox,
      directory: async () => [],
      port,
      changePollMs: 60_000,
      knowsDevice: (d) => m.knows(d),
      pairPerson: async (handle) => m.pairHandle(handle),
      addressRoute: (target, from) => m.addressRoute!(target, from),
      ownAddress: (from) => m.ownAddress!(from),
      acceptAddress: (address, from) => m.acceptAddress!(address, from), // (ADR-083) as `morse start` wires it: the address of mine that writes
      stageFiles: (paths) => stageOutboxFiles(paths, ann.home),
    });
    closers.push(() => server.close());
    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { message?: Message; sentFrom?: string; error?: string } };
    };
    const stored = (id: string) => (ann.db.prepare('SELECT my_address AS a FROM messages WHERE id = ?').get(id) as { a: string | null }).a;

    // the daemon's send endpoint
    // (ADR-091) kai's old name finds his contact, which is by address now: it goes from the first address, said as itself
    const plainOld = await post('/api/send', { target: 'morse.im/kai', text: 'plain, old-handle contact' });
    expect(plainOld.body.sentFrom).toBe(ann.address);
    expect(stored(plainOld.body.message!.id)).toBe(ann.address);
    const bare = await post('/api/send', { target: ben.address, text: 'plain, a bare address' });
    expect(bare.body.sentFrom).toBe(ann.address);
    expect(stored(bare.body.message!.id)).toBe(ann.address);
    const byName = await post('/api/send', { target: 'morse.im/kai', text: 'from the first address, by its name', fromAddress: 'ann-mbp' });
    expect(byName.body).toMatchObject({ sentFrom: ann.address, message: { myAgent: 'ann-mbp', myAddress: ann.address } });
    const file = join(ann.home, 'note.txt');
    writeFileSync(file, 'a small file');
    const byAddress = await post('/api/send', { target: ben.address, text: 'from work, by its address', fromAddress: work.address, files: [file] });
    expect(byAddress.body).toMatchObject({ sentFrom: work.address, message: { myAgent: 'work', myAddress: work.address } });
    // a name that is no address of this computer is refused here — never stored as a name
    const before = ann.mailbox.inbox({ all: true }).length;
    expect(await post('/api/send', { target: ben.address, text: 'x', fromAddress: 'ghost' })).toEqual({ status: 422, body: { error: `"ghost" is not one of your addresses here — morse address lists them` } });
    expect(ann.mailbox.inbox({ all: true })).toHaveLength(before);
    // the web console's endpoint (a message to a device)
    const web = await post('/api/messages', { from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'kai' }, text: 'from the console' });
    expect(stored(web.body.message!.id)).toBe('');
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }, { ok: true, via: 'relay', request: true }, { ok: true, via: 'relay' }, { ok: true, via: 'relay', request: true }, { ok: true, via: 'relay' }]);

    // replies: to mail that came the old way (→ none named: the first address), and to mail written to `work` (→ work)
    kai.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'ann' }, text: 'kai, the old way' });
    expect(await flush(kai)).toEqual([{ ok: true, via: 'relay' }]);
    const oldWay = ann.mailbox.reply(got(ann, 'kai, the old way').id, 'answer the old way');
    // (ADR-091: mail that came the old way is filed by the address it was sealed to — the first one, said as itself)
    expect(stored(oldWay.id)).toBe(ann.address);
    const r = acceptRequest(work.address, { mailbox: ben.mailbox, trust: createTrustStore(ben.home), home: ben.home });
    expect(r.ok).toBe(true);
    await ben.morse!.notifyAccepted(work.address);
    // …which makes her computer queue the files of that message again (a request keeps none): from `work`, like the message
    await until(() => ann.logs.some((l) => /sending the files of 1 message\(s\) again/.test(l)));
    const again = ann.db.prepare(`SELECT my_address AS a, agent FROM messages WHERE direction = 'out' AND parts LIKE '%morse-files%'`).all();
    expect(again).toEqual([{ a: work.address, agent: 'work' }]);
    const toWork = ben.mailbox.reply((r as { message: Message }).message.id, 'ben to work');
    expect(await deliver(ben, ben.mailbox.claimNextPending({ scope: 'outbound' })!)).toEqual({ ok: true, via: 'relay' });
    expect(ben.db.prepare('SELECT my_address AS a FROM messages WHERE id = ?').get(toWork.id)).toEqual({ a: ben.address });
    const native = ann.mailbox.reply(got(ann, 'ben to work').id, 'work answering');
    expect(stored(native.id)).toBe(work.address);
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }, { ok: true, via: 'relay' }, { ok: true, via: 'relay' }]);
    expect(received(ben).filter((x) => x.parts[0]!.files?.length).map((x) => x.from.device)).toEqual([work.address]);

    // the sweep: every outbound row of both computers that write by address has its address (or '')
    for (const d of [ann, ben, kai]) {
      const rows = d.db.prepare(`SELECT id, my_address AS a, parts FROM messages WHERE direction = 'out'`).all() as Array<{ id: string; a: string | null; parts: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((x) => x.a === null).map((x) => x.parts)).toEqual([]);
    }
    // and the mailbox itself refuses to queue a name without its address
    expect(() => ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'kai' }, text: 'x', myAgent: 'work' })).toThrow('a sending address was named ("work") without the address itself — nothing queued');
  }, 30_000);

  it('--from <name> while the relay is away: queued with the ADDRESS the name stands for (no row with only a name), and sent from it when the relay is back', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    const work = second(ann, 'work');
    // her daemon cannot reach the relay: a port nobody listens on
    const dead = await freePort();
    ann.morse = startMorse({ url: `ws://127.0.0.1:${dead}`, home: ann.home, mailbox: ann.mailbox, receiptTimeoutMs: 1500, connectWaitMs: 200, log: (l) => ann.logs.push(l) });
    running.push(ann.morse);
    const m = ann.morse;
    const port = await freePort();
    const server = startConsoleServer({ token: TEST_TOKEN, 
      mailbox: ann.mailbox,
      directory: async () => [],
      port,
      changePollMs: 60_000,
      knowsDevice: (d) => m.knows(d),
      addressRoute: (target, from) => m.addressRoute!(target, from),
      ownAddress: (from) => m.ownAddress!(from),
      acceptAddress: (address, from) => m.acceptAddress!(address, from), // (ADR-083) as `morse start` wires it: the address of mine that writes
    });
    closers.push(() => server.close());
    const res = await fetch(`http://127.0.0.1:${port}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: ben.address, text: 'queued while the relay is away', fromAddress: 'work' }) });
    const body = (await res.json()) as { message: Message; sentFrom: string };
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ sentFrom: work.address, message: { myAgent: 'work', myAddress: work.address } });
    expect(ann.db.prepare('SELECT my_address AS a, agent FROM messages WHERE id = ?').get(body.message.id)).toEqual({ a: work.address, agent: 'work' });
    // a daemon that reaches the relay takes over: from `work`, nothing from the first address
    running.splice(running.indexOf(m), 1)[0]!.stop();
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    await online(work.address);
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay', request: true }]);
    expect(ben.mailbox.requests.list().map((r) => r.handle)).toEqual([work.address]);
    expect(relay!.v3Log().some((e) => e.from === ann.address)).toBe(false);
  }, 30_000);
});
