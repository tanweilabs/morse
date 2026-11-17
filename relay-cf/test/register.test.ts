import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allowEntry, devicesOfHandle, putDevice, type AllowKV } from '../src/allowlist.js';
import { getNickname, listAgents, registerAgent, resetBook, resolveAgent, setNickname as setNicknameRecord, type AgentStorage } from '../src/agents.js';
import { verifyPairCode, verifyProfile, verifyRegister } from '../src/crypto.js';
import { createInvite as createInviteRecord, type AgentRegistrar, type InviteStorage } from '../src/invites.js';
import { normalizeNickname as relayNickname } from '../src/protocol.js';
import {
  ID_ALPHABET,
  PAIR_CODE_TTL_MS,
  RESERVED_HANDLES,
  createPairCode,
  handleClaim,
  handleInUse,
  isRandomHandle,
  normalizePairCode as relayPairCode,
  randomId,
  redeemJoin,
  redeemPairCode,
  registerDevice,
  registerSettingsFromEnv,
  releaseHandle,
  type RandomBytes,
  type RegisterSettings,
} from '../src/register.js';
import { loadOrCreateIdentity, type DeviceIdentity } from '../../src/cluster/identity.js';
import { signJoin, signPairCode, signProfile, signRegister } from '../../src/cluster/join.js';
import { normalizeNickname } from '../../src/cluster/nicknames.js';

/**
 * Server side (not part of the public client). Open registration, pairing codes,
 * nicknames, admin release (ADR-036).
 * relay-cf/src/register.ts and agents.ts are runtime-agnostic, so they run here
 * against Map-backed stand-ins for Durable Object storage and Workers KV; the
 * Durable Object's blockConcurrencyWhile is modelled by a promise chain. The client
 * side (test/morse-register.test.ts) runs against test/helpers/fake-relay.ts. The
 * real Worker is covered by scripts/morse-e2e-register.sh.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-reg-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

class MemStorage implements InviteStorage, AgentStorage {
  readonly m = new Map<string, unknown>();
  async get<T>(k: string) {
    return structuredClone(this.m.get(k)) as T | undefined;
  }
  async put<T>(k: string, v: T) {
    this.m.set(k, structuredClone(v));
  }
  async delete(k: string) {
    return this.m.delete(k);
  }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T]));
  }
}
class MemKV implements AllowKV {
  readonly m = new Map<string, string>();
  async get(k: string) {
    const v = this.m.get(k);
    return v === undefined ? null : JSON.parse(v);
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

/** blockConcurrencyWhile: one request at a time, in arrival order. */
function serialiser() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

/** Per-handle AgentBooks on top of the same KV (what the Worker wires up). */
function agentBooks(kv: AllowKV) {
  const books = new Map<string, MemStorage>();
  const book = (h: string) => books.get(h) ?? (books.set(h, new MemStorage()), books.get(h)!);
  const registrar: AgentRegistrar = {
    register: (handle, agent, device, dryRun) => registerAgent(book(handle), { agent, device }, async (d) => (await allowEntry(kv, d))?.handle === handle, { dryRun }),
  };
  return { book, registrar };
}

