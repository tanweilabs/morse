import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { syncMentionAgents } from '../src/cluster/sync-agents.js';

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  agent: 'codex',
  sessionId: '019f4823-74af-7510-8daa-bb7cb0450a77',
  title: 'mobile app dev',
  cwd: '/Users/alex/projects/mobile-app',
  lastActiveAt: 1000,
  ...over,
});

let dir: string;
const setup = () => {
  dir = mkdtempSync(join(tmpdir(), 'anytoany-agents-'));
  return dir;
};
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('syncMentionAgents', () => {
  it('materializes non-claude sessions as morse- prefixed agent files with exact ids', async () => {
    const agentsDir = setup();
    const { written } = await syncMentionAgents(
      [s({}), s({ agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001', title: 'x' })],
      [],
      { agentsDir },
    );
    expect(written).toHaveLength(1); // claude sessions are not materialized
    const files = readdirSync(agentsDir);
    expect(files).toEqual(['morse-codex-mobile-app.md']);
    const body = readFileSync(join(agentsDir, files[0]!), 'utf8');
    expect(body).toContain('name: morse-codex-mobile-app');
    expect(body).toContain('@codex:019f4823-74af-7510-8daa-bb7cb0450a77'); // pre-bound exact id
    expect(body).toContain('tools: Bash');
    expect(body).toContain('model: haiku');
    expect(body).toContain('via Morse');
    expect(body).toContain('morse send "@codex:019f4823-74af-7510-8daa-bb7cb0450a77"');
    expect(body).not.toMatch(/anytoany|anyd /);
  });

  it('excludes temp-dir sessions (smoke leftovers) from the mention list', async () => {
    const agentsDir = setup();
    const { written } = await syncMentionAgents(
      [
        s({}),
        s({ sessionId: '019f9999-0000-7000-8000-000000000009', cwd: '/private/tmp/anytoany-smoke.abcd', title: 'smoke' }),
        s({ sessionId: '019f9998-0000-7000-8000-000000000008', cwd: '/tmp/x', title: 'tmp' }),
      ],
      [],
      { agentsDir },
    );
    expect(written).toHaveLength(1);
    expect(readdirSync(agentsDir)).toEqual(['morse-codex-mobile-app.md']);
  });

  it('includes device prefix for remote sessions', async () => {
    const agentsDir = setup();
    await syncMentionAgents([s({ device: 'mini', sessionId: '019f0000-0000-7000-8000-000000000001' })], [], { agentsDir });
    const files = readdirSync(agentsDir);
    expect(files).toEqual(['morse-mini-codex-mobile-app.md']);
    expect(readFileSync(join(agentsDir, files[0]!), 'utf8')).toContain('@mini/codex:019f0000');
  });

  it('caps per agent kind by recency but always keeps conversation partners', async () => {
    const agentsDir = setup();
    const many = Array.from({ length: 12 }, (_, i) =>
      s({ sessionId: `019f00${String(i).padStart(2, '0')}-0000-7000-8000-000000000001`, title: `proj${i}`, cwd: `/w/proj${i}`, lastActiveAt: i }),
    );
    const partner = many[0]!; // oldest — would be cut by the cap
    const { written } = await syncMentionAgents(
      many,
      [{ a: { agent: 'claude', sessionId: 'c1' }, b: { agent: partner.agent, sessionId: partner.sessionId } }],
      { agentsDir, maxPerAgent: 5 },
    );
    expect(written.length).toBe(6); // top 5 + 1 conversation partner
    expect(readdirSync(agentsDir).some((f) => f.includes('proj0'))).toBe(true);
  });

  it('is idempotent, removes its own stale files, never touches user files', async () => {
    const agentsDir = setup();
    writeFileSync(join(agentsDir, 'my-reviewer.md'), 'user file');
    await syncMentionAgents([s({ sessionId: '019f7777-0000-7000-8000-000000000007', cwd: '/w/gone' })], [], { agentsDir });
    expect(readdirSync(agentsDir)).toContain('morse-codex-gone.md');

    const first = await syncMentionAgents([s({})], [], { agentsDir });
    expect(first.removed).toEqual(['morse-codex-gone.md']);
    const second = await syncMentionAgents([s({})], [], { agentsDir });
    expect(second.written).toHaveLength(0); // unchanged content not rewritten
    expect(readFileSync(join(agentsDir, 'my-reviewer.md'), 'utf8')).toBe('user file');
  });

  it('removes the legacy any-*.md files it generated (anytoany signature), and only those', async () => {
    const agentsDir = setup();
    const legacy = `---\nname: any-codex-old\ndescription: Message the codex session "old" (/w/old). Delivers to that exact codex session via anytoany; use when the user @-mentions this agent to relay a message. Active 2d ago.\ntools: Bash\nmodel: haiku\n---\n\nYou are a delivery proxy for the anytoany session-messaging system. Your ONLY job is to relay the user's message to one exact session and report the outcome. Never do anything else.\n`;
    writeFileSync(join(agentsDir, 'any-codex-old.md'), legacy);
    writeFileSync(join(agentsDir, 'any-codex-mobile-app.md'), legacy.replace(/old/g, 'mobile-app'));
    writeFileSync(join(agentsDir, 'any-helper.md'), 'my own agent that happens to start with any-');
    writeFileSync(join(agentsDir, 'morse-notes.md'), 'my own agent that happens to start with morse-');

    const { removed } = await syncMentionAgents([s({})], [], { agentsDir });
    expect(removed.sort()).toEqual(['any-codex-mobile-app.md', 'any-codex-old.md']);
    expect(readdirSync(agentsDir).sort()).toEqual(['any-helper.md', 'morse-codex-mobile-app.md', 'morse-notes.md']);
    expect(readFileSync(join(agentsDir, 'any-helper.md'), 'utf8')).toBe('my own agent that happens to start with any-');
    expect(readFileSync(join(agentsDir, 'morse-notes.md'), 'utf8')).toBe('my own agent that happens to start with morse-');
  });

  it('never overwrites a user file that has the name it would generate', async () => {
    const agentsDir = setup();
    writeFileSync(join(agentsDir, 'morse-codex-mobile-app.md'), 'hand-written');
    const { written, removed } = await syncMentionAgents([s({})], [], { agentsDir });
    expect(written).toEqual([]);
    expect(removed).toEqual([]);
    expect(readFileSync(join(agentsDir, 'morse-codex-mobile-app.md'), 'utf8')).toBe('hand-written');
  });

  it('disambiguates name collisions with an id suffix', async () => {
    const agentsDir = setup();
    await syncMentionAgents(
      [
        s({ sessionId: '019f0001-0000-7000-8000-000000000001' }),
        s({ sessionId: '019f0002-0000-7000-8000-000000000002', lastActiveAt: 2000 }),
      ],
      [],
      { agentsDir },
    );
    const files = readdirSync(agentsDir).sort();
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
  });
});
