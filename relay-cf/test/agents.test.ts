import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allowEntry, type AllowKV } from '../src/allowlist.js';
import { dropDevice, listAgents, registerAgent, removeAgent, renameAgent, resolveAgent, setDefaultAgent, type AgentStorage } from '../src/agents.js';
import { verifyAgentOp, verifyJoin } from '../src/crypto.js';
import { createInvite as createInviteRecord, redeemInvite, type AgentRegistrar } from '../src/invites.js';
import { normalizeAgent } from '../src/protocol.js';
import { normalizeAgentName, signAgentOp } from '../../src/cluster/agents.js';
import { loadOrCreateIdentity, type DeviceIdentity } from '../../src/cluster/identity.js';
import { signJoin } from '../../src/cluster/join.js';

/**
 * Server side (not part of the public client). One address per agent (ADR-033):
 * relay-cf/src/agents.ts (the AgentBook logic) runs here against a Map. The client
 * side (test/morse-agents.test.ts) runs against test/helpers/fake-relay.ts; the
 * real Worker is covered by scripts/morse-e2e-agents.sh.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-agents-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

class MemStorage implements AgentStorage {
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

const member = (set: Set<string>) => async (d: string) => set.has(d);
const cert = (id: DeviceIdentity) => new X509Certificate(id.certPem).raw.toString('base64');

describe('agent names: client and relay agree', () => {
  it('a-z 0-9 -, 1–32, no leading/trailing dash, not user/inbox', () => {
    for (const ok of ['mini', 'air', 'macbook-air', 'a', 'x1', 'a'.repeat(32)]) {
      expect(normalizeAgentName(ok)).toBe(ok);
      expect(normalizeAgent(ok)).toBe(ok);
    }
    for (const bad of ['', '-air', 'air-', 'a_b', 'a.b', 'a/b', 'user', 'inbox', 'a'.repeat(33), '中文']) {
      expect(normalizeAgentName(bad)).toBeNull();
      expect(normalizeAgent(bad)).toBeNull();
    }
  });
});

describe('relay-cf agent directory (AgentBook logic)', () => {
  it('first agent is the default; names are unique per person; same device re-adding is harmless', async () => {
    const s = new MemStorage();
    const devs = new Set(['D1', 'D2']);
    expect((await registerAgent(s, { agent: 'Mini', device: 'D1' }, member(devs), { now: 1 })).body).toMatchObject({ agent: 'mini', default: 'mini' });
    expect((await registerAgent(s, { agent: 'air', device: 'D2' }, member(devs), { now: 2 })).body).toMatchObject({ agent: 'air', default: 'mini' });
    expect(await registerAgent(s, { agent: 'air', device: 'D1' }, member(devs))).toMatchObject({ status: 409, body: { code: 'agent_taken' } });
    expect(await registerAgent(s, { agent: 'air', device: 'D2' }, member(devs))).toMatchObject({ status: 200, body: { already: true } });
    expect(await registerAgent(s, { agent: 'bad name', device: 'D2' }, member(devs))).toMatchObject({ status: 400, body: { code: 'bad_agent' } });
    expect(await registerAgent(s, { agent: 'pro', device: 'D2' }, member(devs), { dryRun: true })).toMatchObject({ status: 200, body: { available: true } });
    expect(await resolveAgent(s, 'pro')).toBeNull(); // dry run wrote nothing
    expect(await resolveAgent(s)).toMatchObject({ agent: 'mini', device: 'D1' });
    expect(await resolveAgent(s, 'AIR')).toMatchObject({ agent: 'air', device: 'D2' });
    expect(await resolveAgent(s, 'nope')).toBeNull();
    expect((await listAgents(s)).agents.map((a) => a.agent)).toEqual(['mini', 'air']);
  });

  it('default can be changed; removing the default moves it to the earliest remaining agent', async () => {
    const s = new MemStorage();
    const devs = new Set(['D1', 'D2']);
    await registerAgent(s, { agent: 'mini', device: 'D1' }, member(devs), { now: 1 });
    await registerAgent(s, { agent: 'air', device: 'D2' }, member(devs), { now: 2 });
    await registerAgent(s, { agent: 'pro', device: 'D2' }, member(devs), { now: 3 });
    expect((await setDefaultAgent(s, { agent: 'pro' })).body).toMatchObject({ default: 'pro' });
    expect((await setDefaultAgent(s, { agent: 'ghost' })).status).toBe(404);
    expect(await removeAgent(s, { agent: 'pro', device: 'D1' })).toMatchObject({ status: 403, body: { code: 'not_your_agent' } });
    expect((await removeAgent(s, { agent: 'pro', device: 'D2' })).body).toMatchObject({ removed: true, default: 'mini' });
    expect((await removeAgent(s, { agent: 'pro', device: 'D2' })).status).toBe(404);
    expect((await removeAgent(s, { agent: 'mini', device: 'D1' })).body).toMatchObject({ default: 'air' });
    expect((await removeAgent(s, { agent: 'air', device: 'D2' })).body).toMatchObject({ default: null });
    expect(await resolveAgent(s)).toBeNull();
  });

  it('rename: atomic, old name gone, default follows, new name must be free, only the hosting device may', async () => {
    const s = new MemStorage();
    const devs = new Set(['D1', 'D2']);
    await registerAgent(s, { agent: 'mini', device: 'D1' }, member(devs), { now: 1 });
    await registerAgent(s, { agent: 'air', device: 'D2' }, member(devs), { now: 2 });
    expect(await renameAgent(s, { agent: 'air', to: 'mini', device: 'D2' }, member(devs))).toMatchObject({ status: 409, body: { code: 'agent_taken' } });
    expect(await renameAgent(s, { agent: 'air', to: 'x', device: 'D1' }, member(devs))).toMatchObject({ status: 403 });
    expect(await renameAgent(s, { agent: 'ghost', to: 'x', device: 'D1' }, member(devs))).toMatchObject({ status: 404 });
    expect(await renameAgent(s, { agent: 'air', to: 'no good', device: 'D2' }, member(devs))).toMatchObject({ status: 400 });
    expect((await renameAgent(s, { agent: 'air', to: 'macbook-air', device: 'D2' }, member(devs))).body).toMatchObject({ agent: 'macbook-air', from: 'air', default: 'mini' });
    expect(await resolveAgent(s, 'air')).toBeNull();
    expect(await resolveAgent(s, 'macbook-air')).toMatchObject({ device: 'D2', addedAt: 2 });
    expect((await renameAgent(s, { agent: 'mini', to: 'mac-mini', device: 'D1' }, member(devs))).body).toMatchObject({ default: 'mac-mini' });
    expect(await resolveAgent(s)).toMatchObject({ agent: 'mac-mini', device: 'D1' });
    expect([...s.m.keys()].sort()).toEqual(['agent:mac-mini', 'agent:macbook-air', 'default']);
  });

  it('a name held by a device that left the allowlist can be taken over; dropDevice frees its names', async () => {
    const s = new MemStorage();
    const devs = new Set(['OLD', 'NEW']);
    await registerAgent(s, { agent: 'mini', device: 'OLD' }, member(devs), { now: 1 });
    await registerAgent(s, { agent: 'spare', device: 'OLD' }, member(devs), { now: 2 });
    expect((await registerAgent(s, { agent: 'mini', device: 'NEW' }, member(devs))).status).toBe(409);
    devs.delete('OLD'); // e.g. the computer was wiped and an admin removed the old device
    expect((await registerAgent(s, { agent: 'mini', device: 'NEW' }, member(devs))).body).toMatchObject({ tookOver: 'OLD', default: 'mini' });
    expect(await dropDevice(s, 'OLD')).toEqual(['spare']);
    expect((await listAgents(s)).agents.map((a) => [a.agent, a.device])).toEqual([['mini', 'NEW']]);
  });

  it('agents are listed in the order they were registered — also when several register in the same millisecond', async () => {
    const s = new MemStorage();
    const devs = new Set(['D1', 'D2', 'D3']);
    // the same time for all three: alphabetical order would be air, mini, pro
    for (const [agent, device] of [['pro', 'D1'], ['mini', 'D2'], ['air', 'D3']] as const) {
      expect((await registerAgent(s, { agent, device }, member(devs), { now: 1_000 })).status).toBe(200);
    }
    expect((await listAgents(s)).agents.map((a) => a.agent)).toEqual(['pro', 'mini', 'air']);
    expect((await listAgents(s)).agents.map((a) => a.addedAt)).toEqual([1_000, 1_001, 1_002]);
    // the default falls to the earliest remaining one
    expect((await removeAgent(s, { agent: 'pro', device: 'D1' })).body).toMatchObject({ default: 'mini' });
  });
});

describe('signatures (Node signs, the Worker verifies)', () => {
  it('agent ops and joins with an agent', async () => {
    const me = loadOrCreateIdentity(freshHome());
    const other = loadOrCreateIdentity(freshHome());
    const ts = Date.now();
    expect(await verifyAgentOp(cert(me), ts, 'rename', 'air', 'macbook-air', signAgentOp(me, ts, 'rename', 'air', 'macbook-air'))).toBe(me.id);
    expect(await verifyAgentOp(cert(me), ts, 'rename', 'air', 'other', signAgentOp(me, ts, 'rename', 'air', 'macbook-air'))).toBeNull();
    expect(await verifyAgentOp(cert(me), ts, 'list', '', '', signAgentOp(other, ts, 'list'))).toBeNull();
    expect(await verifyJoin(cert(me), ts, 'c'.repeat(32), signJoin(me, ts, 'c'.repeat(32), 'mini'), 'mini')).toBe(me.id);
    expect(await verifyJoin(cert(me), ts, 'c'.repeat(32), signJoin(me, ts, 'c'.repeat(32), 'mini'), 'air')).toBeNull(); // the agent is signed
    expect(await verifyJoin(cert(me), ts, 'c'.repeat(32), signJoin(me, ts, 'c'.repeat(32)))).toBe(me.id);
  });
});

describe('join registers this computer\'s agent (invites + AgentBook logic)', () => {
  const setup = () => {
    const store = new MemStorage();
    const kv = new MemKV();
    const books = new Map<string, MemStorage>();
    const agents: AgentRegistrar = {
      register: async (handle, agent, device, dryRun) => {
        const book = books.get(handle) ?? new MemStorage();
        books.set(handle, book);
        return registerAgent(book, { agent, device }, async (d) => (await allowEntry(kv, d))?.handle === handle, { dryRun });
      },
    };
    return { store, kv, books, agents };
  };
  const req = (id: DeviceIdentity, code: string, agent?: string) => {
    const ts = Date.now();
    return { code, cert: cert(id), ts, sig: signJoin(id, ts, code, agent), ...(agent ? { agent } : {}) };
  };

  it('the agent lands on the joining device; a taken name refuses the join WITHOUT spending the invite', async () => {
    const { store, kv, books, agents } = setup();
    const code = (await createInviteRecord(store, { handle: 'mei', uses: 3 })).body['code'] as string;
    const [mini, air, pro] = [1, 2, 3].map(() => loadOrCreateIdentity(freshHome()));
    expect((await redeemInvite(store, kv, req(mini!, code, 'mini'), Date.now(), agents)).body).toMatchObject({ handle: 'mei', agent: 'mini' });
    expect((await redeemInvite(store, kv, req(air!, code, 'air'), Date.now(), agents)).body).toMatchObject({ agent: 'air' });
    const taken = await redeemInvite(store, kv, req(pro!, code, 'air'), Date.now(), agents);
    expect(taken).toMatchObject({ status: 409, body: { code: 'agent_taken' } });
    expect(await allowEntry(kv, pro!.id)).toBeNull(); // not joined…
    expect((await redeemInvite(store, kv, req(pro!, code, 'pro'), Date.now(), agents)).body).toMatchObject({ agent: 'pro' }); // …and the use was still there
    expect((await listAgents(books.get('mei')!)).agents.map((a) => [a.agent, a.device])).toEqual([
      ['mini', mini!.id],
      ['air', air!.id],
      ['pro', pro!.id],
    ]);
    expect((await listAgents(books.get('mei')!)).default).toBe('mini');
    expect(await redeemInvite(store, kv, { ...req(pro!, code, 'pro'), agent: 'Bad Name' }, Date.now(), agents)).toMatchObject({ status: 400, body: { code: 'bad_agent' } });
    // an agent name swapped in transit no longer matches the signature
    expect(await redeemInvite(store, kv, { ...req(pro!, code, 'pro'), agent: 'evil' }, Date.now(), agents)).toMatchObject({ status: 401 });
  });
});
