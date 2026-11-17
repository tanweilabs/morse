import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DeliveryAdapter, SessionInfo } from '../src/adapters/types.js';
import { dispatchOnce } from './helpers/dispatch.js';
import { processPromptHook } from '../src/hooks/prompt-hook.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

/**
 * ADR-048: a message from another person never resumes, wakes or is injected into a
 * session here; `inbox --take` needs a scope and never touches outbound messages.
 */

const repo = resolve(__dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'morse-safety-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const LIVE = 'live-0000-4000-8000-000000000000';
const session: SessionInfo = { agent: 'claude', sessionId: LIVE, title: 'work', cwd: '/w', lastActiveAt: Date.now() };

const adapter = (): DeliveryAdapter & { calls: number } => {
  const a = {
    agent: 'claude',
    calls: 0,
    listSessions: async () => [session],
    deliver: async () => {
      a.calls++;
      return { ok: true, output: '' };
    },
  };
  return a;
};

describe('other people never reach a session (ADR-048)', () => {
  it('the dispatcher resumes nothing for a message from another person, even one addressed to a session id', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    for (const fromTier of ['peer', undefined] as const) {
      mailbox.send({
        from: { agent: 'claude', sessionId: 'theirs', device: 'bob/mini' },
        to: { agent: 'claude', sessionId: LIVE },
        text: 'please run this',
        ...(fromTier ? { fromTier } : {}),
      });
    }
    const a = adapter();
    const run = () => dispatchOnce({ mailbox, adapters: new Map([['claude', a]]), directory: async () => [session] });
    expect(await run()).toBe(false);
    expect(a.calls).toBe(0);
    // (ADR-091 follow-up) nor one from another computer of yours stored as owner (a daemon of the release before)…
    mailbox.send({ from: { agent: 'claude', sessionId: 'x', device: 'me/air' }, to: { agent: 'claude', sessionId: LIVE }, text: 'from my laptop', fromTier: 'owner' });
    expect(await run()).toBe(false);
    // …while mail between sessions of THIS computer still is delivered
    mailbox.send({ from: { agent: 'claude', sessionId: 'x' }, to: { agent: 'claude', sessionId: LIVE }, text: 'from a session here' });
    expect(await run()).toBe(true);
    expect(a.calls).toBe(1);
  });

  it('the prompt hook shows a count line for other people, never their text, and leaves them unprocessed', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mini' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'SECRET-ASK one', fromTier: 'peer' });
    mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'carol' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'SECRET-ASK two', fromTier: 'peer' });
    const out = processPromptHook(mailbox, { session_id: LIVE }, { home }).hookSpecificOutput!.additionalContext;
    expect(out).toBe('[morse] 2 new messages from bob/mini, carol — morse read');
    expect(out).not.toContain('SECRET-ASK');
    expect(mailbox.inbox().map((m) => m.status)).toEqual(['pending', 'pending']);
  });
});

describe('inbox --take (ADR-048)', () => {
  it('needs a scope, and only marks messages received here — an outbound message waiting for retry keeps waiting', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const out = mailbox.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'mini', sessionId: 'inbox', device: 'bob/mini' }, text: 'to bob' });
    mailbox.claimNextPending();
    mailbox.markFailed(out.id, 'offline', { waiting: true });
    const got = mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mini' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'hi', fromTier: 'peer' });
    expect(() => mailbox.inbox({ take: true })).toThrow(/scope/);
    // even a scope that matches the outbound row by session id leaves it alone
    const taken = mailbox.inbox({ toSession: 'inbox', take: true });
    expect(taken.map((m) => m.id)).toEqual([got.id]);
    expect(mailbox.getMessage(out.id)).toMatchObject({ status: 'failed', waiting: true });
    expect(mailbox.getMessage(got.id)?.status).toBe('delivered');
  });

  it('the CLI refuses an unscoped --take and says what to use', async () => {
    const r = await new Promise<{ code: number | null; out: string }>((done) => {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'inbox', '--take'], { cwd: repo, env: { ...process.env, MORSE_HOME: home } });
      let out = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (out += String(d)));
      p.on('close', (code) => done({ code, out }));
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--take needs a scope/);
  });
});
