import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, STRANDED_NOTE, type Mailbox, type MessageFile } from '../src/mailbox/mailbox.js';

// Core mailbox behaviour: storing messages, conversations, the delivery state machine and the
// pull-mode inbox. Lease, contact and address behaviour have their own test files.

const PLANNER = { agent: 'claude', sessionId: '0a0a0a0a-1111-4000-8000-0000000000a1' };
const BUILDER = { agent: 'codex', sessionId: '0b0b0b0b-2222-4000-8000-0000000000b2' };
const REVIEWER = { agent: 'kimi', sessionId: '0c0c0c0c-3333-4000-8000-0000000000c3' };

let mb: Mailbox;
let clock: number;
const tick = (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  clock = 1_750_000_000_000;
  mb = createMailbox(createDb(':memory:'), { now: () => clock });
});

/** Claim `id` and report a failure `times` times, waiting out the backoff in between. */
function failRepeatedly(id: string, times: number, error = 'it broke'): void {
  for (let i = 0; i < times; i++) {
    expect(mb.claimNextPending()?.id).toBe(id);
    mb.markFailed(id, error);
    tick(30_000);
  }
}

describe('send', () => {
  it('stores a pending text message that starts its own context', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'draft the plan' });
    expect(m).toMatchObject({ status: 'pending', attempts: 0, from: PLANNER, to: BUILDER, createdAt: clock, updatedAt: clock });
    expect(m.contextId).toBe(m.id);
    expect(m.parts).toEqual([{ type: 'text', text: 'draft the plan' }]);
    expect(m.lastError).toBeUndefined();
    expect(mb.getMessage(m.id)).toEqual(m);
  });

  it('keeps a given context id, the via label and attached files in the part', () => {
    const file: MessageFile = { name: 'a.txt', path: '/tmp/a.txt', size: 3, sha256: 'abc' };
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'see file', contextId: 'ctx-1', via: 'cli', files: [file] });
    expect(m.contextId).toBe('ctx-1');
    expect(m.parts).toEqual([{ type: 'text', text: 'see file', via: 'cli', files: [file] }]);
  });

  it('records the devices of both ends, and omits a device for this machine', () => {
    const m = mb.send({ from: PLANNER, to: { ...BUILDER, device: 'studio' }, text: 'over there' });
    expect(m.to).toEqual({ ...BUILDER, device: 'studio' });
    expect(m.from).toEqual(PLANNER);
    expect('device' in m.from).toBe(false);
  });

  it('getMessage is null for an unknown id', () => {
    expect(mb.getMessage('missing')).toBeNull();
  });
});

