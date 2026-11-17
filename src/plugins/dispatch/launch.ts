import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkClaudeLaunch } from '../../adapters/claude.js';
import type { LaunchOptions, SessionInfo } from '../../adapters/types.js';

/**
 * Per-agent launch settings for the dispatch plugin (ADR-054) — the owner says how one of
 * his agents is started: "this Claude session runs with model X, effort Y, these
 * permissions, this extra system prompt, this time limit". Config, not core:
 *
 *   ~/.morse/config.json
 *   { "plugins": { "dispatch": { "launch": [
 *       { "agent": "claude", "session": "<session id>", "cwd": "/abs/dir", "from": "ilink",
 *         "prompt": "plain", "permissionMode": "acceptEdits", "allowedTools": ["mcp__1board"],
 *         "model": "…", "effort": "high", "timeoutSec": 600, "appendSystemPrompt": "…" } ] } } }
 *
 * Match: `agent` (required) = the target's agent; `session` = the target session id;
 * `cwd` = the target session's directory; `from` = the sender's agent name. The most
 * specific match wins (session > cwd > from), the first one on a tie. No match = the
 * agent's own defaults, exactly as before.
 *
 * `prompt: "plain"` (only with `from`): the message is the owner speaking in person
 * through that channel (e.g. the iLink plugin) — it is handed over as is, under one
 * header line, with no agent-to-agent protocol, and the agent's whole answer is the reply.
 *
 * Bypass-style permission modes are refused in code (checkClaudeLaunch), and so is a
 * profile for an agent whose adapter has no launch settings.
 *
 * `whenLive` (ADR-055): "wait" (default) = a session that is open on the computer right
 * now (live) or monitored is left alone and the message waits; "resume" = run it anyway
 * (what the standalone weixin-bridge did) — see docs/PLUGINS.md for the risk.
 *
 * `to: "inbox"` (ADR-061): the profile is for your own mail to an agent's inbox (no session
 * named) — see self-inbox.ts; `from` then matches the sending agent (or the
 * sender's agent name). It never matches a delivery to a session.
 *
 * `dedicated: true` + `name` + `cwd` (ADR-056): the profile owns one session of its own,
 * created on first use in `cwd`, its id kept in the plugin's state
 * (~/.morse/plugins/dispatch/state.json), started afresh when it is gone (the next reply
 * then begins with `resetNotice`). Its Morse address is `@dispatch:<name>`.
 */

export interface LaunchProfile {
  agent: string;
  /** A name (letters, digits, dashes) — required for a dedicated session. */
  name?: string;
  session?: string;
  cwd?: string;
  from?: string;
  /** ADR-061: "inbox" = your own mail to an agent's inbox (self-inbox.ts), never a session delivery. */
  to?: 'inbox';
  prompt: 'envelope' | 'plain';
  /** ADR-055: what to do while the target session is live / monitored. */
  whenLive: 'wait' | 'resume';
  /** ADR-056: the profile owns a session of its own (address `@dispatch:<name>`). */
  dedicated: boolean;
  /** ADR-056: the line the first reply after a fresh start begins with. */
  resetNotice: string;
  launch: LaunchOptions;
}

/** The agent name of the dispatch plugin's profile addresses: `@dispatch:<profile name>`. */
export const DISPATCH_AGENT = 'dispatch';
export const DEFAULT_RESET_NOTICE = '[Morse] The earlier session could not be found, so a new one was started: earlier context is not available.';
export const PROFILE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface LaunchConfig {
  profiles: LaunchProfile[];
  errors: string[];
}

