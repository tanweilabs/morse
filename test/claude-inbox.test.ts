import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDoorbellFrame,
  createClaudeInboxRegistry,
  createDoorbell,
  doorbellUseful,
  ringInbox,
  type DoorbellEvent,
  type InboxEntry,
} from '../src/daemon/claude-inbox.js';
import { crossSessionInboundCheck } from '../src/doctor.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

// ADR-027: a running Claude Code session lists an inbox socket in
// ~/.claude/sessions/<pid>.json; one JSON line there makes it take a turn, whose
// prompt hook then hands it the pending Morse mail.

const S1 = '0b5e55ed-1111-4111-8111-111111111111';
const S2 = '0b5e55ed-2222-4222-8222-222222222222';
const S3 = '0b5e55ed-3333-4333-8333-333333333333';

const fresh = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A session file as Claude Code 2.1.29x writes it (extra fields included). */
const sessionFile = (dir: string, pid: number, fields: Record<string, unknown>) =>
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, cwd: '/w/app', kind: 'interactive', entrypoint: 'cli', peerProtocol: 1, ...fields }),
  );

describe('createClaudeInboxRegistry', () => {
  it('keeps a session only when its pid runs and its socket exists; status and version come along when present', () => {
    const dir = fresh('morse-cc-sessions-');
    const sock = join(dir, 'a.sock');
    writeFileSync(sock, '');
    sessionFile(dir, 11, { sessionId: S1, messagingSocketPath: sock, status: 'busy', version: '2.1.296' });
    sessionFile(dir, 12, { sessionId: S2, messagingSocketPath: sock }); // pid not running
    sessionFile(dir, 13, { sessionId: S3, messagingSocketPath: join(dir, 'missing.sock') }); // socket gone
    const live = createClaudeInboxRegistry({ dir, isAlive: (pid) => pid !== 12 })();
    expect([...live.entries()]).toEqual([[S1, { pid: 11, sessionId: S1, socketPath: sock, status: 'busy', version: '2.1.296' }]]);
  });

  it('skips files that are not <pid>.json, broken JSON, and entries with a bad id, pid or socket field', () => {
    const dir = fresh('morse-cc-junk-');
    const sock = join(dir, 'b.sock');
    writeFileSync(sock, '');
    writeFileSync(join(dir, '20.json'), '{oops');
    writeFileSync(join(dir, '21.abcdef.key'), 'token-we-never-read');
    writeFileSync(join(dir, 'notes.json'), JSON.stringify({ pid: 1, sessionId: S1, messagingSocketPath: sock }));
    sessionFile(dir, 22, { sessionId: 'not-a-uuid', messagingSocketPath: sock });
    sessionFile(dir, 23, { sessionId: S2.toUpperCase(), messagingSocketPath: sock });
    sessionFile(dir, 24, { sessionId: S2, messagingSocketPath: '' });
    sessionFile(dir, 25, { sessionId: S2 });
    writeFileSync(join(dir, '26.json'), JSON.stringify({ pid: '26', sessionId: S3, messagingSocketPath: sock }));
    sessionFile(dir, 27, { sessionId: S3, messagingSocketPath: sock, status: 7 });
    const live = createClaudeInboxRegistry({ dir, isAlive: () => true })();
    expect([...live.keys()]).toEqual([S3]);
    expect(live.get(S3)).toEqual({ pid: 27, sessionId: S3, socketPath: sock }); // non-string status dropped
  });

  it('a missing folder means no live sessions', () => {
    expect(createClaudeInboxRegistry({ dir: join(tmpdir(), 'morse-no-such-sessions-dir') })().size).toBe(0);
  });

  it('the default liveness check is the real process table: our own pid counts, an unused one does not', () => {
    const dir = fresh('morse-cc-pids-');
    const sock = join(dir, 'c.sock');
    writeFileSync(sock, '');
    sessionFile(dir, process.pid, { sessionId: S1, messagingSocketPath: sock });
    sessionFile(dir, 2_147_483_000, { sessionId: S2, messagingSocketPath: sock });
    expect([...createClaudeInboxRegistry({ dir })().keys()]).toEqual([S1]);
  });

  it('reuses one scan for ttlMs, then looks again', () => {
    const dir = fresh('morse-cc-ttl-');
    const sock = join(dir, 'd.sock');
    writeFileSync(sock, '');
    let t = 1_000;
    const probe = createClaudeInboxRegistry({ dir, isAlive: () => true, ttlMs: 500, now: () => t });
    const first = probe();
    sessionFile(dir, 31, { sessionId: S1, messagingSocketPath: sock });
    t = 1_499;
    expect(probe()).toBe(first);
    expect(first.size).toBe(0);
    t = 1_500;
    expect(probe().has(S1)).toBe(true);
  });
});

