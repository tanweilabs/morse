import { describe, expect, it } from 'vitest';
import { checkClaudeLaunch, claudeArgs, createClaudeAdapter } from '../src/adapters/claude.js';
import type { DeliveryAdapter, ExecFn, SessionInfo } from '../src/adapters/types.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import { createLocalClient } from '../src/plugin/local-client.js';
import { dispatchStep } from '../src/plugins/dispatch/deliver.js';
import { matchLaunch, parseLaunchConfig } from '../src/plugins/dispatch/launch.js';

/**
 * ADR-054: per-agent launch settings in the dispatch plugin — "this agent runs with
 * model X, effort Y, these permissions, this time limit" — config, not core. Bypass-style
 * permission modes are refused in code. Uses a fake exec that records calls and returns a canned result.
 */

const SID = 'aaaa1111-0000-4000-8000-000000000001';
const session: SessionInfo = { agent: 'claude', sessionId: SID, title: 'wechat', cwd: '/w/helper', lastActiveAt: 1 };

function fakeExec(result: { stdout?: string; stderr?: string; code?: number }) {
  const calls: Array<{ cmd: string; args: string[]; opts: { cwd?: string; timeoutMs: number } }> = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === '--version') return { stdout: '9.9.9 (Claude Code)', stderr: '', code: 0 };
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
  };
  return { exec, calls };
}

// today's weixin-bridge run.sh, as a dispatch profile
const RUN_SH = {
  agent: 'claude',
  session: SID,
  from: 'ilink',
  prompt: 'plain',
  permissionMode: 'acceptEdits',
  allowedTools: ['mcp__1board', 'Bash(python3 tools/share.py:*)'],
  model: 'claude-fable-5-2',
  effort: 'high',
  timeoutSec: 600,
  appendSystemPrompt: 'send files with [[send-file: /abs/path]]',
};

describe('claude launch settings (ADR-054)', () => {
  it('builds the run.sh command line: model, effort, permission mode, allowed tools, system prompt, prompt last after --', async () => {
    const { profiles, errors } = parseLaunchConfig([RUN_SH]);
    expect(errors).toEqual([]);
    const { exec, calls } = fakeExec({ stdout: 'hello back' });
    const r = await createClaudeAdapter({ exec }).deliver(session, '-rf hostile "text"', profiles[0]!.launch);
    expect(r).toEqual({ ok: true, output: 'hello back' });
    const run = calls.find((c) => c.args[0] === '-p')!;
    expect(run.args).toEqual([
      '-p',
      '--model', 'claude-fable-5-2',
      '--effort', 'high',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'mcp__1board,Bash(python3 tools/share.py:*)',
      '--append-system-prompt', 'send files with [[send-file: /abs/path]]', '--system-prompt-snapshot', 'off',
      '--resume', SID,
      '--', '-rf hostile "text"',
    ]);
    expect(run.opts).toEqual({ cwd: '/w/helper', timeoutMs: 600_000 });
    expect(run.args.join(' ')).not.toMatch(/dangerously|bypass/);
  });

  it('no settings = exactly the old command line', async () => {
    expect(claudeArgs(SID, 'ENV')).toEqual(['-p', '--resume', SID, 'ENV']);
  });

  it('refuses bypass-style permission modes and odd tool names — in the config and again in the adapter', async () => {
    for (const mode of ['bypassPermissions', 'BYPASS', 'dangerously-skip-permissions', 'skip', 'whatever']) {
      expect(() => checkClaudeLaunch({ permissionMode: mode })).toThrow();
      expect(parseLaunchConfig([{ agent: 'claude', permissionMode: mode }]).profiles).toEqual([]);
    }
    for (const tool of ['Bash', 'Bash(*)', 'Bash(rm -rf /; ls:*)', 'mcp__x; rm', '--dangerously-skip-permissions']) {
      expect(() => checkClaudeLaunch({ allowedTools: [tool] }), tool).toThrow();
    }
    // even if a bad object reaches the adapter directly, nothing runs
    const { exec, calls } = fakeExec({ stdout: 'x' });
    const r = await createClaudeAdapter({ exec }).deliver(session, 'ENV', { permissionMode: 'bypassPermissions' });
    expect(r).toMatchObject({ ok: false, retry: false });
    expect(r.error).toMatch(/bypass/);
    expect(calls).toEqual([]);
  });

  it('a timeout under launch settings is final (the turn already ran)', async () => {
    const { exec } = fakeExec({ code: 124, stderr: '\ntimeout after 600000ms' });
    const r = await createClaudeAdapter({ exec }).deliver(session, 'ENV', { timeoutMs: 600_000 });
    expect(r).toEqual({ ok: false, retry: false, error: 'claude did not finish within 600 s' });
  });

  it('config validation: unsupported agents, plain without from, relative cwd are ignored with a reason', () => {
    const { profiles, errors } = parseLaunchConfig([
      { agent: 'codex', model: 'x' },
      { agent: 'claude', prompt: 'plain' },
      { agent: 'claude', cwd: 'rel/dir' },
      { agent: 'claude', effort: 'turbo' },
      { agent: 'claude', model: 'claude-fable-5-2' },
    ]);
    expect(profiles).toHaveLength(1);
    expect(errors).toHaveLength(4);
    expect(errors.join('\n')).toMatch(/only supported for claude[\s\S]*needs "from"[\s\S]*absolute[\s\S]*effort/);
    expect(parseLaunchConfig({}).errors).toEqual(['plugins.dispatch.launch must be a list']);
  });

  it('matching: agent required; the most specific profile wins (session > cwd > from)', () => {
    const { profiles } = parseLaunchConfig([
      { agent: 'claude', model: 'm-all' },
      { agent: 'claude', cwd: '/w/helper/', model: 'm-cwd' },
      { agent: 'claude', from: 'ilink', model: 'm-from' },
      { agent: 'claude', session: SID, model: 'm-session' },
    ]);
    expect(matchLaunch(profiles, session, 'claude')?.launch.model).toBe('m-session');
    expect(matchLaunch(profiles, { ...session, sessionId: 'other' }, 'ilink')?.launch.model).toBe('m-cwd');
    expect(matchLaunch(profiles, { ...session, sessionId: 'other', cwd: '/x' }, 'ilink')?.launch.model).toBe('m-from');
    expect(matchLaunch(profiles, { ...session, sessionId: 'other', cwd: '/x' }, 'codex')?.launch.model).toBe('m-all');
    expect(matchLaunch(profiles, { ...session, agent: 'codex' }, 'ilink')).toBeNull();
  });
});

