import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildV2Home, fakeDevice, T0, type FakeDevice, type V2Home } from './helpers/v2-home.js';
import { completeContactSplit, type SplitDeps } from '../src/cluster/contact-split.js';
import type { AgentLocation, AliasEntry, HandleDevice } from '../src/cluster/relay-client.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { demotedDevices, effectiveTrust } from '../src/cluster/effective-trust.js';
import { pinnedAddresses } from '../src/identity/device-address.js';
import { resolveSendTarget } from '../src/commands/messaging.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { parseAttendantConfig, profileFor } from '../src/plugins/attendant/config.js';

/** (ADR-091) a contact still known by its old name cannot be written to: the line names the contact a string reached */
const reachesOldName = (mailbox: Parameters<typeof resolveSendTarget>[0], typed: string, remark: string) =>
  expect(() => resolveSendTarget(mailbox, typed, 'me')).toThrow(`${remark}: old names no longer work`);

/**
 * ADR-077 — the online half of the migration (src/cluster/contact-split.ts) on the migrated
 * v2 home of test/helpers/v2-home.ts, with the relay's answers faked: contacts by old handle
 * are split per address from the frozen alias table (else the v2 directory), own computers
 * become `self` contacts, and everything is safe to repeat or to interrupt.
 */

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const NOW = T0 + 86_400_000;
const migrated = () => {
  const h = buildV2Home(homes);
  const ctx = homeContactContext(h.home);
  const db = createDb(h.dbPath, { upTo: 4, ctx, morseDir: h.morseDir, now: () => NOW });
  return { h, db, mailbox: createMailbox(db, { ctx, now: () => NOW }) };
};
const hd = (d: FakeDevice, name = ''): HandleDevice => ({ id: d.id, name, bundle: d.bundle });

/** A relay directory: handle → agents (the first is the default) and their devices. */
type Directory = Record<string, Array<{ agent: string; device: FakeDevice; name?: string }>>;
const directoryOf = (h: V2Home, me: FakeDevice): Directory => ({
  bob: [{ agent: 'mbp', device: h.bob }],
  alice: [
    { agent: 'mini', device: h.aliceMini },
    { agent: 'air', device: h.aliceAir },
    { agent: 'codex', device: h.aliceMini }, // a second agent on her mini: the same address
  ],
  me: [
    { agent: 'mini', device: me, name: 'meideMac-mini' },
    { agent: 'codex', device: me },
    { agent: 'air', device: h.myAir, name: 'Yus-MacBook-Air' },
  ],
});
const depsFor = (h: V2Home, mailbox: Mailbox, dir: Directory, o: { aliases?: boolean; down?: boolean } = {}) => {
  const calls = { alias: 0, agent: 0, handle: 0 };
  const fail = () => {
    throw new Error('relay not connected');
  };
  const deps: SplitDeps = {
    contacts: mailbox.contacts,
    selfHandle: () => 'me',
    selfDeviceId: dir['me']![0]!.device.id,
    trust: createTrustStore(h.home),
    pinned: (id) => pinnedAddresses(h.home).get(id) ?? null,
    ...(o.aliases
      ? {
          lookupAlias: async (name: string): Promise<AliasEntry[]> => {
            calls.alias++;
            if (o.down) fail();
            return (dir[name] ?? []).map((a, i) => ({ name: i === 0 ? name : `${name}/${a.agent}`, address: a.device.address, agent: a.agent, ...(i === 0 ? { default: true as const } : {}) }));
          },
        }
      : {}),
    resolveAgent: async (handle, agent): Promise<AgentLocation | null> => {
      calls.agent++;
      if (o.down) fail();
      const list = dir[handle] ?? [];
      const hit = agent ? list.find((a) => a.agent === agent) : list[0];
      return hit ? { handle, agent: hit.agent, device: hd(hit.device, hit.name) } : null;
    },
    lookupHandle: async (handle) => {
      calls.handle++;
      if (o.down) fail();
      return [...new Map((dir[handle] ?? []).map((a) => [a.device.id, hd(a.device, a.name)])).values()];
    },
  };
  return { deps, calls };
};
const snapshot = (mailbox: Mailbox) => mailbox.contacts.list().map((c) => ({ ...c, updatedAt: 0, createdAt: 0 }));

