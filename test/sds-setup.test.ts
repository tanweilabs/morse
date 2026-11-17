import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { externalHeaderPath, externalTokenPath } from '../src/daemon/local-api.js';
import {
  applyChanges,
  defaultAppHome,
  detectSds,
  installedSdsPort,
  planSdsInstall,
  planSdsUninstall,
  removeMarkedBlock,
  resolveSdsPaths,
  SDS_AGENT,
  sdsSkillMarkdown,
  upsertMarkedBlock,
} from '../src/integrations/sds.js';

// ADR-024: `morse connect sds` writes three things into 闪电说's own data folder —
// the skill, its on-switch, a block in AGENTS.md — and nothing else of the app's.

const OPEN = '<!-- anytoany:begin -->';
const CLOSE = '<!-- anytoany:end -->';
const KEY = 'voice_assistant/anytoany';

let appHome: string;
beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'morse-sds-app-'));
  mkdirSync(join(appHome, 'workspace'), { recursive: true });
});

const paths = () => resolveSdsPaths({ appHome });
const install = () => planSdsInstall(paths());
const read = (file: string) => readFileSync(file, 'utf8');
const json = (file: string) => JSON.parse(read(file)) as Record<string, { enabled: boolean; created_at: number }>;
const writeJson = (file: string, value: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

describe('where things go', () => {
  it('the app folder defaults to ~/Library/Application Support/Shandianshuo', () => {
    expect(defaultAppHome('/Users/me')).toBe('/Users/me/Library/Application Support/Shandianshuo');
    expect(defaultAppHome()).toBe(join(homedir(), 'Library', 'Application Support', 'Shandianshuo'));
    expect(resolveSdsPaths({ home: '/Users/me' }).appHome).toBe('/Users/me/Library/Application Support/Shandianshuo');
  });

  it('skill under <workspace>/library/skills/anytoany, switches in <app>/skills, AGENTS.md in the workspace', () => {
    const ws = join(appHome, 'workspace');
    expect(paths()).toEqual({
      appHome,
      workspace: ws,
      skillDir: join(ws, 'library', 'skills', 'anytoany'),
      skillFile: join(ws, 'library', 'skills', 'anytoany', 'SKILL.md'),
      stateFile: join(appHome, 'skills', 'skills-state.json'),
      agentsFile: join(ws, 'AGENTS.md'),
    });
  });

  it('follows a workspace the user moved (the app\'s migration marker); a broken or empty marker is ignored', () => {
    const marker = join(appHome, 'migrations', 'workspace-location-v1.json');
    writeJson(marker, { workspacePath: '/Volumes/data/sds-ws' });
    expect(paths().workspace).toBe('/Volumes/data/sds-ws');
    expect(paths().agentsFile).toBe('/Volumes/data/sds-ws/AGENTS.md');
    for (const bad of ['{', JSON.stringify({ workspacePath: '' }), JSON.stringify({ workspacePath: 3 }), 'null']) {
      writeFileSync(marker, bad);
      expect(paths().workspace).toBe(join(appHome, 'workspace'));
    }
  });
});

describe('upsertMarkedBlock / removeMarkedBlock', () => {
  it('adds the block after the user\'s text with one blank line between, ending in a newline', () => {
    expect(upsertMarkedBlock('', 'B')).toBe(`${OPEN}\nB\n${CLOSE}\n`);
    expect(upsertMarkedBlock('mine\n', 'B')).toBe(`mine\n\n${OPEN}\nB\n${CLOSE}\n`);
    expect(upsertMarkedBlock('mine', 'B')).toBe(`mine\n\n${OPEN}\nB\n${CLOSE}\n`);
  });

  it('a second pass replaces just the block body, in place', () => {
    const doc = `top\n\n${OPEN}\nold\n${CLOSE}\nbottom\n`;
    expect(upsertMarkedBlock(doc, 'new')).toBe(`top\n\n${OPEN}\nnew\n${CLOSE}\nbottom\n`);
    const once = upsertMarkedBlock('# notes\n', 'same');
    expect(upsertMarkedBlock(once, 'same')).toBe(once);
  });

  it('fences out of order are not a block: the new one is appended', () => {
    const doc = `${CLOSE}\n${OPEN}\n`;
    expect(upsertMarkedBlock(doc, 'B')).toBe(`${doc}\n${OPEN}\nB\n${CLOSE}\n`);
    expect(removeMarkedBlock(doc)).toBe(doc);
  });

  it('removing takes out the block and the blank lines around it, nothing else', () => {
    expect(removeMarkedBlock(`top\n\n\n${OPEN}\nx\n${CLOSE}\n\nbottom\n`)).toBe('top\nbottom\n');
    expect(removeMarkedBlock(upsertMarkedBlock('mine\n', 'x'))).toBe('mine\n');
    expect(removeMarkedBlock(`${OPEN}\nx\n${CLOSE}\n`)).toBe('');
    expect(removeMarkedBlock('just mine\n')).toBe('just mine\n');
  });
});

describe('planSdsInstall', () => {
  it('three planned writes — skill, switch, AGENTS.md — all "create" on a fresh app, nothing written yet', () => {
    const p = paths();
    const plan = install();
    expect(plan.map((c) => [c.path, c.action])).toEqual([
      [p.skillFile, 'create'],
      [p.stateFile, 'create'],
      [p.agentsFile, 'create'],
    ]);
    expect(plan.every((c) => typeof c.note === 'string' && c.note.length > 0)).toBe(true);
    for (const c of plan) expect(existsSync(c.path)).toBe(false);
  });

  it('the skill is a DSH skill named anytoany that teaches the local HTTP API, not the CLI', () => {
    const skill = install()[0]!.content!;
    expect(skill.startsWith('---\nname: anytoany\ndescription: ')).toBe(true);
    expect(skill).toBe(sdsSkillMarkdown());
    for (const call of ['127.0.0.1:7433/api/inbox', '127.0.0.1:7433/api/sessions?q=', '127.0.0.1:7433/api/send']) expect(skill).toContain(call);
    expect(skill).toContain('SID="${DSH_SESSION_ID:-${SHANDIANSHUO_DSH_SESSION_ID:-main}}"');
    expect(skill).toContain(String.raw`-d "{\"agent\":\"sds\",\"sessionId\":\"$SID\",\"register\":true,\"title\":\"闪电说助手\"}"`);
    expect(skill).toContain(String.raw`\"from\":{\"agent\":\"sds\",\"sessionId\":\"$SID\"}`);
    expect(skill).not.toMatch(/\banyd (send|pull|read)\b/);
  });

  it('the port is written into every call, and read back from an installed skill', () => {
    const plan = planSdsInstall(paths(), { port: 7611 });
    expect(plan[0]!.content).not.toContain(':7433/');
    expect(plan[2]!.content).toContain('127.0.0.1:7611/api/inbox');
    expect(installedSdsPort(paths())).toBeNull();
    applyChanges(plan);
    expect(installedSdsPort(paths())).toBe(7611);
  });

  it('turns the switch on, keeping every other switch and the first install\'s date; a new one is stamped in seconds', () => {
    const p = paths();
    writeJson(p.stateFile, { 'voice_input/整理': { enabled: false, created_at: 3 }, [KEY]: { enabled: false, created_at: 99 } });
    const state = planSdsInstall(p, { now: () => 5_000_000 })[1]!.content!;
    expect(state.endsWith('}\n')).toBe(true);
    expect(JSON.parse(state)).toEqual({ 'voice_input/整理': { enabled: false, created_at: 3 }, [KEY]: { enabled: true, created_at: 99 } });

    writeFileSync(p.stateFile, 'garbage');
    expect(JSON.parse(planSdsInstall(p, { now: () => 5_000_999 })[1]!.content!)).toEqual({ [KEY]: { enabled: true, created_at: 5_000 } });
  });

  it('keeps the user\'s AGENTS.md text and adds the standing block', () => {
    const p = paths();
    writeFileSync(p.agentsFile, '# 我的规矩\n\n- 说中文\n');
    const agents = install()[2]!;
    expect(agents.action).toBe('update');
    expect(agents.content!.startsWith('# 我的规矩\n\n- 说中文\n\n' + OPEN + '\n')).toBe(true);
    expect(agents.content!.endsWith(CLOSE + '\n')).toBe(true);
    expect(agents.content).toContain('`anytoany`');
  });

  it('refuses when the app is not installed', () => {
    expect(() => planSdsInstall(resolveSdsPaths({ appHome: join(appHome, 'absent') }))).toThrow(
      `闪电说 not found at ${join(appHome, 'absent')} — install the app first, or pass --app-home`,
    );
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

});

describe('applyChanges', () => {
  it('writes all three, creating folders; then re-planning finds nothing to do and re-applying changes nothing', () => {
    const p = paths();
    applyChanges(install());
    expect(read(p.skillFile)).toBe(sdsSkillMarkdown());
    expect(json(p.stateFile)[KEY]?.enabled).toBe(true);
    expect(read(p.agentsFile)).toContain(OPEN);

    const again = install();
    expect(again.map((c) => c.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    const before = again.map((c) => read(c.path));
    applyChanges(again);
    expect(again.map((c) => read(c.path))).toEqual(before);
  });

  it('a changed skill file is planned as an update', () => {
    const p = paths();
    applyChanges(install());
    writeFileSync(p.skillFile, 'edited by hand');
    expect(install()[0]?.action).toBe('update');
  });
});

describe('planSdsUninstall', () => {
  it('after an install: deletes the skill folder, drops our switch, removes our block — the rest stays', () => {
    const p = paths();
    writeFileSync(p.agentsFile, '# 我的规矩\n');
    writeJson(p.stateFile, { 'voice_assistant/other': { enabled: true, created_at: 2 } });
    applyChanges(install());

    const plan = planSdsUninstall(p);
    expect(plan.map((c) => c.action)).toEqual(['delete', 'update', 'update']);
    applyChanges(plan);

    expect(existsSync(p.skillDir)).toBe(false);
    expect(existsSync(join(p.workspace, 'library', 'skills'))).toBe(true);
    expect(read(p.stateFile)).toBe(`${JSON.stringify({ 'voice_assistant/other': { enabled: true, created_at: 2 } }, null, 2)}\n`);
    expect(read(p.agentsFile)).toBe('# 我的规矩\n');
  });

  it('nothing installed: every entry unchanged, and applying it is harmless', () => {
    const p = paths();
    writeFileSync(p.agentsFile, 'mine\n');
    const plan = planSdsUninstall(p);
    expect(plan.map((c) => [c.path, c.action])).toEqual([
      [p.skillFile, 'unchanged'],
      [p.stateFile, 'unchanged'],
      [p.agentsFile, 'unchanged'],
    ]);
    expect(() => applyChanges(plan)).not.toThrow();
    expect(read(p.agentsFile)).toBe('mine\n');
  });
});

describe('detectSds (morse setup, morse status --check)', () => {
  it('no app; app but no skill; skill switched on; skill there but switched off in the app', () => {
    expect(detectSds(resolveSdsPaths({ appHome: join(appHome, 'absent') }))).toEqual({ appInstalled: false, skillInstalled: false, skillEnabled: false });
    expect(detectSds(paths())).toEqual({ appInstalled: true, skillInstalled: false, skillEnabled: false });
    applyChanges(install());
    expect(detectSds(paths())).toEqual({ appInstalled: true, skillInstalled: true, skillEnabled: true });
    const p = paths();
    writeJson(p.stateFile, { ...json(p.stateFile), [KEY]: { enabled: false, created_at: 1 } });
    expect(detectSds(p)).toEqual({ appInstalled: true, skillInstalled: true, skillEnabled: false });
    writeFileSync(p.stateFile, 'broken');
    expect(detectSds(p).skillEnabled).toBe(false);
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
