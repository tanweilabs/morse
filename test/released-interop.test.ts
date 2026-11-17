import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releasedTree, RELEASED_COMMIT } from './helpers/released-tree.js';
import { startMorse, type Morse } from '../src/cluster/morse.js';
import { resolveSendTarget } from '../src/commands/messaging.js';
import { MINE_GROUP } from '../src/mailbox/contacts.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import type { MigrationReportV5 } from '../src/mailbox/migrate-v5.js';

/**
 * (ADR-091, stage 2) The client of this branch among the RELEASED clients (`RELEASED_COMMIT`, the line every user
 * runs: v2 and v3 side by side), on the released relay's stand-in: the home of the updated computer was written by
 * the released code itself — paired the old way with its own second computer, contacts by old name, mail both ways —
 * and is migrated by this branch when it opens; then it sends no v2 at all, and the two released peers exchange mail
 * with it both ways: one still writing to it by its OLD name (what a released client does for a contact it had by
 * old name), one by its address. Its own computer that stayed on the released code is an ordinary contact now.
 *
 * The released modules are imported from the released tree by absolute path (test/helpers/released-tree.ts); where
 * that tree cannot be had (a shallow clone), the test says so and is skipped.
 */

const tree = releasedTree();
const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-released-interop-'));
  homes.push(h);
  return h;
};

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/* eslint-disable @typescript-eslint/no-explicit-any -- the released modules are typed by the released tree */
type Old = Record<string, any>;
const old: Old = {};
const load = async (rel: string) => (await import(join(tree!, rel))) as Record<string, any>;

interface OldDev {
  home: string;
  id: string;
  address: string;
  mailbox: any;
  morse?: any;
  logs: string[];
  dbPath?: string;
  db?: any;
}

const session = { agent: 'claude', sessionId: 's-1' };
const inboxOf = (mailbox: any) => (mailbox.inbox({ all: true }) as any[]).filter((m) => m.direction === 'in');
const textIn = (mailbox: any, text: string) => inboxOf(mailbox).find((m: any) => m.parts[0]?.text === text);

