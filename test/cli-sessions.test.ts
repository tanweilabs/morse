import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dataDir } from '../src/home.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import { countSpawn, enforceSpawnBudget, spawnBudget } from './helpers/spawn-budget.js';

/**
 * The session commands of the real CLI — list, send to a session with no daemon, read --pull / --history /
 * --wait, list --conversations, connect (an external agent, or 闪电说), hook, stop, status — in temp homes
 * holding Claude and Codex sessions written here. Nothing touches the real home, and no daemon runs.
 */

const repo = resolve(__dirname, '..');
enforceSpawnBudget();

const homes: string[] = [];
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const ALPHA = 'a1a1a1a1-0000-4000-8000-0000000000a1';
const BETA = 'b2b2b2b2-0000-4000-8000-0000000000b2';
const GAMMA = 'c3c3c3c3-0000-4000-8000-0000000000c3';

/** A home with two Claude sessions (in /work/alpha and /work/beta) and one Codex session (in /work/gamma). */
function homeWithSessions(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'morse-cli-sessions-')));
  homes.push(home);
  const write = (rel: string, lines: unknown[], mtime: string) => {
    const path = join(home, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(path, new Date(mtime), new Date(mtime));
  };
  const said = (cwd: string, text: string) => ({ type: 'user', cwd, message: { role: 'user', content: text } });
  write(`.claude/projects/-work-alpha/${ALPHA}.jsonl`, [said('/work/alpha', 'Alpha planning')], '2026-01-03T00:00:00Z');
  write(`.claude/projects/-work-beta/${BETA}.jsonl`, [said('/work/beta', 'Beta review')], '2026-01-02T00:00:00Z');
  write(`.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${GAMMA}.jsonl`, [{ type: 'session_meta', payload: { cwd: '/work/gamma' } }], '2026-01-01T00:00:00Z');
  return home;
}

const run = (home: string, args: string[], stdin?: string) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    countSpawn();
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: repo, env: { ...process.env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => done({ code, out, err }));
    p.stdin.end(stdin ?? '');
  });
const linesOf = (text: string) => text.split('\n').filter(Boolean);
const mailboxOf = (home: string) => createMailbox(createDb(join(dataDir(home), 'mailbox.db'), { ctx: homeContactContext(home) }));

