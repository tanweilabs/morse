import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { buildV2Home } from './helpers/v2-home.js';
import { agentRequest } from '../src/cluster/agents.js';
import { blockHandle, blockedHandles, unblockHandle } from '../src/cluster/blocklist.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { stageOutboxFiles, startMorse, INBOX_AGENT, type Morse, type MorseSendResult } from '../src/cluster/morse.js';
import { acceptRequest, declineRequest, formatRequests } from '../src/cluster/requests.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { startConsoleServer } from '../src/daemon/server.js';
import { addressFromPublicKey, rawPublicKey } from '../src/identity/address.js';
import { loadPrimaryAddress, type AddressKey } from '../src/identity/address-key.js';
import { agentAddressIndex, ensureAgentAddresses } from '../src/identity/agent-addresses.js';
import { openV3, sealV3, type OpenedV3 } from '../src/identity/envelope.js';
import { ensurePrekeys } from '../src/identity/prekeys.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { createDb, type Db } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { contactsOfTarget } from '../src/mailbox/known-as.js';
import { createMailbox, type Mailbox, type Message } from '../src/mailbox/mailbox.js';
import { authedFetch as fetch, TEST_TOKEN } from './helpers/local-api.js';

/**
 * ADR-081 on the client, against the in-memory fake relay: the 26-character address works on
 * its own. Two computers that have never met reach each other by address alone (no handle, no
 * directory, no pairing): a message request keyed by the address, accept / reject / block,
 * receipts, replies in the thread, the offline mailbox, restarts in between. A computer
 * migrated from the release before keeps every old contact exactly as it was. Each address of
 * a computer can send, and the other side then sees only that address. Peers that are too
 * old, addresses nobody published and a relay that lies are refused with one line.
 */

const TOO_OLD = (address: string) =>
  `${address}: their Morse is too old to be reached by address (it needs the release after 20261114170051) — ask them to update: run the installer again (morse.im)`; // (ADR-091) no old name to fall back on

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-addr-'));
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
  /** This computer's first address (its device key's). */
  address: string;
  mailbox: Mailbox;
  db?: Db;
  morse?: Morse;
  logs: string[];
}
/** A computer that joined Morse: its config says who it is; `more` = agents added later (each its own address). */
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
/**
 * (ADR-081 review: legacy rows) A hand-made outbound row with NO sending address, only a local name — what no writer of
 * this release produces (the mailbox refuses to queue one): made by SQL, on a row queued normally.
 */
const nameOnly = (d: Dev, to: string, text: string, name: string): Message => {
  const m = d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: to }, text });
  d.db!.prepare('UPDATE messages SET my_address = NULL, agent = ? WHERE id = ?').run(name, m.id);
  return d.mailbox.getMessage(m.id)!;
};
/** The address of the agent `name` added after the first (its own key). */
const second = (d: Dev, name: string): AddressKey => ensureAgentAddresses(d.home).find((a) => a.agent === name)!.key;

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
const stop = (d: Dev) => {
  d.morse?.stop();
  running.splice(running.indexOf(d.morse!), 1);
};
const v3Online = (...ds: Dev[]) => until(() => ds.every((d) => Boolean(d.morse!.v3Client?.()?.connected())));
const offline = (address: string) => until(() => !relay!.onlineAddresses().includes(address));
/** People on the relay: each with a handle of their own (that nobody else is told) and their agent in the v2 directory. */
const world = async (devs: Dev[], relayOpts: Parameters<typeof startFakeRelay>[0] = {}) => {
  relay = await startFakeRelay({ port: 0, host: '127.0.0.1', v3: true, allowlist: devs.map((d) => ({ id: d.id, handle: d.handle })), log: () => undefined, ...relayOpts });
  for (const d of devs) await agentRequest({ url: url(), op: 'add', agent: d.agent, home: d.home });
};

const session = { agent: 'claude', sessionId: 's-1' };
/** What the outbox does with one message: hand it to Morse, record the outcome. */
const deliver = async (d: Dev, c: Message): Promise<MorseSendResult> => {
  const r = await d.morse!.send(c.to.device!, c);
  if (r.ok) d.mailbox.markDelivered(c.id);
  else d.mailbox.markFailed(c.id, r.error ?? 'failed', r.waiting ? { waiting: true } : undefined);
  return r;
};
/** Everything that is due in the outbox, oldest first. */
const flush = async (d: Dev): Promise<MorseSendResult[]> => {
  const out: MorseSendResult[] = [];
  for (let c = d.mailbox.claimNextPending({ scope: 'outbound' }); c; c = d.mailbox.claimNextPending({ scope: 'outbound' })) out.push(await deliver(d, c));
  return out;
};
/**
 * `morse send <target> "…" [--from <name>]` as the daemon runs it (src/daemon/server.ts): ask whether it goes
 * by address alone, refuse with the one line when it cannot, else accept the address, queue, and send.
 */
