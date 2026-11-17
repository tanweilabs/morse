import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { syncMentionAgents } from '../src/cluster/sync-agents.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});
const agentsDir = (): string => (dir = mkdtempSync(join(tmpdir(), 'morse-mention-')));
const files = (): string[] => readdirSync(dir).sort();
const body = (file: string): string => readFileSync(join(dir, file), 'utf8');

let seq = 0;
const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  agent: 'kimi',
  sessionId: `5e55${String(++seq).padStart(4, '0')}-1111-4222-8333-444455556666`,
  title: 'Billing API',
  cwd: '/Users/alex/code/billing-api',
  lastActiveAt: 50_000,
  ...over,
});

describe('syncMentionAgents: which sessions get an agent', () => {
  it('every non-Claude session outside scratch folders, named after its folder', async () => {
    const d = agentsDir();
    const keep = session();
    const r = await syncMentionAgents(
      [
        keep,
        session({ agent: 'claude', cwd: '/Users/alex/code/web' }),
        session({ cwd: '/tmp/smoke-1' }),
        session({ cwd: '/private/tmp/x' }),
        session({ cwd: '/var/folders/zz/T/run' }),
        session({ cwd: '' }),
      ],
      [],
      { agentsDir: d },
    );
    expect(r).toEqual({ written: ['morse-kimi-billing-api.md'], removed: [] });
    expect(files()).toEqual(['morse-kimi-billing-api.md']);
    expect(body('morse-kimi-billing-api.md')).toContain(`@kimi:${keep.sessionId}`);
  });

  it('falls back from the folder to the title, then to the first 8 characters of the id', async () => {
    const d = agentsDir();
    const titled = session({ cwd: '/', title: 'Release — Notes!' });
    const bare = session({ agent: 'codex', cwd: '/', title: '***' });
    await syncMentionAgents([titled, bare], [], { agentsDir: d });
    expect(files()).toEqual([`morse-codex-${bare.sessionId.slice(0, 8)}.md`, 'morse-kimi-release-notes.md']);
  });

  it('puts the device in the name and the target for a session on another device', async () => {
    const d = agentsDir();
    const remote = session({ device: 'Air M2' });
    await syncMentionAgents([remote], [], { agentsDir: d });
    expect(files()).toEqual(['morse-air-m2-kimi-billing-api.md']);
    expect(body('morse-air-m2-kimi-billing-api.md')).toContain(`morse send "@Air M2/kimi:${remote.sessionId}"`);
  });

  it('keeps the newest N per agent kind, plus any session that is in a conversation', async () => {
    const d = agentsDir();
    const kimis = Array.from({ length: 6 }, (_, i) => session({ cwd: `/w/k${i}`, lastActiveAt: i }));
    const codexes = Array.from({ length: 3 }, (_, i) => session({ agent: 'codex', cwd: `/w/c${i}`, lastActiveAt: 100 + i }));
    const r = await syncMentionAgents(
      [...kimis, ...codexes],
      [{ a: { agent: 'claude', sessionId: 'me' }, b: { agent: 'kimi', sessionId: kimis[0]!.sessionId } }],
      { agentsDir: d, maxPerAgent: 2 },
    );
    // newest first across kinds
    expect(r.written).toEqual(['morse-codex-c2.md', 'morse-codex-c1.md', 'morse-kimi-k5.md', 'morse-kimi-k4.md', 'morse-kimi-k0.md']);
  });

  it('defaults to 8 per kind', async () => {
    const d = agentsDir();
    await syncMentionAgents(Array.from({ length: 10 }, (_, i) => session({ cwd: `/w/p${i}`, lastActiveAt: i })), [], { agentsDir: d });
    expect(files()).toHaveLength(8);
    expect(files()).not.toContain('morse-kimi-p0.md');
  });

  it('a second session with the same name gets 4 characters of its id appended (the newer one keeps the plain name)', async () => {
    const d = agentsDir();
    const older = session({ lastActiveAt: 1 });
    const newer = session({ lastActiveAt: 2 });
    await syncMentionAgents([older, newer], [], { agentsDir: d });
    expect(body('morse-kimi-billing-api.md')).toContain(newer.sessionId);
    expect(body(`morse-kimi-billing-api-${older.sessionId.slice(0, 4)}.md`)).toContain(older.sessionId);
  });
});

