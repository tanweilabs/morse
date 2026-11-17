import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir as realHome } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir as defaultDataDir } from './home.js';
import { claudeExecHook, codexWindowsCommand, isLauncherCommand, launcherPath, launcherScript } from './platform/win-hooks.js';

/** The hook sub-commands (`<cli> hook <name>`). */
const CLAUDE_HOOK = 'claude-prompt-submit';
const CODEX_HOOK = 'codex-prompt-submit';
/**
 * The inbox hook reads the mailbox and prints one line; 10 s is generous. Without a `timeout` Codex waits
 * up to 600 s for a hook — a stuck hook would hold the user's prompt for ten minutes.
 */
export const CODEX_HOOK_TIMEOUT_SEC = 10;

/** Shell-quote one argument for a hook command line. */
const shq = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/**
 * ADR-045: hooks run `<this node> <this package's dist/cli.js> hook <name>` with absolute
 * paths — a bare `anyd` is not on the PATH a desktop app gives its hooks (and may be some
 * other `anyd`), and then the hook silently does nothing.
 */
export function hookCommand(name: string, node: string = process.execPath, cli: string = defaultCli()): string {
  return `${shq(node)} ${shq(cli)} hook ${name}`;
}

function defaultCli(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  // dist/setup.js → dist/cli.js; run from src/ (tsx, tests) → the built ../dist/cli.js
  for (const p of [join(dir, 'cli.js'), join(dir, '..', 'dist', 'cli.js')]) {
    try {
      return realpathSync(p);
    } catch {
      /* next */
    }
  }
  return join(dir, 'cli.js');
}

/** One of OUR hook entries — the bare `anyd hook <name>` of older installs, or an absolute one. */
export function isOurHook(command: string, name: string): boolean {
  const c = command.trim();
  if (!c.endsWith(` hook ${name}`)) return false;
  const head = c.slice(0, -` hook ${name}`.length).trim();
  return /(^|[/'"\s])(anyd|morse)['"]?$/.test(head) || /cli\.js['"]?$/.test(head);
}

/**
 * One of OUR hook entries in any form: the string forms above, and the Windows forms
 * (ADR-080) — Claude's exec form (`command` + `args`: `<node>`, [`…cli.js`, `hook`, name]) and
 * the Codex launcher (`…\morse-hook.cmd <name>` in `command` / `commandWindows`).
 */
export function isOurHookEntry(h: { command?: unknown; args?: unknown; commandWindows?: unknown }, name: string): boolean {
  if (Array.isArray(h.args)) {
    const a = h.args as unknown[];
    return a.length >= 3 && a[a.length - 1] === name && a[a.length - 2] === 'hook' && typeof a[a.length - 3] === 'string' && /cli\.js$/.test(a[a.length - 3] as string);
  }
  if (typeof h.commandWindows === 'string' && isLauncherCommand(h.commandWindows, name)) return true;
  return typeof h.command === 'string' && (isOurHook(h.command, name) || isLauncherCommand(h.command, name));
}

/** Skills shipped with Morse; each is copied into every agent's skills dir. */
const SKILLS = ['morse', 'reload'];
/** Skills shipped under an older name — removed on setup so agents don't see two copies. */
const RETIRED_SKILLS = ['any-to-any'];

/** The skills this package ships: the `skills/` folder next to `dist/` (or `src/` in development). */
const SHIPPED_SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));

/**
 * Copy our skills into every place an agent looks for skills — Claude's and Codex's own folders, and the
 * shared Agent Skills folder that Kimi and Z Code read — and drop the copies of retired ones. Returns the
 * skill folders written.
 */
function installSkills(home: string): string[] {
  const written: string[] = [];
  for (const root of ['.claude', '.codex', '.agents'].map((agent) => join(home, agent, 'skills'))) {
    for (const old of RETIRED_SKILLS) {
      const dir = join(root, old);
      // Only remove a skill dir we shipped (it holds just our SKILL.md).
      if (existsSync(join(dir, 'SKILL.md')) && readdirSync(dir).every((f) => f === 'SKILL.md')) rmSync(dir, { recursive: true, force: true });
    }
    for (const skill of SKILLS) {
      const target = join(root, skill);
      mkdirSync(target, { recursive: true });
      copyFileSync(join(SHIPPED_SKILLS, skill, 'SKILL.md'), join(target, 'SKILL.md'));
      written.push(target);
    }
  }
  return written;
}

