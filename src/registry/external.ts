import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { dataDir, morseHome } from '../home.js';

// Registered ("external") agents — ADR-024.
//
// An app-embedded assistant (闪电说 / `sds` first) has no CLI Morse could
// resume a turn into. It announces itself instead: one JSON file per
// agent+session under <data dir>/registered/, written by the daemon on its
// behalf. That makes it addressable like any other session, while its mail is
// only ever pulled by the app itself — the dispatcher leaves it pending.

export interface ExternalSession {
  agent: string;
  sessionId: string;
  title: string;
  cwd: string;
  /** When this agent+session first registered (epoch ms); survives later registrations. */
  registeredAt: number;
  /** When it last registered or checked in (epoch ms). */
  lastSeenAt: number;
}

export interface RegisterInput {
  agent: string;
  sessionId: string;
  title?: string;
  cwd?: string;
}

interface StoreOpts {
  home?: string;
  now?: () => number;
}

/** Names an external agent may not take: `user` is the human's inbox sink, the
 *  others are agents Morse already delivers to itself. */
export const RESERVED_AGENT_NAMES = ['user', 'claude', 'codex', 'kimi', 'zcode'] as const;

/** How long a registration stays visible without a check-in: one week. */
const VISIBLE_FOR_MS = 604_800_000;

/** Characters allowed verbatim in a registry file name; anything else becomes `_`. */
const fileSafe = (part: string): string => part.replace(/[^A-Za-z0-9._-]/g, '_');

const registryFolder = (home: string): string => join(dataDir(home), 'registered');

const registryFile = (home: string, agent: string, sessionId: string): string =>
  join(registryFolder(home), `${fileSafe(agent)}-${fileSafe(sessionId)}.json`);

/** Why this registration is refused, or null when it is acceptable. */
function refusal({ agent, sessionId }: RegisterInput): string | null {
  const reserved: readonly string[] = RESERVED_AGENT_NAMES;
  if (reserved.includes(agent)) {
    return `agent name "${agent}" is reserved (${reserved.join(', ')}) — pick another name`;
  }
  const wellFormed = /^[a-z][a-z0-9-]+$/.test(agent) && agent.length >= 2 && agent.length <= 32;
  if (!wellFormed) {
    return `invalid agent name "${agent}" — use lowercase letters, digits and dashes, 2-32 chars, starting with a letter`;
  }
  if ((sessionId ?? '').trim() === '') return 'a session id is required to register an external agent session';
  return null;
}

/** Turn a file's text into a session; anything unusable (bad JSON, missing ids) gives null. */
function decode(text: string): ExternalSession | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  const { agent, sessionId } = data;
  if (typeof agent !== 'string' || typeof sessionId !== 'string') return null;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  const time = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    agent,
    sessionId,
    title: str(data.title, agent),
    cwd: str(data.cwd, ''),
    registeredAt: time(data.registeredAt),
    lastSeenAt: time(data.lastSeenAt),
  };
}

/** The stored session at `file`, or null when it is absent, not a file, or unreadable. */
function load(file: string): ExternalSession | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // missing, a directory, or not permitted — none of them is an entry
    return null;
  }
  return decode(text);
}

/**
 * Record (or refresh) an external agent session. Calling it again for the same
 * agent+session updates it in place: `registeredAt` stays, `lastSeenAt` moves,
 * and a title/cwd left out of this call keeps the stored one — the per-turn
 * check-in an app sends is often just `{agent, sessionId}`.
 */
export function register(input: RegisterInput, opts: StoreOpts = {}): ExternalSession {
  const problem = refusal(input);
  if (problem) throw new Error(problem);
  const file = registryFile(opts.home ?? morseHome(), input.agent, input.sessionId);
  const at = (opts.now ?? Date.now)();
  // the daemon and `morse connect` can both write here: lock around read+write,
  // and replace the file atomically so a concurrent listing never sees half of it
  return withFileLock(file, () => {
    const prior = load(file);
    const { agent, sessionId } = input;
    const next: ExternalSession = {
      agent,
      sessionId,
      title: input.title?.trim() || prior?.title || input.agent,
      cwd: input.cwd ?? prior?.cwd ?? '',
      registeredAt: prior ? prior.registeredAt : at,
      lastSeenAt: at,
    };
    writeFileAtomic(file, JSON.stringify(next, null, 2));
    return next;
  });
}

/** Drop a registration. Removing one that is not there is fine. */
export function unregister(agent: string, sessionId: string, opts: { home?: string } = {}): void {
  try {
    rmSync(registryFile(opts.home ?? morseHome(), agent, sessionId), { force: true });
  } catch {
    // nothing to remove
  }
}

/**
 * Every registration, newest check-in first. Ones not seen for `ttlMs` (default a
 * week) are left out unless `includeStale` — but their files stay, so the same
 * agent+session registering again comes back with its original `registeredAt`.
 */
export function listRegistered(opts: StoreOpts & { ttlMs?: number; includeStale?: boolean } = {}): ExternalSession[] {
  const folder = registryFolder(opts.home ?? morseHome());
  let files: string[];
  try {
    files = readdirSync(folder).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const cutoff = (opts.now ?? Date.now)() - (opts.ttlMs ?? VISIBLE_FOR_MS);
  const found: ExternalSession[] = [];
  for (const name of files) {
    const session = load(join(folder, name));
    if (session && (opts.includeStale || session.lastSeenAt >= cutoff)) found.push(session);
  }
  return found.sort((x, y) => y.lastSeenAt - x.lastSeenAt);
}

/**
 * Does any registration — stale ones included — use this session id?
 *
 * The dispatcher asks this with nothing but a session id. Staleness is ignored on
 * purpose: a stale external session cannot be resumed headlessly either, so it is
 * better to keep its mail pending than to fail it.
 */
export function isRegisteredSession(sessionId: string, opts: StoreOpts = {}): boolean {
  return listRegistered({ ...opts, includeStale: true }).some((s) => s.sessionId === sessionId);
}
