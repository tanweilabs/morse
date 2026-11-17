import type { SessionInfo } from '../adapters/types.js';
import { formatRelativeTime, shortenHome } from '../format.js';
import type { Mailbox } from '../mailbox/mailbox.js';
import { scanSessions } from './sessions.js';

/** One session in `morse list`: `@[device/]agent:title  [id]  (last active, directory, how it receives)`. */
function sessionRow(s: SessionInfo, registered: (sessionId: string) => boolean): string {
  const notes = [formatRelativeTime(s.lastActiveAt)];
  if (s.cwd) notes.push(shortenHome(s.cwd));
  // an external agent receives by pulling, never by a headless resume (ADR-024)
  if (!s.device && registered(s.sessionId)) notes.push('external, pull-only');
  return `@${s.device ? `${s.device}/` : ''}${s.agent}:${s.title}  [${s.sessionId.slice(0, 8)}]  (${notes.join(', ')})`;
}

/** `morse list`: the addressable sessions here, newest first — `limit` of them ('0' or not a number: all). */
export async function listSessions(opts: { json?: boolean; limit: string }): Promise<void> {
  const { sessions, errors } = await scanSessions();
  const limit = Number.parseInt(opts.limit, 10);
  const shown = limit > 0 ? sessions.slice(0, limit) : sessions;
  if (opts.json) {
    const failures = errors.map(({ agent, error }) => ({ agent, message: error.message }));
    console.log(JSON.stringify({ sessions: shown, total: sessions.length, errors: failures }, null, 2));
    return;
  }
  const { isRegisteredSession } = await import('../registry/external.js');
  for (const s of shown) console.log(sessionRow(s, isRegisteredSession));
  const hidden = sessions.length - shown.length;
  if (hidden > 0) console.log(`… ${hidden} more (use --limit 0 for all)`);
  for (const { agent, error } of errors) console.error(`warning: ${agent} scan failed: ${error.message}`);
}

/** `morse list --conversations` (was `morse conversations`): the session-to-session conversations, newest first. */
export function listConversations(mailbox: Mailbox, opts: { json?: boolean }): void {
  const conversations = mailbox.listConversations();
  if (opts.json) return console.log(JSON.stringify(conversations, null, 2));
  if (!conversations.length) return console.log('no conversations yet — send a first message with morse send');
  for (const c of conversations) {
    const preview = c.lastMessage ? ` — ${c.lastMessage.parts[0]?.text.slice(0, 40) ?? ''}` : '';
    const side = (ref: { agent: string; sessionId: string }) => `@${ref.agent}:${ref.sessionId.slice(0, 8)}`;
    console.log(`${side(c.a)} ↔ ${side(c.b)}  (${c.messageCount} msgs, ${formatRelativeTime(c.lastMessageAt)})${preview}`);
  }
}