const write = async (from: Dev, target: string, text: string, o: { from?: string; contextId?: string; session?: { agent: string; sessionId: string } } = {}) => {
  // (ADR-083) with no address named: the ONE contact there is says which of my addresses writes (the row it belongs to)
  const persons = o.from ? null : contactsOfTarget(from.mailbox.contacts, target, (h) => from.morse!.knows(h));
  const theirs = persons?.length === 1 && persons[0]!.myAddress ? persons[0]!.myAddress : null;
  const route = await from.morse!.addressRoute!(target, o.from ?? theirs);
  if (route && !route.ok && !route.waiting) return { refused: route.error };
  const bare = /^(?:morse\.im\/)?([23456789abcdefghjkmnpqrstvwxyz]{26})$/i.exec(target)?.[1]?.toLowerCase();
  // (ADR-081 review: legacy rows) --from <name> is recorded as the ADDRESS it stands for, when it is queued
  const own = o.from ? from.morse!.ownAddress!(o.from) : theirs ? (from.morse!.ownAddress!(theirs) ?? { address: theirs, name: null }) : null;
  // (ADR-083) writing to an address makes it a contact OF the address of mine that writes
  if (route && bare) from.morse!.acceptAddress!(bare, own?.address ?? null);
  const myAgent = own ? (own.name ?? o.from) : undefined;
  const m = from.mailbox.send({
    from: o.session ?? session,
    to: { agent: INBOX_AGENT, sessionId: '', device: route && bare ? bare : target.replace(/^morse\.im\//, '') },
    text,
    via: 'cli',
    ...(own ? { ...(myAgent ? { myAgent } : {}), myAddress: own.address } : {}),
    ...(o.contextId ? { contextId: o.contextId } : {}),
  });
  const r = await deliver(from, from.mailbox.claimNextPending({ scope: 'outbound' })!);
  return { m, r };
};
/** `morse reply <id> "…"`: the mailbox makes the reply, the outbox sends it. */
const reply = async (d: Dev, id: string, text: string) => {
  const m = d.mailbox.reply(id, text);
  const r = await deliver(d, d.mailbox.claimNextPending({ scope: 'outbound' })!);
  return { m, r };
};
/** `morse contact accept <address>`: the CLI accepts, then tells the daemon. */
const accept = async (d: Dev, address: string) => {
  const r = acceptRequest(address, { mailbox: d.mailbox, trust: createTrustStore(d.home), home: d.home });
  if (!r.ok) throw new Error(r.error);
  return { ...r, told: await d.morse!.notifyAccepted(address, r.request.myAddress) }; // (ADR-083) only the address of mine that accepted says so
};
/** A message as the outbox would hand it over had its receipt not come (a late resend). */
const again = (d: Dev, id: string): Message => {
  const { receiptAt: _receiptAt, ...m } = d.mailbox.getMessage(id)!;
  return m;
};
const received = (d: Dev) => d.mailbox.inbox({ all: true }).filter((m) => m.direction === 'in');
const texts = (d: Dev) => received(d).map((m) => m.parts[0]!.text);
const got = (d: Dev, text: string) => received(d).find((m) => m.parts[0]!.text === text)!;
const trusted = (d: Dev) => createTrustStore(d.home).list();

/** Open an envelope the fake relay carried, with the recipient's own prekeys (what its daemon does). */
const open = async (key: AddressKey, blob: string): Promise<OpenedV3> => openV3(JSON.parse(blob), { address: key.address, keys: ensurePrekeys(key).keys });
const bodyOf = (o: OpenedV3) => {
  try {
    return JSON.parse(o.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null; // a file chunk
  }
};
/** A hand-made envelope from `from` (any key) to an address — what a client other than ours could put on the wire. */
const forge = async (via: Dev, from: AddressKey, to: string, plain: Record<string, unknown>, o: { cert?: string } = {}) => {
  const info = await via.morse!.v3Client!()!.lookupAddress!(to);
  const env = await sealV3({ from, to, prekey: info.prekey!, body: Buffer.from(JSON.stringify(plain)), ...(o.cert ? { cert: o.cert } : {}) });
  return JSON.stringify(env);
};
const message = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ kind: 'message', id, contextId: id, from: { agent: 'claude', sessionId: '' }, to: { agent: 'user', sessionId: '' }, addr: 1, text, ...extra });

describe('first contact by address alone (ADR-081)', () => {
  it('two computers that never met: one message request keyed by the address, held mail, accept, receipts, replies in the thread — nothing is paired', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    // every address is published with `addr1`
    expect((await ann.morse!.v3Client!()!.lookupAddress!(ben.address)).caps).toEqual(['addr1']);

    // ann writes to ben's 26-character address — she knows nothing else about him
    const first = await write(ann, `morse.im/${ben.address}`, 'hello ben');
    expect(first.r).toEqual({ ok: true, via: 'relay', request: true });
    // "writing first = accepting": he is a contact of hers already, by address only
    expect(ann.mailbox.contacts.find(ben.address)).toMatchObject({ id: `a:${ben.address}`, handle: null, address: ben.address, group: 'other', state: 'active' });
    expect(ann.mailbox.getMessage(first.m!.id)).toMatchObject({ to: { device: ben.address }, contactId: `a:${ben.address}`, direction: 'out', request: true });

    // ben: ONE request keyed by her address; nothing in the inbox, nothing an agent could see
    expect(ben.mailbox.requests.list()).toHaveLength(1);
    expect(ben.mailbox.requests.get(ann.address)).toMatchObject({ handle: ann.address, deviceId: ann.address, text: 'hello ben', to: { agent: 'ben-pc', sessionId: 'inbox' }, count: 1 });
    expect(ben.mailbox.requests.get(ann.address)!.fromAgent).toBeUndefined();
    expect(ben.mailbox.inbox({ all: true })).toEqual([]);
    expect(ben.mailbox.todo()).toEqual([]);
    expect(ben.mailbox.foreignWaiting(0)).toEqual([]);
    expect(ben.mailbox.contacts.find(ann.address)).toBeNull();
    expect(formatRequests(ben.mailbox.requests.list())[1]).toMatch(new RegExp(`^  morse\\.im/${ann.address}  \\d{4}-`)); // an address, no "computer"
    expect(ben.logs.some((l) => l.includes(`message request from morse.im/${ann.address}`))).toBe(true);

    // more mail from her is held on HER computer until he accepts (nothing goes out)
    const sends = relay!.v3Sends().sent;
    const held = await write(ann, `morse.im/${ben.address}`, 'are you there?');
    expect(held.r).toEqual({ ok: false, waiting: true, error: `waiting for morse.im/${ben.address} to accept your message request — held here, sent once they accept` });
    expect(relay!.v3Sends().sent).toBe(sends);

    // ben accepts: a contact with only her address, her message in his inbox — and trusted-devices.json untouched
    const ok = await accept(ben, ann.address);
    expect(ok.told).toBe(1);
    expect(ok.contactId).toBe(`a:${ann.address}`);
    expect(ben.mailbox.contacts.get(`a:${ann.address}`)).toMatchObject({ handle: null, address: ann.address, group: 'other', state: 'active', addresses: [ann.address] });
    expect(ben.mailbox.requests.count()).toBe(0);
    expect(got(ben, 'hello ben')).toMatchObject({ from: { agent: 'claude', sessionId: '', device: ann.address }, to: { agent: 'ben-pc', sessionId: 'inbox' }, contactId: `a:${ann.address}`, fromTier: 'peer' });
    expect(trusted(ben)).toEqual([]);
    expect(trusted(ann)).toEqual([]);
    expect(existsSync(join(ben.home, '.morse', 'trusted-devices.json'))).toBe(false);

    // she is told, and what she held goes out by itself
    await until(() => ann.logs.some((l) => /accepted your message request \(they told us\) — sending the 1 message\(s\) held for them/.test(l)));
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    expect(texts(ben)).toEqual(['hello ben', 'are you there?']);
    for (const m of [first.m!, held.m!]) expect(ann.mailbox.getMessage(m.id)).toMatchObject({ status: 'delivered', receiptAt: expect.any(Number) });
    expect(ann.mailbox.getMessage(first.m!.id)!.request).toBeFalsy();
    expect(ann.logs.some((l) => l.includes(`→ morse.im/${ben.address} delivered via relay (v3, peer)`))).toBe(true);

    // ben answers in her thread: it lands in the session that started it (ADR-071), under his contact
    const back = await reply(ben, got(ben, 'hello ben').id, 'hi ann');
    expect(back.r).toEqual({ ok: true, via: 'relay' });
    expect(back.m).toMatchObject({ to: { device: ann.address }, contactId: `a:${ann.address}`, myAgent: 'ben-pc' });
    expect(got(ann, 'hi ann')).toMatchObject({ from: { device: ben.address }, contactId: `a:${ben.address}`, fromTier: 'peer', ownThread: true, to: session, myAgent: 'ann-mbp' });
    // …and her answer to that goes to his agent's mailbox (it is HER thread, not one of his sessions)
    expect((await reply(ann, got(ann, 'hi ann').id, 'good to meet you')).r).toEqual({ ok: true, via: 'relay' });
    expect(got(ben, 'good to meet you')).toMatchObject({ to: { agent: 'ben-pc', sessionId: 'inbox' }, contactId: `a:${ann.address}` });
    expect(got(ben, 'good to meet you').ownThread).toBeFalsy();
    // a thread HE starts from a session: her reply lands in that session
    const q = await write(ben, ann.address, 'one question', { session: { agent: 'codex', sessionId: 'b-9' } });
    expect(q.r).toEqual({ ok: true, via: 'relay' });
    expect(got(ann, 'one question')).toMatchObject({ to: { agent: 'ann-mbp', sessionId: 'inbox' }, contactId: `a:${ben.address}` });
    expect((await reply(ann, got(ann, 'one question').id, 'one answer')).r).toEqual({ ok: true, via: 'relay' });
    expect(got(ben, 'one answer')).toMatchObject({ ownThread: true, to: { agent: 'codex', sessionId: 'b-9' }, contactId: `a:${ann.address}` });

    // every envelope went over the v3 connection, by address; the relay holds nothing readable
    expect(relay!.dump()).not.toMatch(/hello ben|hi ann|one question/);
    expect(relay!.v3Log().every((e) => [ann.address, ben.address].includes(e.from) && [ann.address, ben.address].includes(e.to))).toBe(true);
    // nothing on the wire carried a certificate, a handle or an agent name of the sender
    for (const e of relay!.v3Log()) {
      const o = await open(loadPrimaryAddress(e.to === ann.address ? ann.home : ben.home), e.blob);
      expect(o.cert).toBeUndefined();
      expect(o.from).toBe(e.from);
      const b = bodyOf(o)!;
      expect(b['fromHandle']).toBeUndefined();
      expect(b['fromAgent']).toBeUndefined();
      if (b['kind'] === 'message') expect(b['addr']).toBe(1);
    }
    expect(trusted(ben)).toEqual([]);
    expect(trusted(ann)).toEqual([]);
  });

  it('a second message after the sender restarted is dropped over there (one request per address) and held again; a late "accepted" still releases it', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    const first = await write(ann, ben.address, 'first');
    expect(first.r).toMatchObject({ ok: true, request: true });
    stop(ann); // nothing in memory any more: only the mailbox says a request is pending
    connect(ann);
    await v3Online(ann);
    const more = await write(ann, ben.address, 'second'); // the one probe after a restart
    expect(more.r).toMatchObject({ ok: false, waiting: true, error: expect.stringMatching(/waiting for morse\.im\/.* to accept your message request/) });
    expect(ben.mailbox.requests.get(ann.address)).toMatchObject({ text: 'first', count: 2 });
    expect(ben.logs.some((l) => /dropped another message from morse\.im\/.* — their message request is still waiting/.test(l))).toBe(true);
    expect(ann.mailbox.getMessage(more.m!.id)!.receiptAt).toBeFalsy(); // "dropped" is no receipt
    // the same message again is the request itself (a duplicate), not a second one
    expect(await ann.morse!.send(ben.address, again(ann, first.m!.id))).toMatchObject({ ok: false, waiting: true });

    // ann is away when ben accepts: the notice waits in the relay's mailbox for her
    stop(ann);
    await offline(ann.address);
    expect((await accept(ben, ann.address)).told).toBe(1);
    expect(relay!.mailbox(ann.address)).toHaveLength(1);
    connect(ann);
    await v3Online(ann);
    await until(() => ann.logs.some((l) => /accepted your message request \(they told us\)/.test(l)));
    await until(() => relay!.mailbox(ann.address).length === 0);
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    expect(texts(ben)).toEqual(['first', 'second']);
  });

  it('reject deletes the request (the next message is a new one); block drops their mail; unblock lets it in again', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    connect(ann, { requestProbeMs: 0 }); // (every send is a probe: nothing is held back in this test)
    connect(ben, { requestProbeMs: 0 });
    await v3Online(ann, ben);
    expect((await write(ann, ben.address, 'one')).r).toMatchObject({ ok: true, request: true });
    // reject = delete, not block
    expect(ben.mailbox.requests.remove(ann.address)).toMatchObject({ handle: ann.address });
    expect((await write(ann, ben.address, 'two')).r).toMatchObject({ ok: true, request: true });
    expect(ben.mailbox.requests.get(ann.address)).toMatchObject({ text: 'two', count: 1 });

    // block (what `morse contact block <address>` / the old `requests block` do): request gone, the ADDRESS blocked —
    // (ADR-083) per address of mine, in address_blocks; morse-blocked.json holds old handles only and is not written
    expect(declineRequest(ann.address, { mailbox: ben.mailbox, home: ben.home })).toMatchObject({ ok: true });
    expect(ben.mailbox.contacts.isBlockedAt(ann.address)).toBe(true);
    expect(blockedHandles(ben.home)).toEqual([]);
    const dropped = await write(ann, ben.address, 'three');
    expect(dropped.r).toMatchObject({ ok: false, waiting: true, error: expect.stringMatching(/forwarded but no receipt/) });
    expect(ben.mailbox.requests.count()).toBe(0);
    expect(texts(ben)).toEqual([]);
    expect(ben.logs.some((l) => l.includes(`dropped message from morse.im/${ann.address} — blocked here (to undo: morse contact unblock ${ann.address})`))).toBe(true);
    // a blocked address gets no answer of any kind (not even "dropped")
    expect(relay!.v3Log().filter((e) => e.from === ben.address)).toHaveLength(2); // the two "filed" receipts from before

    // unblock: their next message comes in again, as a request
    expect(ben.mailbox.contacts.unblockAt(ann.address)).toBe(true); // (ADR-083: where a block by address is kept)
    expect((await write(ann, ben.address, 'four')).r).toMatchObject({ ok: true, request: true });
    expect(ben.mailbox.requests.get(ann.address)).toMatchObject({ text: 'four' });

    // and the other way round: ben will not write to an address he blocked — until he says so himself
    ben.mailbox.contacts.blockAt(ann.address); // (ADR-083: where a block by address is kept)
    const m = ben.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ann.address }, text: 'queued before' });
    expect(await deliver(ben, ben.mailbox.claimNextPending({ scope: 'outbound' })!)).toEqual({ ok: false, error: `morse.im/${ann.address} is blocked here — nothing is sent to it (to undo: morse contact unblock ${ann.address})` });
    expect(ben.mailbox.getMessage(m.id)!.receiptAt).toBeFalsy();
    // writing to them through `morse send` is his word: unblocked, the waiting request accepted, a contact
    expect(ben.mailbox.requests.get(ann.address)).toMatchObject({ text: 'four' }); // (her request from before the block is still waiting)
    expect((await write(ben, `morse.im/${ann.address}`, 'I write first now')).r).toEqual({ ok: true, via: 'relay' });
    expect(ben.mailbox.contacts.isBlockedAt(ann.address)).toBe(false);
    expect(blockedHandles(ben.home)).toEqual([]);
    expect(ben.mailbox.requests.count()).toBe(0);
    expect(texts(ben)).toEqual(['four']);
    expect(ben.mailbox.contacts.find(ann.address)).toMatchObject({ id: `a:${ann.address}`, state: 'active' });
  });

  it('morse.strangers: "block" drops a stranger\'s address; "accept" makes it a contact at once (nothing paired); the receive limit counts per address', async () => {
    const [ann, ben, cat] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc'), dev('cat', 'cat-air')];
    await world([ann, ben, cat]);
    let mode: 'request' | 'accept' | 'block' = 'block';
    let limits = { perSenderPerMinute: 0, totalPerMinute: 0 };
    connect(ann, { requestProbeMs: 0, receiptTimeoutMs: 400 });
    connect(cat, { requestProbeMs: 0, receiptTimeoutMs: 400 });
    connect(ben, { strangers: () => mode, receiveLimits: () => limits });
    await v3Online(ann, ben, cat);

    expect((await write(ann, ben.address, 'blocked out')).r).toMatchObject({ ok: false, waiting: true });
    expect(ben.mailbox.requests.count()).toBe(0);
    expect(texts(ben)).toEqual([]);
    expect(ben.logs.some((l) => l.includes(`dropped message from morse.im/${ann.address} — not a contact, and strangers are blocked (morse.strangers: "block"; to accept them: morse contact add morse.im/${ann.address})`))).toBe(true);

    mode = 'accept';
    expect((await write(ann, ben.address, 'let in')).r).toEqual({ ok: true, via: 'relay' });
    expect(texts(ben)).toEqual(['let in']);
    expect(ben.mailbox.contacts.find(ann.address)).toMatchObject({ id: `a:${ann.address}`, group: 'other' });
    expect(got(ben, 'let in')).toMatchObject({ fromTier: 'peer', contactId: `a:${ann.address}`, to: { agent: 'ben-pc', sessionId: 'inbox' } });
    expect(trusted(ben)).toEqual([]);

    // limits: two a minute per sender — by ADDRESS (ann is a contact now, cat a stranger)
    mode = 'request';
    limits = { perSenderPerMinute: 2, totalPerMinute: 0 };
    expect((await write(ann, ben.address, 'a1')).r).toEqual({ ok: true, via: 'relay' });
    expect((await write(ann, ben.address, 'a2')).r).toEqual({ ok: true, via: 'relay' });
    expect((await write(ann, ben.address, 'a3')).r).toMatchObject({ ok: false, waiting: true, error: expect.stringMatching(/no receipt/) });
    expect(ben.logs.some((l) => l.includes(`rate limit — dropping messages from morse.im/${ann.address} (more than 2 a minute`))).toBe(true);
    expect(texts(ben)).toEqual(['let in', 'a1', 'a2']);
    // another address has its own count — strangers included
    expect((await write(cat, ben.address, 'c1')).r).toMatchObject({ ok: true, request: true });
    expect((await write(cat, ben.address, 'c2')).r).toMatchObject({ ok: false, waiting: true, error: expect.stringMatching(/waiting for .* to accept/) }); // "dropped": counted, kept out
    expect((await write(cat, ben.address, 'c3')).r).toMatchObject({ ok: false, waiting: true, error: expect.stringMatching(/no receipt/) });
    expect(ben.mailbox.requests.get(cat.address)).toMatchObject({ text: 'c1', count: 2 });
    // …and a limit on everything together
    limits = { perSenderPerMinute: 0, totalPerMinute: 1 };
    expect((await write(ann, ben.address, 'a4')).r).toMatchObject({ ok: false, waiting: true });
    expect(ben.logs.some((l) => /rate limit — dropping inbound messages \(more than 1 a minute in total/.test(l))).toBe(true);
  });

  it('a request keeps at most 64 KB of text and no attachment — only names and sizes; the files follow once accepted', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    const path = join(ann.home, 'plan.txt');
    writeFileSync(path, 'the plan');
    expect(await ann.morse!.addressRoute!(ben.address)).toEqual({ ok: true, address: ben.address, from: ann.address }); // (ADR-081 review F1: + the address of ours it goes out from)
    ann.morse!.acceptAddress!(ben.address);
    const m = ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ben.address }, text: 'x'.repeat(70 * 1024), files: stageOutboxFiles([path], ann.home) });
    expect(await deliver(ann, ann.mailbox.claimNextPending({ scope: 'outbound' })!)).toEqual({ ok: true, via: 'relay', request: true });
    const req = ben.mailbox.requests.get(ann.address)!;
    expect(req.text.length).toBeLessThan(66 * 1024);
    expect(req.text).toMatch(/\[… cut: a message request keeps at most 64 KB\]$/);
    expect(req).toMatchObject({ droppedFiles: 1, droppedFileList: [{ name: 'plan.txt', size: expect.any(Number) }] });
    expect(existsSync(join(ben.home, '.morse', 'inbox-files'))).toBe(false);
    await accept(ben, ann.address);
    await until(() => ann.logs.some((l) => /sending the files of 1 message\(s\) again/.test(l)));
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    const again = received(ben).find((x) => x.parts[0]!.files?.length)!;
    expect(again.parts[0]!.text).toContain(`[the 1 file(s) of my earlier message ${m.id.slice(0, 8)}`);
    expect(readFileSync(again.parts[0]!.files![0]!.path, 'utf8')).toBe('the plan');
    expect(again).toMatchObject({ contactId: `a:${ann.address}`, from: { device: ann.address } });
  });
});

