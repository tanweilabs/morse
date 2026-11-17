import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { claudeExecHook, codexWindowsCommand, isLauncherCommand, launcherPath, launcherScript, readHookRuns, recordHookRun } from '../src/platform/win-hooks.js';
import { isOurHookEntry, runSetup } from '../src/setup.js';

/**
 * ADR-080: the inbox hooks `morse setup` writes on Windows. The POSIX form (one single-quoted
 * string for /bin/sh) cannot run there. Run here with `platform: 'win32'` against a temp home;
 * whether Claude Code and Codex on a real Windows machine run these entries is on the
 * real-machine checklist (docs/guides/windows.zh-CN.md).
 */

const tmp = mkdtempSync(join(tmpdir(), 'morse-setup-win-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshHome = () => {
  const h = join(tmp, `home-${n++}`);
  mkdirSync(h, { recursive: true });
  return h;
};

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLI = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\anytoany\\dist\\cli.js';

type Entry = { type: string; command: string; args?: string[]; commandWindows?: string; timeout?: number };
const hooksOf = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Entry[] }>> }).hooks['UserPromptSubmit']!;

describe('the pieces', () => {
  it('Claude: the exec form — the program and its arguments separately, no shell, no quoting', () => {
    expect(claudeExecHook(NODE, CLI, 'claude-prompt-submit')).toEqual({ type: 'command', command: NODE, args: [CLI, 'hook', 'claude-prompt-submit'] });
  });

  it('the launcher holds the quoted command; % is doubled; a non-ASCII path switches the code page first', () => {
    expect(launcherScript(NODE, CLI)).toBe(`@echo off\r\nrem Morse hook launcher - written by "morse setup" (rewritten on every setup; do not edit)\r\n"${NODE}" "${CLI}" hook %*\r\n`);
    expect(launcherScript('C:\\100%\\node.exe', CLI)).toContain('"C:\\100%%\\node.exe"');
    expect(launcherScript(NODE, 'C:\\Users\\小美\\cli.js').split('\r\n')[2]).toBe('chcp 65001 >nul');
  });

  it('Codex: `<launcher> <name>` with no quotes at all for an ordinary profile path; quotes and a warning otherwise', () => {
    expect(launcherPath(join(tmp, '.morse'))).toBe(join(tmp, '.morse', 'bin', 'morse-hook.cmd'));
    expect(codexWindowsCommand('C:\\Users\\me\\.morse\\bin\\morse-hook.cmd', 'codex-prompt-submit')).toEqual({ command: 'C:\\Users\\me\\.morse\\bin\\morse-hook.cmd codex-prompt-submit', warnings: [] });
    const spaced = codexWindowsCommand('C:\\Users\\John Smith\\.morse\\bin\\morse-hook.cmd', 'codex-prompt-submit');
    expect(spaced.command).toBe('"C:\\Users\\John Smith\\.morse\\bin\\morse-hook.cmd" codex-prompt-submit');
    expect(spaced.warnings.join(' ')).toMatch(/spaces.*not verified/);
    expect(codexWindowsCommand('C:\\Users\\小美\\.morse\\bin\\morse-hook.cmd', 'x').warnings.join(' ')).toMatch(/non-ASCII.*not verified/);
    // a path that could break out of the command is always quoted
    expect(codexWindowsCommand('C:\\a&b\\morse-hook.cmd', 'x').command.startsWith('"')).toBe(true);
  });

  it('recognises its own entries in every form — and nobody else\'s', () => {
    expect(isLauncherCommand('C:\\Users\\me\\.morse\\bin\\morse-hook.cmd codex-prompt-submit', 'codex-prompt-submit')).toBe(true);
    expect(isLauncherCommand('"C:\\Users\\J S\\.morse\\bin\\morse-hook.cmd" codex-prompt-submit', 'codex-prompt-submit')).toBe(true);
    expect(isLauncherCommand('C:\\other\\hook.cmd codex-prompt-submit', 'codex-prompt-submit')).toBe(false);
    expect(isOurHookEntry(claudeExecHook(NODE, CLI, 'claude-prompt-submit'), 'claude-prompt-submit')).toBe(true);
    expect(isOurHookEntry({ type: 'command', command: NODE, args: ['C:\\x\\other.js', 'hook', 'claude-prompt-submit'] }, 'claude-prompt-submit')).toBe(false);
    expect(isOurHookEntry({ type: 'command', command: NODE, args: [CLI, 'hook', 'codex-prompt-submit'] }, 'claude-prompt-submit')).toBe(false);
    expect(isOurHookEntry({ type: 'command', command: `'/usr/bin/node' '/x/dist/cli.js' hook claude-prompt-submit` }, 'claude-prompt-submit')).toBe(true);
    expect(isOurHookEntry({ type: 'command', command: 'echo done' }, 'claude-prompt-submit')).toBe(false);
  });

  it('a hook run leaves a trace (Windows only), so a hook that never runs can be seen', () => {
    const dir = join(tmp, 'runs');
    expect(readHookRuns(dir)).toEqual({});
    recordHookRun('codex-prompt-submit', dir, 1000);
    recordHookRun('claude-prompt-submit', dir, 2000);
    recordHookRun('codex-prompt-submit', dir, 3000);
    expect(readHookRuns(dir)).toEqual({ 'codex-prompt-submit': 3000, 'claude-prompt-submit': 2000 });
    writeFileSync(join(dir, 'hook-runs.json'), 'not json');
    expect(readHookRuns(dir)).toEqual({});
  });
});

