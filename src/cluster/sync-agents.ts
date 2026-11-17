import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SessionInfo } from '../adapters/types.js';
import type { SessionRef } from '../mailbox/mailbox.js';
import { formatRelativeTime } from '../format.js';

/**
 * @-mention agents for Claude Code (Phase 2.5, ADR-064): every recent non-Claude session becomes a
 * small agent definition in ~/.claude/agents/, `morse-<agent>-<project>.md`, whose only job is to
 * relay a message to that one session with `morse send`.
 *
 * Ownership is strict. A file counts as generated only when its name has our prefix AND its body
 * contains the marker sentence below; only such files are rewritten or deleted, so a user's own
 * `morse-notes.md` stays untouched. Files that releases named anytoany wrote (`any-*.md`, with the
 * old marker) are recognised the same way and cleaned up.
 */

const FILE_PREFIX = 'morse-';
const MARKER = 'You are a delivery proxy for the Morse session-messaging system.';
/** Compatibility: the prefix and marker of the files written by releases under the anytoany name. */
const OLD_FILE_PREFIX = 'any-';
const OLD_MARKER = 'You are a delivery proxy for the anytoany session-messaging system.';

export interface SyncAgentsOptions {
  /** Where the agent files go (default ~/.claude/agents). */
  agentsDir?: string;
  /** Most recent sessions kept per agent kind (default 8); conversation partners are kept beyond it. */
  maxPerAgent?: number;
}

export interface SyncResult {
  /** File names created or changed by this run. */
  written: string[];
  /** Generated file names deleted by this run. */
  removed: string[];
}

/** Two ends of a conversation (as the mailbox lists them). */
interface ConversationPair {
  a: SessionRef;
  b: SessionRef;
}

/** Scratch locations (smoke runs, experiments): their sessions are not worth a mention. */
const SCRATCH_DIRS = ['/tmp/', '/private/tmp/', '/var/folders/'];
const inScratch = (cwd: string): boolean => cwd === '' || SCRATCH_DIRS.some((dir) => cwd.startsWith(dir));

/** Lower-case ASCII words joined by dashes, cut at 40 characters (the cut may end on a dash). */
function slug(text: string): string {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.join('-').slice(0, 40);
}

/** morse-[<device>-]<agent>-<project folder | title | id prefix> */
function baseName(s: SessionInfo): string {
  const label = slug(basename(s.cwd)) || slug(s.title) || s.sessionId.slice(0, 8);
  return [FILE_PREFIX, s.device ? `${slug(s.device)}-` : '', `${s.agent}-`, label].join('');
}

/** The exact `morse send` target the agent is bound to. */
function boundTarget(s: SessionInfo): string {
  const who = `${s.agent}:${s.sessionId}`;
  return s.device ? `@${s.device}/${who}` : `@${who}`;
}

function agentDefinition(name: string, s: SessionInfo): string {
  const target = boundTarget(s);
  const location = s.device ? `device "${s.device}", ${s.cwd}` : s.cwd;
  const lines = [
    '---',
    `name: ${name}`,
    `description: Message the ${s.agent} session "${s.title}" (${location}). Delivers to that exact ${s.agent} session via Morse; use when the user @-mentions this agent to relay a message. Active ${formatRelativeTime(s.lastActiveAt)}.`,
    'tools: Bash',
    'model: haiku',
    '---',
    '',
    `${MARKER} Your ONLY job is to relay the user's message to one exact session and report the outcome. Never do anything else.`,
    '',
    '**Fixed target (pre-bound, user-confirmed by selecting this agent — NEVER change it):**',
    `\`${target}\` — ${s.agent} session "${s.title}" in ${s.cwd}`,
    '',
    'Steps:',
    '',
    '1. Identify the sender: run `morse list --json --limit 0` and pick the claude session whose `cwd` equals the current working directory, most recently active. Use its id as FROM. If none matches, use the most recently active claude session.',
    '2. Send exactly the user\'s message (verbatim — do not rewrite, summarize, or expand):',
    `   \`morse send "${target}" "<user message verbatim>" --from "@claude:<FROM id prefix>"\``,
    '3. Report back in one short line: the queued message id and that the reply will arrive back automatically via Morse.',
    '',
    'Rules:',
    '- NEVER resolve or guess a different target than the fixed one above.',
    '- Never add instructions of your own to the relayed message.',
    '- If `morse` fails, report the exact error verbatim — retry at most once, never work around it.',
    '',
  ];
  return lines.join('\n');
}

