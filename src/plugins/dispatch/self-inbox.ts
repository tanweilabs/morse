import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { checkClaudeLaunch } from '../../adapters/claude.js';
import type { DeliveryAdapter, LaunchOptions } from '../../adapters/types.js';
import { classifyReply, extractReply, renderEnvelope, withRepeatLine } from '../../envelope.js';
import type { CoreClient, PluginMessage } from '../../plugin/contract.js';
import { isOwnAgentMail, renderPlain, runInDedicated } from './deliver.js';
import { DEFAULT_RESET_NOTICE, PROFILE_NAME_RE, type LaunchProfile } from './launch.js';
import type { DispatchState } from './state.js';

/**
 * Your own mail to an agent's inbox gets a session (ADR-061). A message from you — one of
 * your other agents (contact `self`, e.g. `morse send me "…"` typed through your agent `air`) — addressed
 * to one of your agents but to no particular session lands in that agent's inbox, where
 * nothing ran it. Now the dispatch plugin answers it in a dedicated session per (my agent,
 * sending agent) (`self-<agent>-<peer agent>`): created on first use, continued after, recreated (and
 * said once) when it is gone, one turn at a time — the ADR-056 machinery. The answer goes
 * back with `morse reply` (same thread) and the message is processed; NOOP = `morse done`.
 *
 * Never another person's mail, never a message request, never mail to a session: only
 * `direction: in` + contact `self` (group `self`) + `to.sessionId: "inbox"`.
 *
 *   ~/.morse/config.json
 *   { "plugins": { "dispatch": {
 *       "selfInbox": { "enabled": true, "cwd": "/Users/you", "permissionMode": "default",
 *                      "model": "…", "effort": "…", "timeoutSec": 600, "appendSystemPrompt": "…" },
 *       "launch": [ { "agent": "claude", "to": "inbox", "from": "air", "cwd": "/Users/you/work",
 *                     "permissionMode": "acceptEdits" } ] } } }
 *
 * A `launch` entry with `"to": "inbox"` (optionally `from` = the sending agent's name)
 * wins over the `selfInbox` default. Default: Claude, `--permission-mode default` (your own
 * Claude allow rules apply; anything that would ask is refused — headless nobody answers;
 * a bypass mode is never accepted), cwd = your home directory.
 */

/** Agents whose inbox belongs to a plugin of its own, never a dispatch session. */
const RESERVED = new Set(['user', 'dispatch', 'ilink', 'attendant']);

export interface SelfInboxConfig {
  enabled: boolean;
  cwd: string;
  /** Mail older than this many minutes is left alone (default 60). */
  maxAgeMin: number;
  launch: LaunchOptions;
  resetNotice: string;
  errors: string[];
}

