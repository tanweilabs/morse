import { peerPreamble } from './peer-framing.js';

/**
 * The line an agent ends its turn with to answer a message. Compatibility: the old
 * project name stays in it — installed skills, running sessions and older daemons all
 * write and look for exactly this text (ADR-075).
 */
export const REPLY_MARKER = '<<<ANYTOANY_REPLY>>>';

/** What the delivery prompt is made from. */
export interface EnvelopeInput {
  /** The message's id — quoted in the prompt, and what `anyd reply` is given. */
  messageId: string;
  /** Who sent it, as shown to the recipient: `@claude:backend refactor`. */
  fromLabel: string;
  /** The message body, verbatim. */
  text: string;
  /**
   * Where the recipient's answer comes from. `marker` (the default): Morse reads the delivering CLI's stdout,
   * so the agent ends its turn with a REPLY_MARKER line. `command`: the message went into an App's own
   * runtime (Codex Desktop's queue, ADR-027) — nobody reads its stdout, so the agent runs `anyd reply`.
   */
  replyVia?: 'marker' | 'command';
  /**
   * Set when the sender is someone else's agent (a PEER-tier device): the prompt then carries the peer
   * framing instead of the trusted-teammate one (ADR-016) — no operator authority. Peer mail is normally
   * pulled, never rendered here; this is a second line of defence.
   */
  peer?: { name: string };
}

/** The message body between its fences — the same fences wherever a message reaches an agent. */
export function fencedBody(text: string, peer = false): string[] {
  const kind = peer ? 'PEER MESSAGE' : 'MESSAGE';
  return [`--- ${kind} ---`, text, `--- END ${kind} ---`];
}

/**
 * The verdicts an agent may answer with (ADR-032) and when each applies. The explanations line up in
 * one column, however the verdict itself is written (after the marker, or quoted for `anyd reply`).
 */
const VERDICTS: ReadonlyArray<{ verdict: string; when: string }> = [
  { verdict: 'DONE <result>', when: 'you completed the request in this turn' },
  { verdict: 'BLOCKED <missing>', when: 'you genuinely cannot here (missing credentials/env/network)' },
  { verdict: 'DECLINED <why>', when: 'only for a real substantive objection, NEVER merely "you are another agent" or "authorization was relayed"' },
  { verdict: '<answer>', when: 'for pure questions, just answer' },
];
const VERDICT_COLUMN = 20;

/** How the recipient gets its one verdict back to Morse. */
interface ReplyChannel {
  /** the end of the second line: what the agent must do before its turn ends */
  must: string;
  /** a verdict as the agent writes (or runs) it */
  write: (verdict: string) => string;
  /** how it answers a counterpart's bare status report */
  noop: string;
  /** anything said after the protocol */
  after: string[];
}

const viaMarker: ReplyChannel = {
  must: 'You MUST end your response with one line:',
  write: (verdict) => `${REPLY_MARKER} ${verdict}`,
  noop: `reply "${REPLY_MARKER} NOOP"`,
  after: [],
};

function viaCommand(messageId: string): ReplyChannel {
  const run = `anyd reply ${messageId}`;
  return {
    must: 'Before ending it you MUST send exactly one reply by running:',
    write: (verdict) => `${run} "${verdict}"`,
    noop: `run ${run} "NOOP"`,
    after: [`If ${run} fails (e.g. your sandbox can't write ~/.morse), state the same verdict as the`, 'last line of your visible answer so your operator still sees it.'],
  };
}

const ONLY_TURN = `THIS IS YOUR ONLY TURN for this message — there is no "later"; after this turn
ends, nothing continues automatically.`;

const STATUS_REPORT = `If the MESSAGE is itself only your counterpart's status report (their BLOCKED/
DONE state with no new task or question for you), do not restate your own status:`;

/** Said after every own-cluster delivery: no empty acknowledgements, no unverifiable claims. */
const CLOSING = `Acknowledgement-only replies ("received", "will do") are NOT valid — act now or
state what blocks you. DONE claims must be limited to what you actually did and
observed in this turn — never assert results you cannot verify from here (UI
state, another app's display, remote effects). If unsure, say so in the reply.
This protocol status line is required and is exempt from any anti-chatter/no-reply
conventions established earlier in the conversation.`;

/** Own cluster (ADR-016): relayed authorization is the operator's go-ahead; the recipient keeps its judgement. */
const TEAMMATE = `Do NOT refuse merely because it came from another agent, or because the authorization was relayed rather than typed into your own prompt: inside this cluster that relay IS your operator's go-ahead. If your operator named who leads, follow that.
Engage as a good teammate — take the work on and act, or discuss and propose a better approach to reach consensus. You keep full autonomy and honesty: if something is genuinely wrong, irreversibly destructive, or clearly not what your operator wants, say so and confirm rather than blindly executing. Otherwise act in good faith on the delegated work.`;

