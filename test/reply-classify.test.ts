import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyReply } from '../src/envelope.js';
import { dataDir } from '../src/home.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

// ADR-032: whether an agent's reply becomes a message — one rule for the stdout marker (the dispatcher) and for
// `morse reply` / `anyd reply` (what an agent in Codex Desktop's queue runs).
describe('classifyReply', () => {
  it('a reply with content is filed', () => {
    expect(classifyReply('deploy the docs', 'DONE docs deployed')).toBe('file');
    expect(classifyReply('', '')).toBe('file');
  });

  it('NOOP as the first word drops it — alone, after blanks, or with words after it', () => {
    for (const reply of ['NOOP', '   NOOP', '\nNOOP\n', 'NOOP — nothing to add', 'NOOP\tok']) expect(classifyReply('DONE shipped', reply), JSON.stringify(reply)).toBe('noop');
  });

  it('only the word itself: NOOPS, noop or a later NOOP are content', () => {
    for (const reply of ['NOOPS', 'noop', 'nothing new, NOOP']) expect(classifyReply('DONE shipped', reply), reply).toBe('file');
  });

  it('BLOCKED answering BLOCKED is dropped (two waiting agents would confirm each other for ever)', () => {
    expect(classifyReply('BLOCKED need the token', 'BLOCKED so do I')).toBe('blocked-pingpong');
    expect(classifyReply('\n  BLOCKED waiting', '  BLOCKED same')).toBe('blocked-pingpong');
  });

  it('…but anything else answering BLOCKED, or BLOCKED answering something else, is filed', () => {
    expect(classifyReply('BLOCKED need the token', 'it is in the vault under ci/')).toBe('file');
    expect(classifyReply('please check the build', 'BLOCKED no network here')).toBe('file');
  });
});

// The command path end to end, through the real CLI.
describe('morse reply files a real reply and drops a NOOP', () => {
  const homes: string[] = [];
  afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

  /** A home with one message from a Claude session to a Codex session, waiting for its reply. */
  const homeWithMessage = () => {
    const home = mkdtempSync(join(tmpdir(), 'morse-reply-'));
    homes.push(home);
    const mailbox = createMailbox(createDb(join(dataDir(home), 'mailbox.db')));
    const asked = mailbox.send({ from: { agent: 'claude', sessionId: 'cl-1' }, to: { agent: 'codex', sessionId: 'cx-1' }, text: 'DONE the index is rebuilt' });
    return { home, mailbox, id: asked.id };
  };
  const reply = (home: string, id: string, text: string): string =>
    execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'reply', id, text], { env: { ...process.env, MORSE_HOME: home }, encoding: 'utf8' });

  it('NOOP: nothing is filed, so the other side is never woken', () => {
    const { home, mailbox, id } = homeWithMessage();
    expect(reply(home, id, 'NOOP')).toMatch(/no reply sent/);
    expect(mailbox.inbox({ all: true }).map((m) => m.id)).toEqual([id]);
  }, 20_000);

  it('a real reply is queued as a message of its own', () => {
    const { home, mailbox, id } = homeWithMessage();
    expect(reply(home, id, 'DONE thanks, verified')).toMatch(/queued reply/);
    expect(mailbox.inbox({ all: true })).toHaveLength(2);
  }, 20_000);
});