describe('conversations', () => {
  it('one conversation per pair of sessions, whichever way the message goes', () => {
    const a = mb.send({ from: PLANNER, to: BUILDER, text: '1' });
    const b = mb.send({ from: BUILDER, to: PLANNER, text: '2' });
    const c = mb.send({ from: PLANNER, to: REVIEWER, text: '3' });
    expect(b.conversationId).toBe(a.conversationId);
    expect(c.conversationId).not.toBe(a.conversationId);
    expect(mb.listConversations()).toHaveLength(2);
  });

  it('the same session on another device is another pair', () => {
    const here = mb.send({ from: PLANNER, to: BUILDER, text: 'local' });
    const there = mb.send({ from: PLANNER, to: { ...BUILDER, device: 'studio' }, text: 'remote' });
    expect(there.conversationId).not.toBe(here.conversationId);
  });

  it('summarises each conversation, most recently active first', () => {
    const first = mb.send({ from: PLANNER, to: BUILDER, text: 'a1' });
    tick(1_000);
    const created = clock;
    mb.send({ from: PLANNER, to: { ...REVIEWER, device: 'studio' }, text: 'b1' });
    tick(1_000);
    mb.send({ from: BUILDER, to: PLANNER, text: 'a2' });
    const [top, second] = mb.listConversations();
    expect(top).toMatchObject({ id: first.conversationId, a: PLANNER, b: BUILDER, messageCount: 2, lastMessageAt: clock, createdAt: created - 1_000 });
    expect(top?.lastMessage?.parts[0]?.text).toBe('a2');
    expect(second).toMatchObject({ a: PLANNER, b: { ...REVIEWER, device: 'studio' }, messageCount: 1, createdAt: created, lastMessageAt: created });
  });

  it('an empty mailbox has no conversations', () => {
    expect(mb.listConversations()).toEqual([]);
  });

  it('lists the messages of one conversation oldest first', () => {
    const q = mb.send({ from: PLANNER, to: BUILDER, text: 'q' });
    tick(5);
    mb.reply(q.id, 'a');
    tick(5);
    mb.send({ from: PLANNER, to: REVIEWER, text: 'elsewhere' });
    expect(mb.listMessages(q.conversationId).map((m) => m.parts[0]?.text)).toEqual(['q', 'a']);
    expect(mb.listMessages('unknown')).toEqual([]);
  });

  it('an explicit conversation id files a third party into that thread and bumps it', () => {
    const user = { agent: 'user', sessionId: 'cli' };
    const remote = { agent: 'zcode', sessionId: 'sess_9', device: 'mini' };
    const seed = mb.send({ from: PLANNER, to: remote, text: 'kickoff' });
    tick(2_000);
    const aside = mb.send({ from: user, to: remote, text: 'note from the human', conversationId: seed.conversationId });
    const back = mb.reply(aside.id, 'noted');
    expect([aside.conversationId, back.conversationId]).toEqual([seed.conversationId, seed.conversationId]);
    expect(mb.listConversations()).toEqual([expect.objectContaining({ id: seed.conversationId, messageCount: 3, lastMessageAt: clock })]);
  });

  it('refuses an explicit conversation id that does not exist', () => {
    expect(() => mb.send({ from: PLANNER, to: BUILDER, text: 'x', conversationId: 'nope' })).toThrow('conversation not found: nope');
    expect(mb.listConversations()).toEqual([]);
  });
});

describe('reply', () => {
  it('goes back the other way in the same context and conversation', () => {
    const q = mb.send({ from: PLANNER, to: BUILDER, text: 'ready?' });
    const r = mb.reply(q.id, 'yes', 'hook');
    expect(r).toMatchObject({ from: BUILDER, to: PLANNER, contextId: q.contextId, conversationId: q.conversationId, status: 'pending' });
    expect(r.parts).toEqual([{ type: 'text', text: 'yes', via: 'hook' }]);
  });

  it('a long fast thread is never capped (ADR-072)', () => {
    let m = mb.send({ from: PLANNER, to: BUILDER, text: 'start' });
    for (let i = 0; i < 200; i++) {
      tick(1);
      m = mb.reply(m.id, `turn ${i}`);
    }
    expect(mb.listMessages(m.conversationId).filter((x) => x.contextId === m.contextId)).toHaveLength(201);
  });

  it('fails for an unknown message', () => {
    expect(() => mb.reply('ghost', 'x')).toThrow('message not found: ghost');
  });
});

