import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCodexAdapter, THREAD_BUSY } from '../src/adapters/codex.js';
import type { SessionInfo } from '../src/adapters/types.js';
import { VERSION_MISMATCH } from '../src/adapters/version-guard.js';
import { REPLY_MARKER, renderEnvelope } from '../src/envelope.js';
import { cliReporting, recordingExec } from './helpers/fake-exec.js';

const THREAD = '019a7c3e-5d21-7f00-8a00-00000000c0de';
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratchDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};

const thread = (patch: Partial<SessionInfo> = {}): SessionInfo => ({
  agent: 'codex',
  sessionId: THREAD,
  title: 'release notes',
  cwd: '/srv/app',
  lastActiveAt: 1,
  ...patch,
});

/** A machine config file with `codex` settings; returns its path and a way to rewrite them. */
function machineConfig(codex: Record<string, unknown>) {
  const file = join(scratchDir('morse-codex-config-'), 'config.json');
  const write = (next: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ codex: next }));
  write(codex);
  return { file, write };
}
const NO_CONFIG = join(tmpdir(), 'morse-codex-no-config', 'config.json');
const idle = () => false;

describe('codex: a thread nobody holds gets a headless `codex exec resume` turn', () => {
  it('argv: exec resume <thread> --skip-git-repo-check <envelope>, envelope untouched by any shell', async () => {
    const { exec, runs } = recordingExec({ stdout: 'did it' });
    const envelope = 'go; $(curl evil) "and" `this`';
    const result = await createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: idle }).deliver(thread(), envelope);
    expect(result).toEqual({ ok: true, output: 'did it' });
    expect(runs).toEqual([
      {
        cmd: 'codex',
        args: ['exec', 'resume', THREAD, '--skip-git-repo-check', envelope],
        opts: { cwd: '/srv/app', timeoutMs: 300_000 },
      },
    ]);
  });

  it('an unknown cwd is left out of the spawn options entirely', async () => {
    const { exec, runs } = recordingExec();
    await createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: idle }).deliver(thread({ cwd: '' }), 'E');
    expect(Object.keys(runs[0]!.opts)).toEqual(['timeoutMs']);
  });

  it('a non-zero exit is a retryable failure with the end of stderr', async () => {
    const stderr = `${'banner '.repeat(100)}Error: network hiccup`;
    const { exec } = recordingExec({ code: 1, stderr });
    const result = await createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: idle }).deliver(thread(), 'E');
    expect(result).toEqual({ ok: false, error: `codex exec resume exited 1: …${stderr.slice(-500)}` });
  });

  it('a timeout (124) is final: the turn ran, re-running it would do the work twice', async () => {
    const stderr = `${'.'.repeat(400)}still reading the repo`;
    const { exec } = recordingExec({ code: 124, stderr });
    const result = await createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: idle }).deliver(thread(), 'E');
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.error).toMatch(/^codex exec resume timed out after 300s/);
    expect(result.error).toContain('Raise codex.deliverTimeoutSec in ~/.morse/config.json');
    expect(result.error?.endsWith(`…${stderr.slice(-300)}`)).toBe(true);
  });

  it('a thread another Codex process writes to is a terminal codex_thread_busy (ADR-026)', async () => {
    expect(THREAD_BUSY).toBe('codex_thread_busy');
    const stderr = [
      'ERROR codex_core::session: Failed to create session: thread-store conflict',
      `Error: thread/resume failed: thread ${THREAD} already has an active writer (code -32600)`,
    ].join('\n');
    const { exec } = recordingExec({ code: 1, stderr });
    const result = await createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: idle }).deliver(thread(), 'E');
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.error).toMatch(new RegExp(`^codex_thread_busy: codex thread ${THREAD} is open in another Codex process`));
    expect(result.error).toContain('(usually Codex Desktop)');
    expect(result.error).toContain('the message was NOT delivered');
  });
});

