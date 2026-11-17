import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isInside } from './config.js';

/**
 * Approvals (ADR-060). A Claude Code PreToolUse hook (`hook pretool --run <id>`) sees every
 * tool call of an attendant turn before it runs:
 *
 *   - a call that touches a private place (deny paths)        -> deny, nothing filed
 *   - the one action the owner approved for this run (once)   -> allow
 *   - a call that matches the profile's approval patterns     -> deny + an approval request
 *   - anything else                                           -> no opinion (Claude's own
 *     permissions decide: --restricted, --tools, --allowedTools, the permission mode)
 *
 * The hook only ever turns a call into a request; it never widens what the profile allows,
 * except the single approved action — and even that stays inside the working directory
 * (verified: --restricted confines the file tools even when a hook allows; see
 * docs/research/research-claude-attendant-2026-11.md).
 *
 * Files under ~/.morse/plugins/attendant/ (0700, files 0600):
 *   runs/<run id>.json        what the hook needs for one turn (patterns, deny paths, grant)
 *   approvals/<id>.json       one request: pending -> approved | rejected | expired -> done
 */

/** A pending request expires after a week. */
export const APPROVAL_MAX_AGE_MS = 7 * 86_400_000;

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'done';

export interface ApprovalRequest {
  id: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
  /** When the plugin acted on the decision (re-ran the turn, or sent the refusal). */
  closedAt?: number;
  runId: string;
  /** The lane: your agent + the contact. */
  lane: string;
  agent: string;
  contact: { id: string; handle: string | null; remark: string | null; group: string };
  /** The messages the turn answered, and the one the reply goes to. */
  messageIds: string[];
  replyTo: string;
  tool: string;
  /** What identifies the action: the command, the file, the URL … */
  key: string;
  /** The tool input as Claude gave it (shortened). */
  input: string;
  pattern: string;
  outcome?: string;
}

/** One turn as the hook sees it (runs/<id>.json). */
export interface RunFile {
  runId: string;
  lane: string;
  agent: string;
  contact: ApprovalRequest['contact'];
  messageIds: string[];
  replyTo: string;
  cwd: string;
  approvals: string[];
  denyPaths: string[];
  /** The approved action: allowed once in this run. */
  grant?: { approvalId: string; tool: string; key: string; used?: boolean };
}

const FILE_KEYS = ['file_path', 'notebook_path', 'path'] as const;

/** What identifies a tool call for matching and approval. */
export function actionKey(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input['command'] === 'string') return input['command'].trim();
  for (const k of FILE_KEYS) if (typeof input[k] === 'string') return resolve(String(input[k]));
  if (typeof input['url'] === 'string') return input['url'];
  if (typeof input['query'] === 'string') return input['query'];
  return stableJson(input);
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');

