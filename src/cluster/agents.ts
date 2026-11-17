import { createPrivateKey, sign, X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { morseHome, dataDir } from '../home.js';
import { readMachineConfig, updateMachineConfig } from '../machine-config.js';
import { fetchRelay } from './address.js';
import { loadOrCreateIdentity, type DeviceIdentity } from './identity.js';

/**
 * Agent addresses (ADR-033): every agent has ONE address, morse.im/<handle>/<agent>,
 * and one hosting device. The relay keeps the directory (handle/agent → device);
 * this device changes it with requests signed by its own key:
 *
 *   morse agent list | add <name> | remove <name> | default <name> | rename <old> <new>
 *
 * By default each computer registers one agent when it joins — named after the
 * computer (mini, air, pro …) — which is "this computer's agent inbox": any agent
 * session on it (Claude Code, Codex) reads it with `morse message` / `morse message --pull --inbox`.
 */

export const AGENT_CONTEXT = 'morse-relay-agent-v1';
export type AgentOp = 'add' | 'remove' | 'default' | 'rename' | 'list';

/** Same rule as the relay (relay-cf/src/protocol.ts): a-z 0-9 '-', 1–32, not "user" / "inbox". */
export function normalizeAgentName(input: string): string | null {
  const a = input.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(a)) return null;
  return a === 'user' || a === 'inbox' ? null : a;
}

/**
 * A short default agent name from a device / host name: a Mac model in it wins
 * ("meideMac-mini" → mini, "Yus-MacBook-Air" → air, "…MacBook-Pro" → pro,
 * iMac → imac, Mac Studio → studio); otherwise the name itself, lowercased with
 * anything outside a-z 0-9 turned into '-'. Pass `morse join --agent <name>` to
 * choose instead.
 */
export function defaultAgentName(deviceName: string): string {
  const flat = deviceName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const models: Array<[RegExp, string]> = [
    [/macmini/, 'mini'],
    [/macbookair/, 'air'],
    [/macbookpro/, 'pro'],
    [/macstudio/, 'studio'],
    [/macpro/, 'macpro'],
    [/imac/, 'imac'],
  ];
  for (const [re, name] of models) if (re.test(flat)) return name;
  const slug = deviceName
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return normalizeAgentName(slug) ?? 'computer';
}

export function signAgentOp(identity: DeviceIdentity, ts: number, op: AgentOp, agent = '', to = ''): string {
  return sign(null, Buffer.from(`${AGENT_CONTEXT}\n${ts}\n${op}\n${agent}\n${to}`), createPrivateKey(identity.keyPem)).toString('base64');
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface AgentEntry {
  agent: string;
  device: string;
  addedAt: number;
}

export interface AgentOpResult {
  handle?: string;
  device?: string;
  agent?: string;
  from?: string;
  default?: string | null;
  agents?: AgentEntry[];
  already?: boolean;
  removed?: boolean;
}

/** ws(s)://host[/base] → http(s)://host[/base] */
function httpBase(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol === 'ws:') u.protocol = 'http:';
  return u.toString().replace(/\/+$/, '');
}

/** One signed request to the relay's agent directory (POST /v1/agents). Throws AgentError. */
export async function agentRequest(opts: { url: string; op: AgentOp; agent?: string; to?: string; home?: string; timeoutMs?: number }): Promise<AgentOpResult> {
  const identity = loadOrCreateIdentity(opts.home ?? morseHome());
  const norm = (raw: string | undefined, what: string): string => {
    if (raw === undefined) return '';
    const n = normalizeAgentName(raw);
    if (!n) throw new AgentError(`"${raw}" is not a valid ${what} (1–32 of a-z 0-9 -, e.g. mini, air, macbook-air)`, 'bad_agent');
    return n;
  };
  const agent = norm(opts.agent, 'agent name');
  const to = norm(opts.to, 'agent name');
  const ts = Date.now();
  let res: Response;
  try {
    res = await fetchRelay(opts.url, '/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: opts.op,
        ...(agent ? { agent } : {}),
        ...(to ? { to } : {}),
        cert: new X509Certificate(identity.certPem).raw.toString('base64'),
        ts,
        sig: signAgentOp(identity, ts, opts.op, agent, to),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new AgentError(`cannot reach the relay at ${httpBase(opts.url)}: ${e instanceof Error ? e.message : String(e)}`, 'unreachable');
  }
  const body = (await res.json().catch(() => ({}))) as AgentOpResult & { error?: string; code?: string };
  if (!res.ok) throw new AgentError(body.error ?? `relay answered HTTP ${res.status}`, body.code ?? `http_${res.status}`);
  return body;
}

/** Keep ~/.morse/config.json in step: `relay.agent` (this computer's own) and `relay.agents` (hosted here). */
export function saveLocalAgents(update: { primary?: string | null; agents: string[] }, home: string = morseHome()): void {
  updateMachineConfig(
    (cfg) => {
      const prev = (cfg['relay'] && typeof cfg['relay'] === 'object' ? cfg['relay'] : {}) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...prev, agents: [...new Set(update.agents)] };
      if (update.primary === null) delete next['agent'];
      else if (update.primary) next['agent'] = update.primary;
      cfg['relay'] = next;
    },
    join(dataDir(home), 'config.json'),
  );
}

/** The agents this computer hosts according to the local cache, primary first. */
export function localAgents(home: string = morseHome()): { primary: string | null; agents: string[] } {
  const relay = readMachineConfig(join(dataDir(home), 'config.json')).relay;
  const agents = Array.isArray(relay?.agents) ? relay.agents.filter((a): a is string => typeof a === 'string') : [];
  const primary = typeof relay?.agent === 'string' ? relay.agent : (agents[0] ?? null);
  return { primary, agents: primary && !agents.includes(primary) ? [primary, ...agents] : agents };
}

/** After an op: refresh the local cache from the relay's answer (list) or the op itself. */
export function applyToLocal(op: AgentOp, r: AgentOpResult, home: string = morseHome()): void {
  const { primary, agents } = localAgents(home);
  if (op === 'list' && r.agents && r.device) {
    // (ADR-091) the relay's directory knows only the names registered the v2 way: an address added here since (with
    // no request to the relay) stays in the list — the relay's answer only adds
    const mine = [...new Set([...agents, ...r.agents.filter((a) => a.device === r.device).map((a) => a.agent)])];
    saveLocalAgents({ primary: primary && mine.includes(primary) ? primary : (mine[0] ?? null), agents: mine }, home);
  } else if (op === 'add' && r.agent) {
    saveLocalAgents({ primary: primary ?? r.agent, agents: [...agents, r.agent] }, home);
  } else if (op === 'remove' && r.agent) {
    const left = agents.filter((a) => a !== r.agent);
    saveLocalAgents({ primary: primary === r.agent ? (left[0] ?? null) : primary, agents: left }, home);
  } else if (op === 'rename' && r.agent && r.from) {
    saveLocalAgents({ primary: primary === r.from ? r.agent : primary, agents: agents.map((a) => (a === r.from ? r.agent! : a)) }, home);
  }
}
