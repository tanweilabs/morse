// (ADR-091) Builds test/fixtures/v4-home: a ~/.morse exactly as the RELEASED code before v2 was removed leaves it
// (origin/main at 1afe17e — the release 20261116042458 line, mailbox schema `user_version` 4). Everything is written
// by that release's own modules, imported by absolute path from a tree extracted with `git archive` — never by this
// worktree's src.
//
//   git archive 1afe17e | tar -x -C <old tree>
//   ln -s <repo>/node_modules <old tree>/node_modules
//   cd <old tree> && MORSE_HOME=<tmp> HOME=<tmp> ANYTOANY_HOME=<tmp> \
//     node --import tsx <repo>/test/fixtures/v4-home/build.mjs <old tree> <repo>/test/fixtures/v4-home
//
// See README.md next to this file for what the fixture contains.
//
// NO KEY is written into the fixture: the device key (= my first address), the key of my other address and the
// device certificate stay in the throw-away home this script runs in. fixture.json records the identifiers they
// gave (`mine`: two addresses, the device ID); the test generates keys of its own and replaces those identifiers
// in its copy (test/helpers/v4-fixture.ts).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [oldTreeArg, outArg] = process.argv.slice(2);
if (!oldTreeArg || !outArg) throw new Error('usage: build.mjs <old tree (git archive 1afe17e)> <out dir>');
const oldTree = resolve(oldTreeArg);
const outDir = resolve(outArg);
const home = process.env['MORSE_HOME'];
// never the real home: all three must point at one throw-away directory that has no Morse state yet
if (!home || process.env['HOME'] !== home || process.env['ANYTOANY_HOME'] !== home) throw new Error('MORSE_HOME, HOME and ANYTOANY_HOME must all point at the same temp dir');
if (resolve(home) !== resolve(homedir())) throw new Error('HOME is not what the process sees as its home');
if (existsSync(join(home, '.morse')) || existsSync(join(home, '.anytoany'))) throw new Error(`${home} already holds Morse state — use a fresh temp dir`);
if (existsSync(join(oldTree, 'src/mailbox/migrate-v5.ts'))) throw new Error(`${oldTree} is not the released tree (it has the v5 migration)`);
if (!existsSync(join(oldTree, 'src/mailbox/migrate-v4.ts'))) throw new Error(`${oldTree} is older than the release this fixture stands for (no v4 migration)`);

const old = (path) => import(pathToFileURL(join(oldTree, path)).href);
const { createDb } = await old('src/mailbox/db.ts');
const { createMailbox } = await old('src/mailbox/mailbox.ts');
const { homeContactContext } = await old('src/mailbox/home-context.ts');
const { loadOrCreateIdentity } = await old('src/cluster/identity.ts');
const { loadOrCreateEncKey, makeKeyBundle } = await old('src/cluster/e2e.ts');
const { loadPrimaryAddress } = await old('src/identity/address-key.ts');
const { ensureAgentAddresses } = await old('src/identity/agent-addresses.ts');
const { acceptRequest } = await old('src/cluster/requests.ts');
const { blockHandle, isBlocked } = await old('src/cluster/blocklist.ts');
const { createTrustStore } = await old('src/cluster/trust.ts');
const { updateMachineConfig } = await old('src/machine-config.ts');

const T0 = Date.UTC(2026, 10, 15, 8, 0, 0);
let t = T0;
const now = () => (t += 1000);

// ---- who is who ------------------------------------------------------------------------------------
const peerHomes = join(home, 'peer-homes');
/** Someone else's computer (or another one of mine): its own home, device key, certificate — a REAL address. */
const device = (name) => {
  const h = join(peerHomes, name);
  mkdirSync(h, { recursive: true });
  const identity = loadOrCreateIdentity(h);
  return { id: identity.id, address: loadPrimaryAddress(h, identity).address, bundle: makeKeyBundle(identity, loadOrCreateEncKey(h)) };
};
const morseDir = join(home, '.morse');
const me = loadOrCreateIdentity(home);
updateMachineConfig((cfg) => {
  cfg['relay'] = { url: 'ws://127.0.0.1:9', handle: 'me', agent: 'mini', agents: ['mini', 'work'] };
  // attendant permissions: a group, one contact by remark, one by old handle, one of my own computers by remark
  cfg['plugins'] = {
    attendant: {
      groups: { colleague: { tools: ['Read'], cwd: '/tmp/colleague' } },
      contacts: { bobby: { tools: ['Read', 'Grep'], cwd: '/tmp/bob' }, erin: { tools: ['Read'], cwd: '/tmp/erin' }, air: { tools: ['Bash'], cwd: '/tmp/air' } },
    },
  };
}, join(morseDir, 'config.json'));
const mine = ensureAgentAddresses(home);
const F = loadPrimaryAddress(home).address;
const W = mine.find((a) => a.agent === 'work').key.address;
if (mine.find((a) => a.primary).key.address !== F || new Set([F, W]).size !== 2) throw new Error('addresses are not as expected');