describe('delivery state machine', () => {
  it('pending → delivering → delivered', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    tick(10);
    const claimed = mb.claimNextPending();
    expect(claimed).toMatchObject({ id: m.id, status: 'delivering', updatedAt: clock });
    expect(mb.claimNextPending()).toBeNull();
    tick(10);
    const done = mb.markDelivered(m.id);
    expect(done).toMatchObject({ status: 'delivered', updatedAt: clock });
    expect(done.deliveredInSession).toBeUndefined();
  });

  it('claims the oldest due message first', () => {
    const older = mb.send({ from: PLANNER, to: BUILDER, text: 'older' });
    tick(1);
    mb.send({ from: PLANNER, to: REVIEWER, text: 'newer' });
    expect(mb.claimNextPending()?.id).toBe(older.id);
  });

  it('records an in-session delivery', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    mb.claimNextPending();
    expect(mb.markDelivered(m.id, { inSession: true }).deliveredInSession).toBe(true);
    expect(mb.getMessage(m.id)?.deliveredInSession).toBe(true);
  });

  it('a failure is retried only after the 30 s backoff', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    mb.claimNextPending();
    expect(mb.markFailed(m.id, 'first try')).toMatchObject({ status: 'failed', attempts: 1, lastError: 'first try' });
    tick(29_999);
    expect(mb.claimNextPending()).toBeNull();
    tick(1);
    expect(mb.claimNextPending()?.id).toBe(m.id);
  });

  it('the third reported failure is final', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    failRepeatedly(m.id, 2);
    expect(mb.getMessage(m.id)?.status).toBe('failed');
    failRepeatedly(m.id, 1, 'third');
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'dead', attempts: 3, lastError: 'third' });
    expect(mb.claimNextPending()).toBeNull();
  });

  it('a terminal failure is final at once', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    mb.claimNextPending();
    expect(mb.markFailed(m.id, 'timed out', { terminal: true })).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('a waiting failure is never final on count and retries on the wait interval', () => {
    const box = createMailbox(createDb(':memory:'), { now: () => clock, waitRetryMs: 5_000 });
    const m = box.send({ from: PLANNER, to: { ...BUILDER, device: 'away' }, text: 'x' });
    for (let i = 0; i < 5; i++) {
      expect(box.claimNextPending()?.id).toBe(m.id);
      expect(box.markFailed(m.id, 'offline', { waiting: true })).toMatchObject({ status: 'failed', waiting: true, attempts: i + 1 });
      tick(4_999);
      expect(box.claimNextPending()).toBeNull();
      tick(1);
    }
  });

  it('terminal wins over waiting', () => {
    const m = mb.send({ from: PLANNER, to: { ...BUILDER, device: 'away' }, text: 'x' });
    mb.claimNextPending();
    const dead = mb.markFailed(m.id, 'never', { terminal: true, waiting: true });
    expect(dead.status).toBe('dead');
    expect(dead.waiting).toBeUndefined();
  });

  it('a waiting message gives up after the maximum wait', () => {
    const box = createMailbox(createDb(':memory:'), { now: () => clock, waitRetryMs: 1_000, waitMaxMs: 2 * 86_400_000 });
    const m = box.send({ from: PLANNER, to: { ...BUILDER, device: 'away' }, text: 'x' });
    box.claimNextPending();
    box.markFailed(m.id, 'offline', { waiting: true });
    tick(2 * 86_400_000);
    expect(box.claimNextPending()).toBeNull();
    expect(box.getMessage(m.id)).toMatchObject({ status: 'dead', lastError: 'gave up: recipient unreachable for 2 days — offline' });
  });

  it('refuses reports on a message that was not claimed', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    expect(() => mb.markDelivered(m.id)).toThrow('illegal transition: pending -> delivered (must claim first)');
    expect(() => mb.markFailed(m.id, 'e')).toThrow('illegal transition: pending -> failed (must claim first)');
    expect(() => mb.markDelivered('ghost')).toThrow('message not found: ghost');
    expect(() => mb.markFailed('ghost', 'e')).toThrow('message not found: ghost');
    expect(mb.getMessage(m.id)?.status).toBe('pending');
  });

  it('skip passes over a target decided at claim time, and sees the device', () => {
    const toBuilder = mb.send({ from: PLANNER, to: BUILDER, text: 'monitored' });
    tick(1);
    const toPlanner = mb.send({ from: BUILDER, to: PLANNER, text: 'free' });
    tick(1);
    const remote = mb.send({ from: PLANNER, to: { ...BUILDER, device: 'studio' }, text: 'remote' });
    const skipLocalBuilder = (session: string, device: string | null) => device === null && session === BUILDER.sessionId;
    expect(mb.claimNextPending({ skip: skipLocalBuilder })?.id).toBe(toPlanner.id);
    expect(mb.claimNextPending({ skip: skipLocalBuilder })?.id).toBe(remote.id);
    expect(mb.claimNextPending({ skip: skipLocalBuilder })).toBeNull();
    expect(mb.getMessage(toBuilder.id)?.status).toBe('pending');
  });
});

