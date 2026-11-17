import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { withFileLock } from '../../file-lock.js';
import { type AttendantProfile, type AttendantSettings, type ConfigContext, type ContactRef, DEFAULT_APPROVALS, parseAttendantConfig, profileFor, contactKeys } from './config.js';

/**
 * ADR-070: the attendant's permissions for a contact or a group, set from the command
 * line (`morse contact set <who> --cwd … --tools … --allow … --rate … | --reset`, and
 * `morse contact set --group <g> …` for a whole group) instead of editing
 * ~/.morse/config.json by hand. Only that one entry changes; every other key stays as it
 * was; the result is checked with the plugin's own validation before anything is written,
 * and the file is replaced atomically. `describePermissions` says what actually applies.
 */

export interface PermissionFlags {
  cwd?: string;
  tools?: string;
  allow?: string;
  rate?: string;
  reset?: boolean;
}

export const PERMISSION_FLAGS = ['cwd', 'tools', 'allow', 'rate', 'reset'] as const;
export const hasPermissionFlags = (f: PermissionFlags): boolean => PERMISSION_FLAGS.some((k) => f[k] !== undefined && f[k] !== false);

export type PermissionTarget = { kind: 'contact'; contact: ContactRef & { group: string } } | { kind: 'group'; group: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `a,b(c,d),e` → ['a', 'b(c,d)', 'e'] — commas inside parentheses belong to the rule. */
export function splitList(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** `10/h`, `50/day`, `10/h,50/day` (ADR-068); `none` = no limit (null). */
export function parseRateFlag(raw: string): { perHour?: number; perDay?: number } | null {
  const v = raw.trim().toLowerCase();
  if (v === 'none' || v === '0') return null;
  const out: { perHour?: number; perDay?: number } = {};
  for (const part of splitList(v.replace(/\s+/g, ','))) {
    const m = /^(\d+)\s*\/\s*(h|hr|hour|d|day)$/.exec(part);
    if (!m) throw new Error(`--rate "${raw}": use 10/h, 50/day, 10/h,50/day or none`);
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new Error(`--rate "${raw}": a whole number from 1 to 100000 (none = no limit)`);
    out[m[2]!.startsWith('h') ? 'perHour' : 'perDay'] = n;
  }
  return out;
}

/** The key of this contact's entry under plugins.attendant.contacts: the existing one, else remark, else address. */
export function contactKey(contacts: Obj, c: ContactRef): string {
  const names = [c.remark, c.handle, c.id].filter((k): k is string => typeof k === 'string' && Boolean(k)).map((k) => k.toLowerCase());
  for (const n of names) {
    const hit = Object.keys(contacts).find((k) => k.trim().toLowerCase() === n);
    if (hit !== undefined) return hit;
  }
  return c.remark || c.handle || c.id;
}

/** A group label as the contact store accepts it (mailbox/contacts.ts normalizeGroup — not imported: plugin boundary). */
const groupLabel = (g: string): string => {
  const v = g.trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,31}$/u.test(v)) throw new Error(`group label "${g}": 1–32 letters, digits, space, _ . - (starting with a letter or digit)`);
  return v;
};
const usable = (g: unknown): boolean => isObj(g) && g['enabled'] !== false;
const shortError = (e: string) => e.replace(/ — this (profile|override) is off.*$/, '');

/**
 * Apply the flags to a copy of the whole config (`root` = config.json's object) and check
 * the result: throws (with what is wrong) when the edited entry would not validate.
 */