/** One hook definition, as Claude's settings.json and Codex's hooks.json both write it. */
type HookEntry = {
  type: string;
  command: string;
  /** Windows (ADR-080): Claude's exec form — `command` is the program, these its arguments, no shell. */
  args?: string[];
  /** Windows (ADR-080): the command Codex runs on Windows instead of `command`. */
  commandWindows?: string;
  /** Seconds the hook may take. Codex gives a hook without one 600 s — ten minutes of a stuck prompt. */
  timeout?: number;
};
/** A group of hooks under one event (`matcher` narrows it; ours have none). */
type HookMatcher = { matcher?: string; hooks: HookEntry[] };
/** A hooks file: hooks by event name, every other key kept as it is. */
type HooksFile = { hooks?: Record<string, HookMatcher[]>; [key: string]: unknown };

/**
 * Our hook exactly once, as `entry`: older entries of ours (bare `anyd hook …`, an absolute
 * path to another node / package, another platform's form) are rewritten in place,
 * duplicates dropped, everything else left alone. 'unchanged' = already exactly right.
 */
function mergeHook(matchers: HookMatcher[], name: string, entry: HookEntry, opts: { timeoutOnExisting?: boolean } = {}): 'unchanged' | { matchers: HookMatcher[]; how: 'installed' | 'upgraded' } {
  // `timeout`: a new or rewritten entry gets ours; one that has a timeout keeps its own (the owner may have set
  // it). An entry that is right in everything else but has none is rewritten only with `timeoutOnExisting` —
  // Codex trusts a hook by the hash of its definition and skips a changed one WITHOUT A WORD until it is
  // trusted again, so an existing, trusted entry is not touched for the timeout alone.
  const same = (h: HookEntry): boolean =>
    h.command === entry.command &&
    JSON.stringify(h.args) === JSON.stringify(entry.args) &&
    h.commandWindows === entry.commandWindows &&
    (entry.timeout === undefined || h.timeout !== undefined || !opts.timeoutOnExisting);
  const ours = matchers.flatMap((m) => m.hooks.filter((h) => isOurHookEntry(h, name)));
  if (ours.length === 1 && same(ours[0]!)) return 'unchanged';
  if (ours.length === 0) return { matchers: [...matchers, { hooks: [entry] }], how: 'installed' };
  let kept = false;
  const next = matchers
    .map((m) => ({
      ...m,
      hooks: m.hooks.flatMap((h) => {
        if (!isOurHookEntry(h, name)) return [h];
        if (kept) return [];
        kept = true;
        // the keys we manage are replaced as a set (no `args` left over from another form); anything else on the entry stays
        const { args: _args, commandWindows: _win, ...rest } = h;
        return [{ ...rest, ...entry, ...(h.timeout !== undefined ? { timeout: h.timeout } : {}) }];
      }),
    }))
    .filter((m) => m.hooks.length > 0);
  return { matchers: next, how: 'upgraded' };
}

/**
 * Our UserPromptSubmit hook in a hooks file — Claude's ~/.claude/settings.json or Codex's ~/.codex/hooks.json
 * (the two formats agree). Idempotent; before the file is changed, a timestamped copy of it is kept.
 */
