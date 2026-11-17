import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from '../../file-lock.js';
import { takeLaneLock } from '../../plugin/lane-lock.js';
import { morseDataDirOf } from './config.js';

/**
 * The attendant's own state (ADR-059), in <MORSE_HOME or ~>/.morse/plugins/attendant/
 * (0700, files 0600) — never the mailbox:
 *
 *   state.json   { startedAt, defaultSince, sessions, launches, contextTurns, messages, notices, asks }
 *   locks/       one turn per lane (your agent + one contact), also across processes
 *   runs/, approvals/  see approvals.ts
 */

export interface LaneSession {
  runtime: 'claude' | 'codex';
  /** The Claude session id / Codex thread id. */
  sessionId: string;
  cwd: string;
  createdAt: number;
  /** Created by us, not yet seen to work (its first turn may have failed before it was written). */
  fresh?: boolean;
  lastTurnAt?: number;
  turns: number;
}

export interface MessageMark {
  /** running: a turn has it now (after a restart: retried) · retry: try again after `notBefore` ·
   *  deferred: left for the owner (store only) · failed: gave up — the owner's now. */
  state: 'running' | 'retry' | 'deferred' | 'failed';
  at: number;
  attempts: number;
  notBefore?: number;
  reason?: string;
  runId?: string;
}

export interface AttendantStateData {
  /** When the plugin first ran: older mail is never answered (no backlog surprise). */
  startedAt: number;
  sessions: Record<string, LaneSession>;
  /** contact id -> launch times (rate limits). */
  launches: Record<string, number[]>;
  /**
   * (contact, thread) -> attendant turn times (maxTurnsPerContext, when the owner sets it — ADR-072), keyed
   * by `contextKey(contact id, contextId)`. (ADR-083 review R5) Per CONTACT: a thread id is the sender's to
   * choose, and the same person can be a contact of two of your addresses — what one of those contacts
   * used up must not be visible in how the other is answered. (Before, this was `contexts`, keyed by the
   * thread id alone: that field is no longer read and is dropped the next time the file is written.)
   */
  contextTurns: Record<string, number[]>;
  messages: Record<string, MessageMark>;
  /** contact id -> when the last "rate limited" notice went out. */
  notices: Record<string, number>;
  /** ADR-066: when the default (conversation-only) profile was first on — older mail is never answered by it. */
  defaultSince?: number;
  /** ADR-066: what agents asked the owner (ASK_OWNER), newest last; a week, at most 100. */
  asks: OwnerAsk[];
}

export interface OwnerAsk {
  id: string;
  at: number;
  lane: string;
  contact: { id: string; handle: string | null; remark: string | null; group: string };
  /** The one-line request for the owner. */
  request: string;
  /** The contact's message it came from (`morse reply <id> …` answers them yourself). */
  replyTo: string;
}

export interface AttendantState {
  dir: string;
  read(): AttendantStateData;
  update(fn: (s: AttendantStateData) => void): AttendantStateData;
  lock(lane: string): (() => void) | null;
}

export const attendantStateDir = (env: NodeJS.ProcessEnv = process.env): string => join(morseDataDirOf(env), 'plugins', 'attendant');

const DAY = 86_400_000;

/** (ADR-083 review R5) The key of one thread WITH one contact in `contextTurns` (unambiguous for any two strings). */
export const contextKey = (contactId: string, contextId: string): string => JSON.stringify([contactId, contextId]);

export function createAttendantState(dir: string = attendantStateDir(), now: () => number = Date.now): AttendantState {
  const file = join(dir, 'state.json');
  const ensure = () => {
    mkdirSync(join(dir, 'locks'), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  };
  const empty = (): AttendantStateData => ({ startedAt: now(), sessions: {}, launches: {}, contextTurns: {}, messages: {}, notices: {}, asks: [] });
  const read = (): AttendantStateData => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AttendantStateData>;
      const base = empty();
      return {
        startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : base.startedAt,
        sessions: raw.sessions ?? {},
        launches: raw.launches ?? {},
        // (the field from before — `contexts`, by thread id alone — is not read: its counts were not any one contact's)
        contextTurns: raw.contextTurns && typeof raw.contextTurns === 'object' ? raw.contextTurns : {},
        messages: raw.messages ?? {},
        notices: raw.notices ?? {},
        ...(typeof raw.defaultSince === 'number' ? { defaultSince: raw.defaultSince } : {}),
        asks: Array.isArray(raw.asks) ? raw.asks : [],
      };
    } catch {
      return empty();
    }
  };
  const write = (s: AttendantStateData) => {
    ensure();
    // keep it small: a day of launch / context times, a week of message marks
    const t = now();
    for (const m of [s.launches, s.contextTurns]) {
      for (const [k, v] of Object.entries(m)) {
        const kept = v.filter((x) => t - x < DAY);
        if (kept.length) m[k] = kept;
        else delete m[k];
      }
    }
    for (const [k, v] of Object.entries(s.messages)) if (t - v.at > 7 * DAY) delete s.messages[k];
    s.asks = s.asks.filter((a) => t - a.at < 7 * DAY).slice(-100);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    dir,
    read,
    update(fn) {
      // read-modify-write under the file's lock: the plugin, its hook processes and CLI calls all write it
      return withFileLock(file, () => {
        const s = read();
        fn(s);
        write(s);
        return s;
      });
    },
    lock(lane) {
      ensure();
      return takeLaneLock(join(dir, 'locks'), lane);
    },
  };
}

/** Launches of a contact in the last hour / day. */
export function launchCounts(s: AttendantStateData, contactId: string, at: number): { hour: number; day: number } {
  const list = s.launches[contactId] ?? [];
  return { hour: list.filter((x) => at - x < 3_600_000).length, day: list.filter((x) => at - x < DAY).length };
}