describe('morse setup on Windows (platform injected)', () => {
  const setup = async (home: string, opts: { node?: string; cli?: string; dataDir?: string } = {}) => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lines.push(String(l)));
    try {
      await runSetup({ withHook: true, home, platform: 'win32', node: opts.node ?? NODE, cli: opts.cli ?? CLI, dataDir: opts.dataDir ?? join(home, '.morse') });
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  };

  it('Claude gets the exec form, Codex the launcher in command AND commandWindows; the launcher file is written; a second run changes nothing', async () => {
    const home = freshHome();
    const out = await setup(home);
    const claude = hooksOf(join(home, '.claude', 'settings.json'));
    expect(claude).toEqual([{ hooks: [{ type: 'command', command: NODE, args: [CLI, 'hook', 'claude-prompt-submit'] }] }]);
    const launcher = join(home, '.morse', 'bin', 'morse-hook.cmd');
    const codex = hooksOf(join(home, '.codex', 'hooks.json'));
    expect(codex).toHaveLength(1);
    const entry = codex[0]!.hooks[0]!;
    expect(entry.commandWindows).toMatch(/morse-hook\.cmd"? codex-prompt-submit$/);
    expect(entry.command).toBe(entry.commandWindows);
    expect(entry.timeout).toBe(10);
    expect(entry.commandWindows).toContain(launcher);
    expect(readFileSync(launcher, 'utf8')).toBe(launcherScript(NODE, CLI));
    // Codex runs a new hook only after the user trusted it — said, not left to be found out
    expect(out).toMatch(/Codex.*trust/s);
    const before = [readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')];
    const again = await setup(home);
    expect([readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')]).toEqual(before);
    expect(again).toContain('claude hook already registered');
    expect(again).toContain('codex hook already registered');
  });

  it('an upgrade to another node / package rewrites both entries in place — never a second one; other hooks and settings stay', async () => {
    const home = freshHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
    await setup(home);
    await setup(home, { node: 'C:\\nvm\\v22\\node.exe', cli: 'C:\\other\\prefix\\node_modules\\anytoany\\dist\\cli.js' });
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as { model: string; hooks: Record<string, Array<{ hooks: Entry[] }>> };
    expect(settings.model).toBe('opus');
    expect(settings.hooks['Stop']).toHaveLength(1);
    const all = settings.hooks['UserPromptSubmit']!.flatMap((m) => m.hooks);
    expect(all).toEqual([
      { type: 'command', command: 'echo mine' },
      { type: 'command', command: 'C:\\nvm\\v22\\node.exe', args: ['C:\\other\\prefix\\node_modules\\anytoany\\dist\\cli.js', 'hook', 'claude-prompt-submit'] },
    ]);
    expect(hooksOf(join(home, '.codex', 'hooks.json')).flatMap((m) => m.hooks)).toHaveLength(1);
    expect(readFileSync(join(home, '.morse', 'bin', 'morse-hook.cmd'), 'utf8')).toContain('C:\\nvm\\v22\\node.exe');
  });

  it('a POSIX-form entry of ours (a home shared with WSL, or copied from a Mac) is replaced by the Windows form, not kept beside it', async () => {
    const home = freshHome();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `'/usr/bin/node' '/opt/x/dist/cli.js' hook codex-prompt-submit` }] }] } }));
    await setup(home);
    const all = hooksOf(join(home, '.codex', 'hooks.json')).flatMap((m) => m.hooks);
    expect(all).toHaveLength(1);
    expect(all[0]!.commandWindows).toMatch(/morse-hook\.cmd"? codex-prompt-submit$/);
  });

  it('a profile path with spaces: the entry is written with quotes and setup says it is unverified', async () => {
    const home = freshHome();
    const out = await setup(home, { dataDir: join(home, 'John Smith', '.morse') });
    const entry = hooksOf(join(home, '.codex', 'hooks.json'))[0]!.hooks[0]!;
    expect(entry.commandWindows).toBe(`"${join(home, 'John Smith', '.morse', 'bin', 'morse-hook.cmd')}" codex-prompt-submit`);
    expect(out).toMatch(/spaces.*not verified/);
  });
});

