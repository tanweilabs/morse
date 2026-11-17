import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyChanges,
  detectSds,
  installedSdsPort,
  planSdsInstall,
  planSdsUninstall,
  SDS_AGENT,
  removeMarkedBlock,
  resolveSdsPaths,
  upsertMarkedBlock,
} from '../src/integrations/sds.js';
import { externalHeaderPath, externalTokenPath } from '../src/daemon/local-api.js';

/**
 * ADR-024: hooking 闪电说 up means writing three things into ITS data directory.
 * Everything here must be surgical — the user's own skills, skill toggles and
 * AGENTS.md content are not ours to touch.
 */

let appHome: string;
beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'anytoany-sds-'));
  mkdirSync(join(appHome, 'workspace'), { recursive: true });
});

const paths = () => resolveSdsPaths({ appHome });
const install = () => planSdsInstall(paths());

describe('resolveSdsPaths', () => {
  it('defaults the workspace to <appHome>/workspace', () => {
    const p = paths();
    expect(p.workspace).toBe(join(appHome, 'workspace'));
    expect(p.skillFile).toBe(join(appHome, 'workspace', 'library', 'skills', 'anytoany', 'SKILL.md'));
    expect(p.stateFile).toBe(join(appHome, 'skills', 'skills-state.json'));
    expect(p.agentsFile).toBe(join(appHome, 'workspace', 'AGENTS.md'));
  });

  // data_paths.rs:348-368 — the user can relocate the workspace, so the path
  // must never be hardcoded.
  it('honours the workspace-location migration marker', () => {
    const moved = join(appHome, 'elsewhere');
    mkdirSync(join(appHome, 'migrations'), { recursive: true });
    writeFileSync(
      join(appHome, 'migrations', 'workspace-location-v1.json'),
      JSON.stringify({ workspacePath: moved }),
      'utf8',
    );
    expect(resolveSdsPaths({ appHome }).workspace).toBe(moved);
  });

  it('falls back to the default when the marker is unreadable', () => {
    mkdirSync(join(appHome, 'migrations'), { recursive: true });
    writeFileSync(join(appHome, 'migrations', 'workspace-location-v1.json'), '{broken', 'utf8');
    expect(resolveSdsPaths({ appHome }).workspace).toBe(join(appHome, 'workspace'));
  });
});

describe('marked-block helpers (AGENTS.md)', () => {
  it('appends a fenced block to existing content, preserving it verbatim', () => {
    const before = '# 我的习惯\n\n- 用中文回我\n';
    const after = upsertMarkedBlock(before, 'HELLO');
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('<!-- anytoany:begin -->');
    expect(after).toContain('HELLO');
    expect(after).toContain('<!-- anytoany:end -->');
  });

  it('replaces only the block on a second pass (idempotent)', () => {
    const once = upsertMarkedBlock('# 我的习惯\n', 'V1');
    const twice = upsertMarkedBlock(once, 'V2');
    expect(twice).toContain('V2');
    expect(twice).not.toContain('V1');
    expect(twice).toContain('# 我的习惯');
    expect(twice.match(/anytoany:begin/g)).toHaveLength(1);
    expect(upsertMarkedBlock(twice, 'V2')).toBe(twice);
  });

  it('removes only the block, leaving the user content intact', () => {
    const doc = upsertMarkedBlock('# 我的习惯\n\n- 用中文回我\n', 'OURS');
    const cleaned = removeMarkedBlock(doc);
    expect(cleaned).not.toContain('anytoany');
    expect(cleaned).toContain('- 用中文回我');
  });

  it('removing from a document without our block changes nothing', () => {
    const doc = '# 我的习惯\n';
    expect(removeMarkedBlock(doc)).toBe(doc);
  });
});

