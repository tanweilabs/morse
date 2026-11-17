// (ADR-083) Builds test/fixtures/p3-home: a ~/.morse exactly as the RELEASED code before ADR-083 leaves it
// (commit af4ca40, mailbox schema `user_version` 3). Everything is written by that release's own modules,
// imported by absolute path from a tree extracted with `git archive af4ca40` — never by this worktree's src.
//
//   git archive af4ca40 | tar -x -C <old tree>
//   ln -s <repo>/node_modules <old tree>/node_modules
//   cd <old tree> && MORSE_HOME=<tmp> HOME=<tmp> ANYTOANY_HOME=<tmp> \
//     node --import tsx <repo>/test/fixtures/p3-home/build.mjs <old tree> <repo>/test/fixtures/p3-home
//
// See README.md next to this file for what the fixture contains.
//
// NO KEY is written into the fixture: the device key (= my first address), the keys of my two other
// addresses and the device certificate stay in the throw-away home this script runs in. fixture.json
// records the identifiers they gave (`mine`: three addresses, the device ID); the test generates keys of
// its own and replaces those identifiers in its copy (test/helpers/p3-fixture.ts).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [oldTreeArg, outArg] = process.argv.slice(2);
if (!oldTreeArg || !outArg) throw new Error('usage: build.mjs <old tree (git archive af4ca40)> <out dir>');
const oldTree = resolve(oldTreeArg);
const outDir = resolve(outArg);
const home = process.env['MORSE_HOME'];
// never the real home: all three must point at one throw-away directory that has no Morse state yet
if (!home || process.env['HOME'] !== home || process.env['ANYTOANY_HOME'] !== home) throw new Error('MORSE_HOME, HOME and ANYTOANY_HOME must all point at the same temp dir');
if (resolve(home) !== resolve(homedir())) throw new Error('HOME is not what the process sees as its home');
if (existsSync(join(home, '.morse')) || existsSync(join(home, '.anytoany'))) throw new Error(`${home} already holds Morse state — use a fresh temp dir`);
if (existsSync(join(oldTree, 'src/mailbox/migrate-v4.ts'))) throw new Error(`${oldTree} is not the released tree (it has the v4 migration)`);

const old = (path) => import(pathToFileURL(join(oldTree, path)).href);
const { createDb } = await old('src/mailbox/db.ts');
const { createMailbox } = await old('src/mailbox/mailbox.ts');
const { CONTACTS_TABLE } = await old('src/mailbox/contacts.ts');
const { homeContactContext } = await old('src/mailbox/home-context.ts');
const { loadOrCreateIdentity } = await old('src/cluster/identity.ts');
const { loadOrCreateEncKey, makeKeyBundle } = await old('src/cluster/e2e.ts');
const { loadPrimaryAddress } = await old('src/identity/address-key.ts');
const { ensureAgentAddresses } = await old('src/identity/agent-addresses.ts');
const { acceptRequest, declineRequest } = await old('src/cluster/requests.ts');
const { blockHandle, unblockHandle, isBlocked } = await old('src/cluster/blocklist.ts');
const { createTrustStore } = await old('src/cluster/trust.ts');
const { updateMachineConfig } = await old('src/machine-config.ts');
if (CONTACTS_TABLE.includes('my_address')) throw new Error('the modules loaded are not the released ones');

const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);
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
  cfg['relay'] = { url: 'ws://127.0.0.1:9', handle: 'me', agent: 'mini', agents: ['mini', 'work', 'lab'] };
}, join(morseDir, 'config.json'));
const mine = ensureAgentAddresses(home);
const F = loadPrimaryAddress(home).address;
const W = mine.find((a) => a.agent === 'work').key.address;
const L = mine.find((a) => a.agent === 'lab').key.address;
if (mine.find((a) => a.primary).key.address !== F || new Set([F, W, L]).size !== 3) throw new Error('addresses are not as expected');

