import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir as defaultDataDir } from './home.js';
import { claudeExecHook, codexWindowsCommand, isLauncherCommand, launcherPath, launcherScript } from './platform/win-hooks.js';

const require = createRequire(import.meta.url);

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

/** Per-agent skill roots plus the shared Agent Skills dir (Kimi / Z Code read the shared one). */
function skillRoots(home: string): string[] {
  return [join(home, '.claude', 'skills'), join(home, '.codex', 'skills'), join(home, '.agents', 'skills')];
}

function installSkill(home: string): string[] {
  const skillsDir = join(dirname(require.resolve('../package.json')), 'skills');
  const installed: string[] = [];
  for (const root of skillRoots(home)) {
    for (const old of RETIRED_SKILLS) {
      const dir = join(root, old);
      // Only remove a skill dir we shipped (it holds just our SKILL.md).
      if (existsSync(join(dir, 'SKILL.md')) && readdirSync(dir).every((f) => f === 'SKILL.md')) rmSync(dir, { recursive: true, force: true });
    }
    for (const name of SKILLS) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(skillsDir, name, 'SKILL.md'), join(dir, 'SKILL.md'));
      installed.push(dir);
    }
  }
  return installed;
}

interface HookEntry {
  type: string;
  command: string;
  /** Windows (ADR-080): Claude's exec form — `command` is the program, these its arguments, no shell. */
  args?: string[];
  /** Windows (ADR-080): the command Codex runs on Windows instead of `command`. */
  commandWindows?: string;
  /** Seconds the hook may take. Codex gives a hook without one 600 s — ten minutes of a stuck prompt. */
  timeout?: number;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}
interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

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
 * Register the UserPromptSubmit hook in ~/.claude/settings.json.
 * Idempotent; writes a timestamped backup before the first modification.
 */
function installClaudeHook(home: string, entry: HookEntry): 'installed' | 'upgraded' | 'already-installed' {
  const settingsPath = join(home, '.claude', 'settings.json');
  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
  }

  const matchers: HookMatcher[] = settings.hooks?.['UserPromptSubmit'] ?? [];
  const merged = mergeHook(matchers, CLAUDE_HOOK, entry);
  if (merged === 'unchanged') return 'already-installed';

  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak-morse-${Date.now()}`);
  }
  const next: ClaudeSettings = {
    ...settings,
    hooks: {
      ...(settings.hooks ?? {}),
      UserPromptSubmit: merged.matchers,
    },
  };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return merged.how;
}

/**
 * Register the inbox hook in ~/.codex/hooks.json (Codex hooks are
 * format-compatible with Claude's). Idempotent, timestamped backup.
 */
function installCodexHook(home: string, entry: HookEntry, opts: { timeoutOnExisting?: boolean } = {}): 'installed' | 'upgraded' | 'already-installed' {
  const hooksPath = join(home, '.codex', 'hooks.json');
  let config: { hooks?: Record<string, HookMatcher[]>; [k: string]: unknown } = {};
  if (existsSync(hooksPath)) {
    config = JSON.parse(readFileSync(hooksPath, 'utf8')) as typeof config;
  }
  const matchers: HookMatcher[] = config.hooks?.['UserPromptSubmit'] ?? [];
  const merged = mergeHook(matchers, CODEX_HOOK, entry, opts);
  if (merged === 'unchanged') return 'already-installed';

  if (existsSync(hooksPath)) {
    copyFileSync(hooksPath, `${hooksPath}.bak-morse-${Date.now()}`);
  }
  const next = {
    ...config,
    hooks: {
      ...(config.hooks ?? {}),
      UserPromptSubmit: merged.matchers,
    },
  };
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return merged.how;
}

export interface SetupOptions {
  withHook: boolean;
  home?: string;
  /** Test hooks: the node and dist/cli.js the hooks run (default: this process, this package). */
  node?: string;
  cli?: string;
  /** Which platform's hook form to write (default: this one). Windows: ADR-080. */
  platform?: NodeJS.Platform;
  /** The Morse data directory (Windows: where the Codex hook launcher is written). */
  dataDir?: string;
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  const home = opts.home ?? homedir();

  const dirs = installSkill(home);
  console.log('skill installed:');
  for (const d of dirs) console.log(`  ${d}`);

  if (opts.withHook) {
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
  } else {
    console.log('hooks skipped (--no-hook)');
  }

  // Desktop-App agents can't take a skill the way a CLI can — they need their own
  // data directory written to, which we never do behind the user's back. Surface
  // the one command instead; install.sh runs `anyd setup`, so every install sees it.
  const { resolveSdsPaths, detectSds } = await import('./integrations/sds.js');
  const sds = detectSds(resolveSdsPaths({ home }));
  if (sds.appInstalled && !sds.skillEnabled) {
    console.log('\n闪电说 detected — connect its assistant so it can drive your agents:');
    console.log('  morse connect sds            # preview what gets written');
    console.log('  morse connect sds --apply    # write it');
  } else if (sds.skillEnabled) {
    console.log('\n闪电说: connected (morse connect sds --uninstall --apply to remove)');
  }
  // (ADR-087) what an earlier `morse connect sds` wrote calls the local API without a token: bring it up to date —
  // the same files that command wrote with the user's consent, nothing else (the port it was written for is kept)
  if (sds.skillInstalled) {
    try {
      const { planSdsInstall, applyChanges, installedSdsPort, SDS_AGENT } = await import('./integrations/sds.js');
      const { ensureExternalToken } = await import('./daemon/local-api.js');
      const paths = resolveSdsPaths({ home });
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

  console.log('\nnext steps:');
  console.log('  morse start     # run the delivery daemon');
  console.log('  morse list      # see addressable sessions');
}