const cert = (id: DeviceIdentity) => new X509Certificate(id.certPem).raw.toString('base64');
const regReq = (id: DeviceIdentity, agent?: string, ts = Date.now(), signer: DeviceIdentity = id) => ({
  cert: cert(id),
  ts,
  sig: signRegister(signer, ts, agent),
  name: 'test-box',
  ...(agent ? { agent } : {}),
});
// every request its own timestamp: two in the same millisecond would carry the same (deterministic) signature — a replay
const T0 = Date.now() - 60_000;
let tick = 0;
const pairCodeReq = (id: DeviceIdentity, ts = T0 + tick++) => ({ cert: cert(id), ts, sig: signPairCode(id, ts) });
const pairJoinReq = (id: DeviceIdentity, handle: string, code: string, agent?: string, ts = Date.now()) => ({
  handle,
  code,
  cert: cert(id),
  ts,
  sig: signJoin(id, ts, relayPairCode(code) ?? code, agent),
  name: 'second-box',
  ...(agent ? { agent } : {}),
});
/** A RandomBytes that draws the given ids, in order (then real randomness). */
const scripted = (...ids: string[]): RandomBytes => {
  const queue = [...ids];
  return (n) => {
    const next = queue.shift();
    if (!next) return crypto.getRandomValues(new Uint8Array(n));
    const bytes = new Uint8Array(n).fill(255); // 255 ≥ 240: skipped
    [...next].forEach((c, i) => (bytes[i] = ID_ALPHABET.indexOf(c)));
    return bytes;
  };
};
const settings = (over: Partial<RegisterSettings> = {}): RegisterSettings => ({ ...registerSettingsFromEnv({}), ...over });
const devices = (n: number) => Array.from({ length: n }, () => loadOrCreateIdentity(freshHome()));