describe('planSdsInstall — dry run', () => {
  it('plans three changes and writes nothing', () => {
    const p = paths();
    const changes = install();

    expect(changes.map((c) => c.path)).toEqual([p.skillFile, p.stateFile, p.agentsFile]);
    expect(changes.every((c) => c.action === 'create')).toBe(true);
    expect(existsSync(p.skillFile)).toBe(false);
    expect(existsSync(p.stateFile)).toBe(false);
    expect(existsSync(p.agentsFile)).toBe(false);
  });

  it('the planned skill teaches the HTTP calls, not the anyd CLI', () => {
    const skill = install()[0]?.content ?? '';
    expect(skill).toMatch(/^---\nname: anytoany\n/); // frontmatter for the DSH skill loader
    expect(skill).toContain('127.0.0.1:7433/api/inbox');
    expect(skill).toContain('127.0.0.1:7433/api/send');
    expect(skill).toContain('DSH_SESSION_ID');
    expect(skill).not.toMatch(/\banyd (send|pull)\b/); // the sandbox blocks the CLI
  });

  it('(ADR-087) every call carries the app\'s own token — curl reads the header from a file: the token is neither in the instructions nor on a command line', () => {
    const tokenFile = '/home/you/.morse/api-tokens/sds.header';
    const changes = planSdsInstall(paths(), { tokenFile });
    const header = `-H @'${tokenFile}'`;
    const skill = changes[0]?.content ?? '';
    const agents = changes[2]?.content ?? '';
    // each curl of the skill, and the standing one in AGENTS.md
    expect(skill.match(/curl -s/g)).toHaveLength(3);
    expect(skill.split(header)).toHaveLength(4);
    expect(agents.match(/curl -s/g)).toHaveLength(1);
    expect(agents.split(header)).toHaveLength(2);
    for (const text of [skill, agents]) {
      for (const line of text.split('\n').filter((l) => l.includes('curl -s') && l.includes('/api/sessions'))) expect(line).toContain(header);
      expect(text).not.toMatch(/[0-9a-f]{48}/); // (no token in the text)
      expect(text).not.toContain('$(cat'); // (follow-up 2: nothing puts the token on a command line)
    }
    expect(skill).toContain('返回 401');
    expect(skill).toContain('morse connect sds --apply');
    // (follow-up 1) the session list it gets has no directories: the text does not promise any
    expect(skill).not.toContain('`cwd`');
    // the default: this home's header file (MORSE_HOME — a throw-away directory in tests)
    const byDefault = install()[0]?.content ?? '';
    expect(byDefault).toContain(`-H @'${externalHeaderPath(SDS_AGENT)}'`);
    expect(externalHeaderPath(SDS_AGENT).endsWith('/api-tokens/sds.header')).toBe(true);
    // a path with a quote in it stays one shell word
    expect(planSdsInstall(paths(), { tokenFile: "/home/o'brien/.morse/api-tokens/sds.header" })[0]?.content).toContain(`-H @'/home/o'\\''brien/.morse/api-tokens/sds.header'`);
  });

  it('the port an installed skill was written for is read back (a refresh keeps it)', () => {
    expect(installedSdsPort(paths())).toBeNull();
    applyChanges(planSdsInstall(paths(), { port: 7500 }));
    expect(installedSdsPort(paths())).toBe(7500);
  });

  it('reports the app as missing instead of planning writes', () => {
    expect(() => planSdsInstall(resolveSdsPaths({ appHome: join(appHome, 'nope') }))).toThrow(/闪电说|not found/i);
  });
});

describe('applyChanges — install', () => {
  it('writes all three files', () => {
    const p = paths();
    applyChanges(install());

    expect(readFileSync(p.skillFile, 'utf8')).toContain('api/inbox');
    expect(JSON.parse(readFileSync(p.stateFile, 'utf8'))).toHaveProperty('voice_assistant/anytoany');
    expect(readFileSync(p.agentsFile, 'utf8')).toContain('anytoany:begin');
  });

  // storage.rs:253-256 — a user-dropped SKILL.md is DISABLED by default. Without
  // this key the skill silently never loads.
  it('enables the skill in skills-state.json', () => {
    applyChanges(install());
    const state = JSON.parse(readFileSync(paths().stateFile, 'utf8')) as Record<string, { enabled: boolean }>;
    expect(state['voice_assistant/anytoany']?.enabled).toBe(true);
  });

  it('preserves every other key in an existing skills-state.json', () => {
    const p = paths();
    mkdirSync(join(appHome, 'skills'), { recursive: true });
    writeFileSync(
      p.stateFile,
      JSON.stringify({
        'voice_input/自动结构化': { enabled: true, created_at: 0 },
        'voice_assistant/green-tea-reply': { enabled: false, created_at: 7 },
      }),
      'utf8',
    );

    applyChanges(planSdsInstall(p));
    const state = JSON.parse(readFileSync(p.stateFile, 'utf8')) as Record<string, { enabled: boolean; created_at: number }>;
    expect(state['voice_input/自动结构化']).toEqual({ enabled: true, created_at: 0 });
    expect(state['voice_assistant/green-tea-reply']).toEqual({ enabled: false, created_at: 7 });
    expect(state['voice_assistant/anytoany']?.enabled).toBe(true);
  });

  it('preserves the user AGENTS.md content', () => {
    const p = paths();
    writeFileSync(p.agentsFile, '# 我的习惯\n\n- 永远用中文\n', 'utf8');
    applyChanges(planSdsInstall(p));
    const after = readFileSync(p.agentsFile, 'utf8');
    expect(after).toContain('- 永远用中文');
    expect(after).toContain('anytoany:begin');
  });

  it('is idempotent — re-planning after apply reports no changes', () => {
    const p = paths();
    applyChanges(install());
    const second = planSdsInstall(p);
    expect(second.every((c) => c.action === 'unchanged')).toBe(true);

    const before = second.map((c) => readFileSync(c.path, 'utf8'));
    applyChanges(second);
    expect(second.map((c) => readFileSync(c.path, 'utf8'))).toEqual(before);
  });
});

