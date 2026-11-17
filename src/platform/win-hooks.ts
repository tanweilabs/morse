import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The inbox hooks on Windows (ADR-080). The POSIX form — one string, single-quoted, run by
 * /bin/sh — does not work there: PowerShell takes `'C:\…\node.exe' '…'` for a string, cmd.exe
 * does not know single quotes.
 *
 *   Claude Code: the exec form, `command` + `args` — no shell at all.
 *   Codex:       `commandWindows`, run as `cmd.exe /C <command>`. How Codex passes a command
 *                that contains double quotes is not documented, and the default Node path
 *                (C:\Program Files\nodejs) needs them — so the hook is a launcher `.cmd` in the
 *                data directory (which holds the quoted command), and the hook command itself
 *                is `<launcher> <hook name>`: no quotes when the profile path has no spaces.
 *
 * Checked on a real Windows 11 (2026-11-15, docs/guides/windows-test-log.zh-CN.md): both forms
 * run when started the way the two apps are documented to start them (`cmd.exe /C <command>`
 * for the launcher; node with the arguments, no shell, for the exec form). NOT yet seen: the
 * apps themselves running them (Claude Code, the Codex desktop app and its trust step).
 */

export const HOOK_LAUNCHER = 'morse-hook.cmd';

export interface ExecHook {
  type: 'command';
  command: string;
  args: string[];
}

/** Claude Code's exec-form hook: `<node> <cli.js> hook <name>`, no shell. */
export function claudeExecHook(node: string, cli: string, name: string): ExecHook {
  return { type: 'command', command: node, args: [cli, 'hook', name] };
}

/** Where the launcher lives: `<data directory>\bin\morse-hook.cmd`. */
export const launcherPath = (dataDir: string): string => join(dataDir, 'bin', HOOK_LAUNCHER);

/**
 * The launcher: `"<node>" "<cli.js>" hook %*`. `%` is doubled (a batch file expands it); with
 * a non-ASCII path the code page is switched to UTF-8 first, since this file is written as UTF-8.
 */
export function launcherScript(node: string, cli: string): string {
  const q = (p: string): string => `"${p.replace(/%/g, '%%')}"`;
  const nonAscii = /[^\x20-\x7e]/.test(node + cli);
  return ['@echo off', 'rem Morse hook launcher - written by "morse setup" (rewritten on every setup; do not edit)', ...(nonAscii ? ['chcp 65001 >nul'] : []), `${q(node)} ${q(cli)} hook %*`, ''].join('\r\n');
}

/**
 * The Codex hook command for Windows and what is unverified about it. Without spaces or
 * cmd.exe's special characters in the launcher's path the command has no quotes at all —
 * right however Codex hands it to cmd.exe.
 */
export function codexWindowsCommand(launcher: string, name: string): { command: string; warnings: string[] } {
  const warnings: string[] = [];
  const plain = /^[A-Za-z0-9_.:\\/~-]+$/.test(launcher);
  if (!plain) {
    warnings.push(
      /[^\x20-\x7e]/.test(launcher)
        ? `the path of ${HOOK_LAUNCHER} has non-ASCII characters — whether Codex runs such a hook command is not verified`
        : `the path of ${HOOK_LAUNCHER} has spaces or special characters, so the Codex hook command needs quotes — whether Codex passes them to cmd.exe intact is not verified`,
    );
  }
  return { command: plain ? `${launcher} ${name}` : `"${launcher}" ${name}`, warnings };
}

/** Is this hook command ours in the Windows launcher form (`…\morse-hook.cmd <name>`, quoted or not)? */
export function isLauncherCommand(command: string, name: string): boolean {
  const c = command.trim();
  if (!c.endsWith(` ${name}`)) return false;
  return /morse-hook\.cmd"?$/i.test(c.slice(0, -` ${name}`.length).trim());
}

const runsFile = (dataDir: string): string => join(dataDir, 'hook-runs.json');

/** When each hook last ran (Windows only): a hook that never runs fails silently — this makes it visible. */
export function readHookRuns(dataDir: string): Record<string, number> {
  try {
    const v = JSON.parse(readFileSync(runsFile(dataDir), 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number'));
  } catch {
    return {};
  }
}

/** Best effort — a hook must never fail because its trace could not be written. */
export function recordHookRun(name: string, dataDir: string, now: number = Date.now()): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(runsFile(dataDir), `${JSON.stringify({ ...readHookRuns(dataDir), [name]: now })}\n`);
  } catch {
    /* best effort */
  }
}
