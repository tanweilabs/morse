import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { replyHint } from '../src/hooks/prompt-hook.js';
import { dataDir } from '../src/home.js';
import { createDb, CURRENT_SCHEMA_VERSION, mailboxVersion } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

/**
 * The inbox hook (`morse hook <kind>`) runs before the user's prompt goes out, and the agent CLI waits
 * for it — Codex for the 10 s our entry asks for (ADR-080). So it must never be the process that creates
 * the mailbox, nor the one that performs — or waits behind — a schema migration (ADR-083: a backup and a
 * transaction, up to 30 s on the lock). Through the real CLI, temp MORSE_HOME + HOME.
 */

const repo = resolve(__dirname, '..');
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-hook-quick-'));
  homes.push(h);
  return h;
};
const hook = (home: string, kind: string, input: unknown) =>
  new Promise<{ code: number | null; out: string; err: string; ms: number }>((done) => {
    const t = Date.now();
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'hook', kind], { cwd: repo, env: { ...process.env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err, ms: Date.now() - t }));
    p.stdin.end(JSON.stringify(input));
  });
const SESSION = { session_id: '00000000-0000-4000-8000-00000000abcd' };

describe('morse hook is quick and touches nothing it should not', () => {
  it('no mailbox yet: no context, and no mailbox is created', async () => {
    const home = freshHome();
    const r = await hook(home, 'codex-prompt-submit', SESSION);
    expect({ code: r.code, out: r.out.trim(), err: r.err }).toEqual({ code: 0, out: '{}', err: '' });
    expect(existsSync(join(dataDir(home), 'mailbox.db'))).toBe(false);
  }, 30_000);

  it('a mailbox of an older schema: no context, silently — the hook does not migrate it, takes no backup, says nothing', async () => {
    const home = freshHome();
    const path = join(dataDir(home), 'mailbox.db');
    createMailbox(createDb(path)); // this build's schema …
    const db = new Database(path);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`); // … marked as the release before (a migration is due)
    db.close();
    const before = readdirSync(dataDir(home)).sort();
    for (const kind of ['codex-prompt-submit', 'claude-prompt-submit']) {
      const r = await hook(home, kind, SESSION);
      expect({ code: r.code, out: r.out.trim(), err: r.err }, kind).toEqual({ code: 0, out: '{}', err: '' });
    }
    expect(mailboxVersion(path)).toBe(CURRENT_SCHEMA_VERSION - 1); // still to do — by the daemon, or the next ordinary command
    expect(existsSync(join(dataDir(home), 'backups'))).toBe(false);
    expect(readdirSync(dataDir(home)).filter((f) => !f.startsWith('mailbox.db')).sort()).toEqual(before.filter((f) => !f.startsWith('mailbox.db')));
  }, 60_000);

  it('a mailbox of this schema: the hook works as before (nothing waiting: no context)', async () => {
    const home = freshHome();
    mkdirSync(dataDir(home), { recursive: true });
    createMailbox(createDb(join(dataDir(home), 'mailbox.db')));
    const r = await hook(home, 'claude-prompt-submit', SESSION);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({});
    expect(mailboxVersion(join(dataDir(home), 'mailbox.db'))).toBe(CURRENT_SCHEMA_VERSION);
  }, 30_000);
});

describe('what the hook tells the agent about answering', () => {
  it('macOS / Linux: the text as an argument, as before; Windows: a file — morse refuses the argument from a program there', () => {
    expect(replyHint('abc', 'darwin')).toBe('To answer, run: anyd reply abc "<your reply>"');
    expect(replyHint('abc', 'linux')).toBe('To answer, run: anyd reply abc "<your reply>"');
    expect(replyHint('abc', 'win32')).toBe('To answer, write your reply to a UTF-8 file and run: anyd reply abc --text-file <that file>');
  });
});
