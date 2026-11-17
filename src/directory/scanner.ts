import type { AgentAdapter, SessionInfo } from '../adapters/types.js';

/** An adapter whose listing failed, and how. */
export interface ScanError {
  agent: string;
  error: Error;
}

export interface ScanResult {
  /** Every session the adapters found, newest activity first. */
  sessions: SessionInfo[];
  /** The adapters that failed — reported, never allowed to take the rest of the directory down. */
  errors: ScanError[];
}

/** The session directory: every adapter asked at once, the answers merged. */
export async function listAllSessions(adapters: AgentAdapter[]): Promise<ScanResult> {
  const answers = await Promise.all(
    adapters.map(async (adapter): Promise<SessionInfo[] | ScanError> => {
      try {
        return await adapter.listSessions();
      } catch (thrown) {
        return { agent: adapter.agent, error: thrown instanceof Error ? thrown : new Error(String(thrown)) };
      }
    }),
  );
  // (in adapter order, so sessions with the same activity time keep a stable order)
  const result: ScanResult = { sessions: [], errors: [] };
  for (const answer of answers) {
    if (Array.isArray(answer)) result.sessions.push(...answer);
    else result.errors.push(answer);
  }
  result.sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return result;
}
