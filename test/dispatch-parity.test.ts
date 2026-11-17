import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeArgs, createClaudeAdapter } from '../src/adapters/claude.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, SessionInfo } from '../src/adapters/types.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { createLocalClient } from '../src/plugin/local-client.js';
import { createDispatcher, dispatchStep, type DispatchDeps } from '../src/plugins/dispatch/deliver.js';
import { parseLaunchConfig } from '../src/plugins/dispatch/launch.js';
import { createDispatchState } from '../src/plugins/dispatch/state.js';

/**
 * ADR-055 / ADR-056 / ADR-057: what the dispatch plugin needs so the iLink plugin is not
 * worse than the standalone weixin-bridge — resume a live session when the profile says
 * so, one turn per session, a dedicated session that is created / kept / recreated, and
 * one quick, final failure for the owner writing in person.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'morse-dispatch-parity-'));
  dirs.push(d);
  return d;
};

const SID = 'eeee0000-0000-4000-8000-00000000000e';
const OTHER = 'eeee0000-0000-4000-8000-0000000000ff';
const session: SessionInfo = { agent: 'claude', sessionId: SID, title: 'wechat', cwd: '/w/helper', lastActiveAt: 1 };
const other: SessionInfo = { ...session, sessionId: OTHER, title: 'other' };
const fromWechat = (mb: Mailbox, text: string, to: { agent: string; sessionId: string } = { agent: 'claude', sessionId: SID }) =>
  mb.send({ from: { agent: 'ilink', sessionId: 'ilink-wechat' }, to, text });
/** The iLink plugin's identity pulls its own mail (registered). */
const isPullOnly = (sid: string) => sid === 'ilink-wechat' || sid === 'inbox';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake claude adapter: records each turn, can be slow, answers with the prompt's last line. */
function recordingAdapter(opts: { delayMs?: number; result?: (envelope: string) => DeliveryResult } = {}) {
  const turns: Array<{ session: string; start: number; end: number; envelope: string; launch: unknown }> = [];
  let active = 0;
  let maxActive = 0;
  const adapter: DeliveryAdapter = {
    agent: 'claude',
    listSessions: async () => [session, other],
    deliver: async (s, envelope, launch) => {
      const start = Date.now();
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(opts.delayMs ?? 0);
      active--;
      turns.push({ session: s.sessionId, start, end: Date.now(), envelope, launch });
      return opts.result?.(envelope) ?? { ok: true, output: `answer: ${envelope.split('\n').pop()}` };
    },
  };
  return { adapter, turns, maxActive: () => maxActive };
}

const overlaps = (turns: Array<{ start: number; end: number }>) =>
  turns.some((a, i) => turns.some((b, j) => i !== j && a.start < b.end && b.start < a.end));

