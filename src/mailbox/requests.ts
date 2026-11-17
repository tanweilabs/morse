import type { Db } from './db.js';
import { isAddress } from '../identity/address.js';

/**
 * Morse message requests (ADR-037) — like a chat app's "message requests": the first
 * message of a person who is not paired here. Kept apart from the mailbox's messages,
 * so no inbox, pull, hook or agent session ever sees it; the operator accepts
 * (`morse contact accept`, the message moves into the inbox) or declines (deleted,
 * the person is blocked). One request per person: further messages from them are
 * dropped (only counted) until accepted. The table is capped: when it is full a NEW person is
 * refused (their computer keeps the message and tries again later) — a waiting request is never
 * pushed out to make room (ADR-081 review F4: a flood of strangers must not delete the one you wanted).
 */

export interface MessageRequest {
  /**
   * (ADR-083) WHICH of this computer's addresses the request waits at: '' = its first address (every
   * request that came the old way, from a device), else the 26-character address it was written to.
   * One request per (my address, sender); each of my addresses has its own room (`max`).
   */
  myAddress: string;
  /** The person (Morse handle), lowercase. */
  handle: string;
  /** The device that wrote — verified against the relay directory under `handle`. */
  deviceId: string;
  /** That device's name as the relay directory (or the LAN) gives it. */
  deviceName?: string;
  /** Legacy (ADR-036): never filled or shown any more — Morse has no nicknames (ADR-065). */
  nickname?: string;
  msgId: string;
  contextId?: string;
  from: { agent: string; sessionId: string };
  /** The sender's Morse agent (reply address <handle>/<agent>). */
  fromAgent?: string;
  /** Where it goes once accepted (resolved on arrival). */
  to: { agent: string; sessionId: string };
  /**
   * ADR-081: set = it arrived BY ADDRESS — signed by the address in `handle`, written to this address
   * of yours (answers, the `accepted` notice included, are signed by it). Unset = the old way: a device
   * the relay listed under `handle`. Only a request that arrived by address is ever accepted as one.
   */
  toAddress?: string;
  text: string;
  /** Attachments are never stored for a request — only counted. */
  droppedFiles: number;
  /** Their names and sizes (ADR-038; the sender sends them again once accepted). */
  droppedFileList?: Array<{ name: string; size: number }>;
  via: string;
  /** Messages seen from this person while the request waits (the first included). */
  count: number;
  firstAt: number;
  lastAt: number;
}

export type NewRequest = Omit<MessageRequest, 'count' | 'firstAt' | 'lastAt' | 'myAddress'> & { myAddress?: string };

/** (ADR-083) The message requests table since schema v4: one row per (my address, sender). */
export const REQUESTS_TABLE = `
CREATE TABLE IF NOT EXISTS morse_requests (
  my_address TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT,
  nickname TEXT,
  msg_id TEXT NOT NULL,
  context_id TEXT,
  from_agent TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_morse_agent TEXT,
  to_agent TEXT NOT NULL,
  to_session TEXT NOT NULL,
  text TEXT NOT NULL,
  dropped_files INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  dropped_file_list TEXT,
  to_address TEXT,
  PRIMARY KEY (my_address, handle)
);
`;

/** filed = new request · duplicate = the stored message again (a retry) · dropped = one per person ·
 *  full = the request area is full: not kept, nothing was removed to make room. */
export type FileRequestResult = { result: 'filed' | 'duplicate' | 'dropped' | 'full' };

export interface RequestStore {
  /** The request from `handle` at one address of mine (`my`: '' / nothing = this computer's first address). */
  get(handle: string, my?: string | null): MessageRequest | undefined;
  /** (ADR-083) Every request from `handle`, whichever of my addresses it waits at (the first address's first). */
  find(handle: string): MessageRequest[];
  /** Newest activity first. With `my`: only that address's. */
  list(my?: string | null): MessageRequest[];
  /** All of them — or, with `my`, the ones waiting at that address ('' = the first). */
  count(my?: string | null): number;
  /** How many requests are kept at most — (ADR-083) PER address of mine. */
  max: number;
  /** No room for another person's request at this address of mine (accept or reject some). Without `my`: at ANY of them. */
  full(my?: string | null): boolean;
  /** (ADR-083) The addresses of mine ('' = the first) whose request area is full. */
  fullAt(): string[];
  file(req: NewRequest): FileRequestResult;
  /** Delete and return it (undefined = none). */
  remove(handle: string, my?: string | null): MessageRequest | undefined;
}

export const DEFAULT_MAX_REQUESTS = 200;

/** One line for `morse contact` / `morse message` when no further person's request fits (ADR-081 review F4). */
export const requestsFullLine = (count: number, max: number): string =>
  `message requests are full (${count} of ${max}) — nobody new can reach you until you accept or reject some (morse contact accept | reject <address>)`;
/** A request's text is capped: strangers do not get to fill the disk. */
export const MAX_REQUEST_TEXT = 64 * 1024;

interface Row {
  my_address?: string | null;
  handle: string;
  device_id: string;
  device_name: string | null;
  nickname: string | null;
  msg_id: string;
  context_id: string | null;
  from_agent: string;
  from_session: string;
  from_morse_agent: string | null;
  to_agent: string;
  to_session: string;
  text: string;
  dropped_files: number;
  dropped_file_list?: string | null;
  to_address?: string | null;
  via: string;
  count: number;
  first_at: number;
  last_at: number;
}