const names = ['ann', 'abe', 'wendy', 'lou', 'tess', 'nina', 'bart', 'wanda', 'bea', 'una', 'gus', 'zed', 'rob', 'rita', 'ruth', 'fay', 'kim'];
const peers = Object.fromEntries(names.map((n) => [n, device(n).address]));
const devices = Object.fromEntries(['myAir', 'studio', 'bob', 'aliceMini', 'aliceAir', 'alicePro', 'erin', 'carol', 'lee', 'mel'].map((n) => [n, device(n)]));
const trusted = (d, name, tier) => ({ id: d.id, name, tier, addedAt: T0 });
// my own other computers (owner tier, certificates pinned: their addresses are known) and bob's paired computer
writeFileSync(
  join(morseDir, 'trusted-devices.json'),
  `${JSON.stringify({ devices: [trusted(devices.myAir, 'me', 'owner'), trusted(devices.studio, 'studio', 'owner'), trusted(devices.bob, 'bob', 'peer')] }, null, 2)}\n`,
);
writeFileSync(join(morseDir, 'peer-keys.json'), `${JSON.stringify(Object.fromEntries([devices.myAir, devices.studio, devices.bob].map((d) => [d.id, d.bundle])), null, 2)}\n`);

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
/** A message that came BY ADDRESS from a contact, filed as the transport does (src/cluster/morse.ts fileMessage). */
const nativeIn = (label, from, to, text, agent = 'mini') => {
  const contact = mb.contacts.byAddress(from);
  ids[label] = mb.send({ from: { agent: 'claude', sessionId: '', device: from }, to: inbox(agent), text, via: 'morse-relay', fromTier: 'peer', myAddress: to, ...(contact ? { contactId: contact.id } : {}) }).id;
  mb.firstSeen(from, `wire-${label}`);
  return ids[label];
};
/** A stranger's first message BY ADDRESS: a message request written to one of my addresses (fileRequest). */
const request = (from, to, text, agent = 'mini') => {
  const r = mb.requests.file({ handle: from, deviceId: from, msgId: `req-${from.slice(0, 6)}`, from: { agent: 'claude', sessionId: '' }, to: inbox(agent), toAddress: to, text, droppedFiles: 0, via: 'morse-relay' });
  if (r.result !== 'filed') throw new Error(`request from ${from}: ${r.result}`);
};
/** …and `morse contact accept`: the request becomes an address-only contact, its message moves to the inbox. */
const accept = (label, from) => {
  const r = acceptRequest(from, { mailbox: mb, trust, home });
  if (!r.ok) throw new Error(r.error);
  ids[label] = r.message.id;
  return r.contactId;
};
/** `morse contact block <address>` as the released command does it (src/commands/messaging.ts blockAction). */
const block = (contactId, key) => {
  blockHandle(key, home);
  mb.requests.remove(key);
  mb.contacts.set(contactId, { state: 'blocked' });
};

// own computers: made contacts by the open above (schema v3 does that from the trust list); asked for again here
const myAir = mb.contacts.ensureOwnDevice({ deviceId: devices.myAir.id, address: devices.myAir.address });
const studio = mb.contacts.ensureOwnDevice({ deviceId: devices.studio.id, address: devices.studio.address, name: 'studio' });
if (myAir?.origin !== 'own-device' || myAir.group !== 'self' || studio?.origin !== 'own-device') throw new Error('own computers were not made contacts');
// one of them moved out of group self (`morse contact set studio --group colleague`)
mb.contacts.set(studio.id, { group: 'colleague' });
ids.fromMyAir = mb.send({ from: { agent: 'claude', sessionId: 's-9', device: 'me/air' }, to: inbox(), text: 'from my air', fromTier: 'owner', via: 'morse-relay' }).id;
ids.internal = mb.send({ from: session, to: { agent: 'codex', sessionId: 's-2' }, text: 'local note' }).id;
ids.toStudio = mb.send({ from: session, to: toPerson(devices.studio.address), text: 'to my studio' }).id;
deliver(ids.toStudio);
ids.toStudioFromLab = mb.send({ from: session, to: toPerson(devices.studio.address), text: 'to my studio, as lab', myAddress: L, myAgent: 'lab' }).id;
deliver(ids.toStudioFromLab);