function registerHook(file: string, name: string, entry: HookEntry, opts: { timeoutOnExisting?: boolean } = {}): 'installed' | 'upgraded' | 'already-installed' {
  const existed = existsSync(file);
  const doc: HooksFile = existed ? (JSON.parse(readFileSync(file, 'utf8')) as HooksFile) : {};
  const merged = mergeHook(doc.hooks?.['UserPromptSubmit'] ?? [], name, entry, opts);
  if (merged === 'unchanged') return 'already-installed';
  if (existed) copyFileSync(file, `${file}.bak-morse-${Date.now()}`);
  const updated: HooksFile = { ...doc, hooks: { ...doc.hooks, UserPromptSubmit: merged.matchers } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  return merged.how;
}

const installClaudeHook = (home: string, entry: HookEntry) => registerHook(join(home, '.claude', 'settings.json'), CLAUDE_HOOK, entry);
const installCodexHook = (home: string, entry: HookEntry, opts: { timeoutOnExisting?: boolean } = {}) => registerHook(join(home, '.codex', 'hooks.json'), CODEX_HOOK, entry, opts);

/** `morse setup`: what it installs, and where. */
export type SetupOptions = {
  /** false with --no-hook: only the skills. */
  withHook: boolean;
  /** Whose agents get them (default: the real home — not MORSE_HOME). */
  home?: string;
  /** Test hooks: the node and dist/cli.js the hooks run (default: this process, this package). */
  node?: string;
  cli?: string;
  /** Which platform's hook form to write (default: this one). Windows: ADR-080. */
  platform?: NodeJS.Platform;
  /** The Morse data directory (Windows: where the Codex hook launcher is written). */
  dataDir?: string;
};

/** The inbox hooks of Claude and Codex, in this platform's form; one line said for each. */
function registerHooks(opts: SetupOptions, home: string): void {
  const said = { installed: 'registered', upgraded: 'updated to absolute paths', 'already-installed': 'already registered' } as const;
  if ((opts.platform ?? process.platform) === 'win32') {
    // ADR-080: no POSIX shell on Windows — Claude gets the exec form, Codex a launcher .cmd (see platform/win-hooks.ts)
    const node = opts.node ?? process.execPath;
    const cli = opts.cli ?? defaultCli();
    const result = installClaudeHook(home, claudeExecHook(node, cli, CLAUDE_HOOK));
    console.log(`claude hook ${said[result]}${result === 'already-installed' ? '' : ' in ~/.claude/settings.json (backup saved)'}: ${node} ${cli} hook ${CLAUDE_HOOK} (run without a shell)`);
    const launcher = launcherPath(opts.dataDir ?? defaultDataDir());
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, launcherScript(node, cli), 'utf8');
    const codex = codexWindowsCommand(launcher, CODEX_HOOK);
    // (Windows has no installed base whose trust a rewrite would cost: an entry without a timeout gets one)
    const codexResult = installCodexHook(home, { type: 'command', command: codex.command, commandWindows: codex.command, timeout: CODEX_HOOK_TIMEOUT_SEC }, { timeoutOnExisting: true });
    console.log(`codex hook ${said[codexResult]}${codexResult === 'already-installed' ? '' : ' in ~/.codex/hooks.json (backup saved)'}: ${codex.command}`);
    for (const w of codex.warnings) console.log(`  ⚠ ${w} — check it: morse status --check shows when each hook last ran`);
    if (codexResult !== 'already-installed') console.log('  Codex runs a new or changed hook only after you trust it: in Codex open /hooks (or Settings → Hooks) and trust the Morse entry');
  } else {
    const claudeCmd = hookCommand(CLAUDE_HOOK, opts.node, opts.cli);
    const result = installClaudeHook(home, { type: 'command', command: claudeCmd });
    console.log(`claude hook ${said[result]}${result === 'already-installed' ? '' : ' in ~/.claude/settings.json (backup saved)'}: ${claudeCmd}`);
    const codexCmd = hookCommand(CODEX_HOOK, opts.node, opts.cli);
    const codexResult = installCodexHook(home, { type: 'command', command: codexCmd, timeout: CODEX_HOOK_TIMEOUT_SEC });
    console.log(`codex hook ${said[codexResult]}${codexResult === 'already-installed' ? '' : ' in ~/.codex/hooks.json (backup saved)'}: ${codexCmd}`);
  }
}

/**
 * Desktop-App agents (闪电说). Unlike a CLI they cannot take a skill — their own data directory would have to
 * be written to, and that is never done behind the user's back: the one command to do it is said instead
 * (install.sh runs `anyd setup`, so every install sees it). What an earlier `morse connect sds` wrote, with the
 * user's consent, is brought up to date (ADR-087: calls to the local API carry a token now) — those files only,
 * and the port they were written for is kept.
 */
async function desktopApps(home: string): Promise<void> {
  const { resolveSdsPaths, detectSds, planSdsInstall, applyChanges, installedSdsPort, SDS_AGENT } = await import('./integrations/sds.js');
  const paths = resolveSdsPaths({ home });
  const sds = detectSds(paths);
  if (sds.skillEnabled) console.log('\n闪电说: connected (morse connect sds --uninstall --apply to remove)');
  else if (sds.appInstalled) {
    for (const line of ['\n闪电说 detected — connect its assistant so it can drive your agents:', '  morse connect sds            # preview what gets written', '  morse connect sds --apply    # write it']) console.log(line);
  }
  if (!sds.skillInstalled) return;
  try {
    const { ensureExternalToken } = await import('./daemon/local-api.js');
    ensureExternalToken(SDS_AGENT, undefined, { open: true });
    const port = installedSdsPort(paths);
    const changes = planSdsInstall(paths, port ? { port } : {}).filter((c) => c.path !== paths.stateFile);
    if (changes.some((c) => c.action !== 'unchanged')) {
      applyChanges(changes);
      console.log('闪电说: its Morse instructions were refreshed — calls to the local API now carry a token (ADR-087)');
    }
  } catch (e) {
    console.log(`闪电说: could not refresh its Morse instructions (${e instanceof Error ? e.message : String(e)}) — run: morse connect sds --apply`);
  }
}

/** `morse setup`: the skills, the inbox hooks (unless --no-hook), desktop apps; then what to run next. */
export async function runSetup(opts: SetupOptions): Promise<void> {
  const home = opts.home ?? realHome();
  console.log(['skill installed:', ...installSkills(home).map((dir) => `  ${dir}`)].join('\n'));
  if (opts.withHook) registerHooks(opts, home);
  else console.log('hooks skipped (--no-hook)');
  await desktopApps(home);
  console.log(['', 'next steps:', '  morse start     # run the delivery daemon', '  morse list      # see addressable sessions'].join('\n'));
}