export function parseSelfInbox(raw: unknown, home: string = homedir()): SelfInboxConfig {
  const out: SelfInboxConfig = { enabled: true, cwd: home, maxAgeMin: 60, launch: { permissionMode: 'default' }, resetNotice: DEFAULT_RESET_NOTICE, errors: [] };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    out.errors.push('plugins.dispatch.selfInbox must be an object — using the defaults');
    return out;
  }
  const e = raw as Record<string, unknown>;
  if (e['enabled'] === false) out.enabled = false;
  try {
    const known = new Set(['enabled', 'cwd', 'permissionMode', 'allowedTools', 'model', 'effort', 'timeoutSec', 'appendSystemPrompt', 'resetNotice', 'maxAgeMin']);
    for (const k of Object.keys(e)) if (!known.has(k)) throw new Error(`unknown setting "${k}"`);
    if (e['cwd'] !== undefined) {
      if (typeof e['cwd'] !== 'string' || !isAbsolute(e['cwd'])) throw new Error('"cwd" must be an absolute path');
      out.cwd = resolve(e['cwd']);
    }
    if (e['maxAgeMin'] !== undefined) {
      const a = Number(e['maxAgeMin']);
      if (!Number.isFinite(a) || a < 1) throw new Error('"maxAgeMin" is a number of minutes');
      out.maxAgeMin = a;
    }
    const launch: LaunchOptions = { permissionMode: 'default' };
    if (e['permissionMode'] !== undefined) launch.permissionMode = String(e['permissionMode']);
    if (e['allowedTools'] !== undefined) {
      if (!Array.isArray(e['allowedTools']) || !e['allowedTools'].every((t) => typeof t === 'string')) throw new Error('"allowedTools" is a list of names');
      launch.allowedTools = e['allowedTools'] as string[];
    }
    for (const k of ['model', 'effort', 'appendSystemPrompt'] as const) {
      if (e[k] === undefined) continue;
      if (typeof e[k] !== 'string') throw new Error(`"${k}" is text`);
      if (String(e[k]).trim()) launch[k] = String(e[k]);
    }
    if (e['timeoutSec'] !== undefined) {
      const t = Number(e['timeoutSec']);
      if (!Number.isFinite(t) || t < 1) throw new Error('"timeoutSec" is a number of seconds');
      launch.timeoutMs = Math.round(t * 1000);
    }
    checkClaudeLaunch(launch); // no bypass-style mode, no bare Bash
    out.launch = launch;
    if (typeof e['resetNotice'] === 'string' && e['resetNotice'].trim()) out.resetNotice = e['resetNotice'].trim();
  } catch (err) {
    out.errors.push(`plugins.dispatch.selfInbox: ${err instanceof Error ? err.message : String(err)} — your own inbox mail is not run until it is fixed`);
    out.enabled = false;
  }
  return out;
}

/** Reads plugins.dispatch.selfInbox (re-read when config.json changes). */
export function createSelfInboxReader(opts: { file?: string; log?: (line: string) => void } = {}): () => SelfInboxConfig {
  // compatibility: ANYTOANY_HOME (the old name of MORSE_HOME) is still read, as in src/home.ts
  const file = opts.file ?? join(process.env['MORSE_HOME'] || process.env['ANYTOANY_HOME'] || homedir(), '.morse', 'config.json');
  let cache: { text: string; value: SelfInboxConfig } | null = null;
  return () => {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      /* no config */
    }
    if (cache && cache.text === text) return cache.value;
    let raw: unknown;
    try {
      raw = text ? (JSON.parse(text) as { plugins?: { dispatch?: { selfInbox?: unknown } } }).plugins?.dispatch?.selfInbox : undefined;
    } catch {
      raw = undefined;
    }
    const value = parseSelfInbox(raw);
    for (const e of value.errors) opts.log?.(e);
    cache = { text, value };
    return value;
  };
}

/** Your own mail (from another agent of yours) to an agent's inbox, not handled yet. */
export function isSelfInboxMail(m: PluginMessage): boolean {
  return isOwnAgentMail(m) && m.direction === 'in' && m.to.sessionId === 'inbox' && !m.processed && m.status !== 'dead' && !RESERVED.has(m.to.agent);
}

/** The sending agent's name (`air` for `me/air`), else the sender's agent name. */
export function peerOf(m: Pick<PluginMessage, 'peerAgent' | 'from'>): string {
  const dev = m.from.device?.split('/')[1];
  return m.peerAgent ?? dev ?? m.from.agent;
}

/** The dedicated session's name for (my agent, sending agent): `self-<agent>-<peer agent>`. */
export function selfInboxName(m: Pick<PluginMessage, 'peerAgent' | 'from' | 'to' | 'agent'>): string {
  const clean = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  const name = `self-${clean(m.agent ?? m.to.agent)}-${clean(peerOf(m))}`.slice(0, 32).replace(/-+$/, '');
  return PROFILE_NAME_RE.test(name) ? name : 'self-inbox';
}

/** The profile this message runs with: a `"to": "inbox"` launch entry (most specific), else the default. */
export function selfInboxProfile(m: PluginMessage, profiles: LaunchProfile[], cfg: SelfInboxConfig): LaunchProfile {
  const peer = peerOf(m);
  let best: LaunchProfile | null = null;
  for (const p of profiles) {
    if (p.to !== 'inbox') continue;
    if (p.from && p.from !== peer && p.from !== m.from.agent) continue;
    if (!best || (p.from && !best.from)) best = p;
  }
  const name = selfInboxName(m);
  if (best) return { ...best, name, dedicated: true, cwd: best.cwd ?? cfg.cwd, launch: { ...best.launch } };
  return { agent: 'claude', name, cwd: cfg.cwd, to: 'inbox', prompt: 'envelope', whenLive: 'wait', dedicated: true, resetNotice: cfg.resetNotice, launch: { ...cfg.launch } };
}

