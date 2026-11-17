import { basename } from 'node:path';
import type { SessionInfo } from '../adapters/types.js';

/** `@[device/]agent[:fragment]`, taken apart. Agent and device are lower-cased; the fragment is kept as typed. */
export interface ParsedTarget {
  device?: string;
  agent: string;
  fragment?: string;
}

/** A target resolved to one session — or why not, with the sessions worth showing instead. */
export type ResolveResult =
  | { ok: true; session: SessionInfo }
  | {
      ok: false;
      reason: 'not_found' | 'ambiguous' | 'invalid_target';
      candidates: SessionInfo[];
    };

/** An agent or device name: letters, digits, `_` and `-`. */
const NAME = /^[A-Za-z0-9_-]+$/;
/** A fragment is anything on one line. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * Parse `@agent`, `@agent:fragment` or `@device/agent:fragment` (surrounding blanks ignored). The first `:`
 * ends the name part, so a fragment may itself hold `:` or `/`. null when it is not of that shape.
 */
export function parseTarget(raw: string): ParsedTarget | null {
  const text = raw.trim();
  if (!text.startsWith('@')) return null;
  const colon = text.indexOf(':');
  const names = colon === -1 ? text.slice(1) : text.slice(1, colon);
  const fragment = colon === -1 ? undefined : text.slice(colon + 1);
  if (fragment !== undefined && (fragment === '' || LINE_BREAK.test(fragment))) return null;

  const slash = names.indexOf('/');
  const device = slash === -1 ? undefined : names.slice(0, slash);
  const agent = slash === -1 ? names : names.slice(slash + 1);
  if (!NAME.test(agent) || (device !== undefined && !NAME.test(device))) return null;

  return {
    agent: agent.toLowerCase(),
    ...(device !== undefined ? { device: device.toLowerCase() } : {}),
    ...(fragment !== undefined ? { fragment } : {}),
  };
}

/** How a fragment is matched, strongest first: the first rule that matches anything decides (all case-insensitive). */
const FRAGMENT_RULES: ReadonlyArray<(session: SessionInfo, fragment: string) => boolean> = [
  (s, f) => s.sessionId.toLowerCase().startsWith(f), // a session id prefix
  (s, f) => s.title.toLowerCase().includes(f), // part of the title
  (s, f) => basename(s.cwd).toLowerCase().includes(f), // part of the project directory's name
];

/**
 * Resolve an @-target against the session directory. Only sessions of that agent count — on this computer
 * when the target names no device, else on the device whose name starts with the one given — newest first.
 * Without a fragment the newest of them is meant.
 */
export function resolveTarget(raw: string, sessions: SessionInfo[]): ResolveResult {
  const target = parseTarget(raw);
  if (!target) return { ok: false, reason: 'invalid_target', candidates: [] };

  const onDevice = (s: SessionInfo): boolean => (target.device === undefined ? s.device === undefined || s.device === '' : (s.device ?? '').toLowerCase().startsWith(target.device));
  const pool = sessions.filter((s) => s.agent === target.agent && onDevice(s)).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const newest = pool[0];
  if (!newest) return { ok: false, reason: 'not_found', candidates: [] };
  if (target.fragment === undefined) return { ok: true, session: newest };

  const fragment = target.fragment.toLowerCase();
  for (const rule of FRAGMENT_RULES) {
    const hits = pool.filter((s) => rule(s, fragment));
    if (hits.length === 1) return { ok: true, session: hits[0]! };
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits };
  }
  return { ok: false, reason: 'not_found', candidates: pool };
}