describe('syncMentionAgents: the file', () => {
  it('is exactly the pinned agent definition (only the "Active …" age varies)', async () => {
    const d = agentsDir();
    await syncMentionAgents(
      [{ agent: 'codex', sessionId: 'aaaa0000-1', title: 'mobile app dev', cwd: '/Users/alex/projects/mobile-app', lastActiveAt: Date.now() - 3 * 3600_000, device: 'Mini Box' }],
      [],
      { agentsDir: d },
    );
    const text = body('morse-mini-box-codex-mobile-app.md');
    expect(text).toMatch(/ Active 3h ago\.\n/);
    expect(text.replace(/Active [^.]*\./, 'Active X.')).toBe(readFileSync(join(import.meta.dirname, 'fixtures', 'mention-agent.md'), 'utf8'));
  });

  it('local sessions have no device part', async () => {
    const d = agentsDir();
    const s = session();
    await syncMentionAgents([s], [], { agentsDir: d });
    const text = body('morse-kimi-billing-api.md');
    expect(text).toContain(`(${s.cwd}). Delivers to that exact kimi session via Morse;`);
    expect(text).toContain(`\`@kimi:${s.sessionId}\` — kimi session "Billing API" in ${s.cwd}`);
    expect(text).not.toContain('device "');
  });
});

describe('syncMentionAgents: what it may touch', () => {
  it('does not rewrite a file whose only change is the age phrase', async () => {
    const d = agentsDir();
    const s = session({ lastActiveAt: Date.now() - 60_000 });
    expect((await syncMentionAgents([s], [], { agentsDir: d })).written).toHaveLength(1);
    expect((await syncMentionAgents([{ ...s, lastActiveAt: Date.now() - 7200_000 }], [], { agentsDir: d })).written).toEqual([]);
    expect((await syncMentionAgents([{ ...s, title: 'Renamed' }], [], { agentsDir: d })).written).toEqual(['morse-kimi-billing-api.md']);
    expect(body('morse-kimi-billing-api.md')).toContain('"Renamed"');
  });

  it('removes its own files that are no longer wanted, old any-*.md ones included, and nothing else', async () => {
    const d = agentsDir();
    const gone = session({ cwd: '/w/gone' });
    await syncMentionAgents([gone], [], { agentsDir: d });
    const oldStyle = 'name: any-codex-x\n---\n\nYou are a delivery proxy for the anytoany session-messaging system. Relay.\n';
    writeFileSync(join(d, 'any-codex-x.md'), oldStyle);
    writeFileSync(join(d, 'any-mine.md'), 'mine');
    writeFileSync(join(d, 'morse-mine.md'), 'mine too');
    writeFileSync(join(d, 'reviewer.md'), 'You are a delivery proxy for the Morse session-messaging system.'); // marker, but not our prefix
    writeFileSync(join(d, 'morse-keep.txt'), 'You are a delivery proxy for the Morse session-messaging system.'); // not .md

    const r = await syncMentionAgents([session()], [], { agentsDir: d });
    expect(r.removed.sort()).toEqual(['any-codex-x.md', 'morse-kimi-gone.md']);
    expect(files()).toEqual(['any-mine.md', 'morse-keep.txt', 'morse-kimi-billing-api.md', 'morse-mine.md', 'reviewer.md']);
  });

  it('leaves a user\'s own file that happens to have the generated name, and does not count it', async () => {
    const d = agentsDir();
    writeFileSync(join(d, 'morse-kimi-billing-api.md'), 'written by hand');
    expect(await syncMentionAgents([session()], [], { agentsDir: d })).toEqual({ written: [], removed: [] });
    expect(body('morse-kimi-billing-api.md')).toBe('written by hand');
  });

  it('creates the agents folder when it does not exist', async () => {
    const parent = agentsDir();
    const nested = join(parent, 'a', 'b');
    await syncMentionAgents([session()], [], { agentsDir: nested });
    expect(existsSync(join(nested, 'morse-kimi-billing-api.md'))).toBe(true);
  });
});
