import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentDomainUrl } from './cluster/address.js';
import { withFileLock, writeFileAtomic } from './file-lock.js';
import { morseHome, dataDir } from './home.js';

/**
 * ~/.morse/config.json: settings the OWNER of this computer chose for it. Nothing a sending agent says can
 * change them — in particular the escalation a headless turn woken by Morse may use (`zcode.deliverMode`,
 * `codex.sandbox`) is only ever what is written here. Callers read it again each time (per delivery), so an
 * edit takes effect without restarting the daemon.
 */
export interface MachineConfig {
  /** ZCode delivery: how a woken turn runs (see src/adapters/zcode.ts) and how long it may take. */
  zcode?: { deliverMode?: string; deliverTimeoutSec?: number };
  /** Codex delivery: the sandbox of `codex exec resume` and how long a turn may take. */
  codex?: { sandbox?: string; deliverTimeoutSec?: number };
  /** Morse cross-network relay, e.g. { "url": "wss://relay.morse.im" }; `handle`
   *  is this device's person on it, written by `morse join` (display only — the
   *  relay's allowlist is the authority). `agent` is this computer's own agent
   *  (morse.im/<handle>/<agent>, ADR-033) — the sender name on what it sends —
   *  and `agents` every agent hosted here (a cache; the relay's directory decides).
   *  `nickname` is the person's display nickname (ADR-036; a cache — the relay keeps it). */
  relay?: { url?: string; handle?: string; agent?: string; agents?: string[]; nickname?: string };
  /** Morse behaviour (ADR-037).
   *  strangers: what the first message of someone not paired here becomes —
   *    "request" (default: a message request, kept out of the inbox until you
   *    `morse contact accept` it), "accept" (pair them as `peer` at once — the old
   *    ADR-032 pair-back), "block" (drop it).
   *  autoPairBack: deprecated; `false` still means strangers "block".
   *  receiveLimit: inbound messages a minute — per sending person and in total; no limit
   *    by default (ADR-073), 0 = no limit; over a cap you set they are dropped (the sender
   *    retries later).
   *  maxRequests: message requests kept (default 200; when full a new person is refused — nobody waiting is removed).
   *  maxFileBytes (ADR-038): largest file, and largest total of one message's files, sent
   *    or accepted (default 100 MB = 104857600).
   *  maxStagingBytes (ADR-038): unfinished incoming files kept at most (default 1 GiB).
   *  direct (ADR-069): direct WebRTC links to contacts' devices, relay as fallback — on by
   *    default; {"enabled": false} (or env MORSE_DIRECT=0) turns it off; stun: STUN servers
   *    (default ["stun:stun.cloudflare.com:3478"]). */
  morse?: {
    strangers?: 'request' | 'accept' | 'block';
    autoPairBack?: boolean;
    receiveLimit?: { perSenderPerMinute?: number; totalPerMinute?: number };
    maxRequests?: number;
    /** (ADR-091 follow-up) the LAN by address — off unless true (`morse start --lan` turns it on for one run). */
    lan?: boolean;
    maxFileBytes?: number;
    maxStagingBytes?: number;
    direct?: boolean | { enabled?: boolean; stun?: string[] };
  };
  /** Morse outbox: a message to a person who is not reachable is retried every
   *  retryIntervalSec (default 30) for up to maxWaitDays (default 30). */
  outbox?: { retryIntervalSec?: number; maxWaitDays?: number };
  /** Auto-update (ADR-039). auto: the daemon checks the site for a newer SIGNED release
   *  and installs it (default true; false = only `morse update` by hand). site: where
   *  version.json / morse.tgz live (default https://morse.im; env MORSE_SITE wins). */
  update?: { auto?: boolean; site?: string };
  /** Plugins the daemon supervises (ADR-052): name → { command, enabled }. The built-in
   *  `dispatch` (your own agents) needs no entry; `{ "dispatch": { "enabled": false } }` turns it off. */
  plugins?: Record<string, { command?: string; enabled?: boolean }>;
  /** Plugin hooks (ADR-051, docs/PLUGINS.md). on_message: a command the daemon runs for
   *  every new received message / stranger request, the event's JSON on stdin; killed
   *  after timeoutSec (default 30). Never blocks delivery. */
  hooks?: { on_message?: { command?: string; timeoutSec?: number } };
}

/** Where this computer's config lives: config.json in the data directory. */
export function defaultConfigFile(): string { return join(dataDir(), 'config.json'); }

/** The JSON object in `file`; null when the file is missing, unreadable, not JSON, or not an object. */
function readJsonObject(file: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** The config as it is on disk; `{}` (every default) when there is none or it cannot be read. */
export function readMachineConfig(file: string = defaultConfigFile()): MachineConfig {
  return (readJsonObject(file) ?? {}) as MachineConfig;
}

/**
 * Read-modify-write ~/.morse/config.json, keeping every key we do not touch. Under the
 * file's lock and written atomically: several morse processes change it (join, agent,
 * relay set, contact permissions), and one must not drop another's keys. `mutate` must be
 * synchronous.
 */
export function updateMachineConfig(mutate: (cfg: Record<string, unknown>) => void, file: string = defaultConfigFile()): void {
  withFileLock(file, () => {
    const cfg = readJsonObject(file) ?? {};
    mutate(cfg);
    writeFileAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
  });
}

/**
 * Compatibility (ADR-075): morse.talk is retired. A config.json saved while it was in use
 * may still say `relay.url: wss://relay.morse.talk` or `update.site: https://morse.talk`;
 * those two values are rewritten to the morse.im names — once: afterwards there is nothing
 * left to rewrite — and one line says so. Every other key and value stays as it is.
 * Returns what changed (empty = nothing).
 */
export function migrateLegacyDomains(file: string = defaultConfigFile(), log: (line: string) => void = () => undefined): string[] {
  const stale = (cfg: { relay?: { url?: unknown }; update?: { site?: unknown } }): Array<{ key: 'relay.url' | 'update.site'; from: string; to: string }> => {
    const out: Array<{ key: 'relay.url' | 'update.site'; from: string; to: string }> = [];
    for (const [key, value] of [['relay.url', cfg.relay?.url], ['update.site', cfg.update?.site]] as const) {
      const to = typeof value === 'string' ? currentDomainUrl(value) : null;
      if (to) out.push({ key, from: value as string, to });
    }
    return out;
  };
  // the common case costs one read: nothing to rewrite, nothing written
  if (stale(readMachineConfig(file)).length === 0) return [];
  const changed: string[] = [];
  updateMachineConfig((cfg) => {
    // decided again under the lock: another process may have rewritten it meanwhile
    for (const c of stale(cfg as MachineConfig)) {
      const [section, field] = c.key.split('.') as [string, string];
      (cfg[section] as Record<string, unknown>)[field] = c.to;
      changed.push(`${c.key} ${c.from} → ${c.to}`);
    }
  }, file);
  if (changed.length) log(`config: ${changed.join(', ')} — the old domain is retired (${file} updated)`);
  return changed;
}