describe('codex: the machine owner decides sandbox and time limit (~/.morse/config.json)', () => {
  it.each(['read-only', 'workspace-write', 'danger-full-access'])('sandbox "%s" goes between `exec` and `resume`', async (mode) => {
    const { exec, runs } = recordingExec();
    const { file } = machineConfig({ sandbox: mode });
    await createCodexAdapter({ exec, configFile: file, isThreadLive: idle }).deliver(thread(), 'E');
    expect(runs[0]?.args).toEqual(['exec', '--sandbox', mode, 'resume', THREAD, '--skip-git-repo-check', 'E']);
  });

  it('an unknown sandbox name, or none, adds no flag; edits apply to the next delivery', async () => {
    const { exec, runs } = recordingExec();
    const cfg = machineConfig({ sandbox: 'root-everything' });
    const adapter = createCodexAdapter({ exec, configFile: cfg.file, isThreadLive: idle });
    await adapter.deliver(thread(), 'E');
    cfg.write({});
    await adapter.deliver(thread(), 'E');
    cfg.write({ sandbox: 'read-only' });
    await adapter.deliver(thread(), 'E');
    expect(runs.map((r) => r.args.slice(0, 3))).toEqual([
      ['exec', 'resume', THREAD],
      ['exec', 'resume', THREAD],
      ['exec', '--sandbox', 'read-only'],
    ]);
  });

  it('deliverTimeoutSec counts only within 60..3600 seconds', async () => {
    const { exec, runs } = recordingExec();
    const cfg = machineConfig({});
    const adapter = createCodexAdapter({ exec, configFile: cfg.file, isThreadLive: idle });
    for (const value of [60, 3600, 1200, 59, 3601, '900', null]) {
      cfg.write({ deliverTimeoutSec: value });
      await adapter.deliver(thread(), 'E');
    }
    expect(runs.map((r) => r.opts.timeoutMs)).toEqual([60_000, 3_600_000, 1_200_000, 300_000, 300_000, 300_000, 300_000]);
  });

  it('a time limit given to the adapter itself wins over the config', async () => {
    const { exec, runs } = recordingExec({ code: 124 });
    const { file } = machineConfig({ deliverTimeoutSec: 1200 });
    const result = await createCodexAdapter({ exec, configFile: file, isThreadLive: idle, deliverTimeoutMs: 7_400 }).deliver(thread(), 'E');
    expect(runs[0]?.opts.timeoutMs).toBe(7_400);
    expect(result.error).toMatch(/timed out after 7s/);
  });
});

