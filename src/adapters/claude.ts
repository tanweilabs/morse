import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_TURN_MS, objectLines, shortTitle, tailOf } from './common.js';
import { realExec } from './exec.js';
import { checkCliVersion, createVersionProbe } from './version-guard.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, LaunchOptions, SessionInfo } from './types.js';

interface ClaudeSetup {
  projectsDir?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
}

const GUARD = { cli: 'claude', app: 'Claude Code (desktop App)', upgrade: 'npm i -g @anthropic-ai/claude-code@latest' };

/**
 * Is the headless CLI signed out? Either it says "Not logged in" on stdout, or its OAuth
 * session expired and could not be refreshed. Retrying never fixes that — someone has to
 * sign the CLI in again — so delivery stops with an error that says so. (2026-09-05: a
 * Codex → Claude delivery hit "OAuth session expired and could not be refreshed"; signing
 * in to the desktop App does not necessarily renew the CLI's token. Open sessions are not
 * affected: they take mail through the pull hook inside their own signed-in process.)
 */
export function isAuthFailure(stdout: string, stderr: string): boolean {
  if (/not logged in/i.test(stdout)) return true;
  return /oauth[^\n]{0,40}expired/i.test(`${stdout}\n${stderr}`);
}

const SIGNED_OUT =
  'claude CLI auth expired / not logged in — run `claude` and sign in to restore headless delivery ' +
  '(live sessions still receive via the pull hook; only resume to a CLOSED session needs this). See ADR-008.';

/**
 * Stop, SessionEnd and SubagentStop hooks run after the turn has been done and saved to
 * the transcript. When one of them fails, `claude -p` exits non-zero although the message
 * was delivered (ADR-023, 2026-09-05: a SessionEnd hook giving up on a 495 MB transcript
 * — "Hook cancelled" — made every delivery look failed; three retries each put the same
 * message into the transcript again, ten copies before it was dead-lettered).
 */
function onlyAfterTurnHookFailed(stderr: string): boolean {
  return /\b(?:Stop|SessionEnd|SubagentStop) hook\b[^\n]*\bfailed\b/.test(stderr);
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

/* ── session discovery: ~/.claude/projects/<escaped cwd>/<uuid>.jsonl ── */

/** Transcript files are named after the session's uuid (lower-case hex). */
const TRANSCRIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
/** A transcript over twice this size is only read at its first and its last SAMPLE_BYTES. */
const SAMPLE_BYTES = 256 * 1024;
/** User records that start like this are wrappers Claude Code adds, not something the user typed. */
const WRAPPER_PREFIXES = ['<local-command-caveat>', 'Caveat:', '<command-name>', '<system-reminder>'];

interface TranscriptRecord {
  type?: unknown;
  cwd?: unknown;
  version?: unknown;
  customTitle?: unknown;
  message?: { content?: unknown } | null;
}

async function readSample(path: string, size: number): Promise<string> {
  if (size <= 2 * SAMPLE_BYTES) return readFile(path, 'utf8');
  const file = await open(path, 'r');
  try {
    const chunkAt = async (position: number): Promise<string> => {
      const bytes = Buffer.alloc(SAMPLE_BYTES);
      await file.read(bytes, 0, SAMPLE_BYTES, position);
      return bytes.toString('utf8');
    };
    // a record cut at either edge just fails to parse and is skipped
    return `${await chunkAt(0)}\n${await chunkAt(size - SAMPLE_BYTES)}`;
  } finally {
    await file.close();
  }
}

/** Typed text worth showing as a title, trimmed; undefined for blanks and wrappers. */
function typedText(text: string): string | undefined {
  const trimmed = text.trim();
  const wrapper = WRAPPER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  return trimmed === '' || wrapper ? undefined : trimmed;
}

/** What the user typed in a user record: its string content, or the first usable text part. */
function typedPrompt(record: TranscriptRecord): string | undefined {
  const content = record.message?.content;
  if (typeof content === 'string') return typedText(content);
  if (!Array.isArray(content)) return undefined;
  for (const part of content as Array<{ type?: unknown; text?: unknown } | null>) {
    const text = part?.type === 'text' && typeof part.text === 'string' ? typedText(part.text) : undefined;
    if (text !== undefined) return text;
  }
  return undefined;
}

interface TranscriptFacts {
  /** The first cwd any record names. */
  cwd: string;
  /** The `version` of the last record that has one: who wrote the session last. */
  version?: string;
  /** The last title the user gave the session. */
  customTitle?: string;
  firstPrompt?: string;
}

function factsOf(records: TranscriptRecord[]): TranscriptFacts {
  const facts: TranscriptFacts = { cwd: '' };
  for (const record of records) {
    if (facts.cwd === '' && typeof record.cwd === 'string') facts.cwd = record.cwd;
    if (typeof record.version === 'string') facts.version = record.version;
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') facts.customTitle = record.customTitle;
    if (record.type === 'user' && facts.firstPrompt === undefined) {
      const prompt = typedPrompt(record);
      if (prompt !== undefined) facts.firstPrompt = prompt;
    }
  }
  return facts;
}

async function sessionFromTranscript(path: string): Promise<SessionInfo | null> {
  const { mtimeMs, size } = await stat(path);
  const records = objectLines<TranscriptRecord>(await readSample(path, size));
  if (records.length === 0) return null;
  const facts = factsOf(records);
  const title = (facts.customTitle ?? facts.firstPrompt ?? basename(facts.cwd)).trim() || 'untitled';
  return {
    agent: 'claude',
    sessionId: basename(path, '.jsonl'),
    title: shortTitle(title),
    cwd: facts.cwd,
    lastActiveAt: mtimeMs,
    ...(facts.version ? { writerVersion: facts.version } : {}),
  };
}

/** Every transcript path under the projects dir, one folder per project. */
async function transcriptPaths(projectsDir: string): Promise<string[]> {
  let folders: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    folders = entries.filter((e) => e.isDirectory()).map((e) => join(projectsDir, e.name));
  } catch {
    return []; // no Claude Code here, or no session yet
  }
  const paths: string[] = [];
  for (const folder of folders) {
    const names = await readdir(folder).catch(() => [] as string[]);
    for (const name of names) if (TRANSCRIPT_NAME.test(name)) paths.push(join(folder, name));
  }
  return paths;
}