describe('morse setup elsewhere is unchanged', () => {
  it('macOS / Linux: the single-quoted string form, no args, no commandWindows, no launcher', async () => {
    const home = freshHome();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runSetup({ withHook: true, home, platform: 'darwin', node: '/opt/my node/bin/node', cli: '/opt/x/dist/cli.js', dataDir: join(home, '.morse') });
    } finally {
      spy.mockRestore();
    }
    expect(hooksOf(join(home, '.claude', 'settings.json'))).toEqual([{ hooks: [{ type: 'command', command: `'/opt/my node/bin/node' /opt/x/dist/cli.js hook claude-prompt-submit` }] }]);
    expect(hooksOf(join(home, '.codex', 'hooks.json'))).toEqual([{ hooks: [{ type: 'command', command: `'/opt/my node/bin/node' /opt/x/dist/cli.js hook codex-prompt-submit`, timeout: 10 }] }]);
    expect(existsSync(join(home, '.morse', 'bin'))).toBe(false);
  });
});

describe('the Codex hook has a timeout (Codex gives a hook without one 600 s) — without costing anybody their trust', () => {
  const quiet = async (opts: Parameters<typeof runSetup>[0]) => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: unknown) => void lines.push(String(l)));
    try {
      await runSetup(opts);
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  };
  const mac = (home: string, node = '/usr/local/bin/node') => quiet({ withHook: true, home, platform: 'darwin', node, cli: '/opt/x/dist/cli.js', dataDir: join(home, '.morse') });
  const win = (home: string) => quiet({ withHook: true, home, platform: 'win32', node: NODE, cli: CLI, dataDir: join(home, '.morse') });
  const codexFile = (home: string) => join(home, '.codex', 'hooks.json');
  const put = (home: string, entry: Record<string, unknown>) => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(codexFile(home), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [entry] }] } }));
  };

  it('macOS / Linux: an entry that is already right is NOT rewritten for the timeout — Codex trusts a hook by its hash and would silently stop running it', async () => {
    const home = freshHome();
    put(home, { type: 'command', command: '/usr/local/bin/node /opt/x/dist/cli.js hook codex-prompt-submit' });
    const before = readFileSync(codexFile(home), 'utf8');
    expect(await mac(home)).toContain('codex hook already registered');
    expect(readFileSync(codexFile(home), 'utf8')).toBe(before);
  });

  it('macOS / Linux: an entry that is rewritten anyway (another node) gets the timeout; one that has its own keeps it', async () => {
    const home = freshHome();
    put(home, { type: 'command', command: '/old/node /opt/x/dist/cli.js hook codex-prompt-submit' });
    await mac(home);
    expect(hooksOf(codexFile(home))[0]!.hooks[0]).toEqual({ type: 'command', command: '/usr/local/bin/node /opt/x/dist/cli.js hook codex-prompt-submit', timeout: 10 });
    put(home, { type: 'command', command: '/old/node /opt/x/dist/cli.js hook codex-prompt-submit', timeout: 30 });
    await mac(home);
    expect(hooksOf(codexFile(home))[0]!.hooks[0]!.timeout).toBe(30);
  });

  it('Windows: an entry without a timeout gets one (nobody there has trusted an older form); a second run changes nothing', async () => {
    const home = freshHome();
    const launcher = join(home, '.morse', 'bin', 'morse-hook.cmd');
    put(home, { type: 'command', command: `${launcher} codex-prompt-submit`, commandWindows: `${launcher} codex-prompt-submit` });
    expect(await win(home)).toMatch(/codex hook updated/);
    expect(hooksOf(codexFile(home))[0]!.hooks[0]).toEqual({ type: 'command', command: `${launcher} codex-prompt-submit`, commandWindows: `${launcher} codex-prompt-submit`, timeout: 10 });
    const after = readFileSync(codexFile(home), 'utf8');
    expect(await win(home)).toContain('codex hook already registered');
    expect(readFileSync(codexFile(home), 'utf8')).toBe(after);
  });

  it('Claude Code entries are as they were: no timeout is added', async () => {
    const home = freshHome();
    await mac(home);
    expect(hooksOf(join(home, '.claude', 'settings.json'))[0]!.hooks[0]).toEqual({ type: 'command', command: '/usr/local/bin/node /opt/x/dist/cli.js hook claude-prompt-submit' });
  });
});
