import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import type { SessionInfo } from '../src/adapters/types.js';
import { VERSION_MISMATCH } from '../src/adapters/version-guard.js';
import { cliReporting, recordingExec } from './helpers/fake-exec.js';

const ID = 'c1a0de00-1111-4222-8333-444455556666';

const target = (patch: Partial<SessionInfo> = {}): SessionInfo => ({
  agent: 'claude',
  sessionId: ID,
  title: 'backend',
  cwd: '/srv/backend',
  lastActiveAt: 1,
  ...patch,
});

describe('claude: one headless turn per delivery', () => {
  it('runs `claude -p --resume <id> <envelope>` in the session cwd, the envelope as one argv element', async () => {
    const { exec, runs } = recordingExec({ stdout: 'all good' });
    const hostile = 'line one\n"quoted" `tick` $(touch /tmp/pwned); rm -rf ~';
    const result = await createClaudeAdapter({ exec }).deliver(target(), hostile);
    expect(result).toEqual({ ok: true, output: 'all good' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      cmd: 'claude',
      args: ['-p', '--resume', ID, hostile],
      opts: { cwd: '/srv/backend', timeoutMs: 300_000 },
    });
  });

  it('uses the adapter-wide time limit when one is given', async () => {
    const { exec, runs } = recordingExec({ stdout: 'x' });
    await createClaudeAdapter({ exec, deliverTimeoutMs: 42_000 }).deliver(target(), 'E');
    expect(runs[0]?.opts.timeoutMs).toBe(42_000);
  });

  it('will not run without a cwd (resume only works from the project directory)', async () => {
    const { exec, runs } = recordingExec();
    const result = await createClaudeAdapter({ exec }).deliver(target({ cwd: '' }), 'E');
    expect(result).toEqual({ ok: false, error: 'claude delivery requires the session cwd (unknown for this session)' });
    expect(runs).toEqual([]);
  });

  it('a plain failure is retryable and carries the last 500 characters of stderr', async () => {
    const stderr = `${'#'.repeat(800)}Error: resume blew up`;
    const { exec } = recordingExec({ code: 3, stderr });
    const result = await createClaudeAdapter({ exec }).deliver(target(), 'E');
    expect(result).toEqual({ ok: false, error: `claude -p --resume exited 3: …${stderr.slice(-500)}` });
  });

  it('without launch settings a timeout is an ordinary (retryable) failure', async () => {
    const { exec } = recordingExec({ code: 124, stderr: '\ntimeout after 300000ms' });
    const result = await createClaudeAdapter({ exec }).deliver(target(), 'E');
    expect(result.ok).toBe(false);
    expect(result.retry).toBeUndefined();
    expect(result.error).toMatch(/exited 124/);
  });
});

describe('claude: a failing post-turn hook does not undo a delivered turn (ADR-023)', () => {
  it.each(['Stop', 'SessionEnd', 'SubagentStop'])('%s hook failure with turn output = delivered', async (hook) => {
    const { exec } = recordingExec({
      code: 1,
      stdout: 'Read the brief, starting now.',
      stderr: `some banner\n${hook} hook [bash ~/.claude/hooks/after.sh] failed: Hook cancelled\n`,
    });
    const result = await createClaudeAdapter({ exec }).deliver(target(), 'E');
    expect(result).toEqual({ ok: true, output: 'Read the brief, starting now.' });
  });

  it('the same hook failure with no turn output cannot prove delivery: failure', async () => {
    const { exec } = recordingExec({ code: 1, stdout: '  \n', stderr: 'Stop hook [x] failed: boom' });
    const result = await createClaudeAdapter({ exec }).deliver(target(), 'E');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exited 1');
  });

  it('a hook that runs BEFORE the turn failing is a real failure', async () => {
    const { exec } = recordingExec({ code: 1, stdout: 'partial', stderr: 'UserPromptSubmit hook [x] failed: denied' });
    const result = await createClaudeAdapter({ exec }).deliver(target(), 'E');
    expect(result.ok).toBe(false);
  });
});

describe('claude: a CLI that is not signed in fails clearly and is not retried', () => {
  const expectAuthError = (result: { ok: boolean; retry?: boolean; error?: string }) => {
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.error).toContain('claude CLI auth expired / not logged in');
    expect(result.error).toContain('ADR-008');
  };

  it('"Not logged in" on stdout, even with exit 0', async () => {
    const { exec } = recordingExec({ stdout: '{"type":"result","result":"Not logged in · Please run /login"}' });
    expectAuthError(await createClaudeAdapter({ exec }).deliver(target(), 'E'));
  });

  it('an expired OAuth session, on either stream', async () => {
    const onStdout = recordingExec({ code: 1, stdout: 'OAuth session expired and could not be refreshed' });
    expectAuthError(await createClaudeAdapter({ exec: onStdout.exec }).deliver(target(), 'E'));
    const onStderr = recordingExec({ code: 1, stderr: 'API Error: OAuth token has expired' });
    expectAuthError(await createClaudeAdapter({ exec: onStderr.exec }).deliver(target(), 'E'));
  });
});

