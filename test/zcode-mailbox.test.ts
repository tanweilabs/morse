import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  isSessionBusy,
  mailboxEnabledFor,
  mailboxRoot,
  postToMailbox,
  reclaimMail,
  type MailboxEnvelope,
} from '../src/adapters/zcode-mailbox.js';

const SID = 'sess_0c4f2a7e-91b3-4d65-a8e0-7b1c2d3e4f50';
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const freshRoot = () => {
  const created = mkdtempSync(join(tmpdir(), 'morse-zmailbox-'));
  made.push(created);
  return created;
};
const letter = (patch: Partial<MailboxEnvelope> = {}): MailboxEnvelope => ({
  messageId: 'msg-1',
  fromSessionId: 'anytoany',
  toSessionId: SID,
  content: 'hello zcode',
  createdAt: '2026-11-16T08:00:00.000Z',
  ...patch,
});

describe('where the mailbox lives', () => {
  it('ZCODE_MAILBOX_ROOT when set (with ~ expanded), otherwise ~/.zcode/mailbox', () => {
    expect(mailboxRoot({}, '/Users/me')).toBe('/Users/me/.zcode/mailbox');
    expect(mailboxRoot({ ZCODE_MAILBOX_ROOT: '/var/mail/zc' }, '/Users/me')).toBe('/var/mail/zc');
    expect(mailboxRoot({ ZCODE_MAILBOX_ROOT: '~/inbox/zc' }, '/Users/me')).toBe('/Users/me/inbox/zc');
    expect(mailboxRoot({ ZCODE_MAILBOX_ROOT: '~' }, '/Users/me')).toBe('/Users/me');
    expect(mailboxRoot({ ZCODE_MAILBOX_ROOT: 'relative/~/x' }, '/Users/me')).toBe('relative/~/x');
  });

  it('a session has its mailbox on once ZCode has made its unread/ folder', () => {
    const mailboxes = freshRoot();
    const enabled = (id = SID) => mailboxEnabledFor(mailboxes, id);
    expect(enabled()).toBe(false);
    mkdirSync(join(mailboxes, SID), { recursive: true });
    expect(enabled()).toBe(false);
    mkdirSync(join(mailboxes, SID, 'unread'));
    expect(enabled()).toBe(true);
    expect(enabled('../escape')).toBe(false);
  });
});

