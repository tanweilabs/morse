import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadOrCreateEncKey, makeKeyBundle } from '../../src/cluster/e2e.js';
import { loadOrCreateIdentity } from '../../src/cluster/identity.js';
import { loadPrimaryAddress } from '../../src/identity/address-key.js';
import { createDb } from '../../src/mailbox/db.js';
import { homeContactContext } from '../../src/mailbox/home-context.js';
import { createMailbox } from '../../src/mailbox/mailbox.js';

/**
 * A realistic ~/.morse as a client BEFORE identity v3 phase 2 leaves it (ADR-077 tests):
 * config.json, trusted-devices.json, peer-keys.json, morse-blocked.json with real device
 * certificates, and a mailbox.db at user_version 2 whose `contacts` table has the shipped v2
 * shape (handle UNIQUE, no address columns). The rows are written by the product's own code
 * paths, then the contacts table is put back into its v2 shape.
 */

/** The `contacts` table exactly as schema v2 (ADR-049) created it. */
export const CONTACTS_V2_DDL = `
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE,
  remark TEXT,
  nickname TEXT,
  group_label TEXT NOT NULL DEFAULT 'other',
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'blocked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX contacts_remark ON contacts(lower(remark)) WHERE remark IS NOT NULL;
`;

export interface FakeDevice {
  home: string;
  id: string;
  address: string;
  bundle: ReturnType<typeof makeKeyBundle>;
}

/** A device of someone else (or another computer of ours): its own home, identity and key bundle. */
export function fakeDevice(homes: string[]): FakeDevice {
  const home = mkdtempSync(join(tmpdir(), 'morse-p2-dev-'));
  homes.push(home);
  const identity = loadOrCreateIdentity(home);
  return { home, id: identity.id, address: loadPrimaryAddress(home, identity).address, bundle: makeKeyBundle(identity, loadOrCreateEncKey(home)) };
}

export interface V2Home {
  home: string;
  morseDir: string;
  dbPath: string;
  bob: FakeDevice;
  aliceMini: FakeDevice;
  aliceAir: FakeDevice;
  myAir: FakeDevice;
  studio: FakeDevice;
  /** Message ids by a short label. */
  ids: Record<string, string>;
}

export const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);