describe('retry', () => {
  it('requeues a dead message with a clean count', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    failRepeatedly(m.id, 3);
    tick(7);
    expect(mb.retry(m.id)).toMatchObject({ status: 'pending', attempts: 0, updatedAt: clock });
    expect(mb.claimNextPending()?.id).toBe(m.id);
  });

  it('clears the waiting flag', () => {
    const m = mb.send({ from: PLANNER, to: { ...BUILDER, device: 'away' }, text: 'x' });
    mb.claimNextPending();
    mb.markFailed(m.id, 'offline', { waiting: true });
    expect(mb.retry(m.id).waiting).toBeUndefined();
  });

  it('only failed or dead messages, and only known ones', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    expect(() => mb.retry(m.id)).toThrow('only failed/dead messages can be retried (status: pending)');
    mb.claimNextPending();
    expect(() => mb.retry(m.id)).toThrow('(status: delivering)');
    expect(() => mb.retry('ghost')).toThrow('message not found: ghost');
  });
});

describe('recoverStale', () => {
  it('sets aside what a crashed daemon left mid-delivery; it is claimable after the backoff', () => {
    const m = mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    mb.claimNextPending();
    expect(mb.claimNextPending()).toBeNull();
    expect(mb.recoverStale()).toBe(1);
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'failed', lastError: STRANDED_NOTE });
    tick(30_000);
    expect(mb.claimNextPending()?.id).toBe(m.id);
  });

  it('onlyLocal leaves outbound and human-bound deliveries alone', () => {
    const local = mb.send({ from: PLANNER, to: BUILDER, text: 'local' });
    const outbound = mb.send({ from: PLANNER, to: { ...BUILDER, device: 'studio' }, text: 'out' });
    const human = mb.send({ from: PLANNER, to: { agent: 'user', sessionId: 'cli' }, text: 'human' });
    for (let i = 0; i < 3; i++) mb.claimNextPending();
    expect(mb.recoverStale(true)).toBe(1);
    expect([local, outbound, human].map((m) => mb.getMessage(m.id)?.status)).toEqual(['failed', 'delivering', 'delivering']);
  });

  it('does nothing when nothing is in flight', () => {
    mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    expect(mb.recoverStale()).toBe(0);
  });
});

