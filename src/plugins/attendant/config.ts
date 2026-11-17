import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { checkClaudeLaunch } from '../../adapters/claude.js';
import type { LaunchOptions } from '../../adapters/types.js';

/**
 * The attendant plugin's settings (ADR-059): `plugins.attendant` in ~/.morse/config.json —
 * read only (the owner edits it; `morse plugin enable attendant` turns the plugin on).
 *
 *   { "plugins": { "attendant": { "enabled": true,
 *       "denyPaths": ["/Users/you/private"],          // never reachable, for every profile
 *       "groups": { "colleague": {
 *           "cwd": "/Users/you/work/shared",         // the only directory the agent works in
 *           "tools": ["Read", "Grep", "Glob"],       // available tools (default: these three)
 *           "allowedTools": [], "permissionMode": "dontAsk",
 *           "model": "sonnet", "effort": "medium", "timeoutSec": 600, "maxTurns": 30,
 *           "approval": { "require": ["Bash(git push*)", "WebFetch", "mcp__*"] },
 *           "rateLimit": { "perHour": 6, "perDay": 30 } } },   // optional: no limit by default (ADR-068)
 *       "contacts": { "alice": { "model": "opus" }, "bob": { "enabled": false } },
 *       "defaultProfile": { "model": "sonnet", "rateLimit": { "perDay": 50 } } } } }
 *
 * A group with a profile is answered by your agent, in a session of its own per contact.
 * Every other accepted contact (not you, not blocked) gets the built-in default profile
 * (ADR-066): conversation only — no tools at all, an empty directory of its own — unless
 * `defaultProfile` is false, their group is `{ "enabled": false }`, or they are switched
 * off. Strangers (message requests) never reach a session. Every profile is validated on
 * its own: a bad one is switched off with a log line (that group / contact is then stored
 * only — never the default), the others keep working.
 */

export const ATTENDANT_TOKEN = '[morse-attendant]';

/** Destructive or outward-facing actions that stop for the owner's approval by default. */
export const DEFAULT_APPROVALS = [
  'Bash(rm *)',
  'Bash(rmdir *)',
  'Bash(mv *)',
  'Bash(git push*)',
  'Bash(git reset*)',
  'Bash(git clean*)',
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(rsync *)',
  'Bash(mail *)',
  'Bash(sendmail *)',
  'Bash(osascript *)',
  'Bash(open *)',
  'Bash(morse *)',
  'Bash(gh *)',
  'Bash(npm publish*)',
  'WebFetch',
  'mcp__*',
];

/** Private places no profile ever reaches, relative to the home directory.
 *  `.anytoany` is the data directory of installs from before ADR-035 (compatibility) — as off-limits as `.morse`. */
export const BUILTIN_DENY = ['.ssh', '.gnupg', '.aws', '.morse', '.anytoany', '.claude', '.codex', '.config', '.netrc', '.npmrc', 'Library/Keychains'];

export const DEFAULT_NOTICES = {
  waiting: 'This needs my approval first — my agent will get back to you once I have decided.',
  rejected: 'Sorry, I did not approve that request.',
  footer: 'Automatic reply from my agent.',
  askOwner: 'I will check with my owner and get back to you.',
};

/** ADR-066: the line an agent writes when something needs its owner (never sent to the contact). */
export const ASK_OWNER_MARKER = 'ASK_OWNER:';

