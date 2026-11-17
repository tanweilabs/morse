/**
 * Contracts between Morse and the per-agent adapters (ADR-005). An adapter knows one
 * agent CLI: how to find its sessions on disk, and how to hand a message to one of them
 * through that CLI's official headless channel.
 */

/** One agent session Morse can address — on this machine, or on a paired LAN device. */
export interface SessionInfo {
  /** Which agent runs it: 'claude', 'codex', 'kimi', 'zcode', or a registered app's name. */
  agent: string;
  /** Name of the paired device that hosts it; absent for this machine. */
  device?: string;
  /** The agent's own id for the session; resume-style delivery targets exactly this id. */
  sessionId: string;
  /** What people see in listings and what @-targets are matched against. */
  title: string;
  /** The session's project directory, or '' when unknown. A Claude resume only works from it. */
  cwd: string;
  /** Most recent activity in epoch milliseconds. */
  lastActiveAt: number;
  /** Version of the CLI/App that last wrote the session, when the transcript tells.
   *  Checked against the global CLI before a headless resume (ADR-025). */
  writerVersion?: string;
}

/** Something that can enumerate sessions. Pull-only directories implement just this. */
export interface AgentAdapter {
  readonly agent: string;
  listSessions(): Promise<SessionInfo[]>;
}

/** The outcome of one delivery attempt. */
export interface DeliveryResult {
  ok: boolean;
  /** What the target printed for the turn; the reply marker is looked for here. */
  output?: string;
  /** Why it failed, worded for the sender. */
  error?: string;
  /** Handed to the target's own running process (Codex queue, ZCode mailbox), which runs
   *  it as one of its turns — there is no separate headless turn and no stdout to read. */
  inSession?: boolean;
  /** false: do not retry automatically — e.g. after a timeout the turn has already run,
   *  so a second attempt would do the same work again. */
  retry?: boolean;
  /** The session to resume does not exist, so nothing ran (ADR-056). */
  missingSession?: boolean;
}

/**
 * Per-delivery launch settings (ADR-054), taken from the dispatch plugin's per-agent
 * config. Only Claude honours them today. Each field is optional — unset means the CLI's
 * own default — and they are validated before they get here: a mode that bypasses
 * permission checks is never accepted.
 */
export interface LaunchOptions {
  /** `--permission-mode`: default, acceptEdits, plan or dontAsk. */
  permissionMode?: string;
  /** `--allowedTools`: tool names, or `Bash(<fixed command prefix>:*)`. */
  allowedTools?: string[];
  model?: string;
  effort?: string;
  /** `--append-system-prompt`; sent with the prompt snapshot off so resumed sessions get it as well. */
  appendSystemPrompt?: string;
  timeoutMs?: number;
  /** Never read from config — only the dispatch plugin sets it: create the session under
   *  this id (`--session-id`) rather than resume it; a profile's own session (ADR-056). */
  createSession?: boolean;
}

/** An adapter that can also deliver into its sessions. */
export interface DeliveryAdapter extends AgentAdapter {
  /** Put the envelope into the session as a turn. */
  deliver(session: SessionInfo, envelope: string, launch?: LaunchOptions): Promise<DeliveryResult>;
  /** A check before sending that runs no turn: null when the session can be delivered to,
   *  otherwise the error to show the sender, such as `version_mismatch: …` (ADR-025). */
  preflight?(session: SessionInfo): Promise<string | null>;
  /** How the recipient answers this delivery: 'marker' — a line in the CLI's stdout (the
   *  default) — or 'command' — it runs `anyd reply`, because the turn happens inside an
   *  App whose output Morse cannot read (ADR-027). */
  replyChannel?(session: SessionInfo): 'marker' | 'command';
}

/** How adapters start subprocesses; tests pass a fake so no real CLI is ever spawned. */
export type ExecFn = (
  cmd: string,
  args: string[],
  /** env, when given, is the child's entire environment; otherwise it inherits ours. */
  opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number }>;
