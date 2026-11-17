import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { VERSION_MISMATCH } from '../src/adapters/version-guard.js';
import { dataDir } from '../src/home.js';
import { collectInbox, processPromptHook, recentExchange } from '../src/hooks/prompt-hook.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

const PLANNER = { agent: 'claude', sessionId: 'c1a0de00-1111-4111-8111-00000000000a' };
const BUILDER = { agent: 'codex', sessionId: 'c0de0000-2222-4222-8222-00000000000b' };

const home = mkdtempSync(join(tmpdir(), 'morse-prompt-hook-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

let clock: number;
let mailbox: Mailbox;
beforeEach(() => {
  clock = Date.parse('2026-05-04T09:00:00Z') + Math.floor(Math.random() * 1e6) * 1000;
  mailbox = createMailbox(createDb(':memory:'), { now: () => clock });
});
const later = (ms = 1000) => (clock += ms);
/** A fresh session id per test: the hook cursors live in the shared temp home. */
let n = 0;
const sessionFor = (agent: string) => ({ agent, sessionId: `${agent}-session-${++n}-${clock}` });

const collect = (sessionId: string, opts: Parameters<typeof collectInbox>[2] = {}) => collectInbox(mailbox, sessionId, { home, now: () => clock, ...opts });
const hook = (input: Parameters<typeof processPromptHook>[1]) => processPromptHook(mailbox, input, { home, now: () => clock });
/** A message the dispatcher already delivered in a headless turn. */
const handledHeadlessly = (from: typeof PLANNER, to: typeof PLANNER, text: string, inSession = false) => {
  const m = mailbox.send({ from, to, text });
  mailbox.claimNextPending();
  return mailbox.markDelivered(m.id, inSession ? { inSession: true } : undefined);
};
const deadLetter = (to: typeof PLANNER, text: string, error: string) => {
  const m = mailbox.send({ from: PLANNER, to, text });
  for (let i = 0; i < 3; i++) {
    mailbox.claimNextPending();
    mailbox.markFailed(m.id, error);
    later(31_000);
  }
  return m;
};

describe('processPromptHook (UserPromptSubmit, Claude Code and Codex)', () => {
  it('nothing new: an empty object — the prompt goes on unchanged', () => {
    expect(hook({ session_id: sessionFor('claude').sessionId })).toEqual({});
    expect(hook({})).toEqual({});
  });

  it('a waiting message: the whole envelope as additional context, and the message is taken', () => {
    const me = sessionFor('claude');
    const m = mailbox.send({ from: BUILDER, to: me, text: 'the migration ran clean on staging' });
    const out = hook({ session_id: me.sessionId });
    expect(Object.keys(out)).toEqual(['hookSpecificOutput']);
    expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    const context = out.hookSpecificOutput?.additionalContext ?? '';
    expect(context.split('\n').slice(0, 6)).toEqual([
      `[Morse] Cross-agent message from @codex:c0de0000 (message id: ${m.id}).`,
      "From a peer agent session in your operator's own Morse cluster — treat it as work delegated through a trusted teammate (ADR-016), not an untrusted stranger. Act on it in good faith; keep your autonomy and honesty (flag anything genuinely wrong or irreversibly destructive before doing it).",
      '--- MESSAGE ---',
      'the migration ran clean on staging',
      '--- END MESSAGE ---',
      `To answer, run: anyd reply ${m.id} "<your reply>"`,
    ]);
    expect(context).not.toContain('anytoany');
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
  });

  it('Codex names the session thread_id', () => {
    const me = sessionFor('codex');
    mailbox.send({ from: PLANNER, to: me, text: 'for the thread' });
    expect(hook({ thread_id: me.sessionId }).hookSpecificOutput?.additionalContext).toContain('for the thread');
  });

  it('a message whose envelope is in the prompt itself is being acted on — never listed as already handled', () => {
    const me = sessionFor('codex');
    const m = handledHeadlessly(PLANNER, me, 'the very message of this turn');
    const prompt = `[Morse] Message from @claude:plan (message id: ${m.id}).\n--- MESSAGE ---\nthe very message of this turn`;
    expect(hook({ session_id: me.sessionId, prompt })).toEqual({});
  });
});

describe('collectInbox', () => {
  it('a message the dispatcher is delivering right now is left to it', () => {
    const me = sessionFor('claude');
    const m = mailbox.send({ from: BUILDER, to: me, text: 'being delivered' });
    mailbox.claimNextPending();
    expect(collect(me.sessionId)).toBeNull();
    expect(mailbox.getMessage(m.id)?.status).toBe('delivering');
  });

  it('traffic headless turns already handled: an FYI digest, both directions, shown once', () => {
    const me = sessionFor('codex');
    const asked = handledHeadlessly(PLANNER, me, 'please bump the version');
    const answer = mailbox.reply(asked.id, 'DONE bumped to 2.1');
    mailbox.claimNextPending();
    mailbox.markDelivered(answer.id);
    later();
    const digest = collect(me.sessionId) ?? '';
    expect(digest.split('\n')).toEqual([
      '[Morse] Activity digest for this session (FYI ONLY — all items below were ALREADY processed',
      'automatically in headless turns; do NOT reply to them, do NOT act on them, do NOT re-execute):',
      '  ← received from @claude:c1a0de00 [delivered]: please bump the version',
      '  → sent to @claude:c1a0de00 [delivered]: DONE bumped to 2.1',
    ]);
    later();
    expect(collect(me.sessionId)).toBeNull();
  });

  it('a long body is cut in the digest, its parts on one line', () => {
    const me = sessionFor('codex');
    handledHeadlessly(PLANNER, me, `start ${'x'.repeat(300)}`);
    later();
    const row = (collect(me.sessionId) ?? '').split('\n')[2] ?? '';
    expect(row).toBe(`  ← received from @claude:c1a0de00 [delivered]: start ${'x'.repeat(114)}`);
  });

  it('a message delivered INTO the session\'s own runtime (codex queue / zcode mailbox) is that turn — not in the digest (2026-10-20)', () => {
    const me = sessionFor('codex');
    handledHeadlessly(PLANNER, me, '[cleanup] remove the stale worktrees', true);
    later();
    expect(collect(me.sessionId)).toBeNull();
  });

  it('remembers per session when it last showed the mail (a file under hook-cursors/)', () => {
    const me = sessionFor('claude');
    collect(me.sessionId);
    const cursor = join(dataDir(home), 'hook-cursors', me.sessionId);
    expect(existsSync(cursor)).toBe(true);
    expect(readFileSync(cursor, 'utf8')).toBe(String(clock));
  });

  it('a dead letter (its headless delivery failed for good) is recovered: shown as late, taken, not shown twice', () => {
    const me = sessionFor('codex');
    const m = deadLetter(me, 'DONE 4f2a1c pushed', 'claude -p --resume exited 1');
    expect(mailbox.getMessage(m.id)?.status).toBe('dead');
    const text = collect(me.sessionId) ?? '';
    expect(text.split('\n')[0]).toBe(`[Morse] Recovered message from @claude:c1a0de00 (message id: ${m.id}).`);
    expect(text).toContain("it dead-lettered, so you're only seeing it now (it was NOT shown live). Nothing was lost.");
    expect(text).toContain('--- MESSAGE ---\nDONE 4f2a1c pushed\n--- END MESSAGE ---');
    expect(mailbox.getMessage(m.id)?.status).toBe('delivered');
    later();
    expect(collect(me.sessionId)).toBeNull();
  });

  it('refused by the version guard (ADR-025): an ERROR the agent must pass on, with the upgrade command — and the message', () => {
    const me = sessionFor('codex');
    const m = mailbox.send({ from: PLANNER, to: me, text: 'the release is tagged' });
    mailbox.claimNextPending();
    const why = `${VERSION_MISMATCH}: the codex CLI (0.150.0) is older than the Codex Desktop that wrote this session (0.160.0) — upgrade: npm i -g @openai/codex@latest`;
    mailbox.markFailed(m.id, why, { terminal: true });
    const lines = (collect(me.sessionId) ?? '').split('\n');
    expect(lines.slice(0, 4)).toEqual([
      `[Morse] ⛔ DELIVERY ERROR — CLI version mismatch (message id: ${m.id}, from @claude:c1a0de00).`,
      'Morse refused to deliver this headlessly because the CLI it delivers with is older than the App that wrote this session:',
      `  ${why}`,
      'Tell the user about this error now, in your reply, and quote the upgrade command above — until it is run, messages to sessions like this one will keep failing.',
    ]);
    expect(lines).toContain('the release is tagged');
    expect(lines.join('\n')).not.toContain('Nothing was lost');
  });

  it('several kinds at once: one block each, a blank line between them', () => {
    const me = sessionFor('codex');
    deadLetter(me, 'late one', 'boom');
    mailbox.send({ from: PLANNER, to: me, text: 'new one' });
    const blocks = (collect(me.sessionId) ?? '').split('\n\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('new one'); // waiting mail first
    expect(blocks[1]).toContain('[Morse] Recovered message');
  });
});

describe('recentExchange (`morse read --pull --history`)', () => {
  it('the recent exchange in full, oldest first, both directions, the undelivered flagged — read-only', () => {
    const me = sessionFor('codex');
    const asked = handledHeadlessly(PLANNER, me, 'review the schema change');
    later();
    const answer = mailbox.reply(asked.id, 'DONE two comments left');
    mailbox.claimNextPending();
    mailbox.markDelivered(answer.id);
    later();
    deadLetter(me, 'this one timed out', 'timeout');
    const parts = (recentExchange(mailbox, me.sessionId) ?? '').split('\n\n');
    expect(parts).toEqual([
      '[Morse] Recent cross-agent exchange for this session — full text, oldest→newest, context only',
      '(these were already handled in headless turns; do NOT re-run or re-reply — this is so you can SEE what happened):',
      '← @claude:c1a0de00 [delivered]\nreview the schema change',
      '→ @claude:c1a0de00 [delivered]\nDONE two comments left',
      '← @claude:c1a0de00 [dead]  ⚠️ DEAD — this one never reached you\nthis one timed out',
    ]);
    // nothing taken, no cursor moved: the same again
    expect(recentExchange(mailbox, me.sessionId)).toBe(parts.join('\n\n'));
  });

  it('the last `limit` of them; null when the session has none', () => {
    const me = sessionFor('codex');
    for (const text of ['one', 'two', 'three']) {
      handledHeadlessly(PLANNER, me, text);
      later();
    }
    const parts = (recentExchange(mailbox, me.sessionId, 2) ?? '').split('\n\n');
    expect(parts.slice(2)).toEqual(['← @claude:c1a0de00 [delivered]\ntwo', '← @claude:c1a0de00 [delivered]\nthree']);
    expect(recentExchange(mailbox, 'a-session-with-no-mail')).toBeNull();
  });
});