// bob: a contact by old handle (remark, group), history both ways, a thread I started that he answered
ids.toBob = mb.send({ from: session, to: toPerson('bob'), text: 'hi bob' }).id;
deliver(ids.toBob, true);
ids.fromBob = mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: inbox(), text: 'hi me', fromTier: 'peer', via: 'morse-relay' }).id;
ids.bobThread = mb.send({ from: session, to: toPerson('bob'), text: 'a question, bob' }).id;
deliver(ids.bobThread, true);
ids.bobThreadReply = mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: inbox(), text: 'the answer', contextId: ids.bobThread, fromTier: 'peer', via: 'morse-relay' }).id;
mb.firstSeen(devices.bob.id, 'seen-1');
mb.contacts.set('c:bob', { remark: 'Bobby', group: 'colleague' });
// the relay named his address (ADR-077): from then on `morse send Bobby --from work` goes by address, from `work`
mb.contacts.applySplit('c:bob', [{ agent: 'mbp', address: devices.bob.address, default: true, deviceId: devices.bob.id }]);
ids.toBobFromWork = mb.send({ from: session, to: toPerson('bob'), text: 'hi bob, as work', myAddress: W, myAgent: 'work' }).id;
deliver(ids.toBobFromWork);
// …and his answer BY ADDRESS, written to `work`: filed under the contact his address belongs to
nativeIn('bobAtWork', devices.bob.address, W, 'hi work, bob here', 'work');
if (mb.getMessage(ids.bobAtWork).contactId !== 'c:bob') throw new Error('mail from the address of bob was not filed under c:bob');

// alice: a handle with three agents on three computers — split by the relay's answer; one of them removed again
ids.fromAliceMini = mb.send({ from: { agent: 'claude', sessionId: '', device: 'alice/mini' }, to: inbox(), text: 'from her mini', fromTier: 'peer', via: 'morse-relay' }).id;
mb.contacts.set('c:alice', { group: 'friend' });
const made = mb.contacts.applySplit('c:alice', [
  { agent: 'mini', address: devices.aliceMini.address, default: true },
  { agent: 'air', address: devices.aliceAir.address },
  { agent: 'pro', address: devices.alicePro.address },
]);
if (made.join() !== 'c:alice/air,c:alice/pro') throw new Error(`split made ${made.join()}`);
ids.fromAliceAir = mb.send({ from: { agent: 'claude', sessionId: '', device: 'alice/air' }, to: inbox(), text: 'from her air', fromTier: 'peer', via: 'morse-relay', contactId: 'c:alice/air' }).id;
ids.toAliceAir = mb.send({ from: session, to: { agent: 'air', sessionId: '', device: 'alice/air' }, text: 'to her air' }).id;
deliver(ids.toAliceAir);
mb.contacts.remove('c:alice/pro'); // tombstones: removed:<its address>, removed:c:alice/pro

// erin: a contact by old handle whose address is known; the only mail with her went out from `work`
mb.contacts.ensure('erin');
mb.contacts.applySplit('c:erin', [{ agent: 'mbp', address: devices.erin.address, default: true }]);
ids.toErinFromWork = mb.send({ from: session, to: toPerson('erin'), text: 'hi erin, as work', myAddress: W, myAgent: 'work' }).id;
deliver(ids.toErinFromWork);

// dave: I wrote to his old handle; it waits in HIS message requests
ids.toDave = mb.send({ from: session, to: toPerson('dave'), text: 'hello dave' }).id;
deliver(ids.toDave);
mb.markRequest(ids.toDave);

// eve: wrote once by old handle, then blocked (`morse contact block eve`); mallory: a handle blocked without ever being a contact
ids.fromEve = mb.send({ from: { agent: 'claude', sessionId: '', device: 'eve' }, to: inbox(), text: 'spam', fromTier: 'peer', via: 'morse-relay' }).id;
block('c:eve', 'eve');
blockHandle('mallory', home);
// lee: a contact by old handle whose address is known (the relay named it), mail by handle — then blocked
// (`morse contact block lee`): the handle is in morse-blocked.json, the address stays on the row
// (ADR-083 review R2: such an address must stay blocked at my other addresses too)
ids.fromLee = mb.send({ from: { agent: 'claude', sessionId: '', device: 'lee/mbp' }, to: inbox(), text: 'lee here', fromTier: 'peer', via: 'morse-relay' }).id;
mb.contacts.applySplit('c:lee', [{ agent: 'mbp', address: devices.lee.address, default: true, deviceId: devices.lee.id }]);
block('c:lee', 'lee');
// mel: a contact by old handle with a known address, removed (`morse contact remove mel`: a tombstone that names
// the handle) and blocked afterwards (`morse contact block mel` when nobody is a contact: the released command
// makes the contact by handle again — no address on it — and blocks it). Her address is known from the tombstone only.
mb.contacts.ensure('mel');
mb.contacts.applySplit('c:mel', [{ agent: 'mbp', address: devices.mel.address, default: true }]);
mb.contacts.remove('c:mel');
block(mb.contacts.ensure('mel').id, 'mel');
if (mb.contacts.find('mel')?.address) throw new Error('the contact made again for mel has an address');