describe('claude: launch settings (ADR-054, ADR-056)', () => {
  it('settings that fail validation stop the delivery before anything runs', async () => {
    const { exec, runs } = recordingExec();
    const result = await createClaudeAdapter({ exec }).deliver(target({ writerVersion: '2.0.0' }), 'E', {
      permissionMode: 'bypassPermissions',
    });
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.error).toMatch(/bypass-style/);
    expect(runs).toEqual([]);
  });

  it('a timeout under settings is final, said in seconds', async () => {
    const { exec, runs } = recordingExec({ code: 124, stderr: 'partial\ntimeout after 90000ms' });
    const result = await createClaudeAdapter({ exec }).deliver(target(), 'E', { timeoutMs: 90_000 });
    expect(runs[0]?.opts.timeoutMs).toBe(90_000);
    expect(result).toEqual({ ok: false, retry: false, error: 'claude did not finish within 90 s' });
  });

  it('resuming a session that does not exist reports missingSession (nothing ran)', async () => {
    const { exec } = recordingExec({ code: 1, stderr: `No conversation found with session ID: ${ID}` });
    const result = await createClaudeAdapter({ exec }).deliver(target(), 'E');
    expect(result).toEqual({
      ok: false,
      retry: false,
      missingSession: true,
      error: `claude: no conversation found with session id ${ID}`,
    });
  });

  it('when the session is being created, "no conversation found" is not read as a missing session', async () => {
    const { exec, runs } = recordingExec({ code: 1, stdout: 'No conversation found' });
    const result = await createClaudeAdapter({ exec }).deliver(target(), 'E', { createSession: true });
    expect(runs[0]?.args).toContain('--session-id');
    expect(result.missingSession).toBeUndefined();
    expect(result.ok).toBe(false);
  });
});

describe('claude: refuses a global CLI older than the session writer (ADR-025)', () => {
  it('preflight explains the mismatch and names the upgrade command', async () => {
    const { exec } = cliReporting('2.1.287 (Claude Code)');
    const message = await createClaudeAdapter({ exec }).preflight!(target({ writerVersion: '2.1.295' }));
    expect(message?.startsWith(`${VERSION_MISMATCH}: the claude CLI`)).toBe(true);
    expect(message).toContain('Claude Code (desktop App)');
    expect(message).toContain('npm i -g @anthropic-ai/claude-code@latest');
  });

  it('deliver stops after the version probe, terminally', async () => {
    const { exec, argvs } = cliReporting('2.1.287 (Claude Code)');
    const result = await createClaudeAdapter({ exec }).deliver(target({ writerVersion: '2.1.295' }), 'E');
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(false);
    expect(result.error?.startsWith(VERSION_MISMATCH)).toBe(true);
    expect(argvs()).toEqual([['claude', '--version']]);
  });

  it('a CLI at least as new delivers, and the probe is reused for the next message', async () => {
    const { exec, argvs } = cliReporting('2.1.295 (Claude Code)');
    const adapter = createClaudeAdapter({ exec });
    expect(await adapter.deliver(target({ writerVersion: '2.1.295' }), 'one')).toEqual({ ok: true, output: 'TURN OUTPUT' });
    await adapter.deliver(target({ writerVersion: '2.1.295' }), 'two');
    expect(argvs()).toEqual([
      ['claude', '--version'],
      ['claude', '-p', '--resume', ID, 'one'],
      ['claude', '-p', '--resume', ID, 'two'],
    ]);
  });

  it('a session with no recorded writer is never probed', async () => {
    const { exec, argvs } = cliReporting('0.0.1');
    await createClaudeAdapter({ exec }).deliver(target(), 'E');
    expect(argvs()).toEqual([['claude', '-p', '--resume', ID, 'E']]);
  });
});

