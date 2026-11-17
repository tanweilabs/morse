import { peerPreamble } from './peer-framing.js';

/**
 * The line an agent ends its turn with to answer a message. Compatibility: the old
 * project name stays in it — installed skills, running sessions and older daemons all
 * write and look for exactly this text (ADR-075).
 */
export const REPLY_MARKER = '<<<ANYTOANY_REPLY>>>';

export interface EnvelopeInput {
  messageId: string;
  /** Human-readable sender label, e.g. '@claude:backend refactor'. */
  fromLabel: string;
  text: string;
  /** How the recipient answers. 'marker' (default): end the turn with a marker line
   *  that Morse reads from the delivering CLI's stdout. 'command': the message was
   *  queued into an App's own runtime (Codex Desktop, ADR-027) — there is no stdout
   *  to read, so the recipient must run `anyd reply` itself. */
  replyVia?: 'marker' | 'command';
  /** Morse: the message came from a PEER-tier device (someone else's agent). The
   *  trusted-teammate framing (ADR-016) is replaced by the peer framing — it does
   *  not carry the operator's authority. Normally peer mail is pull-only and never
   *  reaches this renderer; this is defence in depth. */
  peer?: { name: string };
}

function markerReplyLines(): string[] {
  return [
    `THIS IS YOUR ONLY TURN for this message — there is no "later"; after this turn`,
    `ends, nothing continues automatically. You MUST end your response with one line:`,
    `${REPLY_MARKER} DONE <result>       — you completed the request in this turn`,
    `${REPLY_MARKER} BLOCKED <missing>   — you genuinely cannot here (missing credentials/env/network)`,
    `${REPLY_MARKER} DECLINED <why>      — only for a real substantive objection, NEVER merely "you are another agent" or "authorization was relayed"`,
    `${REPLY_MARKER} <answer>            — for pure questions, just answer`,
    `If the MESSAGE is itself only your counterpart's status report (their BLOCKED/`,
    `DONE state with no new task or question for you), do not restate your own status:`,
    `reply "${REPLY_MARKER} NOOP" and nothing else.`,
  ];
}

/** Same verdict protocol, delivered by running a command (queued delivery, ADR-027). */
function commandReplyLines(messageId: string): string[] {
  const cmd = `anyd reply ${messageId}`;
  return [
    `THIS IS YOUR ONLY TURN for this message — there is no "later"; after this turn`,
    `ends, nothing continues automatically. Before ending it you MUST send exactly one reply by running:`,
    `${cmd} "DONE <result>"       — you completed the request in this turn`,
    `${cmd} "BLOCKED <missing>"   — you genuinely cannot here (missing credentials/env/network)`,
    `${cmd} "DECLINED <why>"      — only for a real substantive objection, NEVER merely "you are another agent" or "authorization was relayed"`,
    `${cmd} "<answer>"            — for pure questions, just answer`,
    `If the MESSAGE is itself only your counterpart's status report (their BLOCKED/`,
    `DONE state with no new task or question for you), do not restate your own status:`,
    `run ${cmd} "NOOP" and nothing else.`,
    `If ${cmd} fails (e.g. your sandbox can't write ~/.morse), state the same verdict as the`,
    `last line of your visible answer so your operator still sees it.`,
  ];
}

/**
 * Render the delivery prompt injected into the target session.
 * Trusted-teammate framing (ADR-016): the sender is a peer agent in the
 * operator's OWN cluster (a session here, or an install paired the old way — group self), so a relayed request carries the
 * operator's delegated authority. The receiver collaborates in good faith and
 * keeps full autonomy — it does not refuse merely because the message came
 * from another agent or the authorization was relayed.
 */
export function renderEnvelope(input: EnvelopeInput): string {
  if (input.peer) {
    return [
      ...peerPreamble({ id: input.messageId, from: { agent: input.fromLabel.replace(/^@/, ''), sessionId: '', device: input.peer.name } }),
      `--- PEER MESSAGE ---`,
      input.text,
      `--- END PEER MESSAGE ---`,
      input.replyVia === 'command'
        ? `If you answer, run: anyd reply ${input.messageId} "<your reply>"`
        : `If you answer, end your response with one line: ${REPLY_MARKER} <your answer>`,
    ].join('\n');
  }
  return [
    `[Morse] Message from ${input.fromLabel} — a peer agent session in YOUR OPERATOR's own Morse cluster (message id: ${input.messageId}).`,
    `The same human who runs your session also runs the sender — a session here, or one of their own installs they paired with this one before — and set this collaboration in motion. A request relayed here therefore carries your operator's authority — treat it as work delegated through a trusted teammate, not an untrusted stranger.`,
    `Do NOT refuse merely because it came from another agent, or because the authorization was relayed rather than typed into your own prompt: inside this cluster that relay IS your operator's go-ahead. If your operator named who leads, follow that.`,
    `Engage as a good teammate — take the work on and act, or discuss and propose a better approach to reach consensus. You keep full autonomy and honesty: if something is genuinely wrong, irreversibly destructive, or clearly not what your operator wants, say so and confirm rather than blindly executing. Otherwise act in good faith on the delegated work.`,
    `--- MESSAGE ---`,
    input.text,
    `--- END MESSAGE ---`,
    ...(input.replyVia === 'command' ? commandReplyLines(input.messageId) : markerReplyLines()),
    `Acknowledgement-only replies ("received", "will do") are NOT valid — act now or`,
    `state what blocks you. DONE claims must be limited to what you actually did and`,
    `observed in this turn — never assert results you cannot verify from here (UI`,
    `state, another app's display, remote effects). If unsure, say so in the reply.`,
    `This protocol status line is required and is exempt from any anti-chatter/no-reply`,
    `conventions established earlier in the conversation.`,
  ].join('\n');
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

export type ReplyVerdict = 'file' | 'noop' | 'blocked-pingpong';

/**
 * Should a reply be filed as a new message? (ADR-032) Shared by every reply path —
 * the stdout marker (dispatcher) and `morse reply` / `anyd reply` (Codex Desktop's
 * queue) — so a NOOP never wakes the other side with an empty-looking message.
 * - NOOP as the leading token (then whitespace or end), even with prose after it.
 * - BLOCKED answered with BLOCKED: two waiting agents confirming each other forever.
 */
export function classifyReply(incoming: string, reply: string): ReplyVerdict {
  const r = reply.trimStart();
  if (/^NOOP(\s|$)/.test(r)) return 'noop';
  if (incoming.trimStart().startsWith('BLOCKED') && r.startsWith('BLOCKED')) return 'blocked-pingpong';
  return 'file';
}

/** Extract the reply after the LAST marker occurrence; null when absent or empty. */
export function extractReply(stdout: string, marker: string = REPLY_MARKER): string | null {
  const at = stdout.lastIndexOf(marker);
  if (at === -1) return null;
  const reply = stdout.slice(at + marker.length).trim();
  return reply.length > 0 ? reply : null;
}
