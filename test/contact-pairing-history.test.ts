import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecFn } from '../src/adapters/types.js';
import { createLocalCore } from './helpers/attendant-core.js';
import { addressOf, cliAt, computer, freePort, freshHome, removeHomes, someone, storeOf } from './helpers/personas-home.js';
import { enforceSpawnBudget, spawnBudget } from './helpers/spawn-budget.js';
import { messageViewOf } from '../src/commands/messaging.js';
import { remarkLookupFor } from '../src/cluster/remarks.js';
import { collectInbox } from '../src/hooks/prompt-hook.js';
import { createDb, type Db } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox, type Message } from '../src/mailbox/mailbox.js';
import { createEventSource } from '../src/plugin/events.js';
import { viewOf } from '../src/plugin/local-client.js';
import { createApprovalStore } from '../src/plugins/attendant/approvals.js';
import { parseAttendantConfig, type AttendantSettings } from '../src/plugins/attendant/config.js';
import { createEngine } from '../src/plugins/attendant/engine.js';
import { contextKey, createAttendantState } from '../src/plugins/attendant/state.js';

/**
 * (ADR-083 review R3, R5) A contact is the PAIR (my address, peer) — never the id on a row.
 *
 * A contact id can be given to another pair: the contact (work, wendy) kept the plain id `a:<wendy>` from
 * before contacts were per address; once it is removed its mail still carries that id, and `contact add
 * <wendy>` at my FIRST address would get the same id — and with it, were mail read by id, everything
 * wendy and `work` ever wrote to each other: in `morse message <wendy>`, in the to-process list, in the
 * unread counts and in what the attendant gives the agent as context for the first address's contact.
 *
 *   readers   history / to-process / unread / the plugin views / the attendant's context are read by the
 *             pair: only rows of the address of mine the contact belongs to (`mailbox.contactOf`)
 *   store     a new contact takes the id its OWN pair's mail still carries, and no other pair's mail is
 *             left under the id it takes — no id is shared by two pairs
 *   R5        the attendant's turns per thread are counted per (contact, thread id)
 *
 * `ann` has two addresses (`mini` first, `work`); the stores are in memory unless a test runs the CLI.
 */

const ann = computer('ann', 'mini', ['work']);
process.env['MORSE_HOME'] = ann.home; // (the views name my addresses by reading this process's Morse home)
const first = ann.address;
const work = addressOf(ann, 'work').address;
afterAll(() => removeHomes());
enforceSpawnBudget();

let clock = Date.UTC(2026, 10, 15, 8, 0, 0);
const now = () => (clock += 1000);
const store = (): { db: Db; mailbox: Mailbox } => {
  const ctx = homeContactContext(ann.home);
  const db = createDb(':memory:', { ctx });
  return { db, mailbox: createMailbox(db, { ctx, now }) };
};
/** Mail `from` wrote to one of my addresses, by address — filed as the transport files it ('' = my first address). */
const mail = (mb: Mailbox, from: string, at: string, text: string, more: { contextId?: string } = {}): Message =>
  mb.send({ from: { agent: 'claude', sessionId: '', device: from }, to: { agent: at ? 'work' : 'mini', sessionId: 'inbox' }, text, fromTier: 'peer', myAddress: at || first, ...more });
/** What I wrote to `to` from one of my addresses. */
const sent = (mb: Mailbox, to: string, at: string, text: string): Message =>
  mb.send({ from: { agent: 'claude', sessionId: 's-1' }, to: { agent: 'user', sessionId: '', device: to }, text, ...(at ? { myAddress: at, myAgent: 'work' } : { firstAddress: true }) });
/**
 * A contact of `work` that kept the plain id from before contacts were per address — the row exactly as the
 * 3 → 4 migration leaves a contact the release before had recorded for `work` (src/mailbox/migrate-v4.ts:
 * id kept, `my_address` and `known_as` = the address). Nothing in the product makes such a row any more.
 */
const movedToWork = (db: Db, peer: string, remark: string | null = null): string => {
  const t = now();
  db.prepare(`INSERT INTO contacts (id, my_address, address, remark, group_label, state, split, known_as, created_at, updated_at) VALUES (?, ?, ?, ?, 'colleague', 'active', 'done', ?, ?, ?)`).run(`a:${peer}`, work, peer, remark, work, t, t);
  return `a:${peer}`;
};
const texts = (list: Array<{ parts: Array<{ text: string }> }>) => list.map((m) => m.parts[0]!.text);
const contactIds = (db: Db, ...ids: string[]) => Object.fromEntries(ids.map((id) => [id, (db.prepare('SELECT contact_id AS c FROM messages WHERE id = ?').get(id) as { c: string }).c]));

