import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { withRemark } from '../src/cluster/remarks.js';
import { formatRequests } from '../src/cluster/requests.js';
import { processPromptHook } from '../src/hooks/prompt-hook.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import type { MessageRequest } from '../src/mailbox/requests.js';
import { peerTag } from '../src/peer-framing.js';

/**
 * ADR-065: identity is the address only; a sender is shown by YOUR remark for it,
 * otherwise by its address. A self-chosen nickname is never shown — not even one an
 * older install cached in ~/.morse/nicknames.json, and not in message requests.
 */

const home = mkdtempSync(join(tmpdir(), 'morse-remarks-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
// what an older client left behind: a cached self-chosen nickname for bob
mkdirSync(join(home, '.morse'), { recursive: true });
writeFileSync(join(home, '.morse', 'nicknames.json'), JSON.stringify({ bob: 'The Real Alice' }));

const LIVE = 'live-0000-4000-8000-000000000000';

describe('display precedence: your remark > the address (ADR-065)', () => {
  it('withRemark puts your remark in front of the address, or leaves the address alone', () => {
    const remarks: Record<string, string> = { k7f3a9xq: 'Bob' };
    const of = (h: string) => remarks[h];
    expect(withRemark('k7f3a9xq/mini', of)).toBe('Bob (k7f3a9xq/mini)');
    expect(withRemark('@K7F3A9XQ/mini/claude', of)).toBe('Bob (@K7F3A9XQ/mini/claude)');
    expect(withRemark('zed/air', of)).toBe('zed/air');
    expect(withRemark('k7f3a9xq/mini')).toBe('k7f3a9xq/mini'); // no lookup: just the address
  });

  it('the peer label injected into a session uses your remark, else the address — never a nickname', () => {
    const m = { from: { agent: 'claude', sessionId: '', device: 'bob/mini' } };
    expect(peerTag(m)).toContain('来自 bob/mini 的 Agent');
    expect(peerTag(m, (h) => (h === 'bob' ? 'Bob B' : null))).toContain('来自 Bob B (bob/mini) 的 Agent');
    expect(peerTag(m)).not.toContain('The Real Alice');
  });

  it('the new-message line in a session: address without a remark, your remark once you set one', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mini' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'hi', fromTier: 'peer' });
    const line = (sid = LIVE) => processPromptHook(mailbox, { session_id: sid }, { home }).hookSpecificOutput!.additionalContext;
    expect(line()).toBe('[morse] 1 new message from bob/mini — morse read');
    const bob = mailbox.contacts.byHandle('bob')!;
    mailbox.contacts.set(bob.id, { remark: 'Bob from work' });
    mailbox.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mini' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'again', fromTier: 'peer' });
    const out = line('other-session-0000-4000-8000-000000000000'); // a fresh cursor sees both
    expect(out).toContain('Bob from work (bob/mini)');
    expect(out).not.toContain('The Real Alice');
  });

  it('a message request shows only the address, even when an old client sent a nickname', () => {
    const req: MessageRequest = {
      handle: 'zed',
      deviceId: 'ABCDEFG-1234567',
      deviceName: 'air',
      nickname: 'Your Bank',
      msgId: 'm1',
      contextId: 'c1',
      fromAgent: 'air',
      fromSession: '',
      fromMorseAgent: 'air',
      toAgent: 'mini',
      toSession: 'inbox',
      text: 'hello',
      count: 1,
      firstAt: Date.now(),
      lastAt: Date.now(),
      via: 'morse-relay',
    } as unknown as MessageRequest;
    const lines = formatRequests([req]).join('\n');
    expect(lines).toContain('morse.im/zed/air');
    expect(lines).not.toContain('Your Bank');
  });
});
