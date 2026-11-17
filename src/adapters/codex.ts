import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { liveCodexThreads } from '../daemon/session-liveness.js';
import { defaultConfigFile, readMachineConfig } from '../machine-config.js';
import { DEFAULT_TURN_MS, objectLines, ownerTurnBudgetMs, runOptions, shortTitle, stringField, tailOf } from './common.js';
import { realExec } from './exec.js';
import { checkCliVersion, createVersionProbe, inferWriterVersion, type WriterSample } from './version-guard.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, SessionInfo } from './types.js';

/** Error-code prefix for a thread another Codex process is writing to (ADR-026). */
export const THREAD_BUSY = 'codex_thread_busy';

interface CodexSetup {
  sessionsDir?: string;
  indexFile?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
  /** Morse machine config (~/.morse/config.json): the owner's sandbox and time limit. */
  configFile?: string;
  /** Does another Codex process (Codex Desktop) have the thread open? ADR-026, ADR-027. */
  isThreadLive?: (threadId: string) => boolean;
}

const GUARD = { cli: 'codex', app: 'Codex Desktop', upgrade: 'npm i -g @openai/codex@latest' };

/**
 * Sandbox tiers the machine owner may pick for headless turns. Never the sender's choice,
 * and never the `--dangerously-bypass-*` flag (ADR-054); `danger-full-access` is one of
 * Codex's own sandbox tiers, for an owner who wants it on their own machines.
 */
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

/** `codex queue` only adds a row to a table; it should be back within seconds. */
const QUEUE_LIMIT_MS = 30_000;

/** rollout-YYYY-MM-DDThh-mm-ss-<thread uuid>.jsonl */
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** The session_meta line can be long (it carries the base instructions); read no further than this. */
const META_LINE_LIMIT = 1024 * 1024;
const READ_STEP = 64 * 1024;

/** The owner's choices, read for each delivery so a config edit needs no daemon restart. */
function ownerChoices(configFile: string): { sandboxArgs: string[]; budgetMs: number | null } {
  const codex = readMachineConfig(configFile).codex;
  const sandbox = codex?.sandbox;
  return {
    sandboxArgs: sandbox !== undefined && SANDBOXES.has(sandbox) ? ['--sandbox', sandbox] : [],
    budgetMs: ownerTurnBudgetMs(codex?.deliverTimeoutSec),
  };
}

/** What a failed `codex exec resume` means for the sender. */
function resumeFailure(threadId: string, code: number, stderr: string, budgetMs: number): DeliveryResult {
  if (code === 124) {
    // our time limit killed the turn mid-work: it did run, so running it again repeats it
    const seconds = Math.round(budgetMs / 1000);
    return {
      ok: false,
      retry: false,
      error:
        `codex exec resume timed out after ${seconds}s — the turn ran but exceeded the budget. ` +
        'Raise codex.deliverTimeoutSec in ~/.morse/config.json, or open the session to see its progress. ' +
        `…${tailOf(stderr, 300)}`,
    };
  }
  if (/already has an active writer/.test(stderr)) {
    // Another Codex process (normally Codex Desktop) holds the thread's writer lock. The
    // dispatcher usually routes such threads elsewhere (ADR-026); this is the race, or a
    // machine without lsof. Nothing ran, and the lock belongs to a long-lived App, so a
    // retry seconds later would meet the same lock.
    return {
      ok: false,
      retry: false,
      error:
        `${THREAD_BUSY}: codex thread ${threadId} is open in another Codex process (usually Codex Desktop), ` +
        'which holds its writer lock — headless resume was refused and the message was NOT delivered. ' +
        "It will surface through the thread's prompt hook the next time the user sends it a message.",
    };
  }
  // after the banner and the echoed prompt, the real error is what stderr ends with
  return { ok: false, error: `codex exec resume exited ${code}: …${tailOf(stderr)}` };
}