describe('offline, restarts and receipts by address (ADR-081)', () => {
  /** ann and ben, contacts of each other by address only (each added the other). */
  const friends = async (relayOpts: Parameters<typeof startFakeRelay>[0] = {}) => {
    const [ann, ben] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc')];
    await world([ann, ben], relayOpts);
    ann.mailbox.contacts.ensureAddress(ben.address);
    ben.mailbox.contacts.ensureAddress(ann.address);
    return { ann, ben };
  };

  it('the recipient is away: kept sealed in the relay mailbox, fetched and acked at login — and the receipt is matched after the SENDER restarted too', async () => {
    const { ann, ben } = await friends();
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    stop(ben); // published, now away
    await offline(ben.address);
    const sent = await write(ann, ben.address, 'while you were away');
    expect(sent.r).toEqual({ ok: true, via: 'relay' });
    expect(relay!.mailbox(ben.address)).toHaveLength(1);
    expect(relay!.mailbox(ben.address)[0]).toMatchObject({ from: ann.address, ref: sent.m!.id });
    expect(JSON.stringify(relay!.mailbox(ben.address))).not.toContain('while you were away');
    expect(ann.mailbox.getMessage(sent.m!.id)).toMatchObject({ status: 'delivered' });
    expect(ann.mailbox.getMessage(sent.m!.id)!.receiptAt).toBeFalsy();
    expect(ann.logs.some((l) => l.includes(`→ morse.im/${ben.address} is offline — left in the relay's offline mailbox`))).toBe(true);

    // ann restarts (nothing in memory), then goes away herself; ben comes back and fetches it
    stop(ann);
    await offline(ann.address);
    connect(ben);
    await until(() => texts(ben).includes('while you were away'));
    await until(() => relay!.mailbox(ben.address).length === 0); // acked → deleted
    expect(got(ben, 'while you were away')).toMatchObject({ contactId: `a:${ann.address}`, from: { device: ann.address }, fromTier: 'peer' });
    // his receipt waits for her in the relay mailbox; after her restart it is matched by the message's stored `to`
    await until(() => relay!.mailbox(ann.address).length === 1);
    connect(ann);
    await until(() => Boolean(ann.mailbox.getMessage(sent.m!.id)!.receiptAt));
    expect(ann.logs.some((l) => l.includes(`receipt for ${sent.m!.id.slice(0, 8)} from morse.im/${ben.address}`))).toBe(true);
    // a restart of the RECIPIENT in between: a duplicate is not filed twice, its receipt comes again
    stop(ben);
    connect(ben);
    await v3Online(ann, ben);
    expect(await ann.morse!.send(ben.address, again(ann, sent.m!.id))).toEqual({ ok: true, via: 'relay' });
    expect(texts(ben)).toEqual(['while you were away']);
  });

  it('a receipt counts only from the address the message went to; "accepted" and receipts from anyone else change nothing', async () => {
    const { ann, ben } = await friends();
    const eve = dev('eve', 'eve-x');
    relay!.allow({ id: eve.id, handle: 'eve' });
    connect(ann);
    connect(ben);
    connect(eve);
    await v3Online(ann, ben, eve);
    stop(ben);
    await offline(ben.address);
    const sent = await write(ann, ben.address, 'for ben only');
    expect(sent.r).toEqual({ ok: true, via: 'relay' });
    // eve (an address ann never wrote to) claims she received it — and that she accepted ann
    const eveKey = loadPrimaryAddress(eve.home);
    const raw = eve.morse!.v3Client!()!;
    await raw.sendV3!(ann.address, await forge(eve, eveKey, ann.address, { kind: 'receipt', id: sent.m!.id }));
    await raw.sendV3!(ann.address, await forge(eve, eveKey, ann.address, { kind: 'accepted' }));
    await raw.sendV3!(ann.address, await forge(eve, eveKey, ann.address, { kind: 'rekey', ref: sent.m!.id }));
    await sleep(300);
    expect(ann.mailbox.getMessage(sent.m!.id)).toMatchObject({ status: 'delivered' });
    expect(ann.mailbox.getMessage(sent.m!.id)!.receiptAt).toBeFalsy();
    // also when ann IS a contact of eve's address (a contact may not confirm someone else's mail either)
    ann.mailbox.contacts.ensureAddress(eve.address);
    await raw.sendV3!(ann.address, await forge(eve, eveKey, ann.address, { kind: 'receipt', id: sent.m!.id }));
    await raw.sendV3!(ann.address, await forge(eve, eveKey, ann.address, { kind: 'rekey', ref: sent.m!.id }));
    await sleep(300);
    expect(ann.mailbox.getMessage(sent.m!.id)).toMatchObject({ status: 'delivered' });
    expect(ann.mailbox.getMessage(sent.m!.id)!.receiptAt).toBeFalsy();
    connect(ben);
    await until(() => Boolean(ann.mailbox.getMessage(sent.m!.id)!.receiptAt));
  });

  it('rekey by address: an envelope sealed to a prekey that is gone is asked for again, natively, and resent', async () => {
    const { ann, ben } = await friends();
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    stop(ben);
    await offline(ben.address);
    const sent = await write(ann, ben.address, 'sealed to the old prekey');
    expect(sent.r).toEqual({ ok: true, via: 'relay' });
    rmSync(join(loadPrimaryAddress(ben.home).dir, 'prekeys'), { recursive: true, force: true });
    connect(ben);
    await until(() => ann.mailbox.getMessage(sent.m!.id)!.status === 'failed');
    expect(ben.logs.some((l) => /prekey we no longer have/.test(l))).toBe(true);
    // the notice came by address: no certificate, signed by ben's address
    const notice = relay!.v3Log().filter((e) => e.from === ben.address && e.to === ann.address).pop()!;
    const o = await open(loadPrimaryAddress(ann.home), notice.blob);
    expect(o.cert).toBeUndefined();
    expect(bodyOf(o)).toEqual({ kind: 'rekey', ref: sent.m!.id });
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }]);
    expect(texts(ben)).toEqual(['sealed to the old prekey']);
  });

  it('a file too big for one envelope goes in chunks by address, every chunk and every acknowledgement a native envelope', async () => {
    const { ann, ben } = await friends({ maxBlobBytes: 64 * 1024 });
    const tuning = { chunkRatePerMinute: 100_000, rateBackoffMs: 50, transferTuning: { ackIdleMs: 400, completeWaitMs: 3000, maxIdleRounds: 3 } };
    connect(ann, tuning);
    connect(ben, tuning);
    await v3Online(ann, ben);
    const path = join(ann.home, 'big.bin');
    const data = randomBytes(400 * 1024);
    writeFileSync(path, data);
    const m = ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ben.address }, text: 'the big one', files: stageOutboxFiles([path], ann.home) });
    expect(await ann.morse!.send(ben.address, m)).toMatchObject({ ok: false, waiting: true, error: expect.stringMatching(/sending to morse\.im\/.* — 1 file\(s\)/) });
    await until(() => ann.morse!.transfer(m.id)?.state === 'done', 20_000);
    expect(await ann.morse!.send(ben.address, ann.mailbox.getMessage(m.id)!)).toEqual({ ok: true, via: 'relay' });
    expect(ann.mailbox.getMessage(m.id)!.receiptAt).toBeTypeOf('number');
    const filed = received(ben);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ contactId: `a:${ann.address}`, from: { device: ann.address }, fromTier: 'peer' });
    expect(readFileSync(filed[0]!.parts[0]!.files![0]!.path).equals(data)).toBe(true);
    expect(relay!.v3Log().length).toBeGreaterThan(10);
    for (const e of relay!.v3Log()) expect((await open(loadPrimaryAddress(e.to === ann.address ? ann.home : ben.home), e.blob)).cert).toBeUndefined();
    // chunks are never kept for an offline address (they would not fit the mailbox's purpose): the sender holds them
    expect(relay!.v3Sends().stored).toBe(0);
  }, 30_000);
});

