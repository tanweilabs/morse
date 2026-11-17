import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRegisteredAdapter } from '../src/adapters/registered.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { resolveTarget } from '../src/directory/resolve.js';
import { listAllSessions } from '../src/directory/scanner.js';
import { register } from '../src/registry/external.js';

// The registered adapter puts ADR-024 external agents into the session directory,
// so they can be addressed like any CLI session — but never delivered to.

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'morse-regadapter-'));
});

const NOW = 50_000;
const adapter = (now = NOW) => createRegisteredAdapter({ home, now: () => now });
const add = (agent: string, sessionId: string, at: number, extra: { title?: string; cwd?: string } = {}) =>
  register({ agent, sessionId, ...extra }, { home, now: () => at });

const codexStub: AgentAdapter = {
  agent: 'codex',
  listSessions: async () => [{ agent: 'codex', sessionId: 'cx-9', title: 'billing service', cwd: '/w/billing', lastActiveAt: 30_000 }],
};

describe('createRegisteredAdapter', () => {
  it('lists each registration as a session; the last check-in is its last activity', async () => {
    add('notes-app', 'n-1', 40_000, { title: 'Notes', cwd: '/w/notes' });
    add('sds', 'sds-main', 45_000, { title: '闪电说助手' });
    expect(await adapter().listSessions()).toEqual([
      { agent: 'sds', sessionId: 'sds-main', title: '闪电说助手', cwd: '', lastActiveAt: 45_000 },
      { agent: 'notes-app', sessionId: 'n-1', title: 'Notes', cwd: '/w/notes', lastActiveAt: 40_000 },
    ]);
  });

  it('nothing registered: nothing listed', async () => {
    expect(await adapter().listSessions()).toEqual([]);
  });

  it('labels itself "external", has no deliver(), and its sessions name no device', async () => {
    add('sds', 'sds-main', NOW);
    const a = adapter();
    expect(a.agent).toBe('external');
    expect(Object.keys(a)).toEqual(['agent', 'listSessions']);
    const [only] = await a.listSessions();
    expect(only && 'device' in only).toBe(false);
  });

  it('a registration not seen for over a week drops out of the listing', async () => {
    add('sds', 'sds-main', 0);
    expect(await adapter(7 * 86_400_000).listSessions()).toHaveLength(1);
    expect(await adapter(7 * 86_400_000 + 1).listSessions()).toEqual([]);
  });
});

describe('in the directory', () => {
  const directory = async (now = NOW) => (await listAllSessions([codexStub, adapter(now)])).sessions;

  it('sits next to the CLI agents, newest first, without scan errors', async () => {
    add('sds', 'sds-main', 45_000, { title: '闪电说助手' });
    const { sessions, errors } = await listAllSessions([codexStub, adapter()]);
    expect(errors).toEqual([]);
    expect(sessions.map((s) => `${s.agent}:${s.sessionId}`)).toEqual(['sds:sds-main', 'codex:cx-9']);
  });

  it('@sds and @sds:<part of its title> resolve to the registered session', async () => {
    add('sds', 'sds-main', 45_000, { title: '闪电说助手' });
    for (const target of ['@sds', '@sds:助手']) {
      const r = resolveTarget(target, await directory());
      expect(r.ok && r.session.sessionId).toBe('sds-main');
    }
  });

  it('a stale registration no longer resolves', async () => {
    add('sds', 'sds-main', 0, { title: '闪电说助手' });
    expect(resolveTarget('@sds', await directory(8 * 86_400_000)).ok).toBe(false);
  });
});