describe('a removed contact of `work` that had the plain id: adding the peer again (ADR-083 review R3)', () => {
  /** wendy was a contact of `work` (plain id): two messages in, one of them unread, one answer — then removed. */
  const removedAtWork = () => {
    const { db, mailbox } = store();
    const wendy = someone();
    const id = movedToWork(db, wendy, 'Wendy');
    const hello = mail(mailbox, wendy, work, 'hello work, I am wendy');
    const answer = sent(mailbox, wendy, work, 'hello wendy, this is work');
    const more = mail(mailbox, wendy, work, 'one more thing for work');
    mailbox.markProcessed([hello.id], 'owner');
    expect([hello, answer, more].map((m) => [m.contactId, m.myAddress])).toEqual([[id, work], [id, work], [id, work]]);
    expect(texts(mailbox.history(id))).toEqual(['hello work, I am wendy', 'hello wendy, this is work', 'one more thing for work']);
    expect(mailbox.unread()).toEqual({ [id]: 1 });
    expect(mailbox.contacts.remove(id)).toBe(true);
    return { db, mailbox, wendy, id, hello, answer, more };
  };

  it('nobody reuses the id: the removed contact\'s history, to-process and unread read as before', () => {
    const { mailbox, id, more } = removedAtWork();
    expect(texts(mailbox.history(id))).toEqual(['hello work, I am wendy', 'hello wendy, this is work', 'one more thing for work']);
    expect(mailbox.todo().map((m) => m.id)).toEqual([more.id]);
    expect(mailbox.todo({ contactId: id }).map((m) => m.id)).toEqual([more.id]);
    expect(mailbox.unread()).toEqual({ [id]: 1 });
    // …and it is `work`'s mail: only listed for that address
    expect([mailbox.unread(''), mailbox.unread(work), mailbox.unread(first)]).toEqual([{}, { [id]: 1 }, {}]);
    expect([mailbox.addressOf(more), mailbox.contactOf(more)]).toEqual([work, null]);
    expect(viewOf(mailbox, more).contact).toEqual({ id }); // (the plugin contract for a removed contact: the id alone)
  });

  it('added again at my FIRST address: the new contact shows NOTHING of the mail with `work` — history, to-process, unread, the plugin views, the attendant\'s context', async () => {
    const { db, mailbox, wendy, id, hello, answer, more } = removedAtWork();
    const again = mailbox.contacts.ensureAddress(wendy, '');
    expect(again).toMatchObject({ id: `a:${wendy}`, myAddress: '', address: wendy, remark: null, group: 'other' });
    expect(again.id).toBe(id); // the very id the removed contact of `work` had
    // nothing of work's mail is the new contact's
    expect(mailbox.history(again.id)).toEqual([]);
    expect(mailbox.todo({ contactId: again.id })).toEqual([]);
    expect(mailbox.unread()[again.id]).toBeUndefined();
    expect(await createLocalCore(mailbox).history(again.id, 50)).toEqual([]); // what the attendant asks for as context
    // work's mail went to work's own id (no id is shared by two pairs): still there, still `work`'s, nobody's contact
    const park = `a:${wendy}~${work}`;
    expect(contactIds(db, hello.id, answer.id, more.id)).toEqual({ [hello.id]: park, [answer.id]: park, [more.id]: park });
    expect(texts(mailbox.history(park))).toEqual(['hello work, I am wendy', 'hello wendy, this is work', 'one more thing for work']);
    expect(mailbox.unread()).toEqual({ [park]: 1 });
    expect([mailbox.unread(''), mailbox.unread(work)]).toEqual([{}, { [park]: 1 }]);
    const stillToDo = mailbox.todo();
    expect(stillToDo.map((m) => [m.id, m.contactId, mailbox.addressOf(m), mailbox.contactOf(m)])).toEqual([[more.id, park, work, null]]);
    expect(viewOf(mailbox, stillToDo[0]!)).toMatchObject({ contact: { id: park }, myAddress: null });
    // mail she now writes to my first address is the new contact's — and only that
    const fresh = mail(mailbox, wendy, '', 'hello first address');
    expect(fresh.contactId).toBe(again.id);
    expect(texts(mailbox.history(again.id))).toEqual(['hello first address']);
    expect(mailbox.unread()).toEqual({ [again.id]: 1, [park]: 1 });
    expect(mailbox.todo({ contactId: again.id }).map((m) => m.id)).toEqual([fresh.id]);
  });

  it('added again at `work`: the same contact id, and its history is back; my first address still knows nothing', () => {
    const { mailbox, wendy, id, more } = removedAtWork();
    const again = mailbox.contacts.ensureAddress(wendy, work);
    expect(again).toMatchObject({ id, myAddress: work, address: wendy, remark: null, group: 'other' }); // (none of the old settings: it was removed)
    expect(texts(mailbox.history(again.id))).toEqual(['hello work, I am wendy', 'hello wendy, this is work', 'one more thing for work']);
    expect(mailbox.unread()).toEqual({ [id]: 1 });
    expect(mailbox.contactOf(more)).toMatchObject({ id, myAddress: work });
    // then also at my first address: its own id, none of it
    const atFirst = mailbox.contacts.ensureAddress(wendy, '');
    expect(atFirst).toMatchObject({ id: `a:${wendy}~${first}`, myAddress: '' });
    expect(mailbox.history(atFirst.id)).toEqual([]);
    expect(mailbox.unread()[atFirst.id]).toBeUndefined();
    expect(texts(mailbox.history(again.id))).toHaveLength(3);
  });

  it('first at my first address, then at `work` too: work\'s contact finds its history under the id it was parked at', () => {
    const { mailbox, wendy, id } = removedAtWork();
    const atFirst = mailbox.contacts.ensureAddress(wendy, '');
    mail(mailbox, wendy, '', 'to the first address');
    const atWork = mailbox.contacts.ensureAddress(wendy, work);
    expect([atFirst.id, atWork.id]).toEqual([id, `a:${wendy}~${work}`]);
    expect(texts(mailbox.history(atWork.id))).toEqual(['hello work, I am wendy', 'hello wendy, this is work', 'one more thing for work']);
    expect(texts(mailbox.history(atFirst.id))).toEqual(['to the first address']);
    expect(mailbox.unread()).toEqual({ [atFirst.id]: 1, [atWork.id]: 1 });
  });

  it('a row that still carries another pair\'s id (written by something older) is nobody\'s here: every reader leaves it out, the views name no contact, the attendant never answers it', async () => {
    // the readers are scoped on their own — whatever the store did or did not move: put the shared id back by hand
    const { db, mailbox, wendy, id, hello, answer, more } = removedAtWork();
    const atFirst = mailbox.contacts.set(mailbox.contacts.ensureAddress(wendy, '').id, { remark: 'wendy-private', group: 'friend' });
    db.prepare('UPDATE messages SET contact_id = ? WHERE id IN (?, ?, ?)').run(id, hello.id, answer.id, more.id);
    expect(atFirst.id).toBe(id);
    expect(mailbox.history(id)).toEqual([]);
    expect(mailbox.todo({ contactId: id })).toEqual([]);
    expect(mailbox.unread()).toEqual({}); // it counts for nobody — not for the first address's contact
    expect([mailbox.unread(''), mailbox.unread(work)]).toEqual([{}, {}]);
    const row = mailbox.getMessage(more.id)!;
    expect([row.contactId, mailbox.contactOf(row), mailbox.addressOf(row)]).toEqual([id, null, work]);
    // the plugin views: no contact at all — not the id (it is another contact's), no name, group or state
    expect(viewOf(mailbox, row).contact).toBeNull();
    expect(messageViewOf(mailbox, row)).toMatchObject({ id: more.id, contact: null, myAddress: null, text: 'one more thing for work' });
    expect((await createLocalCore(mailbox).todo()).map((m) => [m.id, m.contact])).toEqual([[more.id, null]]);
    const events = createEventSource(mailbox, { sinceSeq: 0 }).poll().filter((e) => e.type === 'message');
    expect(events.map((e) => (e.type === 'message' ? [e.id, e.contact] : null))).toEqual([[hello.id, null], [more.id, null]]);
    // the label of a sender is the remark of ITS pair's contact: work's mail is not called by the first address's name
    expect(remarkLookupFor(mailbox, row)(wendy)).toBeNull();
    const toFirst = mail(mailbox, wendy, '', 'to my first address');
    expect(remarkLookupFor(mailbox, toFirst)(wendy)).toBe('wendy-private');
    // the attendant: `friend` has a profile — the stray row of `work` is never answered as that contact
    const t = attendant(mailbox, (d) => ({ groups: { friend: { cwd: d.friend } } }));
    await t.turn();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.prompt).toContain('to my first address');
    for (const text of ['hello work, I am wendy', 'hello wendy, this is work', 'one more thing for work']) expect(t.calls[0]!.prompt + t.calls[0]!.system).not.toContain(text);
    expect(mailbox.getMessage(more.id)!.processedAt).toBeUndefined();
    const answers = mailbox.history(id).filter((m) => m.direction === 'out');
    expect(answers.map((m) => [mailbox.addressOf(m), m.parts[0]!.text.startsWith('answer 1')])).toEqual([['', true]]); // answered from my first address, as that contact
  });
});