const fromRow = (r: Row): MessageRequest => ({
  myAddress: r.my_address ?? '',
  handle: r.handle,
  deviceId: r.device_id,
  ...(r.device_name ? { deviceName: r.device_name } : {}),
  // ADR-065: a nickname stored by an older version is never read back or shown
  msgId: r.msg_id,
  ...(r.context_id ? { contextId: r.context_id } : {}),
  from: { agent: r.from_agent, sessionId: r.from_session },
  ...(r.from_morse_agent ? { fromAgent: r.from_morse_agent } : {}),
  to: { agent: r.to_agent, sessionId: r.to_session },
  ...(r.to_address ? { toAddress: r.to_address } : {}),
  text: r.text,
  droppedFiles: r.dropped_files,
  ...(r.dropped_file_list ? { droppedFileList: parseFileList(r.dropped_file_list) } : {}),
  via: r.via,
  count: r.count,
  firstAt: r.first_at,
  lastAt: r.last_at,
});

const parseFileList = (raw: string): Array<{ name: string; size: number }> => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((f): f is { name: string; size: number } => typeof f?.name === 'string' && typeof f?.size === 'number').slice(0, 64) : [];
  } catch {
    return [];
  }
};

const norm = (h: string) => h.trim().toLowerCase().replace(/^@/, '');

export function createRequestStore(db: Db, opts: { now?: () => number; max?: number } = {}): RequestStore {
  const now = opts.now ?? Date.now;
  const max = Math.max(1, opts.max ?? DEFAULT_MAX_REQUESTS);
  const key = (my: string | null | undefined): string => my ?? '';
  const count = (my?: string | null): number =>
    my === undefined
      ? (db.prepare('SELECT COUNT(*) AS n FROM morse_requests').get() as { n: number }).n
      : (db.prepare('SELECT COUNT(*) AS n FROM morse_requests WHERE my_address = ?').get(key(my)) as { n: number }).n;
  const get = (handle: string, my?: string | null): MessageRequest | undefined => {
    const r = db.prepare('SELECT * FROM morse_requests WHERE handle = ? AND my_address = ?').get(norm(handle), key(my)) as Row | undefined;
    return r ? fromRow(r) : undefined;
  };
  const fullAt = (): string[] =>
    (db.prepare('SELECT my_address AS m, COUNT(*) AS n FROM morse_requests GROUP BY my_address').all() as Array<{ m: string | null; n: number }>).filter((r) => r.n >= max).map((r) => r.m ?? '');
  const file = db.transaction((req: NewRequest): FileRequestResult => {
    const handle = norm(req.handle);
    const my = key(req.myAddress);
    const t = now();
    const existing = get(handle, my);
    if (existing) {
      if (existing.msgId === req.msgId) return { result: 'duplicate' };
      db.prepare('UPDATE morse_requests SET count = count + 1, last_at = ? WHERE handle = ? AND my_address = ?').run(t, handle, my);
      return { result: 'dropped' };
    }
    // full: a new person is refused — nobody who is waiting is pushed out. (ADR-083) Counted per address of
    // mine: what waits at another address of this computer takes no room here.
    if (count(my) >= max) return { result: 'full' };
    const text = req.text.length > MAX_REQUEST_TEXT ? `${req.text.slice(0, MAX_REQUEST_TEXT)}\n[… cut: a message request keeps at most ${MAX_REQUEST_TEXT / 1024} KB]` : req.text;
    db.prepare(
      `INSERT INTO morse_requests (my_address, handle, device_id, device_name, nickname, msg_id, context_id, from_agent, from_session, from_morse_agent, to_agent, to_session, text, dropped_files, dropped_file_list, to_address, via, count, first_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      my,
      handle,
      req.deviceId,
      req.deviceName ?? null,
      req.nickname ?? null,
      req.msgId,
      req.contextId ?? null,
      req.from.agent,
      req.from.sessionId,
      req.fromAgent ?? null,
      req.to.agent,
      req.to.sessionId,
      text,
      req.droppedFiles,
      req.droppedFileList?.length ? JSON.stringify(req.droppedFileList.slice(0, 64).map((f) => ({ name: String(f.name).slice(0, 200), size: f.size }))) : null,
      req.toAddress && isAddress(req.toAddress) ? req.toAddress : null,
      req.via,
      t,
      t,
    );
    return { result: 'filed' };
  });
  return {
    get,
    find: (handle) => (db.prepare(`SELECT * FROM morse_requests WHERE handle = ? ORDER BY my_address = '' DESC, my_address ASC`).all(norm(handle)) as Row[]).map(fromRow),
    list: (my) =>
      (my === undefined
        ? (db.prepare('SELECT * FROM morse_requests ORDER BY last_at DESC, rowid DESC').all() as Row[])
        : (db.prepare('SELECT * FROM morse_requests WHERE my_address = ? ORDER BY last_at DESC, rowid DESC').all(key(my)) as Row[])
      ).map(fromRow),
    count,
    max,
    full: (my) => (my === undefined ? fullAt().length > 0 : count(my) >= max),
    fullAt,
    file: (req) => file(req),
    remove(handle, my) {
      const r = get(handle, my);
      if (r) db.prepare('DELETE FROM morse_requests WHERE handle = ? AND my_address = ?').run(r.handle, r.myAddress);
      return r;
    },
  };
}