/** The bytes of a file up to its first newline (or the read limit), as text; '' for an empty file. */
async function firstLine(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const kept: Buffer[] = [];
    for (let offset = 0; offset < META_LINE_LIMIT; ) {
      const step = Buffer.alloc(READ_STEP);
      const { bytesRead } = await file.read(step, 0, READ_STEP, offset);
      if (bytesRead === 0) break;
      const got = step.subarray(0, bytesRead);
      const newline = got.indexOf(0x0a);
      if (newline >= 0) {
        kept.push(got.subarray(0, newline));
        break;
      }
      kept.push(got);
      offset += bytesRead;
    }
    return Buffer.concat(kept).toString('utf8');
  } finally {
    await file.close();
  }
}

interface IndexEntry {
  name: string;
  updatedAt?: number;
}

/** ~/.codex/session_index.jsonl by thread id. It is appended to, so a later line replaces an earlier one. */
async function readIndex(indexFile: string): Promise<Map<string, IndexEntry>> {
  const entries = new Map<string, IndexEntry>();
  const text = await readFile(indexFile, 'utf8').catch(() => '');
  for (const line of objectLines<object>(text)) {
    const id = stringField(line, 'id');
    const name = stringField(line, 'thread_name');
    if (!id || name === undefined) continue;
    const updated = stringField(line, 'updated_at');
    const at = updated ? Date.parse(updated) : NaN;
    entries.set(id, Number.isNaN(at) ? { name } : { name, updatedAt: at });
  }
  return entries;
}

/**
 * For each thread, the path of its newest rollout. A thread gets a new rollout file on a new
 * day or after the App compacts it, and `codex exec resume` continues the newest one — so
 * that is the file that decides whether the thread is usable.
 */
function newestRollouts(relativePaths: string[]): Map<string, string> {
  const newest = new Map<string, string>();
  for (const rel of relativePaths) {
    const name = basename(rel);
    const thread = ROLLOUT_NAME.exec(name)?.[1];
    if (!thread) continue;
    const current = newest.get(thread);
    if (current === undefined || basename(current).localeCompare(name) < 0) newest.set(thread, rel);
  }
  return newest;
}

interface SessionMeta {
  cwd?: unknown;
  parent_thread_id?: unknown;
  thread_source?: unknown;
  cli_version?: unknown;
  originator?: unknown;
  timestamp?: unknown;
}

/** A thread as found on disk, before its writer version is worked out. */
interface Candidate {
  session: SessionInfo;
  recorded?: string;
  originator?: string;
}