export interface AttendantProfile {
  /** Where it came from, for logs: `groups.colleague` or `contacts.alice`. */
  where: string;
  group: string;
  agent: 'claude' | 'codex';
  cwd: string;
  /** Claude: `--tools`, `--permission-mode`, `--allowedTools` … (validated like the dispatch plugin's). */
  tools: string[];
  disallowedTools: string[];
  launch: LaunchOptions & { permissionMode: string };
  maxTurns: number;
  /** Codex (only with allowUnscopedReads): its sandbox. */
  sandbox: 'read-only' | 'workspace-write';
  allowUnscopedReads: boolean;
  approvals: string[];
  denyPaths: string[];
  /** Turns per contact you allow; null = no limit (the default, ADR-068). */
  rate: RateLimit;
  /** Hand an attendant's automatic reply (it carries the marker) to the agent like any other message — default true (ADR-072). */
  answerAttendants: boolean;
  /** Attendant turns per thread (contextId) per 24 h; null = no limit (the default, ADR-072). */
  maxTurnsPerContext: number | null;
  historyMessages: number;
  notices: typeof DEFAULT_NOTICES;
  /** ADR-066: the built-in default — no tools, an empty per-contact directory. */
  conversationOnly?: boolean;
}

/** A per-contact cap on turns (ADR-068): each null = no limit. */
export interface RateLimit {
  perHour: number | null;
  perDay: number | null;
}

/** ADR-068: no rate limit unless the owner sets one. */
export const NO_RATE_LIMIT: RateLimit = { perHour: null, perDay: null };

export interface AttendantSettings {
  /** group label -> its profile (valid ones only). */
  groups: Record<string, AttendantProfile>;
  /** Per-contact overrides, by remark, handle or contact id (lower case). null = switched off. */
  contacts: Record<string, AttendantProfile | null>;
  /** Mail older than this (minutes) is never answered by the default profile (default 60). */
  defaultMaxAgeMin: number;
  /** Groups switched off (`enabled: false`) or with a bad profile: stored only, never the default. */
  offGroups: string[];
  /** ADR-066: the conversation-only profile for accepted contacts nothing else matches (null = store only). */
  defaultProfile: AttendantProfile | null;
  /** Where the default profile's per-contact directories go (~/.morse/plugins/attendant/contacts). */
  contactsDir: string;
  concurrency: number;
  coalesceMs: number;
  maxAgeMin: number;
  /** Tell the owner on WeChat (the ilink plugin) that an approval is waiting. */
  notifyWechat: boolean;
  errors: string[];
}

export interface ConfigContext {
  home: string;
  /** The Morse data directory (~/.morse). */
  morseDir: string;
}

/** MORSE_HOME; compatibility: ANYTOANY_HOME (the old name) is still read, as in src/home.ts. */
export const morseDataDirOf = (env: NodeJS.ProcessEnv = process.env): string => join(env['MORSE_HOME'] || env['ANYTOANY_HOME'] || homedir(), '.morse');

/** Is `path` inside `dir` (or `dir` itself), lexically after resolving? */
export function isInside(path: string, dir: string): boolean {
  const r = relative(resolve(dir), resolve(path));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const TOOL_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RULE_RE = /^[A-Za-z*][A-Za-z0-9_*-]*(\(.+\))?$/;
const posInt = (v: unknown, where: string, def: number, max = 100_000): number => {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw new Error(`"${where}" is a whole number from 1 to ${max}`);
  return v;
};
const strList = (v: unknown, where: string, re: RegExp): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && re.test(x.trim()))) throw new Error(`"${where}" is a list of tool names / rules`);
  return v.map((x: string) => x.trim());
};

/** A path from config: absolute, or `~/…` (the home directory). */
function expand(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  if (!isAbsolute(p)) throw new Error(`"${p}": use an absolute path (or ~/…)`);
  return resolve(p);
}

/** The deny list for a profile: built-ins + the global list + the profile's own, real paths. */
export function denyList(ctx: ConfigContext, extra: string[] = []): string[] {
  const all = [...BUILTIN_DENY.map((d) => join(ctx.home, d)), ctx.morseDir, ...extra.map((p) => expand(p, ctx.home))];
  return [...new Set(all.flatMap((p) => [resolve(p), real(p)]))];
}

/**
 * Throws unless `cwd` is a directory the attendant may work in: not `/`, not the home
 * directory (or above it), not inside a private place, and holding none of them.
 */