describe('inbox (pull mode)', () => {
  it('lists what is still open for a session, oldest first; take marks it delivered', () => {
    const one = mb.send({ from: PLANNER, to: BUILDER, text: 'one' });
    tick(1);
    mb.send({ from: BUILDER, to: PLANNER, text: 'not for builder' });
    tick(1);
    const two = mb.send({ from: REVIEWER, to: BUILDER, text: 'two' });
    expect(mb.inbox({ toSession: BUILDER.sessionId }).map((m) => m.id)).toEqual([one.id, two.id]);
    tick(1);
    const taken = mb.inbox({ toSession: BUILDER.sessionId, take: true });
    expect(taken.map((m) => m.id)).toEqual([one.id, two.id]);
    expect(mb.getMessage(one.id)).toMatchObject({ status: 'delivered', updatedAt: clock });
    expect(mb.inbox({ toSession: BUILDER.sessionId })).toEqual([]);
  });

  it('status filters: default open, all, pendingOnly, undeliveredOnly', () => {
    const pending = mb.send({ from: PLANNER, to: BUILDER, text: 'p' });
    tick(1);
    const dead = mb.send({ from: PLANNER, to: BUILDER, text: 'd' });
    tick(1);
    const delivering = mb.send({ from: PLANNER, to: BUILDER, text: 'w' });
    mb.claimById(dead.id);
    mb.markFailed(dead.id, 'x', { terminal: true });
    mb.claimById(delivering.id);
    const ids = (q: Parameters<Mailbox['inbox']>[0]) => mb.inbox(q).map((m) => m.id);
    expect(ids({})).toEqual([pending.id, delivering.id]);
    expect(ids({ all: true })).toEqual([pending.id, dead.id, delivering.id]);
    expect(ids({ pendingOnly: true })).toEqual([pending.id]);
    expect(ids({ undeliveredOnly: true })).toEqual([dead.id]);
  });

  it('narrows by agent', () => {
    const forBuilder = mb.send({ from: PLANNER, to: { agent: 'codex', sessionId: 'inbox' }, text: 'a' });
    mb.send({ from: PLANNER, to: { agent: 'kimi', sessionId: 'inbox' }, text: 'b' });
    expect(mb.inbox({ toSession: 'inbox', toAgent: 'codex' }).map((m) => m.id)).toEqual([forBuilder.id]);
  });

  it('take needs a session scope', () => {
    mb.send({ from: PLANNER, to: BUILDER, text: 'x' });
    expect(() => mb.inbox({ take: true })).toThrow(/needs a scope/);
  });

  it('take never touches an outbound message waiting for its retries', () => {
    const out = mb.send({ from: PLANNER, to: { ...BUILDER, device: 'studio' }, text: 'out' });
    expect(mb.inbox({ toSession: BUILDER.sessionId, take: true })).toEqual([]);
    expect(mb.getMessage(out.id)?.status).toBe('pending');
  });
});

describe('recentActivity', () => {
  it('both directions of a session updated after the cut-off, oldest first, limited', () => {
    const before = mb.send({ from: PLANNER, to: BUILDER, text: 'old' });
    tick(100);
    const since = clock;
    tick(1);
    const sent = mb.send({ from: BUILDER, to: REVIEWER, text: 'sent by builder' });
    tick(1);
    const got = mb.send({ from: PLANNER, to: BUILDER, text: 'for builder' });
    tick(1);
    mb.send({ from: PLANNER, to: REVIEWER, text: 'unrelated' });
    expect(mb.recentActivity(BUILDER.sessionId, since).map((m) => m.id)).toEqual([sent.id, got.id]);
    expect(mb.recentActivity(BUILDER.sessionId, since, 1).map((m) => m.id)).toEqual([sent.id]);
    expect(mb.recentActivity(BUILDER.sessionId, 0).map((m) => m.id)).toEqual([before.id, sent.id, got.id]);
  });

  it('mail another person claims to have sent "from" a session is not that session\'s', () => {
    tick(1);
    mb.send({ from: { ...BUILDER, device: 'stranger-box' }, to: PLANNER, text: 'pretending' });
    expect(mb.recentActivity(BUILDER.sessionId, 0)).toEqual([]);
  });
});

describe('message requests, sender side (ADR-037)', () => {
  it('marks, lists and clears requests, and makes held mail to that person due at once', () => {
    const box = createMailbox(createDb(':memory:'), { now: () => clock, waitRetryMs: 30_000 });
    const me = { agent: 'claude', sessionId: 's1' };
    const opener = box.send({ from: me, to: { agent: 'user', sessionId: '', device: 'dana' }, text: 'hello' });
    const followUp = box.send({ from: me, to: { agent: 'laptop', sessionId: '', device: 'dana/laptop' }, text: 'and this' });
    const someoneElse = box.send({ from: me, to: { agent: 'user', sessionId: '', device: 'danae' }, text: 'other' });
    expect(box.markRequest(opener.id)).toBe(true);
    expect(box.markRequest('ghost')).toBe(false);
    expect(box.getMessage(opener.id)?.request).toBe(true);
    expect(box.requestPendingHandles()).toEqual(['dana']);
    box.claimNextPending();
    box.markDelivered(opener.id);
    for (let i = 0; i < 2; i++) {
      const m = box.claimNextPending()!;
      box.markFailed(m.id, 'waiting to be accepted', { waiting: true });
    }
    expect(box.claimNextPending()).toBeNull();
    expect(box.requestAccepted('DANA')).toBe(1);
    expect(box.getMessage(opener.id)?.request).toBeUndefined();
    expect(box.requestPendingHandles()).toEqual([]);
    expect(box.claimNextPending()?.id).toBe(followUp.id);
    expect(box.claimNextPending()).toBeNull();
    expect(box.getMessage(someoneElse.id)?.status).toBe('failed');
  });
});