describe('relay: open registration (random handles)', () => {
  it('ids: 8 characters without 0/1/i/l/o/u, uniform-ish, not a readable word list; settings from env', () => {
    expect(ID_ALPHABET).toHaveLength(30);
    for (const bad of '01ilou') expect(ID_ALPHABET).not.toContain(bad);
    const ids = Array.from({ length: 2000 }, () => randomId(8));
    expect(ids.every(isRandomHandle)).toBe(true);
    expect(new Set(ids).size).toBe(2000);
    const counts = new Map<string, number>();
    for (const c of ids.join('')) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(30);
    expect(Math.min(...counts.values())).toBeGreaterThan(16000 / 30 / 2); // no character starved (modulo bias would show here)
    expect(registerSettingsFromEnv({})).toMatchObject({ open: true, perIpPerHour: 20 });
    expect(registerSettingsFromEnv({ OPEN_REGISTRATION: 'false', REGISTER_PER_IP_PER_HOUR: '3', RESERVED_HANDLES: 'Boss, ceo' })).toMatchObject({ open: false, perIpPerHour: 3 });
    expect(registerSettingsFromEnv({ RESERVED_HANDLES: 'boss,ceo' }).reserved).toEqual(expect.arrayContaining(['admin', 'root', 'support', 'boss', 'ceo']));
    for (const h of ['admin', 'administrator', 'root', 'morse', 'support', 'help', 'system', 'relay', 'api', 'www', 'mail', 'security', 'official', 'team', 'user', 'inbox', 'null', 'undefined']) {
      expect(RESERVED_HANDLES).toContain(h);
    }
  });

  it('a new device gets a random handle and is its first device (agent registered); the Node signature verifies in WebCrypto', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const { book, registrar } = agentBooks(kv);
    const [dev] = devices(1);
    const ts = Date.now();
    expect(await verifyRegister(cert(dev!), ts, signRegister(dev!, ts, 'mini'), 'mini')).toBe(dev!.id);
    expect(await verifyRegister(cert(dev!), ts, signRegister(dev!, ts), 'mini')).toBeNull(); // the agent is part of what is signed

    const r = await registerDevice(store, kv, regReq(dev!, 'mini'), { agents: registrar, ip: '1.2.3.4' });
    expect(r.status).toBe(200);
    const handle = r.body['handle'] as string;
    expect(isRandomHandle(handle)).toBe(true);
    expect(r.body).toEqual({ id: dev!.id, handle, name: 'test-box', agent: 'mini' });
    expect(await allowEntry(kv, dev!.id)).toMatchObject({ handle, name: 'test-box', via: 'register' });
    expect(await devicesOfHandle(kv, handle)).toEqual([dev!.id]);
    expect(await handleClaim(store, handle)).toMatchObject({ handle, via: 'register' });
    expect(await resolveAgent(book(handle))).toMatchObject({ agent: 'mini', device: dev!.id });
    expect(JSON.stringify([...store.m])).not.toContain('1.2.3.4'); // the IP is stored hashed
  });

  it('two new users get different handles; registering again keeps the same handle and creates nothing (one device, one handle)', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const [a, b] = devices(2);
    const ra = await registerDevice(store, kv, regReq(a!));
    const rb = await registerDevice(store, kv, regReq(b!));
    expect(ra.body['handle']).not.toBe(rb.body['handle']);
    const again = await registerDevice(store, kv, regReq(a!), { settings: settings({ perIpPerHour: 2 }) });
    expect(again).toMatchObject({ status: 200, body: { handle: ra.body['handle'], already: true } });
    expect((await registerDevice(store, kv, regReq(a!), { settings: settings({ perIpPerHour: 2 }) })).status).toBe(200); // not charged to the IP
    // an invited device (readable handle) asking for a random one keeps its readable handle
    const [c] = devices(1);
    await putDevice(kv, c!.id, { handle: 'mei', name: 'mini' });
    expect(await registerDevice(store, kv, regReq(c!))).toMatchObject({ status: 200, body: { handle: 'mei', already: true } });
  });

  it('a drawn handle that is taken, reserved, existing in KV or released is never handed out — the relay draws again', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const [a, b, c] = devices(3);
    const first = (await registerDevice(store, kv, regReq(a!), { rand: scripted('k7f3a9xq') })).body['handle'];
    expect(first).toBe('k7f3a9xq');
    await putDevice(kv, 'LEGACY0-DEVICE0', { handle: 'abcdefgh' }); // a handle that only exists in KV (pre-ADR-036)
    const r = await registerDevice(store, kv, regReq(b!), { rand: scripted('k7f3a9xq', 'abcdefgh', 'zzzz2222', 'mmmm3333'), settings: settings({ reserved: [...RESERVED_HANDLES, 'zzzz2222'] }) });
    expect(r.body['handle']).toBe('mmmm3333');
    expect(await handleInUse(store, kv, 'mei')).toBe(false);
    await putDevice(kv, 'LEGACY1-DEVICE1', { handle: 'mei' });
    expect(await handleInUse(store, kv, 'mei')).toBe(true);
    expect(await handleInUse(store, kv, 'admin')).toBe(true);
    // released: the tombstone keeps it out of the draw for good
    await releaseHandle(store, kv, 'mmmm3333');
    expect((await registerDevice(store, kv, regReq(c!), { rand: scripted('mmmm3333', 'pppp4444') })).body['handle']).toBe('pppp4444');
    // nothing free at all → a clear 503, not a duplicate
    const [d] = devices(1);
    const stuck = await registerDevice(store, kv, regReq(d!), { rand: scripted(...Array<string>(16).fill('k7f3a9xq')) });
    expect(stuck).toMatchObject({ status: 503, body: { code: 'no_handle' } });
    expect(await allowEntry(kv, d!.id)).toBeNull();
  });

  it('concurrent registrations (serialised like the Durable Object) never share a handle, even when every draw collides first', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const serial = serialiser();
    const devs = devices(12);
    // every request's first draw is the same id: exactly one may get it, the others draw again
    const results = await Promise.all(devs.map((d) => serial(() => registerDevice(store, kv, regReq(d), { rand: scripted('race2222'), settings: settings({ perIpPerHour: 100 }) }))));
    const handles = results.map((r) => r.body['handle'] as string);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(handles).size).toBe(12);
    expect(handles.filter((h) => h === 'race2222')).toHaveLength(1);
    for (const [i, d] of devs.entries()) expect((await allowEntry(kv, d.id))?.handle).toBe(handles[i]);
  });

  it('per-IP hourly limit on NEW handles: the 4th from one IP is refused, another IP is not, the window resets', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const now = 1_900_000_000_000;
    const s = settings({ perIpPerHour: 3 });
    const devs = devices(6);
    const reg = (d: DeviceIdentity, ip: string, at = now) => registerDevice(store, kv, regReq(d, undefined, at), { ip, settings: s, now: at });
    for (const d of devs.slice(0, 3)) expect((await reg(d, '9.9.9.9')).status).toBe(200);
    const refused = await reg(devs[3]!, '9.9.9.9', now + 60_000);
    expect(refused).toMatchObject({ status: 429, body: { code: 'rate_limited', retryAfterSec: 3540 } });
    expect(await allowEntry(kv, devs[3]!.id)).toBeNull();
    expect((await reg(devs[4]!, '8.8.8.8')).status).toBe(200);
    expect((await reg(devs[3]!, '9.9.9.9', now + 3_600_001)).status).toBe(200);
    // old counters are pruned (one key left per IP that registered in the last hour)
    expect([...store.m.keys()].filter((k) => k.startsWith('ip:'))).toHaveLength(1);
  });

  it('refusals: registration closed, bad signature, clock skew, bad agent, junk', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const [dev, thief] = devices(2);
    expect(await registerDevice(store, kv, regReq(dev!), { settings: settings({ open: false }) })).toMatchObject({ status: 403, body: { code: 'registration_closed' } });
    expect(await registerDevice(store, kv, regReq(dev!, undefined, Date.now(), thief))).toMatchObject({ status: 401, body: { code: 'bad_signature' } });
    expect(await registerDevice(store, kv, regReq(dev!, undefined, Date.now() - 11 * 60_000))).toMatchObject({ status: 400, body: { code: 'clock_skew' } });
    expect(await registerDevice(store, kv, { ...regReq(dev!), agent: 'Bad Name' })).toMatchObject({ status: 400, body: { code: 'bad_agent' } });
    expect(await registerDevice(store, kv, null)).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(kv.m.size).toBe(0);
  });
});