describe('planSdsUninstall', () => {
  it('removes our skill, our state key and our AGENTS.md block — nothing else', () => {
    const p = paths();
    writeFileSync(p.agentsFile, '# 我的习惯\n', 'utf8');
    mkdirSync(join(appHome, 'skills'), { recursive: true });
    writeFileSync(p.stateFile, JSON.stringify({ 'voice_assistant/mine': { enabled: true, created_at: 1 } }), 'utf8');
    applyChanges(planSdsInstall(p));

    applyChanges(planSdsUninstall(p));

    expect(existsSync(p.skillFile)).toBe(false);
    const state = JSON.parse(readFileSync(p.stateFile, 'utf8')) as Record<string, unknown>;
    expect(state['voice_assistant/anytoany']).toBeUndefined();
    expect(state['voice_assistant/mine']).toEqual({ enabled: true, created_at: 1 });
    const agents = readFileSync(p.agentsFile, 'utf8');
    expect(agents).toContain('# 我的习惯');
    expect(agents).not.toContain('anytoany');
  });

  it('is a no-op when nothing was installed', () => {
    const changes = planSdsUninstall(paths());
    expect(changes.every((c) => c.action === 'unchanged')).toBe(true);
    expect(() => applyChanges(changes)).not.toThrow();
  });
});

describe('detectSds — for `anyd setup` discovery and `anyd doctor`', () => {
  it('reports the app as absent when the data dir does not exist', () => {
    const d = detectSds(resolveSdsPaths({ appHome: join(appHome, 'nope') }));
    expect(d).toMatchObject({ appInstalled: false, skillInstalled: false, skillEnabled: false });
  });

  it('reports the app present but not yet connected', () => {
    expect(detectSds(paths())).toMatchObject({
      appInstalled: true,
      skillInstalled: false,
      skillEnabled: false,
    });
  });

  it('reports fully connected after an install', () => {
    applyChanges(install());
    expect(detectSds(paths())).toMatchObject({
      appInstalled: true,
      skillInstalled: true,
      skillEnabled: true,
    });
  });

  // storage.rs:253-256 — the file being present is not enough; the toggle decides
  // whether DSH ever loads it. A user who disabled it in the UI must show as off.
  it('separates "file is there" from "actually enabled"', () => {
    const p = paths();
    applyChanges(install());
    const state = JSON.parse(readFileSync(p.stateFile, 'utf8')) as Record<string, { enabled: boolean }>;
    state['voice_assistant/anytoany'] = { enabled: false, created_at: 1 };
    writeFileSync(p.stateFile, JSON.stringify(state), 'utf8');

    expect(detectSds(p)).toMatchObject({ skillInstalled: true, skillEnabled: false });
  });
});