describe('optional fields read back from a row', () => {
  it('receipt, waiting and delivered-in-session appear only when set', () => {
    const m = mb.send({ from: PLANNER, to: { ...BUILDER, device: 'studio' }, text: 'x' });
    const plain = mb.getMessage(m.id)!;
    for (const key of ['receiptAt', 'waiting', 'deliveredInSession', 'request', 'ownThread', 'lastError', 'processedAt', 'lease', 'possibleRepeat'] as const) {
      expect(plain[key], key).toBeUndefined();
    }
    expect(mb.markReceipt(m.id, 1234)).toBe(true);
    expect(mb.getMessage(m.id)?.receiptAt).toBe(1234);
  });
});

describe('database layout of a new mailbox', () => {
  const db = createDb(':memory:', { ctx: {} });
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  it('has the base tables with their columns in on-disk order', () => {
    expect(columns('conversations')).toEqual(['id', 'pair_key', 'a_agent', 'a_session', 'a_device', 'b_agent', 'b_session', 'b_device', 'created_at', 'last_message_at']);
    expect(columns('messages').slice(0, 21)).toEqual([
      'id', 'conversation_id', 'context_id', 'from_agent', 'from_session', 'from_device', 'to_agent', 'to_session', 'to_device', 'parts', 'status',
      'attempts', 'last_error', 'created_at', 'updated_at', 'delivered_in_session', 'from_tier', 'receipt_at', 'waiting', 'request', 'own_thread',
    ]);
    expect(columns('inbound_seen')).toEqual(['from_id', 'msg_id', 'seen_at']);
    expect(columns('sessions_cache')).toEqual(['agent', 'session_id', 'title', 'cwd', 'last_active_at']);
    expect(columns('morse_requests')).toEqual(expect.arrayContaining(['dropped_file_list', 'to_address']));
  });

  it('keeps the CREATE text other tools copy verbatim', () => {
    const sql = (name: string) => (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string }).sql;
    expect(sql('conversations')).toBe(
      'CREATE TABLE conversations (\n  id TEXT PRIMARY KEY,\n  pair_key TEXT NOT NULL UNIQUE,\n  a_agent TEXT NOT NULL,\n  a_session TEXT NOT NULL,\n  a_device TEXT,\n  b_agent TEXT NOT NULL,\n  b_session TEXT NOT NULL,\n  b_device TEXT,\n  created_at INTEGER NOT NULL,\n  last_message_at INTEGER NOT NULL\n)',
    );
    expect(sql('inbound_seen')).toBe('CREATE TABLE inbound_seen (\n  from_id TEXT NOT NULL,\n  msg_id TEXT NOT NULL,\n  seen_at INTEGER NOT NULL,\n  PRIMARY KEY (from_id, msg_id)\n)');
    expect(sql('messages')).toMatch(/^CREATE TABLE messages \(\n  id TEXT PRIMARY KEY,\n  conversation_id TEXT NOT NULL REFERENCES conversations\(id\),\n/);
    expect(sql('idx_messages_status')).toBe('CREATE INDEX idx_messages_status ON messages(status, created_at)');
    expect(sql('idx_messages_to')).toBe('CREATE INDEX idx_messages_to ON messages(to_session, status)');
  });

  it('every new mailbox gets exactly the same layout', () => {
    const before = db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    const file = createDb(':memory:', { ctx: {} });
    expect(file.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(before);
  });
});
