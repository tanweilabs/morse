import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { agentRequest } from '../src/cluster/agents.js';
import { encodeChunk } from '../src/cluster/chunks.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { lookupHandle, parseMorseAddress, stageOutboxFiles, startMorse, trustHandleDevices, INBOX_AGENT, type Morse, type MorseSendResult } from '../src/cluster/morse.js';
import { saveRelayMembership } from '../src/cluster/join.js';
import { acceptRequest, formatRequests } from '../src/cluster/requests.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { printTodo } from '../src/commands/messaging.js';
import { startConsoleServer } from '../src/daemon/server.js';
import { addressesDir, loadPrimaryAddress, type AddressKey } from '../src/identity/address-key.js';
import { ensureAgentAddresses, renameAgentAddress } from '../src/identity/agent-addresses.js';
import { openV3, sealV3, type OpenedV3 } from '../src/identity/envelope.js';
import { ensurePrekeys } from '../src/identity/prekeys.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { convertKnownHandles } from '../src/mailbox/migrate-v5.js';
import { createDb, type Db } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox, type Message } from '../src/mailbox/mailbox.js';
import { authedFetch as fetch, TEST_TOKEN } from './helpers/local-api.js';

/**
 * Review findings on ADR-081, against the in-memory fake relay:
 *
 *  F1  which of MY addresses a message, a request or an answer belongs to is kept as the ADDRESS (not
 *      its local name) and every signature on the by-address path comes from one resolver that fails
 *      closed: an address this daemon does not hold right now signs nothing — never the first address
 *      instead, never the old handle + certificate path.
 *  F2  an answer (receipt, rekey, chunk acknowledgement) counts only for the address PAIR it belongs to.
 *  F3  an old handle never has the shape of an address: a relay that lists a device under one cannot
 *      put mail into an address-only contact's thread.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-bind-'));
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
/**
 * (ADR-081 review: legacy rows) A hand-made outbound row with NO sending address, only a local name — what no writer of
 * this release produces (the mailbox refuses to queue one): made by SQL, on a row queued normally.
 */
const nameOnly = (d: Dev, to: string, text: string, name: string): Message => {
  const m = d.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: to }, text });
  d.db.prepare('UPDATE messages SET my_address = NULL, agent = ? WHERE id = ?').run(name, m.id);
  return d.mailbox.getMessage(m.id)!;
};
const second = (d: Dev, name: string): AddressKey => ensureAgentAddresses(d.home).find((a) => a.agent === name)!.key;
/** `morse address remove <name>` as this computer sees it: the name leaves the config; its key directory stays. */
const removeAddress = (d: Dev, name: string) =>
  updateMachineConfig((cfg) => {
    const r = cfg['relay'] as { agents: string[] };
    r.agents = r.agents.filter((a) => a !== name);
  }, configOf(d));
/** `morse address rename <from> <to>`: the same address under another local name. */
const renameAddress = (d: Dev, from: string, to: string) => {
  updateMachineConfig((cfg) => {
    const r = cfg['relay'] as { agent: string; agents: string[] };
    r.agents = r.agents.map((a) => (a === from ? to : a));
    if (r.agent === from) r.agent = to;
  }, configOf(d));
  renameAgentAddress(from, to, d.home);
};

