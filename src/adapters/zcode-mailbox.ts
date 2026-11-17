import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/*
 * ZCode's session mailbox (ADR-029). Not a published feature: a ZCode runtime started with
 * ZCODE_MESSAGE_ENABLED=1 looks into `<root>/<session>/unread/` for `*.json` letters when a
 * prompt is submitted, after every tool call (the letter joins the running turn) and when a
 * turn stops (it then carries on with the letter). The file format and the rules below follow
 * ZCode's open-source runtime (its core hooks/session-mailbox module) and were checked live
 * against CLI 0.16.5.
 */

/** A letter as ZCode reads it; written with `version: 1` in front. */
export interface MailboxEnvelope {
  messageId: string;
  fromSessionId: string;
  toSessionId: string;
  content: string;
  createdAt: string;
}

/** The session ids ZCode accepts — the same check keeps us from writing outside the root. */
const VALID_SESSION = /^sess_[A-Za-z0-9._-]+$/;
/** An assistant turn older than this without `completed` is a leftover of a crash. */
const STALE_TURN_MS = 30 * 60_000;
/** A fresh user message with no answer yet means a turn is just starting. */
const STARTING_TURN_MS = 60_000;
/** Ties on the timestamp go to the row written last. */
const NEWEST_MESSAGE = `SELECT data FROM message WHERE session_id = ?
  ORDER BY time_created DESC, rowid DESC
  LIMIT 1`;

/** The mailbox root: ZCODE_MAILBOX_ROOT, `~` expanded, or ~/.zcode/mailbox. */
export function mailboxRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env['ZCODE_MAILBOX_ROOT'] ?? '~/.zcode/mailbox';
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return join(home, configured.slice(2));
  return configured;
}

function folderOf(root: string, sessionId: string): string {
  const acceptable = VALID_SESSION.test(sessionId) && !sessionId.includes('..');
  if (!acceptable) throw new Error(`invalid ZCode session id for the mailbox: ${sessionId}`);
  return join(root, sessionId);
}

/**
 * Has this session run with the mailbox switched on? A flagged runtime creates its
 * `unread/` folder whenever it checks for mail, and every turn starts with a check — so the
 * folder is ZCode's own record of it. The process cannot simply be asked: ZCode retitles
 * itself `zcode-cli`, which overwrites the memory `ps eww` would read its environment from.
 */
export function mailboxEnabledFor(root: string, sessionId: string): boolean {
  let folder: string;
  try {
    folder = folderOf(root, sessionId);
  } catch {
    return false;
  }
  return existsSync(join(folder, 'unread'));
}

/**
 * Drop a letter into the session's `unread/` and return its path. It is written next to
 * `unread/` first and then renamed in, so a drain can never pick up half a file.
 */
export function postToMailbox(root: string, envelope: MailboxEnvelope): string {
  const folder = folderOf(root, envelope.toSessionId);
  const unread = join(folder, 'unread');
  mkdirSync(unread, { recursive: true });
  const fileName = `${Date.now()}-${envelope.messageId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
  const staging = join(folder, `.morse-${fileName}.tmp`);
  const letter = { version: 1, ...envelope };
  writeFileSync(staging, JSON.stringify(letter), { mode: 0o600 });
  const delivered = join(unread, fileName);
  renameSync(staging, delivered);
  return delivered;
}

/**
 * Try to get an unread letter back. ZCode drains by renaming too, and only one rename of the
 * same file can succeed: true means the letter is ours again (send it some other way), false
 * means ZCode has it.
 */
export function reclaimMail(path: string): boolean {
  const aside = `${path}.reclaimed`;
  try {
    renameSync(path, aside);
  } catch {
    return false;
  }
  rmSync(aside, { force: true });
  return true;
}

interface MessageData {
  role?: string;
  time?: { created?: number; completed?: number };
}

/** Busy or not, judged from the session's newest message alone. */
function turnInProgress(newest: MessageData, now: number): boolean {
  const age = now - (newest.time?.created ?? 0);
  switch (newest.role) {
    case 'assistant':
      return !newest.time?.completed && age < STALE_TURN_MS;
    case 'user':
      return age < STARTING_TURN_MS;
    default:
      return false;
  }
}

/**
 * Run `read` against ZCode's database opened read-only — the App keeps this WAL database open
 * and writes to it. `fallback` when the file is missing, cannot be opened, or `read` throws
 * (no such table, a schema from another ZCode version).
 */
export function readZcodeDb<T>(dbFile: string, fallback: T, read: (db: Database.Database) => T): T {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
    return read(db);
  } catch {
    return fallback;
  } finally {
    db?.close();
  }
}

/**
 * Is the session in the middle of a turn? ZCode (of the opencode family) stores the
 * assistant message as a turn begins and sets its `time.completed` when the turn is over —
 * seen live: missing for the whole of a `sleep 20` turn, there right after. Anything that
 * cannot be read counts as not busy, which keeps the ordinary delivery path.
 */
export function isSessionBusy(dbFile: string, sessionId: string, now: number = Date.now()): boolean {
  return readZcodeDb(dbFile, false, (db) => {
    const newest = db.prepare(NEWEST_MESSAGE).get(sessionId) as { data?: unknown } | undefined;
    if (typeof newest?.data !== 'string') return false;
    return turnInProgress(JSON.parse(newest.data) as MessageData, now);
  });
}