/** Agents whose adapter takes launch settings. */
const SUPPORTED = new Set(['claude']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export function parseLaunchConfig(raw: unknown): LaunchConfig {
  const profiles: LaunchProfile[] = [];
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { profiles, errors };
  if (!Array.isArray(raw)) return { profiles, errors: ['plugins.dispatch.launch must be a list'] };
  raw.forEach((entry, i) => {
    const where = `plugins.dispatch.launch[${i}]`;
    try {
      if (!entry || typeof entry !== 'object') throw new Error('not an object');
      const e = entry as Record<string, unknown>;
      const agent = str(e['agent']);
      if (!agent) throw new Error('"agent" is required');
      if (!SUPPORTED.has(agent)) throw new Error(`agent "${agent}": launch settings are only supported for ${[...SUPPORTED].join(', ')}`);
      const prompt = e['prompt'] === undefined || e['prompt'] === 'envelope' ? 'envelope' : e['prompt'] === 'plain' ? 'plain' : null;
      if (!prompt) throw new Error('"prompt" is "envelope" or "plain"');
      const from = str(e['from']);
      if (e['to'] !== undefined && e['to'] !== 'inbox') throw new Error('"to" is "inbox" (your own mail to an agent\'s inbox) or not set');
      const to = e['to'] === 'inbox' ? ('inbox' as const) : undefined;
      if (prompt === 'plain' && !from && !to) throw new Error('"prompt": "plain" needs "from" (the sender that is you in person)');
      if (to && (e['session'] !== undefined || e['dedicated'] !== undefined || e['name'] !== undefined))
        throw new Error('"to": "inbox" gets one session per sending agent by itself — no "session", "dedicated" or "name"');
      const cwd = str(e['cwd']);
      if (cwd && !cwd.startsWith('/')) throw new Error('"cwd" must be an absolute path');
      const launch: LaunchOptions = {};
      const mode = str(e['permissionMode']);
      if (mode) launch.permissionMode = mode;
      if (e['allowedTools'] !== undefined) {
        const tools = e['allowedTools'];
        if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string')) throw new Error('"allowedTools" is a list of names');
        launch.allowedTools = tools.map((t) => t.trim()).filter(Boolean);
      }
      const model = str(e['model']);
      if (model) launch.model = model;
      const effort = str(e['effort']);
      if (effort) launch.effort = effort;
      if (e['timeoutSec'] !== undefined) {
        const t = Number(e['timeoutSec']);
        if (!Number.isFinite(t) || t < 1) throw new Error('"timeoutSec" is a number of seconds');
        launch.timeoutMs = Math.round(t * 1000);
      }
      if (e['appendSystemPrompt'] !== undefined) {
        if (typeof e['appendSystemPrompt'] !== 'string') throw new Error('"appendSystemPrompt" is text');
        if (e['appendSystemPrompt'].trim()) launch.appendSystemPrompt = e['appendSystemPrompt'];
      }
      checkClaudeLaunch(launch);
      const session = str(e['session']);
      const whenLive = e['whenLive'] === undefined || e['whenLive'] === 'wait' ? 'wait' : e['whenLive'] === 'resume' ? 'resume' : null;
      if (!whenLive) throw new Error('"whenLive" is "wait" or "resume"');
      const name = str(e['name']);
      if (name && !PROFILE_NAME_RE.test(name)) throw new Error(`"name" "${name}": lowercase letters, digits and dashes, starting with a letter`);
      if (name && profiles.some((p) => p.name === name)) throw new Error(`"name" "${name}" is used twice`);
      if (e['dedicated'] !== undefined && typeof e['dedicated'] !== 'boolean') throw new Error('"dedicated" is true or false');
      const dedicated = e['dedicated'] === true;
      if (dedicated && (!name || !cwd)) throw new Error('"dedicated": true needs "name" and "cwd" (where the session is started)');
      if (dedicated && session) throw new Error('"dedicated": true owns its session — no "session"');
      if (e['resetNotice'] !== undefined && typeof e['resetNotice'] !== 'string') throw new Error('"resetNotice" is text');
      const resetNotice = typeof e['resetNotice'] === 'string' && e['resetNotice'].trim() ? e['resetNotice'].trim() : DEFAULT_RESET_NOTICE;
      profiles.push({ agent, ...(name ? { name } : {}), ...(session ? { session } : {}), ...(cwd ? { cwd: trimSlash(cwd) } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), prompt, whenLive, dedicated, resetNotice, launch });
    } catch (err) {
      errors.push(`${where}: ${err instanceof Error ? err.message : String(err)} — ignored`);
    }
  });
  return { profiles, errors };
}

/**
 * The profile for this delivery, or null (the agent's defaults). A dedicated profile only
 * matches its own session (`dedicatedId` gives its current id), as if it named it.
 */
export function matchLaunch(profiles: LaunchProfile[], target: SessionInfo, fromAgent: string, dedicatedId: (name: string) => string | null = () => null): LaunchProfile | null {
  let best: LaunchProfile | null = null;
  let bestScore = -1;
  for (const p of profiles) {
    if (p.agent !== target.agent || p.to) continue;
    if (p.dedicated) {
      if (dedicatedId(p.name!) !== target.sessionId) continue;
      if (p.from && p.from !== fromAgent) continue;
      const score = 4 + 2 + (p.from ? 1 : 0);
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
      continue;
    }
    if (p.session && p.session !== target.sessionId) continue;
    if (p.cwd && p.cwd !== trimSlash(target.cwd)) continue;
    if (p.from && p.from !== fromAgent) continue;
    const score = (p.session ? 4 : 0) + (p.cwd ? 2 : 0) + (p.from ? 1 : 0);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

/** Reads plugins.dispatch.launch from <MORSE_HOME or ~>/.morse/config.json (cached briefly). */
export function createLaunchReader(opts: { file?: string; log?: (line: string) => void; ttlMs?: number } = {}): () => LaunchProfile[] {
  // compatibility: ANYTOANY_HOME (the old name of MORSE_HOME) is still read, as in src/home.ts
  const file = opts.file ?? join(process.env['MORSE_HOME'] || process.env['ANYTOANY_HOME'] || homedir(), '.morse', 'config.json');
  const ttl = opts.ttlMs ?? 2000;
  let cache: { at: number; text: string; profiles: LaunchProfile[] } | null = null;
  return () => {
    if (cache && Date.now() - cache.at < ttl) return cache.profiles;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      /* no config */
    }
    if (cache && cache.text === text) {
      cache.at = Date.now();
      return cache.profiles;
    }
    let raw: unknown;
    try {
      raw = text ? ((JSON.parse(text) as { plugins?: { dispatch?: { launch?: unknown } } }).plugins?.dispatch?.launch ?? null) : null;
    } catch {
      opts.log?.('launch settings: config.json is not valid JSON — none applied');
      raw = null;
    }
    const { profiles, errors } = parseLaunchConfig(raw);
    for (const e of errors) opts.log?.(`launch settings: ${e}`);
    cache = { at: Date.now(), text, profiles };
    return profiles;
  };
}