describe('two contacts of one peer, at two of my addresses (ADR-083 review R3)', () => {
  it('history, to-process and unread of each are its own rows — also as the attendant\'s context', async () => {
    const { mailbox } = store();
    const pat = someone();
    const a = mailbox.contacts.set(mailbox.contacts.ensureAddress(pat, '').id, { remark: 'pat-home', group: 'friend' });
    const b = mailbox.contacts.set(mailbox.contacts.ensureAddress(pat, work).id, { remark: 'pat-office', group: 'client' });
    expect([a.id, b.id]).toEqual([`a:${pat}`, `a:${pat}~${work}`]);
    const toFirst = mail(mailbox, pat, '', 'private matter');
    const toWork = mail(mailbox, pat, work, 'work matter');
    sent(mailbox, pat, work, 'work answer');
    expect(texts(mailbox.history(a.id))).toEqual(['private matter']);
    expect(texts(mailbox.history(b.id))).toEqual(['work matter', 'work answer']);
    expect(mailbox.todo({ contactId: a.id }).map((m) => m.id)).toEqual([toFirst.id]);
    expect(mailbox.todo({ contactId: b.id }).map((m) => m.id)).toEqual([toWork.id]);
    expect(mailbox.unread()).toEqual({ [a.id]: 1, [b.id]: 1 });
    expect([mailbox.unread(''), mailbox.unread(work)]).toEqual([{ [a.id]: 1 }, { [b.id]: 1 }]);
    expect([mailbox.contactOf(toFirst)!.remark, mailbox.contactOf(toWork)!.remark]).toEqual(['pat-home', 'pat-office']);
    expect([mailbox.addressOf(toFirst), mailbox.addressOf(toWork)]).toEqual(['', work]);
    expect([remarkLookupFor(mailbox, toFirst)(pat), remarkLookupFor(mailbox, toWork)(pat)]).toEqual(['pat-home', 'pat-office']);
    // the attendant answers each from its own contact, with its own context
    const t = attendant(mailbox, (d) => ({ groups: { friend: { cwd: d.friend }, client: { cwd: d.client } } }));
    await t.turn();
    expect(t.calls).toHaveLength(2);
    const byCwd = Object.fromEntries(t.calls.map((c) => [c.cwd, c.prompt]));
    expect(byCwd[t.dirs.friend]).toContain('private matter');
    expect(byCwd[t.dirs.friend]).not.toMatch(/work matter|work answer/);
    expect(byCwd[t.dirs.client]).toContain('work matter');
    expect(byCwd[t.dirs.client]).not.toContain('private matter');
    // a thread I started from `work` is "my own thread" only for mail that comes back to `work`
    const started = sent(mailbox, pat, work, 'a question from work');
    expect(mail(mailbox, pat, '', 'the same thread id, to my first address', { contextId: started.contextId })).toMatchObject({ contactId: a.id, to: { sessionId: 'inbox' } });
    expect(mail(mailbox, pat, '', 'again', { contextId: started.contextId }).ownThread).toBeUndefined();
    expect(mail(mailbox, pat, work, 'the answer, to work', { contextId: started.contextId })).toMatchObject({ contactId: b.id, ownThread: true, to: { agent: 'claude', sessionId: 's-1' } });
  });

  it('the prompt hook names a sender by the contact of the pair the mail belongs to', () => {
    const { mailbox } = store();
    const pat = someone();
    mailbox.contacts.set(mailbox.contacts.ensureAddress(pat, '').id, { remark: 'pat-home' });
    mailbox.contacts.set(mailbox.contacts.ensureAddress(pat, work).id, { remark: 'pat-office' });
    const home = freshHome('hook-');
    mail(mailbox, pat, work, 'work matter');
    expect(collectInbox(mailbox, 's-hook', { home, now })).toMatch(new RegExp(`1 new message from pat-office \\(${pat}\\)`));
    mail(mailbox, pat, '', 'private matter');
    expect(collectInbox(mailbox, 's-hook', { home, now })).toMatch(new RegExp(`1 new message from pat-home \\(${pat}\\)`));
  });
});