export function createCodexAdapter(setup: CodexSetup = {}): DeliveryAdapter {
  const sessionsDir = setup.sessionsDir ?? join(homedir(), '.codex', 'sessions');
  const indexFile = setup.indexFile ?? join(homedir(), '.codex', 'session_index.jsonl');
  const exec = setup.exec ?? realExec;
  const configFile = setup.configFile ?? defaultConfigFile();
  const isLive = setup.isThreadLive ?? ((threadId: string) => liveCodexThreads().has(threadId));
  const cliVersion = createVersionProbe(exec, 'codex');

  // A queued message is only a row in Codex's own queue — nothing is resumed, so an older
  // global CLI does no harm there (checked from 0.157.1 against 0.162-alpha). ADR-027.
  const preflight = async (session: SessionInfo): Promise<string | null> =>
    isLive(session.sessionId) ? null : checkCliVersion(cliVersion, GUARD, session.writerVersion);

  /**
   * Codex Desktop keeps a thread it has open locked against `exec resume`, but it watches the
   * shared queue (~/.codex/queue_1.sqlite) for its loaded threads and runs what is queued
   * within seconds (checked 2026-10-13 on a scratch thread, ADR-027). No stdout comes back,
   * so the reply arrives through `anyd reply` — see replyChannel.
   */
  async function enqueue(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
    const argv = ['queue', '--thread', session.sessionId, '--message', envelope];
    const run = await exec('codex', argv, runOptions(session.cwd, QUEUE_LIMIT_MS));
    if (run.code === 0) return { ok: true, output: '', inSession: true };
    return { ok: false, error: `codex queue exited ${run.code}: …${tailOf(run.stderr || run.stdout)}` };
  }

  /** One rollout's session_meta → a candidate, also noting the sighting of its originator's version. */
  async function inspect(threadId: string, rel: string, index: Map<string, IndexEntry>, sightings: WriterSample[]): Promise<Candidate | null> {
    const path = join(sessionsDir, rel);
    const line = await firstLine(path);
    if (!line) return null;
    const head = JSON.parse(line) as { type?: unknown; payload?: SessionMeta };
    if (head.type !== 'session_meta') return null;
    const meta = head.payload;
    const recorded = stringField(meta, 'cli_version');
    const originator = stringField(meta, 'originator');
    const createdAt = typeof meta?.timestamp === 'string' && meta.timestamp ? Date.parse(meta.timestamp) : NaN;
    // the creation of any rollout shows which version its originator was running then (ADR-025)
    if (recorded && originator && !Number.isNaN(createdAt)) sightings.push({ originator, version: recorded, at: createdAt });
    // sub-agent threads are driven by their parent and reject direct input (app-server -32600)
    if (meta?.parent_thread_id || meta?.thread_source === 'subagent') return null;
    const cwd = stringField(meta, 'cwd') ?? '';
    const listed = index.get(threadId);
    const { mtimeMs } = await stat(path);
    return {
      session: {
        agent: 'codex',
        sessionId: threadId,
        title: shortTitle((listed?.name ?? basename(cwd)).trim() || 'untitled'),
        cwd,
        // the App does not bump the index on every turn, while the rollout file changes with each — take the later
        lastActiveAt: Math.max(listed?.updatedAt ?? 0, mtimeMs),
      },
      ...(recorded ? { recorded } : {}),
      ...(originator ? { originator } : {}),
    };
  }

  return {
    agent: 'codex',
    preflight,
    replyChannel: (session: SessionInfo) => (isLive(session.sessionId) ? 'command' : 'marker'),

    // `codex exec resume` brings the whole history, does not depend on the cwd and copes with
    // concurrent resumes of one thread (checked 2026-08-05, spec §9 R2).
    async deliver(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
      if (isLive(session.sessionId)) return enqueue(session, envelope);
      // a CLI older than the Codex Desktop that wrote the thread cannot resume it (ADR-025)
      const refusal = await preflight(session);
      if (refusal) return { ok: false, retry: false, error: refusal };
      const owner = ownerChoices(configFile);
      const budgetMs = setup.deliverTimeoutMs ?? owner.budgetMs ?? DEFAULT_TURN_MS;
      // --sandbox belongs to `exec`, not to `resume`: placed after `resume` the CLI exits 2 with
      // "unexpected argument '--sandbox'" and nothing would ever be delivered
      const argv = ['exec', ...owner.sandboxArgs, 'resume', session.sessionId, '--skip-git-repo-check', envelope];
      const run = await exec('codex', argv, runOptions(session.cwd, budgetMs));
      if (run.code !== 0) return resumeFailure(session.sessionId, run.code, run.stderr, budgetMs);
      return { ok: true, output: run.stdout };
    },

    async listSessions(): Promise<SessionInfo[]> {
      let tree: string[];
      try {
        tree = (await readdir(sessionsDir, { recursive: true })) as string[];
      } catch {
        return []; // no Codex here, or no thread yet
      }
      const index = await readIndex(indexFile);
      const sightings: WriterSample[] = [];
      const candidates: Candidate[] = [];
      for (const [threadId, rel] of newestRollouts(tree)) {
        const found = await inspect(threadId, rel, index, sightings).catch(() => null);
        if (found) candidates.push(found);
      }
      // only now are all sightings known: a thread's writer is whatever its originator ran by
      // the thread's last activity, never less than what the thread itself recorded
      return candidates.map(({ session, recorded, originator }) => {
        const writerVersion = inferWriterVersion(recorded, originator, session.lastActiveAt, sightings);
        return writerVersion ? { ...session, writerVersion } : session;
      });
    },
  };
}
