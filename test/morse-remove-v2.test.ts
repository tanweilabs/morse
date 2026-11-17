import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import { blockHandle } from '../src/cluster/blocklist.js';
import { acceptRequest } from '../src/cluster/requests.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { ensureAgentAddresses } from '../src/identity/agent-addresses.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { lanTxt, startAddressLan, type AddressLan } from '../src/cluster/lan-address.js';
import { startMorse, type Morse } from '../src/cluster/morse.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { loadPrimaryAddress } from '../src/identity/address-key.js';
import { openV3, sealV3 } from '../src/identity/envelope.js';
import { ensurePrekeys } from '../src/identity/prekeys.js';
import { MINE_GROUP } from '../src/mailbox/contacts.js';
import { createDb } from '../src/mailbox/db.js';
import { convertKnownHandles } from '../src/mailbox/migrate-v5.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

/**
 * (ADR-091, stage 1) The client needs no v2 at all: a computer installed since v2 was removed has no old name and
 * never logs in the v2 way — the v3 connection opens at start; every contact is reached by its address; every
 * envelope that comes in is decided by the address that signed it, and nobody's mail carries your authority;
 * the LAN and direct links go by address too. Against the in-memory fake relay; the LAN on 127.0.0.1 without mDNS.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-no-v2-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const until = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

interface Dev {
  home: string;
  address: string;
  mailbox: Mailbox;
  logs: string[];
  morse?: Morse;
  lan?: AddressLan;
}
const dev = (): Dev => {
  const home = freshHome();
  loadOrCreateIdentity(home);
  return { home, address: loadPrimaryAddress(home).address, mailbox: createMailbox(createDb(':memory:')), logs: [] };
};

let relay: FakeRelay | null = null;
const running: Morse[] = [];
const lans: AddressLan[] = [];
afterEach(async () => {
  running.splice(0).forEach((m) => m.stop());
  await Promise.all(lans.splice(0).map((l) => l.stop()));
  await relay?.close();
  relay = null;
});
const connect = (d: Dev, extra: Partial<Parameters<typeof startMorse>[0]> = {}) => {
  d.morse = startMorse({ url: `ws://127.0.0.1:${relay!.port}`, home: d.home, mailbox: d.mailbox, receiptTimeoutMs: 3000, connectWaitMs: 1000, log: (l) => d.logs.push(l), ...extra });
  running.push(d.morse);
  return d.morse;
};
const online = (...ds: Dev[]) => until(() => ds.every((d) => Boolean(d.morse!.v3Client?.()?.connected())));
const to = (a: Dev, b: Dev, text: string, contextId?: string) => a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'user', sessionId: '', device: b.address }, text, ...(contextId ? { contextId } : {}) });

describe('a computer without an old name (ADR-091)', () => {
  it('never logs in the v2 way: the v3 connection opens at start and carries everything, both ways', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    const b = dev();
    a.mailbox.contacts.ensureAddress(b.address);
    b.mailbox.contacts.ensureAddress(a.address);
    connect(a);
    connect(b);
    await online(a, b);
    // no v2 connection at all (nobody is allowlisted: a v2 login would be refused and logged)
    expect(a.morse!.client.connected()).toBe(false);
    expect(a.logs.some((l) => /v2|allowlist|not on the allowlist/i.test(l))).toBe(false);
    expect(a.morse!.status()).toMatchObject({ connected: true, handle: null, v3: { connected: true, address: a.address } });
    expect(await a.morse!.send(b.address, to(a, b, 'hello b'))).toEqual({ ok: true, via: 'relay' });
    expect(await b.morse!.send(a.address, to(b, a, 'hello a'))).toEqual({ ok: true, via: 'relay' });
    expect(b.mailbox.inbox().filter((m) => m.direction === 'in').map((m) => [m.parts[0]!.text, m.fromTier])).toEqual([['hello b', 'peer']]);
    expect(a.mailbox.inbox().filter((m) => m.direction === 'in').map((m) => [m.parts[0]!.text, m.fromTier])).toEqual([['hello a', 'peer']]);
    // the relay saw v3 only
    expect(relay.v3Sends().sent).toBeGreaterThanOrEqual(4); // two messages, two receipts
  });

  it('an old name it knows no address for reaches nobody — one line, nothing sent', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    connect(a);
    await online(a);
    const m = a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'user', sessionId: '', device: 'lin' }, text: 'hi' });
    expect(await a.morse!.send('lin', m)).toEqual({ ok: false, terminal: true, error: 'lin: old names no longer work — ask for their 26-character address (morse address shows it)' });
  });
});

describe('every contact by its address (ADR-091)', () => {
  it('a contact that had an old name goes by its address — no handle, no directory, no device path', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    const b = dev();
    // what the migration leaves: bob was a contact by old name (`c:bob`), the relay named his address (ADR-077), and the
    // v5 step made him a contact by address that remembers the old name
    const db = createDb(':memory:');
    a.mailbox = createMailbox(db);
    a.mailbox.contacts.ensure('bob');
    a.mailbox.contacts.applySplit('c:bob', [{ agent: 'mbp', address: b.address, default: true }]);
    convertKnownHandles(db);
    const c = a.mailbox.contacts.get('c:bob')!;
    expect(c).toMatchObject({ handle: null, address: b.address, oldName: 'bob' });
    b.mailbox.contacts.ensureAddress(a.address);
    connect(a);
    connect(b);
    await online(a, b);
    const m = a.mailbox.send({ from: { agent: 'claude', sessionId: 'a-1' }, to: { agent: 'user', sessionId: '', device: 'bob/mbp' }, text: 'by the name of before' });
    expect(m.contactId).toBe(c.id);
    const r = await a.morse!.send('bob/mbp', m);
    expect(r, JSON.stringify(r)).toEqual({ ok: true, via: 'relay' });
    expect(b.mailbox.inbox().map((x) => x.parts[0]!.text)).toEqual(['by the name of before']);
  });

  it('nobody is your owner any more: mail from a computer you had paired as your own is a contact\'s mail — peer, under its contact (group mine), never a session', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const mine = dev();
    const air = dev();
    // the old trust list still says "owner" for that computer — it decides nothing now
    createTrustStore(mine.home).add({ id: loadOrCreateIdentity(air.home).id, name: 'me', tier: 'owner' });
    const c = mine.mailbox.contacts.ensureAddress(air.address);
    mine.mailbox.contacts.set(c.id, { group: MINE_GROUP, remark: 'air' });
    air.mailbox.contacts.ensureAddress(mine.address);
    connect(mine);
    connect(air);
    await online(mine, air);
    const m = air.mailbox.send({ from: { agent: 'claude', sessionId: 'air-session' }, to: { agent: 'claude', sessionId: 'a-session-of-mine', device: mine.address }, text: 'do this for me' });
    expect(await air.morse!.send(mine.address, m)).toEqual({ ok: true, via: 'relay' });
    const got = mine.mailbox.inbox()[0]!;
    expect(got).toMatchObject({ fromTier: 'peer', contactId: c.id });
    // never a session of mine: it lands in the agent's mailbox
    expect(got.to.sessionId).toBe('inbox');
  });
});

describe('the old way still comes in (ADR-091): a v3 envelope with the device certificate and no `addr`', () => {
  it('is filed by its address like any other — and answered the old way, with this computer\'s certificate, so an older Morse takes the receipt', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev(); // this release
    const old = dev(); // stands for a computer of the release before, writing the old way
    a.mailbox.contacts.ensureAddress(old.address);
    connect(a);
    // the older computer: logged in by address (it is on v3), but it writes with its certificate
    const oldMorse = connect(old);
    await online(a, old);
    const id = loadOrCreateIdentity(old.home);
    const key = loadPrimaryAddress(old.home, id);
    const info = await oldMorse.v3Client!()!.lookupAddress!(a.address);
    const cert = new X509Certificate(id.certPem).raw.toString('base64');
    const body = Buffer.from(JSON.stringify({ kind: 'message', id: 'old-1', contextId: 'ctx-old', from: { agent: 'claude', sessionId: '' }, to: { agent: 'mini', sessionId: '' }, fromHandle: 'oldname', fromAgent: 'mbp', text: 'the old way' }));
    const env = await sealV3({ from: key, to: a.address, prekey: info.prekey!, body, cert });
    // what comes back to the older computer: caught on its connection before its own client sees it
    const seen: Array<{ cert: boolean; kind: string }> = [];
    const before = old.logs.length;
    await oldMorse.v3Client!()!.sendV3!(a.address, JSON.stringify(env), { ref: 'old-1' });
    await until(() => a.mailbox.inbox().length === 1);
    expect(a.mailbox.inbox()[0]).toMatchObject({ fromTier: 'peer', contactId: a.mailbox.contacts.byAddress(old.address)!.id });
    // (nothing the sender said about itself is kept: no old name, no agent name)
    expect(a.mailbox.inbox()[0]!.from.device).toBe(old.address);
    // the receipt went back sealed with a's certificate (the old form)
    await until(() => relay!.v3SentLog().some((s) => s.from === a.address && s.to === old.address));
    const back = relay!.v3SentLog().filter((s) => s.from === a.address && s.to === old.address);
    const prekeys = ensurePrekeys(key, Date.now(), { rotate: false });
    for (const s of back) {
      const o = await openV3(JSON.parse(s.blob), { address: old.address, keys: prekeys.keys });
      seen.push({ cert: Boolean(o.cert), kind: (JSON.parse(o.body.toString('utf8')) as { kind: string }).kind });
    }
    expect(seen).toEqual([{ cert: true, kind: 'receipt' }]);
    void before;
  });

  /** a computer of the release before writes to `a` the old way: certificate, `fromHandle`, `to.agent` */
  const writeOldWay = async (a: Dev, old: Dev, oldMorse: Morse, o: { id: string; fromHandle: string; toAgent: string; text: string }) => {
    const id = loadOrCreateIdentity(old.home);
    const key = loadPrimaryAddress(old.home, id);
    const info = await oldMorse.v3Client!()!.lookupAddress!(a.address);
    const cert = new X509Certificate(id.certPem).raw.toString('base64');
    const body = Buffer.from(JSON.stringify({ kind: 'message', id: o.id, contextId: `ctx-${o.id}`, from: { agent: 'claude', sessionId: '' }, to: { agent: o.toAgent, sessionId: '' }, fromHandle: o.fromHandle, fromAgent: 'mbp', text: o.text }));
    const env = await sealV3({ from: key, to: a.address, prekey: info.prekey!, body, cert });
    await oldMorse.v3Client!()!.sendV3!(a.address, JSON.stringify(env), { ref: o.id });
  };

  it('(follow-up) someone blocked by old name — a declined request, a removed contact: no address known — does not come back as a message request: the address is blocked too', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    const old = dev();
    blockHandle('mallory', a.home); // what `morse contact reject|block` wrote the old way
    connect(a);
    const oldMorse = connect(old);
    await online(a, old);
    await writeOldWay(a, old, oldMorse, { id: 'm-1', fromHandle: 'mallory', toAgent: 'mini', text: 'let me in' });
    await until(() => a.logs.some((l) => /written under the old name mallory, which is blocked here/.test(l)));
    expect(a.mailbox.requests.get(old.address)).toBeFalsy();
    expect(a.mailbox.inbox()).toEqual([]);
    expect(a.mailbox.contacts.isBlockedAt(old.address, '')).toBe(true);
  });

  it('(follow-up) a stranger of the release before is told "accepted" in the form its Morse takes: with this computer\'s certificate', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    const old = dev();
    connect(a);
    const oldMorse = connect(old);
    await online(a, old);
    await writeOldWay(a, old, oldMorse, { id: 'r-1', fromHandle: 'stranger', toAgent: 'mini', text: 'may I?' });
    await until(() => Boolean(a.mailbox.requests.get(old.address)));
    expect(acceptRequest(old.address, { mailbox: a.mailbox, trust: createTrustStore(a.home), home: a.home, myAddress: '' }).ok).toBe(true);
    expect(await a.morse!.notifyAccepted(old.address, '')).toBe(1);
    const key = loadPrimaryAddress(old.home, loadOrCreateIdentity(old.home));
    const prekeys = ensurePrekeys(key, Date.now(), { rotate: false });
    const kinds: Array<[string, boolean]> = [];
    for (const x of relay.v3SentLog().filter((y) => y.from === a.address && y.to === old.address)) {
      const o = await openV3(JSON.parse(x.blob), { address: old.address, keys: prekeys.keys });
      kinds.push([(JSON.parse(o.body.toString('utf8')) as { kind: string }).kind, Boolean(o.cert)]);
    }
    expect(kinds).toContainEqual(['accepted', true]);
  });

  it('(follow-up) old-name mail for a second agent of this computer (`me/<agent2>`) is filed for that agent, not the first', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    updateMachineConfig((cfg) => {
      cfg['relay'] = { agent: 'mini', agents: ['mini', 'codex'] };
    }, join(a.home, '.morse', 'config.json'));
    ensureAgentAddresses(a.home);
    const old = dev();
    a.mailbox.contacts.ensureAddress(old.address);
    connect(a);
    const oldMorse = connect(old);
    await online(a, old);
    await writeOldWay(a, old, oldMorse, { id: 'm-2', fromHandle: 'oldname', toAgent: 'codex', text: 'for codex' });
    await until(() => a.mailbox.inbox().length === 1);
    expect(a.mailbox.inbox()[0]!.to.agent).toBe('codex');
    // …and an agent this computer does not have: the first one, as before
    await writeOldWay(a, old, oldMorse, { id: 'm-3', fromHandle: 'oldname', toAgent: 'nobody', text: 'for nobody' });
    await until(() => a.mailbox.inbox().length === 2);
    expect(a.mailbox.inbox().find((m) => m.parts[0]!.text === 'for nobody')!.to.agent).toBe('mini');
  });
});