export function editPermissions(root: Obj, target: PermissionTarget, flags: PermissionFlags, ctx: ConfigContext, cwdBase: string = process.cwd()): { root: Obj; where: string } {
  if (flags.reset && PERMISSION_FLAGS.some((k) => k !== 'reset' && flags[k] !== undefined)) throw new Error('--reset goes alone (it removes the whole entry)');
  const next = structuredClone(root);
  const plugins = isObj(next['plugins']) ? next['plugins'] : (next['plugins'] = {});
  const att = isObj((plugins as Obj)['attendant']) ? ((plugins as Obj)['attendant'] as Obj) : ((plugins as Obj)['attendant'] = {});
  const before = parseAttendantConfig(structuredClone(att), ctx).errors;
  const section = target.kind === 'contact' ? 'contacts' : 'groups';
  if (att[section] !== undefined && !isObj(att[section])) throw new Error(`plugins.attendant.${section} in config.json is not an object — fix it by hand first`);
  const entries = (isObj(att[section]) ? att[section] : (att[section] = {})) as Obj;
  const group = target.kind === 'group' ? groupLabel(target.group) : target.contact.group;
  if (target.kind === 'group' && group === 'self') throw new Error('group "self" is your own mail — the attendant never answers it');
  const key = target.kind === 'contact' ? contactKey(entries, target.contact) : group;
  const where = `plugins.attendant.${section}.${key}`;

  if (flags.reset) {
    if (!(key in entries)) throw new Error(`nothing to reset — ${where} is not set`);
    delete entries[key];
    return { root: next, where };
  }

  const existing = entries[key];
  if (existing !== undefined && !isObj(existing)) throw new Error(`${where} in config.json is not an object — fix it by hand first`);
  const entry: Obj = isObj(existing) ? existing : {};
  const groups = isObj(att['groups']) ? att['groups'] : {};
  // a new contact entry sits on top of its group's profile, when there is one (ADR-059)
  if (target.kind === 'contact' && existing === undefined && group && usable(groups[group])) entry['group'] = group;
  const inherits = target.kind === 'contact' && typeof entry['group'] === 'string' && usable(groups[entry['group']]);

  if (flags.cwd !== undefined) {
    const v = flags.cwd.trim();
    if (!v) throw new Error('--cwd needs a directory');
    entry['cwd'] = v === '~' || v.startsWith('~/') ? v : resolve(cwdBase, v);
  }
  if (flags.tools !== undefined) {
    const v = flags.tools.trim();
    entry['tools'] = v.toLowerCase() === 'none' ? [] : splitList(v);
  }
  if (flags.allow !== undefined) {
    const v = flags.allow.trim();
    if (!v || v.toLowerCase() === 'none') delete entry['allowedTools'];
    else entry['allowedTools'] = splitList(v);
  }
  if (flags.rate !== undefined) {
    const r = parseRateFlag(flags.rate);
    // the contact entry replaces the group's whole rateLimit: 0 lifts an inherited cap
    if (r === null) {
      if (inherits) entry['rateLimit'] = { perHour: 0, perDay: 0 };
      else delete entry['rateLimit'];
    } else entry['rateLimit'] = r;
  }
  if (target.kind === 'contact' && !inherits && entry['cwd'] === undefined)
    throw new Error(
      `${target.contact.remark || target.contact.handle || target.contact.id} has no group profile to build on (group "${group}") — give --cwd <dir> too, or set the group's: morse contact set --group ${group} --cwd <dir> …`,
    );
  if (target.kind === 'group' && entry['cwd'] === undefined && entry['enabled'] !== false) throw new Error(`group "${group}" needs a directory first — give --cwd <dir>`);
  entries[key] = entry;

  const after = parseAttendantConfig(structuredClone(att), ctx).errors;
  const added = after.filter((e) => !before.includes(e)).map(shortError);
  if (added.length) throw new Error(added.join('; '));
  return { root: next, where };
}

/** The indentation config.json already uses (default 2 spaces). */
const indentOf = (text: string): string | number => /\n([ \t]+)"/.exec(text)?.[1] ?? 2;

/**
 * Read config.json, edit it, write it back atomically (a temp file in the same directory,
 * then rename), keeping its mode, indentation and every key the edit did not touch.
 */
export function updateConfigFile<T>(path: string, edit: (root: Obj) => { root: Obj } & T): T {
  // the same lock updateMachineConfig takes: this file is changed by several morse processes
  return withFileLock(path, () => updateConfigFileLocked(path, edit));
}