const names = ['ann', 'nina', 'rob'];
const peers = Object.fromEntries(names.map((n) => [n, device(n).address]));
const devices = Object.fromEntries(['myAir', 'myWin', 'studio', 'bob', 'aliceMini', 'aliceAir', 'erin', 'carl', 'lee', 'carol', 'gail'].map((n) => [n, device(n)]));
const trusted = (d, name, tier) => ({ id: d.id, name, tier, addedAt: T0 });
// my own other computers (owner tier, certificates pinned: their addresses are known); people's paired computers
// (carl: paired, certificate pinned, but the relay was never asked for his agents — his contact has no address yet)
writeFileSync(
  join(morseDir, 'trusted-devices.json'),
  `${JSON.stringify({ devices: [trusted(devices.myAir, 'me', 'owner'), trusted(devices.myWin, 'me', 'owner'), trusted(devices.studio, 'studio', 'owner'), trusted(devices.bob, 'bob', 'peer'), trusted(devices.carl, 'carl', 'peer'), trusted(devices.lee, 'lee', 'peer')] }, null, 2)}\n`,
);
// pinned bundles (with certificates): carol's too — a stranger's bundle is pinned when the relay confirmed her
// request (src/cluster/morse.ts verifyStranger); gail's is not
writeFileSync(join(morseDir, 'peer-keys.json'), `${JSON.stringify(Object.fromEntries([devices.myAir, devices.myWin, devices.studio, devices.bob, devices.carl, devices.lee, devices.carol].map((d) => [d.id, d.bundle])), null, 2)}\n`);

// ---- the mailbox, through the released code ----------------------------------------------------------
const dbPath = join(morseDir, 'mailbox.db');
const ctx = homeContactContext(home);
const db = createDb(dbPath, { ctx, now });
const mb = createMailbox(db, { ctx, now });
const trust = createTrustStore(home);
const ids = {};
const session = { agent: 'claude', sessionId: 's-1' };
const inbox = (agent = 'mini') => ({ agent, sessionId: 'inbox' });
const toPerson = (dev) => ({ agent: 'user', sessionId: '', device: dev });
const deliver = (id, receipt = false) => {
  const claimed = mb.claimNextPending({ scope: 'outbound' });
  if (claimed?.id !== id) throw new Error(`claimed ${claimed?.id} instead of ${id}`);
  mb.markDelivered(id);
  if (receipt) mb.markReceipt(id, now());
};
/** `morse contact block <old name>` as the released command does it for a contact by old handle. */
const blockOld = (contactId, handle) => {
  blockHandle(handle, home);
  mb.requests.remove(handle, '');
  mb.contacts.set(contactId, { state: 'blocked' });
};

// own computers: made contacts by the v3 step of the open above (schema v3 does that from the trust list)
const air = mb.contacts.ensureOwnDevice({ deviceId: devices.myAir.id, address: devices.myAir.address, handle: 'me', agent: 'air', name: 'air' });
const win = mb.contacts.ensureOwnDevice({ deviceId: devices.myWin.id, address: devices.myWin.address, handle: 'me', agent: 'win', name: 'win' });
const studio = mb.contacts.ensureOwnDevice({ deviceId: devices.studio.id, address: devices.studio.address, name: 'studio' });
if (air?.origin !== 'own-device' || air.group !== 'self' || win?.group !== 'self' || studio?.origin !== 'own-device') throw new Error('own computers were not made contacts');
// one of them moved out of group self (`morse contact set studio --group colleague`)
mb.contacts.set(studio.id, { group: 'colleague' });
// mail from my air (owner tier, with a session id — it could resume a session), and one I sent it that waits
ids.fromAir = mb.send({ from: { agent: 'claude', sessionId: 's-9', device: 'me/air' }, to: inbox(), text: 'from my air', fromTier: 'owner', via: 'morse-relay', contactId: air.id }).id;
ids.toWin = mb.send({ from: session, to: toPerson(devices.myWin.address), text: 'to my windows pc', firstAddress: true }).id;
deliver(ids.toWin, true);
ids.internal = mb.send({ from: session, to: { agent: 'codex', sessionId: 's-2' }, text: 'local note' }).id;

