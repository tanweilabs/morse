import type { Mailbox } from '../mailbox/mailbox.js';
import type { ExternalSession } from '../registry/external.js';
import type { Notifier } from './notify.js';

// Desktop notification for mail waiting on a registered external agent (ADR-024).
//
// The usual notification fires on `delivered`, which a pull-only session never
// produces — the dispatcher does not claim its mail. And an app assistant such as
// 闪电说 cannot wake itself up to look. So the daemon watches those inboxes and
// tells the operator: something arrived, go ask the app.

export interface ExternalInboxNotifier {
  /** One scan right now (tests call it directly). */
  tick(): void;
  stop(): void;
}

export interface ExternalInboxNotifierOptions {
  mailbox: Pick<Mailbox, 'inbox'>;
  listRegistered: () => ExternalSession[];
  notifier: Notifier;
  intervalMs?: number;
  /** Pass false to leave the timer off and drive `tick()` by hand. */
  autoStart?: boolean;
  /** Told about every notification shown, for the daemon log. */
  onNotify?: (session: ExternalSession, messageId: string) => void;
}

/** Each pending message for a registered session, with the session it waits on. Read errors count as "nothing". */
function* waitingMail(opts: ExternalInboxNotifierOptions): Generator<[ExternalSession, string]> {
  let sessions: ExternalSession[];
  try {
    sessions = opts.listRegistered();
  } catch {
    return;
  }
  for (const session of sessions) {
    let pending: Array<{ id: string }>;
    try {
      pending = opts.mailbox.inbox({ toSession: session.sessionId, pendingOnly: true });
    } catch {
      // e.g. the database is busy — try again next tick, never take the daemon down
      continue;
    }
    for (const message of pending) yield [session, message.id];
  }
}

export function startExternalInboxNotifier(opts: ExternalInboxNotifierOptions): ExternalInboxNotifier {
  // Mail already waiting at start-up is old news: without this, every daemon
  // restart would announce everything the app has not fetched yet.
  const seen = new Set<string>();
  for (const [, id] of waitingMail(opts)) seen.add(id);

  const tick = (): void => {
    for (const [session, id] of waitingMail(opts)) {
      if (seen.has(id)) continue;
      seen.add(id);
      opts.notifier.sessionActivity(session.agent, session.title, session.sessionId, 'received');
      opts.onNotify?.(session, id);
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.autoStart !== false) {
    timer = setInterval(tick, opts.intervalMs ?? 5_000);
    timer.unref?.();
  }

  return {
    tick,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
