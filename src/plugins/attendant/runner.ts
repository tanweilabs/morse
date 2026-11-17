import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAuthFailure, MISSING_SESSION_RE } from '../../adapters/claude.js';
import type { ExecFn } from '../../adapters/types.js';
import type { AttendantProfile } from './config.js';

/**
 * How one attendant turn is launched (ADR-059). Verified against claude 2.1.316 and
 * codex-cli 0.153.4 — docs/research/research-claude-attendant-2026-11.md.
 *
 * Claude: `claude -p --output-format json --restricted --strict-mcp-config --settings <hook>
 *   --tools … --permission-mode … --permission-prompts none [--allowedTools …]
 *   [--disallowedTools …] [--model …] [--effort …] --max-turns N
 *   --append-system-prompt <rules> --system-prompt-snapshot off
 *   (--session-id <new> | --resume <id>) -- <prompt>`, run in the profile's cwd.
 *   --restricted: user / project / local settings are ignored (no `allow: Bash(*)` or
 *   bypass default leaks in), the file tools are confined to cwd, Bash and WebFetch exist
 *   only when --tools names them. --permission-prompts none: what would ask is denied.
 *   The conversation-only default (ADR-066): `--tools ""` + `--disable-slash-commands` —
 *   no tool at all (the init event lists tools [], mcp_servers [], skills []).
 *
 * Codex (only with allowUnscopedReads): `codex exec --json -o <file> --sandbox <mode>
 *   --skip-git-repo-check --ignore-user-config --ignore-rules -C <cwd>
 *   -c approval_policy="never" [-m …] [resume <thread>] <prompt>`.
 */

export interface TurnInput {
  profile: AttendantProfile;
  /** The session / thread to resume; null = start a new one (`newId` for Claude). */
  sessionId: string | null;
  newId: string;
  prompt: string;
  systemPrompt: string;
  /** For the PreToolUse hook (Claude). */
  hookCommand: string;
  runId: string;
  /** Where the run's scratch files go (settings, codex output). */
  runDir: string;
  env: NodeJS.ProcessEnv;
}

export interface TurnResult {
  ok: boolean;
  /** The session / thread id the turn ran in (a new one when created). */
  sessionId: string | null;
  /** The agent's final answer. */
  text: string;
  error?: string;
  /** The session to resume is gone — nothing ran. */
  missingSession?: boolean;
  /** Don't try again (auth, timeout, bad flags): the owner has to look. */
  terminal?: boolean;
  /** Codex: actions it says need approval (NEEDS_APPROVAL: …). */
  needsApproval?: string[];
  /** Claude: tool calls that were refused (from the JSON result). */
  denials?: Array<{ tool: string; input: unknown }>;
}

/** The settings file of one turn: only the PreToolUse hook (a settings file that fails validation is ignored in -p mode, so keep it minimal). */
export function hookSettings(hookCommand: string): object {
  return { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand, timeout: 30 }] }] } };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The hook's shell command: the plugin itself, failing closed (a crash exits 2 = blocked). */
export function hookCommandFor(argv: string[], runId: string, stateDir: string): string {
  return `${[...argv, 'hook', 'pretool', '--run', runId, '--state', stateDir].map(shq).join(' ')} || exit 2`;
}

export function claudeAttendantArgs(t: Pick<TurnInput, 'profile' | 'sessionId' | 'newId' | 'prompt' | 'systemPrompt'>, settingsPath: string): string[] {
  const p = t.profile;
  const args = ['-p', '--output-format', 'json', '--restricted', '--strict-mcp-config', '--settings', settingsPath, '--tools', p.tools.join(','), '--permission-mode', p.launch.permissionMode, '--permission-prompts', 'none'];
  // ADR-066: the default profile has no tools at all — `--tools ""` (no built-in tool), no MCP
  // (--strict-mcp-config), no skills or commands (verified on 2.1.316: docs/research/research-attendant-no-tools-2026-11.md)
  if (p.conversationOnly) args.push('--disable-slash-commands');
  if (p.launch.allowedTools?.length) args.push('--allowedTools', p.launch.allowedTools.join(','));
  if (p.disallowedTools.length) args.push('--disallowedTools', p.disallowedTools.join(','));
  if (p.launch.model) args.push('--model', p.launch.model);
  if (p.launch.effort) args.push('--effort', p.launch.effort);
  args.push('--max-turns', String(p.maxTurns));
  const system = [t.systemPrompt, p.launch.appendSystemPrompt].filter(Boolean).join('\n\n');
  args.push('--append-system-prompt', system, '--system-prompt-snapshot', 'off');
  if (t.sessionId) args.push('--resume', t.sessionId);
  else args.push('--session-id', t.newId);
  args.push('--', t.prompt);
  return args;
}

export function codexAttendantArgs(t: Pick<TurnInput, 'profile' | 'sessionId' | 'prompt'>, outFile: string): string[] {
  const p = t.profile;
  const args = ['exec', '--json', '-o', outFile, '--sandbox', p.sandbox, '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-C', p.cwd, '-c', 'approval_policy="never"'];
  if (p.launch.model) args.push('-m', p.launch.model);
  if (p.launch.effort) args.push('-c', `model_reasoning_effort="${p.launch.effort}"`);
  if (t.sessionId) args.push('resume', t.sessionId);
  args.push(t.prompt);
  return args;
}

