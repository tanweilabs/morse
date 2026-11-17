import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { realExec } from './exec.js';
import { checkCliVersion, createVersionProbe } from './version-guard.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, LaunchOptions, SessionInfo } from './types.js';

const CLAUDE_GUARD = {
  cli: 'claude',
  app: 'Claude Code (desktop App)',
  upgrade: 'npm i -g @anthropic-ai/claude-code@latest',
};

const UUID_JSONL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** Max bytes read per session file; large transcripts are sampled head + tail. */
const CHUNK = 256 * 1024;
const TITLE_MAX = 80;

/**
 * Post-turn lifecycle hooks (Stop / SessionEnd / SubagentStop) fire AFTER the
 * turn's work has run and been persisted to the transcript. A non-zero exit whose
 * failure is one of these does NOT mean the message failed to deliver — the turn
 * already ran. Verified 2026-09-05 (ADR-023): a user's SessionEnd hook choking on
 * a 495MB transcript ("Hook cancelled") made `claude -p` exit 1, so Morse
 * false-failed and retried 3× — re-injecting duplicates — before dead-lettering
 * messages that had physically landed 10× in the target transcript.
 */
const POST_TURN_HOOK_FAILURE_RE = /\b(?:Stop|SessionEnd|SubagentStop) hook\b[^\n]*\bfailed\b/;

function isPostTurnHookFailure(stderr: string): boolean {
  return POST_TURN_HOOK_FAILURE_RE.test(stderr);
}

/**
 * CLI-level auth failures: the headless `claude` login expired or was never done.
 * These never self-heal by retrying — the operator must sign the CLI back in — so
 * we stop retrying and return a clear, actionable error instead of a cryptic
 * "exited 1". (Verified 2026-09-05: a Codex→Claude delivery surfaced "OAuth session
 * expired and could not be refreshed"; re-logging into the desktop app does not
 * necessarily refresh the CLI token. Live sessions are unaffected — they receive via
 * the pull hook inside their own already-authenticated process, not headless resume.)
 */
export function isAuthFailure(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return /not logged in/i.test(stdout) || /oauth[^\n]{0,40}expired/i.test(combined);
}

/** Permission modes a launch setting may ask for. Anything that bypasses or skips
 *  permission checks is refused here, whatever the config says (ADR-054). */