describe('codex: a thread Codex Desktop holds open goes through its queue (ADR-027)', () => {
  const live = () => true;

  it('`codex queue --thread <id> --message <envelope>`, a short time limit, delivered in-session', async () => {
    const { exec, runs } = recordingExec({ stdout: `Queued message 7 for thread ${THREAD}.` });
    const result = await createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: live }).deliver(thread(), 'HELLO');
    expect(result).toEqual({ ok: true, output: '', inSession: true });
    expect(runs).toEqual([
      { cmd: 'codex', args: ['queue', '--thread', THREAD, '--message', 'HELLO'], opts: { cwd: '/srv/app', timeoutMs: 30_000 } },
    ]);
  });

  it('the queue ignores sandbox settings and never probes the CLI version', async () => {
    const { exec, argvs } = cliReporting('0.100.0');
    const { file } = machineConfig({ sandbox: 'danger-full-access' });
    const adapter = createCodexAdapter({ exec, configFile: file, isThreadLive: live });
    expect(await adapter.preflight!(thread({ writerVersion: '0.170.0' }))).toBeNull();
    await adapter.deliver(thread({ writerVersion: '0.170.0', cwd: '' }), 'E');
    expect(argvs()).toEqual([['codex', 'queue', '--thread', THREAD, '--message', 'E']]);
  });

  it('a failed queue is retryable and quotes stderr, or stdout when stderr is empty', async () => {
    const viaStderr = recordingExec({ code: 2, stderr: 'error: no such thread', stdout: 'ignored' });
    const a = await createCodexAdapter({ exec: viaStderr.exec, configFile: NO_CONFIG, isThreadLive: live }).deliver(thread(), 'E');
    expect(a).toEqual({ ok: false, error: 'codex queue exited 2: …error: no such thread' });
    const viaStdout = recordingExec({ code: 2, stdout: 'queue db locked' });
    const b = await createCodexAdapter({ exec: viaStdout.exec, configFile: NO_CONFIG, isThreadLive: live }).deliver(thread(), 'E');
    expect(b).toEqual({ ok: false, error: 'codex queue exited 2: …queue db locked' });
  });

  it('replies come back by command when queued, by marker otherwise', () => {
    const held = new Set([THREAD]);
    const adapter = createCodexAdapter({ configFile: NO_CONFIG, isThreadLive: (id) => held.has(id) });
    expect(adapter.replyChannel?.(thread())).toBe('command');
    expect(adapter.replyChannel?.(thread({ sessionId: 'other' }))).toBe('marker');
  });

  it('the envelope tells the agent how to answer on each channel', () => {
    const input = { messageId: 'm-42', fromLabel: '@claude:api', text: 'ship it' };
    expect(renderEnvelope(input)).toContain(`${REPLY_MARKER} DONE`);
    const byCommand = renderEnvelope({ ...input, replyVia: 'command' });
    expect(byCommand).toContain('anyd reply m-42 "DONE');
    expect(byCommand).toContain('anyd reply m-42 "NOOP"');
    expect(byCommand).toContain('ship it');
    expect(byCommand).not.toContain(REPLY_MARKER);
  });
});

describe('codex: refuses a global CLI older than the session writer (ADR-025)', () => {
  it('stops after `codex --version`, naming both versions and the upgrade', async () => {
    const { exec, argvs } = cliReporting('codex-cli 0.157.1');
    const result = await createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: idle }).deliver(
      thread({ writerVersion: '0.162.0-alpha.17.2' }),
      'E',
    );
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.error?.startsWith(`${VERSION_MISMATCH}: the codex CLI`)).toBe(true);
    expect(result.error).toContain('(codex-cli 0.157.1)');
    expect(result.error).toContain('Codex Desktop that last wrote this session (0.162.0-alpha.17.2)');
    expect(result.error).toContain('npm i -g @openai/codex@latest');
    expect(argvs()).toEqual([['codex', '--version']]);
  });

  it('a released 0.162.1 resumes what a 0.162.0 prerelease wrote', async () => {
    const { exec, argvs } = cliReporting('codex-cli 0.162.1');
    const result = await createCodexAdapter({ exec, configFile: NO_CONFIG, isThreadLive: idle }).deliver(
      thread({ writerVersion: '0.162.0-alpha.17.2' }),
      'E',
    );
    expect(result).toEqual({ ok: true, output: 'TURN OUTPUT' });
    expect(argvs()[1]?.slice(0, 3)).toEqual(['codex', 'exec', 'resume']);
  });
});