/** Ours = one of our prefixes AND one of our markers in the body. */
function isOurs(dir: string, file: string): boolean {
  if (!file.startsWith(FILE_PREFIX) && !file.startsWith(OLD_FILE_PREFIX)) return false;
  let body: string;
  try {
    body = readFileSync(join(dir, file), 'utf8');
  } catch {
    return false;
  }
  return body.includes(MARKER) || body.includes(OLD_MARKER);
}

/** The "Active 3h ago." phrase changes by itself; it alone is no reason to rewrite a file. */
const withoutAge = (text: string): string => text.replace(/Active [^.]*\./g, '');

/**
 * Which sessions get an agent: per agent kind the `max` most recent, plus every session that is
 * part of a conversation — newest first, kinds in the order they first appear.
 */
function pickSessions(sessions: SessionInfo[], conversations: ConversationPair[], max: number): SessionInfo[] {
  const partners = new Set<string>();
  for (const { a, b } of conversations) for (const ref of [a, b]) if (ref.agent !== 'claude') partners.add(ref.sessionId);

  const newestFirst = sessions
    .filter((s) => s.agent !== 'claude' && !inScratch(s.cwd))
    .sort((x, y) => y.lastActiveAt - x.lastActiveAt);
  const kindOrder = new Map<string, number>();
  const seenPerKind = new Map<string, number>();
  const picked = new Map<string, { session: SessionInfo; kind: number; rank: number }>();
  newestFirst.forEach((session, position) => {
    if (!kindOrder.has(session.agent)) kindOrder.set(session.agent, kindOrder.size);
    const nth = seenPerKind.get(session.agent) ?? 0;
    seenPerKind.set(session.agent, nth + 1);
    if (nth >= max && !partners.has(session.sessionId)) return;
    const earlier = picked.get(session.sessionId);
    const kind = kindOrder.get(session.agent)!;
    // one entry per session id: the last one seen wins, at the place of the first
    picked.set(session.sessionId, earlier ? { ...earlier, session } : { session, kind, rank: position });
  });
  return [...picked.values()]
    .sort((x, y) => y.session.lastActiveAt - x.session.lastActiveAt || x.kind - y.kind || x.rank - y.rank)
    .map((p) => p.session);
}

/** Bring ~/.claude/agents in line with the current sessions; see the header for what is touched. */
export async function syncMentionAgents(
  sessions: SessionInfo[],
  conversations: ConversationPair[],
  options: SyncAgentsOptions = {},
): Promise<SyncResult> {
  const dir = options.agentsDir ?? join(homedir(), '.claude', 'agents');
  mkdirSync(dir, { recursive: true });

  // file name → session; a second session with the same name gets the first 4 characters of its id appended
  const files = new Map<string, SessionInfo>();
  for (const s of pickSessions(sessions, conversations, options.maxPerAgent ?? 8)) {
    const base = baseName(s);
    files.set(files.has(`${base}.md`) ? `${base}-${s.sessionId.slice(0, 4)}.md` : `${base}.md`, s);
  }

  const result: SyncResult = { written: [], removed: [] };
  for (const [file, session] of files) {
    const path = join(dir, file);
    const content = agentDefinition(file.slice(0, -'.md'.length), session);
    if (!existsSync(path)) {
      writeFileSync(path, content, 'utf8');
      result.written.push(file);
      continue;
    }
    if (!isOurs(dir, file)) continue; // the user's own file under that name
    if (withoutAge(readFileSync(path, 'utf8')) === withoutAge(content)) continue;
    writeFileSync(path, content, 'utf8');
    result.written.push(file);
  }

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md') || files.has(file) || !isOurs(dir, file)) continue;
    rmSync(join(dir, file));
    result.removed.push(file);
  }
  return result;
}