describe('a computer with ONE address: nothing changes (ADR-083 review R3)', () => {
  it('ids, history, to-process and unread are what they were; removing and adding a contact again finds its history under the same id; no row is ever moved', () => {
    const solo = computer('solo', 'main');
    const ctx = homeContactContext(solo.home);
    const db = createDb(':memory:', { ctx });
    const mailbox = createMailbox(db, { ctx, now });
    const peer = someone();
    const send = (text: string) => mailbox.send({ from: { agent: 'claude', sessionId: '', device: peer }, to: { agent: 'main', sessionId: 'inbox' }, text, fromTier: 'peer', myAddress: solo.address });
    const c = mailbox.contacts.ensureAddress(peer);
    const one = send('one');
    const out = mailbox.send({ from: { agent: 'claude', sessionId: 's-1' }, to: { agent: 'user', sessionId: '', device: peer }, text: 'two' });
    const old = mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'kai/mbp' }, to: { agent: 'main', sessionId: 'inbox' }, text: 'the old way', fromTier: 'peer' });
    expect(c.id).toBe(`a:${peer}`);
    expect([one.contactId, out.contactId, old.contactId]).toEqual([c.id, c.id, 'c:kai']);
    expect(texts(mailbox.history(c.id))).toEqual(['one', 'two']);
    expect(texts(mailbox.history('c:kai'))).toEqual(['the old way']);
    expect(mailbox.unread()).toEqual({ [c.id]: 1, 'c:kai': 1 });
    expect(mailbox.unread('')).toEqual(mailbox.unread());
    expect(mailbox.todo({ contactId: c.id }).map((m) => m.id)).toEqual([one.id]);
    expect([mailbox.contactOf(one)!.id, mailbox.contactOf(old)!.id, mailbox.addressOf(one), mailbox.addressOf(old)]).toEqual([c.id, 'c:kai', '', '']);
    const before = db.prepare('SELECT id, contact_id FROM messages ORDER BY rowid').all();
    mailbox.contacts.remove(c.id);
    expect(texts(mailbox.history(c.id))).toEqual(['one', 'two']); // a removed contact's history stays
    const again = mailbox.contacts.ensureAddress(peer);
    expect(again.id).toBe(c.id);
    expect(texts(mailbox.history(again.id))).toEqual(['one', 'two']);
    expect(mailbox.unread()).toEqual({ [c.id]: 1, 'c:kai': 1 });
    expect(db.prepare('SELECT id, contact_id FROM messages ORDER BY rowid').all()).toEqual(before);
  });

  it('a store that was never told its first address (as most tests make one): the same', () => {
    const db = createDb(':memory:');
    const mailbox = createMailbox(db, { now });
    const peer = someone();
    const c = mailbox.contacts.ensureAddress(peer);
    const m = mailbox.send({ from: { agent: 'claude', sessionId: '', device: peer }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'hello', fromTier: 'peer' });
    expect([c.id, m.contactId]).toEqual([`a:${peer}`, `a:${peer}`]);
    expect(texts(mailbox.history(c.id))).toEqual(['hello']);
    expect(mailbox.unread()).toEqual({ [c.id]: 1 });
    mailbox.contacts.remove(c.id);
    expect(mailbox.contacts.ensureAddress(peer).id).toBe(c.id);
    expect(texts(mailbox.history(c.id))).toEqual(['hello']);
  });
});