export function checkWorkDir(cwd: string, deny: string[], ctx: ConfigContext): string {
  let st;
  try {
    st = statSync(cwd);
  } catch {
    throw new Error(`"cwd" ${cwd}: no such directory`);
  }
  if (!st.isDirectory()) throw new Error(`"cwd" ${cwd}: not a directory`);
  const r = real(cwd);
  const home = real(ctx.home);
  if (r === '/' || isInside(home, r)) throw new Error(`"cwd" ${cwd}: is your home directory (or above it) — give the attendant a project directory of its own`);
  for (const d of deny) {
    if (isInside(r, d)) throw new Error(`"cwd" ${cwd}: is inside a private place (${d})`);
    if (isInside(d, r)) throw new Error(`"cwd" ${cwd}: holds a private place (${d})`);
  }
  return r;
}

const RESERVED_GROUPS = new Set(['self']);

/**
 * `rateLimit` (ADR-068): the owner's own cap per contact. Left out (or one of the two left
 * out) = no limit; `0` = no limit too; otherwise a whole number from 1.
 */
function parseRate(rl: unknown): RateLimit {
  if (rl !== undefined && (typeof rl !== 'object' || rl === null || Array.isArray(rl))) throw new Error('"rateLimit" is { "perHour": n, "perDay": n } (0 or left out = no limit)');
  const rlr = (rl ?? {}) as Record<string, unknown>;
  const one = (k: 'perHour' | 'perDay'): number | null => {
    const v = rlr[k];
    if (v === undefined || v === 0) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100_000) throw new Error(`"rateLimit.${k}" is a whole number from 1 to 100000 (0 or left out = no limit)`);
    return v;
  };
  return { perHour: one('perHour'), perDay: one('perDay') };
}

/** `maxTurnsPerContext` (ADR-072): no limit unless the owner sets one; `0` = no limit too. */
function turnsPerContext(v: unknown): number | null {
  if (v === undefined || v === 0) return null;
  return posInt(v, 'maxTurnsPerContext', 1, 1000);
}

function parseNotices(n: unknown): typeof DEFAULT_NOTICES {
  const notices = { ...DEFAULT_NOTICES };
  if (n === undefined) return notices;
  if (typeof n !== 'object' || n === null) throw new Error('"notices" is { "waiting": "…", "rejected": "…", "footer": "…", "askOwner": "…" }');
  for (const k of Object.keys(DEFAULT_NOTICES) as Array<keyof typeof DEFAULT_NOTICES>) {
    const v = (n as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) throw new Error(`"notices.${k}" is text`);
    notices[k] = v.trim();
  }
  return notices;
}