describe('who cannot be reached by address alone (ADR-081 §2)', () => {
  it('a peer on the release before (no `addr1`): the one-line error, nothing sent, no contact made — and that peer drops what has no certificate', async () => {
    const [ann, old] = [dev('ann', 'ann-mbp'), dev('old', 'old-pc')];
    await world([ann, old]);
    connect(ann);
    connect(old, { caps: [] }); // the release before: v3 envelopes, but only with a device certificate
    await v3Online(ann, old);
    expect((await ann.morse!.v3Client!()!.lookupAddress!(old.address)).caps).toEqual([]);
    const before = relay!.v3Sends();
    expect(await write(ann, `morse.im/${old.address}`, 'hello?')).toEqual({ refused: TOO_OLD(old.address) });
    expect(ann.mailbox.inbox({ all: true })).toEqual([]);
    expect(ann.mailbox.contacts.find(old.address)).toBeNull();
    // also for a message that was queued some other way (e.g. a reply): refused by the transport, not sent
    const m = ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: old.address }, text: 'queued' });
    expect(await deliver(ann, ann.mailbox.claimNextPending({ scope: 'outbound' })!)).toEqual({ ok: false, error: TOO_OLD(old.address) });
    expect(ann.mailbox.getMessage(m.id)!.receiptAt).toBeFalsy();
    expect(relay!.v3Sends()).toEqual(before);

    // what the old client does with an envelope that has no certificate (why we do not even try): drops it
    const annKey = loadPrimaryAddress(ann.home);
    await ann.morse!.v3Client!()!.sendV3!(old.address, await forge(ann, annKey, old.address, message('m-old', 'no certificate')));
    await until(() => old.logs.some((l) => /dropped v3 envelope from .* — it carries no device certificate/.test(l)));
    expect(old.mailbox.requests.count()).toBe(0);
    expect(old.mailbox.inbox({ all: true })).toEqual([]);
    // and it never sends by address itself: an address it has no paired device for is "no paired device", as before
    expect(await old.morse!.addressRoute!(ann.address)).toBeNull();
    const back = old.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ann.address }, text: 'from the old one' });
    // (ADR-091: this stand-in for the release before runs this code, with no v2 side — the line is this code's)
    expect(await old.morse!.send(ann.address, back)).toEqual({ ok: false, terminal: true, error: `${ann.address}: old names no longer work — ask for their 26-character address (morse address shows it)` });

    // once that computer updates (it publishes addr1 at its next login) the same address works — after the lookup is looked at again
    stop(old);
    connect(old);
    await v3Online(old);
    stop(ann);
    connect(ann); // (a fresh daemon: no cached lookup)
    await v3Online(ann);
    // (no request: `old` wrote to her address above, and whoever you write to is a contact)
    expect(old.mailbox.contacts.find(ann.address)).toMatchObject({ id: `a:${ann.address}` });
    expect((await write(ann, old.address, 'hello again')).r).toEqual({ ok: true, via: 'relay' });
    expect(texts(old)).toEqual(['hello again']);
  });

  it('a relay that does not know caps: every address reads as too old; a relay without v3: cannot deliver by address', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc')];
    await world([ann, ben], { caps: false });
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    expect((await ann.morse!.v3Client!()!.lookupAddress!(ben.address)).caps).toEqual([]);
    expect(await write(ann, ben.address, 'hi')).toEqual({ refused: TOO_OLD(ben.address) });
    expect(relay!.v3Sends()).toEqual({ sent: 0, stored: 0, offline: 0 });
    running.splice(0).forEach((m) => m.stop());
    await relay!.close();

    // (ADR-091) a relay without v3: the connection by address never comes up — what is written waits (nothing is refused
    // for it: the v3 connection does not depend on what a v2 login announced)
    await world([ann, ben], { v3: false });
    connect(ann, { connectWaitMs: 200 });
    await sleep(300);
    expect(await ann.morse!.addressRoute!(ben.address)).toMatchObject({ ok: false, waiting: true });
  });

  it('an address nobody published; a relay that answers with a key that is not that address\'s, or a prekey it did not sign: refused', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    connect(ann, { v3LookupTtlMs: 0 });
    connect(ben);
    await v3Online(ann, ben);
    const nobody = addressFromPublicKey(rawPublicKey(generateKeyPairSync('ed25519').publicKey));
    expect(await write(ann, `morse.im/${nobody}`, 'anyone?')).toEqual({ refused: `nobody has published ${nobody} yet` });
    expect(ann.mailbox.contacts.find(nobody)).toBeNull();
    expect(ann.mailbox.inbox({ all: true })).toEqual([]);

    // the relay hands out SOMEONE ELSE's key for ben's address (with that someone's validly signed prekey)
    const mallory = loadPrimaryAddress(freshHome());
    const lookups = new Map<string, number>();
    const lie = async (patch: Parameters<FakeRelay['tamper']>[1]) => {
      relay!.tamper(ben.address, patch);
      // (cached answers are kept for a minute; this daemon is new each time)
      stop(ann);
      connect(ann);
      await v3Online(ann);
      lookups.set(JSON.stringify(Object.keys(patch)), 1);
      return write(ann, ben.address, 'for ben');
    };
    const sends = relay!.v3Sends();
    const refused = { refused: `${ben.address}: what the relay returned for this address does not verify (the key is not this address's, or did not sign its prekey) — not sent` };
    expect(await lie({ key: mallory.publicKey.toString('base64') })).toEqual(refused);
    // back to ben's real key, but no prekey at all
    expect(await lie({ key: loadPrimaryAddress(ben.home).publicKey.toString('base64'), prekey: null })).toEqual(refused);
    expect(relay!.v3Sends()).toEqual(sends);
    expect(texts(ben)).toEqual([]);
    expect(ben.mailbox.requests.count()).toBe(0);
    // caps stripped by the relay: too old (nothing can make an address look newer than its key holder said — only older)
    stop(ben);
    connect(ben);
    await v3Online(ben);
    expect(await lie({ caps: [] })).toEqual({ refused: TOO_OLD(ben.address) });
    expect(lookups.size).toBe(3);
  });

  it('one of this computer\'s own addresses is not a correspondent: refused to send, dropped when received', async () => {
    const ann = dev('ann', 'ann-mbp', ['codex']);
    await world([ann]);
    const codex = second(ann, 'codex');
    connect(ann);
    await v3Online(ann);
    await until(() => relay!.onlineAddresses().includes(codex.address));
    expect(await write(ann, codex.address, 'to myself')).toEqual({ refused: `${codex.address} is one of your addresses here — to write to a session here use a session target (@<agent>:<session>)` });
    expect(await write(ann, ann.address, 'to myself', { from: 'codex' })).toEqual({ refused: `${ann.address} is one of your addresses here — to write to a session here use a session target (@<agent>:<session>)` });
    await ann.morse!.v3Client!()!.sendV3!(ann.address, await forge(ann, codex, ann.address, message('m-self', 'from my own codex')), { from: codex.address });
    await until(() => ann.logs.some((l) => /that is an address of this computer/.test(l)));
    expect(ann.mailbox.requests.count()).toBe(0);
    expect(ann.mailbox.inbox({ all: true })).toEqual([]);
  });
});