describe('claude: session discovery from ~/.claude/projects', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  /** A projects dir holding one project folder; returns a writer for transcripts in it. */
  function projects() {
    const root = mkdtempSync(join(tmpdir(), 'morse-claude-projects-'));
    roots.push(root);
    const folder = join(root, '-escaped-name');
    mkdirSync(folder);
    const put = (file: string, records: unknown[] | string, mtime?: Date): string => {
      const path = join(folder, file);
      writeFileSync(path, typeof records === 'string' ? records : records.map((r) => JSON.stringify(r)).join('\n'));
      if (mtime) utimesSync(path, mtime, mtime);
      return path;
    };
    const list = () => createClaudeAdapter({ projectsDir: root }).listSessions();
    return { root, folder, put, list };
  }
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('maps a transcript: id from the file name, cwd from the content, mtime as last activity', async () => {
    const p = projects();
    p.put(`${uuid(1)}.jsonl`, [
      { type: 'summary', summary: 'x' },
      { type: 'user', cwd: '/real/place', version: '2.1.0', message: { content: 'fix the login bug' } },
      { type: 'assistant', cwd: '/elsewhere', version: '2.1.9', message: { content: [] } },
    ], new Date('2026-11-01T10:00:00Z'));
    expect(await p.list()).toEqual([
      {
        agent: 'claude',
        sessionId: uuid(1),
        title: 'fix the login bug',
        cwd: '/real/place',
        lastActiveAt: Date.parse('2026-11-01T10:00:00Z'),
        writerVersion: '2.1.9',
      },
    ]);
  });

  it('title: the last custom title wins over any user text', async () => {
    const p = projects();
    p.put(`${uuid(2)}.jsonl`, [
      { type: 'user', cwd: '/w', message: { content: 'first prompt' } },
      { type: 'custom-title', customTitle: 'early name' },
      { type: 'custom-title', customTitle: 'final name' },
    ]);
    expect((await p.list())[0]?.title).toBe('final name');
  });

  it('title: the first user text that is not a system wrapper, from string or text-part content', async () => {
    const p = projects();
    p.put(`${uuid(3)}.jsonl`, [
      { type: 'user', cwd: '/w', message: { content: '<local-command-caveat>Caveat: generated</local-command-caveat>' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'zzz' }, { type: 'text', text: '<system-reminder>x' }] } },
      { type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: '   ' }, { type: 'text', text: '  review my PR  ' }] } },
      { type: 'user', message: { content: 'later prompt' } },
    ]);
    expect((await p.list())[0]?.title).toBe('review my PR');
  });

  it('title: falls back to the cwd folder name, then "untitled"; long ones are cut at 80 with an ellipsis', async () => {
    const p = projects();
    p.put(`${uuid(4)}.jsonl`, [{ type: 'assistant', cwd: '/home/me/web-shop' }]);
    p.put(`${uuid(5)}.jsonl`, [{ type: 'assistant' }]);
    p.put(`${uuid(6)}.jsonl`, [{ type: 'user', cwd: '/w', message: { content: 'q'.repeat(81) } }]);
    p.put(`${uuid(7)}.jsonl`, [{ type: 'user', cwd: '/w', message: { content: 'q'.repeat(80) } }]);
    const byId = new Map((await p.list()).map((s) => [s.sessionId, s]));
    expect(byId.get(uuid(4))?.title).toBe('web-shop');
    expect(byId.get(uuid(5))?.title).toBe('untitled');
    expect(byId.get(uuid(5))?.cwd).toBe('');
    expect(byId.get(uuid(5))).not.toHaveProperty('writerVersion');
    expect(byId.get(uuid(6))?.title).toBe(`${'q'.repeat(80)}…`);
    expect(byId.get(uuid(7))?.title).toBe('q'.repeat(80));
  });

  it('skips what is not a session transcript: other names, empty or unparseable files, loose files', async () => {
    const p = projects();
    p.put(`${uuid(8)}.jsonl`, [{ type: 'user', cwd: '/w', message: { content: 'kept' } }]);
    p.put('ABCDEF00-0000-4000-8000-00000000000A.jsonl', [{ type: 'user', cwd: '/w' }]);
    p.put('notes.jsonl', [{ type: 'user', cwd: '/w' }]);
    p.put(`${uuid(10)}.json`, [{ type: 'user', cwd: '/w' }]);
    p.put(`${uuid(11)}.jsonl`, '');
    p.put(`${uuid(12)}.jsonl`, 'not json at all\n{"half":');
    mkdirSync(join(p.folder, 'memory'));
    writeFileSync(join(p.root, `${uuid(13)}.jsonl`), JSON.stringify({ type: 'user', cwd: '/w' }));
    expect((await p.list()).map((s) => s.sessionId)).toEqual([uuid(8)]);
  });

  it('corrupt or non-object lines inside a transcript are skipped, the rest is read', async () => {
    const p = projects();
    p.put(`${uuid(14)}.jsonl`, `{"type":"user","cwd":"/w","message":{"content":"ok"}}\n{broken\nnull\n42\n\n{"version":"1.2.3"}`);
    const [s] = await p.list();
    expect(s?.title).toBe('ok');
    expect(s?.writerVersion).toBe('1.2.3');
  });

  it('a huge transcript is read only at its head and tail', async () => {
    const p = projects();
    const filler = (n: number) => Array.from({ length: n }, () => ({ type: 'assistant', message: { content: 'f'.repeat(1000) } }));
    p.put(`${uuid(15)}.jsonl`, [
      { type: 'user', cwd: '/w/big', version: '1.0.0', message: { content: 'opening prompt' } },
      ...filler(320),
      { type: 'custom-title', customTitle: 'hidden in the middle' },
      ...filler(320),
      { type: 'assistant', version: '1.0.7' },
    ]);
    const [s] = await p.list();
    expect(s?.title).toBe('opening prompt');
    expect(s?.cwd).toBe('/w/big');
    expect(s?.writerVersion).toBe('1.0.7');
  });

  it('no projects directory yet: no sessions', async () => {
    expect(await createClaudeAdapter({ projectsDir: join(tmpdir(), 'morse-no-such-dir', 'projects') }).listSessions()).toEqual([]);
  });
});