// ---- contacts that have only an address ---------------------------------------------------------------
// ann wrote to my FIRST address (the row records the literal address); accepted; I answered
request(peers.ann, F, 'hello, I am ann');
const ann = accept('fromAnn', peers.ann);
mb.contacts.set(ann, { remark: 'Ann', group: 'friend' });
ids.toAnn = mb.reply(ids.fromAnn, 'hello ann').id;
deliver(ids.toAnn, true);
// wendy wrote to `work`; accepted; a second message of hers; I answered from work
request(peers.wendy, W, 'hello work, I am wendy', 'work');
const wendy = accept('fromWendy', peers.wendy);
mb.contacts.set(wendy, { remark: 'Wendy', group: 'colleague' });
nativeIn('fromWendy2', peers.wendy, W, 'one more thing', 'work');
ids.toWendy = mb.reply(ids.fromWendy, 'hello wendy').id;
deliver(ids.toWendy);
// tess knows `work` — and also wrote to my first address, and I wrote to her from `lab`
request(peers.tess, W, 'hello work, I am tess', 'work');
const tess = accept('tessAtWork', peers.tess);
mb.contacts.set(tess, { remark: 'Tess', group: 'colleague' });
ids.toTessFromWork = mb.reply(ids.tessAtWork, 'hello tess').id;
deliver(ids.toTessFromWork);
nativeIn('tessAtFirst', peers.tess, F, 'tess here, to your first address');
ids.toTessFromFirst = mb.reply(ids.tessAtFirst, 'answered from my first address').id;
deliver(ids.toTessFromFirst);
ids.toTessFromFirstUnnamed = mb.send({ from: session, to: toPerson(peers.tess), text: 'again, from my first address', firstAddress: true }).id;
deliver(ids.toTessFromFirstUnnamed);
ids.toTessFromLab = mb.send({ from: session, to: toPerson(peers.tess), text: 'tess, this is lab', myAddress: L, myAgent: 'lab' }).id;
deliver(ids.toTessFromLab);
// nina: added by hand (`morse contact add`), nothing exchanged yet
mb.contacts.ensureAddress(peers.nina);
// bart wrote to my first address, was accepted, then blocked
request(peers.bart, F, 'bart here');
block(accept('fromBart', peers.bart), peers.bart);
// wanda wrote to `work`, was accepted, then blocked
request(peers.wanda, W, 'wanda here', 'work');
block(accept('fromWanda', peers.wanda), peers.wanda);
// bea wrote to my first address, was accepted, I also wrote to her from `work` — then blocked
request(peers.bea, F, 'bea here');
const bea = accept('fromBea', peers.bea);
ids.toBeaFromWork = mb.send({ from: session, to: toPerson(peers.bea), text: 'bea, this is work', myAddress: W, myAgent: 'work' }).id;
deliver(ids.toBeaFromWork);
block(bea, peers.bea);
// una wrote to my first address, was accepted, blocked — and then I wrote to her again, which unblocks (ADR-037).
// The three calls below are what the daemon does when `morse send morse.im/<address>` is queued
// (src/cluster/morse.ts `acceptAddress`, call for call): the entry leaves morse-blocked.json — which is what
// this release obeys — and the row's own `state` column is left saying 'blocked'.
request(peers.una, F, 'una here');
const una = accept('fromUna', peers.una);
block(una, peers.una);
unblockHandle(peers.una, home);
const unaNow = mb.contacts.ensureAddress(peers.una);
if (unaNow.state === 'blocked') mb.contacts.set(unaNow.id, { state: 'active' });
ids.toUna = mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: toPerson(peers.una), text: 'una, let us talk again', via: 'cli', myAddress: F, myAgent: 'mini' }).id;
deliver(ids.toUna);
if (isBlocked(peers.una, home) || mb.contacts.byAddress(peers.una).state !== 'active') throw new Error('una is still blocked for the released code');
// gus wrote to my first address, was accepted, then removed (`morse contact remove`): a tombstone, history kept
request(peers.gus, F, 'gus here');
mb.contacts.remove(accept('fromGus', peers.gus));
// zed wrote to my first address and was rejected: blocked, nobody's contact
request(peers.zed, F, 'zed here');
if (!declineRequest(peers.zed, { mailbox: mb, home }).ok) throw new Error('decline failed');
// fay wrote to `work` and was rejected there (`morse contact reject … ` + block: declineRequest): blocked by address,
// nobody's contact (ADR-083 review R2: before the upgrade that block was the whole computer's)
request(peers.fay, W, 'fay here, to work', 'work');
if (!declineRequest(peers.fay, { mailbox: mb, home }).ok) throw new Error('decline failed');
// kim wrote to `work`, was accepted, wrote again (unread), I answered from work — then removed (`morse contact
// remove`): a tombstone, and her history at `work` keeps the contact id `a:<kim>` (ADR-083 review R3)
request(peers.kim, W, 'hello work, I am kim', 'work');
const kim = accept('kimAtWork', peers.kim);
nativeIn('kimAtWork2', peers.kim, W, 'kim again, to work', 'work');
ids.toKimFromWork = mb.reply(ids.kimAtWork, 'hello kim').id;
deliver(ids.toKimFromWork);
mb.contacts.remove(kim);