describe('buildDoorbellFrame', () => {
  const parse = (line: string) =>
    JSON.parse(line) as { type: string; message: { role: string; content: string }; msg_id: string; priority: string };

  it('one newline-terminated JSON line: a user message with priority "next" and an anytoany- msg_id', () => {
    const line = buildDoorbellFrame({ messageIds: ['m-42', 'm-43'], fromLabel: '@kimi:abcd1234' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    const frame = parse(line);
    expect(Object.keys(frame)).toEqual(['type', 'message', 'msg_id', 'priority']);
    expect(frame).toMatchObject({ type: 'user', message: { role: 'user' }, msg_id: 'anytoany-m-42', priority: 'next' });
  });

  it('says how many messages and from whom, points at the hook and the fallback — and carries no message text', () => {
    const many = parse(buildDoorbellFrame({ messageIds: ['a', 'b', 'c'], fromLabel: '@codex:feedbeef' })).message.content;
    expect(many).toBe(
      '[Morse] Doorbell: 3 new cross-agent messages for this session (from @codex:feedbeef).\n' +
        'The Morse inbox hook attaches them to this turn — handle them there.\n' +
        'If nothing from Morse is attached, run: morse read --pull',
    );
    const one = parse(buildDoorbellFrame({ messageIds: ['a'], fromLabel: '@codex:feedbeef' })).message.content;
    expect(one).toContain('1 new cross-agent message for this session');
    expect(one).toContain('attaches it to this turn — handle it there.');
    expect(one).not.toContain('anytoany');
  });

  it('without ids the msg_id says "wake"', () => {
    expect(parse(buildDoorbellFrame({ messageIds: [], fromLabel: '@x:y' })).msg_id).toBe('anytoany-wake');
  });
});

describe('ringInbox (a real Unix socket)', () => {
  it('delivers exactly the frame and reports ok', async () => {
    const path = join(fresh('morse-ring-'), 'in.sock');
    let got = '';
    let ended!: () => void;
    const closed = new Promise<void>((done) => (ended = done));
    const server: Server = createServer((c) => {
      c.on('data', (d) => (got += d.toString()));
      c.on('end', ended);
    });
    await new Promise<void>((done) => server.listen(path, done));
    try {
      const frame = buildDoorbellFrame({ messageIds: ['z'], fromLabel: '@claude:12345678' });
      expect(await ringInbox(path, frame)).toEqual({ ok: true });
      await closed;
      expect(got).toBe(frame);
    } finally {
      server.close();
    }
  });

  it('nobody listening: not ok, with the error text', async () => {
    const r = await ringInbox(join(tmpdir(), 'morse-nobody-here.sock'), 'x\n', 1_000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOENT|ECONNREFUSED/);
  });
});

describe('doorbellUseful', () => {
  it('rings with an explicit accept, never with refuse or hold, otherwise unless permissions default to bypass', () => {
    const bypass = { permissions: { defaultMode: 'bypassPermissions' } };
    const table: Array<[Parameters<typeof doorbellUseful>[0], boolean]> = [
      [null, true],
      [{}, true],
      [{ permissions: { defaultMode: 'acceptEdits' } }, true],
      [bypass, false],
      [{ ...bypass, crossSessionInbound: 'accept' }, true],
      [{ crossSessionInbound: 'refuse' }, false],
      [{ crossSessionInbound: 'hold', permissions: { defaultMode: 'default' } }, false],
      [{ crossSessionInbound: 'something-new' }, true],
    ];
    for (const [settings, expected] of table) expect(doorbellUseful(settings)).toBe(expected);
  });
});

describe('createDoorbell', () => {
  const sockets: Record<string, string> = { [S1]: '/tmp/morse-test/s1.sock', [S2]: '/tmp/morse-test/s2.sock' };
  const running = (): Map<string, InboxEntry> =>
    new Map(Object.entries(sockets).map(([sessionId, socketPath], i) => [sessionId, { pid: 100 + i, sessionId, socketPath }]));
  const codex = { agent: 'codex', sessionId: 'c0dec0de-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };

  function bell(over: { ok?: boolean; error?: string; enabled?: () => boolean; inboxes?: () => Map<string, InboxEntry> } = {}) {
    const db = createDb(':memory:');
    const mailbox = createMailbox(db);
    const rings: { path: string; frame: string }[] = [];
    const events: DoorbellEvent[] = [];
    const door = createDoorbell({
      inboxes: over.inboxes ?? running,
      mailbox,
      onEvent: (e) => void events.push(e),
      ring: async (socket, line) => {
        rings.push({ path: socket, frame: line });
        return over.ok === false ? { ok: false, ...(over.error ? { error: over.error } : {}) } : { ok: true };
      },
      ...(over.enabled ? { enabled: over.enabled } : {}),
    });
    const toClaude = (sessionId: string, extra: { device?: string } = {}) =>
      mailbox.send({ from: codex, to: { agent: 'claude', sessionId, ...extra }, text: 'please look' });
    return { mailbox, rings, events, door, toClaude };
  }

  it('one ring per session for all its new mail; already-rung mail is not rung again; the mail stays pending', async () => {
    const b = bell();
    const m1 = b.toClaude(S1);
    const m2 = b.toClaude(S1);
    const m3 = b.toClaude(S2);
    await b.door.tick();
    expect(b.rings.map((r) => r.path)).toEqual([sockets[S1], sockets[S2]]);
    expect(JSON.parse(b.rings[0]!.frame).msg_id).toBe(`anytoany-${m1.id}`);
    expect(JSON.parse(b.rings[0]!.frame).message.content).toContain('2 new cross-agent messages');
    expect(JSON.parse(b.rings[0]!.frame).message.content).toContain(`(from @codex:c0dec0de)`);
    expect(b.events).toEqual([
      { kind: 'rung', sessionId: S1, messageIds: [m1.id, m2.id] },
      { kind: 'rung', sessionId: S2, messageIds: [m3.id] },
    ]);
    await b.door.tick();
    expect(b.rings).toHaveLength(2);
    expect(b.mailbox.getMessage(m1.id)?.status).toBe('pending');

    const m4 = b.toClaude(S1);
    await b.door.tick();
    expect(b.events.at(-1)).toEqual({ kind: 'rung', sessionId: S1, messageIds: [m4.id] });
  });

  it('rings nobody for: a session without an inbox, a non-Claude target, a remote device, the human, or a peer\'s message', async () => {
    const b = bell();
    b.toClaude(S3);
    b.toClaude(S1, { device: 'laptop' });
    b.mailbox.send({ from: codex, to: { agent: 'codex', sessionId: S1 }, text: 'x' });
    b.mailbox.send({ from: codex, to: { agent: 'user', sessionId: 'cli' }, text: 'x' });
    // from another computer, even one stored as the owner's: never rung (ADR-048, ADR-091)
    const remote = b.mailbox.send({ from: { ...codex, device: 'mini' }, to: { agent: 'claude', sessionId: S1 }, text: 'x', fromTier: 'owner' });
    expect(remote.to.sessionId).toBe(S1);
    await b.door.tick();
    expect(b.rings).toEqual([]);
  });

  it('a failed ring is reported once and not retried; without an error text it says "unknown error"', async () => {
    const b = bell({ ok: false, error: 'EPIPE' });
    const m = b.toClaude(S1);
    await b.door.tick();
    await b.door.tick();
    expect(b.rings).toHaveLength(1);
    expect(b.events).toEqual([{ kind: 'ring-failed', sessionId: S1, messageIds: [m.id], detail: 'EPIPE' }]);

    const quiet = bell({ ok: false });
    quiet.toClaude(S2);
    await quiet.door.tick();
    expect(quiet.events[0]?.detail).toBe('unknown error');
  });

  it('the gate is read every tick, and with no running session the mailbox is not even read', async () => {
    let on = false;
    const b = bell({ enabled: () => on });
    b.toClaude(S1);
    await b.door.tick();
    expect(b.rings).toEqual([]);
    on = true;
    await b.door.tick();
    expect(b.rings).toHaveLength(1);

    const idle = bell({ inboxes: () => new Map() });
    idle.mailbox.inbox = () => {
      throw new Error('must not be read');
    };
    await expect(idle.door.tick()).resolves.toBeUndefined();
  });
});

describe('doctor: crossSessionInbound (ADR-027)', () => {
  it('only an explicit refuse is a failed check; bypass-by-default reports the doorbell OFF and names the opt-in', () => {
    const verdict = (settings: Parameters<typeof crossSessionInboundCheck>[0]) => crossSessionInboundCheck(settings);
    expect([null, {}, { crossSessionInbound: 'accept' }].map((x) => verdict(x).ok)).toEqual([true, true, true]);
    expect(verdict({ crossSessionInbound: 'refuse' }).ok).toBe(false);
    expect(verdict({}).note).toMatch(/Bypass permissions/);

    const off = verdict({ permissions: { defaultMode: 'bypassPermissions' } });
    expect(off.ok).toBe(true);
    expect(off.note).toMatch(/^OFF/);
    expect(off.note).toContain('"crossSessionInbound": "accept"');
  });
});