describe('identity v3 phase 2: contacts split per address once the relay can be asked (ADR-077)', () => {
  for (const aliases of [true, false]) {
    it(`${aliases ? 'from the frozen alias table' : 'from the v2 directory (a relay without the alias table)'}: one contact per address, groups and blocks kept, own computers in group self; a second run changes nothing`, async () => {
      const { h, db, mailbox } = migrated();
      const me = fakeDevice(homes);
      const { deps, calls } = depsFor(h, mailbox, directoryOf(h, me), { aliases });
      const r = await completeContactSplit(deps);
      expect(r).toMatchObject({ done: 4, created: ['c:alice/air'], pending: 0, ownDevices: 1 });
      if (!aliases) expect(calls.alias).toBe(0);

      // alice = her default agent's address; her air is a contact of its own, same group, named the old way
      expect(mailbox.contacts.get('c:alice')).toMatchObject({ address: h.aliceMini.address, remark: 'alice', group: 'friend', split: 'done' });
      const air = mailbox.contacts.find('alice/air')!;
      expect(air).toMatchObject({ id: 'c:alice/air', handle: 'alice', agent: 'air', address: h.aliceAir.address, remark: 'alice/air', group: 'friend', state: 'active', inherits: 'alice', split: 'done' });
      // her codex is on the same computer as her mini: the same address, no third contact
      expect(mailbox.contacts.list().filter((c) => c.handle === 'alice').map((c) => c.id)).toEqual(['c:alice', 'c:alice/air']);
      expect(mailbox.contacts.byAddress(h.aliceAir.address)!.id).toBe('c:alice/air');
      // bob had his address already; eve and dave are unknown to the relay: checked, nothing split
      expect(mailbox.contacts.get('c:bob')).toMatchObject({ address: h.bob.address, split: 'done' });
      expect(mailbox.contacts.get('c:eve')).toMatchObject({ state: 'blocked', split: 'done', address: null });
      expect(mailbox.contacts.pendingSplits()).toEqual([]);
      // my air: the contact made offline now has its agent name — and is how I write to it
      expect(mailbox.contacts.byAddress(h.myAir.address)).toMatchObject({ handle: 'me', agent: 'air', remark: 'air', group: 'self', origin: 'own-device' });
      reachesOldName(mailbox, 'air', 'air');
      reachesOldName(mailbox, 'alice/air', 'alice/air');
      reachesOldName(mailbox, 'alice', 'alice');

      // history stays where it was (ADR-077 §4): nothing was moved
      expect(mailbox.history('c:alice').map((m) => m.id)).toEqual([h.ids['fromAliceMini'], h.ids['fromAliceAir'], h.ids['toAliceAir']]);
      expect(mailbox.history('c:alice/air')).toEqual([]);

      const after = snapshot(mailbox);
      expect(await completeContactSplit(depsFor(h, mailbox, directoryOf(h, me), { aliases }).deps)).toMatchObject({ done: 0, created: [], pending: 0, ownDevices: 0 });
      expect(snapshot(mailbox)).toEqual(after);
      db.close();
    });
  }

  it('after the split: mail is filed by the sender’s VERIFIED address — never by the agent name it claims; a reply in a thread started BEFORE the split still reaches the session (ADR-071); permissions follow', async () => {
    const { h, db, mailbox } = migrated();
    const me = fakeDevice(homes);
    await completeContactSplit(depsFor(h, mailbox, directoryOf(h, me), { aliases: true }).deps);
    /** What the transport does: the authenticated device picks the contact, the body only labels the agent. */
    const from = (sender: FakeDevice, claims: string, text: string, contextId?: string) => {
      const contactId = mailbox.contacts.filingContact({ address: sender.address, deviceId: sender.id }, 'alice', 'peer');
      return mailbox.send({ from: { agent: 'claude', sessionId: '', device: claims }, to: { agent: 'mini', sessionId: 'inbox' }, text, fromTier: 'peer', via: 'morse-relay', ...(contextId ? { contextId } : {}), ...(contactId ? { contactId } : {}) });
    };
    expect(from(h.aliceAir, 'alice/air', 'from her air').contactId).toBe('c:alice/air');
    expect(from(h.aliceMini, 'alice/mini', 'from her mini').contactId).toBe('c:alice');
    // a device cannot choose its contact by what it writes: her mini claiming to be "air", her air claiming "mini" or nothing
    expect(from(h.aliceMini, 'alice/air', 'mini says it is air').contactId).toBe('c:alice');
    expect(from(h.aliceAir, 'alice/mini', 'air says it is mini').contactId).toBe('c:alice/air');
    expect(from(h.aliceAir, 'alice', 'air names no agent').contactId).toBe('c:alice/air');
    expect(from(h.aliceMini, 'alice/brand-new', 'mini invents an agent').contactId).toBe('c:alice');
    // without a verified address (an old path that only knows the handle) it is the base contact — whatever is claimed
    expect(mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'alice/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'claimed only', fromTier: 'peer' }).contactId).toBe('c:alice');
    // an address filed under another name is not followed: bob's computer claiming to be alice's air
    expect(mailbox.contacts.filingContact({ address: h.aliceAir.address }, 'bob', 'peer')).toBeUndefined();
    // an invented agent name re-opens nothing (only a verified NEW address does)
    expect(mailbox.contacts.pendingSplits()).toEqual([]);
    // what WE address is ours to choose
    expect(mailbox.send({ from: { agent: 'claude', sessionId: 's-1' }, to: { agent: 'user', sessionId: '', device: 'alice/air' }, text: 'to her air' }).contactId).toBe('c:alice/air');

    // the question we sent to alice/air before the migration is filed under c:alice; her air answers now
    const asked = mailbox.getMessage(h.ids['toAliceAir']!)!;
    expect(asked.contactId).toBe('c:alice');
    const answer = from(h.aliceAir, 'alice/air', 'the answer', asked.contextId);
    expect(answer).toMatchObject({ contactId: 'c:alice/air', ownThread: true, to: { agent: 'claude', sessionId: 's-1' } });
    // someone else using that thread id gets nowhere
    const other = (device: string) => mailbox.send({ from: { agent: 'claude', sessionId: '', device }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'x', fromTier: 'peer', contextId: asked.contextId });
    expect(other('bob/mbp').ownThread).toBeFalsy();
    expect(other('eve').ownThread).toBeFalsy();

    // permissions: the group's profile, and settings written for the contact it was split from
    const ctx = { home: h.home, morseDir: h.morseDir };
    const air = mailbox.contacts.get('c:alice/air')!;
    const byGroup = parseAttendantConfig({ groups: { friend: { cwd: `${h.home}/work`, tools: ['Read'] } } }, ctx);
    expect(profileFor(byGroup, air)).toMatchObject({ group: 'friend', tools: ['Read'] });
    const byHandle = parseAttendantConfig({ groups: { friend: { cwd: `${h.home}/work` } }, contacts: { alice: { group: 'friend', tools: ['Grep'] } } }, ctx);
    expect(profileFor(byHandle, air)).toMatchObject({ tools: ['Grep'] });
    db.close();
  });

  it('relay answers are not trusted: only an address of a device paired here under that handle counts — each entry on its own; no address moves between contacts', async () => {
    const { h, db, mailbox } = migrated();
    const me = fakeDevice(homes);
    const stranger = fakeDevice(homes);
    // 1. an extra bogus entry next to real ones: a computer nobody paired here, listed as alice's "evil"
    // 2. an address that belongs to another contact (bob's computer), listed under alice as "bobs"
    const dir = directoryOf(h, me);
    dir['alice'] = [...dir['alice']!, { agent: 'evil', device: stranger }, { agent: 'bobs', device: h.bob }];
    for (const aliases of [true, false]) {
      // (the v2 directory is asked for the agent names seen here — make the bogus ones "seen")
      mailbox.contacts.seenAgent('c:alice', 'evil');
      mailbox.contacts.seenAgent('c:alice', 'bobs');
      const { deps } = depsFor(h, mailbox, dir, { aliases });
      const r = await completeContactSplit(deps);
      if (aliases) expect(r.created).toEqual(['c:alice/air']);
      expect(mailbox.contacts.list().filter((c) => c.handle === 'alice').map((c) => c.id)).toEqual(['c:alice', 'c:alice/air']);
      expect(mailbox.contacts.byAddress(stranger.address)).toBeNull();
      expect(mailbox.contacts.byAddress(h.bob.address)!.id).toBe('c:bob');
      expect(mailbox.contacts.get('c:bob')).toMatchObject({ address: h.bob.address });
    }
    // a relay that lists ONLY bogus addresses under a name changes nothing at all
    const liar: Directory = { ...directoryOf(h, me), alice: [{ agent: 'mini', device: stranger }, { agent: 'air', device: h.bob }] };
    const fresh = migrated();
    await completeContactSplit(depsFor(fresh.h, fresh.mailbox, { ...liar, bob: [{ agent: 'mbp', device: fresh.h.bob }] }, { aliases: true }).deps);
    expect(fresh.mailbox.contacts.get('c:alice')).toMatchObject({ address: null, split: 'done' });
    expect(fresh.mailbox.contacts.list().filter((c) => c.handle === 'alice')).toHaveLength(1);
    fresh.db.close();
    // the store itself refuses to move a recorded address, whoever asks
    expect(mailbox.contacts.applySplit('c:dave', [{ agent: 'x', address: h.bob.address, default: true }, { agent: 'y', address: h.aliceAir.address }])).toEqual([]);
    expect(mailbox.contacts.get('c:dave')).toMatchObject({ address: null });
    expect(mailbox.contacts.byAddress(h.aliceAir.address)!.id).toBe('c:alice/air');
    mailbox.contacts.seenAddress('c:dave', h.bob.address, h.bob.id);
    expect(mailbox.contacts.byAddress(h.bob.address)!.id).toBe('c:bob');
    db.close();
  });

  it('a generated remark never changes what a command reaches today: a colliding name gets another one', async () => {
    const { h, db, mailbox } = migrated();
    const me = fakeDevice(homes);
    // I call alice "bob-work"… and bob's handle is "bob"; and I call dave "alice" hm — the second is the collision:
    // "alice/air" typed today reaches the contact REMARKED alice, i.e. dave's handle path morse.im/dave/air
    mailbox.contacts.set('c:alice', { remark: 'Ally' });
    mailbox.contacts.set('c:dave', { remark: 'alice' });
    reachesOldName(mailbox, 'alice/air', 'alice'); // dave
    reachesOldName(mailbox, 'Ally/air', 'Ally');
    await completeContactSplit(depsFor(h, mailbox, directoryOf(h, me), { aliases: true }).deps);
    const air = mailbox.contacts.get('c:alice/air')!;
    expect(air.remark).toBe('Ally/air');
    // both strings still reach what they reached before the split
    reachesOldName(mailbox, 'alice/air', 'alice'); // dave, as before
    reachesOldName(mailbox, 'Ally/air', 'Ally/air'); // alice's air, as before

    // the other way round: her generated name would be someone else's handle path, or an existing remark
    const again = migrated();
    again.mailbox.contacts.set('c:alice', { remark: 'bob' }); // "bob/air" typed today = bob... no: the contact REMARKED bob = alice
    again.mailbox.contacts.set('c:bob', { remark: 'Bobby' });
    again.mailbox.contacts.set('c:dave', { remark: 'bob/air' }); // …and that exact remark is taken
    await completeContactSplit(depsFor(again.h, again.mailbox, directoryOf(again.h, me), { aliases: true }).deps);
    const hers = again.mailbox.contacts.get('c:alice/air')!;
    expect(hers.remark).toBe('alice/air'); // not "bob/air": taken — her own old path instead
    expect(again.mailbox.contacts.find('bob/air')!.id).toBe('c:dave');
    again.db.close();

    const third = migrated();
    third.mailbox.contacts.set('c:dave', { remark: 'D' });
    third.mailbox.contacts.set('c:alice', { remark: 'dave' }); // "dave/…" typed today means the contact REMARKED dave (= alice), not dave's handle
    await completeContactSplit(depsFor(third.h, third.mailbox, directoryOf(third.h, me), { aliases: true }).deps);
    expect(third.mailbox.contacts.get('c:alice/air')!.remark).toBe('dave/air'); // "dave" as a word means the contact remarked dave = alice: unchanged
    reachesOldName(third.mailbox, 'dave/air', 'dave/air'); // alice's air
    third.db.close();
    db.close();
  });

  it('removing a contact never raises trust, and only YOUR `contact add` brings a removed contact back (N1, N2); the trust check fails closed (N5a)', async () => {
    const { h, db, mailbox } = migrated();
    const me = fakeDevice(homes);
    await completeContactSplit(depsFor(h, mailbox, directoryOf(h, me), { aliases: true }).deps);
    const contacts = mailbox.contacts;
    const base = createTrustStore(h.home);
    const logs: string[] = [];
    const trust = effectiveTrust(base, demotedDevices(() => contacts, (l) => logs.push(l)));
    const air = contacts.byAddress(h.myAir.address)!;
    expect(trust.get(h.myAir.id)!.tier).toBe('owner');

    // moved out of group self: lowered — and it stays lowered when the contact is removed
    contacts.set(air.id, { group: 'colleague' });
    expect(contacts.isLowered(h.myAir.id)).toBe(true);
    expect(trust.get(h.myAir.id)!.tier).toBe('peer');
    contacts.remove(air.id);
    expect(contacts.byAddress(h.myAir.address)).toBeNull();
    expect(contacts.isLowered(h.myAir.id)).toBe(true);
    expect(trust.get(h.myAir.id)!.tier).toBe('peer');
    expect(trust.list().find((d) => d.id === h.myAir.id)!.tier).toBe('peer');
    // the migration does not make it again, nothing a sender does brings it back…
    expect((await completeContactSplit(depsFor(h, mailbox, directoryOf(h, me), { aliases: true }).deps)).ownDevices).toBe(0);
    expect(contacts.byAddress(h.myAir.address)).toBeNull();
    // …my own `contact add <its address>` does: default group, still lowered; back in group self = an owner again
    const back = contacts.restore(`morse.im/${h.myAir.address}`)!;
    expect(back).toMatchObject({ id: `a:${h.myAir.address}`, origin: 'own-device', group: 'other' });
    expect(contacts.ownDeviceOf(h.myAir.id)!.id).toBe(back.id);
    expect(trust.get(h.myAir.id)!.tier).toBe('peer');
    expect(contacts.restore(h.myAir.address)).toBeNull(); // nothing left to restore
    contacts.set(back.id, { group: 'self' });
    expect(contacts.isLowered(h.myAir.id)).toBe(false);
    expect(trust.get(h.myAir.id)!.tier).toBe('owner');
    // removed while in group self: it stays what it is (your own), and comes back in group self
    contacts.remove(back.id);
    expect(trust.get(h.myAir.id)!.tier).toBe('owner');
    expect(contacts.restore(h.myAir.address)).toMatchObject({ group: 'self', origin: 'own-device' });
    // trusted-devices.json was never rewritten for any of this
    expect(base.get(h.myAir.id)!.tier).toBe('owner');

    // a split contact I removed: back by its old path or its address — default group, none of its old settings
    contacts.set('c:alice/air', { group: 'vip', remark: 'her-air' });
    contacts.remove('c:alice/air');
    expect(contacts.restore('bob/air')).toBeNull();
    const hers = contacts.restore('morse.im/alice/air')!;
    expect(hers).toMatchObject({ id: 'c:alice/air', address: h.aliceAir.address, group: 'other', remark: 'alice/air', inherits: null, split: 'done' });
    expect(contacts.filingContact({ address: h.aliceAir.address }, 'alice', 'peer')).toBe('c:alice/air');
    contacts.remove('c:alice/air');
    expect(contacts.restore(h.aliceAir.address)!.id).toBe('c:alice/air');
    // an address nobody removed is not "restored" into existence
    expect(contacts.restore(fakeDevice(homes).address)).toBeNull();

    // N5a: the lookup fails (database busy): an owner reads as peer for that call, said once
    const broken = effectiveTrust(base, demotedDevices(() => ({ isLowered: () => { throw new Error('database is locked'); } }), (l) => logs.push(l)));
    expect(broken.get(h.myAir.id)!.tier).toBe('peer');
    expect(broken.get(h.studio.id)!.tier).toBe('peer');
    expect(broken.get(h.bob.id)!.tier).toBe('peer'); // (a peer stays a peer)
    expect(logs.filter((l) => /could not check whether your own computers are still in group self \(database is locked\)/.test(l))).toHaveLength(1);
    db.close();
  });

  it('settings written for a remark still apply to the contact split off it', async () => {
    const { h, db, mailbox } = migrated();
    mailbox.contacts.set('c:alice', { remark: 'Ally' });
    await completeContactSplit(depsFor(h, mailbox, directoryOf(h, fakeDevice(homes)), { aliases: true }).deps);
    const air = mailbox.contacts.find('Ally/air')!;
    expect(air).toMatchObject({ id: 'c:alice/air', inherits: 'Ally' });
    const s = parseAttendantConfig({ groups: { friend: { cwd: `${h.home}/work` } }, contacts: { ally: { group: 'friend', tools: ['Glob'] } } }, { home: h.home, morseDir: h.morseDir });
    expect(profileFor(s, air)).toMatchObject({ tools: ['Glob'] });
    db.close();
  });

  it('the relay cannot be asked: everything stays pending and works as before; the next run finishes', async () => {
    const { h, db, mailbox } = migrated();
    const me = fakeDevice(homes);
    const before = snapshot(mailbox);
    for (const aliases of [true, false]) {
      expect(await completeContactSplit(depsFor(h, mailbox, directoryOf(h, me), { aliases, down: true }).deps)).toMatchObject({ done: 0, created: [], pending: 4, ownDevices: 0 });
      expect(snapshot(mailbox)).toEqual(before);
    }
    expect(mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'alice/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'meanwhile', fromTier: 'peer' }).contactId).toBe('c:alice');
    expect(await completeContactSplit(depsFor(h, mailbox, directoryOf(h, me), { aliases: true }).deps)).toMatchObject({ done: 4, created: ['c:alice/air'], pending: 0 });
    db.close();
  });

  it('a name that means someone else on the relay is left alone; a removed contact is not made again', async () => {
    const { h, db, mailbox } = migrated();
    const me = fakeDevice(homes);
    const dir = directoryOf(h, me);
    // on the relay "bob" is another person's computer than the one paired here as bob
    const stranger = fakeDevice(homes);
    dir['bob'] = [{ agent: 'x', device: stranger }];
    await completeContactSplit(depsFor(h, mailbox, dir, { aliases: true }).deps);
    expect(mailbox.contacts.get('c:bob')).toMatchObject({ address: h.bob.address, split: 'done' });
    expect(mailbox.contacts.byAddress(stranger.address)).toBeNull();

    // I remove my air and her air from my contacts: neither comes back on the next run
    mailbox.contacts.remove(mailbox.contacts.byAddress(h.myAir.address)!.id);
    mailbox.contacts.remove('c:alice/air');
    expect(await completeContactSplit(depsFor(h, mailbox, dir, { aliases: true }).deps)).toMatchObject({ created: [], ownDevices: 0 });
    expect(mailbox.contacts.byAddress(h.myAir.address)?.origin ?? null).not.toBe('own-device');
    expect(mailbox.contacts.get('c:alice/air')).toBeNull();
    // mail from her air is simply alice's again — whatever agent name it shows, old or new
    const fromAir = (claims: string) => {
      const contactId = mailbox.contacts.filingContact({ address: h.aliceAir.address, deviceId: h.aliceAir.id }, 'alice', 'peer');
      return mailbox.send({ from: { agent: 'claude', sessionId: '', device: claims }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'x', fromTier: 'peer', ...(contactId ? { contactId } : {}) });
    };
    expect(fromAir('alice/air').contactId).toBe('c:alice');
    expect(fromAir('alice/air2').contactId).toBe('c:alice');
    // a new agent NAME does not bring the removed contact back, under any name: nothing is even re-checked
    expect(mailbox.contacts.pendingSplits()).toEqual([]);
    dir['alice'] = [...dir['alice']!, { agent: 'air2', device: h.aliceAir }];
    for (const aliases of [true, false]) expect((await completeContactSplit(depsFor(h, mailbox, dir, { aliases }).deps)).created).toEqual([]);
    expect(mailbox.contacts.list().filter((c) => c.handle === 'alice').map((c) => c.id)).toEqual(['c:alice']);

    // a VERIFIED new address is what creates a contact: alice pairs a third computer (trusted here, key from the relay)
    const pro = fakeDevice(homes);
    createTrustStore(h.home).add({ id: pro.id, name: 'alice', tier: 'peer' });
    mailbox.contacts.seenAddress('c:alice', pro.address, pro.id);
    expect(mailbox.contacts.pendingSplits().map((c) => c.id)).toEqual(['c:alice']);
    dir['alice'] = [...dir['alice']!, { agent: 'pro', device: pro }];
    expect((await completeContactSplit(depsFor(h, mailbox, dir, { aliases: true }).deps)).created).toEqual(['c:alice/pro']);
    expect(mailbox.contacts.get('c:alice/pro')).toMatchObject({ address: pro.address });
    expect(mailbox.contacts.get('c:alice/air')).toBeNull(); // still removed
    db.close();
  });
});