export interface SelfInboxDeps {
  core: CoreClient;
  adapters: Map<string, DeliveryAdapter>;
  state: DispatchState;
  launchProfiles: () => LaunchProfile[];
  config: () => SelfInboxConfig;
  isSessionLive?: (sessionId: string) => boolean;
  newSessionId?: () => string;
  log?: (line: string) => void;
  now?: () => number;
  /** (ADR-089 review F3) false = the supervising daemon is gone: no new turn is started. */
  daemonAlive?: () => boolean;
}

const MAX_TRIES = 3;
const RETRY_MS = 30_000;

/**
 * One turn for one message in its sending agent's session. 'busy' = the lane is held (or
 * its session is open on the computer) — try later.
 */
export async function deliverSelfInbox(m: PluginMessage, deps: SelfInboxDeps): Promise<'answered' | 'noop' | 'failed' | 'busy'> {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const cfg = deps.config();
  const profile = selfInboxProfile(m, deps.launchProfiles(), cfg);
  const name = profile.name!;
  const unlock = deps.state.lock(`dispatch:${name}`);
  if (!unlock) return 'busy';
  try {
    const adapter = deps.adapters.get(profile.agent);
    if (!adapter) {
      log(`self inbox ${m.id.slice(0, 8)}: no adapter for ${profile.agent}`);
      return 'failed';
    }
    // the directory changed: a new session (Claude resumes only in the directory it began in) — not a "reset"
    const rec = deps.state.dedicated(name);
    if (rec && rec.cwd !== profile.cwd) deps.state.setDedicated(name, null);
    else if (rec && profile.whenLive !== 'resume' && deps.isSessionLive?.(rec.sessionId)) return 'busy';
    const peer = peerOf(m);
    // you typing (`from.agent === 'user'`) is you in person, writing through your agent address "air"; a session of yours there is an agent
    const plain = profile.prompt === 'plain' || m.from.agent === 'user';
    const envelope = plain
      ? renderPlain({ messageId: m.id, fromLabel: `Morse from your agent "${peer}"`, text: m.text })
      : renderEnvelope({ messageId: m.id, fromLabel: `@${m.from.agent}, a session of your agent "${peer}"`, text: m.text, replyVia: 'marker' });
    // (ADR-089) this mail is not claimed — the mark says a turn was started for it: a run that finds the mark of
    // a turn that never reported (the plugin was stopped in the middle) tells the agent it may be a repeat
    const before = deps.state.mark(m.id);
    deps.state.setMark(m.id, { attempts: before?.attempts ?? 0, notBefore: before?.notBefore ?? 0, ...(before?.error ? { error: before.error } : {}), startedAt: now() });
    const { result, started } = await runInDedicated(deps.state, name, profile, adapter, withRepeatLine(envelope, Boolean(before?.startedAt)), deps.newSessionId);
    if (!result.ok) {
      const tries = (deps.state.mark(m.id)?.attempts ?? 0) + 1;
      const final = result.retry === false || tries >= MAX_TRIES;
      deps.state.setMark(m.id, { attempts: tries, notBefore: final ? Number.MAX_SAFE_INTEGER : now() + RETRY_MS, error: (result.error ?? 'failed').slice(0, 300) });
      log(`self inbox ${m.id.slice(0, 8)} @dispatch:${name}: failed (try ${tries}${final ? ', giving up — it waits for you (morse read)' : ''}): ${result.error}`);
      return 'failed';
    }
    deps.state.setMark(m.id, null);
    let reply = plain ? (result.output ?? '').trim() || null : extractReply(result.output ?? '');
    const verdict = reply ? classifyReply(m.text, reply) : 'noop';
    if (verdict !== 'file') reply = null;
    const recNow = deps.state.dedicated(name);
    const notice = recNow?.resetPending ? profile.resetNotice : undefined;
    if (notice) reply = reply ? `${notice}\n\n${reply}` : notice;
    if (!reply) {
      await deps.core.done([m.id], { by: 'plugin:dispatch' });
      log(`self inbox ${m.id.slice(0, 8)} @dispatch:${name}: no reply (${verdict})${started ? ` — ${started}` : ''}`);
      return 'noop';
    }
    const r = await deps.core.reply(m.id, reply, { via: 'auto', by: 'plugin:dispatch' });
    if (r.ok && notice && recNow) {
      const { resetPending: _, ...rest } = recNow;
      deps.state.setDedicated(name, rest);
    }
    // `morse reply` marks it processed already; done also when the reply could not be filed —
    // the turn ran, it must never run again
    await deps.core.done([m.id], { by: 'plugin:dispatch' });
    log(`self inbox ${m.id.slice(0, 8)} @dispatch:${name}: ${r.ok ? 'answered' : `reply not sent (${r.error})`}${started ? ` — ${started}` : ''}`);
    return 'answered';
  } finally {
    unlock();
  }
}