describe('whenLive (ADR-055)', () => {
  const profile = (whenLive: string) => parseLaunchConfig([{ agent: 'claude', session: SID, from: 'ilink', prompt: 'plain', whenLive }]).profiles;

  it('"resume": a WeChat message runs while the target session is live; "wait" (the default): it waits, untouched', async () => {
    for (const mode of ['resume', 'wait']) {
      const mb = createMailbox(createDb(':memory:'));
      const { adapter, turns } = recordingAdapter();
      const deps: DispatchDeps = { isPullOnly, core: createLocalClient(mb), adapters: new Map([['claude', adapter]]), directory: async () => [session], isSessionLive: (sid) => sid === SID, launchProfiles: () => profile(mode) };
      const m = fromWechat(mb, '在吗');
      const ran = await dispatchStep(deps);
      if (mode === 'resume') {
        expect(ran).toBe(true);
        expect(turns.map((t) => t.session)).toEqual([SID]);
        expect(mb.getMessage(m.id)?.status).toBe('delivered');
      } else {
        expect(ran).toBe(false);
        expect(turns).toEqual([]);
        expect(mb.getMessage(m.id)).toMatchObject({ status: 'pending', attempts: 0 });
      }
    }
    expect(parseLaunchConfig([{ agent: 'claude', whenLive: 'always' }]).errors[0]).toMatch(/whenLive/);
  });

  it('only the matching profile resumes: mail from another agent to the same live session still waits — and an older waiting one does not hold up the WeChat one', async () => {
    const mb = createMailbox(createDb(':memory:'));
    const { adapter, turns } = recordingAdapter();
    const deps: DispatchDeps = { isPullOnly, core: createLocalClient(mb), adapters: new Map([['claude', adapter]]), directory: async () => [session], isSessionLive: (sid) => sid === SID, launchProfiles: () => profile('resume') };
    const codex = mb.send({ from: { agent: 'codex', sessionId: 'c1' }, to: { agent: 'claude', sessionId: SID }, text: 'from codex' });
    const wx = fromWechat(mb, 'from wechat');
    expect(await dispatchStep(deps)).toBe(true);
    expect(await dispatchStep(deps)).toBe(false);
    expect(turns).toHaveLength(1);
    expect(mb.getMessage(wx.id)?.status).toBe('delivered');
    expect(mb.getMessage(codex.id)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('one turn per session (ADR-055)', () => {
  it('two messages for one session never run at the same time; another session runs alongside', async () => {
    const mb = createMailbox(createDb(':memory:'));
    const { adapter, turns } = recordingAdapter({ delayMs: 300 });
    const deps: DispatchDeps = { isPullOnly, core: createLocalClient(mb), adapters: new Map([['claude', adapter]]), directory: async () => [session, other], state: createDispatchState(tmp()) };
    fromWechat(mb, 'one');
    fromWechat(mb, 'two');
    mb.send({ from: { agent: 'codex', sessionId: 'c1' }, to: { agent: 'claude', sessionId: OTHER }, text: 'elsewhere' });
    const d = createDispatcher(deps, { concurrency: 4 });
    await d.idle();
    expect(turns).toHaveLength(3);
    const mine = turns.filter((t) => t.session === SID);
    expect(mine).toHaveLength(2);
    expect(overlaps(mine)).toBe(false);
    expect(overlaps(turns)).toBe(true); // the other session did not wait for them
  });

  it('a session whose turn another process is running (its lock) is left alone until it is free', async () => {
    const mb = createMailbox(createDb(':memory:'));
    const { adapter, turns } = recordingAdapter();
    const state = createDispatchState(tmp());
    const deps: DispatchDeps = { isPullOnly, core: createLocalClient(mb), adapters: new Map([['claude', adapter]]), directory: async () => [session], state };
    const m = fromWechat(mb, 'x');
    const held = state.lock(SID)!;
    expect(held).toBeTypeOf('function');
    expect(await dispatchStep(deps)).toBe(false);
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'pending', attempts: 0 });
    held();
    expect(await dispatchStep(deps)).toBe(true);
    expect(turns).toHaveLength(1);
  });
});

/** A fake `claude` for the real adapter: knows which sessions exist, like the CLI does. */
function fakeClaude(known: Set<string>, opts: { fail?: RegExp } = {}) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const exec: ExecFn = async (_cmd, args, o) => {
    if (args[0] === '--version') return { stdout: '9.9.9 (Claude Code)', stderr: '', code: 0 };
    calls.push({ args, ...(o.cwd ? { cwd: o.cwd } : {}) });
    const prompt = args[args.length - 1]!;
    const resume = args.indexOf('--resume');
    if (resume >= 0 && !known.has(args[resume + 1]!)) return { stdout: '', stderr: `No conversation found with session ID: ${args[resume + 1]}`, code: 1 };
    const create = args.indexOf('--session-id');
    if (create >= 0) known.add(args[create + 1]!);
    if (opts.fail?.test(prompt)) return { stdout: '', stderr: 'boom', code: 1 };
    return { stdout: `got: ${prompt.split('\n\n').slice(1).join(' ')}`, stderr: '', code: 0 };
  };
  return { exec, calls };
}

const DEDICATED = { agent: 'claude', name: 'wechat', dedicated: true, cwd: '/w/helper', from: 'ilink', prompt: 'plain', whenLive: 'resume', permissionMode: 'acceptEdits', resetNotice: '（之前的会话找不到了，已新开一个会话，之前的上下文没有了。）' };

describe('a dedicated session per launch profile (ADR-056)', () => {
  const setup = (known = new Set<string>(), opts: { fail?: RegExp } = {}) => {
    const mb = createMailbox(createDb(':memory:'));
    const dir = tmp();
    const state = createDispatchState(dir);
    const claude = fakeClaude(known, opts);
    const ids = ['aaaa0000-0000-4000-8000-000000000001', 'aaaa0000-0000-4000-8000-000000000002', 'aaaa0000-0000-4000-8000-000000000003'];
    const { profiles, errors } = parseLaunchConfig([DEDICATED]);
    expect(errors).toEqual([]);
    const deps: DispatchDeps = { isPullOnly, core: createLocalClient(mb), adapters: new Map([['claude', createClaudeAdapter({ exec: claude.exec })]]), directory: async () => [], launchProfiles: () => profiles, state, newSessionId: () => ids.shift()! };
    const send = async (text: string) => {
      const m = fromWechat(mb, text, { agent: 'dispatch', sessionId: 'wechat' });
      expect(await dispatchStep(deps)).toBe(true);
      return { m, reply: mb.inbox({ all: true }).find((x) => x.to.agent === 'ilink' && x.contextId === m.contextId)?.parts[0]?.text ?? null };
    };
    return { mb, dir, state, claude, deps, send, known };
  };

  it('created on first use in the profile\'s directory, its id kept (0600), then resumed — no reset notice for a first start', async () => {
    const { dir, state, claude, send } = setup();
    const first = await send('第一条');
    expect(claude.calls[0]!.args).toContain('--session-id');
    expect(claude.calls[0]!.args.slice(-3)).toEqual(['aaaa0000-0000-4000-8000-000000000001', '--', expect.stringMatching(/^\[Morse\] This is your owner/)]);
    expect(claude.calls[0]!.args).not.toContain('--resume');
    expect(claude.calls[0]!.cwd).toBe('/w/helper');
    expect(first.reply).toBe('got: 第一条');
    expect(state.dedicated('wechat')).toMatchObject({ sessionId: 'aaaa0000-0000-4000-8000-000000000001', cwd: '/w/helper', fresh: false });
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const second = await send('第二条');
    expect(claude.calls[1]!.args).toEqual(expect.arrayContaining(['--resume', 'aaaa0000-0000-4000-8000-000000000001']));
    expect(claude.calls[1]!.args).not.toContain('--session-id');
    expect(second.reply).toBe('got: 第二条');
  });

  it('recreated when it is gone (no conversation found): the next reply says so once, then the new one is kept', async () => {
    const { state, claude, send, known } = setup();
    await send('a');
    known.clear(); // the session was deleted
    const after = await send('b');
    expect(claude.calls.map((c) => (c.args.includes('--session-id') ? 'create' : 'resume'))).toEqual(['create', 'resume', 'create']);
    expect(after.reply).toBe(`${DEDICATED.resetNotice}\n\ngot: b`);
    expect(state.dedicated('wechat')).toMatchObject({ sessionId: 'aaaa0000-0000-4000-8000-000000000002' });
    expect(state.dedicated('wechat')?.resetPending).toBeUndefined();
    expect((await send('c')).reply).toBe('got: c'); // once
    expect(claude.calls.at(-1)!.args).toEqual(expect.arrayContaining(['--resume', 'aaaa0000-0000-4000-8000-000000000002']));
  });

  it('a seeded session (morse ilink import) is continued, and recreated if it cannot be resumed', async () => {
    const BRIDGE = 'bbbb0000-0000-4000-8000-00000000000b';
    const { state, claude, send } = setup(new Set([BRIDGE]));
    state.setDedicated('wechat', { agent: 'claude', sessionId: BRIDGE, cwd: '/w/helper', createdAt: 'x', seededFrom: 'weixin-bridge' });
    expect((await send('continue')).reply).toBe('got: continue');
    expect(claude.calls[0]!.args).toEqual(expect.arrayContaining(['--resume', BRIDGE]));
  });

  it('mail to the profile address and to its session id share one lane', async () => {
    const { mb, state, deps } = setup(new Set(['cccc0000-0000-4000-8000-00000000000c']));
    state.setDedicated('wechat', { agent: 'claude', sessionId: 'cccc0000-0000-4000-8000-00000000000c', cwd: '/w/helper', createdAt: 'x' });
    const slow = recordingAdapter({ delayMs: 250 });
    deps.adapters.set('claude', slow.adapter);
    deps.directory = async () => [{ ...session, sessionId: 'cccc0000-0000-4000-8000-00000000000c' }];
    fromWechat(mb, 'via profile', { agent: 'dispatch', sessionId: 'wechat' });
    mb.send({ from: { agent: 'codex', sessionId: 'c1' }, to: { agent: 'claude', sessionId: 'cccc0000-0000-4000-8000-00000000000c' }, text: 'via id' });
    await createDispatcher(deps, { concurrency: 4 }).idle();
    expect(slow.turns).toHaveLength(2);
    expect(overlaps(slow.turns)).toBe(false);
  });

  it('config: a dedicated profile needs name and cwd and owns its session', () => {
    const { errors } = parseLaunchConfig([
      { agent: 'claude', dedicated: true, cwd: '/w' },
      { agent: 'claude', dedicated: true, name: 'x' },
      { agent: 'claude', dedicated: true, name: 'y', cwd: '/w', session: SID },
      { agent: 'claude', name: 'Bad Name' },
    ]);
    expect(errors).toHaveLength(4);
    expect(claudeArgs('aaaa0000-0000-4000-8000-000000000001', 'P', { createSession: true })).toEqual(['-p', '--session-id', 'aaaa0000-0000-4000-8000-000000000001', '--', 'P']);
    expect(() => claudeArgs('not-a-uuid', 'P', { createSession: true })).toThrow();
  });
});

describe('a failure for the owner in person is final at once (ADR-057)', () => {
  it('plain: one try, dead immediately (the channel tells him); an agent-to-agent message keeps its retries', async () => {
    const mb = createMailbox(createDb(':memory:'));
    const claude = fakeClaude(new Set([SID]), { fail: /fail/ });
    const { profiles } = parseLaunchConfig([{ agent: 'claude', session: SID, from: 'ilink', prompt: 'plain' }]);
    const deps: DispatchDeps = { isPullOnly, core: createLocalClient(mb), adapters: new Map([['claude', createClaudeAdapter({ exec: claude.exec })]]), directory: async () => [session], launchProfiles: () => profiles };
    const wx = fromWechat(mb, 'please fail');
    expect(await dispatchStep(deps)).toBe(true);
    expect(mb.getMessage(wx.id)).toMatchObject({ status: 'dead', attempts: 1 });
    expect(await dispatchStep(deps)).toBe(false);
    expect(claude.calls).toHaveLength(1);
    const codex = mb.send({ from: { agent: 'codex', sessionId: 'c1' }, to: { agent: 'claude', sessionId: SID }, text: 'please fail too' });
    expect(await dispatchStep(deps)).toBe(true);
    expect(mb.getMessage(codex.id)).toMatchObject({ status: 'failed', attempts: 1 });
  });
});

describe('the state file', () => {
  it('keeps nothing but session ids and directories', () => {
    const dir = tmp();
    const s = createDispatchState(dir);
    s.setDedicated('wechat', { agent: 'claude', sessionId: SID, cwd: '/w', createdAt: 't' });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual({ dedicated: { wechat: { agent: 'claude', sessionId: SID, cwd: '/w', createdAt: 't' } } });
  });
});
