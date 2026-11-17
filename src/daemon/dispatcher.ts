import type { DeliveryAdapter, SessionInfo } from '../adapters/types.js';
import { routeForMessage } from '../cluster/routing.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';

/** What happened to one claimed message, reported through `onEvent`. */
export interface DispatchEvent {
  kind: 'delivered' | 'failed' | 'waiting' | 'reply-filed' | 'reply-rejected' | 'redirected';
  message: Message;
  detail?: string;
}

/** What a transport reports after trying to hand a message to another device or person. */
type RelayResult = { ok: boolean; error?: string; waiting?: boolean; terminal?: boolean; via?: string; request?: boolean };

export interface DispatcherOptions {
  mailbox: Mailbox;
  /** No longer read by the core (ADR-052: own-agent delivery moved to the dispatch plugin); still accepted. */
  adapters?: Map<string, DeliveryAdapter>;
  /** No longer read by the core (see `adapters`). */
  directory?: () => Promise<SessionInfo[]>;
  onEvent?: (event: DispatchEvent) => void;
  /** Name of this device. When unset every message is treated as local and nothing is relayed. */
  selfDevice?: string;
  /**
   * Transport to another device (paired LAN peer) or, via the Morse relay, to a person.
   * `waiting` means "not reachable at the moment": the message stays queued and is tried again
   * later with no retry ceiling. `terminal` means it can never be delivered.
   */
  relay?: (device: string, message: Message) => Promise<RelayResult>;
  /** Not read by the core: a session following its own mail with `morse message --wait` (consumed by the dispatch plugin). */
  isMonitored?: (sessionId: string) => boolean;
  /**
   * Not read by the core: a session that is open interactively (a Claude process, a Codex Desktop
   * thread) and picks mail up through its prompt hook instead of a headless resume (ADR-023, ADR-026).
   */
  isSessionLive?: (sessionId: string) => boolean;
  /** Not read by the core: an external registered session (ADR-024) that fetches its mail over HTTP. */
  isPullOnly?: (sessionId: string) => boolean;
  /** Session ids that only ever pull (e.g. 'inbox'); excluded in the claim query so they cannot starve it (ADR-044). */
  pullOnlySessions?: string[];
}

/** How the core settles a claimed message. */
type Outcome =
  | { status: 'delivered'; detail: string }
  | { status: 'failed'; error: string; terminal?: boolean }
  | { status: 'waiting'; error: string };

const REQUEST_PENDING = ' — request pending (in their message requests until they accept you)';

/**
 * Decide the outcome for a message bound for another device or person.
 *
 * Mail to the human ('user') is the operator's escalation channel (ADR-020) and must not be lost:
 * whenever the relay is missing or fails (short of "never deliverable"), it is kept in this
 * machine's inbox — shown in the local console — rather than failed.
 */
async function relayOutcome(message: Message, device: string, opts: DispatcherOptions): Promise<Outcome> {
  const forHuman = message.to.agent === 'user';
  const keepLocally = (why: string): Outcome => ({ status: 'delivered', detail: `user-inbox:${why}` });

  if (opts.relay === undefined) {
    if (forHuman) return keepLocally('relay-unconfigured');
    return { status: 'failed', error: `target device "${device}" requires LAN relay (not configured)` };
  }

  let result: RelayResult;
  try {
    result = await opts.relay(device, message);
  } catch (err) {
    if (forHuman) return keepLocally('relay-error');
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) {
    // ADR-037: `request` = it reached the recipient's message requests; they have not accepted us yet.
    const via = result.via ? ` via ${result.via}` : '';
    return { status: 'delivered', detail: `relayed-to:${device}${via}${result.request ? REQUEST_PENDING : ''}` };
  }
  if (result.waiting) return { status: 'waiting', error: result.error ?? `${device} is not reachable right now` };
  // ADR-091 follow-up: e.g. an old name that no longer resolves. Fail for good, never fall back locally.
  if (result.terminal) return { status: 'failed', error: result.error ?? `${device} cannot be reached`, terminal: true };
  if (forHuman) return keepLocally('relay-failed');
  return { status: 'failed', error: result.error ?? `relay to ${device} failed` };
}

/** Outcome for a message that stays on this device. */
function localOutcome(message: Message): Outcome {
  // The human has no session to resume: the mailbox itself is their inbox (read in the console).
  if (message.to.agent === 'user') return { status: 'delivered', detail: 'user-inbox' };
  // The outbound claim never yields own-session mail; should it ever, hand it back as a plain failure.
  return { status: 'failed', error: "not for the core: local session mail is the dispatch plugin's" };
}

/** Write the outcome to the mailbox and report it. */
function settle(opts: DispatcherOptions, id: string, outcome: Outcome): void {
  const { mailbox } = opts;
  let event: DispatchEvent;
  switch (outcome.status) {
    case 'delivered':
      event = { kind: 'delivered', message: mailbox.markDelivered(id), detail: outcome.detail };
      break;
    case 'waiting':
      event = { kind: 'waiting', message: mailbox.markFailed(id, outcome.error, { waiting: true }), detail: outcome.error };
      break;
    case 'failed':
      event = {
        kind: 'failed',
        message: mailbox.markFailed(id, outcome.error, outcome.terminal ? { terminal: true } : undefined),
        detail: outcome.error,
      };
      break;
  }
  opts.onEvent?.(event);
}

/**
 * One step of the core's delivery work (ADR-052). It claims the oldest due OUTBOUND message —
 * one headed to another device or person, or to the human's own inbox — and passes it to the
 * transport. Running an agent for a session on this computer is the dispatch plugin's job
 * (src/plugins/dispatch), which claims such mail through the plugin contract.
 * Resolves false when there was nothing to claim.
 */
export async function dispatchOnce(opts: DispatcherOptions): Promise<boolean> {
  const pullOnly = opts.pullOnlySessions ?? [];
  const message = opts.mailbox.claimNextPending(
    pullOnly.length > 0 ? { scope: 'outbound', pullOnlySessions: pullOnly } : { scope: 'outbound' },
  );
  if (message === null) return false;

  // Routing comes first even for the human: a reply to someone on another device must travel there.
  const route = routeForMessage(message, opts.selfDevice ?? '');
  const outcome = route.kind === 'relay' ? await relayOutcome(message, route.device, opts) : localOutcome(message);
  settle(opts, message.id, outcome);
  return true;
}

export interface RunningDispatcher {
  stop(): void;
}

/**
 * Keep dispatching until stopped: drain everything that is due, then sleep `intervalMs`
 * before looking again. Errors never end the loop (failures are already recorded per message).
 */
export function startDispatcher(opts: DispatcherOptions, { intervalMs = 1000 }: { intervalMs?: number } = {}): RunningDispatcher {
  let active = true;
  let sleeper: NodeJS.Timeout | undefined;

  const drain = async (): Promise<void> => {
    try {
      let more = true;
      while (active && more) more = await dispatchOnce(opts);
    } catch {
      // swallow: the next round tries again
    }
  };
  const round = (): void => {
    void drain().then(() => {
      if (active) sleeper = setTimeout(round, intervalMs);
    });
  };

  round();
  return {
    stop() {
      active = false;
      clearTimeout(sleeper);
    },
  };
}