/** One profile from its raw config (group entry, merged with a contact override). */
export function parseProfile(raw: Record<string, unknown>, where: string, group: string, ctx: ConfigContext, globalDeny: string[] = []): AttendantProfile {
  if (RESERVED_GROUPS.has(group)) throw new Error('group "self" is your own mail — that is the dispatch plugin\'s, never the attendant\'s');
  const agentRaw = raw['agent'] ?? 'claude';
  if (agentRaw !== 'claude' && agentRaw !== 'codex') throw new Error('"agent" is "claude" or "codex"');
  const agent = agentRaw;
  if (raw['allowUnscopedReads'] !== undefined && typeof raw['allowUnscopedReads'] !== 'boolean') throw new Error('"allowUnscopedReads" is true or false');
  const allowUnscopedReads = raw['allowUnscopedReads'] === true;
  if (agent === 'codex' && !allowUnscopedReads)
    throw new Error('"agent": "codex" reads the whole disk in any sandbox — only with "allowUnscopedReads": true (Claude is the default because its reads stay in "cwd")');
  if (typeof raw['cwd'] !== 'string' || !raw['cwd'].trim()) throw new Error('"cwd" (the directory the agent works in) is required');
  const ownDeny = strList(raw['denyPaths'], 'denyPaths', /^[~/].*/) ?? [];
  const denyPaths = denyList(ctx, [...globalDeny, ...ownDeny]);
  const cwd = checkWorkDir(expand(raw['cwd'].trim(), ctx.home), denyPaths, ctx);

  const claudeOnly = ['tools', 'allowedTools', 'disallowedTools', 'permissionMode', 'maxTurns', 'appendSystemPrompt'];
  if (agent === 'codex') for (const k of claudeOnly) if (raw[k] !== undefined) throw new Error(`"${k}" is a Claude setting — Codex has no per-tool permissions (only "sandbox")`);
  if (agent === 'claude' && raw['sandbox'] !== undefined) throw new Error('"sandbox" is a Codex setting');
  const sandboxRaw = raw['sandbox'] ?? 'read-only';
  if (sandboxRaw !== 'read-only' && sandboxRaw !== 'workspace-write') throw new Error('"sandbox" is "read-only" or "workspace-write" (danger-full-access is never allowed)');

  const tools = strList(raw['tools'], 'tools', TOOL_RE) ?? ['Read', 'Grep', 'Glob'];
  const disallowedTools = strList(raw['disallowedTools'], 'disallowedTools', RULE_RE) ?? [];
  const launch: LaunchOptions & { permissionMode: string } = { permissionMode: 'dontAsk' };
  if (raw['permissionMode'] !== undefined) {
    if (typeof raw['permissionMode'] !== 'string') throw new Error('"permissionMode" is text');
    launch.permissionMode = raw['permissionMode'];
  }
  const allowed = strList(raw['allowedTools'], 'allowedTools', /.+/);
  if (allowed) launch.allowedTools = allowed;
  for (const k of ['model', 'effort'] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'string' || !raw[k].trim()) throw new Error(`"${k}" is text`);
    launch[k] = raw[k].trim();
  }
  launch.timeoutMs = posInt(raw['timeoutSec'], 'timeoutSec', 600, 86_400) * 1000;
  if (raw['appendSystemPrompt'] !== undefined) {
    if (typeof raw['appendSystemPrompt'] !== 'string') throw new Error('"appendSystemPrompt" is text');
    if (raw['appendSystemPrompt'].trim()) launch.appendSystemPrompt = raw['appendSystemPrompt'];
  }
  // the dispatch plugin's checks: no bypass-style mode, no bare Bash, real model / effort names
  checkClaudeLaunch(launch);

  const approval = raw['approval'];
  if (approval !== undefined && (typeof approval !== 'object' || approval === null || Array.isArray(approval))) throw new Error('"approval" is { "require": [ … ] }');
  const approvals = strList((approval as Record<string, unknown> | undefined)?.['require'], 'approval.require', RULE_RE) ?? DEFAULT_APPROVALS;

  const rate = parseRate(raw['rateLimit']);
  if (raw['answerAttendants'] !== undefined && typeof raw['answerAttendants'] !== 'boolean') throw new Error('"answerAttendants" is true or false');
  const notices = parseNotices(raw['notices']);
  const known = new Set(['agent', 'cwd', 'tools', 'allowedTools', 'disallowedTools', 'permissionMode', 'model', 'effort', 'timeoutSec', 'maxTurns', 'appendSystemPrompt', 'approval', 'rateLimit', 'denyPaths', 'answerAttendants', 'maxTurnsPerContext', 'historyMessages', 'notices', 'sandbox', 'allowUnscopedReads', 'enabled', 'group']);
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error(`unknown setting "${k}"`);

  return {
    where,
    group,
    agent,
    cwd,
    tools,
    disallowedTools,
    launch,
    maxTurns: posInt(raw['maxTurns'], 'maxTurns', 30, 500),
    sandbox: sandboxRaw,
    allowUnscopedReads,
    approvals,
    denyPaths,
    rate,
    answerAttendants: raw['answerAttendants'] !== false,
    maxTurnsPerContext: turnsPerContext(raw['maxTurnsPerContext']),
    historyMessages: raw['historyMessages'] === 0 ? 0 : posInt(raw['historyMessages'], 'historyMessages', 10, 200),
    notices,
  };
}