describe('through the real CLI: `morse message <who>` reads the pair (ADR-083 review R3)', () => {
  it('the peer added again at my first address: `morse message <peer> --json` shows nothing of the mail with `work`; added at `work`: `--from work` shows it', { timeout: spawnBudget(7) }, async () => {
    const { db, mailbox } = storeOf(ann.home);
    const wendy = someone();
    const id = movedToWork(db, wendy, 'Wendy');
    const hello = mail(mailbox, wendy, work, 'hello work, I am wendy');
    sent(mailbox, wendy, work, 'hello wendy, this is work');
    const dead = String(await freePort()); // (no daemon runs: nothing listens there)
    expect((await cliAt(ann.home, ['contact', 'remove', 'Wendy'])).code).toBe(0);
    // added again at my first address — by the command
    const add = await cliAt(ann.home, ['contact', 'add', wendy, '--port', dead, '--json']);
    expect(add.code, add.err).toBe(0);
    const atFirst = mailbox.contacts.byAddress(wendy, '')!;
    expect(atFirst.id).toBe(id);
    const view = async (...args: string[]) => {
      const r = await cliAt(ann.home, ['message', ...args, '--json']);
      expect(r.code, r.err).toBe(0);
      return JSON.parse(r.out) as { contact?: { id: string; unread: number; myAddress: { name: string } | null }; messages: Array<{ id: string; text: string; contact: { id: string } | null }>; unread?: Array<{ contact: string; count: number }> };
    };
    const first = await view(wendy);
    expect(first.contact).toMatchObject({ id, unread: 0, myAddress: { name: 'mini' } });
    expect(first.messages).toEqual([]);
    // the to-process list: work's unread mail is listed for `work` — under no contact of the first address
    const todo = await view();
    expect(todo.messages.map((m) => [m.id, m.contact])).toEqual([[hello.id, { id: `a:${wendy}~${work}` }]]);
    expect(todo.unread).toEqual([{ contact: `a:${wendy}~${work}`, remark: null, handle: null, group: null, count: 1 }]);
    expect((await view('--from', 'mini')).messages).toEqual([]);
    // …and added at `work` too: that contact has the history
    expect((await cliAt(ann.home, ['contact', 'add', wendy, '--from', 'work', '--port', dead])).code).toBe(0);
    const atWork = await view(wendy, '--from', 'work');
    expect(atWork.contact).toMatchObject({ id: `a:${wendy}~${work}`, unread: 1, myAddress: { name: 'work' } });
    expect(atWork.messages.map((m) => m.text)).toEqual(['hello work, I am wendy', 'hello wendy, this is work']);
  });
});

