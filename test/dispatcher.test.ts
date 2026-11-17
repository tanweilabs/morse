import { describe, expect, it } from 'vitest';
import type { DeliveryAdapter, DeliveryResult, SessionInfo } from '../src/adapters/types.js';
import { dispatchOnce as coreStep, startDispatcher as startCore, type DispatchEvent, type DispatcherOptions } from '../src/daemon/dispatcher.js';
import { REPLY_MARKER } from '../src/envelope.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { dispatchOnce as pipelineStep, startDispatcher as startPipeline } from './helpers/dispatch.js';

// Two layers are exercised here:
//  - the core step on its own (src/daemon/dispatcher.ts): outbound routing, relay outcomes, the human's inbox;
//  - the full pipeline (core + dispatch plugin, test/helpers/dispatch.ts): own-agent delivery through adapters.

const ALICE = { agent: 'claude', sessionId: '11111111-aaaa-4000-8000-00000000000a' };
const BOB = { agent: 'codex', sessionId: '22222222-bbbb-4000-8000-00000000000b' };
const CAROL = { agent: 'kimi', sessionId: '33333333-cccc-4000-8000-00000000000c' };
const HUMAN = { agent: 'user', sessionId: 'cli' };

const SESSIONS: SessionInfo[] = [
  { agent: ALICE.agent, sessionId: ALICE.sessionId, title: 'api work', cwd: '/src/api', lastActiveAt: 10 },
  { agent: BOB.agent, sessionId: BOB.sessionId, title: 'ui work', cwd: '/src/ui', lastActiveAt: 20 },
  { agent: CAROL.agent, sessionId: CAROL.sessionId, title: 'docs', cwd: '/src/docs', lastActiveAt: 30 },
];

const freshMailbox = (clock?: () => number): Mailbox => createMailbox(createDb(':memory:'), clock ? { now: clock } : {});

interface Recorder extends DeliveryAdapter {
  envelopes: string[];
  sessions: string[];
}

/** An adapter that records what it was asked to deliver and answers with `answer`. */
function recorder(agent: string, answer: DeliveryResult | (() => DeliveryResult)): Recorder {
  const envelopes: string[] = [];
  const sessions: string[] = [];
  return {
    agent,
    envelopes,
    sessions,
    listSessions: async () => [],
    deliver: async (session, envelope) => {
      sessions.push(session.sessionId);
      envelopes.push(envelope);
      return typeof answer === 'function' ? answer() : answer;
    },
  };
}

/** Run one pipeline step with the given adapters and collect the events it emits. */
async function pipeline(mailbox: Mailbox, adapters: DeliveryAdapter[], extra: Partial<DispatcherOptions> = {}) {
  const events: DispatchEvent[] = [];
  const did = await pipelineStep({
    mailbox,
    adapters: new Map(adapters.map((a) => [a.agent, a])),
    directory: async () => SESSIONS,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { did, kinds: events.map((e) => e.kind), events };
}

/** Run one core step and collect its events. */
async function core(mailbox: Mailbox, extra: Partial<DispatcherOptions> = {}) {
  const events: DispatchEvent[] = [];
  const did = await coreStep({ mailbox, onEvent: (e) => events.push(e), ...extra });
  return { did, events: events.map((e) => ({ kind: e.kind, detail: e.detail })) };
}

describe('core step: what it claims', () => {
  it('has nothing to do on an empty mailbox', async () => {
    expect((await core(freshMailbox())).did).toBe(false);
  });

  it('leaves own-session mail on this device for the dispatch plugin', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: BOB, text: 'local job' });
    expect((await core(mb, { selfDevice: 'laptop' })).did).toBe(false);
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('files a reply to the human on this device straight into the inbox', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: BOB, to: HUMAN, text: 'done, have a look' });
    expect(await core(mb)).toEqual({ did: true, events: [{ kind: 'delivered', detail: 'user-inbox' }] });
    expect(mb.getMessage(m.id)?.status).toBe('delivered');
  });

  it('treats a target device equal to this one (any case) as local', async () => {
    const mb = freshMailbox();
    let relayCalls = 0;
    mb.send({ from: CAROL, to: { ...HUMAN, device: 'Laptop' }, text: 'here' });
    const out = await core(mb, {
      selfDevice: 'laptop',
      relay: async () => {
        relayCalls++;
        return { ok: true };
      },
    });
    expect(out.events).toEqual([{ kind: 'delivered', detail: 'user-inbox' }]);
    expect(relayCalls).toBe(0);
  });

  it('skips pull-only sessions in the claim so they cannot starve outbound mail (ADR-044)', async () => {
    let t = 1_800_000_000_000;
    const mb = freshMailbox(() => t++);
    for (let i = 0; i < 30; i++) mb.send({ from: ALICE, to: { agent: 'inbox', sessionId: 'inbox' }, text: `queued ${i}` });
    const outbound = mb.send({ from: ALICE, to: { ...HUMAN, device: 'desk' }, text: 'over there' });
    const sent: string[] = [];
    const out = await core(mb, {
      selfDevice: 'laptop',
      pullOnlySessions: ['inbox'],
      relay: async (_d, msg) => {
        sent.push(msg.id);
        return { ok: true };
      },
    });
    expect(out.did).toBe(true);
    expect(sent).toEqual([outbound.id]);
  });
});