/** ADR-066: the default profile's defaults — a fast, inexpensive model; no rate limit unless you set one (ADR-068). */
export const DEFAULT_PROFILE = { model: 'sonnet', timeoutSec: 180, maxTurns: 3, maxAgeMin: 60 };
const DEFAULT_PROFILE_KEYS = new Set(['enabled', 'model', 'effort', 'timeoutSec', 'appendSystemPrompt', 'rateLimit', 'maxTurnsPerContext', 'answerAttendants', 'historyMessages', 'notices', 'maxAgeMin']);

/**
 * The built-in default profile (ADR-066): conversation only. No tools at all (`--tools ""`,
 * no MCP), an empty directory of its own per contact (set at match time), never your files.
 * Only the model, limits and texts can be changed; tools / cwd / permissions belong to a
 * group or contact profile.
 */
export function parseDefaultProfile(raw: Record<string, unknown>, ctx: ConfigContext): { profile: AttendantProfile; maxAgeMin: number } {
  for (const k of Object.keys(raw))
    if (!DEFAULT_PROFILE_KEYS.has(k)) throw new Error(`"${k}" is not a default-profile setting — the default is conversation only (no tools, no directory); give the contact a group profile for that`);
  const launch: LaunchOptions & { permissionMode: string } = { permissionMode: 'dontAsk', model: DEFAULT_PROFILE.model };
  for (const k of ['model', 'effort'] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'string' || !raw[k].trim()) throw new Error(`"${k}" is text`);
    launch[k] = raw[k].trim();
  }
  launch.timeoutMs = posInt(raw['timeoutSec'], 'timeoutSec', DEFAULT_PROFILE.timeoutSec, 86_400) * 1000;
  if (raw['appendSystemPrompt'] !== undefined) {
    if (typeof raw['appendSystemPrompt'] !== 'string') throw new Error('"appendSystemPrompt" is text');
    if (raw['appendSystemPrompt'].trim()) launch.appendSystemPrompt = raw['appendSystemPrompt'];
  }
  checkClaudeLaunch(launch);
  const profile: AttendantProfile = {
    where: 'plugins.attendant.defaultProfile',
    group: '',
    agent: 'claude',
    cwd: '',
    tools: [],
    disallowedTools: [],
    launch,
    maxTurns: DEFAULT_PROFILE.maxTurns,
    sandbox: 'read-only',
    allowUnscopedReads: false,
    approvals: DEFAULT_APPROVALS,
    denyPaths: denyList(ctx),
    rate: parseRate(raw['rateLimit']),
    answerAttendants: raw['answerAttendants'] !== false,
    maxTurnsPerContext: turnsPerContext(raw['maxTurnsPerContext']),
    historyMessages: raw['historyMessages'] === 0 ? 0 : posInt(raw['historyMessages'], 'historyMessages', 10, 200),
    notices: parseNotices(raw['notices']),
    conversationOnly: true,
  };
  return { profile, maxAgeMin: posInt(raw['maxAgeMin'], 'maxAgeMin', DEFAULT_PROFILE.maxAgeMin, 100_000) };
}

