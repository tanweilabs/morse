import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createKimiAdapter } from '../src/adapters/kimi.js';
import type { SessionInfo } from '../src/adapters/types.js';
import { recordingExec } from './helpers/fake-exec.js';

const work = mkdtempSync(join(tmpdir(), 'morse-kimi-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const KIMI = '/opt/kimi/bin/kimi';
const NO_INDEX = join(work, 'absent.jsonl');
const target: SessionInfo = {
  agent: 'kimi',
  sessionId: 'session_5e55-10n0',
  title: 'notes',
  cwd: '/home/user/notes',
  lastActiveAt: 0,
};

/** Kimi's `--output-format stream-json`: one JSON message per line. */
const stream = (...messages: Array<Record<string, unknown> | string>) =>
  messages.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n');

describe('kimi: delivery is `kimi -S <id> -p <envelope> --output-format stream-json`', () => {
  it('builds the argv, runs in the session cwd, and never adds an autonomy flag', async () => {
    const { exec, runs } = recordingExec({ stdout: stream({ role: 'assistant', content: 'ok' }) });
    await createKimiAdapter({ indexFile: NO_INDEX, kimiBin: KIMI, exec }).deliver(target, '--yolo "not a flag"');
    expect(runs).toEqual([
      {
        cmd: KIMI,
        args: ['-S', target.sessionId, '-p', '--yolo "not a flag"', '--output-format', 'stream-json'],
        opts: { cwd: '/home/user/notes', timeoutMs: 300_000 },
      },
    ]);
  });

  it('without a cwd only the time limit is passed; the adapter time limit is honoured', async () => {
    const { exec, runs } = recordingExec();
    await createKimiAdapter({ indexFile: NO_INDEX, kimiBin: KIMI, exec, deliverTimeoutMs: 12_000 }).deliver({ ...target, cwd: '' }, 'E');
    expect(runs[0]?.opts).toStrictEqual({ timeoutMs: 12_000 });
  });

  it('the output is the assistant prose only — tool results, meta hints and banner noise dropped', async () => {
    const stdout = stream(
      'Kimi Code v0.32 — starting',
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'ran ls: 3 files' },
      { role: 'assistant', content: 'Looked at the files.' },
      { role: 'assistant', content: [{ type: 'text', text: 'structured, skipped' }] },
      '',
      { role: 'assistant', content: '<<<ANYTOANY_REPLY>>> DONE three files' },
      { role: 'meta', type: 'session.resume_hint', content: 'To resume: kimi -r session_5e55' },
    );
    const { exec } = recordingExec({ stdout });
    const result = await createKimiAdapter({ indexFile: NO_INDEX, kimiBin: KIMI, exec }).deliver(target, 'E');
    expect(result).toEqual({ ok: true, output: 'Looked at the files.\n<<<ANYTOANY_REPLY>>> DONE three files' });
  });

  it('a failure reports the exit code and the last 500 characters of stderr', async () => {
    const stderr = `${'~'.repeat(700)}Error: session not found`;
    const { exec } = recordingExec({ code: 2, stderr });
    const result = await createKimiAdapter({ indexFile: NO_INDEX, kimiBin: KIMI, exec }).deliver(target, 'E');
    expect(result).toEqual({ ok: false, error: `kimi resume exited 2: …${stderr.slice(-500)}` });
  });

  it('finds the binary through MORSE_KIMI_BIN, then the old ANYTOANY_KIMI_BIN, then PATH', async () => {
    const bins = join(work, 'bins');
    mkdirSync(bins, { recursive: true });
    const named = join(bins, 'kimi-custom');
    const legacy = join(bins, 'kimi-legacy');
    for (const f of [named, legacy, join(bins, 'kimi')]) {
      writeFileSync(f, '#!/bin/sh\n');
      chmodSync(f, 0o755);
    }
    const { exec, runs } = recordingExec();
    const adapter = createKimiAdapter({ indexFile: NO_INDEX, exec });
    vi.stubEnv('PATH', `${join(work, 'empty-dir')}:${bins}`);
    vi.stubEnv('MORSE_KIMI_BIN', named);
    vi.stubEnv('ANYTOANY_KIMI_BIN', legacy);
    await adapter.deliver(target, 'E');
    vi.stubEnv('MORSE_KIMI_BIN', '');
    await adapter.deliver(target, 'E');
    vi.stubEnv('ANYTOANY_KIMI_BIN', join(bins, 'does-not-exist'));
    await adapter.deliver(target, 'E');
    expect(runs.map((r) => r.cmd)).toEqual([named, legacy, join(bins, 'kimi')]);
  });
});

describe('kimi: sessions come from ~/.kimi-code/session_index.jsonl', () => {
  let n = 0;
  /** An index file whose rows point at real session dirs with the given mtimes (ms). */
  function indexOf(rows: Array<{ id: string; workDir?: unknown; mtime?: number } | string>): string {
    const file = join(work, `index-${++n}.jsonl`);
    const lines = rows.map((row) => {
      if (typeof row === 'string') return row;
      const sessionDir = join(work, `dirs-${n}`, row.id);
      if (row.mtime !== undefined) {
        mkdirSync(sessionDir, { recursive: true });
        utimesSync(sessionDir, row.mtime / 1000, row.mtime / 1000);
      }
      return JSON.stringify({ sessionId: row.id, sessionDir, workDir: row.workDir });
    });
    writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  }
  const list = (indexFile: string) => createKimiAdapter({ indexFile, kimiBin: KIMI }).listSessions();

  it('maps each row and puts the most recently used session first', async () => {
    const file = indexOf([
      { id: 'session_old', workDir: '/home/user/api', mtime: 2_000_000 },
      { id: 'session_new', workDir: '/home/user/web', mtime: 8_000_000 },
    ]);
    expect(await list(file)).toEqual([
      { agent: 'kimi', sessionId: 'session_new', title: 'web', cwd: '/home/user/web', lastActiveAt: 8_000_000 },
      { agent: 'kimi', sessionId: 'session_old', title: 'api', cwd: '/home/user/api', lastActiveAt: 2_000_000 },
    ]);
  });

  it('a repeated id keeps its latest row; a vanished session dir counts as never active', async () => {
    const file = indexOf([
      { id: 'session_dup', workDir: '/a/first', mtime: 5_000_000 },
      { id: 'session_gone', workDir: '/a/gone' },
      { id: 'session_dup', workDir: '/a/second', mtime: 5_000_000 },
    ]);
    const found = await list(file);
    expect(found.map((s) => [s.sessionId, s.cwd, s.lastActiveAt])).toEqual([
      ['session_dup', '/a/second', 5_000_000],
      ['session_gone', '/a/gone', 0],
    ]);
  });

  it('title is the work dir name cut to 80 characters (no ellipsis), or "untitled"', async () => {
    const long = 'd'.repeat(95);
    const file = indexOf([
      { id: 'session_long', workDir: `/x/${long}`, mtime: 1000 },
      { id: 'session_nowhere', workDir: 42, mtime: 1000 },
    ]);
    const byId = new Map((await list(file)).map((s) => [s.sessionId, s]));
    expect(byId.get('session_long')?.title).toBe('d'.repeat(80));
    expect(byId.get('session_nowhere')).toMatchObject({ title: 'untitled', cwd: '' });
  });

  it('bad lines, non-object lines and rows without an id are skipped; no index means no sessions', async () => {
    const file = indexOf([
      '{"sessionId": "trunc',
      'null',
      '[1, 2]',
      JSON.stringify({ workDir: '/no/id' }),
      JSON.stringify({ sessionId: '', workDir: '/empty/id' }),
      JSON.stringify({ sessionId: 'session_fine', workDir: '/w/fine', sessionDir: 7 }),
    ]);
    expect((await list(file)).map((s) => [s.sessionId, s.lastActiveAt])).toEqual([['session_fine', 0]]);
    expect(await list(NO_INDEX)).toEqual([]);
  });
});