describe('core step: relaying to another device', () => {
  const toDesk = (mb: Mailbox, to: { agent: string; sessionId: string } = BOB) =>
    mb.send({ from: ALICE, to: { ...to, device: 'desk' }, text: 'remote task' });

  it('hands the message to the transport and marks it delivered', async () => {
    const mb = freshMailbox();
    const m = toDesk(mb);
    const seen: Array<[string, string]> = [];
    const out = await core(mb, {
      selfDevice: 'laptop',
      relay: async (device, msg) => {
        seen.push([device, msg.id]);
        return { ok: true };
      },
    });
    expect(seen).toEqual([['desk', m.id]]);
    expect(out.events).toEqual([{ kind: 'delivered', detail: 'relayed-to:desk' }]);
    expect(mb.getMessage(m.id)?.status).toBe('delivered');
  });

  it('names the path taken and a pending message request (ADR-037)', async () => {
    const mb = freshMailbox();
    toDesk(mb, HUMAN);
    const out = await core(mb, { selfDevice: 'laptop', relay: async () => ({ ok: true, via: 'lan', request: true }) });
    expect(out.events).toEqual([
      { kind: 'delivered', detail: 'relayed-to:desk via lan — request pending (in their message requests until they accept you)' },
    ]);
  });

  it('fails when no transport is configured', async () => {
    const mb = freshMailbox();
    const m = toDesk(mb);
    const out = await core(mb, { selfDevice: 'laptop' });
    expect(out.events).toEqual([{ kind: 'failed', detail: 'target device "desk" requires LAN relay (not configured)' }]);
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'failed', lastError: 'target device "desk" requires LAN relay (not configured)' });
  });

  it('fails with the thrown message when the transport throws', async () => {
    const mb = freshMailbox();
    const m = toDesk(mb);
    await core(mb, {
      selfDevice: 'laptop',
      relay: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'failed', lastError: 'socket hang up' });
  });

  it('fails with the transport error, or a default one', async () => {
    const mb = freshMailbox();
    const a = toDesk(mb);
    await core(mb, { selfDevice: 'laptop', relay: async () => ({ ok: false, error: 'tls handshake failed' }) });
    expect(mb.getMessage(a.id)?.lastError).toBe('tls handshake failed');

    const mb2 = freshMailbox();
    const b = toDesk(mb2);
    await core(mb2, { selfDevice: 'laptop', relay: async () => ({ ok: false }) });
    expect(mb2.getMessage(b.id)).toMatchObject({ status: 'failed', lastError: 'relay to desk failed' });
  });

  it('keeps the message queued while the other side is unreachable', async () => {
    const mb = freshMailbox();
    const m = toDesk(mb);
    const out = await core(mb, { selfDevice: 'laptop', relay: async () => ({ ok: false, waiting: true }) });
    expect(out.events).toEqual([{ kind: 'waiting', detail: 'desk is not reachable right now' }]);
    expect(mb.getMessage(m.id)?.status).not.toBe('dead');
  });

  it('gives up for good when the transport says it can never go — even mail to the human (ADR-091)', async () => {
    const line = 'desk: old names no longer work — ask for their 26-character address (morse address shows it)';
    const mb = freshMailbox();
    const m = toDesk(mb, { agent: 'user', sessionId: '' });
    const out = await core(mb, { selfDevice: 'laptop', relay: async () => ({ ok: false, terminal: true, error: line }) });
    expect(out.events).toEqual([{ kind: 'failed', detail: line }]);
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'dead', lastError: line });

    const mb2 = freshMailbox();
    const n = toDesk(mb2);
    await core(mb2, { selfDevice: 'laptop', relay: async () => ({ ok: false, terminal: true }) });
    expect(mb2.getMessage(n.id)).toMatchObject({ status: 'dead', lastError: 'desk cannot be reached' });
  });
});