export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk'] as const;
const BYPASS_RE = /bypass|skip|danger|yolo/i;
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const BASH_PREFIX_RE = /^Bash\([A-Za-z0-9][A-Za-z0-9 ._/-]*:\*\)$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/;
/** `claude --resume <id>` for a session that does not exist (nothing ran). */
export const MISSING_SESSION_RE = /no conversation found/i;
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Throws on anything a launch setting must not contain. Returns the same object. */
export function checkClaudeLaunch(launch: LaunchOptions): LaunchOptions {
  const mode = launch.permissionMode;
  if (mode !== undefined) {
    if (BYPASS_RE.test(mode)) throw new Error(`permissionMode "${mode}": bypass-style permission modes are never allowed`);
    if (!(CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) throw new Error(`permissionMode "${mode}": use one of ${CLAUDE_PERMISSION_MODES.join(', ')}`);
  }
  for (const t of launch.allowedTools ?? []) {
    // a bare "Bash" would allow every shell command: only a fixed command prefix is accepted
    if (BYPASS_RE.test(t) || t === 'Bash' || (!TOOL_RE.test(t) && !BASH_PREFIX_RE.test(t))) throw new Error(`allowedTools: "${t}" is not a tool name or Bash(<fixed command prefix>:*)`);
  }
  if (launch.model !== undefined && !MODEL_RE.test(launch.model)) throw new Error(`model "${launch.model}": not a model name`);
  if (launch.effort !== undefined && !(CLAUDE_EFFORTS as readonly string[]).includes(launch.effort)) throw new Error(`effort "${launch.effort}": use one of ${CLAUDE_EFFORTS.join(', ')}`);
  if (launch.timeoutMs !== undefined && !(Number.isFinite(launch.timeoutMs) && launch.timeoutMs >= 1000)) throw new Error('timeout: at least 1 s');
  if (launch.appendSystemPrompt !== undefined && typeof launch.appendSystemPrompt !== 'string') throw new Error('appendSystemPrompt: text');
  if (launch.createSession !== undefined && typeof launch.createSession !== 'boolean') throw new Error('createSession: true or false');
  return launch;
}

/** argv for one headless resume. The prompt is the last argument; flags come before it. */
export function claudeArgs(sessionId: string, prompt: string, launch?: LaunchOptions): string[] {
  if (!launch) return ['-p', '--resume', sessionId, prompt];
  checkClaudeLaunch(launch);
  const args = ['-p'];
  if (launch.model) args.push('--model', launch.model);
  if (launch.effort) args.push('--effort', launch.effort);
  if (launch.permissionMode) args.push('--permission-mode', launch.permissionMode);
  if (launch.allowedTools?.length) args.push('--allowedTools', launch.allowedTools.join(','));
  // Claude Code records the system prompt on a conversation's first request and replays
  // it on resume; with the snapshot off the appended text reaches older sessions too
  if (launch.appendSystemPrompt) args.push('--append-system-prompt', launch.appendSystemPrompt, '--system-prompt-snapshot', 'off');
  // ADR-056: a profile's dedicated session is created with an id we choose, then resumed
  if (launch.createSession) {
    if (!SESSION_UUID_RE.test(sessionId)) throw new Error(`createSession: "${sessionId}" is not a session id`);
    args.push('--session-id', sessionId, '--', prompt);
  } else args.push('--resume', sessionId, '--', prompt);
  return args;
}

interface ClaudeAdapterOptions {
  projectsDir?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
}

interface ParsedLine {
  type?: string;
  cwd?: string;
  version?: string;
  customTitle?: string;
  message?: { content?: unknown };
}

/** System-wrapped user turns (command caveats etc.) are not usable as titles. */
const NON_TITLE_PREFIXES = ['<local-command-caveat>', 'Caveat:', '<command-name>', '<system-reminder>'];

function usableTitle(text: string): string | undefined {
  const t = text.trim();
  if (!t || NON_TITLE_PREFIXES.some((p) => t.startsWith(p))) return undefined;
  return t;
}

function extractUserText(line: ParsedLine): string | undefined {
  const content = line.message?.content;
  if (typeof content === 'string') return usableTitle(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: string }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        const usable = usableTitle((part as { text: string }).text);
        if (usable) return usable;
      }
    }
  }
  return undefined;
}

function parseLines(raw: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ParsedLine);
    } catch {
      // truncated sample boundaries and corrupt lines are expected — skip
    }
  }
  return out;
}

async function sampleFile(path: string, size: number): Promise<string> {
  if (size <= CHUNK * 2) return readFile(path, 'utf8');
  const fd = await import('node:fs/promises').then((m) => m.open(path, 'r'));
  try {
    const head = Buffer.alloc(CHUNK);
    const tail = Buffer.alloc(CHUNK);
    await fd.read(head, 0, CHUNK, 0);
    await fd.read(tail, 0, CHUNK, size - CHUNK);
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
  } finally {
    await fd.close();
  }
}

