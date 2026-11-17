import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { checkOwnerOnly, protectCommandLine, type AclDeps } from './acl.js';
import { autostartStatus } from './autostart.js';
import { HOOK_LAUNCHER, isLauncherCommand, launcherPath, readHookRuns } from './win-hooks.js';
import { envValue, findExecutable } from './which.js';

/**
 * `morse status --check` on Windows (ADR-080). The macOS / Linux checks would raise false
 * alarms there: `which` does not exist, a key file's mode is always 0666, and the agent CLIs
 * are not needed while this release is pull-only. These replace them; the checks that are the
 * same everywhere (mailbox, skill) stay in doctor.ts.
 */
export interface WinCheck {
  name: string;
  ok: boolean;
  note: string;
}

export interface WinDoctorDeps extends AclDeps {
  /** The user's home (where .claude / .codex are). */
  home: string;
  /** The Morse data directory. */
  dataDir: string;
  exists?: (path: string) => boolean;
  now?: () => number;
}

type HookEntry = { command?: unknown; args?: unknown; commandWindows?: unknown };

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};

function hooksIn(file: string): HookEntry[] | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: HookEntry[] }>> };
    return (v.hooks?.['UserPromptSubmit'] ?? []).flatMap((m) => m.hooks ?? []);
  } catch {
    return null;
  }
}

const mentions = (h: HookEntry, name: string): boolean =>
  (Array.isArray(h.args) && h.args.includes(name)) || (typeof h.command === 'string' && h.command.includes(name)) || (typeof h.commandWindows === 'string' && h.commandWindows.includes(name));

export function windowsDoctorChecks(deps: WinDoctorDeps): WinCheck[] {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const now = deps.now ?? Date.now;
  const checks: WinCheck[] = [];

  // the agent CLIs: looked for, never required — nothing is pushed into a session in this release
  const local = envValue(env, 'LOCALAPPDATA');
  const places: Record<string, string[]> = {
    claude: [win32.join(deps.home, '.local', 'bin')],
    codex: local ? [win32.join(local, 'Programs', 'OpenAI', 'Codex', 'bin')] : [],
  };
  for (const cli of ['claude', 'codex']) {
    const found = findExecutable(cli, { platform: 'win32', env, exists, extraDirs: places[cli] ?? [] });
    checks.push({
      name: `${cli} CLI`,
      ok: true,
      note: found
        ? `${found}${/\.(cmd|bat)$/i.test(found) ? ' (an npm shim)' : ''}`
        : `not found on PATH — not needed in this release: a message reaches the agent at its next prompt (the desktop app's own ${cli} is not on PATH)`,
    });
  }
  const sessions = { claude: exists(join(deps.home, '.claude', 'projects')), codex: exists(join(deps.home, '.codex', 'sessions')) };
  const any = sessions.claude || sessions.codex;
  for (const [agent, dir] of [['claude', '~/.claude/projects'], ['codex', '~/.codex/sessions']] as const) {
    checks.push({
      name: `${agent} sessions`,
      ok: sessions[agent] || any,
      note: sessions[agent] ? dir : any ? `${dir} not there — fine if you do not use ${agent === 'claude' ? 'Claude Code' : 'Codex'} here` : `${dir} not there — no Claude Code or Codex session found here yet`,
    });
  }

  // private keys: chmod does nothing on Windows — the ACL is read back every time (the marker file is not trusted here)
  const key = join(deps.dataDir, 'identity', 'key.pem');
  const targets = [deps.dataDir, ...(exists(key) ? [key] : [])];
  const bad: string[] = [];
  const readers = new Set<string>();
  for (const t of targets) {
    const c = checkOwnerOnly(t, deps);
    if (c.error) bad.push(`${t}: ${c.error}`);
    else if (!c.ok) bad.push(`${t} is also open to ${c.others.join(', ')}`);
    for (const r of c.readers ?? []) readers.add(r);
  }
  // the Codex desktop app's sandbox puts its own group on a directory its agent reads: not a failure, but said
  const sandboxNote = readers.size
    ? ` — and readable (not writable) by ${[...readers].join(', ')}: the Codex app added that so its sandboxed agent can read Morse's data, private keys included; that agent cannot write there, so it can read mail but not send or reply until you give that Codex session full access`
    : '';
  checks.push({
    name: 'private keys (Windows access control)',
    ok: bad.length === 0,
    note: bad.length === 0 ? `${deps.dataDir} is open to you, SYSTEM and Administrators only${sandboxNote}` : `${bad.join('; ')} — fix it: ${protectCommandLine(deps.dataDir)}`,
  });

  // the inbox hooks, and whether each has ever run (a hook that does not run fails silently)
  const runs = readHookRuns(deps.dataDir);
  const ran = (name: string): string => (runs[name] ? `last ran ${ago(now() - runs[name]!)}` : 'has not run yet');
  const claude = hooksIn(join(deps.home, '.claude', 'settings.json')) ?? [];
  const claudeOurs = claude.filter((h) => mentions(h, 'claude-prompt-submit'));
  const claudeExec = claudeOurs.some((h) => Array.isArray(h.args) && h.args[h.args.length - 1] === 'claude-prompt-submit' && h.args[h.args.length - 2] === 'hook');
  checks.push({
    name: 'claude inbox hook',
    ok: claudeExec,
    note: claudeExec
      ? `registered (no shell) — ${ran('claude-prompt-submit')}${runs['claude-prompt-submit'] ? '' : ': it runs when you send a prompt in Claude Code; if it still has not after that, your Claude Code may be too old for hooks with "args"'}`
      : claudeOurs.length
        ? 'registered in a form Windows cannot run (a POSIX shell command) — run: morse setup'
        : 'run: morse setup',
  });
  const codex = hooksIn(join(deps.home, '.codex', 'hooks.json')) ?? [];
  const codexOurs = codex.filter((h) => mentions(h, 'codex-prompt-submit'));
  const codexLauncher = codexOurs.some((h) => typeof h.commandWindows === 'string' && isLauncherCommand(h.commandWindows, 'codex-prompt-submit'));
  const launcher = launcherPath(deps.dataDir);
  const launcherThere = exists(launcher);
  checks.push({
    name: 'codex inbox hook',
    ok: codexLauncher && launcherThere,
    note: !codexLauncher
      ? codexOurs.length
        ? 'registered in a form Windows cannot run (a POSIX shell command) — run: morse setup'
        : 'run: morse setup'
      : !launcherThere
        ? `registered, but ${HOOK_LAUNCHER} is missing (${launcher}) — run: morse setup`
        : `registered (${HOOK_LAUNCHER}) — ${ran('codex-prompt-submit')}${runs['codex-prompt-submit'] ? '' : ': Codex runs a hook only after you trust it — open /hooks in Codex (or Settings → Hooks), trust the Morse entry, then send a prompt'}`,
  });

  const auto = autostartStatus({ ...deps, platform: 'win32' }).kind;
  checks.push({
    name: 'daemon at logon',
    ok: auto !== 'none',
    note: auto === 'task' ? 'scheduled task MorseDaemon' : auto === 'run-key' ? 'registry Run value MorseDaemon (the scheduled task was refused when it was set up)' : 'not set up — run: morse autostart enable',
  });
  return checks;
}
