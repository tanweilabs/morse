import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DeliveryAdapter, DeliveryResult, LaunchOptions, SessionInfo } from '../src/adapters/types.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { REPLY_MARKER } from '../src/envelope.js';
import { createLocalClient } from '../src/plugin/local-client.js';
import { matchLaunch, parseLaunchConfig } from '../src/plugins/dispatch/launch.js';
import { createSelfInboxRunner, parseSelfInbox, selfInboxName } from '../src/plugins/dispatch/self-inbox.js';
import { createDispatchState } from '../src/plugins/dispatch/state.js';

/**
 * ADR-061: your own mail to an agent's inbox (no session named) gets a session — one
 * dedicated session per (my agent, sending agent), continued across messages, answered with
 * `morse reply`; never another person's mail.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'morse-self-inbox-'));
  dirs.push(d);
  return d;
};

let clock = Date.now();
const now = () => clock;
let n = 0;
const newSessionId = () => `aaaa0000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

interface Turn {
  session: SessionInfo;
  envelope: string;
  launch: LaunchOptions | undefined;
}
function fakeClaude(answer: (envelope: string, t: Turn) => DeliveryResult = (e) => ({ ok: true, output: `got: ${e.split('\n').pop()}` })) {
  const turns: Turn[] = [];
  const adapter: DeliveryAdapter = {
    agent: 'claude',
    listSessions: async () => [],
    deliver: async (session, envelope, launch) => {
      const t = { session: { ...session }, envelope, launch };
      turns.push(t);
      return answer(envelope, t);
    },
  };
  return { adapter, turns };
}

function setup(o: { selfInbox?: unknown; launch?: unknown; answer?: Parameters<typeof fakeClaude>[0] } = {}) {
  const home = tmp();
  const mailbox = createMailbox(createDb(':memory:'), { now });
  const state = createDispatchState(join(home, 'state'));
  const claude = fakeClaude(o.answer);
  const logs: string[] = [];
  const cfg = parseSelfInbox(o.selfInbox, home);
  const { profiles } = parseLaunchConfig(o.launch);
  const runner = createSelfInboxRunner({ core: createLocalClient(mailbox), adapters: new Map([['claude', claude.adapter]]), state, launchProfiles: () => profiles, config: () => cfg, newSessionId, log: (l) => logs.push(l), now });
  return { home, mailbox, state, claude, logs, runner, cfg };
}

/** You, through another agent address of yours (`me/<agent>`), to your agent `mini`'s inbox. */
const fromMe = (mb: Mailbox, text: string, peer = 'air', agent = 'user', sessionId = 'cli') =>
  mb.send({ from: { agent, sessionId, device: `me/${peer}` }, to: { agent: 'mini', sessionId: 'inbox' }, text, fromTier: 'owner' });
const outTo = (mb: Mailbox, peer: string) =>
  mb
    .inbox({ all: true })
    .filter((m) => m.direction === 'out' && m.to.device === `me/${peer}`)
    .map((m) => m.parts[0]!.text);

describe('own inbox mail gets a session (ADR-061)', () => {
  it('(ADR-091 follow-up) mail from another computer of yours — even stored as owner by a daemon of the release before — is a contact\'s: the runner starts nothing for it', async () => {
    const t = setup({ selfInbox: { cwd: '/w/me' } });
    const m = fromMe(t.mailbox, 'what is on my calendar?');
    await t.runner.idle();
    expect(t.claude.turns).toHaveLength(0);
    expect(t.mailbox.getMessage(m.id)?.processedAt).toBeUndefined();
  });
  // (ADR-091 follow-up) removed: "routing: your inbox mail runs…" — mail from your other computers is never yours now (it never reaches this runner).

  // (ADR-091 follow-up) removed: "continuity: the next message…" — mail from your other computers is never yours now (it never reaches this runner).

  // (ADR-091 follow-up) removed: "an agent session behind your other agent address…" — mail from your other computers is never yours now (it never reaches this runner).

  it('enabled: false turns it off — your inbox mail waits as before', async () => {
    const t = setup({ selfInbox: { enabled: false } });
    const m = fromMe(t.mailbox, 'hello');
    await t.runner.idle();
    expect(t.claude.turns).toHaveLength(0);
    expect(t.mailbox.getMessage(m.id)?.processedAt).toBeUndefined();
  });

  // (ADR-091 follow-up) removed: "an explicit "to": "inbox" launch profile…" — mail from your other computers is never yours now (it never reaches this runner).

  // (ADR-091 follow-up) removed: "a lost session is started afresh…" — mail from your other computers is never yours now (it never reaches this runner).

  // (ADR-091 follow-up) removed: "a failed turn is retried after 30 s…" — mail from your other computers is never yours now (it never reaches this runner).

  // (ADR-091 follow-up) removed: "backlog: mail from before the loop…" — mail from your other computers is never yours now (it never reaches this runner).

  it('config: bypass modes switch it off with a reason; "to" is only "inbox" and never names a session; session delivery ignores those profiles', () => {
    expect(parseSelfInbox({ permissionMode: 'bypassPermissions' })).toMatchObject({ enabled: false, errors: [expect.stringMatching(/bypass-style/)] });
    expect(parseSelfInbox({ cwd: 'relative' }).errors[0]).toMatch(/absolute/);
    expect(parseLaunchConfig([{ agent: 'claude', to: 'outbox' }]).errors[0]).toMatch(/"to" is "inbox"/);
    expect(parseLaunchConfig([{ agent: 'claude', to: 'inbox', dedicated: true, name: 'x', cwd: '/w' }]).errors[0]).toMatch(/one session per sending agent/);
    const { profiles, errors } = parseLaunchConfig([{ agent: 'claude', to: 'inbox', prompt: 'plain' }]);
    expect(errors).toEqual([]);
    expect(matchLaunch(profiles, { agent: 'claude', sessionId: 's', title: 't', cwd: '/w', lastActiveAt: 0 }, 'user')).toBeNull();
    expect(selfInboxName({ agent: 'mini', to: { agent: 'mini', sessionId: 'inbox' }, peerAgent: 'Air Book', from: { agent: 'user', sessionId: 'cli' } })).toBe('self-mini-air-book');
  });
});
