import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_MAX_MEDIA_BYTES, DEFAULT_MEDIA_KEEP_DAYS, DEFAULT_MEDIA_TIMEOUT_MS } from './inbound.js';

/**
 * The iLink plugin's settings: `plugins.ilink` in ~/.morse/config.json (read only — the
 * owner edits it; `morse plugin enable ilink` turns it on). State lives in
 * ~/.morse/plugins/ilink/ (0700, files 0600).
 *
 *   { "plugins": { "ilink": { "enabled": true,
 *       "target": "@claude", "profile": "wechat", // your agent that answers WeChat (required): a
 *                                           // dedicated dispatch profile (ADR-056), or "@claude:<session id>"
 *       "notify_others": false,             // other people's Morse mail: a one-line notice, never content
 *       "sendRoot": "/Users/you/work",      // [[send-file]] only inside here (unset = no files)
 *       "mediaDir": "/Users/you/work/wechat-media", // received attachments (default: <the agent's
 *                                           // cwd>/wechat-media when the launch config names it, else state/media)
 *       "replyTimeoutSec": 660, "maxMediaBytes": 52428800,   // ("port" is no longer used: the morse command
 *                                           // finds this home's daemon by itself — ADR-087)
 *       "mediaTimeoutSec": 120, "mediaKeepDays": 30 } } }
 */

export interface IlinkConfig {
  /** The Morse address messages go to: `@dispatch:<profile>` or `@agent[:session]`. */
  target: string | null;
  /** ADR-056: the dispatch launch profile that answers (its dedicated session). */
  profile: string | null;
  /** The answering agent's working directory, when the launch config names it. */
  agentCwd: string | null;
  /** mediaDir was not set: the default (inside agentCwd when known). */
  mediaDefaulted: boolean;
  notifyOthers: boolean;
  sendRoot: string | null;
  mediaDir: string;
  /** Not used any more (ADR-087 follow-up 2): still read, so that a config that has it is not an error. */
  port: number;
  replyTimeoutMs: number;
  maxMediaBytes: number;
  mediaTimeoutMs: number;
  mediaKeepDays: number;
  stateDir: string;
  morseDir: string;
}

/** MORSE_HOME; compatibility: ANYTOANY_HOME (the old name) is still read, as in src/home.ts. */
export const morseDataDir = (env: NodeJS.ProcessEnv = process.env): string => join(env['MORSE_HOME'] || env['ANYTOANY_HOME'] || homedir(), '.morse');

/** A session of yours on this computer: `@<agent>` or `@<agent>:<session id | title>` — never another device or person. */
export const TARGET_RE = /^@[a-z0-9_-]+(:[^\s/][^/]*)?$/i;

const PROFILE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const positive = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function readIlinkConfig(env: NodeJS.ProcessEnv = process.env): { config: IlinkConfig; errors: string[] } {
  const morseDir = morseDataDir(env);
  const stateDir = join(morseDir, 'plugins', 'ilink');
  let raw: Record<string, unknown> = {};
  const errors: string[] = [];
  try {
    const all = JSON.parse(readFileSync(join(morseDir, 'config.json'), 'utf8')) as { plugins?: { ilink?: Record<string, unknown> } };
    raw = all.plugins?.ilink ?? {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push('config.json is not valid JSON');
  }
  let launch: Array<Record<string, unknown>> = [];
  try {
    const all = JSON.parse(readFileSync(join(morseDir, 'config.json'), 'utf8')) as { plugins?: { dispatch?: { launch?: unknown } } };
    const l = all.plugins?.dispatch?.launch;
    if (Array.isArray(l)) launch = l.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object');
  } catch {
    /* reported above */
  }
  let target = text(raw['target']);
  const profile = text(raw['profile']);
  let agentCwd: string | null = null;
  const cwdOf = (e: Record<string, unknown> | undefined) => (typeof e?.['cwd'] === 'string' && e['cwd'].startsWith('/') ? resolve(e['cwd']) : null);
  if (profile) {
    // ADR-056: "target": "@claude" + "profile": "wechat" = that profile's dedicated session, address @dispatch:wechat
    const ok = PROFILE_RE.test(profile);
    const entry = launch.find((e) => e['name'] === profile && e['dedicated'] === true);
    if (!ok) errors.push(`plugins.ilink.profile "${profile}": not a profile name`);
    else if (!entry) errors.push(`plugins.ilink.profile "${profile}": no launch profile with "name": "${profile}" and "dedicated": true in plugins.dispatch.launch`);
    if (target && !/^@[a-z0-9_-]+$/i.test(target)) errors.push(`plugins.ilink.target "${target}": with "profile", give only the agent (like @claude) — the profile owns the session`);
    else if (target && entry && typeof entry['agent'] === 'string' && target.slice(1).toLowerCase() !== entry['agent']) errors.push(`plugins.ilink.target "${target}": the profile "${profile}" is for @${String(entry['agent'])}`);
    agentCwd = cwdOf(entry);
    target = ok ? `@dispatch:${profile}` : null;
  } else if (target) {
    const agent = /^@([a-z0-9_-]+)/i.exec(target)?.[1]?.toLowerCase();
    const sid = /^@[a-z0-9_-]+:(.+)$/i.exec(target)?.[1];
    const dedicated = agent === 'dispatch' && sid ? launch.find((e) => e['name'] === sid && e['dedicated'] === true) : undefined;
    const named = sid ? launch.find((e) => e['session'] === sid && cwdOf(e)) : undefined;
    const channel = launch.find((e) => e['agent'] === agent && e['from'] === 'ilink' && e['dedicated'] !== true && cwdOf(e));
    agentCwd = cwdOf(dedicated ?? named ?? channel);
  }
  if (target && !TARGET_RE.test(target)) {
    errors.push(`plugins.ilink.target "${target}": must be a session of yours here, like @claude:<session id>`);
    target = null;
  }
  if (target && /^@ilink(:|$)/i.test(target)) {
    errors.push('plugins.ilink.target: not the plugin itself');
    target = null;
  }
  const abs = (key: string) => {
    const v = text(raw[key]);
    if (v && !v.startsWith('/')) {
      errors.push(`plugins.ilink.${key}: must be an absolute path`);
      return null;
    }
    return v ? resolve(v) : null;
  };
  const mediaSet = abs('mediaDir');
  return {
    config: {
      target,
      profile,
      agentCwd,
      mediaDefaulted: !mediaSet,
      notifyOthers: raw['notify_others'] === true,
      sendRoot: abs('sendRoot'),
      // ADR-057: received media must be readable by the answering agent — headless Claude
      // cannot approve a read outside its working directory, so the default is inside it
      mediaDir: mediaSet ?? (agentCwd ? join(agentCwd, 'wechat-media') : join(stateDir, 'media')),
      port: positive(raw['port'], 7433),
      replyTimeoutMs: positive(raw['replyTimeoutSec'], 660) * 1000,
      maxMediaBytes: positive(raw['maxMediaBytes'], DEFAULT_MAX_MEDIA_BYTES),
      mediaTimeoutMs: positive(raw['mediaTimeoutSec'], DEFAULT_MEDIA_TIMEOUT_MS / 1000) * 1000,
      mediaKeepDays: positive(raw['mediaKeepDays'], DEFAULT_MEDIA_KEEP_DAYS),
      stateDir,
      morseDir,
    },
    errors,
  };
}

/** Is `path` inside `dir` (lexically, after resolving)? */
export function isInside(path: string, dir: string): boolean {
  const r = relative(resolve(dir), resolve(path));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}