// (ADR-091) "a computer migrated from the release before (ADR-081 §7)" is gone: its premise — a contact by old name keeps
// the device path, a computer paired as your own is the owner — is what stage 1 of removing v2 changes. What replaces it:
// test/migrate-v5.test.ts (the upgrade of a home the released code wrote), test/morse-remove-v2.test.ts (every contact by
// its address, no owner, the old way still received) and test/released-interop.test.ts (both ways with the released code).

describe('every address of this computer can send (ADR-081 §6)', () => {
  it('from a second address: the other side sees only that address; replies come back to it and go out from it; the first address appears nowhere', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp', ['codex']), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    const codex = second(ann, 'codex');
    expect(codex.address).not.toBe(ann.address);
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    await until(() => relay!.onlineAddresses().includes(codex.address));
    expect((await ben.morse!.v3Client!()!.lookupAddress!(codex.address)).caps).toEqual(['addr1']);

    // morse send morse.im/<ben> "…" --from codex
    const hi = await write(ann, `morse.im/${ben.address}`, 'from my codex', { from: 'codex' });
    expect(hi.r).toEqual({ ok: true, via: 'relay', request: true });
    expect(hi.m).toMatchObject({ myAgent: 'codex', to: { device: ben.address } });
    // ben: a request from the SECOND address; her first address, handle and computer are unknown to him
    expect(ben.mailbox.requests.list().map((r) => r.handle)).toEqual([codex.address]);
    await accept(ben, codex.address);
    expect(got(ben, 'from my codex')).toMatchObject({ contactId: `a:${codex.address}`, from: { device: codex.address } });
    expect(ben.mailbox.contacts.find(ann.address)).toBeNull();
    // his reply goes to the second address and lands in THAT address's inbox (ADR-071 still finds the session)
    // (ADR-083) on her side he is a contact OF `codex` — a new row of another address of mine is `a:<theirs>~<mine>`
    const atCodex = `a:${ben.address}~${codex.address}`;
    expect(ann.mailbox.contacts.findAll(ben.address).map((c) => [c.id, c.myAddress])).toEqual([[atCodex, codex.address]]);
    expect((await reply(ben, got(ben, 'from my codex').id, 'hello codex')).r).toEqual({ ok: true, via: 'relay' });
    expect(got(ann, 'hello codex')).toMatchObject({ contactId: atCodex, myAgent: 'codex', ownThread: true, to: session, from: { device: ben.address } });
    // a new thread from him to that address: the codex inbox
    expect((await write(ben, codex.address, 'a new thread for codex')).r).toEqual({ ok: true, via: 'relay' });
    expect(got(ann, 'a new thread for codex')).toMatchObject({ to: { agent: 'codex', sessionId: 'inbox' }, myAgent: 'codex', contactId: atCodex });
    // her `morse reply` goes out FROM the address it was written to — also after her daemon restarted
    stop(ann);
    connect(ann);
    await v3Online(ann);
    await until(() => relay!.onlineAddresses().includes(codex.address));
    const answer = await reply(ann, got(ann, 'a new thread for codex').id, 'codex answering');
    expect(answer.r).toEqual({ ok: true, via: 'relay' });
    expect(answer.m).toMatchObject({ myAgent: 'codex', to: { device: ben.address } });
    expect(got(ben, 'codex answering')).toMatchObject({ contactId: `a:${codex.address}`, from: { device: codex.address }, ownThread: true });
    expect(ann.mailbox.getMessage(answer.m.id)!.receiptAt).toBeTypeOf('number');

    // the wire: the relay never saw her first address in this exchange, and nothing ben could open names it,
    // her handle, her computer, or carries a certificate
    const log = relay!.v3Log();
    expect(log.length).toBeGreaterThanOrEqual(8);
    expect(log.some((e) => e.from === ann.address || e.to === ann.address)).toBe(false);
    for (const e of log) {
      const o = await open(e.to === ben.address ? loadPrimaryAddress(ben.home) : codex, e.blob);
      expect(o.cert).toBeUndefined();
      expect([codex.address, ben.address]).toContain(o.from);
      const text = JSON.stringify(bodyOf(o));
      for (const secret of [ann.address, ann.id, '"ann"', 'ann-mbp', 'fromHandle', 'fromAgent']) expect(text).not.toContain(secret);
    }
    // on his side there is one contact, by the second address; nothing of hers is paired
    expect(ben.mailbox.contacts.list().filter((c) => c.id !== 'self').map((c) => c.id)).toEqual([`a:${codex.address}`]);
    expect(trusted(ben)).toEqual([]);

    // (ADR-081 review N2) ben knows her as `codex`: a plain send to him (no --from) goes out from THAT address — not the first
    // (ADR-083: he is the contact of `codex`, the row says so)
    expect(ann.mailbox.contacts.knownAs(atCodex)).toBe(codex.address);
    const plain = await write(ann, ben.address, 'no --from');
    expect(plain.r).toEqual({ ok: true, via: 'relay' });
    expect(plain.m).toMatchObject({ myAddress: codex.address });
    expect(got(ben, 'no --from')).toMatchObject({ contactId: `a:${codex.address}`, from: { device: codex.address } });
    expect(relay!.v3Log().some((e) => e.from === ann.address || e.to === ann.address)).toBe(false);
    // the same person written to from her FIRST address — named for this one message — is someone else to him: a request of its own
    expect((await write(ann, ben.address, 'from my first address', { from: 'ann-mbp' })).r).toEqual({ ok: true, via: 'relay', request: true });
    expect(ben.mailbox.requests.list().map((r) => r.handle)).toEqual([ann.address]);
    // …and that did not change the contact of `codex`: (ADR-083) he is a contact of her first address too now — a separate one
    expect(ann.mailbox.contacts.knownAs(atCodex)).toBe(codex.address);
    expect(ann.mailbox.contacts.findAll(ben.address).map((c) => [c.id, c.myAddress])).toEqual([[`a:${ben.address}`, ''], [atCodex, codex.address]]);
    expect(ann.mailbox.history(`a:${ben.address}`).map((m) => m.parts[0]!.text)).toEqual(['from my first address']);
  }, 30_000);

  // (ADR-091, stage 2) removed: "from a second address a peer without `addr1` cannot be reached at all…" — its premise (the old way: an old name, a device path) is gone.

  it('a name that is not an address online here never falls back to another address: added but not restarted → wait; gone → refused', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp', ['codex']), dev('ben', 'ben-pc')];
    await world([ann, ben]);
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    // an address added while the daemon runs (morse address add helper): on disk, not logged in yet
    updateMachineConfig((cfg) => {
      (cfg['relay'] as { agents: string[] }).agents.push('helper');
    }, join(ann.home, '.morse', 'config.json'));
    ensureAgentAddresses(ann.home);
    const waiting = { ok: false, waiting: true, error: 'your address "helper" is not online in this daemon yet — restart it: morse stop --restart' };
    expect(await ann.morse!.addressRoute!(ben.address, 'helper')).toEqual(waiting);
    expect(await ann.morse!.addressRoute!('morse.im/ben', 'helper')).toEqual(waiting); // not the old path under the first address either
    // (ADR-081 review: legacy rows) the daemon records the ADDRESS the name stands for when it queues — also one it has not loaded yet
    expect(ann.morse!.ownAddress!('helper')).toEqual({ address: agentAddressIndex(ann.home)['helper'], name: 'helper' });
    const m = ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ben.address }, text: 'from helper', myAgent: 'helper', myAddress: agentAddressIndex(ann.home)['helper']! });
    expect(await deliver(ann, ann.mailbox.claimNextPending({ scope: 'outbound' })!)).toEqual(waiting);
    expect(relay!.v3Log()).toEqual([]);
    // a row with only a name (no writer of this release makes one — hand-made): refused, never resolved by that name
    expect(() => ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ben.address }, text: 'a name only', myAgent: 'ghost' })).toThrow('a sending address was named ("ghost") without the address itself — nothing queued');
    const gone = nameOnly(ann, ben.address, 'from nobody', 'ghost');
    expect(await ann.morse!.send(ben.address, gone)).toEqual({ ok: false, error: 'this message was queued from your address "ghost", which is no longer here under that name — send it again (morse send --from <name>; morse address lists them)' });
    expect(relay!.v3Log()).toEqual([]);
    // after the restart the new address is online and the held message goes out from IT
    stop(ann);
    connect(ann);
    await v3Online(ann);
    const helper = second(ann, 'helper');
    await until(() => relay!.onlineAddresses().includes(helper.address));
    expect(await ann.morse!.send(ben.address, ann.mailbox.getMessage(m.id)!)).toEqual({ ok: true, via: 'relay', request: true });
    expect(ben.mailbox.requests.list().map((r) => r.handle)).toEqual([helper.address]);
  });
});

