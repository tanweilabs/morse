import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { parseTarget, resolveTarget, type ResolveResult } from '../src/directory/resolve.js';

/** A session of the directory: an agent, an id, a title, a project directory, a last-activity time. */
const session = (agent: string, sessionId: string, title: string, cwd: string, lastActiveAt: number, device?: string): SessionInfo => ({
  agent,
  sessionId,
  title,
  cwd,
  lastActiveAt,
  ...(device ? { device } : {}),
});

const DIRECTORY: SessionInfo[] = [
  session('claude', '7f00aa01-1111-4111-8111-000000000001', 'Payments API', '/src/payments', 40),
  session('claude', '7f00bb02-2222-4222-8222-000000000002', 'docs rewrite', '/src/handbook', 90),
  session('claude', 'c0ffee03-3333-4333-8333-000000000003', 'release notes', '/src/7f-tools', 10),
  session('codex', '9a9a0004-4444-4444-8444-000000000004', 'Payments UI', '/src/web', 70),
  session('codex', '9b9b0005-5555-4555-8555-000000000005', 'flaky test hunt', '/src/web-e2e', 20),
  session('claude', 'd3d30006-6666-4666-8666-000000000006', 'remote work', '/r/one', 500, 'Studio'),
  session('claude', 'd4d40007-7777-4777-8777-000000000007', 'remote other', '/r/two', 300, 'studio-2'),
];

const idOf = (r: ResolveResult): string | null => (r.ok ? r.session.sessionId.slice(0, 8) : null);
const failure = (r: ResolveResult) => (r.ok ? null : { reason: r.reason, candidates: r.candidates.map((c) => c.sessionId.slice(0, 8)) });

describe('parseTarget: @[device/]agent[:fragment]', () => {
  it('takes the three parts apart, lower-casing the names but not the fragment', () => {
    expect(parseTarget('@Kimi')).toEqual({ agent: 'kimi' });
    expect(parseTarget('@claude:Payments API')).toEqual({ agent: 'claude', fragment: 'Payments API' });
    expect(parseTarget('@Studio/Claude:Remote')).toEqual({ device: 'studio', agent: 'claude', fragment: 'Remote' });
  });

  it('ignores surrounding blanks; the first colon ends the names, so a fragment may hold : and /', () => {
    expect(parseTarget('  @codex  ')).toEqual({ agent: 'codex' });
    expect(parseTarget('@codex:a:b/c')).toEqual({ agent: 'codex', fragment: 'a:b/c' });
    expect(parseTarget('@mac_mini-2/zcode_x:frag')).toEqual({ device: 'mac_mini-2', agent: 'zcode_x', fragment: 'frag' });
  });

  it('refuses what is not of that shape', () => {
    for (const bad of ['', 'claude', '@', '@:frag', '@claude:', '@two words', '@a/b/c', '@dev/', '@/agent', '@dev/:x', '@claude:line\nbreak', '@cla.ude']) {
      expect(parseTarget(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('resolveTarget', () => {
  it('without a fragment: the newest session of that agent on this computer', () => {
    expect(idOf(resolveTarget('@claude', DIRECTORY))).toBe('7f00bb02');
    expect(idOf(resolveTarget('@CODEX', DIRECTORY))).toBe('9a9a0004');
  });

  it('a session id prefix wins over a title or directory match', () => {
    // "7f" is the prefix of two ids, and also part of a directory name: the ids decide — two of them, so ambiguous
    expect(failure(resolveTarget('@claude:7f', DIRECTORY))).toEqual({ reason: 'ambiguous', candidates: ['7f00bb02', '7f00aa01'] });
    expect(idOf(resolveTarget('@claude:7F00AA', DIRECTORY))).toBe('7f00aa01');
  });

  it('then part of the title, then part of the project directory name — case-insensitive', () => {
    expect(idOf(resolveTarget('@claude:PAYMENTS', DIRECTORY))).toBe('7f00aa01');
    expect(idOf(resolveTarget('@claude:handbook', DIRECTORY))).toBe('7f00bb02');
    expect(idOf(resolveTarget('@codex:e2e', DIRECTORY))).toBe('9b9b0005');
    // only the last part of the directory counts
    expect(failure(resolveTarget('@claude:src', DIRECTORY))?.reason).toBe('not_found');
  });

  it('several sessions match: ambiguous, the matches newest first', () => {
    expect(failure(resolveTarget('@codex:web', DIRECTORY))).toEqual({ reason: 'ambiguous', candidates: ['9a9a0004', '9b9b0005'] });
  });

  it('nothing matches: not_found, with every session of that agent here as candidates (newest first)', () => {
    expect(failure(resolveTarget('@codex:nothing-like-it', DIRECTORY))).toEqual({ reason: 'not_found', candidates: ['9a9a0004', '9b9b0005'] });
  });

  it('an agent with no session here: not_found without candidates; bad syntax: invalid_target', () => {
    expect(failure(resolveTarget('@kimi', DIRECTORY))).toEqual({ reason: 'not_found', candidates: [] });
    expect(failure(resolveTarget('kimi', DIRECTORY))).toEqual({ reason: 'invalid_target', candidates: [] });
    expect(failure(resolveTarget('@claude', []))).toEqual({ reason: 'not_found', candidates: [] });
  });

  it('sessions on another device only answer a target naming it (by a case-insensitive prefix)', () => {
    expect(idOf(resolveTarget('@claude:remote', DIRECTORY))).toBeNull();
    expect(idOf(resolveTarget('@studio/claude', DIRECTORY))).toBe('d3d30006');
    expect(failure(resolveTarget('@stu/claude:remote', DIRECTORY))).toEqual({ reason: 'ambiguous', candidates: ['d3d30006', 'd4d40007'] });
    expect(idOf(resolveTarget('@STUDIO-2/claude:remote', DIRECTORY))).toBe('d4d40007');
    expect(failure(resolveTarget('@laptop/claude', DIRECTORY))?.reason).toBe('not_found');
  });

  it('an empty device name counts as this computer', () => {
    const local = session('kimi', 'e5e50008-8888-4888-8888-000000000008', 'k', '/k', 1, undefined);
    expect(idOf(resolveTarget('@kimi', [{ ...local, device: '' }]))).toBe('e5e50008');
  });
});