function updateConfigFileLocked<T>(path: string, edit: (root: Obj) => { root: Obj } & T): T {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let root: unknown = {};
  if (text.trim()) {
    try {
      root = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not valid JSON — fix it by hand first (nothing changed)`);
    }
  }
  if (!isObj(root)) throw new Error(`${path} is not a JSON object — fix it by hand first (nothing changed)`);
  const result = edit(root);
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    /* a new file */
  }
  const tmp = join(dirname(path), `.config.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(result.root, null, indentOf(text))}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  return result;
}

export interface PermissionView {
  /** profile = a group / contact profile; conversation = the built-in default (ADR-066). */
  mode: 'profile' | 'conversation' | 'stored' | 'self' | 'blocked' | 'off';
  source: string | null;
  /** Why it is stored only, or what is wrong with its entry. */
  note: string | null;
  agent?: 'claude' | 'codex';
  cwd?: string;
  tools?: string[];
  allowedTools?: string[];
  approvals?: string[];
  rateLimit?: { perHour: number | null; perDay: number | null };
  model?: string | null;
  sandbox?: string;
  errors: string[];
}

const rate = (r: { perHour: number | null; perDay: number | null }) => [r.perHour !== null ? `${r.perHour}/h` : '', r.perDay !== null ? `${r.perDay}/day` : ''].filter(Boolean).join(' ') || 'no limit';

/** What the attendant actually does with this contact's messages, and with which permissions. */
export function describePermissions(settings: AttendantSettings, contact: ContactRef & { group: string }, enabled: boolean): PermissionView {
  const keys = contactKeys(contact);
  const own = keys.find((k) => k in settings.contacts);
  const errors = settings.errors.filter((e) => (own && e.toLowerCase().startsWith(`plugins.attendant.contacts.${own}:`)) || e.startsWith(`plugins.attendant.groups.${contact.group}:`)).map(shortError);
  const base = { errors, note: null, source: null };
  if (contact.self || contact.id === 'self') return { ...base, mode: 'self', note: 'your own mail — your agents get it (dispatch), never the attendant' };
  if (contact.state === 'blocked') return { ...base, mode: 'blocked', note: 'blocked — their messages are dropped' };
  if (!enabled) return { ...base, mode: 'off', note: 'the attendant plugin is off (morse plugin enable attendant)' };
  const p: AttendantProfile | null = profileFor(settings, contact);
  if (!p) {
    const note = own ? `stored only — plugins.attendant.contacts.${own} is off` : settings.offGroups.includes(contact.group) ? `stored only — group "${contact.group}" is switched off` : 'stored only — no profile, and the conversation-only default is off';
    return { ...base, mode: 'stored', note };
  }
  if (p.conversationOnly) return { ...base, mode: 'conversation', source: p.where, tools: [], rateLimit: p.rate, model: p.launch.model ?? null };
  const onGroup = p.where.startsWith('plugins.attendant.contacts.') && !p.group.startsWith('contact:') ? `plugins.attendant.groups.${p.group}` : null;
  return {
    ...base,
    mode: 'profile',
    source: p.where,
    note: onGroup ? `on top of ${onGroup}` : null,
    agent: p.agent,
    cwd: p.cwd,
    ...(p.agent === 'claude' ? { tools: p.tools, allowedTools: p.launch.allowedTools ?? [] } : { sandbox: p.sandbox }),
    approvals: p.approvals,
    rateLimit: p.rate,
    model: p.launch.model ?? null,
  };
}

/** The same for people: a few lines under the contact. */
export function permissionLines(v: PermissionView): string[] {
  const errs = v.errors.map((e) => `  ! ${e}`);
  switch (v.mode) {
    case 'self':
    case 'blocked':
    case 'off':
    case 'stored':
      return [`attendant: ${v.note}`, ...errs];
    case 'conversation':
      return [`attendant: conversation only (the default) — no tools, no files · model ${v.model ?? 'default'} · rate ${rate(v.rateLimit!)}`, ...errs];
    default: {
      const approvals = v.approvals === DEFAULT_APPROVALS ? `the default list (${DEFAULT_APPROVALS.length} rules: rm, mv, git push, curl, ssh, WebFetch, MCP …)` : v.approvals!.join(', ') || 'nothing';
      return [
        `attendant: ${v.source}${v.note ? ` (${v.note})` : ''}`,
        `  works in: ${v.cwd}${v.agent === 'codex' ? ' (codex)' : ''}`,
        v.agent === 'codex' ? `  sandbox: ${v.sandbox}` : `  tools: ${v.tools!.join(', ') || 'none'}`,
        ...(v.agent === 'codex' ? [] : [`  runs without asking: ${v.allowedTools!.join(', ') || 'none'}`]),
        `  waits for your approval: ${approvals}`,
        `  rate: ${rate(v.rateLimit!)} · model: ${v.model ?? 'default'}`,
        ...errs,
      ];
    }
  }
}