// ---- message requests still waiting ----------------------------------------------------------------
request(peers.rob, F, 'rob, to your first address');
request(peers.rita, W, 'rita, to work', 'work');
request(peers.ruth, L, 'ruth, to lab', 'lab');
// the old way: a computer the relay listed under the handle carol
mb.requests.file({ handle: 'carol', deviceId: devices.carol.id, msgId: 'req-carol', from: { agent: 'claude', sessionId: '' }, fromAgent: 'pro', to: inbox(), text: 'may I?', droppedFiles: 0, via: 'morse-relay' });

// ---- the outbox, and what was read --------------------------------------------------------------------
// (after every delivery above: what is made here stays in the outbox)
// abe: I wrote first, naming no address of mine (the row says '') — and he is not reachable yet: waiting, retried
ids.toAbe = mb.send({ from: session, to: toPerson(peers.abe), text: 'hello abe' }).id;
const held = mb.claimNextPending({ scope: 'outbound' });
if (held?.id !== ids.toAbe) throw new Error(`claimed ${held?.id} instead of the message to abe`);
mb.markFailed(held.id, 'not reachable yet', { waiting: true });
// lou: I wrote first, from `lab` — pending
ids.toLou = mb.send({ from: session, to: toPerson(peers.lou), text: 'hello lou, this is lab', myAddress: L, myAgent: 'lab' }).id;
mb.contacts.set(mb.contacts.byAddress(peers.lou).id, { remark: 'Lou' });
// bob, by his old handle, from my first address — pending
ids.waitingBob = mb.send({ from: session, to: toPerson('bob'), text: 'when you are back' }).id;
mb.markProcessed([ids.fromBob, ids.fromAnn, ids.fromWendy, ids.tessAtWork, ids.fromMyAir], 'owner');

const contacts = Object.fromEntries(mb.contacts.list().map((c) => [c.remark ?? c.handle ?? c.address ?? c.id, c.id]));
const version = db.pragma('user_version', { simple: true });
if (version !== 3) throw new Error(`user_version is ${version}, not 3`);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
for (const f of ['mailbox.db-wal', 'mailbox.db-shm']) if (existsSync(join(morseDir, f))) throw new Error(`${f} is still there`);

// ---- the fixture: only what a test needs ---------------------------------------------------------------
const target = join(outDir, 'morse');
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, 'addresses'), { recursive: true });
for (const f of ['mailbox.db', 'morse-blocked.json', 'config.json', 'trusted-devices.json', 'peer-keys.json']) cpSync(join(morseDir, f), join(target, f));
// which agent has which address — and nothing else from `addresses/` or `identity/`: no key, no certificate
// (they stay in the throw-away home; the test makes its own, test/helpers/p3-fixture.ts)
cpSync(join(morseDir, 'addresses', 'agents.json'), join(target, 'addresses', 'agents.json'));
const pub = (d) => ({ id: d.id, address: d.address });
writeFileSync(
  join(outDir, 'fixture.json'),
  `${JSON.stringify(
    {
      builtBy: 'af4ca40',
      userVersion: version,
      t0: T0,
      lastAt: t,
      // the identifiers the builder's keys gave — the test replaces them by those of the keys it generates
      mine: { first: F, work: W, lab: L, device: me.id },
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
console.log(`first ${F}\nwork  ${W}\nlab   ${L}\ndevice ${me.id}\n(their keys were NOT copied: they stay in ${home} — delete it)`);
console.log(`morse-blocked.json: ${readFileSync(join(target, 'morse-blocked.json'), 'utf8').replace(/\s+/g, ' ')}`);