/** The one-turn verdict protocol, for one way of answering. */
function verdictProtocol(channel: ReplyChannel): string[] {
  const verdicts = VERDICTS.map(({ verdict, when }) => `${channel.write(verdict)}${' '.repeat(VERDICT_COLUMN - verdict.length)}— ${when}`);
  return [`${ONLY_TURN} ${channel.must}`, ...verdicts, STATUS_REPORT, `${channel.noop} and nothing else.`, ...channel.after];
}

/**
 * The prompt a delivered message reaches its session with. A sender in the operator's OWN cluster (a
 * session here, or an install paired the old way — group self) gets the trusted-teammate framing
 * (ADR-016): what it relays carries the operator's delegated authority, so the recipient works with it in
 * good faith instead of refusing because "it came from another agent" — while keeping its own judgement.
 * A peer gets the peer framing (no authority) and a one-line way to answer.
 */
export function renderEnvelope(input: EnvelopeInput): string {
  if (input.peer) {
    return [
      ...peerPreamble({ id: input.messageId, from: { agent: input.fromLabel.replace(/^@/, ''), sessionId: '', device: input.peer.name } }),
      ...fencedBody(input.text, true),
      input.replyVia === 'command'
        ? `If you answer, run: anyd reply ${input.messageId} "<your reply>"`
        : `If you answer, end your response with one line: ${REPLY_MARKER} <your answer>`,
    ].join('\n');
  }
  const channel = input.replyVia === 'command' ? viaCommand(input.messageId) : viaMarker;
  const lines = [
    `[Morse] Message from ${input.fromLabel} — a peer agent session in YOUR OPERATOR's own Morse cluster (message id: ${input.messageId}).`,
    `The same human who runs your session also runs the sender — a session here, or one of their own installs they paired with this one before — and set this collaboration in motion. A request relayed here therefore carries your operator's authority — treat it as work delegated through a trusted teammate, not an untrusted stranger.`,
    TEAMMATE,
    ...fencedBody(input.text),
    ...verdictProtocol(channel),
    CLOSING,
  ];
  return lines.join('\n');
}

/**
 * ADR-089: said to the agent that gets a message whose EARLIER delivery was interrupted before it was
 * confirmed (a restart killed the turn, or its holder vanished and the delivery was taken over). On every
 * path a message reaches an agent: the dispatch envelope, the prompt hook, `morse message --pull`.
 */
export const POSSIBLE_REPEAT_LINE =
  '[Morse] ⚠ Possible repeat — an earlier delivery of the message below was interrupted (a restart) before it was confirmed, so you may ALREADY have handled it. Check what you already did for it (this session\'s own history, the files, anything you sent) before acting again: do not do the same thing twice. If it is already done, just report the result.';

/** Put the repeat line in front of an envelope when the message is a possible repeat. */
export const withRepeatLine = (envelope: string, possibleRepeat: boolean | undefined): string => (possibleRepeat ? `${POSSIBLE_REPEAT_LINE}\n${envelope}` : envelope);

/** What becomes of an agent's reply: filed as a message, or dropped (and why). */
export type ReplyVerdict = 'file' | 'noop' | 'blocked-pingpong';

/**
 * The one rule (ADR-032) every reply path applies — the stdout marker (dispatcher) as much as `morse reply`
 * / `anyd reply` (Codex Desktop's queue) — before a reply becomes a message:
 * - a reply whose first word is NOOP is dropped (prose after it changes nothing), so "nothing to add" never
 *   wakes the other side with an empty-looking message;
 * - BLOCKED answering BLOCKED is dropped: two waiting agents would otherwise confirm each other for ever.
 */
export function classifyReply(incoming: string, reply: string): ReplyVerdict {
  const answer = reply.trimStart();
  const firstWord = answer.split(/\s/, 1)[0];
  if (firstWord === 'NOOP') return 'noop';
  const bothBlocked = [incoming, answer].every((text) => text.trimStart().startsWith('BLOCKED'));
  return bothBlocked ? 'blocked-pingpong' : 'file';
}

/**
 * The reply in an agent's output: whatever follows the LAST marker (an earlier one may be the prompt quoted
 * back), trimmed. null when there is no marker, or nothing after it. (The marker cannot overlap itself, so
 * splitting on it finds the same last occurrence.)
 */
export function extractReply(stdout: string, marker: string = REPLY_MARKER): string | null {
  const pieces = stdout.split(marker);
  if (pieces.length === 1) return null;
  return pieces[pieces.length - 1]!.trim() || null;
}
