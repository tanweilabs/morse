import { formatAddress } from '../cluster/address.js';
import { myAddressView, ownAddressNames } from '../commands/known-as.js';
import { messageViewOf, type messageView } from '../commands/messaging.js';
import type { Mailbox } from '../mailbox/mailbox.js';

/**
 * The core's event stream for plugins (ADR-051, docs/PLUGINS.md): one event per newly
 * received message (in from a person — another one or our own device — or internal,
 * between sessions here) and per new stranger request. The core decides nothing here:
 * every event carries the contact's group label as data, nothing more.
 *
 * Message events are ordered by the message's row sequence (`seq`); a plugin resumes
 * with the last id (or time) it saw. A request event never carries the request's text —
 * a request must not reach an agent (ADR-037); `morse contact` shows it to the owner.
 */

export type MessageEvent = { type: 'message'; seq: number } & ReturnType<typeof messageView>;
export interface RequestEvent {
  type: 'request';
  handle: string;
  address: string;
  /** always null — Morse has no nicknames (ADR-065); kept so plugins that read it do not break */
  nickname: string | null;
  time: string;
  at: number;
  droppedFiles: number;
  /** (ADR-083) which of YOUR addresses the request waits at */
  myAddress?: { name: string | null; address: string } | null;
}
export type CoreEvent = MessageEvent | RequestEvent;

export interface EventSourceOptions {
  /** Start after this message (id) or time (epoch ms). Neither = only what arrives from now on. */
  sinceId?: string;
  sinceMs?: number;
  /** Start after this row sequence (a saved cursor); `sinceMs` then only scopes requests. */
  sinceSeq?: number;
  now?: () => number;
}

export interface EventSource {
  /** Events since the last poll (messages first, oldest first). */
  poll(): CoreEvent[];
  /** The message cursor (row sequence) — what to persist to resume. */
  cursor(): number;
}

/** `--since` value: a message id (or unique prefix), an ISO time, or epoch ms. */
export function parseSince(mailbox: Mailbox, raw: string | undefined): Pick<EventSourceOptions, 'sinceId' | 'sinceMs'> | { error: string } {
  if (!raw) return {};
  if (/^\d{10,}$/.test(raw)) return { sinceMs: Number(raw) };
  const t = Date.parse(raw);
  if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}/.test(raw)) return { sinceMs: t };
  const exact = mailbox.getMessage(raw);
  if (exact) return { sinceId: exact.id };
  const hits = raw.length >= 4 ? mailbox.inbox({ all: true }).filter((m) => m.id.startsWith(raw)) : [];
  if (hits.length === 1) return { sinceId: hits[0]!.id };
  return { error: `--since "${raw}": not a message id, an ISO time or epoch ms` };
}

export function createEventSource(mailbox: Mailbox, opts: EventSourceOptions = {}): EventSource {
  const now = opts.now ?? Date.now;
  // requests are scoped by time: --since <id> means "since that message arrived"
  const startMs = opts.sinceMs ?? (opts.sinceId ? (mailbox.getMessage(opts.sinceId)?.createdAt ?? now()) : now());
  let seq: number;
  if (opts.sinceSeq !== undefined) seq = opts.sinceSeq;
  else if (opts.sinceId) {
    const m = mailbox.getMessage(opts.sinceId);
    seq = m ? mailbox.seqOf(m.id) : mailbox.seqAt(startMs);
  } else seq = mailbox.seqAt(startMs);
  // requests: one per person, re-filed when replaced — key by handle + first time
  const seenRequests = new Set<string>();
  for (const r of mailbox.requests.list()) if (r.firstAt <= startMs) seenRequests.add(`${r.myAddress}\0${r.handle}\0${r.firstAt}`); // (ADR-083: one per address of mine)
  return {
    poll() {
      const events: CoreEvent[] = [];
      for (;;) {
        const batch = mailbox.receivedAfter(seq, 200);
        for (const m of batch) {
          seq = m.seq;
          const { seq: s, ...msg } = m;
          events.push({ type: 'message', seq: s, ...messageViewOf(mailbox, msg) }); // (ADR-083 review R3: its contact by the pair, never by the bare id)
        }
        if (batch.length < 200) break;
      }
      for (const r of mailbox.requests.list().sort((a, b) => a.firstAt - b.firstAt)) {
        const key = `${r.myAddress}\0${r.handle}\0${r.firstAt}`;
        if (seenRequests.has(key)) continue;
        seenRequests.add(key);
        events.push({ type: 'request', handle: r.handle, address: formatAddress(r.handle, r.fromAgent), nickname: null /* ADR-065: always null */, time: new Date(r.firstAt).toISOString(), at: r.firstAt, droppedFiles: r.droppedFiles, myAddress: myAddressView(r.myAddress, ownAddressNames()) });
      }
      return events;
    },
    cursor: () => seq,
  };
}