/* ── delivery ── */

type Run = Awaited<ReturnType<ExecFn>>;

/** Reads a finished `claude -p` run. Checked in this order; the first that applies decides. */
function judgeRun(run: Run, session: SessionInfo, launch: LaunchOptions | undefined, budgetMs: number): DeliveryResult {
  const { stdout, stderr, code } = run;
  // ADR-054: with launch settings a timeout is final — the turn already ran, and running
  // it again 30 s later would do the work twice
  if (launch && code === 124 && /timeout after/.test(stderr)) {
    return { ok: false, retry: false, error: `claude did not finish within ${Math.round(budgetMs / 1000)} s` };
  }
  // ADR-056: the session to resume does not exist (deleted, or started elsewhere) —
  // nothing ran; the dispatch plugin may start a profile's dedicated session afresh
  if (code !== 0 && !launch?.createSession && MISSING_SESSION_RE.test(`${stdout}\n${stderr}`)) {
    return { ok: false, retry: false, missingSession: true, error: `claude: no conversation found with session id ${session.sessionId}` };
  }
  // whatever the exit code: a signed-out CLI stays signed out until someone signs it in
  if (isAuthFailure(stdout, stderr)) return { ok: false, retry: false, error: SIGNED_OUT };
  if (code === 0) return { ok: true, output: stdout };
  // a post-turn hook failed but the turn produced its answer: delivered and saved, so
  // neither a retry (a duplicate turn) nor a dead letter (ADR-023)
  if (onlyAfterTurnHookFailed(stderr) && stdout.trim() !== '') return { ok: true, output: stdout };
  return { ok: false, error: `claude -p --resume exited ${code}: …${tailOf(stderr)}` };
}

export function createClaudeAdapter(setup: ClaudeSetup = {}): DeliveryAdapter {
  const projectsDir = setup.projectsDir ?? join(homedir(), '.claude', 'projects');
  const exec = setup.exec ?? realExec;
  const defaultBudgetMs = setup.deliverTimeoutMs ?? DEFAULT_TURN_MS;
  const cliVersion = createVersionProbe(exec, 'claude');
  const preflight = (session: SessionInfo): Promise<string | null> => checkCliVersion(cliVersion, GUARD, session.writerVersion);

  return {
    agent: 'claude',
    preflight,

    // `-p --resume` keeps the session id, but only works when run from the session's own
    // project directory (checked 2026-08-05, spec §9 R1). The CLI must be signed in once
    // (`claude` → /login); until then every run says "Not logged in".
    async deliver(session: SessionInfo, envelope: string, launch?: LaunchOptions): Promise<DeliveryResult> {
      if (!session.cwd) return { ok: false, error: 'claude delivery requires the session cwd (unknown for this session)' };
      let args: string[];
      try {
        args = claudeArgs(session.sessionId, envelope, launch);
      } catch (e) {
        return { ok: false, retry: false, error: e instanceof Error ? e.message : String(e) };
      }
      // a CLI older than the App that wrote the session cannot resume it: refuse, no retry (ADR-025)
      const refusal = await preflight(session);
      if (refusal) return { ok: false, retry: false, error: refusal };
      const budgetMs = launch?.timeoutMs ?? defaultBudgetMs;
      const run = await exec('claude', args, { cwd: session.cwd, timeoutMs: budgetMs });
      return judgeRun(run, session, launch, budgetMs);
    },

    async listSessions(): Promise<SessionInfo[]> {
      const listed: SessionInfo[] = [];
      for (const path of await transcriptPaths(projectsDir)) {
        // a transcript that cannot be read is left out; the scan goes on
        const session = await sessionFromTranscript(path).catch(() => null);
        if (session) listed.push(session);
      }
      return listed;
    },
  };
}
