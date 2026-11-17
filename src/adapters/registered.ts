import { listRegistered, type ExternalSession } from '../registry/external.js';
import type { AgentAdapter, SessionInfo } from './types.js';

/** A registration as the session directory sees it: its last check-in is its last activity. */
const toSessionInfo = ({ agent, sessionId, title, cwd, lastSeenAt }: ExternalSession): SessionInfo => ({
  agent,
  sessionId,
  title,
  cwd,
  lastActiveAt: lastSeenAt,
});

/**
 * Lists registered external agents (ADR-024) next to the CLI agents, so `@sds:…`
 * resolves and `morse list` shows them.
 *
 * It only lists. There is no `deliver`: a registered session pulls its own mail,
 * and the dispatcher must never get a delivery adapter for it (cli.ts keeps this
 * adapter out of that map). The `agent` label here only names the source when a
 * scan fails — each listed session carries the name it registered under.
 */
export function createRegisteredAdapter(opts: { home?: string; now?: () => number } = {}): AgentAdapter {
  const listSessions = async (): Promise<SessionInfo[]> => listRegistered(opts).map(toSessionInfo);
  return { agent: 'external', listSessions };
}