// --- the attendant over a mailbox (a fake `claude -p` that answers "answer <n>") ---------------------------------

interface Call {
  cwd: string | undefined;
  prompt: string;
  system: string;
}
function attendant(mailbox: Mailbox, config: (dirs: { friend: string; client: string }) => Record<string, unknown>) {
  const h = join(freshHome('attendant-pairs-'), 'home');
  const dirs = { friend: join(h, 'work', 'friend'), client: join(h, 'work', 'client') };
  const inbox = join(h, '.morse', 'inbox-files');
  for (const d of [...Object.values(dirs), inbox]) mkdirSync(d, { recursive: true });
  const settings: AttendantSettings = parseAttendantConfig({ coalesceSec: 0, ...config(dirs) }, { home: h, morseDir: join(h, '.morse') });
  expect(settings.errors).toEqual([]);
  const stateDir = join(h, '.morse', 'plugins', 'attendant');
  const peek = () => clock;
  const state = createAttendantState(stateDir, peek);
  const calls: Call[] = [];
  const exec: ExecFn = async (_cmd, args, opts) => {
    const session = args.includes('--resume') ? args[args.indexOf('--resume') + 1]! : args[args.indexOf('--session-id') + 1]!;
    calls.push({ cwd: opts.cwd, prompt: args[args.length - 1]!, system: args[args.indexOf('--append-system-prompt') + 1] ?? '' });
    return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `answer ${calls.length}`, session_id: session, permission_denials: [] }) };
  };
  const logs: string[] = [];
  let idn = 0;
  const engine = createEngine({ core: createLocalCore(mailbox), exec, state, approvals: createApprovalStore(stateDir), settings: () => settings, ilinkEnabled: () => false, pluginArgv: ['/usr/bin/node', '/opt/morse/attendant/main.js'], stateDir, home: h, inboxFilesDir: inbox, now: peek, newId: () => `00000000-0000-4000-8000-${String(++idn).padStart(12, '0')}`, log: (l) => logs.push(l), osNotify: () => undefined });
  // (the attendant only answers mail that arrived after it was first on: it starts "a minute ago")
  clock -= 60_000;
  engine.recover();
  clock += 60_000;
  const turn = async () => {
    clock += 10_000;
    await engine.idle();
  };
  return { dirs, state, engine, calls, logs, turn, stateDir };
}