describe('core step: mail to the human never dead-letters (ADR-020)', () => {
  const cases: Array<[string, Partial<DispatcherOptions>, string]> = [
    ['no transport configured', {}, 'user-inbox:relay-unconfigured'],
    [
      'the transport throws',
      {
        relay: async () => {
          throw new Error('boom');
        },
      },
      'user-inbox:relay-error',
    ],
    ['the transport fails', { relay: async () => ({ ok: false, error: 'peer unreachable' }) }, 'user-inbox:relay-failed'],
  ];

  for (const [when, extra, detail] of cases) {
    it(`falls back to this machine's inbox when ${when}`, async () => {
      const mb = freshMailbox();
      const m = mb.send({ from: BOB, to: { ...HUMAN, device: 'home-mac' }, text: 'need your decision' });
      const out = await core(mb, { selfDevice: 'travel-mac', ...extra });
      expect(out).toEqual({ did: true, events: [{ kind: 'delivered', detail }] });
      expect(mb.getMessage(m.id)?.status).toBe('delivered');
    });
  }

  it('still prefers relaying home when the transport works', async () => {
    const mb = freshMailbox();
    mb.send({ from: BOB, to: { ...HUMAN, device: 'home-mac' }, text: 'fyi' });
    const out = await core(mb, { selfDevice: 'travel-mac', relay: async () => ({ ok: true }) });
    expect(out.events).toEqual([{ kind: 'delivered', detail: 'relayed-to:home-mac' }]);
  });

  it('a non-human target on another device is not given that fallback', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: { ...BOB, device: 'home-mac' }, text: 'job' });
    await core(mb, { selfDevice: 'travel-mac', relay: async () => ({ ok: false, error: 'down' }) });
    expect(mb.getMessage(m.id)?.status).toBe('failed');
  });
});

describe('startDispatcher (core loop)', () => {
  it('drains everything due, keeps polling, and stops', async () => {
    const mb = freshMailbox();
    for (const text of ['a', 'b', 'c']) mb.send({ from: ALICE, to: HUMAN, text });
    const loop = startCore({ mailbox: mb }, { intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    mb.send({ from: ALICE, to: HUMAN, text: 'late' });
    await new Promise((r) => setTimeout(r, 60));
    loop.stop();
    expect(mb.inbox({ all: true }).every((m) => m.status === 'delivered')).toBe(true);
    expect(mb.inbox({ all: true })).toHaveLength(4);
  });

  it('survives a step that throws', async () => {
    const mb = freshMailbox();
    const first = mb.send({ from: ALICE, to: HUMAN, text: 'first' });
    const second = mb.send({ from: ALICE, to: HUMAN, text: 'second' });
    let calls = 0;
    const loop = startCore(
      {
        mailbox: mb,
        onEvent: () => {
          calls++;
          if (calls === 1) throw new Error('listener bug');
        },
      },
      { intervalMs: 5 },
    );
    await new Promise((r) => setTimeout(r, 60));
    loop.stop();
    expect(calls).toBe(2);
    expect([mb.getMessage(first.id)?.status, mb.getMessage(second.id)?.status]).toEqual(['delivered', 'delivered']);
  });
});

describe('pipeline: delivering to a local agent session', () => {
  it('delivers an envelope that carries the text and the sender by title', async () => {
    const mb = freshMailbox();
    const bob = recorder('codex', { ok: true, output: 'ok' });
    const m = mb.send({ from: ALICE, to: BOB, text: 'please review the diff' });
    expect((await pipeline(mb, [bob])).did).toBe(true);
    expect(bob.sessions).toEqual([BOB.sessionId]);
    expect(bob.envelopes[0]).toContain('please review the diff');
    expect(bob.envelopes[0]).toContain('@claude:api work');
    expect(mb.getMessage(m.id)?.status).toBe('delivered');
  });

  it('turns the text after the reply marker into a reply in the same context', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: BOB, text: 'build it' });
    await pipeline(mb, [recorder('codex', { ok: true, output: `log line\n${REPLY_MARKER} build green` })]);
    const replies = mb.inbox({ toSession: ALICE.sessionId });
    expect(replies.map((r) => [r.parts[0]?.text, r.contextId])).toEqual([['build green', m.contextId]]);
  });

  it('files nothing back when the output has no marker', async () => {
    const mb = freshMailbox();
    mb.send({ from: ALICE, to: BOB, text: 'quiet job' });
    await pipeline(mb, [recorder('codex', { ok: true, output: 'nothing to say' })]);
    expect(mb.inbox({ toSession: ALICE.sessionId })).toEqual([]);
  });

  it('records an in-session delivery (2026-10-20)', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: BOB, text: 'into the desktop app' });
    await pipeline(mb, [recorder('codex', { ok: true, output: '', inSession: true })]);
    expect(mb.getMessage(m.id)?.deliveredInSession).toBe(true);
  });

  it('asks for a command reply when the adapter queues instead of resuming (ADR-027)', async () => {
    const mb = freshMailbox();
    const bob = { ...recorder('codex', { ok: true, output: '' }), replyChannel: () => 'command' as const };
    const m = mb.send({ from: ALICE, to: BOB, text: 'hello' });
    await pipeline(mb, [bob]);
    expect(bob.envelopes[0]).toContain(`anyd reply ${m.id}`);
    expect(mb.getMessage(m.id)?.status).toBe('delivered');
  });
});

