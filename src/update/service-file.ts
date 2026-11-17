import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../file-lock.js';
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from './release-key.js';

/**
 * ADR-089 (review N1): the service definition the installer wrote BEFORE it knew that a stop has to wait for
 * an agent turn. launchd sends SIGKILL 5 s after SIGTERM unless the plist says `ExitTimeOut`; systemd signals
 * every process of the unit at once (the agent's turn included) unless the unit says `KillMode=mixed`. The
 * installer writes both now — a computer that was installed earlier gets them here, at a daemon's start.
 *
 * What is touched, and only this: OUR OWN service file — `~/Library/LaunchAgents/talk.morse.daemon.plist`
 * whose Label is ours, or `<systemd user dir>/morse.service` — and only by ADDING the lines that are missing,
 * the same lines the installer writes. Idempotent (a file that has them is not written). The service is NOT
 * restarted or reloaded by this: launchd reads a plist when it loads the job (the next login / reload),
 * systemd is told to re-read its unit files (`daemon-reload` — it restarts nothing).
 */

export const EXIT_TIMEOUT_SEC = 30;
const PLIST_LINE = `  <key>ExitTimeOut</key><integer>${EXIT_TIMEOUT_SEC}</integer>\n`;

/** The plist with `ExitTimeOut` added; null = nothing to do (it has one, or it is not our job's plist). */
export function patchLaunchdPlist(text: string, label: string = LAUNCHD_LABEL): string | null {
  if (!new RegExp(`<key>Label</key>\\s*<string>${label.replace(/\./g, '\\.')}</string>`).test(text)) return null;
  if (/<key>ExitTimeOut<\/key>/.test(text)) return null;
  // where the installer puts it: after ThrottleInterval — else before the end of the top-level dictionary
  const throttle = /^[ \t]*<key>ThrottleInterval<\/key>.*\n/m.exec(text);
  if (throttle) return text.slice(0, throttle.index + throttle[0].length) + PLIST_LINE + text.slice(throttle.index + throttle[0].length);
  const end = text.lastIndexOf('</dict>');
  return end === -1 ? null : text.slice(0, end) + PLIST_LINE + text.slice(end);
}

/** The unit with `KillMode=mixed` / `TimeoutStopSec` added to [Service] where missing; null = nothing to do. */
export function patchSystemdUnit(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '[Service]');
  if (start === -1 || !lines.some((l) => /^ExecStart=.*\bstart\b/.test(l.trim()))) return null; // not a unit of ours
  let end = lines.findIndex((l, i) => i > start && /^\[.+\]$/.test(l.trim()));
  if (end === -1) end = lines.length;
  const service = lines.slice(start + 1, end);
  const has = (key: string) => service.some((l) => l.trim().startsWith(`${key}=`));
  const add = [...(has('KillMode') ? [] : ['KillMode=mixed']), ...(has('TimeoutStopSec') ? [] : [`TimeoutStopSec=${EXIT_TIMEOUT_SEC}`])];
  if (!add.length) return null;
  // after the last setting of the section (before the blank line that ends it)
  let at = end;
  while (at > start + 1 && lines[at - 1]!.trim() === '') at--;
  return [...lines.slice(0, at), ...add, ...lines.slice(at)].join('\n');
}

export interface ServiceFileOptions {
  platform?: NodeJS.Platform;
  /** The user's home (default: os.homedir()). */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Told to re-read unit files after a unit was rewritten (default: `systemctl --user daemon-reload`). */
  reload?: () => void;
}

export type ServiceFileOutcome = { outcome: 'patched' | 'ok' | 'absent' | 'not-ours' | 'error'; file: string | null; detail?: string };

/** Where this platform's service file of ours is (null: none on this platform). */
export function serviceFilePath(opts: ServiceFileOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  if (platform === 'linux') return join((opts.env ?? process.env)['XDG_CONFIG_HOME'] || join(home, '.config'), 'systemd', 'user', SYSTEMD_UNIT);
  return null;
}

/** Add what is missing to our own service file. Never throws; never restarts anything. */
export function ensureServiceFileTimeouts(opts: ServiceFileOptions = {}): ServiceFileOutcome {
  const platform = opts.platform ?? process.platform;
  const file = serviceFilePath(opts);
  if (!file) return { outcome: 'absent', file: null };
  try {
    if (!existsSync(file)) return { outcome: 'absent', file };
    const before = readFileSync(file, 'utf8');
    const after = platform === 'darwin' ? patchLaunchdPlist(before) : patchSystemdUnit(before);
    if (after === null) {
      const ours = platform === 'darwin' ? before.includes(`<string>${LAUNCHD_LABEL}</string>`) : before.includes('[Service]');
      return { outcome: ours ? 'ok' : 'not-ours', file };
    }
    writeFileAtomic(file, after, { mode: statSync(file).mode & 0o777 });
    if (platform === 'linux') {
      try {
        opts.reload?.();
      } catch {
        /* systemd reads it at the next daemon-reload / login */
      }
    }
    return { outcome: 'patched', file };
  } catch (e) {
    return { outcome: 'error', file, detail: e instanceof Error ? e.message : String(e) };
  }
}