describe('the daemon\'s send endpoint (ADR-081)', () => {
  const freePort = () =>
    new Promise<number>((done, fail) => {
      const s = createServer();
      s.once('error', fail);
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });

  it('POST /api/send to a bare address: contact + queued; too old / unpublished: 422 with the one line and nothing queued; --from <name> is recorded', async () => {
    const [ann, ben, old] = [dev('ann', 'ann-mbp', ['codex']), dev('ben', 'ben-pc'), dev('old', 'old-pc')];
    await world([ann, ben, old]);
    const codex = second(ann, 'codex');
    connect(ann);
    connect(ben);
    connect(old, { caps: [] });
    await v3Online(ann, ben, old);
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
    });
    closers.push(() => server.close());
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { error?: string; message?: Message; resolvedTarget?: { device?: string; agent: string } } };
    };
    const ok = await post({ target: `morse.im/${ben.address.toUpperCase()}`, text: 'via the daemon' });
    expect(ok.status).toBe(201);
    expect(ok.body.resolvedTarget).toMatchObject({ device: ben.address, agent: INBOX_AGENT });
    expect(ok.body.message).toMatchObject({ to: { device: ben.address }, contactId: `a:${ben.address}`, direction: 'out' });
    expect(ann.mailbox.contacts.find(ben.address)).toMatchObject({ id: `a:${ben.address}` });
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay', request: true }]);
    expect(ben.mailbox.requests.get(ann.address)).toMatchObject({ text: 'via the daemon' });
    // a bare address without morse.im/ in front, from another address of this computer
    const from = await post({ target: ben.address, text: 'via the daemon, from codex', fromAddress: 'codex' });
    expect(from.status).toBe(201);
    expect(from.body.message).toMatchObject({ myAgent: 'codex', to: { device: ben.address } });
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay', request: true }]);
    expect(ben.mailbox.requests.list().map((r) => r.handle).sort()).toEqual([ann.address, codex.address].sort());

    const queued = ann.mailbox.inbox({ all: true }).length;
    const tooOld = await post({ target: `morse.im/${old.address}`, text: 'hello?' });
    expect(tooOld).toEqual({ status: 422, body: { error: TOO_OLD(old.address) } });
    const nobody = addressFromPublicKey(rawPublicKey(generateKeyPairSync('ed25519').publicKey));
    expect(await post({ target: nobody, text: 'hello?' })).toEqual({ status: 422, body: { error: `nobody has published ${nobody} yet` } });
    expect(ann.mailbox.inbox({ all: true })).toHaveLength(queued);
    expect(ann.mailbox.contacts.find(old.address)).toBeNull();
    expect(ann.mailbox.contacts.find(nobody)).toBeNull();
  });
});

