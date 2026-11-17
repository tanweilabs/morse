import type { DeliveryAdapter, SessionInfo } from '../adapters/types.js';
import { routeForMessage } from '../cluster/routing.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';

export interface DispatchEvent {
  kind: 'delivered' | 'failed' | 'waiting' | 'reply-filed' | 'reply-rejected' | 'redirected';
  message: Message;
  detail?: string;
}

export interface DispatcherOptions {
  mailbox: Mailbox;
  /** Unused by the core since ADR-052 (the dispatch plugin has them); kept so callers compile. */
  adapters?: Map<string, DeliveryAdapter>;
  directory?: () => Promise<SessionInfo[]>;
  onEvent?: (event: DispatchEvent) => void;
  /** This machine's device name; unset disables relay routing (Phase 1 mode). */
  selfDevice?: string;
  /** Hand a message to a paired peer daemon (Phase 2 LAN) or, through the Morse
   *  relay, to a person (handle). `waiting` = not reachable right now; the message
   *  stays in the outbox and is retried until it is (no dead-letter on count). */
  relay?: (device: string, message: Message) => Promise<{ ok: boolean; error?: string; waiting?: boolean; terminal?: boolean; via?: string; request?: boolean }>;
  /** A local session actively running `morse message --wait` receives messages live in its
   *  own turn; the dispatcher must NOT resume-deliver to it (which would create an
   *  invisible headless turn). Such messages stay pending for the monitor to pull. */
  isMonitored?: (sessionId: string) => boolean;
  /** A local Claude session open in an interactive process must also NOT be
   *  resume-delivered to: the injected turn lands but `claude -p` exits non-zero
   *  (a post-turn hook chokes, or the shared session errors), so Morse false-
   *  fails and retries — re-injecting duplicate turns into the session the operator
   *  is actively using. Leave it pending; its own prompt hook surfaces it (ADR-023).
   *  Same for a Codex thread held open by Codex Desktop: resume is refused outright
   *  ("already has an active writer"), so it too waits for its prompt hook (ADR-026). */
  isSessionLive?: (sessionId: string) => boolean;
  /** A registered EXTERNAL agent session (ADR-024) — a desktop App's assistant
   *  such as 闪电说, which Morse has no delivery adapter for. It pulls its own
   *  mail over the daemon's HTTP inbox, so its messages must stay pending rather
   *  than be claimed and dead-lettered for want of an adapter. */
  isPullOnly?: (sessionId: string) => boolean;
  /** Local session ids that are ALWAYS pull-only (Morse 'inbox') — the mailbox filters
   *  them in SQL so they never fill the claim window (ADR-044). */
  pullOnlySessions?: string[];
}

/**
 * The core's half of delivery (ADR-052): claim the next OUTBOUND message — to another
 * device / person, or to the human's own inbox — and hand it to the transport. The
 * core never runs an agent: mail for a session on this computer is left for the
 * dispatch plugin (src/plugins/dispatch), which claims it through the plugin contract.
 * Returns false when nothing was due.
 */
export async function dispatchOnce(opts: DispatcherOptions): Promise<boolean> {
  const claimed = opts.mailbox.claimNextPending({
    scope: 'outbound',
    ...(opts.pullOnlySessions?.length ? { pullOnlySessions: opts.pullOnlySessions } : {}),
  });
  if (!claimed) return false;
  const emit = (event: DispatchEvent) => opts.onEvent?.(event);

  const fail = (error: string, terminal = false): true => {
    const failed = opts.mailbox.markFailed(claimed.id, error, terminal ? { terminal: true } : undefined);
    emit({ kind: 'failed', message: failed, detail: error });
    return true;
  };
  const wait = (error: string): true => {
    const failed = opts.mailbox.markFailed(claimed.id, error, { waiting: true });
    emit({ kind: 'waiting', message: failed, detail: error });
    return true;
  };

  // Route FIRST — even a reply to the human may be on another device (kimi on
  // mini replying to the user on macbook must relay home, not sit in mini's
  // local inbox). Only a LOCAL user reply is a mailbox-is-the-inbox delivery.
  const route = routeForMessage(claimed, opts.selfDevice ?? '');
  if (route.kind === 'relay') {
    // A message to the human must never dead-letter — it is the operator's
    // escalation channel (ADR-020: the self-driving loop asks the operator here
    // when it stalls). Relay home when we can; if relay is unavailable or fails,
    // fall back to THIS machine's inbox (visible in the local console) instead of
    // losing it. Non-user targets keep the normal fail→retry→dead behaviour.
    const toUser = claimed.to.agent === 'user';
    const userSink = (detail: string): true => {
      const delivered = opts.mailbox.markDelivered(claimed.id);
      emit({ kind: 'delivered', message: delivered, detail });
      return true;
    };
    if (!opts.relay) {
      return toUser
        ? userSink('user-inbox:relay-unconfigured')
        : fail(`target device "${route.device}" requires LAN relay (not configured)`);
    }
    let relayed;
    try {
      relayed = await opts.relay(route.device, claimed);
    } catch (e) {
      return toUser ? userSink('user-inbox:relay-error') : fail(e instanceof Error ? e.message : String(e));
    }
    if (!relayed.ok) {
      if (relayed.waiting) return wait(relayed.error ?? `${route.device} is not reachable right now`);
      // (ADR-091 follow-up) it can never go (an old name): a failure for good — not "delivered" to the local inbox
      if (relayed.terminal) return fail(relayed.error ?? `${route.device} cannot be reached`, true);
      return toUser ? userSink('user-inbox:relay-failed') : fail(relayed.error ?? `relay to ${route.device} failed`);
    }
    const delivered = opts.mailbox.markDelivered(claimed.id);
    emit({
      kind: 'delivered',
      message: delivered,
      // ADR-037: it reached their message requests, not their inbox — they have not accepted you yet
      detail: `relayed-to:${route.device}${relayed.via ? ` via ${relayed.via}` : ''}${relayed.request ? ' — request pending (in their message requests until they accept you)' : ''}`,
    });
    return true;
  }

  // Local: a reply addressed to the human has no session to resume — landing in this
  // machine's mailbox IS the delivery (read in the console). Nothing else local is claimed.
  if (claimed.to.agent === 'user') {
    const delivered = opts.mailbox.markDelivered(claimed.id);
    emit({ kind: 'delivered', message: delivered, detail: 'user-inbox' });
    return true;
  }
  // scope 'outbound' never hands out other local mail; put it back untouched if it ever does
  return fail('not for the core: local session mail is the dispatch plugin\'s');
}
export interface RunningDispatcher {
  stop(): void;
}

/** Poll the mailbox forever; drains the queue then idles at intervalMs. */
export function startDispatcher(
  opts: DispatcherOptions,
  { intervalMs = 1000 }: { intervalMs?: number } = {},
): RunningDispatcher {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // drain everything currently pending before going back to sleep
      while (!stopped && (await dispatchOnce(opts))) {
        /* keep draining */
      }
    } catch {
      // dispatchOnce already records failures; never let the loop die
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