/** The loop: lanes (one per sending agent) side by side, each message in order, one at a time. */
export function createSelfInboxRunner(deps: SelfInboxDeps, opts: { concurrency?: number } = {}) {
  const max = Math.max(1, opts.concurrency ?? 2);
  const now = deps.now ?? Date.now;
  const running = new Map<string, Promise<void>>();
  const skipped = new Set<string>();
  let scanning: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  const scan = async () => {
    if (stopped || deps.daemonAlive?.() === false || !deps.config().enabled) return;
    let todo: PluginMessage[];
    try {
      todo = await deps.core.todo();
    } catch (e) {
      deps.log?.(`self inbox: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const lanes = new Map<string, PluginMessage[]>();
    // never answer backlog: mail from before the loop first ran, or older than maxAgeMin, stays in `morse message`
    const cfg = deps.config();
    const since = deps.state.selfInboxSince(now());
    for (const m of todo) {
      if (!isSelfInboxMail(m)) continue;
      const stale = m.at < since ? 'arrived before this was enabled' : now() - m.at > cfg.maxAgeMin * 60_000 ? `older than ${cfg.maxAgeMin} min` : '';
      if (stale) {
        if (!skipped.has(m.id)) {
          skipped.add(m.id);
          deps.log?.(`self inbox ${m.id.slice(0, 8)}: ${stale} — left in your inbox`);
        }
        continue;
      }
      const mark = deps.state.mark(m.id);
      if (mark && mark.notBefore > now()) continue;
      const lane = selfInboxName(m);
      lanes.set(lane, [...(lanes.get(lane) ?? []), m]);
    }
    for (const [lane, msgs] of lanes) {
      if (stopped || running.has(lane) || running.size >= max) continue;
      const job = (async () => {
        for (const m of msgs) if (stopped || deps.daemonAlive?.() === false || (await deliverSelfInbox(m, deps)) === 'busy') break;
      })().finally(() => {
        running.delete(lane);
        runner.kick();
      });
      running.set(lane, job);
    }
  };
  const runner = {
    kick: () => void runner.tick(),
    async tick(): Promise<void> {
      if (scanning) {
        again = true;
        return scanning;
      }
      scanning = (async () => {
        try {
          do {
            again = false;
            await scan();
          } while (again);
        } finally {
          scanning = null;
        }
      })();
      return scanning;
    },
    /** Resolves when nothing runs and nothing more is due (tests). */
    async idle(): Promise<void> {
      for (;;) {
        await runner.tick();
        if (!running.size) return;
        await Promise.all([...running.values()]);
      }
    },
    running: () => [...running.keys()],
    /** (ADR-089) Stopping: no new turn is started; resolves when the ones that are running have finished and reported. */
    async stop(): Promise<void> {
      stopped = true;
      while (running.size) await Promise.all([...running.values()]);
    },
  };
  return runner;
}