describe('relay: pairing codes (adding your own second computer)', () => {
  const setup = async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const { book, registrar } = agentBooks(kv);
    const [first, second, stranger] = devices(3);
    const handle = (await registerDevice(store, kv, regReq(first!, 'mini'), { agents: registrar })).body['handle'] as string;
    return { store, kv, book, registrar, first: first!, second: second!, stranger: stranger!, handle };
  };

  it('a member gets a one-time code; only its hash is stored; the second computer joins the handle with it; the code is then gone', async () => {
    const { store, kv, book, registrar, first, second, handle } = await setup();
    const ts = Date.now();
    expect(await verifyPairCode(cert(first), ts, signPairCode(first, ts))).toBe(first.id);
    const pc = await createPairCode(store, kv, pairCodeReq(first));
    expect(pc.status).toBe(200);
    const code = pc.body['code'] as string;
    expect(code).toMatch(/^[2-9a-hjkmnp-tv-z]{5}-[2-9a-hjkmnp-tv-z]{5}$/);
    expect(pc.body).toMatchObject({ handle, expiresAt: expect.any(Number) });
    expect(JSON.stringify([...store.m])).not.toContain(code.replace('-', ''));

    const ok = await redeemJoin(store, kv, pairJoinReq(second, `morse.talk/${handle}`.replace('morse.talk/', ''), code.toUpperCase(), 'air'), Date.now(), registrar);
    expect(ok).toEqual({ status: 200, body: { id: second.id, handle, name: 'second-box', agent: 'air' } });
    expect(await devicesOfHandle(kv, handle)).toEqual([first.id, second.id]);
    expect(await allowEntry(kv, second.id)).toMatchObject({ handle, via: `pair:${first.id.slice(0, 7)}` });
    expect((await listAgents(book(handle))).agents.map((a) => a.agent)).toEqual(['mini', 'air']);
    // one-time
    const [third] = devices(1);
    expect(await redeemPairCode(store, kv, pairJoinReq(third!, handle, code))).toMatchObject({ status: 404, body: { code: 'pair_invalid' } });
  });

  it('no code, a wrong code, a code for another handle, an expired code: a taken handle cannot be joined', async () => {
    const { store, kv, first, stranger, handle } = await setup();
    expect(await redeemPairCode(store, kv, pairJoinReq(stranger, handle, 'abcde-fghjk'))).toMatchObject({ status: 404, body: { code: 'pair_invalid' } });
    const now = Date.now();
    const code = (await createPairCode(store, kv, pairCodeReq(first, now), { now })).body['code'] as string;
    expect(await redeemPairCode(store, kv, pairJoinReq(stranger, 'mei', code))).toMatchObject({ status: 404 });
    expect(await redeemPairCode(store, kv, pairJoinReq(stranger, handle, 'not-a-code'))).toMatchObject({ status: 404 });
    const later = now + PAIR_CODE_TTL_MS + 1;
    expect(await redeemPairCode(store, kv, pairJoinReq(stranger, handle, code, undefined, later), later)).toMatchObject({ status: 404 });
    expect(await allowEntry(kv, stranger.id)).toBeNull();
    expect(await devicesOfHandle(kv, handle)).toEqual([first.id]);
  });

  it('five wrong guesses burn the code; a new code replaces the old one; a non-member cannot get one', async () => {
    const { store, kv, first, second, stranger, handle } = await setup();
    const code = (await createPairCode(store, kv, pairCodeReq(first))).body['code'] as string;
    for (let i = 0; i < 5; i++) expect((await redeemPairCode(store, kv, pairJoinReq(stranger, handle, 'abcde-fghjk'))).status).toBe(404);
    expect(await redeemPairCode(store, kv, pairJoinReq(second, handle, code))).toMatchObject({ status: 404 }); // burned
    const c1 = (await createPairCode(store, kv, pairCodeReq(first))).body['code'] as string;
    const c2 = (await createPairCode(store, kv, pairCodeReq(first))).body['code'] as string;
    expect((await redeemPairCode(store, kv, pairJoinReq(second, handle, c1))).status).toBe(404);
    expect((await redeemPairCode(store, kv, pairJoinReq(second, handle, c2))).status).toBe(200);
    expect(await createPairCode(store, kv, pairCodeReq(stranger))).toMatchObject({ status: 403, body: { code: 'not_member' } });
    // a captured request replayed inside the time window gets no code
    const req = pairCodeReq(first);
    expect((await createPairCode(store, kv, req)).status).toBe(200);
    expect(await createPairCode(store, kv, req)).toMatchObject({ status: 409, body: { code: 'replayed' } });
  });

  it('a computer of another handle is refused and the code survives; a member re-joining or a taken agent name does not use it', async () => {
    const { store, kv, registrar, first, second, stranger, handle } = await setup();
    await registerDevice(store, kv, regReq(stranger)); // stranger now has its own handle
    const code = (await createPairCode(store, kv, pairCodeReq(first))).body['code'] as string;
    expect(await redeemPairCode(store, kv, pairJoinReq(stranger, handle, code))).toMatchObject({ status: 409, body: { code: 'device_taken' } });
    expect(await redeemPairCode(store, kv, pairJoinReq(first, handle, code))).toMatchObject({ status: 200, body: { already: true } });
    expect(await redeemPairCode(store, kv, pairJoinReq(second, handle, code, 'mini'), Date.now(), registrar)).toMatchObject({ status: 409, body: { code: 'agent_taken' } });
    expect((await redeemPairCode(store, kv, pairJoinReq(second, handle, code, 'air'), Date.now(), registrar)).status).toBe(200);
  });

  it('two computers racing for one code (serialised): exactly one joins', async () => {
    const { store, kv, first, handle } = await setup();
    const serial = serialiser();
    const code = (await createPairCode(store, kv, pairCodeReq(first))).body['code'] as string;
    const racers = devices(5);
    const results = await Promise.all(racers.map((d) => serial(() => redeemPairCode(store, kv, pairJoinReq(d, handle, code)))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await devicesOfHandle(kv, handle)).toHaveLength(2);
  });
});