describe('dispatch with a launch profile (ADR-054)', () => {
  const setup = (adapterOut: string) => {
    const mailbox = createMailbox(createDb(':memory:'));
    const calls: Array<{ envelope: string; launch: unknown }> = [];
    const adapter: DeliveryAdapter = {
      agent: 'claude',
      listSessions: async () => [session],
      deliver: async (_s, envelope, launch) => {
        calls.push({ envelope, launch });
        return { ok: true, output: adapterOut };
      },
    };
    const { profiles } = parseLaunchConfig([RUN_SH]);
    const deps = { core: createLocalClient(mailbox), adapters: new Map([['claude', adapter]]), directory: async () => [session], launchProfiles: () => profiles };
    return { mailbox, calls, deps };
  };

  it('plain: the owner\'s text under one header, settings passed, the whole answer filed as the reply in the same thread', async () => {
    const { mailbox, calls, deps } = setup('Line one\n[[send-file: /w/helper/a.png]]\nLine three\n');
    const m = mailbox.send({ from: { agent: 'ilink', sessionId: 'ilink-wechat' }, to: { agent: 'claude', sessionId: SID }, text: '帮我看看今天的待办' });
    expect(await dispatchStep(deps)).toBe(true);
    expect(calls[0]!.envelope).toMatch(/^\[Morse\] This is your owner writing to you in person through @ilink:/);
    expect(calls[0]!.envelope).toContain('帮我看看今天的待办');
    expect(calls[0]!.envelope).not.toMatch(/ANYTOANY_REPLY|peer agent/);
    expect(calls[0]!.launch).toMatchObject({ permissionMode: 'acceptEdits', model: 'claude-fable-5-2', timeoutMs: 600_000 });
    const reply = mailbox.inbox({ all: true }).find((x) => x.to.agent === 'ilink')!;
    expect(reply.parts[0]!.text).toBe('Line one\n[[send-file: /w/helper/a.png]]\nLine three');
    expect(reply.contextId).toBe(m.contextId);
    expect(reply.to.sessionId).toBe('ilink-wechat');
  });

  it('mail from another of your agents to the same session keeps the envelope and no settings', async () => {
    const { mailbox, calls, deps } = setup('');
    mailbox.send({ from: { agent: 'codex', sessionId: 'c1' }, to: { agent: 'claude', sessionId: SID }, text: 'run the tests' });
    expect(await dispatchStep(deps)).toBe(true);
    expect(calls[0]!.envelope).toMatch(/ANYTOANY_REPLY/);
    expect(calls[0]!.launch).toBeUndefined();
  });
});