describe('pipeline: delivery failures', () => {
  it('records the adapter error', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: BOB, text: 'x' });
    await pipeline(mb, [recorder('codex', { ok: false, error: 'resume crashed' })]);
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'failed', lastError: 'resume crashed' });
  });

  it('sends a non-retryable failure straight to dead', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: BOB, text: 'long job' });
    await pipeline(mb, [recorder('codex', { ok: false, error: 'timed out after 300s', retry: false })]);
    expect(mb.getMessage(m.id)?.status).toBe('dead');
  });

  it('records an adapter that throws', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: BOB, text: 'x' });
    const thrower = recorder('codex', () => {
      throw new Error('spawn codex ENOENT');
    });
    await pipeline(mb, [thrower]);
    expect(mb.getMessage(m.id)?.lastError).toMatch(/ENOENT/);
  });

  it('records a session directory that throws', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: BOB, text: 'x' });
    await pipeline(mb, [], {
      directory: async () => {
        throw new Error('index unreadable');
      },
    });
    expect(mb.getMessage(m.id)?.lastError).toMatch(/index unreadable/);
  });

  it('fails when there is no adapter for the target agent', async () => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: CAROL, text: 'x' });
    await pipeline(mb, [recorder('codex', { ok: true, output: '' })]);
    expect(mb.getMessage(m.id)?.status).toBe('failed');
    expect(mb.getMessage(m.id)?.lastError).toMatch(/no adapter/i);
  });

  it("moves mail for a vanished session into that agent's inbox instead of dead letters (ADR-048)", async () => {
    const mb = freshMailbox();
    const bob = recorder('codex', { ok: true, output: '' });
    const m = mb.send({ from: ALICE, to: { agent: 'codex', sessionId: '99999999-dead-4000-8000-000000000000' }, text: 'x' });
    await pipeline(mb, [bob]);
    const after = mb.getMessage(m.id)!;
    expect(after).toMatchObject({ status: 'pending', to: { agent: 'codex', sessionId: 'inbox' } });
    expect(after.lastError).toMatch(/not found/i);
    expect(bob.envelopes).toEqual([]);
    expect(mb.claimNextPending({ pullOnlySessions: ['inbox'] })).toBeNull();
  });

  it('does not run a local adapter for mail bound to another device', async () => {
    const mb = freshMailbox();
    const bob = recorder('codex', { ok: true, output: '' });
    const m = mb.send({ from: ALICE, to: { ...BOB, device: 'desk' }, text: 'x' });
    await pipeline(mb, [bob], { selfDevice: 'laptop', relay: async () => ({ ok: true }) });
    expect(bob.envelopes).toEqual([]);
    expect(mb.getMessage(m.id)?.status).toBe('delivered');

    const mb2 = freshMailbox();
    const n = mb2.send({ from: ALICE, to: { ...BOB, device: 'desk' }, text: 'x' });
    await pipeline(mb2, [bob]);
    expect(mb2.getMessage(n.id)?.lastError).toMatch(/relay/i);
  });
});