describe('the attendant\'s turns per thread are counted per (contact, thread) (ADR-083 review R5)', () => {
  const capped = (d: { friend: string; client: string }) => ({ groups: { friend: { cwd: d.friend, maxTurnsPerContext: 2 }, client: { cwd: d.client, maxTurnsPerContext: 2 } } });

  it('the same thread id used by one peer at two of my addresses: each contact has its own count — and one contact still hits its limit', async () => {
    const { mailbox } = store();
    const pat = someone();
    const a = mailbox.contacts.set(mailbox.contacts.ensureAddress(pat, '').id, { group: 'friend' });
    const b = mailbox.contacts.set(mailbox.contacts.ensureAddress(pat, work).id, { group: 'client' });
    const t = attendant(mailbox, capped);
    const THREAD = 'one-thread-id-chosen-by-the-sender';
    // two turns in that thread at my first address: its limit is reached there
    for (const text of ['first, to mini', 'second, to mini']) {
      mail(mailbox, pat, '', text, { contextId: THREAD });
      await t.turn();
    }
    expect(t.calls.map((c) => c.cwd)).toEqual([t.dirs.friend, t.dirs.friend]);
    expect(Object.keys(t.state.read().contextTurns)).toEqual([contextKey(a.id, THREAD)]);
    // the same thread id at `work`: answered — nothing was used up there
    for (const text of ['first, to work', 'second, to work']) {
      mail(mailbox, pat, work, text, { contextId: THREAD });
      await t.turn();
    }
    expect(t.calls.map((c) => c.cwd)).toEqual([t.dirs.friend, t.dirs.friend, t.dirs.client, t.dirs.client]);
    expect(t.logs.join('\n')).not.toMatch(/thread limit/);
    expect(Object.fromEntries(Object.entries(t.state.read().contextTurns).map(([k, v]) => [k, v.length]))).toEqual({ [contextKey(a.id, THREAD)]: 2, [contextKey(b.id, THREAD)]: 2 });
    // a third one at each: both are over THEIR limit now, each said for its own lane
    const third = [mail(mailbox, pat, '', 'third, to mini', { contextId: THREAD }), mail(mailbox, pat, work, 'third, to work', { contextId: THREAD })];
    await t.turn();
    expect(t.calls).toHaveLength(4);
    expect(t.logs.filter((l) => /thread limit reached/.test(l)).map((l) => l.split(':')[0]).sort()).toEqual([`mini/a`, `work/a`].sort());
    for (const m of third) expect(t.state.read().messages[m.id]).toMatchObject({ state: 'deferred', reason: 'thread limit (2 turns a day)' });
    // another thread with the same contact is not affected
    mail(mailbox, pat, '', 'another thread, to mini');
    await t.turn();
    expect(t.calls).toHaveLength(5);
  });

  it('a state file from before (turns keyed by the thread id alone): not read as anybody\'s count, no crash, gone at the next write', async () => {
    const { mailbox } = store();
    const pat = someone();
    mailbox.contacts.set(mailbox.contacts.ensureAddress(pat, '').id, { group: 'friend' });
    const b = mailbox.contacts.set(mailbox.contacts.ensureAddress(pat, work).id, { group: 'client' });
    const t = attendant(mailbox, capped);
    const THREAD = 'a-thread-from-before';
    // what the release before wrote: `contexts[<thread id>]` — here already at the limit, and one whose key looks like a new one
    const { writeFileSync, readFileSync } = await import('node:fs');
    const file = join(t.stateDir, 'state.json');
    const was = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...was, contextTurns: undefined, contexts: { [THREAD]: [clock - 1000, clock - 500], [contextKey(b.id, THREAD)]: [clock - 1000, clock - 500] } }));
    expect(t.state.read().contextTurns).toEqual({});
    mail(mailbox, pat, work, 'to work, in the old thread', { contextId: THREAD });
    await t.turn();
    expect(t.calls).toHaveLength(1); // answered: the old counts are nobody's
    const after = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(after['contexts']).toBeUndefined();
    expect(Object.keys(after['contextTurns'] as object)).toEqual([contextKey(b.id, THREAD)]);
    expect(contextKey('a:x', 'y')).not.toBe(contextKey('a:x\ny', ''));
    expect(contextKey('a', 'b,c')).not.toBe(contextKey('a,b', 'c'));
  });
});