async function readSession(path: string, mtimeMs: number, size: number): Promise<SessionInfo | null> {
  const lines = parseLines(await sampleFile(path, size));
  if (lines.length === 0) return null;

  let cwd = '';
  let lastCustomTitle: string | undefined;
  let firstUserText: string | undefined;
  let writerVersion: string | undefined;
  for (const line of lines) {
    if (!cwd && typeof line.cwd === 'string') cwd = line.cwd;
    if (typeof line.version === 'string') writerVersion = line.version; // last writer wins
    if (line.type === 'custom-title' && typeof line.customTitle === 'string') {
      lastCustomTitle = line.customTitle;
    }
    if (firstUserText === undefined && line.type === 'user') {
      const text = extractUserText(line);
      if (text !== undefined) firstUserText = text;
    }
  }

  const title = (lastCustomTitle ?? firstUserText ?? basename(cwd) ?? '').trim() || 'untitled';
  return {
    agent: 'claude',
    sessionId: basename(path, '.jsonl'),
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title,
    cwd,
    lastActiveAt: mtimeMs,
    ...(writerVersion ? { writerVersion } : {}),
  };
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): DeliveryAdapter {
  const projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects');
  const exec = options.exec ?? realExec;
  const timeoutMs = options.deliverTimeoutMs ?? 300_000;
  const probeVersion = createVersionProbe(exec, 'claude');
  const preflight = (session: SessionInfo) => checkCliVersion(probeVersion, CLAUDE_GUARD, session.writerVersion);

  return {
    agent: 'claude',
    preflight,

    // Verified 2026-08-05: -p --resume keeps the session id stable but REQUIRES
    // running from the session's project cwd (spec §9 R1). Needs CLI login —
    // fails cleanly with "Not logged in" until the user runs claude /login once.
    async deliver(session: SessionInfo, envelope: string, launch?: LaunchOptions): Promise<DeliveryResult> {
      if (!session.cwd) {
        return { ok: false, error: 'claude delivery requires the session cwd (unknown for this session)' };
      }
      let args: string[];
      try {
        args = claudeArgs(session.sessionId, envelope, launch);
      } catch (e) {
        return { ok: false, retry: false, error: e instanceof Error ? e.message : String(e) };
      }
      // An older CLI can't resume what a newer App wrote — refuse loudly, don't retry (ADR-025).
      const mismatch = await preflight(session);
      if (mismatch) return { ok: false, retry: false, error: mismatch };
      const runFor = launch?.timeoutMs ?? timeoutMs;
      const { stdout, stderr, code } = await exec('claude', args, {
        cwd: session.cwd,
        timeoutMs: runFor,
      });
      // ADR-054: with launch settings, a timeout is final — the turn already ran, and running
      // it again 30 s later would do the work twice
      if (launch && code === 124 && /timeout after/.test(stderr)) {
        return { ok: false, retry: false, error: `claude did not finish within ${Math.round(runFor / 1000)} s` };
      }
      // ADR-056: the session to resume does not exist (deleted, or started elsewhere) —
      // nothing ran; the dispatch plugin may start a profile's dedicated session afresh
      if (code !== 0 && !launch?.createSession && MISSING_SESSION_RE.test(`${stdout}\n${stderr}`)) {
        return { ok: false, retry: false, missingSession: true, error: `claude: no conversation found with session id ${session.sessionId}` };
      }
      // Auth failures don't self-heal by retrying — surface a clear, non-retryable
      // hint (checked regardless of exit code). ADR-008/ADR-023.
      if (isAuthFailure(stdout, stderr)) {
        return {
          ok: false,
          retry: false,
          error:
            'claude CLI auth expired / not logged in — run `claude` and sign in to restore headless delivery ' +
            '(live sessions still receive via the pull hook; only resume to a CLOSED session needs this). See ADR-008.',
        };
      }
      if (code !== 0) {
        // Only a post-turn lifecycle hook failed (e.g. SessionEnd choking on a huge
        // transcript) and the turn still produced output → the message WAS delivered
        // and persisted; treat as success rather than retrying (which duplicates the
        // injected turn) or dead-lettering it. ADR-023.
        if (isPostTurnHookFailure(stderr) && stdout.trim().length > 0) {
          return { ok: true, output: stdout };
        }
        return { ok: false, error: `claude -p --resume exited ${code}: …${stderr.slice(-500)}` };
      }
      return { ok: true, output: stdout };
    },
    async listSessions(): Promise<SessionInfo[]> {
      let projectDirs: string[];
      try {
        projectDirs = (await readdir(projectsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => join(projectsDir, e.name));
      } catch {
        return []; // claude not installed / no sessions yet
      }

      const sessions: SessionInfo[] = [];
      for (const dir of projectDirs) {
        let files: string[];
        try {
          files = (await readdir(dir)).filter((f) => UUID_JSONL_RE.test(f));
        } catch {
          continue;
        }
        for (const file of files) {
          const path = join(dir, file);
          try {
            const st = await stat(path);
            const info = await readSession(path, st.mtimeMs, st.size);
            if (info) sessions.push(info);
          } catch {
            // unreadable session file — skip rather than fail the whole scan
          }
        }
      }
      return sessions;
    },
  };
}