describe('pipeline: no ping-pong between agents', () => {
  const answer = async (incoming: string, output: string) => {
    const mb = freshMailbox();
    const m = mb.send({ from: ALICE, to: BOB, text: incoming });
    const out = await pipeline(mb, [recorder('codex', { ok: true, output })]);
    return { ...out, total: mb.inbox({ all: true }).length, status: mb.getMessage(m.id)?.status };
  };

  it('drops a BLOCKED answer to a BLOCKED message', async () => {
    const out = await answer('BLOCKED until the user approves', `${REPLY_MARKER} BLOCKED me too`);
    expect(out.status).toBe('delivered');
    expect(out.kinds).toEqual(['delivered', 'reply-rejected']);
    expect(out.events.map((e) => e.detail ?? '').join(' ')).toContain('pingpong');
    expect(out.total).toBe(1);
  });

  it('drops a NOOP answer, also with prose after it', async () => {
    for (const tail of ['', '\n\n---\n\nstanding by for the next task.']) {
      const out = await answer('DONE shipped', `${REPLY_MARKER} NOOP${tail}`);
      expect(out.kinds).toEqual(['delivered', 'reply-rejected']);
      expect(out.total).toBe(1);
    }
  });

  it('keeps an answer that merely starts with the letters NOOP', async () => {
    const out = await answer('how is it going?', `${REPLY_MARKER} NOOPLE is not a verdict`);
    expect(out.kinds).toEqual(['delivered', 'reply-filed']);
    expect(out.total).toBe(2);
  });

  it('keeps a real answer to a BLOCKED message', async () => {
    const out = await answer('BLOCKED waiting on credentials', `${REPLY_MARKER} use the staging fixture instead`);
    expect(out.kinds).toEqual(['delivered', 'reply-filed']);
    expect(out.total).toBe(2);
  });
});

describe('pipeline: sessions that fetch their own mail stay pending', () => {
  const skipped: Array<[string, Partial<DispatcherOptions>, { agent: string; sessionId: string }]> = [
    ['is monitoring with --wait', { isMonitored: (sid) => sid === BOB.sessionId }, BOB],
    ['is open interactively (ADR-023)', { isSessionLive: (sid) => sid === BOB.sessionId }, BOB],
    ['is a registered external session (ADR-024)', { isPullOnly: (sid) => sid === 'ext-app-1' }, { agent: 'sds', sessionId: 'ext-app-1' }],
  ];

  for (const [why, extra, target] of skipped) {
    it(`no resume when the session ${why}`, async () => {
      const mb = freshMailbox();
      const bob = recorder('codex', { ok: true, output: '' });
      const m = mb.send({ from: ALICE, to: target, text: 'hello' });
      const out = await pipeline(mb, [bob], extra);
      expect(out.did).toBe(false);
      expect(bob.envelopes).toEqual([]);
      expect(mb.getMessage(m.id)).toMatchObject({ status: 'pending', attempts: 0 });
    });
  }

  it('a session that is not monitoring still gets resumed', async () => {
    const mb = freshMailbox();
    const bob = recorder('codex', { ok: true, output: '' });
    const m = mb.send({ from: ALICE, to: BOB, text: 'hello' });
    await pipeline(mb, [bob], { isMonitored: () => false });
    expect(bob.envelopes).toHaveLength(1);
    expect(mb.getMessage(m.id)?.status).toBe('delivered');
  });

  it('60 older messages for a live session do not hold up outbound mail (ADR-044)', async () => {
    let t = 1_800_000_000_000;
    const mb = freshMailbox(() => t++);
    const live = '44444444-dddd-4000-8000-00000000000d';
    for (let i = 0; i < 60; i++) mb.send({ from: ALICE, to: { agent: 'claude', sessionId: live }, text: `n${i}` });
    const outbound = mb.send({ from: ALICE, to: { ...HUMAN, device: 'friend' }, text: 'hi' });
    const relayed: string[] = [];
    const opts: Partial<DispatcherOptions> = {
      selfDevice: 'laptop',
      pullOnlySessions: ['inbox'],
      isPullOnly: (sid) => sid === 'inbox',
      isSessionLive: (sid) => sid === live,
      relay: async (_d, msg) => {
        relayed.push(msg.id);
        return { ok: true };
      },
    };
    expect((await pipeline(mb, [], opts)).did).toBe(true);
    expect(relayed).toEqual([outbound.id]);
    expect(mb.inbox({ all: true }).filter((m) => m.status === 'pending')).toHaveLength(60);
    expect((await pipeline(mb, [], opts)).did).toBe(false);
  });

  it('the pipeline loop drains its queue and stops', async () => {
    const mb = freshMailbox();
    const bob = recorder('codex', { ok: true, output: 'no marker here' });
    mb.send({ from: ALICE, to: BOB, text: 'one' });
    const loop = startPipeline({ mailbox: mb, adapters: new Map([['codex', bob]]), directory: async () => SESSIONS }, { intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 120));
    loop.stop();
    expect(bob.envelopes.length).toBeGreaterThanOrEqual(1);
    expect(mb.inbox({ toSession: ALICE.sessionId })).toEqual([]);
  });
});