describe('the LAN by address (ADR-091; hardened by the follow-up)', () => {
  /** d's LAN listener, wired as the daemon wires it: the first address announced and proven, envelopes opened first */
  const lanFor = async (d: Dev, o: { drop?: boolean } = {}) => {
    d.lan = await startAddressLan({
      port: 0,
      host: '127.0.0.1',
      mdns: false,
      address: () => d.morse?.status().v3?.address ?? null,
      sign: (address, message) => d.morse?.lanSign?.(address, message) ?? null,
      check: (blob) => d.morse!.lanCheck!(blob),
      onEnvelope: (blob) => (o.drop ? undefined : void d.morse!.receive({ id: `lan-${Math.random()}`, from: '', blob, ts: Date.now(), via: 'lan' })),
      log: (l) => d.logs.push(l),
    });
    lans.push(d.lan);
    return d.lan;
  };
  /** a listener that cannot prove anything: it announces whatever it is told to and takes every envelope */
  const impostor = async (posts: string[]) => {
    const l = await startAddressLan({ port: 0, host: '127.0.0.1', mdns: false, address: () => null, sign: () => null, check: () => ({ ok: true, from: '23456789abcdefghjkmnpqrstv', known: true }), onEnvelope: (blob) => void posts.push(blob) });
    lans.push(l);
    return l;
  };

  it('a message goes over the LAN to a computer that proved its address; the receipt never comes back over the LAN — an impostor announcing the SENDER there swallows nothing', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    const b = dev();
    a.mailbox.contacts.ensureAddress(b.address);
    b.mailbox.contacts.ensureAddress(a.address);
    const la = await lanFor(a);
    const lb = await lanFor(b);
    connect(a, { lanAddress: la });
    connect(b, { lanAddress: lb });
    await online(a, b);
    const swallowed: string[] = [];
    const fake = await impostor(swallowed);
    la.addPeer(b.address, '127.0.0.1', lb.port);
    lb.addPeer(a.address, '127.0.0.1', fake.port); // on b's network someone announces a's address
    expect(await a.morse!.send(b.address, to(a, b, 'over the LAN'))).toEqual({ ok: true, via: 'lan' });
    expect(b.mailbox.inbox().map((m) => [m.parts[0]!.text, m.fromTier])).toEqual([['over the LAN', 'peer']]);
    expect(swallowed).toEqual([]);
    // the message itself did not go through the relay; its receipt did
    expect(relay.v3SentLog().map((x) => [x.from, x.to])).toEqual([[b.address, a.address]]);
    expect(la.peers()).toEqual([expect.objectContaining({ address: b.address, proven: true })]);
    expect(a.logs.some((l) => /delivered via lan/.test(l))).toBe(true);
    expect(b.logs.some((l) => /^lan: received .* via lan/.test(l))).toBe(true);
  });

  it('a stranger on the LAN is a message request, exactly as through the relay', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    const b = dev();
    const la = await lanFor(a);
    const lb = await lanFor(b);
    connect(a, { lanAddress: la });
    connect(b, { lanAddress: lb });
    await online(a, b);
    la.addPeer(b.address, '127.0.0.1', lb.port);
    expect(await a.morse!.send(b.address, to(a, b, 'hi, we have not met'))).toEqual({ ok: true, via: 'lan', request: true });
    expect(b.mailbox.inbox()).toEqual([]);
    expect(b.mailbox.requests.get(a.address)).toMatchObject({ text: 'hi, we have not met' });
  });

  it('someone announcing the recipient\'s address who cannot prove it gets nothing: the relay carries it, at once', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    const b = dev();
    a.mailbox.contacts.ensureAddress(b.address);
    b.mailbox.contacts.ensureAddress(a.address);
    const la = await lanFor(a);
    const swallowed: string[] = [];
    const fake = await impostor(swallowed);
    connect(a, { lanAddress: la });
    connect(b);
    await online(a, b);
    la.addPeer(b.address, '127.0.0.1', fake.port);
    expect(await a.morse!.send(b.address, to(a, b, 'not for the impostor'))).toEqual({ ok: true, via: 'relay' });
    expect(swallowed).toEqual([]);
    expect(a.logs.some((l) => /announced .* but could not prove it holds that address — not used/.test(l))).toBe(true);
    expect(b.mailbox.inbox().map((m) => m.parts[0]!.text)).toEqual(['not for the impostor']);
  });

  it('the other side proved its address, took it and never answered: the relay carries it (deduped there), and that address is left to the relay for a while', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const a = dev();
    const b = dev();
    a.mailbox.contacts.ensureAddress(b.address);
    b.mailbox.contacts.ensureAddress(a.address);
    const la = await lanFor(a);
    connect(a, { lanAddress: la, lanReceiptMs: 300 });
    connect(b);
    await online(a, b);
    // b's own listener — it proves b's address — that takes envelopes and drops them
    const black = await lanFor(b, { drop: true });
    la.addPeer(b.address, '127.0.0.1', black.port);
    expect(await a.morse!.send(b.address, to(a, b, 'first'))).toEqual({ ok: true, via: 'relay' });
    expect(a.logs.some((l) => /lan: no receipt within 0.3 s — falling back/.test(l))).toBe(true);
    // the next one goes straight to the relay
    const t0 = Date.now();
    expect(await a.morse!.send(b.address, to(a, b, 'second'))).toEqual({ ok: true, via: 'relay' });
    expect(Date.now() - t0).toBeLessThan(250);
    expect(b.mailbox.inbox().map((m) => m.parts[0]!.text)).toEqual(['first', 'second']);
  });

  it('only the first address is proven on the LAN; asked about any other address, the listener answers as about one that is not here', async () => {
    relay = await startFakeRelay({ port: 0, v3: true });
    const b = dev();
    const lb = await lanFor(b);
    connect(b, { lanAddress: lb });
    await online(b);
    expect(lanTxt(b.morse!.status().v3!.address)).toEqual({ v: '3', a0: b.address });
    expect(b.morse!.lanSign!(b.address, Buffer.from('x'))).not.toBeNull();
    expect(b.morse!.lanSign!('23456789abcdefghjkmnpqrstv', Buffer.from('x'))).toBeNull();
    const proof = (address: string) =>
      new Promise<number>((resolve) => {
        const req = request({ host: '127.0.0.1', port: lb.port, method: 'POST', path: '/v3/prove', headers: { 'content-type': 'application/json' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.end(JSON.stringify({ address, nonce: 'abcdefghijklmnopqrstuv' }));
      });
    expect(await proof(b.address)).toBe(200);
    expect(await proof('23456789abcdefghjkmnpqrstv')).toBe(404);
  });

});