/** A contact's own empty directory for the default profile: <contactsDir>/<safe id>-<hash>. */
export function contactDirOf(contactsDir: string, contactId: string): string {
  const safe = contactId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'contact';
  return join(contactsDir, `${safe}-${createHash('sha256').update(contactId).digest('hex').slice(0, 8)}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate the whole `plugins.attendant` object. */
export function parseAttendantConfig(raw: unknown, ctx: ConfigContext): AttendantSettings {
  const out: AttendantSettings = {
    groups: {},
    contacts: {},
    offGroups: [],
    defaultProfile: parseDefaultProfile({}, ctx).profile,
    defaultMaxAgeMin: DEFAULT_PROFILE.maxAgeMin,
    contactsDir: join(ctx.morseDir, 'plugins', 'attendant', 'contacts'),
    concurrency: 2,
    coalesceMs: 3000,
    maxAgeMin: 720,
    notifyWechat: true,
    errors: [],
  };
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) {
    out.errors.push('plugins.attendant must be an object — no profiles');
    out.defaultProfile = null;
    return out;
  }
  const num = (k: string, def: number, max: number) => {
    try {
      return posInt(raw[k], k, def, max);
    } catch (e) {
      out.errors.push(`plugins.attendant.${(e as Error).message} — using ${def}`);
      return def;
    }
  };
  out.concurrency = num('concurrency', 2, 16);
  out.coalesceMs = raw['coalesceSec'] === 0 ? 0 : num('coalesceSec', 3, 600) * 1000;
  out.maxAgeMin = num('maxAgeMin', 720, 100_000);
  if (raw['notifyWechat'] === false) out.notifyWechat = false;
  const dp = raw['defaultProfile'];
  if (dp === false || (isObj(dp) && dp['enabled'] === false)) out.defaultProfile = null;
  else if (dp !== undefined && dp !== true) {
    try {
      if (!isObj(dp)) throw new Error('is false (store only) or { "model": …, "rateLimit": … }');
      const d = parseDefaultProfile(dp, ctx);
      out.defaultProfile = d.profile;
      out.defaultMaxAgeMin = d.maxAgeMin;
    } catch (e) {
      out.errors.push(`plugins.attendant.defaultProfile: ${(e as Error).message} — the default is off (contacts without a profile are stored only)`);
      out.defaultProfile = null;
    }
  }
  let globalDeny: string[] = [];
  try {
    globalDeny = strList(raw['denyPaths'], 'denyPaths', /^[~/].*/) ?? [];
    denyList(ctx, globalDeny);
  } catch (e) {
    out.errors.push(`plugins.attendant.denyPaths: ${(e as Error).message} — every profile is off until it is fixed`);
    out.defaultProfile = null;
    return out;
  }
  const groupsRaw = raw['groups'];
  if (groupsRaw !== undefined && !isObj(groupsRaw)) out.errors.push('plugins.attendant.groups must be an object { "<group>": { … } }');
  const groups = isObj(groupsRaw) ? groupsRaw : {};
  for (const [group, entry] of Object.entries(groups)) {
    const where = `plugins.attendant.groups.${group}`;
    try {
      if (!isObj(entry)) throw new Error('not an object');
      if (entry['enabled'] === false) {
        out.offGroups.push(group);
        continue;
      }
      out.groups[group] = parseProfile(entry, where, group, ctx, globalDeny);
    } catch (e) {
      out.errors.push(`${where}: ${(e as Error).message} — this profile is off (the group is stored only)`);
      out.offGroups.push(group);
    }
  }
  const contactsRaw = raw['contacts'];
  if (contactsRaw !== undefined && !isObj(contactsRaw)) out.errors.push('plugins.attendant.contacts must be an object { "<remark | handle>": { … } }');
  for (const [who, entry] of Object.entries(isObj(contactsRaw) ? contactsRaw : {})) {
    const where = `plugins.attendant.contacts.${who}`;
    const key = who.trim().toLowerCase();
    try {
      if (!isObj(entry)) throw new Error('not an object');
      if (entry['enabled'] === false) {
        out.contacts[key] = null;
        continue;
      }
      // a contact override sits on top of its group's profile (named by "group", or found at match time)
      const group = typeof entry['group'] === 'string' ? entry['group'] : null;
      const base = group && isObj(groups[group]) ? groups[group] : {};
      out.contacts[key] = parseProfile({ ...base, ...entry }, where, group ?? `contact:${key}`, ctx, globalDeny);
    } catch (e) {
      out.errors.push(`${where}: ${(e as Error).message} — this override is off (the contact is stored only)`);
      out.contacts[key] = null;
    }
  }
  return out;
}

export interface ContactRef {
  id: string;
  handle?: string | null;
  remark?: string | null;
  /** ADR-077: the remark of the contact this one was split from. */
  inherits?: string | null;
  /** (ADR-091) how this contact was written in v2 (`handle[/agent]`) — settings written by old name still apply. */
  oldName?: string | null;
  /** (ADR-091 follow-up) more keys from before the upgrade (a remark lost in a merge, the old handle) — looked at last. */
  oldKeys?: string[] | null;
  group?: string;
  self?: boolean;
  /** `blocked` contacts are never answered (ADR-066). */
  state?: string;
}

/**
 * The keys per-contact settings are looked up by, in order: the contact's remark, handle, id; (ADR-077) the remark of
 * the contact it was split from; (ADR-091) its old name; then (follow-up) what it was called before the upgrade — the
 * handle of its old name (`alice` for `alice/air`: settings for the whole old name kept covering it) and the keys the
 * repair kept (a remark lost in a merge). The first that has an entry decides — so an upgrade never makes a
 * contact fall through to a wider group profile.
 */
export function contactKeys(contact: ContactRef): string[] {
  const old = typeof contact.oldName === 'string' && contact.oldName ? contact.oldName.split('/')[0] : null;
  const keys = [contact.remark, contact.handle, contact.id, contact.inherits, contact.oldName, old, ...(contact.oldKeys ?? [])].filter((k): k is string => typeof k === 'string' && Boolean(k.trim())).map((k) => k.trim().toLowerCase());
  return [...new Set(keys)];
}

/**
 * The profile that answers this contact, or null (store only). Never your own mail, never
 * a blocked contact. A contact override wins over the group's profile (it inherits the
 * group named in its own "group" key; without one it stands alone and needs its own
 * "cwd"); then the group's profile; then — for any other accepted contact — the built-in
 * conversation-only default (ADR-066), in an empty directory of the contact's own.
 */
export function profileFor(settings: AttendantSettings, contact: ContactRef | null | undefined): AttendantProfile | null {
  if (!contact || contact.self || contact.id === 'self' || contact.state === 'blocked') return null;
  for (const k of contactKeys(contact)) if (k in settings.contacts) return settings.contacts[k] ?? null;
  if (!contact.group || RESERVED_GROUPS.has(contact.group)) return null;
  if (settings.groups[contact.group]) return settings.groups[contact.group]!;
  if (settings.offGroups.includes(contact.group) || !settings.defaultProfile) return null;
  return { ...settings.defaultProfile, group: contact.group, cwd: contactDirOf(settings.contactsDir, contact.id) };
}

/** Read and validate plugins.attendant from <MORSE_HOME or ~>/.morse/config.json. */
export function readAttendantConfig(env: NodeJS.ProcessEnv = process.env): { settings: AttendantSettings; enabled: boolean; ilinkEnabled: boolean; ctx: ConfigContext } {
  const morseDir = morseDataDirOf(env);
  const ctx: ConfigContext = { home: homedir(), morseDir };
  let all: { plugins?: Record<string, unknown> } = {};
  let bad = false;
  try {
    all = JSON.parse(readFileSync(join(morseDir, 'config.json'), 'utf8')) as typeof all;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') bad = true;
  }
  const raw = all.plugins?.['attendant'];
  const settings = parseAttendantConfig(raw, ctx);
  if (bad) settings.errors.unshift('config.json is not valid JSON — no profiles');
  const entry = isObj(raw) ? raw : {};
  const ilink = all.plugins?.['ilink'];
  // ADR-066: on unless switched off (new installs and upgrades)
  return { settings, enabled: entry['enabled'] !== false, ilinkEnabled: isObj(ilink) && ilink['enabled'] === true, ctx };
}