describe('(ADR-087) `morse setup` brings an earlier install up to date', () => {
  it('instructions written before the token existed are refreshed — same port, the token made, nothing else touched; a home without the app is left alone', async () => {
    const { runSetup } = await import('../src/setup.js');
    const { rmSync } = await import('node:fs');
    const { readExternalToken, removeExternalToken } = await import('../src/daemon/local-api.js');
    const home = mkdtempSync(join(tmpdir(), 'morse-sds-refresh-'));
    try {
      const app = join(home, 'Library', 'Application Support', 'Shandianshuo');
      mkdirSync(join(app, 'workspace'), { recursive: true });
      const p = resolveSdsPaths({ home });
      // what the release before wrote: the same three places, port 7500, no token header
      removeExternalToken(SDS_AGENT);
      applyChanges(planSdsInstall(p, { port: 7500 }));
      const strip = (text: string) => text.replace(/ ?-H @'[^']*'( \\\n {2})?/g, '');
      for (const f of [p.skillFile, p.agentsFile]) writeFileSync(f, strip(readFileSync(f, 'utf8')));
      writeFileSync(p.agentsFile, `# mine\n\nkeep this line\n\n${readFileSync(p.agentsFile, 'utf8')}`);
      expect(readFileSync(p.skillFile, 'utf8')).not.toContain("-H @'");
      const state = readFileSync(p.stateFile, 'utf8');
      expect(readExternalToken(SDS_AGENT)).toBeNull();

      await runSetup({ withHook: false, home });

      const skill = readFileSync(p.skillFile, 'utf8');
      expect(skill).toContain(`-H @'${externalHeaderPath(SDS_AGENT)}'`);
      expect(readFileSync(externalHeaderPath(SDS_AGENT), 'utf8')).toBe(`x-morse-token: ${readExternalToken(SDS_AGENT)}\n`);
      expect(skill).toContain('127.0.0.1:7500/api/inbox');
      expect(skill).not.toContain('127.0.0.1:7433');
      const agents = readFileSync(p.agentsFile, 'utf8');
      expect(agents).toContain("-H @'");
      expect(agents.startsWith('# mine\n\nkeep this line\n')).toBe(true);
      expect(readFileSync(p.stateFile, 'utf8')).toBe(state);
      expect(readExternalToken(SDS_AGENT)).toMatch(/^[0-9a-f]{48}$/);
      // a second run changes nothing
      const before = [skill, agents, readExternalToken(SDS_AGENT)];
      await runSetup({ withHook: false, home });
      expect([readFileSync(p.skillFile, 'utf8'), readFileSync(p.agentsFile, 'utf8'), readExternalToken(SDS_AGENT)]).toEqual(before);

      // what the FIRST ADR-087 release wrote (`$(cat '<token file>')`) is brought up to date too — and its token,
      // which that app may be using right now, stays the same token
      const token = readExternalToken(SDS_AGENT)!;
      const cat = `-H "x-morse-token: $(cat '${externalTokenPath(SDS_AGENT)}')"`;
      for (const f of [p.skillFile, p.agentsFile]) writeFileSync(f, readFileSync(f, 'utf8').split(`-H @'${externalHeaderPath(SDS_AGENT)}'`).join(cat));
      rmSync(externalHeaderPath(SDS_AGENT));
      rmSync(join(externalHeaderPath(SDS_AGENT), '..', 'sds.json'));
      await runSetup({ withHook: false, home });
      expect(readFileSync(p.skillFile, 'utf8')).not.toContain('$(cat');
      expect(readFileSync(p.skillFile, 'utf8')).toContain(`-H @'${externalHeaderPath(SDS_AGENT)}'`);
      expect(readExternalToken(SDS_AGENT)).toBe(token);
      expect(readFileSync(externalTokenPath(SDS_AGENT), 'utf8')).toBe(`${token}\n`); // (the file that release's instructions read is still there, unchanged)
      expect(readFileSync(externalHeaderPath(SDS_AGENT), 'utf8')).toBe(`x-morse-token: ${token}\n`);

      // the app is there but was never connected: nothing is written into it, no token is made
      const bare = mkdtempSync(join(tmpdir(), 'morse-sds-bare-'));
      mkdirSync(join(bare, 'Library', 'Application Support', 'Shandianshuo', 'workspace'), { recursive: true });
      removeExternalToken(SDS_AGENT);
      await runSetup({ withHook: false, home: bare });
      expect(existsSync(resolveSdsPaths({ home: bare }).skillFile)).toBe(false);
      expect(readExternalToken(SDS_AGENT)).toBeNull();
      rmSync(bare, { recursive: true, force: true });
    } finally {
      removeExternalToken(SDS_AGENT);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
