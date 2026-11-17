import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allowEntry, devicesOfHandle, type AllowKV } from '../src/allowlist.js';
import { verifyJoin } from '../src/crypto.js';
import {
  createInvite as createInviteRecord,
  listInvites as listInviteRecords,
  normalizeInviteCode as relayNormalize,
  redeemInvite,
  revokeInvite as revokeInviteRecord,
  type InviteStorage,
} from '../src/invites.js';
import { loadOrCreateIdentity, type DeviceIdentity } from '../../src/cluster/identity.js';
import { signJoin } from '../../src/cluster/join.js';

/**
 * Server side (not part of the public client). Invites (ADR-032):
 * relay-cf/src/invites.ts is runtime-agnostic, so it runs here against Map-backed
 * stand-ins for the Durable Object storage and Workers KV. The client side
 * (test/morse-invites.test.ts) runs against test/helpers/fake-relay.ts. The real
 * Worker is covered by scripts/morse-e2e-join.sh.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-inv-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

class MemStorage implements InviteStorage {
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
  failPuts = false;
  async get(k: string) {
    const v = this.m.get(k);
    return v === undefined ? null : JSON.parse(v);
  }
  async put(k: string, v: string) {
    if (this.failPuts) throw new Error('kv down');
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

const cert = (id: DeviceIdentity) => new X509Certificate(id.certPem).raw.toString('base64');
const joinReq = (id: DeviceIdentity, code: string, ts = Date.now(), signer: DeviceIdentity = id) => ({
  code,
  cert: cert(id),
  ts,
  sig: signJoin(signer, ts, relayNormalize(code) ?? code),
  name: 'test-box',
});

describe('relay-cf invites (storage logic)', () => {
  it('creates a one-use, 7-day invite by default; stores only the hash of the code', async () => {
    const store = new MemStorage();
    const now = 1_800_000_000_000;
    const r = await createInviteRecord(store, { handle: ' @Mei ', note: 'mac\nmini' }, now);
    expect(r.status).toBe(200);
    const code = r.body['code'] as string;
    expect(code).toMatch(/^[a-z2-7]{32}$/);
    expect(r.body).toMatchObject({ handle: 'mei', uses: 1, expiresAt: now + 7 * 86_400_000, createdAt: now, note: 'mac mini' });
    expect(JSON.stringify([...store.m])).not.toContain(code);
    expect([...store.m.keys()][0]).toMatch(/^inv:[0-9a-f]{64}$/);
    expect((await createInviteRecord(store, {})).status).toBe(400);
    expect((await createInviteRecord(store, { handle: 'x' })).body['code']).toBe('bad_handle');
    expect((await createInviteRecord(store, { handle: 'ab', uses: 0 })).body['code']).toBe('bad_uses');
    expect((await createInviteRecord(store, { handle: 'ab', uses: 101 })).body['code']).toBe('bad_uses');
    expect((await createInviteRecord(store, { handle: 'ab', ttlSec: 91 * 86_400 })).body['code']).toBe('bad_ttl');
    expect(new Set(await Promise.all([1, 2, 3].map(async () => (await createInviteRecord(store, { handle: 'ab' })).body['code']))).size).toBe(3);
  });

  it('redeem: the signature from the daemon (Node) verifies in the Worker (WebCrypto); device lands under the handle; one use is one use', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const code = (await createInviteRecord(store, { handle: 'kai' })).body['code'] as string;
    const dev = loadOrCreateIdentity(freshHome());
    const ts = Date.now();
    expect(await verifyJoin(cert(dev), ts, code, signJoin(dev, ts, code))).toBe(dev.id);

    const ok = await redeemInvite(store, kv, joinReq(dev, code.toUpperCase().replace(/(.{8})/g, '$1-')));
    expect(ok).toEqual({ status: 200, body: { id: dev.id, handle: 'kai', name: 'test-box' } });
    expect(await allowEntry(kv, dev.id)).toMatchObject({ handle: 'kai', name: 'test-box', via: expect.stringMatching(/^invite:[0-9a-f]{12}$/) });
    expect(await devicesOfHandle(kv, 'kai')).toEqual([dev.id]);
    expect(await listInviteRecords(store)).toEqual([]); // used up → deleted

    const other = loadOrCreateIdentity(freshHome());
    expect(await redeemInvite(store, kv, joinReq(other, code))).toMatchObject({ status: 404, body: { code: 'invite_invalid' } });
    expect(await allowEntry(kv, other.id)).toBeNull();
  });

  it('several uses: two devices of one person, the third is refused; list shows what is left; revoke', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const inv = (await createInviteRecord(store, { handle: 'lin', uses: 2 })).body;
    const [d1, d2, d3] = [1, 2, 3].map(() => loadOrCreateIdentity(freshHome()));
    expect((await redeemInvite(store, kv, joinReq(d1!, inv['code'] as string))).status).toBe(200);
    expect((await listInviteRecords(store)).map((i) => [i.id, i.uses])).toEqual([[inv['id'], 1]]);
    expect((await redeemInvite(store, kv, joinReq(d2!, inv['code'] as string))).status).toBe(200);
    expect((await redeemInvite(store, kv, joinReq(d3!, inv['code'] as string))).status).toBe(404);
    expect(await devicesOfHandle(kv, 'lin')).toEqual([d1!.id, d2!.id]);

    const again = (await createInviteRecord(store, { handle: 'lin' })).body;
    expect(await revokeInviteRecord(store, 'zz')).toBe(false);
    expect(await revokeInviteRecord(store, again['id'] as string)).toBe(true);
    expect((await redeemInvite(store, kv, joinReq(d3!, again['code'] as string))).status).toBe(404);
  });

  it('expired invites are refused and pruned', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const now = Date.now();
    const code = (await createInviteRecord(store, { handle: 'late', ttlSec: 60 }, now - 61_000)).body['code'] as string;
    const dev = loadOrCreateIdentity(freshHome());
    expect(await redeemInvite(store, kv, joinReq(dev, code), now)).toMatchObject({ status: 404, body: { code: 'invite_invalid' } });
    expect(store.m.size).toBe(0);
    await createInviteRecord(store, { handle: 'late', ttlSec: 60 }, now - 61_000);
    expect(await listInviteRecords(store, now)).toEqual([]);
    expect(store.m.size).toBe(0);
  });

  it('re-joining the same handle does not spend an invite; another handle is a conflict', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const dev = loadOrCreateIdentity(freshHome());
    const c1 = (await createInviteRecord(store, { handle: 'mei' })).body['code'] as string;
    expect((await redeemInvite(store, kv, joinReq(dev, c1))).status).toBe(200);
    const c2 = (await createInviteRecord(store, { handle: 'mei' })).body['code'] as string;
    expect(await redeemInvite(store, kv, joinReq(dev, c2))).toMatchObject({ status: 200, body: { handle: 'mei', already: true } });
    expect((await listInviteRecords(store)).map((i) => i.uses)).toEqual([1]); // c2 still unused
    const c3 = (await createInviteRecord(store, { handle: 'someone' })).body['code'] as string;
    expect(await redeemInvite(store, kv, joinReq(dev, c3))).toMatchObject({ status: 409, body: { code: 'device_taken' } });
    expect((await allowEntry(kv, dev.id))?.handle).toBe('mei');
  });

  it('refuses a forged signature, a stale or future timestamp, junk; refunds the use when KV fails', async () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const code = (await createInviteRecord(store, { handle: 'bob' })).body['code'] as string;
    const dev = loadOrCreateIdentity(freshHome());
    const thief = loadOrCreateIdentity(freshHome());
    // someone else's certificate with my signature: cannot enrol a device whose key I do not hold
    expect(await redeemInvite(store, kv, joinReq(dev, code, Date.now(), thief))).toMatchObject({ status: 401, body: { code: 'bad_signature' } });
    expect(await redeemInvite(store, kv, joinReq(dev, code, Date.now() - 11 * 60_000))).toMatchObject({ status: 400, body: { code: 'clock_skew' } });
    expect(await redeemInvite(store, kv, joinReq(dev, code, Date.now() + 11 * 60_000))).toMatchObject({ status: 400, body: { code: 'clock_skew' } });
    expect(await redeemInvite(store, kv, null)).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await redeemInvite(store, kv, { ...joinReq(dev, code), code: 'short' })).toMatchObject({ status: 404 });
    expect((await listInviteRecords(store))[0]!.uses).toBe(1); // none of that spent it

    kv.failPuts = true;
    expect(await redeemInvite(store, kv, joinReq(dev, code))).toMatchObject({ status: 503 });
    expect((await listInviteRecords(store))[0]!.uses).toBe(1); // refunded
    kv.failPuts = false;
    expect((await redeemInvite(store, kv, joinReq(dev, code))).status).toBe(200);
  });
});