describe('codex: thread discovery from ~/.codex/sessions', () => {
  /** A sessions tree plus an index file. */
  function codexHome() {
    const sessions = scratchDir('morse-codex-sessions-');
    const indexFile = join(sessions, 'session_index.jsonl');
    const rollout = (
      day: string,
      clock: string,
      id: string,
      firstLine: unknown,
      opts: { mtime?: Date; rest?: string } = {},
    ): string => {
      const folder = join(sessions, ...day.split('-'));
      mkdirSync(folder, { recursive: true });
      const path = join(folder, `rollout-${day}T${clock}-${id}.jsonl`);
      const head = typeof firstLine === 'string' ? firstLine : JSON.stringify(firstLine);
      writeFileSync(path, `${head}\n${opts.rest ?? '{"type":"event"}\n'}`);
      if (opts.mtime) utimesSync(path, opts.mtime, opts.mtime);
      return path;
    };
    const index = (lines: Array<Record<string, unknown> | string>) =>
      writeFileSync(indexFile, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
    const list = () => createCodexAdapter({ sessionsDir: sessions, indexFile, configFile: NO_CONFIG, isThreadLive: idle }).listSessions();
    return { sessions, rollout, index, list };
  }
  const meta = (payload: Record<string, unknown>) => ({ type: 'session_meta', payload });
  const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

  it('title from the index (its last entry), else the cwd folder, else "untitled"; cut at 80', async () => {
    const h = codexHome();
    h.rollout('2026-11-01', '09-00-00', id(1), meta({ cwd: '/w/alpha' }));
    h.rollout('2026-11-01', '09-00-01', id(2), meta({ cwd: '/w/beta' }));
    h.rollout('2026-11-01', '09-00-02', id(3), meta({}));
    h.rollout('2026-11-01', '09-00-03', id(4), meta({ cwd: '/w/d' }));
    h.index([
      { id: id(1), thread_name: 'first name', updated_at: '2026-01-01T00:00:00Z' },
      'garbage line',
      { id: id(1), thread_name: '  renamed  ' },
      { id: id(2) },
      { thread_name: 'no id' },
      { id: id(4), thread_name: 'n'.repeat(90) },
    ]);
    const byId = new Map((await h.list()).map((s) => [s.sessionId, s]));
    expect(byId.get(id(1))).toMatchObject({ agent: 'codex', title: 'renamed', cwd: '/w/alpha' });
    expect(byId.get(id(2))?.title).toBe('beta');
    expect(byId.get(id(3))).toMatchObject({ title: 'untitled', cwd: '' });
    expect(byId.get(id(4))?.title).toBe(`${'n'.repeat(80)}…`);
  });

  it('last activity: the newer of the index timestamp and the rollout mtime', async () => {
    const h = codexHome();
    h.rollout('2026-11-02', '10-00-00', id(5), meta({ cwd: '/w' }), { mtime: new Date('2026-11-02T10:00:00Z') });
    h.rollout('2026-11-02', '10-00-01', id(6), meta({ cwd: '/w' }), { mtime: new Date('2026-11-02T10:00:00Z') });
    h.index([
      { id: id(5), thread_name: 'a', updated_at: '2026-11-03T00:00:00Z' },
      { id: id(6), thread_name: 'b', updated_at: '2026-10-01T00:00:00Z' },
    ]);
    const byId = new Map((await h.list()).map((s) => [s.sessionId, s.lastActiveAt]));
    expect(byId.get(id(5))).toBe(Date.parse('2026-11-03T00:00:00Z'));
    expect(byId.get(id(6))).toBe(Date.parse('2026-11-02T10:00:00Z'));
  });

  it('a thread spread over several rollouts appears once, judged by its newest rollout', async () => {
    const h = codexHome();
    h.rollout('2026-10-01', '08-00-00', id(7), meta({ cwd: '/w/old' }));
    h.rollout('2026-10-05', '08-00-00', id(7), meta({ cwd: '/w/new' }));
    h.rollout('2026-10-01', '08-00-00', id(8), meta({ cwd: '/w/fine' }));
    h.rollout('2026-10-09', '08-00-00', id(8), { type: 'response_item' });
    const found = await h.list();
    expect(found.map((s) => [s.sessionId, s.cwd])).toEqual([[id(7), '/w/new']]);
  });

  it('sub-agent threads and unreadable first lines are left out', async () => {
    const h = codexHome();
    h.rollout('2026-11-04', '08-00-00', id(9), meta({ cwd: '/w', parent_thread_id: id(1) }));
    h.rollout('2026-11-04', '08-00-01', id(10), meta({ cwd: '/w', thread_source: 'subagent' }));
    h.rollout('2026-11-04', '08-00-02', id(11), 'this is not json');
    h.rollout('2026-11-04', '08-00-03', id(12), '');
    h.rollout('2026-11-04', '08-00-04', id(13), meta({ cwd: '/w/ok', thread_source: 'user' }));
    writeFileSync(join(h.sessions, '2026', '11', '04', 'rollout-not-a-thread.jsonl'), JSON.stringify(meta({ cwd: '/w' })));
    expect((await h.list()).map((s) => s.sessionId)).toEqual([id(13)]);
  });

  it('a very long session_meta line (base instructions) is read whole', async () => {
    const h = codexHome();
    h.rollout('2026-11-05', '08-00-00', id(14), meta({ cwd: '/w/long', base_instructions: 'b'.repeat(200_000), cli_version: '0.160.0' }));
    const [s] = await h.list();
    expect(s).toMatchObject({ sessionId: id(14), cwd: '/w/long', writerVersion: '0.160.0' });
  });

  it('no sessions directory: no threads', async () => {
    const adapter = createCodexAdapter({ sessionsDir: join(tmpdir(), 'morse-no-codex-here'), indexFile: NO_CONFIG, configFile: NO_CONFIG, isThreadLive: idle });
    expect(await adapter.listSessions()).toEqual([]);
  });

  // cli_version is written once, when a thread is created; a long-lived Desktop thread is
  // written today by today's Desktop, so its writer is inferred from its originator's newest rollouts
  it('writer version: own cli_version, raised to what the same originator ran by the thread\'s last activity', async () => {
    const h = codexHome();
    const desktop = (v: string, at: string) => ({ originator: 'Codex Desktop', cli_version: v, timestamp: at });
    h.rollout('2026-06-01', '12-00-00', id(20), meta({ cwd: '/w', ...desktop('0.140.0', '2026-06-01T04:00:00Z') }), {
      mtime: new Date('2026-11-10T09:00:00Z'),
    });
    h.rollout('2026-11-09', '12-00-00', id(21), meta({ cwd: '/w', ...desktop('0.165.0-alpha.3', '2026-11-09T04:00:00Z') }), {
      mtime: new Date('2026-11-09T05:00:00Z'),
    });
    h.rollout('2026-11-11', '12-00-00', id(22), meta({ cwd: '/w', ...desktop('0.170.0', '2026-11-11T04:00:00Z') }), {
      mtime: new Date('2026-11-11T05:00:00Z'),
    });
    h.rollout('2026-06-02', '12-00-00', id(23), meta({ cwd: '/w', ...desktop('0.141.0', '2026-06-02T04:00:00Z') }), {
      mtime: new Date('2026-06-03T00:00:00Z'),
    });
    h.rollout('2026-11-10', '12-00-00', id(24), meta({ cwd: '/w', originator: 'codex_exec', cli_version: '0.150.0', timestamp: '2026-11-10T00:00:00Z' }), {
      mtime: new Date('2026-11-12T00:00:00Z'),
    });
    h.rollout('2026-11-10', '12-00-01', id(25), meta({ cwd: '/w' }));
    // a sub-agent thread is not listed, but its creation still tells what Desktop ran then
    h.rollout('2026-11-10', '12-00-02', id(26), meta({ cwd: '/w', parent_thread_id: id(20), ...desktop('0.168.0', '2026-11-10T08:00:00Z') }));
    const byId = new Map((await h.list()).map((s) => [s.sessionId, s.writerVersion]));
    expect(byId.get(id(20))).toBe('0.168.0');
    expect(byId.get(id(21))).toBe('0.165.0-alpha.3');
    expect(byId.get(id(22))).toBe('0.170.0');
    expect(byId.get(id(23))).toBe('0.141.0');
    expect(byId.get(id(24))).toBe('0.150.0');
    expect(byId.has(id(25))).toBe(true);
    expect(byId.get(id(25))).toBeUndefined();
    expect(byId.has(id(26))).toBe(false);
  });
});