let relay: FakeRelay | null = null;
const running: Morse[] = [];
afterEach(async () => {
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
const restart = async (d: Dev) => {
  stop(d);
  connect(d);
  await v3Online(d);
};
const v3Online = (...ds: Dev[]) => until(() => ds.every((d) => Boolean(d.morse!.v3Client?.()?.connected())));
const online = (address: string) => until(() => relay!.onlineAddresses().includes(address));
const offline = (address: string) => until(() => !relay!.onlineAddresses().includes(address));
const world = async (devs: Dev[], relayOpts: Parameters<typeof startFakeRelay>[0] = {}) => {
  relay = await startFakeRelay({ port: 0, host: '127.0.0.1', v3: true, allowlist: devs.map((d) => ({ id: d.id, handle: d.handle })), log: () => undefined, ...relayOpts });
  for (const d of devs) await agentRequest({ url: url(), op: 'add', agent: d.agent, home: d.home });
};

const session = { agent: 'claude', sessionId: 's-1' };
const deliver = async (d: Dev, c: Message): Promise<MorseSendResult> => {
  const r = await d.morse!.send(c.to.device!, c);
  if (r.ok) d.mailbox.markDelivered(c.id);
  else d.mailbox.markFailed(c.id, r.error ?? 'failed', r.waiting ? { waiting: true } : undefined);
  return r;
};
const next = (d: Dev) => deliver(d, d.mailbox.claimNextPending({ scope: 'outbound' })!);
const flush = async (d: Dev): Promise<MorseSendResult[]> => {
  const out: MorseSendResult[] = [];
  for (let c = d.mailbox.claimNextPending({ scope: 'outbound' }); c; c = d.mailbox.claimNextPending({ scope: 'outbound' })) out.push(await deliver(d, c));
  return out;
};
/** `morse send <target> "…" [--from <name>]` as the daemon queues it (src/daemon/server.ts) — not sent yet. */
const queue = async (from: Dev, target: string, text: string, o: { from?: string } = {}) => {
  const route = await from.morse!.addressRoute!(target, o.from ?? null);
  if (route && !route.ok && !route.waiting) throw new Error(route.error);
  const bare = /^(?:morse\.im\/)?([23456789abcdefghjkmnpqrstvwxyz]{26})$/i.exec(target)?.[1]?.toLowerCase();
  // (ADR-081 review: legacy rows) --from <name> is recorded as the ADDRESS it stands for, when it is queued — also while the relay is away
  const own = o.from ? from.morse!.ownAddress!(o.from) : null;
  const mine = own?.address ?? (route && route.ok ? (route as { from?: string }).from : undefined);
  // (ADR-083) writing to an address makes it a contact OF the address of mine that writes
  if (route && bare) from.morse!.acceptAddress!(bare, mine ?? null);
  return from.mailbox.send({
    from: session,
    to: { agent: INBOX_AGENT, sessionId: '', device: route && bare ? bare : target.replace(/^morse\.im\//, '') },
    text,
    via: 'cli',
    ...(own ? { myAgent: own.name ?? o.from! } : {}),
    ...(mine ? { myAddress: mine } : {}),
  });
};
const write = async (from: Dev, target: string, text: string, o: { from?: string } = {}) => {
  const m = await queue(from, target, text, o);
  return { m, r: await next(from) };
};
const accept = async (d: Dev, address: string) => {
  const r = acceptRequest(address, { mailbox: d.mailbox, trust: createTrustStore(d.home), home: d.home });
  if (!r.ok) throw new Error(r.error);
  return { ...r, told: await d.morse!.notifyAccepted(address, r.request.myAddress) }; // (ADR-083) only the address of mine that accepted says so
};
const received = (d: Dev) => d.mailbox.inbox({ all: true }).filter((m) => m.direction === 'in');
const texts = (d: Dev) => received(d).map((m) => m.parts[0]!.text);
const got = (d: Dev, text: string) => received(d).find((m) => m.parts[0]!.text === text)!;

const open = async (key: AddressKey, blob: string): Promise<OpenedV3> => openV3(JSON.parse(blob), { address: key.address, keys: ensurePrekeys(key).keys });
const bodyOf = (o: OpenedV3) => {
  try {
    return JSON.parse(o.body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
/** A hand-made envelope from `from` (any key) to an address, sealed to the prekey that address published. */
const forge = async (via: Dev, from: AddressKey, to: string, plain: Record<string, unknown> | Buffer, o: { cert?: string } = {}) => {
  const info = await via.morse!.v3Client!()!.lookupAddress!(to);
  const env = await sealV3({ from, to, prekey: info.prekey!, body: Buffer.isBuffer(plain) ? plain : Buffer.from(JSON.stringify(plain)), ...(o.cert ? { cert: o.cert } : {}) });
  return JSON.stringify(env);
};
/** Hand a sealed envelope to a daemon as if the relay had delivered it (the relay names the signer as sender). */
let seq = 0;
const inject = (to: Dev, from: string, blob: string, toAddress?: string) => to.morse!.receive({ id: `inj-${++seq}`, from, blob, ts: Date.now(), ...(toAddress ? { to: toAddress } : {}) });
const message = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ kind: 'message', id, contextId: id, from: { agent: 'claude', sessionId: '' }, to: { agent: 'user', sessionId: '' }, addr: 1, text, ...extra });
const signedBy = (address: string) => relay!.v3Log().filter((e) => e.from === address);

/** (ADR-091) A contact by old name as the v5 step leaves it: by address (the relay named it), the old name kept. */
const oldWayContact = (of: Dev, who: Dev) => {
  of.mailbox.contacts.ensure(who.handle);
  of.mailbox.contacts.applySplit(`c:${who.handle}`, [{ agent: who.agent, address: who.address, default: true }]);
  convertKnownHandles(of.db);
};
const GONE = (address: string) => `this message was written from your address morse.im/${address}, which is no longer here (or its key is not loaded) — not sent`;
/** (ADR-083) A contact by old name is the first address's alone: the mailbox queues nothing for it from another address of mine. */
const FIRST_ONLY = (name: string) => `"${name}" is a contact of your first address — from another of your addresses, write to their address (morse.im/<their 26 characters>): they are then a contact of that address`;

describe('F1 — the first address never stands in for another one', () => {
  it('(a) queued from `work`, then `work` is removed and the daemon restarts: nothing goes out — not signed by the first address, not by handle + certificate', async () => {
    const [ann, ben, kai] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc'), dev('kai', 'kai-mini')];
    await world([ann, ben, kai]);
    const work = second(ann, 'work');
    // kai is a contact the old way (paired by handle), his address known as after the P2 migration
    createTrustStore(ann.home).add({ id: kai.id, name: 'kai', tier: 'peer' });
    createTrustStore(kai.home).add({ id: ann.id, name: 'ann', tier: 'peer' });
    connect(ann);
    connect(ben);
    connect(kai);
    await v3Online(ann, ben, kai);
    await online(work.address);
    // (ADR-091) kai's contact as the v5 step leaves it: by address, his old name kept (and ann's on his side)
    oldWayContact(ann, kai);
    oldWayContact(kai, ann);
    ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'kai' }, text: 'first, the old way' });
    expect(await next(ann)).toEqual({ ok: true, via: 'relay' });

    // queued from `work`, not sent yet: as the daemon records it (the address) — and two rows with the name only
    // (hand-made: no writer of this release leaves the address out, and the mailbox refuses to queue one)
    const toBen = await queue(ann, ben.address, 'to a bare address, from work', { from: 'work' });
    // (ADR-083) by his old name nothing is queued from `work` at all — c:kai is the first address's contact …
    const rows = ann.mailbox.inbox({ all: true }).length;
    await expect(queue(ann, 'morse.im/kai', 'to an old-handle contact, from work', { from: 'work' })).rejects.toThrow(FIRST_ONLY('kai'));
    expect(ann.mailbox.inbox({ all: true })).toHaveLength(rows);
    // … to his ADDRESS it is: a contact of `work` then, apart from c:kai — and an address a device paired here has
    const toKai = await queue(ann, kai.address, 'to the address of an old-handle contact, from work', { from: 'work' });
    expect(toBen).toMatchObject({ myAgent: 'work', myAddress: work.address });
    expect(toKai).toMatchObject({ myAgent: 'work', myAddress: work.address, contactId: `a:${kai.address}~${work.address}`, to: { device: kai.address } });
    const oldBen = nameOnly(ann, ben.address, 'name only, to a bare address', 'work');
    const oldKai = nameOnly(ann, 'kai', 'name only, to an old-handle contact', 'work');
    expect(oldBen.myAddress).toBeUndefined();
    expect(oldBen.fromFirstAddress).toBeUndefined();

    removeAddress(ann, 'work');
    await restart(ann);
    const [v3Before, v2Before] = [relay!.v3Log().length, relay!.v2Sends().length];
    const nameGone = { ok: false, error: 'this message was queued from your address "work", which is no longer here under that name — send it again (morse send --from <name>; morse address lists them)' };
    expect(await flush(ann)).toEqual([{ ok: false, error: GONE(work.address) }, { ok: false, error: GONE(work.address) }, nameGone, nameGone]);
    for (const m of [toBen, toKai, oldBen, oldKai]) expect(ann.mailbox.getMessage(m.id)).toMatchObject({ status: 'failed' });
    for (const m of [toBen, toKai, oldBen, oldKai]) expect(ann.mailbox.getMessage(m.id)!.waiting).toBeFalsy();
    // nothing left this computer: no envelope by address, none the old way
    await sleep(200);
    expect(relay!.v3Log().length).toBe(v3Before);
    expect(relay!.v2Sends().length).toBe(v2Before);
    expect(ben.mailbox.requests.count()).toBe(0);
    expect(texts(kai)).toEqual(['first, the old way']);
    // the first address itself still works, both ways
    expect((await write(ann, ben.address, 'from the first address')).r).toMatchObject({ ok: true, request: true });
    ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'kai' }, text: 'old way again' });
    expect(await next(ann)).toEqual({ ok: true, via: 'relay' });
  }, 30_000);

  it('(b) a damaged agents.json at daemon start is not "this computer has only its first address": mail from another address is refused, loudly', async () => {
    const [ann, ben, kai] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc'), dev('kai', 'kai-mini')];
    await world([ann, ben, kai]);
    const work = second(ann, 'work');
    createTrustStore(ann.home).add({ id: kai.id, name: 'kai', tier: 'peer' });
    createTrustStore(kai.home).add({ id: ann.id, name: 'ann', tier: 'peer' });
    connect(ann);
    connect(ben);
    connect(kai);
    await v3Online(ann, ben, kai);
    await online(work.address);
    const toBen = await queue(ann, ben.address, 'recorded address', { from: 'work' });
    const oldBen = nameOnly(ann, ben.address, 'name only', 'work');
    const oldKai = nameOnly(ann, 'kai', 'name only, old-handle contact', 'work');

    stop(ann);
    await offline(ann.address);
    const index = join(addressesDir(ann.home), 'agents.json');
    writeFileSync(index, '{ "v": 1, "agents": { "ann-mbp": ');
    connect(ann);
    await v3Online(ann);
    expect(ann.logs.some((l) => /agents\.json is damaged/.test(l) && /ONLY this computer's first address is online/.test(l))).toBe(true);
    const [v3Before, v2Before] = [relay!.v3Log().length, relay!.v2Sends().length];
    const out = await flush(ann);
    expect(out[0]).toEqual({ ok: false, error: GONE(work.address) });
    for (const r of out.slice(1)) {
      expect(r.ok).toBe(false);
      expect(r.waiting).toBeFalsy();
      expect(r.error).toMatch(/^this message was queued from your address "work", but which address that is cannot be read .*agents\.json is damaged.* — not sent$/);
    }
    expect(out).toHaveLength(3);
    await sleep(200);
    expect(relay!.v3Log().length).toBe(v3Before);
    expect(relay!.v2Sends().length).toBe(v2Before);
    expect(ben.mailbox.requests.count()).toBe(0);
    expect(texts(kai)).toEqual([]);
    for (const m of [toBen, oldBen, oldKai]) expect(ann.mailbox.getMessage(m.id)!.receiptAt).toBeFalsy();
    // the daemon keeps running for the first address
    expect((await write(ann, ben.address, 'the first address is fine')).r).toMatchObject({ ok: true, request: true });
    expect(ben.mailbox.requests.list().map((r) => r.handle)).toEqual([ann.address]);
  }, 30_000);

  it('(c) a stranger wrote to `work`; it is renamed and the daemon restarted; accepting tells them from THAT address — and from none when it is gone', async () => {
    const [ann, ben, cy] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc'), dev('cy', 'cy-pc')];
    await world([ann, ben, cy]);
    const work = second(ann, 'work');
    connect(ann);
    connect(ben);
    connect(cy);
    await v3Online(ann, ben, cy);
    await online(work.address);
    expect((await write(ben, work.address, 'hello work')).r).toMatchObject({ ok: true, request: true });
    expect((await write(cy, work.address, 'hello from cy')).r).toMatchObject({ ok: true, request: true });
    // (ADR-083) a request waits at the address of mine it was written to — the first address has none from him
    expect(ann.mailbox.requests.get(ben.address, work.address)).toMatchObject({ myAddress: work.address, toAddress: work.address, to: { agent: 'work', sessionId: 'inbox' } });
    expect(ann.mailbox.requests.get(ben.address)).toBeUndefined();

    renameAddress(ann, 'work', 'job');
    await restart(ann);
    await online(work.address);
    const ok = await accept(ann, ben.address);
    expect(ok.told).toBe(1);
    expect(got(ann, 'hello work')).toMatchObject({ myAddress: work.address, contactId: `a:${ben.address}~${work.address}` }); // (ADR-083) a contact OF `work`
    const notices = relay!.v3Log().filter((e) => e.to === ben.address && e.from !== ben.address);
    const notice = notices[notices.length - 1]!;
    expect(notice.from).toBe(work.address);
    expect(bodyOf(await open(loadPrimaryAddress(ben.home), notice.blob))).toEqual({ kind: 'accepted' });
    // the first address appears nowhere in this exchange
    expect(relay!.v3Log().some((e) => e.from === ann.address || e.to === ann.address)).toBe(false);
    // …and her reply goes out from the address he wrote to, whatever it is called now
    const back = ann.mailbox.reply(got(ann, 'hello work').id, 'hello ben');
    expect(back).toMatchObject({ myAddress: work.address });
    expect(await next(ann)).toEqual({ ok: true, via: 'relay' });
    expect(got(ben, 'hello ben')).toMatchObject({ from: { device: work.address } });

    // the address is removed before cy is accepted: cy is told by nobody (and learns it at their next probe) — never by the first address
    removeAddress(ann, 'job');
    await restart(ann);
    const before = relay!.v3Log().length;
    const late = await accept(ann, cy.address);
    expect(late.told).toBe(0);
    await sleep(200);
    expect(relay!.v3Log().length).toBe(before);
    expect(signedBy(ann.address)).toEqual([]);
    expect(ann.logs.some((l) => l.includes(`nothing is sent from your address morse.im/${work.address}`))).toBe(true);
    // and a reply to cy's message is refused the same way
    ann.mailbox.reply(got(ann, 'hello from cy').id, 'too late');
    expect(await next(ann)).toEqual({ ok: false, error: GONE(work.address) });
    expect(signedBy(ann.address)).toEqual([]);
  }, 30_000);

  it('a rename breaks nothing: mail queued from `work`, renamed to `job`, still goes out from that address — a row with only the name is never resolved by it', async () => {
    const [ann, ben, cy] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc'), dev('cy', 'cy-pc')];
    await world([ann, ben, cy]);
    const work = second(ann, 'work');
    ben.mailbox.contacts.ensureAddress(work.address);
    cy.mailbox.contacts.ensureAddress(work.address);
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    await online(work.address);
    const recorded = await queue(ann, ben.address, 'queued from work', { from: 'work' });
    // (ADR-081 review: legacy rows) a row with the name only, made after this release's daemon first ran here (hand-made: no
    // writer leaves the address out): refused — the name is never resolved to an address, not even while it matches
    const legacy = nameOnly(ann, cy.address, 'name only', 'work');
    expect(legacy.myAddress).toBeUndefined();
    expect(await deliver(ann, ann.mailbox.claimNextPending({ scope: 'outbound', skipIds: [recorded.id] })!)).toEqual({
      ok: false,
      error: 'this message was queued from your address "work", which is no longer here under that name — send it again (morse send --from <name>; morse address lists them)',
    });
    expect(ann.mailbox.getMessage(legacy.id)!.myAddress).toBeUndefined();
    connect(cy);
    await v3Online(cy);
    const toCy = await queue(ann, cy.address, 'for cy, from work', { from: 'work' });
    expect(toCy).toMatchObject({ myAgent: 'work', myAddress: work.address });

    renameAddress(ann, 'work', 'job');
    await restart(ann);
    await online(work.address);
    expect(ann.morse!.addresses!().find((a) => a.address === work.address)).toMatchObject({ agent: 'job' });
    expect(await flush(ann)).toEqual([{ ok: true, via: 'relay' }, { ok: true, via: 'relay' }]);
    expect(texts(ben)).toEqual(['queued from work']);
    expect(texts(cy)).toEqual(['for cy, from work']);
    for (const m of [...received(ben), ...received(cy)]) expect(m).toMatchObject({ from: { device: work.address }, contactId: `a:${work.address}` });
    expect(signedBy(ann.address)).toEqual([]);
    expect(ann.mailbox.getMessage(recorded.id)).toMatchObject({ status: 'delivered', myAddress: work.address });
    // the new name works for new mail, the old name is no longer one
    expect((await write(ann, ben.address, 'as job', { from: 'job' })).r).toEqual({ ok: true, via: 'relay' });
    expect(got(ben, 'as job')).toMatchObject({ from: { device: work.address } });
    expect(await ann.morse!.addressRoute!(ben.address, 'work')).toEqual({ ok: false, error: 'this message was queued from your address "work", which is no longer here under that name — send it again (morse send --from <name>; morse address lists them)' });
  }, 30_000);

  it('sweep: with the key of the second address not loaded, no kind of outbound envelope leaves — message, old-handle message, receipt, accepted, rekey, chunk answer', async () => {
    const [ann, ben, kai] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc'), dev('kai', 'kai-mini')];
    await world([ann, ben, kai], { maxBlobBytes: 64 * 1024 });
    const work = second(ann, 'work');
    createTrustStore(ann.home).add({ id: kai.id, name: 'kai', tier: 'peer' });
    createTrustStore(kai.home).add({ id: ann.id, name: 'ann', tier: 'peer' });
    ann.mailbox.contacts.ensureAddress(ben.address, work.address); // (ADR-083) a contact OF `work`: a contact of her first address would be a stranger there
    ben.mailbox.contacts.ensureAddress(work.address);
    connect(ann);
    connect(ben);
    connect(kai);
    await v3Online(ann, ben, kai);
    await online(work.address);
    oldWayContact(ann, kai);
    oldWayContact(kai, ann);
    ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: 'kai' }, text: 'the old way' });
    expect(await next(ann)).toEqual({ ok: true, via: 'relay' });
    // ben wrote to `work` (so there is something to answer), and a stranger's request waits there
    expect((await write(ben, work.address, 'for work')).r).toEqual({ ok: true, via: 'relay' });
    const cy = dev('cy', 'cy-pc');
    relay!.allow({ id: cy.id, handle: 'cy' });
    connect(cy);
    await v3Online(cy);
    expect((await write(cy, work.address, 'a request for work')).r).toMatchObject({ ok: true, request: true });
    // envelopes sealed for `work` while it was online (what a relay could still hand over later)
    const benKey = loadPrimaryAddress(ben.home);
    const lateMessage = await forge(ben, benKey, work.address, message('late-1', 'late for work'));
    const lateChunk = await forge(ben, benKey, work.address, encodeChunk({ kind: 'chunk', id: 'late-big', f: 0, seq: 0, n: 2, sha256: 'ab'.repeat(32) }, randomBytes(64)));
    const unknownPrekey = JSON.stringify(await sealV3({ from: benKey, to: work.address, prekey: { ...(await ben.morse!.v3Client!()!.lookupAddress!(ann.address)).prekey! }, body: Buffer.from('{}') }));
    const queued = [
      await queue(ann, ben.address, 'message to a bare address', { from: 'work' }),
      // (ADR-083) to the ADDRESS of the old-handle contact: by his old name nothing is queued from `work` (F1 (a))
      await queue(ann, kai.address, 'message to the address of an old-handle contact', { from: 'work' }),
      ann.mailbox.reply(got(ann, 'for work').id, 'a reply from work'),
    ];
    const path = join(ann.home, 'big.bin');
    writeFileSync(path, randomBytes(300 * 1024));
    queued.push(ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ben.address }, text: 'a big file from work', files: stageOutboxFiles([path], ann.home), myAgent: 'work', myAddress: work.address }));

    removeAddress(ann, 'work');
    await restart(ann);
    const [v3Before, v2Before] = [relay!.v3Log().length, relay!.v2Sends().length];
    // messages (plain, old-handle contact, reply, chunked)
    expect(await flush(ann)).toEqual(queued.map(() => ({ ok: false, error: GONE(work.address) })));
    // accepted
    expect((await accept(ann, cy.address)).told).toBe(0);
    // receipt, chunk answer, rekey: what arrives for an address this daemon does not hold is not answered (and not filed)
    await inject(ann, ben.address, lateMessage, work.address);
    await inject(ann, ben.address, lateChunk, work.address);
    await inject(ann, ben.address, unknownPrekey, work.address);
    await sleep(400);
    expect(texts(ann)).not.toContain('late for work');
    expect(relay!.v3Log().length).toBe(v3Before);
    expect(relay!.v2Sends().length).toBe(v2Before);
    expect(relay!.v3Log().slice(v3Before).filter((e) => e.from === ann.address)).toEqual([]);
    expect(ann.morse!.transfers()).toEqual([]);
    expect(ann.morse!.incoming()).toEqual([]);
  }, 30_000);

  it('the daemon records the ADDRESS when it queues: --from <name>, a bare address without --from, and "no address named" for everything else', async () => {
    const [ann, ben, kai] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc'), dev('kai', 'kai-mini')];
    await world([ann, ben, kai]);
    const work = second(ann, 'work');
    createTrustStore(ann.home).add({ id: kai.id, name: 'kai', tier: 'peer' });
    createTrustStore(kai.home).add({ id: ann.id, name: 'ann', tier: 'peer' });
    oldWayContact(ann, kai);
    oldWayContact(kai, ann);
    connect(ann);
    connect(ben);
    connect(kai);
    await v3Online(ann, ben, kai);
    await online(work.address);
    const port = await new Promise<number>((done, fail) => {
      const srv = createNetServer();
      srv.once('error', fail);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => done(p));
      });
    });
    const m = ann.morse!;
    const server = startConsoleServer({ token: TEST_TOKEN, 
      mailbox: ann.mailbox,
      directory: async () => [],
      port,
      changePollMs: 60_000,
      // (ADR-091, stage 2: as `morse start` wires it — no knowsDevice / pairPerson any more)
      addressRoute: (target, from) => m.addressRoute!(target, from),
      ownAddress: (from) => m.ownAddress!(from),
      acceptAddress: (address, from) => m.acceptAddress!(address, from), // (ADR-083) as `morse start` wires it: the address of mine that writes
    });
    try {
      const post = async (body: Record<string, unknown>) => ((await (await fetch(`http://127.0.0.1:${port}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { message: Message }).message;
      // (the plain one first: ben then knows her by her first address, and `--from work` is said for one message — ADR-081 review N2)
      const plain = await post({ target: ben.address, text: 'no --from' });
      expect(plain).toMatchObject({ myAddress: ann.address });
      expect(plain.fromFirstAddress).toBeUndefined();
      expect(await post({ target: ben.address, text: 'from work', fromAddress: 'work' })).toMatchObject({ myAgent: 'work', myAddress: work.address });
      // (ADR-091) an old name finds the contact it was — by address now: it goes to that address, from the first one
      const old = await post({ target: 'morse.im/kai', text: 'the old way' });
      expect(old).toMatchObject({ myAddress: ann.address, to: { device: kai.address } });
      // …and it stays that after the first agent was renamed while the message waited
      renameAddress(ann, 'ann-mbp', 'ann-new');
      await restart(ann);
      expect(await flush(ann)).toEqual([{ ok: true, via: 'relay', request: true }, { ok: true, via: 'relay', request: true }, { ok: true, via: 'relay' }]);
      expect(ben.mailbox.requests.list().map((r) => r.handle).sort()).toEqual([ann.address, work.address].sort());
      expect(got(kai, 'the old way')).toMatchObject({ from: { device: ann.address } });
    } finally {
      server.close();
    }
  }, 30_000);

  it('the columns are additive: my_address / to_address are new nullable columns, user_version is unchanged, old rows read as before', () => {
    const home = freshHome();
    const path = join(home, 'mailbox.db');
    const db = createDb(path);
    const version = db.pragma('user_version', { simple: true });
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>).filter((c) => ['my_address', 'to_address'].includes(c.name));
    expect(cols('messages')).toEqual([{ name: 'my_address', notnull: 0, dflt_value: null }].map((c) => expect.objectContaining(c)));
    // (ADR-083, schema v4) morse_requests is keyed by (my_address, handle): my_address is NOT NULL DEFAULT '' there ('' = the first address)
    expect(cols('morse_requests')).toEqual([{ name: 'my_address', notnull: 1, dflt_value: "''" }, { name: 'to_address', notnull: 0, dflt_value: null }].map((c) => expect.objectContaining(c)));
    const mb = createMailbox(db);
    const plain = mb.send({ from: session, to: { agent: 'user', sessionId: '', device: 'kai' }, text: 'no address named' });
    expect(plain.myAddress).toBeUndefined();
    db.close();
    // opened again: the same version, nothing migrated, no backup taken
    const again = createDb(path);
    expect(again.pragma('user_version', { simple: true })).toBe(version);
    expect(createMailbox(again).getMessage(plain.id)).toMatchObject({ id: plain.id });
    again.close();
  });
});

describe('F2 — an answer counts only for the address pair it belongs to', () => {
  it('a receipt, a rekey and a chunk acknowledgement for mail sent from my second address are ignored when they arrive at my first — and honoured at the second', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc')];
    await world([ann, ben], { maxBlobBytes: 64 * 1024 });
    const work = second(ann, 'work');
    ann.mailbox.contacts.ensureAddress(ben.address);
    ben.mailbox.contacts.ensureAddress(work.address);
    ben.mailbox.contacts.ensureAddress(ann.address);
    connect(ann, { chunkRatePerMinute: 100_000, rateBackoffMs: 50, transferTuning: { ackIdleMs: 300, completeWaitMs: 500, maxIdleRounds: 1 } });
    connect(ben);
    await v3Online(ann, ben);
    await online(work.address);
    const benKey = loadPrimaryAddress(ben.home);
    stop(ben);
    await offline(ben.address);

    // from `work` to ben (away): left in the relay's mailbox, no receipt yet
    const sent = await write(ann, ben.address, 'from work, waiting for a receipt', { from: 'work' });
    expect(sent.r).toEqual({ ok: true, via: 'relay' });
    const state = () => ann.mailbox.getMessage(sent.m.id)!;
    // ben (who also knows her first address) answers to the WRONG address of hers
    await inject(ann, ben.address, await forge(ann, benKey, ann.address, { kind: 'rekey', ref: sent.m.id }), ann.address);
    await inject(ann, ben.address, await forge(ann, benKey, ann.address, { kind: 'receipt', id: sent.m.id }), ann.address);
    expect(state()).toMatchObject({ status: 'delivered' });
    expect(state().receiptAt).toBeFalsy();
    // the same two at the address the message was sent from
    await inject(ann, ben.address, await forge(ann, benKey, work.address, { kind: 'rekey', ref: sent.m.id }), work.address);
    expect(state()).toMatchObject({ status: 'failed', waiting: true });
    await inject(ann, ben.address, await forge(ann, benKey, work.address, { kind: 'receipt', id: sent.m.id }), work.address);
    expect(state().receiptAt).toBeTypeOf('number');
    expect(await flush(ann)).toEqual([{ ok: true }]); // (the resend the rekey asked for: confirmed meanwhile)

    // the other direction: mail from her FIRST address is not confirmed through her second
    const first = await write(ann, ben.address, 'from the first address');
    expect(first.r).toEqual({ ok: true, via: 'relay' });
    await inject(ann, ben.address, await forge(ann, benKey, work.address, { kind: 'receipt', id: first.m.id }), work.address);
    expect(ann.mailbox.getMessage(first.m.id)!.receiptAt).toBeFalsy();
    await inject(ann, ben.address, await forge(ann, benKey, ann.address, { kind: 'receipt', id: first.m.id }), ann.address);
    expect(ann.mailbox.getMessage(first.m.id)!.receiptAt).toBeTypeOf('number');

    // a chunked transfer from `work` (ben away: it waits): an acknowledgement counts only at `work`
    const path = join(ann.home, 'big.bin');
    writeFileSync(path, randomBytes(200 * 1024));
    const big = ann.mailbox.send({ from: session, to: { agent: INBOX_AGENT, sessionId: '', device: ben.address }, text: 'big, from work', files: stageOutboxFiles([path], ann.home), myAgent: 'work', myAddress: work.address });
    expect(await ann.morse!.send(ben.address, big)).toMatchObject({ ok: false, waiting: true });
    await until(() => ann.morse!.transfer(big.id)?.state === 'waiting');
    const total = ann.morse!.transfer(big.id)!.total;
    expect(total).toBeGreaterThan(1);
    const ack = { kind: 'transfer', id: big.id, have: [[[0, total - 1]]] };
    await inject(ann, ben.address, await forge(ann, benKey, ann.address, ack), ann.address);
    expect(ann.morse!.transfer(big.id)!.acked).toBe(0);
    await inject(ann, ben.address, await forge(ann, benKey, work.address, ack), work.address);
    expect(ann.morse!.transfer(big.id)!.acked).toBe(total);
  }, 30_000);

  it('an incoming chunked message is staged per address pair: chunks that arrive at another address of mine are not part of it', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp', ['work']), dev('ben', 'ben-pc')];
    await world([ann, ben], { maxBlobBytes: 64 * 1024 });
    const work = second(ann, 'work');
    ann.mailbox.contacts.ensureAddress(ben.address);
    ann.mailbox.contacts.ensureAddress(ben.address, work.address); // (ADR-083) a contact of BOTH her addresses: two rows — at `work` he would be a stranger otherwise
    connect(ann, { ackEvery: 1, ackDelayMs: 10 });
    connect(ben);
    await v3Online(ann, ben);
    await online(work.address);
    const benKey = loadPrimaryAddress(ben.home);
    const data = randomBytes(2048);
    const sha = createHash('sha256').update(data).digest('hex');
    const manifest = { chunkSize: 1024, files: [{ name: 'f.bin', size: 2048, sha256: sha, chunks: 2 }] };
    const chunk = (s: number) => encodeChunk({ kind: 'chunk', id: 'big-1', f: 0, seq: s, n: 2, sha256: sha }, data.subarray(s * 1024, s * 1024 + 1024));
    // the manifest and the first chunk go to `work` …
    await inject(ann, ben.address, await forge(ann, benKey, work.address, message('big-1', 'two chunks', { chunked: manifest })), work.address);
    await inject(ann, ben.address, await forge(ann, benKey, work.address, chunk(0)), work.address);
    expect(ann.morse!.incoming()).toMatchObject([{ senderId: ben.address, msgId: 'big-1', held: 1, total: 2 }]);
    // … the second to her first address: not this transfer (answered "no such transfer", signed by the first address only)
    await inject(ann, ben.address, await forge(ann, benKey, ann.address, chunk(1)), ann.address);
    await sleep(200);
    expect(ann.morse!.incoming()).toMatchObject([{ held: 1, total: 2 }]);
    expect(texts(ann)).toEqual([]);
    const said = await Promise.all(signedBy(ann.address).map(async (e) => bodyOf(await open(benKey, e.blob))));
    expect(said).toEqual([{ kind: 'transfer', id: 'big-1', unknown: true }]);
    // at `work` it completes, and the receipt is signed by `work`
    await inject(ann, ben.address, await forge(ann, benKey, work.address, chunk(1)), work.address);
    await until(() => received(ann).length === 1);
    expect(received(ann)[0]).toMatchObject({ myAddress: work.address, myAgent: 'work', from: { device: ben.address } });
    expect(received(ann)[0]!.parts[0]!.text).toMatch(/^two chunks\n\n\[attachments saved/);
    expect(ann.morse!.incoming()).toEqual([]);
    await until(() => signedBy(work.address).length >= 3); // what it holds after the manifest, after the first chunk, then the receipt
    const last = signedBy(work.address).pop()!;
    expect(bodyOf(await open(benKey, last.blob))).toEqual({ kind: 'receipt', id: 'big-1', chunked: true });
  }, 30_000);
});

describe('F3 — an old handle never has the shape of an address', () => {
  it('a relay that lists an attacker\'s device under a handle equal to my contact\'s address: nothing is filed, no request, the contact\'s thread untouched', async () => {
    const [ann, ben, eve] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc'), dev('eve', 'eve-x')];
    eve.handle = ben.address; // what the lying relay says eve's handle is
    await world([ann, ben, eve]);
    expect(relay!.devicesOf(ben.address)).toEqual([eve.id]);
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    // ann and ben are contacts by address only, with a thread
    expect((await write(ann, ben.address, 'hello ben')).r).toMatchObject({ ok: true, request: true });
    await accept(ben, ann.address);
    const history = () => ann.mailbox.history(`a:${ben.address}`).map((m) => m.parts[0]!.text);
    expect(history()).toEqual(['hello ben']);

    // (ADR-091, stage 2: ann has no v2 connection — a v2 envelope from eve cannot even reach her)
    // eve, as a v3 envelope with her own certificate and the handle only claimed in the content
    connect(eve);
    await v3Online(eve);
    const eveKey = loadPrimaryAddress(eve.home);
    const eveCert = new X509Certificate(loadOrCreateIdentity(eve.home).certPem).raw.toString('base64');
    const { addr: _addr, ...legacy } = message('e-2', 'I am ben (v3 + certificate)', { fromHandle: ben.address, to: { agent: 'ann-mbp', sessionId: '' } });
    await eve.morse!.v3Client!()!.sendV3!(ann.address, await forge(eve, eveKey, ann.address, legacy, { cert: eveCert }));
    // (ADR-091) a v3 envelope is decided by the address that SIGNED it, whatever handle it claims: a request from
    // eve's own address — nothing of it reaches ben's contact or thread
    await until(() => ann.mailbox.requests.count() === 1);
    await sleep(200);

    expect(ann.mailbox.requests.list().map((x) => x.handle)).toEqual([eveKey.address]);
    expect(history()).toEqual(['hello ben']);
    expect(texts(ann)).toEqual([]);
    expect(createTrustStore(ann.home).list()).toEqual([]);
    // nothing of ann's is paired "by handle" with it either, by any route
    expect(await ann.morse!.pairHandle(ben.address)).toEqual({ ok: false, error: `"${ben.address}" is an address, not an old name — there is nothing to pair (morse contact add morse.im/${ben.address})` });
    expect(await ann.morse!.admitDirect(eve.id, ben.address)).toBeUndefined();
    // (ADR-091, stage 2: ann has no v2 connection to ask a directory at all)
    await expect(ann.morse!.client.lookupHandle(ben.address)).rejects.toThrow(/does not use old names/);
    await expect(lookupHandle(ben.address, { url: url(), home: ann.home })).rejects.toThrow(/is an address, not an old name/);
  }, 30_000);

  it('a request that did not arrive by address is never accepted as an address — even when its key looks like one (a row from before this check)', () => {
    const ann = dev('ann', 'ann-mbp');
    const ben = loadPrimaryAddress(freshHome()).address;
    const trust = createTrustStore(ann.home);
    ann.mailbox.contacts.ensureAddress(ben);
    // as the release before could have stored it: keyed by an address-shaped handle, written by a DEVICE
    ann.mailbox.requests.file({ handle: ben, deviceId: 'EVE-DEVICE', msgId: 'r-1', from: { agent: 'claude', sessionId: '' }, to: { agent: 'ann-mbp', sessionId: 'inbox' }, text: 'I am ben', droppedFiles: 0, via: 'morse-relay' });
    const r = acceptRequest(ben, { mailbox: ann.mailbox, trust, home: ann.home });
    expect(r).toEqual({ ok: false, error: `the request filed under morse.im/${ben} did not come from that address (it came the old way, from a sender the relay listed under an address-shaped name) — it cannot be accepted: morse contact reject ${ben}` });
    expect(ann.mailbox.history(`a:${ben}`)).toEqual([]);
    expect(trust.list()).toEqual([]);
    expect(ann.mailbox.requests.get(ben)).toBeDefined();
    expect(formatRequests(ann.mailbox.requests.list()).join('\n')).toContain('did NOT come from this address');
    // the same key, arrived by address (signed by it, written to an address of mine): accepted as that address
    ann.mailbox.requests.remove(ben);
    ann.mailbox.requests.file({ handle: ben, deviceId: ben, msgId: 'r-2', from: { agent: 'claude', sessionId: '' }, to: { agent: 'ann-mbp', sessionId: 'inbox' }, toAddress: ann.address, text: 'really ben', droppedFiles: 0, via: 'morse-relay' });
    expect(acceptRequest(ben, { mailbox: ann.mailbox, trust, home: ann.home })).toMatchObject({ ok: true, contactId: `a:${ben}`, message: { myAddress: ann.address, from: { device: ben } } });
  });

  it('unit: address-shaped handles are refused wherever a handle is taken from outside', () => {
    const address = loadPrimaryAddress(freshHome()).address;
    const home = freshHome();
    // (parseMorseAddress still reads the string — a bare address is routed by address before it is ever a handle)
    expect(parseMorseAddress(`morse.im/${address}/x`)).toEqual({ handle: address, agent: 'x' });
    const trust = createTrustStore(home);
    expect(trustHandleDevices(address, [{ id: 'DEV-1', name: 'x', bundle: null }], { trust, home, selfId: 'ME' })).toEqual([]);
    expect(trustHandleDevices(address.toUpperCase(), [{ id: 'DEV-1', name: 'x', bundle: null }], { trust, home, selfId: 'ME' })).toEqual([]);
    expect(trust.list()).toEqual([]);
    expect(trustHandleDevices('kai', [{ id: 'DEV-1', name: 'x', bundle: null }], { trust, home, selfId: 'ME' })).toHaveLength(1);
    // `morse join`: a relay that answers with an address-shaped handle is not believed
    expect(() => saveRelayMembership('wss://relay.example', address, home)).toThrow(/has the shape of an address/);
    saveRelayMembership('wss://relay.example', 'k7f3a9xq', home);
  });
});

describe('F4 — the request area never pushes anyone out', () => {
  it('by address: when it is full a new stranger is refused with a receipt that says so; their computer holds the message; nobody waiting is removed', async () => {
    const [ann, cy] = [dev('ann', 'ann-mbp'), dev('cy', 'cy-pc')];
    const ben = dev('ben', 'ben-pc');
    const ctx = homeContactContext(ben.home);
    ben.mailbox = createMailbox(createDb(':memory:', { ctx }), { ctx, maxRequests: 1 });
    await world([ann, ben, cy]);
    connect(ann);
    connect(ben);
    connect(cy, { requestProbeMs: 0 }); // (every send is a probe)
    await v3Online(ann, ben, cy);
    expect((await write(ann, ben.address, 'first come')).r).toMatchObject({ ok: true, request: true });
    expect(ben.mailbox.requests.full()).toBe(true);

    const late = await write(cy, ben.address, 'too late');
    expect(late.r).toEqual({ ok: false, waiting: true, error: `morse.im/${ben.address}: their message requests are full — try again later (held here; it is sent again by itself)` });
    expect(cy.mailbox.getMessage(late.m.id)).toMatchObject({ status: 'failed', waiting: true });
    expect(cy.mailbox.getMessage(late.m.id)!.receiptAt).toBeFalsy();
    expect(cy.mailbox.getMessage(late.m.id)!.request).toBeFalsy();
    // ben: ann's request is still the one that waits
    expect(ben.mailbox.requests.list().map((r) => r.handle)).toEqual([ann.address]);
    expect(ben.logs.some((l) => l.includes(`message requests are full (1 of 1) — refused a new one from morse.im/${cy.address}`))).toBe(true);
    expect(formatRequests(ben.mailbox.requests.list(), { max: ben.mailbox.requests.max })[1]).toMatch(/^message requests are full \(1 of 1\) — nobody new can reach you until you accept or reject some/);
    expect(formatRequests(ben.mailbox.requests.list()).join('\n')).not.toContain('are full'); // (only when the caller says how many are kept)
    // on the wire: "dropped" (what a Morse before this understands: hold it) plus `full`
    const receipt = relay!.v3Log().filter((e) => e.from === ben.address && e.to === cy.address).pop()!;
    expect(bodyOf(await open(loadPrimaryAddress(cy.home), receipt.blob))).toEqual({ kind: 'receipt', id: late.m.id, request: 'dropped', full: true });
    // ben rejects ann: room again — cy's next try is filed, and from then on cy waits for "accept" like anyone
    ben.mailbox.requests.remove(ann.address);
    expect(await cy.morse!.send(ben.address, cy.mailbox.getMessage(late.m.id)!)).toEqual({ ok: true, via: 'relay', request: true });
    expect(ben.mailbox.requests.list().map((r) => r.handle)).toEqual([cy.address]);
    connect(cy, { requestProbeMs: 600_000 });
    await v3Online(cy);
  }, 30_000);
});

describe('F4 — the owner is told when the request area is full', () => {
  it('`morse message` (the to-process view) says so, in text and in JSON; nothing is said while there is room', () => {
    const ann = dev('ann', 'ann-mbp');
    const mb = createMailbox(createDb(':memory:'), { maxRequests: 2 });
    const file = (h: string) => mb.requests.file({ handle: h, deviceId: `D-${h}`, msgId: `m-${h}`, from: { agent: 'claude', sessionId: '' }, to: { agent: 'ann-mbp', sessionId: 'inbox' }, text: 'hi', droppedFiles: 0, via: 'morse-relay' });
    const shown = (json: boolean) => {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.join(' '));
      try {
        printTodo(mb, json ? { json: true } : {});
      } finally {
        console.log = orig;
      }
      return lines.join('\n');
    };
    file('p1');
    expect(shown(false)).not.toContain('are full');
    expect(JSON.parse(shown(true)).requestsFull).toBeUndefined();
    file('p2');
    expect(file('p3')).toEqual({ result: 'full' });
    expect(shown(false)).toContain('message requests are full (2 of 2) — nobody new can reach you until you accept or reject some (morse contact accept | reject <address>)');
    expect(JSON.parse(shown(true))).toMatchObject({ requests: 2, requestsFull: true });
    expect(ann.mailbox.requests.full()).toBe(false);
  });
});

describe('F5 — "another person\'s mail never picks a session" goes by the tier the row is stored with', () => {
  it('a sender that is a bare address, passed in as owner with a session: stored as a peer, in the mailbox — not the session it named', () => {
    const ann = dev('ann', 'ann-mbp');
    const x = loadPrimaryAddress(freshHome()).address;
    ann.mailbox.contacts.ensureAddress(x);
    const m = ann.mailbox.send({ from: { agent: 'claude', sessionId: 's', device: x }, to: { agent: 'claude', sessionId: 'live-session-7' }, text: 'tier passed in, session named', fromTier: 'owner' });
    expect(m).toMatchObject({ fromTier: 'peer', contactId: `a:${x}`, to: { agent: 'claude', sessionId: 'inbox' } });
    expect(ann.mailbox.inbox({ toSession: 'live-session-7' })).toEqual([]);
    expect(ann.mailbox.claimNextPending({ scope: 'local' })).toBeNull(); // nothing of theirs is deliverable into a session
    // …while one of our own devices (tier owner, a device name — not an address) keeps the session it names
    const own = ann.mailbox.send({ from: { agent: 'claude', sessionId: 's', device: 'ann/air' }, to: { agent: 'claude', sessionId: 'live-session-7' }, text: 'from my own computer', fromTier: 'owner' });
    expect(own).toMatchObject({ fromTier: 'owner', contactId: 'self', to: { agent: 'claude', sessionId: 'live-session-7' } });
  });
});

describe('F4 — the relay\'s per-IP send limit (client side)', () => {
  it('a message the relay refuses with "rate limited" is not failed: it waits in the outbox and goes out when there is room again', async () => {
    const [ann, ben] = [dev('ann', 'ann-mbp'), dev('ben', 'ben-pc')];
    await world([ann, ben], { v3RatePerIpPerMinute: 4 }); // (each delivered message costs two sends: the message and its receipt)
    ann.mailbox.contacts.ensureAddress(ben.address);
    ben.mailbox.contacts.ensureAddress(ann.address);
    connect(ann);
    connect(ben);
    await v3Online(ann, ben);
    expect((await write(ann, ben.address, 'one')).r).toEqual({ ok: true, via: 'relay' });
    expect((await write(ann, ben.address, 'two')).r).toEqual({ ok: true, via: 'relay' });
    const third = await write(ann, ben.address, 'three');
    expect(third.r).toEqual({ ok: false, waiting: true, error: `morse.im/${ben.address}: relay: rate limited (max 4/min) — kept in the outbox, will retry` });
    expect(ann.mailbox.getMessage(third.m.id)).toMatchObject({ status: 'failed', waiting: true });
    expect(texts(ben)).toEqual(['one', 'two']);
  });
});
