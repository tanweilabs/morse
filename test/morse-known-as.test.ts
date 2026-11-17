import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { agentRequest } from '../src/cluster/agents.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { startMorse, INBOX_AGENT, type Morse, type MorseSendResult } from '../src/cluster/morse.js';
import { acceptRequest } from '../src/cluster/requests.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { describeKnownAs, knownAsLine } from '../src/commands/known-as.js';
import { startConsoleServer } from '../src/daemon/server.js';
import { loadPrimaryAddress, type AddressKey } from '../src/identity/address-key.js';
import { ensureAgentAddresses } from '../src/identity/agent-addresses.js';
import { openV3, type OpenedV3 } from '../src/identity/envelope.js';
import { ensurePrekeys } from '../src/identity/prekeys.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { createDb, type Db } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { contactKnownAs } from '../src/mailbox/known-as.js';
import { createMailbox, type Mailbox, type Message } from '../src/mailbox/mailbox.js';
import { authedFetch as fetch, TEST_TOKEN } from './helpers/local-api.js';

/**
 * ADR-081 review N2 — which of MY addresses a contact knows me by is remembered per contact
 * (`contacts.known_as`) and is the default sender of mail to them:
 *
 *   - learnt from the FIRST mail with the contact: the address their mail was written to (a request
 *     that is accepted, a message by address), or the address I first wrote to them from; mail that
 *     comes or goes the old way means the first address;
 *   - first knowledge wins: later mail to or from another address of mine does not switch it;
 *   - `--from` overrides it for one message and does not change it;
 *   - an address that is no longer here is refused — never the first address instead.
 *
 * (ADR-083) "Which address a contact knows me by" is no longer learnt from the first mail: a contact
 * BELONGS to one address of mine (`Contact.myAddress`, '' = the first), from the moment it is made, and
 * the same person can be a separate contact of two of my addresses. The scenarios below are the ones of
 * the N2 review; where they said "does not switch it", they now say "is another contact".
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-known-'));
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
  agent: string;
  address: string;
  mailbox: Mailbox;
  db: Db;
  morse?: Morse;
  logs: string[];
  port?: number;
}
const configOf = (d: { home: string }) => join(d.home, '.morse', 'config.json');
const dev = (handle: string, agent: string, more: string[] = []): Dev => {
  const home = freshHome();
  const identity = loadOrCreateIdentity(home);
  updateMachineConfig((cfg) => {
    cfg['relay'] = { handle, agent, agents: [agent, ...more] };
  }, join(home, '.morse', 'config.json'));
  const ctx = homeContactContext(home);
  const db = createDb(':memory:', { ctx });
  return { home, id: identity.id, handle, agent, address: loadPrimaryAddress(home, identity).address, mailbox: createMailbox(db, { ctx }), db, logs: [] };
};
const second = (d: Dev, name: string): AddressKey => ensureAgentAddresses(d.home).find((a) => a.agent === name)!.key;
const removeAddress = (d: Dev, name: string) =>
  updateMachineConfig((cfg) => {
    const r = cfg['relay'] as { agents: string[] };
    r.agents = r.agents.filter((a) => a !== name);
  }, configOf(d));

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
const connect = (d: Dev) => {
  d.morse = startMorse({ url: url(), home: d.home, mailbox: d.mailbox, receiptTimeoutMs: 1500, connectWaitMs: 1000, log: (l) => d.logs.push(l) });
  running.push(d.morse);
  return d.morse;
};
const restart = async (d: Dev) => {
  d.morse?.stop();
  running.splice(running.indexOf(d.morse!), 1);
  connect(d);
  await v3Online(d);
};
const v3Online = (...ds: Dev[]) => until(() => ds.every((d) => Boolean(d.morse!.v3Client?.()?.connected())));
const online = (address: string) => until(() => relay!.onlineAddresses().includes(address));
const world = async (devs: Dev[]) => {
  relay = await startFakeRelay({ port: 0, host: '127.0.0.1', v3: true, allowlist: devs.map((d) => ({ id: d.id, handle: d.handle })), log: () => undefined });
  for (const d of devs) await agentRequest({ url: url(), op: 'add', agent: d.agent, home: d.home });
};
const pair = (a: Dev, b: Dev) => {
  createTrustStore(a.home).add({ id: b.id, name: b.handle, tier: 'peer' });
  createTrustStore(b.home).add({ id: a.id, name: a.handle, tier: 'peer' });
};
const session = { agent: 'claude', sessionId: 's-1' };
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
/** This computer's daemon console, as `morse start` wires it — `morse send` posts here. */
const daemon = async (d: Dev) => {
  d.port = await freePort();
  const server = startConsoleServer({ token: TEST_TOKEN, 
    mailbox: d.mailbox,
    directory: async () => [],
    port: d.port,
    changePollMs: 60_000,
    knowsDevice: (x) => d.morse!.knows(x),
    pairPerson: async (handle) => d.morse!.pairHandle(handle),
    addressRoute: (target, from) => d.morse!.addressRoute!(target, from),
    ownAddress: (from) => d.morse!.ownAddress!(from),
    acceptAddress: (address, from) => d.morse!.acceptAddress!(address, from), // (ADR-083) as `morse start` wires it: the address of mine that writes
  });
  closers.push(() => server.close());
};
/** `morse send <target> "…" [--from <name>]` as it reaches the daemon. */
const send = async (d: Dev, target: string, text: string, from?: string) => {
  const res = await fetch(`http://127.0.0.1:${d.port}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, text, ...(from ? { fromAddress: from } : {}) }) });
  return { status: res.status, ...((await res.json()) as { message?: Message; sentFrom?: string; error?: string }) };
};
const accept = async (d: Dev, address: string) => {
  const r = acceptRequest(address, { mailbox: d.mailbox, trust: createTrustStore(d.home), home: d.home });
  if (!r.ok) throw new Error(r.error);
  return { ...r, told: await d.morse!.notifyAccepted(address, r.request.myAddress) }; // (ADR-083) only the address of mine that accepted says so
};
const open = async (key: AddressKey, blob: string): Promise<OpenedV3> => openV3(JSON.parse(blob), { address: key.address, keys: ensurePrekeys(key).keys });
const GONE = (address: string) => `this message was written from your address morse.im/${address}, which is no longer here (or its key is not loaded) — not sent`;
/** Nothing ann's FIRST address, her old name, her computer or a certificate is in any envelope between these two addresses. */
const onlyTheSecondAddress = async (ann: Dev, mine: AddressKey, ben: Dev) => {
  const log = relay!.v3Log();
  expect(log.some((e) => e.from === ann.address || e.to === ann.address)).toBe(false);
  expect(relay!.v2Sends()).toEqual([]);
  const benKey = loadPrimaryAddress(ben.home);
  for (const e of log) {
    const o = await open(e.to === ben.address ? benKey : mine, e.blob);
    expect(o.cert).toBeUndefined();
    expect([mine.address, ben.address]).toContain(o.from);
    const text = o.body.toString('utf8');
    for (const secret of [ann.address, ann.id, `"${ann.handle}"`, ann.agent, 'fromHandle', 'fromAgent']) expect(text).not.toContain(secret);
  }
};

describe('N2 — a contact is written to from the address of mine it knows me by', () => {
  it('a stranger writes to my SECOND address: once accepted, a plain send to them goes out from that address — no first address, no old name, no certificate', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    const work = second(ann, 'work');
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    await online(work.address);
    await daemon(ann);
    await daemon(ben);
    expect(await send(ben, work.address, 'hello work')).toMatchObject({ status: 201 });
    expect(await flush(ben)).toEqual([{ ok: true, via: 'relay', request: true }]);
    // a request is not a contact yet: nothing is known
    expect(ann.mailbox.contacts.find(ben.address)).toBeNull();
    await accept(ann, ben.address);
    // (ADR-083) he is a contact OF `work` — the row itself says so — and of no other address of mine
    const atWork = ann.mailbox.contacts.byAddress(ben.address, work.address)!;
    expect(atWork).toMatchObject({ id: `a:${ben.address}~${work.address}`, myAddress: work.address });
    expect(ann.mailbox.contacts.byAddress(ben.address)).toBeNull();
    expect(ann.mailbox.contacts.knownAs(atWork.id)).toBe(work.address);
    expect(ann.db.prepare('SELECT known_as AS k FROM contacts WHERE id = ?').get(atWork.id)).toEqual({ k: work.address });

    // morse send <ben> "…" — no --from
    const plain = await send(ann, `morse.im/${ben.address}`, 'a plain send');
    expect(plain).toMatchObject({ status: 201, sentFrom: work.address, message: { myAddress: work.address, myAgent: 'work', to: { device: ben.address } } });
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    expect(got(ben, 'a plain send')).toMatchObject({ from: { device: work.address }, contactId: `a:${work.address}` });
    await onlyTheSecondAddress(ann, work, ben);
    // on his side there is one contact, by her second address
    expect(ben.mailbox.contacts.list().filter((c) => c.id !== 'self').map((c) => c.id)).toEqual([`a:${work.address}`]);
    // any writer that names nothing gets the same default (the web console, a plugin): the mailbox itself applies it
    const direct = ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ben.address }, text: 'queued without the daemon' });
    expect(direct).toMatchObject({ myAddress: work.address });
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    await onlyTheSecondAddress(ann, work, ben);
  }, 30_000);

  it('I first write to a new address from my second address: remembered; --from another one is for that message only and changes nothing', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    const work = second(ann, 'work');
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    await online(work.address);
    await daemon(ann);
    expect(await send(ann, ben.address, 'first, from work', 'work')).toMatchObject({ status: 201, sentFrom: work.address });
    // (ADR-083) writing to him from `work` makes him a contact of `work` — and only of it
    const atWork = `a:${ben.address}~${work.address}`;
    expect(ann.mailbox.contacts.findAll(ben.address).map((c) => [c.id, c.myAddress])).toEqual([[atWork, work.address]]);
    expect(ann.mailbox.contacts.knownAs(atWork)).toBe(work.address);
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay', request: true }]);
    await accept(ben, work.address);
    await until(() => ann.logs.some((l) => /accepted your message request/.test(l)));
    // plain: from work
    expect(await send(ann, ben.address, 'plain')).toMatchObject({ status: 201, sentFrom: work.address, message: { myAddress: work.address } });
    // --from the first address, by its name: this one message goes from it — he sees a stranger (a request of its own).
    // (ADR-083) That is writing to him AS another address: he becomes a contact of the first address too — a separate one
    const other = await send(ann, ben.address, 'this one from my first address', 'ann-mbp');
    expect(other).toMatchObject({ status: 201, sentFrom: ann.address, message: { myAddress: ann.address, myAgent: 'ann-mbp', contactId: `a:${ben.address}` } });
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }, { ok: true, via: 'relay', request: true }]);
    expect(ben.mailbox.requests.list().map((r) => r.handle)).toEqual([ann.address]);
    // the contact of `work` is not changed — and his later mail to her FIRST address is the first address's contact's
    expect(ann.mailbox.contacts.findAll(ben.address).map((c) => [c.id, c.myAddress])).toEqual([[`a:${ben.address}`, ''], [atWork, work.address]]);
    await accept(ben, ann.address);
    ben.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ann.address }, text: 'ben to her first address', firstAddress: true });
    expect(await flush(ben)).toEqual([{ ok: true, via: 'relay' }]);
    expect(got(ann, 'ben to her first address')).toMatchObject({ myAddress: ann.address, contactId: `a:${ben.address}` });
    expect(ann.mailbox.contacts.knownAs(atWork)).toBe(work.address);
    expect(ann.mailbox.contacts.knownAs(`a:${ben.address}`)).toBe('');
    // (ADR-083) his address is a contact of two of mine now: a plain send is refused with the one line — never guessed
    expect(await send(ann, ben.address, 'plain again')).toEqual({ status: 422, error: `morse.im/${ben.address} is a contact of 2 of your addresses (ann-mbp, work) — say which one: --from <name>` });
    expect(await send(ann, ben.address, 'plain again', 'work')).toMatchObject({ status: 201, sentFrom: work.address, message: { contactId: atWork } });
    // `morse reply` answers from the address the original was written to — here her first one
    expect(ann.mailbox.reply(got(ann, 'ben to her first address').id, 'answering there')).toMatchObject({ myAddress: ann.address });
  }, 30_000);

  it('the remembered address is no longer on this computer: refused before anything is queued, and what was queued is not sent — never from the first address', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    const work = second(ann, 'work');
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    await online(work.address);
    await daemon(ann);
    await daemon(ben);
    await send(ben, work.address, 'hello work');
    await flush(ben);
    await accept(ann, ben.address);
    const queued = ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ben.address }, text: 'queued before work was removed' });
    expect(queued).toMatchObject({ myAddress: work.address });

    removeAddress(ann, 'work');
    await restart(ann);
    const [v3Before, v2Before, rows] = [relay!.v3Log().length, relay!.v2Sends().length, ann.mailbox.inbox({ all: true }).length];
    expect(await send(ann, `morse.im/${ben.address}`, 'after it was removed')).toEqual({ status: 422, error: GONE(work.address) });
    expect(ann.mailbox.inbox({ all: true })).toHaveLength(rows);
    expect(await flush(ann)).toEqual([{ ok: false, error: GONE(work.address) }]);
    await sleep(200);
    expect(relay!.v3Log().length).toBe(v3Before);
    expect(relay!.v2Sends().length).toBe(v2Before);
    expect(received(ben).map((m) => m.parts[0]!.text)).toEqual([]);
    // he is still the contact of that address; (ADR-083) naming another address writes to him as that one — its own contact
    const atWork = ann.mailbox.contacts.byAddress(ben.address, work.address)!;
    expect(atWork).toMatchObject({ id: `a:${ben.address}~${work.address}`, myAddress: work.address });
    expect(ann.mailbox.contacts.knownAs(atWork.id)).toBe(work.address);
    expect(await send(ann, ben.address, 'from my first address then', 'ann-mbp')).toMatchObject({ status: 201, sentFrom: ann.address, message: { contactId: `a:${ben.address}` } });
    expect(ann.mailbox.contacts.knownAs(atWork.id)).toBe(work.address);
    // the line `morse contact <who>` shows for it
    expect(knownAsLine(describeKnownAs(work.address, { first: ann.address, byName: { 'ann-mbp': ann.address } })!)).toBe(
      `knows you as: morse.im/${work.address} — an address that is no longer here: mail to them is not sent unless you name one (morse send … --from <name>)`,
    );
  }, 30_000);

  // (ADR-091, stage 2) removed: "a contact with an old handle and no mail by address: exactly as before…" — its premise (the old way: an old name, a device path) is gone.
});

describe('N2 — the store', () => {
  const store = () => {
    const d = dev('ann', 'ann-mbp');
    return d;
  };
  const other = '23456789abcdefghjkmnpqrstv';
  const mine = 'wxyz23456789abcdefghjkmnpq';
  const mine2 = 'zzzz23456789abcdefghjkmnpq';

  it('known_as is an additive nullable column on contacts (no user_version step); self never has one', () => {
    const d = store();
    const col = (d.db.prepare('PRAGMA table_info(contacts)').all() as Array<{ name: string; notnull: number; dflt_value: unknown; type: string }>).find((c) => c.name === 'known_as');
    expect(col).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    expect(d.db.pragma('user_version', { simple: true })).toBe(5); // (ADR-091: the schema version is 5 now; the column itself is still additive)
    expect(d.mailbox.contacts.knownAs('self')).toBeNull();
    expect(d.mailbox.contacts.knownAs('c:nobody')).toBeNull();
    // mail between my own sessions teaches nothing
    d.mailbox.send({ from: session, to: { agent: 'codex', sessionId: 's-2' }, text: 'internal' });
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE known_as IS NOT NULL').get()).toEqual({ n: 0 });
  });

  it('first knowledge wins: the first mail with a contact decides — by address: the address it was written to / from; the old way: the first address', () => {
    const d = store();
    // their mail by address, written to `mine`: (ADR-083) the contact of (mine, them) — the row says which address
    const atMine = `a:${other}~${mine}`;
    expect(d.mailbox.send({ from: { agent: 'claude', sessionId: '', device: other }, to: { agent: 'work', sessionId: 'inbox' }, text: 'in', myAddress: mine })).toMatchObject({ contactId: atMine });
    expect(d.mailbox.contacts.byAddress(other, mine)).toMatchObject({ id: atMine, myAddress: mine });
    expect(d.mailbox.contacts.knownAs(atMine)).toBe(mine);
    // and what I send them without naming an address goes out from it (the one contact there is)
    expect(d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: other }, text: 'default' })).toMatchObject({ myAddress: mine, contactId: atMine });
    // later mail written to another address of mine, and mail I send from another: no change to that contact —
    // (ADR-083) it is the business of ANOTHER contact, the one of (mine2, them)
    const atMine2 = `a:${other}~${mine2}`;
    expect(d.mailbox.send({ from: { agent: 'claude', sessionId: '', device: other }, to: { agent: 'user', sessionId: 'inbox' }, text: 'in 2', myAddress: mine2 })).toMatchObject({ contactId: atMine2 });
    expect(d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: other }, text: 'out', myAddress: mine2, myAgent: 'x' })).toMatchObject({ contactId: atMine2, myAddress: mine2 });
    expect(d.mailbox.contacts.knownAs(atMine)).toBe(mine);
    expect(d.mailbox.contacts.findAll(other).map((c) => [c.id, c.myAddress])).toEqual([[atMine, mine], [atMine2, mine2]]);
    // a contact of two of my addresses, none named: (ADR-083) never guessed — nothing is queued
    const rows = d.mailbox.inbox({ all: true }).length;
    expect(() => d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: other }, text: 'default 2' })).toThrow(`morse.im/${other} is a contact of 2 of your addresses — say which one: --from <name>`);
    expect(d.mailbox.inbox({ all: true })).toHaveLength(rows);
    // …unless the caller says "the first address" (an answer to mail that came the old way): its own contact of them
    expect(d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: other }, text: 'first', firstAddress: true })).toMatchObject({ fromFirstAddress: true, contactId: `a:${other}` });
    expect(d.mailbox.contacts.knownAs(`a:${other}`)).toBe('');

    // the old way, inbound and outbound: the first address ('')
    d.mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'kai/kai-mini' }, to: { agent: 'user', sessionId: 'inbox' }, text: 'old in', fromTier: 'peer' });
    expect(d.mailbox.contacts.knownAs('c:kai')).toBe('');
    d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'lee' }, text: 'old out' });
    expect(d.mailbox.contacts.knownAs('c:lee')).toBe('');
    expect(d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'lee' }, text: 'old out 2' })).toMatchObject({ fromFirstAddress: true });
  });

  // (ADR-083) was: 'a contact from before this was kept: told from its oldest message, once — and kept'. Nothing is
  // told from the mail any more — the row says which address of mine a contact belongs to (the v3 → v4 migration
  // decides it for the rows from before: test/migrate-v4.test.ts) — and the `known_as` column is not read
  it('a contact whose known_as column says nothing, or something else: the row itself decides — the column is not read (ADR-083)', () => {
    const d = store();
    d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'kai' }, text: 'from before' });
    d.mailbox.send({ from: { agent: 'claude', sessionId: '', device: other }, to: { agent: 'work', sessionId: 'inbox' }, text: 'in', myAddress: mine });
    const atMine = `a:${other}~${mine}`;
    // as a morse of the release before may leave them: no known_as, the old row without an address
    d.db.prepare('UPDATE contacts SET known_as = NULL').run();
    d.db.prepare(`UPDATE messages SET my_address = NULL WHERE to_device = 'kai'`).run();
    expect(d.mailbox.contacts.knownAs('c:kai')).toBe('');
    expect(d.mailbox.contacts.knownAs(atMine)).toBe(mine);
    expect(d.db.prepare(`SELECT id, my_address AS m FROM contacts WHERE id != 'self' ORDER BY id`).all()).toEqual([{ id: atMine, m: mine }, { id: 'c:kai', m: '' }]);
    // a reply to mail that came the old way goes from the first address — whatever the column says
    d.db.prepare(`UPDATE contacts SET known_as = ? WHERE id = 'c:kai'`).run(mine);
    const inbound = d.mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'kai/kai-mini' }, to: { agent: 'user', sessionId: 'inbox' }, text: 'old in', fromTier: 'peer' });
    expect(d.mailbox.reply(inbound.id, 'answer')).toMatchObject({ fromFirstAddress: true });
    // (ADR-083) a contact by old name is the first address's alone: a new message to it goes out from the first address
    expect(d.mailbox.contacts.knownAs('c:kai')).toBe('');
    const fresh = d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'kai' }, text: 'a new message' });
    expect(fresh).toMatchObject({ fromFirstAddress: true, contactId: 'c:kai' });
    expect(fresh.myAddress).toBeUndefined();
  });

  it('which targets count as a person (the daemon and the command use one rule): an address, morse.im/…, a paired old name — never a session or a bare word', () => {
    const d = store();
    d.mailbox.send({ from: { agent: 'claude', sessionId: '', device: other }, to: { agent: 'work', sessionId: 'inbox' }, text: 'in', myAddress: mine });
    d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'kai' }, text: 'out' });
    const c = d.mailbox.contacts;
    // (ADR-083) the contact of (mine, them): a new row of another address of mine is `a:<theirs>~<mine>`
    for (const t of [other, `morse.im/${other}`, `https://morse.im/${other.toUpperCase()}/`]) expect(contactKnownAs(c, t, () => false)).toMatchObject({ known: mine, contact: { id: `a:${other}~${mine}`, myAddress: mine } });
    expect(contactKnownAs(c, 'morse.im/kai', () => false)).toMatchObject({ known: '', contact: { id: 'c:kai' } });
    expect(contactKnownAs(c, 'kai', () => false)).toBeNull();
    expect(contactKnownAs(c, 'kai', (h) => h === 'kai')).toMatchObject({ known: '' });
    for (const t of ['@claude:s-1', '@kai', 'claude:s-1', 'me', 'morse.im/nobody', '']) expect(contactKnownAs(c, t, () => true)).toBeNull();
  });
});