/** Shell commands inside one Bash command line (split on ; && || | newlines and $( … ). */
export function subCommands(command: string): string[] {
  return command
    .split(/\n|;|&&|\|\||\||\$\(|`|\(|\)/)
    .map((s) => s.trim().replace(/^(sudo|exec|command|nohup|env(\s+\w+=\S*)*)\s+/, ''))
    .filter(Boolean);
}

/** The approval pattern this call matches, or null. `Tool`, `Tool(glob)`, `mcp__*`. */
export function matchPattern(patterns: string[], tool: string, key: string): string | null {
  for (const p of patterns) {
    const m = /^([^()]+?)(?:\((.*)\))?$/s.exec(p.trim());
    if (!m) continue;
    if (!globRe(m[1]!).test(tool)) continue;
    if (m[2] === undefined) return p;
    const arg = globRe(m[2]);
    const candidates = tool === 'Bash' ? [key, ...subCommands(key)] : [key];
    if (candidates.some((c) => arg.test(c))) return p;
  }
  return null;
}

/** Does this call name a private place (a path in its input, or in a shell command)? */
export function touchesDenied(tool: string, input: Record<string, unknown>, deny: string[], home: string): string | null {
  const paths: string[] = [];
  for (const k of FILE_KEYS) if (typeof input[k] === 'string') paths.push(resolve(String(input[k])));
  for (const d of deny) {
    if (paths.some((p) => isInside(p, d))) return d;
  }
  // shell commands and anything else: the private path written out (absolute or ~/…)
  const text = tool === 'Bash' && typeof input['command'] === 'string' ? input['command'] : stableJson(input);
  for (const d of deny) {
    const tilde = d.startsWith(`${home}/`) ? `~/${d.slice(home.length + 1)}` : null;
    if (text.includes(d) || (tilde && text.includes(tilde)) || (tilde && text.includes(`$HOME/${tilde.slice(2)}`))) return d;
  }
  return null;
}

export interface HookAnswer {
  decision: 'allow' | 'deny' | null;
  reason?: string;
  approval?: ApprovalRequest;
}

/** The hook's JSON on stdout for an answer (null decision = say nothing). */
export function hookOutput(a: HookAnswer): string {
  if (!a.decision) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: a.decision, permissionDecisionReason: a.reason ?? '' } });
}

export const newApprovalId = (): string => randomBytes(4).toString('hex');

export interface ApprovalStore {
  dir: string;
  get(id: string): ApprovalRequest | null;
  put(a: ApprovalRequest): void;
  list(): ApprovalRequest[];
  /** Pending ones older than `maxAgeMs` become expired. Returns them. */
  expire(now: number, maxAgeMs: number): ApprovalRequest[];
  writeRun(r: RunFile): void;
  readRun(runId: string): RunFile | null;
  removeRun(runId: string): void;
}

const RUN_ID_RE = /^[A-Za-z0-9-]{6,64}$/;

function writeJson(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function createApprovalStore(stateDir: string): ApprovalStore {
  const dir = join(stateDir, 'approvals');
  const runs = join(stateDir, 'runs');
  const ensure = () => {
    for (const d of [stateDir, dir, runs]) mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
  };
  const read = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      return null;
    }
  };
  const store: ApprovalStore = {
    dir,
    get(id) {
      if (!/^[0-9a-f]{8}$/.test(id)) return null;
      return read(join(dir, `${id}.json`)) as ApprovalRequest | null;
    },
    put(a) {
      ensure();
      writeJson(join(dir, `${a.id}.json`), a);
    },
    list() {
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((n) => /^[0-9a-f]{8}\.json$/.test(n));
      } catch {
        return [];
      }
      return names
        .map((n) => read(join(dir, n)) as ApprovalRequest | null)
        .filter((a): a is ApprovalRequest => Boolean(a?.id))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    expire(now, maxAgeMs) {
      const out: ApprovalRequest[] = [];
      for (const a of store.list()) {
        if (a.status === 'pending' && now - a.createdAt > maxAgeMs) {
          const next = { ...a, status: 'expired' as const, decidedAt: now };
          store.put(next);
          out.push(next);
        }
      }
      return out;
    },
    writeRun(r) {
      if (!RUN_ID_RE.test(r.runId)) throw new Error(`bad run id ${r.runId}`);
      ensure();
      writeJson(join(runs, `${r.runId}.json`), r);
    },
    readRun(runId) {
      if (!RUN_ID_RE.test(runId)) return null;
      return read(join(runs, `${runId}.json`)) as RunFile | null;
    },
    removeRun(runId) {
      if (RUN_ID_RE.test(runId)) rmSync(join(runs, `${runId}.json`), { force: true });
    },
  };
  return store;
}

const short = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * The hook's decision for one PreToolUse call. Files the approval request itself (one per
 * distinct action and run — the same action asked twice in a turn reuses it).
 */
export function decidePreTool(payload: { tool_name?: unknown; tool_input?: unknown }, run: RunFile | null, store: ApprovalStore, home: string, now: number = Date.now()): HookAnswer {
  if (!run) return { decision: 'deny', reason: '[Morse attendant] unknown run — refused' };
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? (payload.tool_input as Record<string, unknown>) : {};
  if (!tool) return { decision: 'deny', reason: '[Morse attendant] no tool name — refused' };
  const denied = touchesDenied(tool, input, run.denyPaths, home);
  if (denied) return { decision: 'deny', reason: `[Morse attendant] refused: that is your owner's private material (${denied}). Do not try another way.` };
  const key = actionKey(tool, input);
  if (run.grant && !run.grant.used && run.grant.tool === tool && run.grant.key === key) {
    run.grant.used = true;
    store.writeRun(run);
    return { decision: 'allow', reason: `[Morse attendant] approved by your owner (request ${run.grant.approvalId}) — this one time` };
  }
  const pattern = matchPattern(run.approvals, tool, key);
  if (!pattern) return { decision: null };
  const existing = store.list().find((a) => a.runId === run.runId && a.tool === tool && a.key === key && a.status === 'pending');
  const approval: ApprovalRequest = existing ?? {
    id: newApprovalId(),
    status: 'pending',
    createdAt: now,
    runId: run.runId,
    lane: run.lane,
    agent: run.agent,
    contact: run.contact,
    messageIds: run.messageIds,
    replyTo: run.replyTo,
    tool,
    key: short(key, 500),
    input: short(stableJson(input)),
    pattern,
  };
  if (!existing) store.put(approval);
  return {
    decision: 'deny',
    approval,
    reason: `[Morse attendant] This action needs your owner's approval (request ${approval.id}). Do not try it another way. Stop here and say in one short sentence that you are waiting for your owner's approval.`,
  };
}

/** Environment variables that mean "running inside an AI agent", not a person at a terminal. */
export const AGENT_ENV_MARKERS = [
  'MORSE_ATTENDANT_RUN',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'AI_AGENT',
  'GEMINI_CLI',
  'KIMI_CLI',
];

/** Why this process may not decide an approval, or null (a person at a terminal). */
export function humanCheck(env: NodeJS.ProcessEnv, tty: { stdin: boolean; stdout: boolean }): string | null {
  const marker = AGENT_ENV_MARKERS.find((k) => env[k] !== undefined && env[k] !== '');
  if (marker) return `refused: this runs inside an AI agent (${marker} is set) — only you, in your own terminal, can decide an approval`;
  if (!tty.stdin || !tty.stdout) return 'refused: not an interactive terminal — run it yourself in a terminal';
  return null;
}