describe.skipIf(!tree)(`this branch among clients of the release (${RELEASED_COMMIT}) — ADR-091 stage 2`, () => {
  let relay: any;
  const running: Array<{ stop: () => void }> = [];
  const url = () => `ws://127.0.0.1:${relay.port}`;

  beforeAll(async () => {
    old['relay'] = await load('test/helpers/fake-relay.ts');
    old['identity'] = await load('src/cluster/identity.ts');
    old['morse'] = await load('src/cluster/morse.ts');
    old['trust'] = await load('src/cluster/trust.ts');
    old['agents'] = await load('src/cluster/agents.ts');
    old['addressKey'] = await load('src/identity/address-key.ts');
    old['machineConfig'] = await load('src/machine-config.ts');
    old['db'] = await load('src/mailbox/db.ts');
    old['homeContext'] = await load('src/mailbox/home-context.ts');
    old['mailbox'] = await load('src/mailbox/mailbox.ts');
  }, 60_000);
  afterAll(async () => {
    running.splice(0).forEach((m) => m.stop());
    await relay?.close();
    homes.forEach((h) => rmSync(h, { recursive: true, force: true }));
  });

  /** A computer as the released code sets one up: its config names its old name and agent; the mailbox in a file when `file`. */
  const oldDev = (handle: string, agent: string, file = false): OldDev => {
    const home = freshHome();
    const identity = old['identity'].loadOrCreateIdentity(home);
    old['machineConfig'].updateMachineConfig((cfg: Record<string, unknown>) => {
      cfg['relay'] = { handle, agent, agents: [agent] };
    }, join(home, '.morse', 'config.json'));
    const ctx = old['homeContext'].homeContactContext(home);
    const dbPath = file ? join(home, '.morse', 'mailbox.db') : ':memory:';
    const db = old['db'].createDb(dbPath, { ctx });
    return { home, id: identity.id, address: old['addressKey'].loadPrimaryAddress(home, identity).address, mailbox: old['mailbox'].createMailbox(db, { ctx }), logs: [], ...(file ? { dbPath, db } : {}) };
  };
  const connectOld = (d: OldDev) => {
    d.morse = old['morse'].startMorse({ url: url(), home: d.home, mailbox: d.mailbox, receiptTimeoutMs: 3000, log: (l: string) => d.logs.push(l) });
    running.push(d.morse);
    return d.morse;
  };
  const stop = (m: { stop: () => void }) => {
    m.stop();
    running.splice(running.indexOf(m), 1);
  };
  /** What the outbox does: claim the row, hand it to Morse, mark it delivered when Morse says ok. */
  const sendOld = async (from: OldDev, to: string, text: string, contextId?: string) => {
    from.mailbox.send({ from: session, to: { agent: old['morse'].INBOX_AGENT, sessionId: '', device: to }, text, ...(contextId ? { contextId } : {}) });
    const c = from.mailbox.claimNextPending({ scope: 'outbound' });
    const r = await from.morse.send(to, c);
    if (r.ok) from.mailbox.markDelivered(c.id);
    return r as { ok: boolean; via?: string; error?: string };
  };
  const addAgent = async (d: OldDev, agent: string) => old['agents'].applyToLocal('add', await old['agents'].agentRequest({ url: url(), op: 'add', agent, home: d.home }), d.home);

  it('a home written by the released code is migrated when it opens; then mail goes both ways with two released peers — one writing to the old name, one to the address — and with its own computer still on the release, an ordinary contact now', async () => {
    // ---- the world as the release left it: sam (two computers: mini, which updates, and air, which does not),
    // kai and pia (one computer each, released); everyone paired the old way, contacts by old name
    const sam = oldDev('sam', 'mini', true);
    const air = oldDev('sam', 'air');
    const kai = oldDev('kai', 'kmini');
    const pia = oldDev('pia', 'pmini');
    relay = await old['relay'].startFakeRelay({
      port: 0,
      host: '127.0.0.1',
      v3: true,
      aliases: true,
      allowlist: [
        { id: sam.id, handle: 'sam', name: 'sam-mini' },
        { id: air.id, handle: 'sam', name: 'sam-air' },
        { id: kai.id, handle: 'kai' },
        { id: pia.id, handle: 'pia' },
      ],
      log: () => undefined,
    });
    await addAgent(sam, 'mini');
    await addAgent(air, 'air');
    await addAgent(kai, 'kmini');
    await addAgent(pia, 'pmini');
    const trust = (d: OldDev) => old['trust'].createTrustStore(d.home);
    trust(sam).add({ id: air.id, name: 'sam', tier: 'owner' });
    trust(air).add({ id: sam.id, name: 'sam', tier: 'owner' });
    for (const [a, b] of [[sam, kai], [sam, pia], [air, kai], [air, pia]] as const) {
      trust(a).add({ id: b.id, name: b === kai ? 'kai' : 'pia', tier: 'peer' });
      trust(b).add({ id: a.id, name: 'sam', tier: 'peer' });
    }
    sam.mailbox.contacts.ensure('kai');
    sam.mailbox.contacts.ensure('pia');
    kai.mailbox.contacts.ensure('sam');
    pia.mailbox.contacts.ensure('sam');
    for (const d of [sam, air, kai, pia]) connectOld(d);
    await until(() => [sam, air, kai, pia].every((d) => d.morse.client.connected() && Boolean(d.morse.v3Client?.()?.connected())));
    // the released code finishes its own migration (ADR-077: contacts per address) once online
    for (const d of [sam, kai, pia]) await d.morse.migrateContacts();
    await until(() => Boolean(sam.mailbox.contacts.byAddress(air.address)?.agent));
    // mail both ways, the old way: kai and sam, pia and sam; sam's air to sam (as its owner)
    expect(await sendOld(kai, 'sam', 'kai to sam, before')).toMatchObject({ ok: true });
    expect(await sendOld(sam, 'kai', 'sam to kai, before')).toMatchObject({ ok: true });
    expect(await sendOld(pia, 'sam', 'pia to sam, before')).toMatchObject({ ok: true });
    expect(await sendOld(air, 'sam/mini', 'air to mini, before')).toMatchObject({ ok: true });
    expect(textIn(sam.mailbox, 'air to mini, before')).toMatchObject({ contactId: 'self', fromTier: 'owner' });
    const before = { kai: sam.mailbox.contacts.find('kai').id as string, pia: sam.mailbox.contacts.find('pia').id as string };
    expect(sam.mailbox.contacts.get(before.kai)).toMatchObject({ handle: 'kai', address: kai.address });

    // ---- sam's mini updates to this branch: the released daemon stops; the new one opens the same home
    stop(sam.morse);
    sam.db.close();
    const reports: MigrationReportV5[] = [];
    const ctx = homeContactContext(sam.home);
    const db = createDb(sam.dbPath!, { ctx, onMigrateV5: (r) => reports.push(r) });
    const mailbox: Mailbox = createMailbox(db, { ctx });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ from: 4, to: 5, needAddress: 0 });
    expect(reports[0]!.converted).toBeGreaterThanOrEqual(3); // kai, pia and the air
    // kai and pia: contacts by address that remember the old name; the air: group mine, an ordinary contact
    expect(mailbox.contacts.get(before.kai)).toMatchObject({ handle: null, address: kai.address, oldName: 'kai' });
    expect(mailbox.contacts.get(before.pia)).toMatchObject({ handle: null, address: pia.address, oldName: 'pia' });
    const airContact = mailbox.contacts.byAddress(air.address)!;
    expect(airContact).toMatchObject({ handle: null, group: MINE_GROUP, origin: null, oldName: 'sam/air' });
    // nothing was lost
    expect(mailbox.history(before.kai).map((m) => m.parts[0]!.text)).toEqual(['kai to sam, before', 'sam to kai, before']);
    expect(mailbox.history(airContact.id).map((m) => m.parts[0]!.text)).toEqual(['air to mini, before']);

    const logs: string[] = [];
    const morse: Morse = startMorse({ url: url(), home: sam.home, mailbox, receiptTimeoutMs: 3000, connectWaitMs: 2000, log: (l) => logs.push(l) });
    running.push(morse);
    await until(() => Boolean(morse.v3Client?.()?.connected()));
    expect(morse.client.connected()).toBe(false); // no v2 login at all
    const sendNew = async (to: string, text: string, contextId?: string) => {
      const target = resolveSendTarget(mailbox, to);
      const m = mailbox.send({ from: session, to: { agent: 'user', sessionId: '', device: target }, text, ...(contextId ? { contextId } : {}) });
      const c = mailbox.claimNextPending({ scope: 'outbound' })!;
      expect(c.id).toBe(m.id);
      const r = await morse.send(target, c);
      if (r.ok) mailbox.markDelivered(c.id);
      return r;
    };

    // ---- kai (released) writes to sam's OLD name, as before; sam answers in the thread, by kai's remark
    expect(await sendOld(kai, 'sam', 'kai to sam, after')).toMatchObject({ ok: true });
    await until(() => Boolean(textIn(mailbox, 'kai to sam, after')));
    const fromKai = textIn(mailbox, 'kai to sam, after');
    expect(fromKai).toMatchObject({ contactId: before.kai, fromTier: 'peer' });
    expect(await sendNew('kai', 'sam to kai, after', fromKai.contextId)).toMatchObject({ ok: true });
    await until(() => Boolean(textIn(kai.mailbox, 'sam to kai, after')));
    expect(textIn(kai.mailbox, 'sam to kai, after')).toMatchObject({ fromTier: 'peer', contextId: fromKai.contextId });

    // ---- sam starts a thread with pia (by her remark); pia (released) answers by sam's ADDRESS
    expect(await sendNew('pia', 'sam to pia, after')).toMatchObject({ ok: true });
    await until(() => Boolean(textIn(pia.mailbox, 'sam to pia, after')));
    const atPia = textIn(pia.mailbox, 'sam to pia, after');
    expect(atPia).toMatchObject({ fromTier: 'peer' });
    expect(await sendOld(pia, `morse.im/${sam.address}`, 'pia to sam, by address', atPia.contextId)).toMatchObject({ ok: true });
    await until(() => Boolean(textIn(mailbox, 'pia to sam, by address')));
    // her answer is in sam's thread: back to the session that asked (ADR-071)
    expect(textIn(mailbox, 'pia to sam, by address')).toMatchObject({ contactId: before.pia, fromTier: 'peer', ownThread: true, to: session });

    // ---- sam's air stays on the release and writes to sam/mini as before: an ordinary contact's mail now
    expect(await sendOld(air, 'sam/mini', 'air to mini, after')).toMatchObject({ ok: true });
    await until(() => Boolean(textIn(mailbox, 'air to mini, after')));
    expect(textIn(mailbox, 'air to mini, after')).toMatchObject({ contactId: airContact.id, fromTier: 'peer' });
    expect(await sendNew('air', 'mini to air, after')).toMatchObject({ ok: true });
    await until(() => Boolean(textIn(air.mailbox, 'mini to air, after')));

    // the old way is gone from this computer: an old name it has no address for reaches nobody, in one line
    const nobody = mailbox.send({ from: session, to: { agent: 'user', sessionId: '', device: 'nobody' }, text: 'x' });
    expect(await morse.send('nobody', nobody)).toEqual({ ok: false, terminal: true, error: 'nobody: old names no longer work — ask for their 26-character address (morse address shows it)' });
    // and nothing went out the v2 way: every envelope this computer sent was a v3 one
    expect(logs.some((l) => /via relay \(v2|v1 envelope/.test(l))).toBe(false);
  }, 120_000);
});