const lastJson = (stdout: string): Record<string, unknown> | null => {
  const lines = stdout.trim().split('\n').reverse();
  for (const l of lines) {
    const s = l.trim();
    if (!s.startsWith('{')) continue;
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      /* not this one */
    }
  }
  return null;
};

const NEEDS_APPROVAL_RE = /^\s*NEEDS_APPROVAL:\s*(.+)$/gm;

/** Codex's final message without its NEEDS_APPROVAL lines, and those actions. */
export function splitApprovals(text: string): { text: string; actions: string[] } {
  const actions = [...text.matchAll(NEEDS_APPROVAL_RE)].map((m) => m[1]!.trim()).filter(Boolean);
  return { text: text.replace(NEEDS_APPROVAL_RE, '').trim(), actions };
}

const UNKNOWN_FLAG_RE = /unknown option|unexpected argument|unrecognized/i;

export async function runTurn(exec: ExecFn, t: TurnInput): Promise<TurnResult> {
  mkdirSync(t.runDir, { recursive: true, mode: 0o700 });
  const p = t.profile;
  const timeoutMs = p.launch.timeoutMs ?? 600_000;
  if (p.agent === 'claude') {
    const settingsPath = join(t.runDir, `${t.runId}.settings.json`);
    writeFileSync(settingsPath, JSON.stringify(hookSettings(t.hookCommand)), { mode: 0o600 });
    try {
      const { stdout, stderr, code } = await exec('claude', claudeAttendantArgs(t, settingsPath), { cwd: p.cwd, timeoutMs, env: t.env });
      if (code === 124 && /timeout after/.test(stderr)) return { ok: false, sessionId: t.sessionId ?? t.newId, text: '', terminal: true, error: `claude did not finish within ${Math.round(timeoutMs / 1000)} s` };
      if (t.sessionId && code !== 0 && MISSING_SESSION_RE.test(`${stdout}\n${stderr}`)) return { ok: false, sessionId: t.sessionId, text: '', missingSession: true, error: `no conversation ${t.sessionId}` };
      if (isAuthFailure(stdout, stderr)) return { ok: false, sessionId: t.sessionId, text: '', terminal: true, error: 'claude CLI is not logged in (or the login expired) — run `claude` once and sign in' };
      if (code !== 0 && UNKNOWN_FLAG_RE.test(stderr)) return { ok: false, sessionId: t.sessionId, text: '', terminal: true, error: `this claude CLI does not take the attendant's flags (verified on 2.1.316): …${stderr.slice(-300)}` };
      const j = lastJson(stdout);
      if (!j) return { ok: false, sessionId: t.sessionId, text: '', error: `claude exited ${code} without a JSON result: …${(stderr || stdout).slice(-300)}` };
      const sid = typeof j['session_id'] === 'string' ? j['session_id'] : (t.sessionId ?? t.newId);
      const denials = Array.isArray(j['permission_denials']) ? (j['permission_denials'] as Array<{ tool_name?: string; tool_input?: unknown }>).map((d) => ({ tool: String(d.tool_name ?? ''), input: d.tool_input })) : [];
      const text = typeof j['result'] === 'string' ? j['result'] : '';
      if (j['is_error'] === true || (j['subtype'] && j['subtype'] !== 'success')) {
        return { ok: false, sessionId: sid, text, denials, terminal: true, error: `claude ended with ${String(j['subtype'] ?? 'an error')}${text ? `: ${text.slice(0, 200)}` : ''}` };
      }
      return { ok: true, sessionId: sid, text, denials };
    } finally {
      rmSync(settingsPath, { force: true });
    }
  }
  // codex
  const outFile = join(t.runDir, `${t.runId}.last.txt`);
  try {
    const { stdout, stderr, code } = await exec('codex', codexAttendantArgs(t, outFile), { cwd: p.cwd, timeoutMs, env: t.env });
    if (code === 124) return { ok: false, sessionId: t.sessionId, text: '', terminal: true, error: `codex did not finish within ${Math.round(timeoutMs / 1000)} s` };
    let thread = t.sessionId;
    let last = '';
    for (const line of stdout.split('\n')) {
      try {
        const e = JSON.parse(line) as { type?: string; thread_id?: string; item?: { type?: string; text?: string } };
        if (e.type === 'thread.started' && e.thread_id) thread = e.thread_id;
        if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') last = e.item.text;
      } catch {
        /* not an event */
      }
    }
    if (t.sessionId && code !== 0 && /no (rollout|session|thread|conversation)[^\n]*found|not found/i.test(stderr)) return { ok: false, sessionId: t.sessionId, text: '', missingSession: true, error: `no codex thread ${t.sessionId}` };
    if (code !== 0) return { ok: false, sessionId: thread, text: '', ...(UNKNOWN_FLAG_RE.test(stderr) ? { terminal: true } : {}), error: `codex exec exited ${code}: …${stderr.slice(-300)}` };
    let final = last;
    try {
      final = readFileSync(outFile, 'utf8') || last;
    } catch {
      /* no file: the events had it */
    }
    const { text, actions } = splitApprovals(final);
    return { ok: true, sessionId: thread, text, ...(actions.length ? { needsApproval: actions } : {}) };
  } finally {
    rmSync(outFile, { force: true });
  }
}