describe('contacts, requests and messages by address in the store (ADR-081 §4)', () => {
  it('ensureAddress: the contact of an address, made once; classification by the address on a message; no schema change', () => {
    const ann = dev('ann', 'ann-mbp');
    const [x, y] = [loadPrimaryAddress(freshHome()).address, loadPrimaryAddress(freshHome()).address];
    const c = ann.mailbox.contacts.ensureAddress(`morse.im/${x.toUpperCase()}`);
    expect(c).toMatchObject({ id: `a:${x}`, handle: null, agent: null, address: x, addresses: [x], group: 'other', state: 'active', split: 'done', origin: null });
    expect(ann.mailbox.contacts.ensureAddress(x).id).toBe(c.id);
    expect(() => ann.mailbox.contacts.ensureAddress('k7f3a9xq')).toThrow(/is not an address/);
    expect(ann.mailbox.contacts.pendingSplits()).toEqual([]); // nothing to ask the relay about
    // an address that already is someone's computer stays theirs
    const kai = ann.mailbox.contacts.ensure('kai');
    ann.mailbox.contacts.seenAddress(kai.id, y, 'DEV-KAI');
    expect(ann.mailbox.contacts.ensureAddress(y).id).toBe('c:kai');
    // outbound to a bare address: that contact; inbound from one: that contact, always a peer; an unknown one is made
    expect(ann.mailbox.send({ from: session, to: { agent: 'user', sessionId: '', device: x }, text: 'out' })).toMatchObject({ direction: 'out', contactId: `a:${x}`, myAgent: 'ann-mbp' });
    expect(ann.mailbox.send({ from: { agent: 'claude', sessionId: '', device: x }, to: { agent: 'ann-mbp', sessionId: 'inbox' }, text: 'in' })).toMatchObject({ direction: 'in', contactId: `a:${x}`, fromTier: 'peer', myAgent: 'ann-mbp' });
    const z = loadPrimaryAddress(freshHome()).address;
    expect(ann.mailbox.send({ from: session, to: { agent: 'user', sessionId: '', device: z }, text: 'out, new' }).contactId).toBe(`a:${z}`);
    expect(ann.mailbox.contacts.list().map((k) => k.id)).not.toContain(`c:${z}`);
    expect(ann.mailbox.history(`a:${x}`).map((m) => m.parts[0]!.text)).toEqual(['out', 'in']);
    expect(ann.mailbox.hasInboundFrom(x)).toBe(true);
    expect(ann.mailbox.hasInboundFrom(z)).toBe(false);
    // removed, then written to again: a contact again (your word), and the tombstone is gone
    ann.mailbox.contacts.remove(`a:${x}`);
    expect(ann.mailbox.contacts.find(x)).toBeNull();
    expect(ann.mailbox.contacts.mark(`removed:${x}`)).toBeTruthy();
    expect(ann.mailbox.contacts.restore(x)).toBeNull(); // (restore is for split contacts and own computers)
    expect(ann.mailbox.contacts.ensureAddress(x)).toMatchObject({ id: `a:${x}`, group: 'other' });
    expect(ann.mailbox.contacts.mark(`removed:${x}`)).toBeNull();
    // blocked by address: (ADR-083) the state follows address_blocks — the block of (my address, theirs); a handle's
    // still follows morse-blocked.json, where an address is no longer looked for
    ann.mailbox.contacts.blockAt(x);
    expect(ann.mailbox.contacts.get(`a:${x}`)!.state).toBe('blocked');
    expect(blockedHandles(ann.home)).toEqual([]);
    expect(ann.mailbox.contacts.unblockAt(x)).toBe(true);
    expect(ann.mailbox.contacts.get(`a:${x}`)!.state).toBe('active');
    blockHandle('kai', ann.home);
    expect(ann.mailbox.contacts.get('c:kai')!.state).toBe('blocked');
    unblockHandle('kai', ann.home);
    expect(ann.mailbox.contacts.get('c:kai')!.state).toBe('active');
  });

  it('acceptRequest by address: the address-only contact, no trust entry, the bare address as sender; a handle request is accepted as before', () => {
    const ann = dev('ann', 'ann-mbp');
    const x = loadPrimaryAddress(freshHome()).address;
    const trust = createTrustStore(ann.home);
    // (ADR-081 review F3: `toAddress` — the address of ours it was written to — is what marks a request as having arrived by address)
    ann.mailbox.requests.file({ handle: x, deviceId: x, msgId: 'r-1', contextId: 'ctx-1', from: { agent: 'claude', sessionId: '' }, to: { agent: 'ann-mbp', sessionId: 'inbox' }, toAddress: ann.address, text: 'by address', droppedFiles: 2, via: 'morse-relay' });
    ann.mailbox.requests.file({ handle: 'bob', deviceId: 'DEV-BOB', msgId: 'r-2', from: { agent: 'claude', sessionId: '' }, fromAgent: 'mbp', to: { agent: 'ann-mbp', sessionId: 'inbox' }, text: 'by handle', droppedFiles: 0, via: 'morse-relay' });
    ann.mailbox.contacts.blockAt(x); // (ADR-083: a block by address is kept per address of mine, in address_blocks)
    const r = acceptRequest(`morse.im/${x}`, { mailbox: ann.mailbox, trust, home: ann.home });
    expect(r).toMatchObject({ ok: true, contactId: `a:${x}`, device: { id: x, name: x, tier: 'peer' } });
    if (!r.ok) throw new Error('unreachable');
    expect(r.message).toMatchObject({ from: { device: x }, contactId: `a:${x}`, fromTier: 'peer', contextId: 'ctx-1' });
    expect(r.message.parts[0]!.text).toMatch(/^by address\n\n\[2 attachment\(s\) not kept while this was a message request/);
    expect(trust.list()).toEqual([]);
    expect(ann.mailbox.contacts.isBlockedAt(x)).toBe(false); // accepting lifts the block
    expect(blockedHandles(ann.home)).toEqual([]);
    expect(ann.mailbox.hasSeen(x, 'r-1')).toBe(true);
    expect(ann.mailbox.requests.get(x)).toBeUndefined();
    const old = acceptRequest('bob', { mailbox: ann.mailbox, trust, home: ann.home });
    expect(old).toMatchObject({ ok: true, contactId: 'c:bob', device: { id: 'DEV-BOB', name: 'bob', tier: 'peer' } });
    expect(trust.list().map((d) => d.id)).toEqual(['DEV-BOB']);
    expect(acceptRequest(x, { mailbox: ann.mailbox, trust, home: ann.home })).toEqual({ ok: false, error: `no message request from morse.im/${x} (morse contact lists them)` });
  });
});