// bob: a contact by old handle (remark, group, a permission by remark), history both ways, a thread he answered;
// the relay named his address (ADR-077 split done)
ids.toBob = mb.send({ from: session, to: toPerson('bob'), text: 'hi bob', firstAddress: true }).id;
deliver(ids.toBob, true);
ids.fromBob = mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: inbox(), text: 'hi me', fromTier: 'peer', via: 'morse-relay' }).id;
ids.bobThread = mb.send({ from: session, to: toPerson('bob'), text: 'a question, bob', firstAddress: true }).id;
deliver(ids.bobThread, true);
ids.bobThreadReply = mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: inbox(), text: 'the answer', contextId: ids.bobThread, fromTier: 'peer', via: 'morse-relay' }).id;
mb.contacts.set('c:bob', { remark: 'Bobby', group: 'colleague' });
mb.contacts.applySplit('c:bob', [{ agent: 'mbp', address: devices.bob.address, default: true, deviceId: devices.bob.id }]);

// alice: a handle with two agents on two computers — split by the relay's answer
ids.fromAliceMini = mb.send({ from: { agent: 'claude', sessionId: '', device: 'alice/mini' }, to: inbox(), text: 'from her mini', fromTier: 'peer', via: 'morse-relay' }).id;
mb.contacts.set('c:alice', { group: 'friend' });
const made = mb.contacts.applySplit('c:alice', [
  { agent: 'mini', address: devices.aliceMini.address, default: true },
  { agent: 'air', address: devices.aliceAir.address },
]);
if (made.join() !== 'c:alice/air') throw new Error(`split made ${made.join()}`);
ids.fromAliceAir = mb.send({ from: { agent: 'claude', sessionId: '', device: 'alice/air' }, to: inbox(), text: 'from her air', fromTier: 'peer', via: 'morse-relay', contactId: 'c:alice/air' }).id;

// erin: a contact by old handle whose address is known; her permission is written by old handle
mb.contacts.ensure('erin');
mb.contacts.applySplit('c:erin', [{ agent: 'mbp', address: devices.erin.address, default: true }]);
ids.fromErin = mb.send({ from: { agent: 'claude', sessionId: '', device: 'erin/mbp' }, to: inbox(), text: 'erin here', fromTier: 'peer', via: 'morse-relay' }).id;

// carl: paired by old handle, his certificate is pinned — but his contact never got an address (split pending)
ids.fromCarl = mb.send({ from: { agent: 'claude', sessionId: '', device: 'carl' }, to: inbox(), text: 'carl here', fromTier: 'peer', via: 'morse-relay' }).id;
mb.contacts.set('c:carl', { remark: 'Carl' });


// eve: wrote once by old handle, then blocked (no address known); mallory: a handle blocked without ever being a contact
ids.fromEve = mb.send({ from: { agent: 'claude', sessionId: '', device: 'eve' }, to: inbox(), text: 'spam', fromTier: 'peer', via: 'morse-relay' }).id;
blockOld('c:eve', 'eve');
blockHandle('mallory', home);
// lee: a contact by old handle with a known address, blocked AFTER the v4 step (`morse contact block lee`): only the
// handle is in morse-blocked.json — his address is not in address_blocks
ids.fromLee = mb.send({ from: { agent: 'claude', sessionId: '', device: 'lee/mbp' }, to: inbox(), text: 'lee here', fromTier: 'peer', via: 'morse-relay' }).id;
mb.contacts.applySplit('c:lee', [{ agent: 'mbp', address: devices.lee.address, default: true, deviceId: devices.lee.id }]);
blockOld('c:lee', 'lee');
if (mb.contacts.isBlockedAt(devices.lee.address, '')) throw new Error('lee is blocked by address already');

// ---- contacts that have only an address ---------------------------------------------------------------
// ann wrote to my first address (a request by address), accepted, I answered
mb.requests.file({ handle: peers.ann, deviceId: peers.ann, msgId: 'req-ann', from: { agent: 'claude', sessionId: '' }, to: inbox(), toAddress: F, text: 'hello, I am ann', droppedFiles: 0, via: 'morse-relay' });
const a = acceptRequest(peers.ann, { mailbox: mb, trust, home });
if (!a.ok) throw new Error(a.error);
ids.fromAnn = a.message.id;
mb.contacts.set(a.contactId, { remark: 'Ann', group: 'friend' });
ids.toAnn = mb.reply(ids.fromAnn, 'hello ann').id;
deliver(ids.toAnn, true);
// nina: added by hand and put into group self (`morse contact set nina --group self`) — which gave her nothing
const nina = mb.contacts.ensureAddress(peers.nina);
mb.contacts.set(nina.id, { remark: 'nina', group: 'self' });