/** Put a v3-shaped database back into the shipped v2 shape (contacts table, marks, version). */
export function downgradeToV2(path: string): void {
  const db = new Database(path);
  db.exec('BEGIN');
  db.exec('ALTER TABLE contacts RENAME TO contacts_new');
  db.exec('DROP INDEX IF EXISTS contacts_remark; DROP INDEX IF EXISTS contacts_handle_agent; DROP INDEX IF EXISTS contacts_address;');
  db.exec(CONTACTS_V2_DDL);
  // (rows the v3 code made on the way — own computers as contacts — did not exist in v2)
  db.exec(`INSERT INTO contacts SELECT id, handle, remark, nickname, group_label, state, created_at, updated_at FROM contacts_new WHERE id NOT LIKE 'a:%'`);
  db.exec(`DELETE FROM contact_addresses WHERE contact_id LIKE 'a:%'`);
  db.exec('DROP TABLE contacts_new; DROP TABLE IF EXISTS migration_marks;');
  db.exec('COMMIT');
  db.pragma('user_version = 2');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

/**
 * me (handle `me`) on this computer (agents mini + codex), another computer of mine under
 * the same handle (air), one paired by device ID in the LAN era (studio); bob — one
 * computer, remark Bobby, group colleague, with attendant permissions; alice — two computers
 * (mini, air), no remark, group friend; eve — blocked; carol — a pending message request.
 */
export function buildV2Home(homes: string[]): V2Home {
  const home = mkdtempSync(join(tmpdir(), 'morse-p2-home-'));
  homes.push(home);
  const morseDir = join(home, '.morse');
  mkdirSync(morseDir, { recursive: true });
  loadOrCreateIdentity(home);
  mkdirSync(join(home, 'work'));
  const [bob, aliceMini, aliceAir, myAir, studio] = [fakeDevice(homes), fakeDevice(homes), fakeDevice(homes), fakeDevice(homes), fakeDevice(homes)];
  writeFileSync(
    join(morseDir, 'config.json'),
    `${JSON.stringify(
      {
        relay: { url: 'ws://127.0.0.1:9', handle: 'me', agent: 'mini', agents: ['mini', 'codex'] },
        plugins: {
          attendant: {
            groups: { colleague: { cwd: join(home, 'work'), tools: ['Read', 'Grep'] } },
            contacts: { bobby: { group: 'colleague', tools: ['Read'] } },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const dev = (d: FakeDevice, name: string, tier: 'owner' | 'peer') => ({ id: d.id, name, tier, addedAt: T0 });
  writeFileSync(
    join(morseDir, 'trusted-devices.json'),
    `${JSON.stringify({ devices: [dev(bob, 'bob', 'peer'), dev(aliceMini, 'alice', 'peer'), dev(aliceAir, 'alice', 'peer'), dev(myAir, 'me', 'owner'), dev(studio, 'studio', 'owner')] }, null, 2)}\n`,
  );
  writeFileSync(join(morseDir, 'peer-keys.json'), `${JSON.stringify(Object.fromEntries([bob, aliceMini, aliceAir, myAir, studio].map((d) => [d.id, d.bundle])), null, 2)}\n`);
  writeFileSync(join(morseDir, 'morse-blocked.json'), `${JSON.stringify({ handles: ['eve'] }, null, 2)}\n`);

  const dbPath = join(morseDir, 'mailbox.db');
  let t = T0;
  const now = () => (t += 1000);
  const ctx = homeContactContext(home);
  const db = createDb(dbPath, { upTo: 4, ctx, now });
  const mb = createMailbox(db, { ctx, now });
  const ids: Record<string, string> = {};
  const session = { agent: 'claude', sessionId: 's-1' };
  // history with bob, both ways, one delivered with a receipt
  ids['toBob'] = mb.send({ from: session, to: { agent: 'user', sessionId: '', device: 'bob' }, text: 'hi bob' }).id;
  mb.markDelivered(mb.claimNextPending({ scope: 'outbound' })!.id);
  mb.markReceipt(ids['toBob']);
  ids['fromBob'] = mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'hi me', fromTier: 'peer', via: 'morse-relay' }).id;
  // alice: mail from both of her agents, and a thread WE started with her air that is not answered yet
  ids['fromAliceMini'] = mb.send({ from: { agent: 'claude', sessionId: '', device: 'alice/mini' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'from her mini', fromTier: 'peer', via: 'morse-relay' }).id;
  ids['fromAliceAir'] = mb.send({ from: { agent: 'claude', sessionId: '', device: 'alice/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'from her air', fromTier: 'peer', via: 'morse-relay' }).id;
  ids['toAliceAir'] = mb.send({ from: session, to: { agent: 'user', sessionId: '', device: 'alice/air' }, text: 'a question for your air' }).id;
  mb.markDelivered(mb.claimNextPending({ scope: 'outbound' })!.id);
  // still in the outbox: bob is offline
  ids['waiting'] = mb.send({ from: session, to: { agent: 'user', sessionId: '', device: 'bob' }, text: 'when you are back' }).id;
  mb.markFailed(mb.claimNextPending({ scope: 'outbound' })!.id, 'bob is offline', { waiting: true });
  // own mail: from my other computer, and between two sessions here
  ids['fromMyAir'] = mb.send({ from: { agent: 'claude', sessionId: 's-9', device: 'me/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'from my air', fromTier: 'owner', via: 'morse-relay' }).id;
  ids['internal'] = mb.send({ from: session, to: { agent: 'codex', sessionId: 's-2' }, text: 'local note' }).id;
  // eve wrote once, then got blocked
  ids['fromEve'] = mb.send({ from: { agent: 'claude', sessionId: '', device: 'eve' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'spam', fromTier: 'peer', via: 'morse-relay' }).id;
  // carol: a message request, not a contact
  const carol = fakeDevice(homes);
  mb.requests.file({ handle: 'carol', deviceId: carol.id, msgId: 'req-1', from: { agent: 'claude', sessionId: '' }, fromAgent: 'pro', to: { agent: 'mini', sessionId: 'inbox' }, text: 'may I?', droppedFiles: 0, via: 'morse-relay' });
  // an outbound message that sits in dave's message requests
  ids['request'] = mb.send({ from: session, to: { agent: 'user', sessionId: '', device: 'dave' }, text: 'hello dave' }).id;
  mb.markDelivered(mb.claimNextPending({ scope: 'outbound' })!.id);
  mb.markRequest(ids['request']);
  mb.firstSeen(bob.id, 'seen-1');
  // what `morse contact set` did before the migration
  mb.contacts.set('c:bob', { remark: 'Bobby', group: 'colleague' });
  mb.contacts.set('c:alice', { group: 'friend' });
  mb.contacts.set('c:eve', { state: 'blocked' });
  // P1 already recorded one address: bob's computer
  mb.contacts.seenAddress('c:bob', bob.address, bob.id, T0);
  db.close();
  downgradeToV2(dbPath);
  return { home, morseDir, dbPath, bob, aliceMini, aliceAir, myAir, studio, ids };
}
