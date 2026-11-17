import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createZcodeAdapter } from '../src/adapters/zcode.js';
import type { SessionInfo } from '../src/adapters/types.js';
import { recordingExec } from './helpers/fake-exec.js';

const work = mkdtempSync(join(tmpdir(), 'morse-zcode-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const SID = 'sess_7f3a9c10-0b1d-4e2f-9a8b-1c2d3e4f5a6b';
const target: SessionInfo = { agent: 'zcode', sessionId: SID, title: 'audit', cwd: '/srv/audit', lastActiveAt: 0 };
const NO_DB = join(work, 'no-db.sqlite');
const NO_CONFIG = join(work, 'no-config.json');
let fileNo = 0;
const config = (zcode: Record<string, unknown>): string => {
  const file = join(work, `config-${++fileNo}.json`);
  writeFileSync(file, JSON.stringify({ zcode }));
  return file;
};

describe('zcode: sessions are read from ZCode\'s own sqlite db', () => {
  function dbOf(rows: Array<Record<string, unknown>>, schema = 'id TEXT, parent_id TEXT, title TEXT, directory TEXT, task_type TEXT, time_updated INTEGER, extra TEXT'): string {
    const file = join(work, `db-${++fileNo}.sqlite`);
    const db = new Database(file);
    db.exec(`CREATE TABLE session (${schema})`);
    for (const row of rows) {
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO session (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
    }
    db.close();
    return file;
  }
  const list = (dbFile: string) => createZcodeAdapter({ dbFile, engineBin: '/x/zcode', exec: recordingExec().exec }).listSessions();

  it('lists top-level sessions newest first, with title, directory and update time', async () => {
    const file = dbOf([
      { id: 'sess_older', title: ' Billing fix ', directory: '/w/billing', task_type: 'interactive', time_updated: 100 },
      { id: 'sess_newer', title: null, directory: '/w/frontend', task_type: 'interactive', time_updated: 900 },
      { id: 'sess_blank', title: '   ', directory: '', time_updated: 'not a number' },
    ]);
    expect(await list(file)).toEqual([
      { agent: 'zcode', sessionId: 'sess_newer', title: 'frontend', cwd: '/w/frontend', lastActiveAt: 900 },
      { agent: 'zcode', sessionId: 'sess_older', title: 'Billing fix', cwd: '/w/billing', lastActiveAt: 100 },
      { agent: 'zcode', sessionId: 'sess_blank', title: 'untitled', cwd: '', lastActiveAt: 0 },
    ]);
  });

  it('sub-agent sessions in any of their three shapes, and rows without an id, are left out', async () => {
    const file = dbOf([
      { id: 'sess_main', title: 'main', directory: '/w', time_updated: 5 },
      { id: 'sess_subagent_reviewer_1', title: 'by name', directory: '/w', time_updated: 6 },
      { id: 'sess_child', parent_id: 'sess_main', title: 'by parent', directory: '/w', time_updated: 7 },
      { id: 'sess_typed', title: 'by type', directory: '/w', task_type: 'subagent_child', time_updated: 8 },
      { id: 'sess_emptyparent', parent_id: '', title: 'empty parent is fine', directory: '/w', time_updated: 4 },
      { id: '', title: 'no id', directory: '/w', time_updated: 9 },
      { id: null, title: 'null id', directory: '/w', time_updated: 9 },
    ]);
    expect((await list(file)).map((s) => s.sessionId)).toEqual(['sess_main', 'sess_emptyparent']);
  });

  it('long titles are cut at 80 characters with an ellipsis', async () => {
    const file = dbOf([{ id: 'sess_long', title: 't'.repeat(100), directory: '/w', time_updated: 1 }]);
    expect((await list(file))[0]?.title).toBe(`${'t'.repeat(80)}…`);
  });

  it('no db, or a db without a session table: no sessions', async () => {
    expect(await list(NO_DB)).toEqual([]);
    const other = join(work, 'other.sqlite');
    new Database(other).exec('CREATE TABLE unrelated (x TEXT)');
    expect(await list(other)).toEqual([]);
  });
});

describe('zcode: headless delivery resumes the session in an explicit mode', () => {
  const adapter = (opts: { engineBin?: string; configFile?: string; stdout?: string } = {}) => {
    const rec = recordingExec({ stdout: opts.stdout ?? 'answer' });
    const a = createZcodeAdapter({
      dbFile: NO_DB,
      exec: rec.exec,
      configFile: opts.configFile ?? NO_CONFIG,
      ...(opts.engineBin === undefined ? { engineBin: '/opt/zcode/bin/zcode' } : opts.engineBin ? { engineBin: opts.engineBin } : {}),
    });
    return { a, runs: rec.runs };
  };
  const modeIn = (args: string[]) => args[args.indexOf('--mode') + 1];

  it('a native engine runs directly: --cwd, --resume, --mode build, --prompt', async () => {
    const { a, runs } = adapter();
    expect(await a.deliver(target, 'PROMPT; rm -rf /')).toEqual({ ok: true, output: 'answer' });
    expect(runs).toEqual([
      {
        cmd: '/opt/zcode/bin/zcode',
        args: ['--cwd', '/srv/audit', '--resume', SID, '--mode', 'build', '--prompt', 'PROMPT; rm -rf /'],
        opts: { cwd: '/srv/audit', timeoutMs: 300_000 },
      },
    ]);
  });

  it.each(['/Applications/ZCode.app/glm/zcode.cjs', '/opt/zcode/engine.js'])('a script engine (%s) runs through node', async (engine) => {
    const { a, runs } = adapter({ engineBin: engine });
    await a.deliver(target, 'E');
    expect(runs[0]?.cmd).toBe('node');
    expect(runs[0]?.args.slice(0, 3)).toEqual([engine, '--cwd', '/srv/audit']);
  });

  it('an unknown cwd: no --cwd and no cwd option', async () => {
    const { a, runs } = adapter();
    await a.deliver({ ...target, cwd: '' }, 'E');
    expect(runs[0]?.args).toEqual(['--resume', SID, '--mode', 'build', '--prompt', 'E']);
    expect(runs[0]?.opts).toStrictEqual({ timeoutMs: 300_000 });
  });

  it('the mode is the owner\'s choice from config; anything unknown falls back to build', async () => {
    const modes: Array<string | undefined> = [];
    for (const deliverMode of ['yolo', 'plan', 'edit', 'build', 'sudo', 7]) {
      const { a, runs } = adapter({ configFile: config({ deliverMode }) });
      await a.deliver(target, 'E');
      modes.push(modeIn(runs[0]!.args));
    }
    expect(modes).toEqual(['yolo', 'plan', 'edit', 'build', 'build', 'build']);
  });

  it('by default the headless engine never gets yolo', async () => {
    const { a, runs } = adapter();
    await a.deliver(target, 'E');
    expect(runs[0]?.args.join(' ')).not.toContain('yolo');
  });

  it('deliverTimeoutSec counts within 60..3600 seconds; the adapter\'s own limit wins', async () => {
    const seen: number[] = [];
    for (const deliverTimeoutSec of [900, 60, 3600, 30, 4000]) {
      const { a, runs } = adapter({ configFile: config({ deliverTimeoutSec }) });
      await a.deliver(target, 'E');
      seen.push(runs[0]!.opts.timeoutMs);
    }
    expect(seen).toEqual([900_000, 60_000, 3_600_000, 300_000, 300_000]);
    const rec = recordingExec();
    await createZcodeAdapter({ dbFile: NO_DB, exec: rec.exec, engineBin: '/z', configFile: config({ deliverTimeoutSec: 900 }), deliverTimeoutMs: 5_000 }).deliver(target, 'E');
    expect(rec.runs[0]?.opts.timeoutMs).toBe(5_000);
  });

  it('a failure reports the exit code and the end of stderr', async () => {
    const stderr = `${'='.repeat(900)}FATAL: session locked`;
    const rec = recordingExec({ code: 1, stderr });
    const result = await createZcodeAdapter({ dbFile: NO_DB, exec: rec.exec, engineBin: '/z', configFile: NO_CONFIG }).deliver(target, 'E');
    expect(result).toEqual({ ok: false, error: `zcode resume exited 1: …${stderr.slice(-500)}` });
  });

  it('the engine is found through MORSE_ZCODE_BIN, then the old ANYTOANY_ZCODE_BIN, then PATH', async () => {
    const bins = join(work, 'bins');
    mkdirSync(bins, { recursive: true });
    for (const f of ['custom-zcode', 'legacy-zcode', 'zcode']) writeFileSync(join(bins, f), '');
    vi.stubEnv('PATH', bins);
    const rec = recordingExec();
    const a = createZcodeAdapter({ dbFile: NO_DB, exec: rec.exec, configFile: NO_CONFIG });
    vi.stubEnv('MORSE_ZCODE_BIN', join(bins, 'custom-zcode'));
    vi.stubEnv('ANYTOANY_ZCODE_BIN', join(bins, 'legacy-zcode'));
    await a.deliver(target, 'E');
    vi.stubEnv('MORSE_ZCODE_BIN', '');
    await a.deliver(target, 'E');
    vi.stubEnv('ANYTOANY_ZCODE_BIN', '');
    await a.deliver(target, 'E');
    expect(rec.runs.map((r) => r.cmd)).toEqual([join(bins, 'custom-zcode'), join(bins, 'legacy-zcode'), join(bins, 'zcode')]);
  });
});

describe('zcode: a session mid-turn with its mailbox on gets the letter in its mailbox (ADR-029)', () => {
  /** A mailbox root (optionally already enabled for SID) and an adapter whose polling we drive. */
  function rig(opts: { enabled?: boolean; busy: () => boolean; onPoll?: (unread: string) => void; deliverTimeoutMs?: number }) {
    const root = mkdtempSync(join(work, 'mailbox-'));
    const unread = join(root, SID, 'unread');
    if (opts.enabled !== false) mkdirSync(unread, { recursive: true });
    const rec = recordingExec({ stdout: 'resumed headless' });
    let polls = 0;
    const adapter = createZcodeAdapter({
      dbFile: NO_DB,
      exec: rec.exec,
      engineBin: '/opt/zcode/bin/zcode',
      configFile: NO_CONFIG,
      mailboxRoot: root,
      isBusy: () => opts.busy(),
      pollMs: 3,
      sleep: async (ms) => {
        expect(ms).toBe(3);
        polls++;
        opts.onPoll?.(unread);
      },
      ...(opts.deliverTimeoutMs !== undefined ? { deliverTimeoutMs: opts.deliverTimeoutMs } : {}),
    });
    return { adapter, root, unread, runs: rec.runs, polls: () => polls };
  }
  /** What ZCode does when it drains: move every unread letter to read/. */
  const drainInto = (read: string[]) => (unread: string) => {
    for (const name of readdirSync(unread)) {
      read.push(readFileSync(join(unread, name), 'utf8'));
      renameSync(join(unread, name), join(unread, '..', `taken-${name}`));
    }
  };

  it('the letter is picked up: delivered in-session, no headless turn, reply by command', async () => {
    const letters: string[] = [];
    const r = rig({ busy: () => true, onPoll: drainInto(letters) });
    expect(r.adapter.replyChannel?.(target)).toBe('command');
    expect(await r.adapter.deliver(target, 'THE ENVELOPE')).toEqual({ ok: true, output: '', inSession: true });
    expect(r.runs).toEqual([]);
    expect(letters).toHaveLength(1);
    const letter = JSON.parse(letters[0]!);
    expect(letter).toMatchObject({ version: 1, fromSessionId: 'anytoany', toSessionId: SID, content: 'THE ENVELOPE' });
    expect(letter.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(letter.createdAt))).toBe(false);
  });

  it('the turn ends with the letter unread: it is taken back and delivered headless, once', async () => {
    let checks = 0;
    const r = rig({ busy: () => checks++ < 2 });
    expect(await r.adapter.deliver(target, 'E')).toEqual({ ok: true, output: 'resumed headless' });
    expect(r.polls()).toBe(2);
    expect(r.runs).toHaveLength(1);
    expect(readdirSync(r.unread)).toEqual([]);
  });

  it('the budget runs out while the turn goes on: taken back, delivered headless', async () => {
    const r = rig({ busy: () => true, deliverTimeoutMs: -1 });
    expect(await r.adapter.deliver(target, 'E')).toEqual({ ok: true, output: 'resumed headless' });
    expect(r.polls()).toBe(1);
    expect(readdirSync(r.unread)).toEqual([]);
  });

  it('ZCode grabs the letter at the moment we try to take it back: still delivered in-session', async () => {
    let checks = 0;
    const r = rig({
      busy: () => {
        checks++;
        if (checks === 2) drainInto([])(join(r.root, SID, 'unread'));
        return checks < 2;
      },
    });
    expect(await r.adapter.deliver(target, 'E')).toEqual({ ok: true, output: '', inSession: true });
    expect(r.runs).toEqual([]);
  });

  it('an idle session, or a busy one whose mailbox is off, gets the headless turn and marker replies', async () => {
    const idleRig = rig({ busy: () => false });
    expect(idleRig.adapter.replyChannel?.(target)).toBe('marker');
    await idleRig.adapter.deliver(target, 'E');
    expect(idleRig.runs).toHaveLength(1);
    expect(readdirSync(idleRig.unread)).toEqual([]);

    const offRig = rig({ enabled: false, busy: () => true });
    expect(offRig.adapter.replyChannel?.(target)).toBe('marker');
    await offRig.adapter.deliver(target, 'E');
    expect(offRig.runs).toHaveLength(1);
    expect(existsSync(join(offRig.root, SID))).toBe(false);
  });

  it('a letter that cannot be written falls back to the headless turn', async () => {
    const r = rig({ busy: () => true });
    chmodSync(join(r.root, SID), 0o500);
    try {
      expect(await r.adapter.deliver(target, 'E')).toEqual({ ok: true, output: 'resumed headless' });
      expect(r.polls()).toBe(0);
    } finally {
      chmodSync(join(r.root, SID), 0o700);
    }
  });

  it('replyChannel and the delivery right after it take the same route', async () => {
    let busy = true;
    let checks = 0;
    const r = rig({
      busy: () => {
        checks++;
        return busy;
      },
      onPoll: drainInto([]),
    });
    expect(r.adapter.replyChannel?.(target)).toBe('command');
    busy = false; // the turn ends between rendering the envelope and delivering it
    expect(await r.adapter.deliver(target, 'E')).toEqual({ ok: true, output: '', inSession: true });
    expect(checks).toBe(1);
  });
});