// ---- message requests still waiting ----------------------------------------------------------------
// by address, to `work`
mb.requests.file({ myAddress: W, handle: peers.rob, deviceId: peers.rob, msgId: 'req-rob', from: { agent: 'claude', sessionId: '' }, to: inbox('work'), toAddress: W, text: 'rob, to work', droppedFiles: 0, via: 'morse-relay' });
// the old way, by handle from a device the relay listed under it: carol's certificate is pinned, gail's is not
mb.requests.file({ handle: 'carol', deviceId: devices.carol.id, msgId: 'req-carol', from: { agent: 'claude', sessionId: '' }, fromAgent: 'pro', to: inbox(), text: 'may I?', droppedFiles: 0, via: 'morse-relay' });
mb.requests.file({ handle: 'gail', deviceId: devices.gail.id, msgId: 'req-gail', from: { agent: 'claude', sessionId: '' }, to: inbox(), text: 'gail here', droppedFiles: 0, via: 'morse-lan' });

// ---- the outbox: still waiting (queued after every delivery above) ------------------------------------
ids.toAirWaiting = mb.send({ from: session, to: toPerson('me/air'), text: 'to my air, still waiting', firstAddress: true }).id;
// to bob by his old handle and agent
ids.waitingBob = mb.send({ from: session, to: toPerson('bob/mbp'), text: 'when you are back', firstAddress: true }).id;
ids.toCarlWaiting = mb.send({ from: session, to: toPerson('carl'), text: 'carl, are you there?', firstAddress: true }).id;
// dave: I wrote to his old handle; nothing is known of him — no device, no address
ids.toDave = mb.send({ from: session, to: toPerson('dave'), text: 'hello dave', firstAddress: true }).id;
mb.markProcessed([ids.fromBob, ids.fromAnn, ids.fromAir], 'owner');

if (!isBlocked('lee', home) || !isBlocked('eve', home) || !isBlocked('mallory', home)) throw new Error('blocks are not as expected');
const contacts = Object.fromEntries(mb.contacts.list().map((c) => [c.remark ?? c.handle ?? c.address ?? c.id, c.id]));
const version = db.pragma('user_version', { simple: true });
if (version !== 4) throw new Error(`user_version is ${version}, not 4`);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
for (const f of ['mailbox.db-wal', 'mailbox.db-shm']) if (existsSync(join(morseDir, f))) throw new Error(`${f} is still there`);

// ---- the fixture: only what a test needs ---------------------------------------------------------------
const target = join(outDir, 'morse');
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, 'addresses'), { recursive: true });
for (const f of ['mailbox.db', 'morse-blocked.json', 'config.json', 'trusted-devices.json', 'peer-keys.json']) cpSync(join(morseDir, f), join(target, f));
// which agent has which address — and nothing else from `addresses/` or `identity/`: no key, no certificate
cpSync(join(morseDir, 'addresses', 'agents.json'), join(target, 'addresses', 'agents.json'));
const pub = (d) => ({ id: d.id, address: d.address });
writeFileSync(
  join(outDir, 'fixture.json'),
  `${JSON.stringify(
    {
      builtBy: '1afe17e',
      userVersion: version,
      t0: T0,
      lastAt: t,
      // the identifiers the builder's keys gave — the test replaces them by those of the keys it generates
      mine: { first: F, work: W, device: me.id },
      peers,
      devices: Object.fromEntries(Object.entries(devices).map(([n, d]) => [n, pub(d)])),
      contacts,
      messages: ids,
    },
    null,
    2,
  )}\n`,
);
const listed = [];
const walk = (dir, rel = '') => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, `${rel}${name}/`);
    else listed.push(`${rel}${name} (${statSync(p).size} bytes)`);
  }
};
walk(target);
// no key material may end up in the repository: no .pem, no PEM private-key block in any file written here
const keyFiles = listed.map((l) => l.replace(/ \(\d+ bytes\)$/, '')).filter((f) => /\.pem$/i.test(f) || /PRIVATE[ ]KEY/.test(readFileSync(join(target, f), 'latin1')));
if (keyFiles.length) throw new Error(`key material in the fixture: ${keyFiles.join(', ')}`);
console.log(`fixture written to ${outDir}:\n  fixture.json\n${listed.map((l) => `  morse/${l}`).join('\n')}`);
console.log(`first ${F}\nwork  ${W}\ndevice ${me.id}\n(their keys were NOT copied: they stay in ${home} — delete it)`);