describe('morse list', () => {
  it('the sessions here, newest first: @agent:title  [id]  (when, where); --limit; --json', { timeout: spawnBudget(3) }, async () => {
    const home = homeWithSessions();
    const all = await run(home, ['list']);
    expect(all.code).toBe(0);
    expect(linesOf(all.out).map((l) => l.replace(/\(\d+d ago, /, '(…, '))).toEqual([
      '@claude:Alpha planning  [a1a1a1a1]  (…, /work/alpha)',
      '@claude:Beta review  [b2b2b2b2]  (…, /work/beta)',
      '@codex:gamma  [c3c3c3c3]  (…, /work/gamma)',
    ]);
    const one = await run(home, ['list', '--limit', '1']);
    expect(linesOf(one.out).slice(1)).toEqual(['… 2 more (use --limit 0 for all)']);
    const json = JSON.parse((await run(home, ['list', '--json', '--limit', '2'])).out) as { sessions: Array<{ sessionId: string }>; total: number; errors: unknown[] };
    expect(json.sessions.map((s) => s.sessionId)).toEqual([ALPHA, BETA]);
    expect(json.total).toBe(3);
    expect(json.errors).toEqual([]);
  });
});

describe('sending to a session, no daemon running', () => {
  it('queued here by @agent:fragment; a target that resolves to nothing: the candidates, exit 1', { timeout: spawnBudget(3) }, async () => {
    const home = homeWithSessions();
    const sent = await run(home, ['send', '@claude:beta', 'please look at the diff']);
    expect(sent.code).toBe(0);
    const [queued, to, later] = linesOf(sent.out);
    expect(queued).toMatch(/^queued [0-9a-f-]{36} \(daemon offline — local resolution only\)$/);
    expect(to).toBe('  to: @claude:Beta review [b2b2b2b2]');
    expect(later).toBe('  delivery starts once the daemon is running (morse start)');

    const missing = await run(home, ['send', '@claude:nothing-like-it', 'x']);
    expect(missing.code).toBe(1);
    expect(linesOf(missing.err)).toEqual([
      'error: cannot resolve target "@claude:nothing-like-it" (not_found)',
      '  candidate: @claude:Alpha planning  [a1a1a1a1]',
      '  candidate: @claude:Beta review  [b2b2b2b2]',
    ]);

    const fromSession = await run(home, ['send', '@codex', 'from alpha', '--session', '@claude:alpha']);
    expect(fromSession.code).toBe(0);
    const m = mailboxOf(home).inbox({ all: true }).find((x) => x.parts[0]?.text === 'from alpha');
    expect(m?.from).toEqual({ agent: 'claude', sessionId: ALPHA });
    expect(m?.to.sessionId).toBe(GAMMA);
  });
});

describe('morse read --pull / --history / --wait, list --conversations', () => {
  it('pull: the new mail of a session once; --history: the exchange again; no session in a directory: said', { timeout: spawnBudget(5) }, async () => {
    const home = homeWithSessions();
    const mb = mailboxOf(home);
    const m = mb.send({ from: { agent: 'claude', sessionId: ALPHA }, to: { agent: 'codex', sessionId: GAMMA }, text: 'run the benchmarks' });

    const first = await run(home, ['read', '--pull', '--cwd', '/work/gamma']);
    const lines = first.out.split('\n');
    expect(lines[0]).toBe('===== @codex:gamma =====');
    expect(lines[1]).toBe(`[Morse] Cross-agent message from @claude:a1a1a1a1 (message id: ${m.id}).`);
    expect(first.out.endsWith(`To answer, run: anyd reply ${m.id} "<your reply>"\n\n`)).toBe(true);

    const again = await run(home, ['read', '--pull', '--session', '@codex']);
    expect(again.out).toBe('no new Morse messages — run `morse read --pull --history` to see the recent exchange (delivered ones included).\n');

    const history = await run(home, ['read', '--pull', '--history', '--session', '@codex:gamma']);
    expect(history.out).toContain('===== @codex:gamma =====\n[Morse] Recent cross-agent exchange for this session');
    expect(history.out).toContain('← @claude:a1a1a1a1 [delivered]\nrun the benchmarks');

    const nowhere = await run(home, ['read', '--pull', '--cwd', '/no/such/dir']);
    expect(nowhere.out).toBe('no session found for /no/such/dir — open a session here, or pass --session "@<agent>:<fragment>"\n');
    const quiet = await run(home, ['read', '--pull', '--history', '--quiet', '--session', '@claude:beta']);
    expect(quiet.out).toBe('');
  });

  it('wait: returns with the mail that is there; nothing within the window: said; conversations listed', { timeout: spawnBudget(3) }, async () => {
    const home = homeWithSessions();
    mailboxOf(home).send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'claude', sessionId: BETA }, text: 'for the waiting session' });
    const got = await run(home, ['read', '--wait', '--session', '@claude:beta', '--timeout', '5', '--poll', '100']);
    expect(got.code).toBe(0);
    expect(got.out.split('\n').slice(0, 2)).toEqual(['waiting for messages to @claude:Beta review…', '===== @claude:Beta review =====']);
    expect(got.out).toContain('for the waiting session');
    // a heartbeat was kept while it waited, and cleared on the way out
    expect(existsSync(join(dataDir(home), 'monitors'))).toBe(true);
    expect(existsSync(join(dataDir(home), 'monitors', BETA))).toBe(false);

    const none = await run(home, ['monitor', '--session', '@claude:beta', '--timeout', '1', '--poll', '100']);
    expect(linesOf(none.out)).toEqual(['waiting for messages to @claude:Beta review…', 'nothing arrived in the window — run `morse read --wait` again to keep waiting.']);

    const convos = await run(home, ['list', '--conversations']);
    expect(linesOf(convos.out)).toEqual([`@user:cli ↔ @claude:b2b2b2b2  (1 msgs, just now) — for the waiting session`]);
  });
});