describe('posting a letter', () => {
  it('lands as one complete version-1 JSON file in unread/, readable only by the owner', () => {
    const root = freshRoot();
    const before = Date.now();
    const path = postToMailbox(root, letter());
    expect(dirname(path)).toBe(join(root, SID, 'unread'));
    const [stamp, rest] = basename(path).split(/-(.*)/s);
    expect(Number(stamp)).toBeGreaterThanOrEqual(before);
    expect(rest).toBe('msg-1.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, ...letter() });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, SID))).toEqual(['unread']);
  });

  it('a message id is made safe for a file name', () => {
    const root = freshRoot();
    const path = postToMailbox(root, letter({ messageId: 'a/b\\c d:é.v2' }));
    expect(basename(path)).toMatch(/^\d+-a_b_c_d__\.v2\.json$/);
  });

  it('refuses session ids ZCode itself would refuse, before touching the disk', () => {
    const root = freshRoot();
    for (const bad of ['../etc', 'sess_a/../../x', 'sess_..', 'session_1', 'sess_', 'sess_a b']) {
      expect(() => postToMailbox(root, letter({ toSessionId: bad }))).toThrow(`invalid ZCode session id for the mailbox: ${bad}`);
    }
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('taking a letter back', () => {
  it('works while it is still unread, and leaves nothing behind', () => {
    const root = freshRoot();
    const path = postToMailbox(root, letter());
    expect(reclaimMail(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(root, SID, 'unread'))).toEqual([]);
  });

  it('fails once ZCode has drained it — exactly one side gets the letter', () => {
    const root = freshRoot();
    const path = postToMailbox(root, letter());
    mkdirSync(join(root, SID, 'read'));
    renameSync(path, join(root, SID, 'read', basename(path)));
    expect(reclaimMail(path)).toBe(false);
    expect(readdirSync(join(root, SID, 'read'))).toEqual([basename(path)]);
  });
});

describe('is the session mid-turn? (ZCode\'s message table)', () => {
  const NOW = 1_800_000_000_000;
  type Msg = { session?: string; role?: string; created?: number; completed?: number; raw?: string; at?: number };
  function messages(rows: Msg[]): string {
    const file = join(freshRoot(), 'db.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
    rows.forEach((m, i) => {
      const data = m.raw ?? JSON.stringify({ role: m.role, time: { created: m.created, ...(m.completed ? { completed: m.completed } : {}) } });
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`m${i}`, m.session ?? SID, m.at ?? m.created ?? 0, data);
    });
    db.close();
    return file;
  }
  const busy = (rows: Msg[]) => isSessionBusy(messages(rows), SID, NOW);

  it('an assistant message that has not completed, younger than 30 minutes: busy', () => {
    expect(busy([{ role: 'user', created: NOW - 60_000 }, { role: 'assistant', created: NOW - 59_000 }])).toBe(true);
    expect(busy([{ role: 'assistant', created: NOW - 29 * 60_000 }])).toBe(true);
  });

  it('a completed one, or one "running" for 30 minutes or more (a crash leftover): not busy', () => {
    expect(busy([{ role: 'assistant', created: NOW - 5000, completed: NOW - 100 }])).toBe(false);
    expect(busy([{ role: 'assistant', created: NOW - 30 * 60_000 }])).toBe(false);
  });

  it('a user message under a minute old with no answer yet: the turn is starting', () => {
    expect(busy([{ role: 'user', created: NOW - 59_999 }])).toBe(true);
    expect(busy([{ role: 'user', created: NOW - 60_000 }])).toBe(false);
  });

  it('only the newest message of THIS session counts', () => {
    expect(busy([{ role: 'assistant', created: NOW - 1000 }, { role: 'assistant', created: NOW - 900, completed: NOW - 10 }])).toBe(false);
    expect(busy([{ role: 'assistant', created: NOW - 1000 }, { session: 'sess_other', role: 'assistant', created: NOW - 10, completed: NOW }])).toBe(true);
    // same timestamp: the row written last wins
    expect(busy([{ role: 'assistant', created: NOW - 1000, completed: NOW - 500, at: 5 }, { role: 'assistant', created: NOW - 1000, at: 5 }])).toBe(true);
  });

  it('anything it cannot read means not busy', () => {
    expect(isSessionBusy(join(tmpdir(), 'morse-no-zcode-db.sqlite'), SID, NOW)).toBe(false);
    expect(busy([])).toBe(false);
    expect(busy([{ raw: 'not json', at: NOW }])).toBe(false);
    expect(busy([{ role: 'system', created: NOW }])).toBe(false);
    const noTable = join(freshRoot(), 'empty.sqlite');
    new Database(noTable).close();
    expect(isSessionBusy(noTable, SID, NOW)).toBe(false);
  });
});

describe('doctor reports the ZCode doorbell', () => {
  it('nothing without ZCode; off with how to turn it on; on once a session used it', async () => {
    const doctor = await import('../src/doctor.js');
    const mailboxes = freshRoot();
    expect(doctor.zcodeMailboxCheck(mailboxes, false)).toBe(null);
    expect(doctor.zcodeMailboxCheck(join(mailboxes, 'missing'), true)?.note).toMatch(/^off .*launchctl setenv ZCODE_MESSAGE_ENABLED 1/);
    mkdirSync(join(mailboxes, SID, 'unread'), { recursive: true });
    const on = doctor.zcodeMailboxCheck(mailboxes, true);
    expect(on?.note.startsWith('on — 1 session')).toBe(true);
  });
});
