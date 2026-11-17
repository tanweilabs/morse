import { createClaudeAdapter } from '../adapters/claude.js';
import { createCodexAdapter } from '../adapters/codex.js';
import { createKimiAdapter } from '../adapters/kimi.js';
import { createRegisteredAdapter } from '../adapters/registered.js';
import type { SessionInfo } from '../adapters/types.js';
import { createZcodeAdapter } from '../adapters/zcode.js';
import { resolveTarget } from '../directory/resolve.js';
import { listAllSessions, type ScanResult } from '../directory/scanner.js';

/** The agents a session of which can be handed a message headlessly (what the daemon delivers through). */
export const deliveryAdapters = () => [createClaudeAdapter(), createCodexAdapter(), createZcodeAdapter(), createKimiAdapter()];

/**
 * Every session an @-target can name: the delivery adapters' and the registered external agents' (ADR-024).
 * An external session is listed only — it has no `deliver`, so it never joins the delivery adapters; it
 * receives by pulling (`morse message --pull`, or POST /api/inbox for desktop Apps).
 */
export const scanSessions = (): Promise<ScanResult> => listAllSessions([...deliveryAdapters(), createRegisteredAdapter()]);

/** A session an @-target resolved to. */
export interface FoundSession {
  agent: string;
  sessionId: string;
  title: string;
}

/**
 * The one session `target` names on this computer. When there is none (or more than one), the command ends
 * here: exit code 1, the reason and up to eight candidates on stderr.
 */
export async function sessionOrExit(target: string): Promise<FoundSession> {
  const found = resolveTarget(target, (await scanSessions()).sessions);
  if (found.ok) {
    const { agent, sessionId, title } = found.session;
    return { agent, sessionId, title };
  }
  const lines = [`error: cannot resolve target "${target}" (${found.reason})`, ...found.candidates.slice(0, 8).map((c) => `  candidate: @${c.agent}:${c.title}  [${c.sessionId.slice(0, 8)}]`)];
  for (const line of lines) console.error(line);
  process.exit(1);
}

/** The sessions whose project directory is exactly `cwd`. */
export async function sessionsInDirectory(cwd: string): Promise<SessionInfo[]> {
  return (await scanSessions()).sessions.filter((s) => s.cwd === cwd);
}

/**
 * The daemon's view of the sessions here: scanned at most once per `ttlMs`, scan failures said as warnings.
 * `after` sees every list handed out (the daemon keeps the mention agents in step with it).
 */
export function cachedSessionDirectory(ttlMs: number, after: (sessions: SessionInfo[]) => Promise<void> = async () => undefined) {
  let snapshot: { takenAt: number; sessions: SessionInfo[] } | undefined;
  const fresh = async (): Promise<SessionInfo[]> => {
    if (snapshot && Date.now() - snapshot.takenAt <= ttlMs) return snapshot.sessions;
    const scan = await scanSessions();
    for (const failed of scan.errors) console.error(`warning: ${failed.agent} scan failed: ${failed.error.message}`);
    snapshot = { takenAt: Date.now(), sessions: scan.sessions };
    return scan.sessions;
  };
  return {
    /** The sessions, rescanned when the last scan is older than the TTL. */
    list: async (): Promise<SessionInfo[]> => {
      const sessions = await fresh();
      await after(sessions);
      return sessions;
    },
    /** Forget the last scan: the next list scans again. */
    invalidate: (): void => {
      snapshot = undefined;
    },
    /** A session's title from the last scan, without scanning. */
    titleOf: (sessionId: string): string | undefined => snapshot?.sessions.find((s) => s.sessionId === sessionId)?.title,
  };
}