describe('morse connect', () => {
  it('an external agent session: registered (pull-only, listed), then forgotten', { timeout: spawnBudget(4) }, async () => {
    const home = homeWithSessions();
    const reg = await run(home, ['connect', '--agent', 'notes', '--session', 'n-1', '--title', 'Notes App']);
    expect(linesOf(reg.out).slice(0, 2)).toEqual(['registered @notes:Notes App  [n-1]', 'it is pull-only — it receives via `morse read --pull` or POST /api/inbox, never a headless resume']);
    expect(linesOf((await run(home, ['list'])).out)[0]).toBe('@notes:Notes App  [n-1]  (just now, external, pull-only)');
    const reserved = await run(home, ['register', '--agent', 'codex', '--session', 'x']);
    expect(reserved.code).toBe(1);
    expect(reserved.err).toMatch(/^error: agent name "codex" is reserved/);
    const gone = await run(home, ['connect', '--agent', 'notes', '--session', 'n-1', '--uninstall']);
    expect(gone.out).toBe('unregistered @notes:n-1\n');
  });

  it('闪电说: a preview first, written with --apply; an unknown app or nothing at all: exit 1', { timeout: spawnBudget(4) }, async () => {
    const home = homeWithSessions();
    const app = join(home, 'sds-data');
    mkdirSync(app);
    const preview = await run(home, ['connect', 'sds', '--app-home', app]);
    const lines = preview.out.split('\n');
    expect(lines.slice(0, 4)).toEqual(['闪电说 data dir: ~/sds-data', 'workspace:      ~/sds-data/workspace', '', '  create    ~/sds-data/workspace/library/skills/anytoany/SKILL.md']);
    expect(lines[4]).toMatch(/^ {12}↳ /);
    expect(lines.at(-2)).toBe('preview only — nothing was written. Re-run with --apply to write these changes.');
    expect(existsSync(join(app, 'workspace'))).toBe(false);

    const applied = await run(home, ['connect', 'sds', '--app-home', app, '--apply', '--port', '7999']);
    expect(linesOf(applied.out).slice(-2)).toEqual(['installed.', 'Restart 闪电说 (or just start a new message) and say 「有我的消息吗」 to test it.']);
    expect(readFileSync(join(app, 'workspace', 'library', 'skills', 'anytoany', 'SKILL.md'), 'utf8')).toContain('7999');

    expect(await run(home, ['connect', 'fax'])).toMatchObject({ code: 1, err: 'error: unknown app "fax" — supported: sds (闪电说)\n' });
    expect((await run(home, ['connect'])).code).toBe(1);
  });
});

describe('morse hook, stop, status', () => {
  it('hook: an unknown kind is refused; no mailbox yet: {}; a waiting message: the context as JSON; bad JSON on stdin: {}', { timeout: spawnBudget(5) }, async () => {
    const home = homeWithSessions();
    expect(await run(home, ['hook', 'shell-prompt'])).toMatchObject({ code: 1, err: 'unknown hook kind: shell-prompt\n' });
    expect((await run(home, ['hook', 'claude-prompt-submit'], JSON.stringify({ session_id: ALPHA }))).out).toBe('{}\n');
    mailboxOf(home).send({ from: { agent: 'codex', sessionId: GAMMA }, to: { agent: 'claude', sessionId: ALPHA }, text: 'hook me' });
    const ran = await run(home, ['hook', 'claude-prompt-submit'], JSON.stringify({ session_id: ALPHA }));
    const out = JSON.parse(ran.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toContain('hook me');
    expect((await run(home, ['hook', 'codex-prompt-submit'], 'not json at all')).out).toBe('{}\n');
    expect((await run(home, ['hook', 'codex-prompt-submit'], 'null')).out).toBe('{}\n');
  });

  it('stop with no daemon, and with a pid file naming nobody; status counts the mailbox by state', { timeout: spawnBudget(3) }, async () => {
    const home = homeWithSessions();
    expect((await run(home, ['stop'])).out).toBe('daemon not running (no pid file)\n');
    mkdirSync(dataDir(home), { recursive: true });
    writeFileSync(join(dataDir(home), 'daemon.pid'), '999999');
    expect((await run(home, ['stop'])).out).toBe('daemon pid 999999 not alive — cleaning pid file\n');
    const mb = mailboxOf(home);
    for (const text of ['one', 'two']) mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'claude', sessionId: ALPHA }, text });
    mb.claimNextPending();
    const status = await run(home, ['status']);
    expect(linesOf(status.out)[0]).toBe('daemon: not running');
    expect(linesOf(status.out)).toContain('mailbox: 2 messages — delivering: 1, pending: 1');
  });
});