describe('relay: invites still work, reserved names, nicknames, admin release, old data', () => {
  it('an old-style invite join (no handle field) goes through redeemJoin unchanged and records the handle', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const [dev] = devices(1);
    const code = (await createInviteRecord(store, { handle: 'kai' })).body['code'] as string;
    const ts = Date.now();
    const r = await redeemJoin(store, kv, { code, cert: cert(dev!), ts, sig: signJoin(dev!, ts, code), name: 'mbp' });
    expect(r).toEqual({ status: 200, body: { id: dev!.id, handle: 'kai', name: 'mbp' } });
    expect(await handleClaim(store, 'kai')).toMatchObject({ via: 'invite' });
    expect(await createInviteRecord(store, { handle: 'Admin' })).toMatchObject({ status: 400, body: { code: 'reserved_handle' } });
    expect(await createInviteRecord(store, { handle: 'support' })).toMatchObject({ status: 400, body: { code: 'reserved_handle' } });
    expect(await createInviteRecord(store, { handle: 'boss' }, Date.now(), [...RESERVED_HANDLES, 'boss'])).toMatchObject({ status: 400 });
  });

  it('data written by the previous relay (KV allowlist, AgentBook, InviteBook) keeps working next to the new keys', async () => {
    // KV exactly as the ADR-032/033 relay wrote it, and an AgentBook with agents + default but no profile
    const kv = new MemKV();
    kv.m.set('MINI000-AAAAAAA', JSON.stringify({ handle: 'mei', name: 'mac-mini', addedAt: '2026-10-20T00:00:00Z', via: 'invite:3f9a1c2b7d4e' }));
    kv.m.set('AIR0000-BBBBBBB', JSON.stringify({ handle: 'mei', name: 'air', addedAt: '2026-10-20T00:00:00Z', via: 'invite:aaaaaaaaaaaa' }));
    kv.m.set('@mei', JSON.stringify(['MINI000-AAAAAAA', 'AIR0000-BBBBBBB']));
    const agents = new MemStorage();
    agents.m.set('agent:mini', { agent: 'mini', device: 'MINI000-AAAAAAA', addedAt: 1 });
    agents.m.set('agent:air', { agent: 'air', device: 'AIR0000-BBBBBBB', addedAt: 2 });
    agents.m.set('default', 'mini');
    const store = new MemStorage();
    const live = await createInviteRecord(store, { handle: 'mei', uses: 2 });

    expect(await devicesOfHandle(kv, 'mei')).toEqual(['MINI000-AAAAAAA', 'AIR0000-BBBBBBB']);
    expect(await getNickname(agents)).toBeNull();
    expect(await listAgents(agents)).toMatchObject({ default: 'mini', agents: [{ agent: 'mini' }, { agent: 'air' }] });
    expect(await setNicknameRecord(agents, { nickname: '  小美 ', device: 'MINI000-AAAAAAA' })).toMatchObject({ status: 200, body: { nickname: '小美' } });
    expect(await resolveAgent(agents)).toMatchObject({ agent: 'mini' }); // the profile key does not disturb the directory
    expect((await listAgents(agents)).agents).toHaveLength(2);
    // the old invite is still redeemable through the new join dispatcher
    const [pro] = devices(1);
    const ts = Date.now();
    const code = live.body['code'] as string;
    expect(await redeemJoin(store, kv, { code, cert: cert(pro!), ts, sig: signJoin(pro!, ts, code) })).toMatchObject({ status: 200, body: { handle: 'mei' } });
    expect(await devicesOfHandle(kv, 'mei')).toHaveLength(3);
    // and a readable handle in KV is never drawn (it is not even the random shape), nor can a pairing code be faked for it
    expect(await redeemPairCode(store, kv, pairJoinReq(devices(1)[0]!, 'mei', 'abcde-fghjk'))).toMatchObject({ status: 404 });
  });

  it('nicknames: normalised the same on client and relay; set, change, clear', async () => {
    for (const [raw, want] of [
      ['  小美  ', '小美'],
      ['a\nb\tc', 'a b c'],
      ['x‮evil', 'x evil'],
      ['🙂'.repeat(40), '🙂'.repeat(32)],
      ['', ''],
    ] as const) {
      expect(relayNickname(raw)).toBe(want);
      expect(normalizeNickname(raw)).toBe(want);
    }
    expect(relayNickname(42)).toBeNull();
    const s = new MemStorage();
    expect((await setNicknameRecord(s, { nickname: 'Yu', device: 'D' })).body).toEqual({ nickname: 'Yu' });
    expect((await setNicknameRecord(s, { nickname: '小美', device: 'D' })).body).toEqual({ nickname: '小美' });
    expect(await getNickname(s)).toBe('小美');
    expect((await setNicknameRecord(s, { nickname: '', device: 'D' })).body).toEqual({ nickname: null });
    expect(await getNickname(s)).toBeNull();
    expect(await setNicknameRecord(s, { nickname: 7, device: 'D' })).toMatchObject({ status: 400 });
    const [dev] = devices(1);
    const ts = Date.now();
    expect(await verifyProfile(cert(dev!), ts, '小美', signProfile(dev!, ts, '小美'))).toBe(dev!.id);
    expect(await verifyProfile(cert(dev!), ts, 'someone else', signProfile(dev!, ts, '小美'))).toBeNull();
  });

  it('admin release: devices leave the allowlist, the pairing code dies, the AgentBook is wiped, the random handle is never reissued', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const { book, registrar } = agentBooks(kv);
    const [a, b, c] = devices(3);
    const handle = (await registerDevice(store, kv, regReq(a!, 'mini'), { agents: registrar })).body['handle'] as string;
    const code = (await createPairCode(store, kv, pairCodeReq(a!))).body['code'] as string;
    await redeemPairCode(store, kv, pairJoinReq(b!, handle, code));
    await setNicknameRecord(book(handle), { nickname: 'Lost', device: a!.id });
    const code2 = (await createPairCode(store, kv, pairCodeReq(a!))).body['code'] as string;

    const r = await releaseHandle(store, kv, handle);
    expect(r).toEqual({ handle, devices: [a!.id, b!.id] });
    expect(await resetBook(book(handle))).toEqual(['mini']);
    expect(await allowEntry(kv, a!.id)).toBeNull();
    expect(await devicesOfHandle(kv, handle)).toEqual([]);
    expect(kv.m.has(`@${handle}`)).toBe(false);
    expect(await getNickname(book(handle))).toBeNull();
    expect(await redeemPairCode(store, kv, pairJoinReq(c!, handle, code2))).toMatchObject({ status: 404 });
    expect(await handleClaim(store, handle)).toMatchObject({ releasedAt: expect.any(Number) });
    expect(await handleInUse(store, kv, handle)).toBe(true);
    // the freed devices may register again (they get a NEW random handle)
    const again = await registerDevice(store, kv, regReq(a!), { rand: scripted(handle) });
    expect(again.status).toBe(200);
    expect(again.body['handle']).not.toBe(handle);
    // a released readable handle can be given out again by an admin invite
    await putDevice(kv, 'OLD0000-CCCCCCC', { handle: 'lin' });
    await releaseHandle(store, kv, 'lin');
    const inv = (await createInviteRecord(store, { handle: 'lin' })).body['code'] as string;
    const ts = Date.now();
    expect(await redeemJoin(store, kv, { code: inv, cert: cert(c!), ts, sig: signJoin(c!, ts, inv) })).toMatchObject({ status: 200, body: { handle: 'lin' } });
    expect(await handleClaim(store, 'lin')).not.toHaveProperty('releasedAt');
  });
});
