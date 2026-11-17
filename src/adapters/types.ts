/** A discoverable, addressable agent session (local, or on a paired LAN device). */
export interface SessionInfo {
  /** Agent kind: 'claude' | 'codex' | ... */
  agent: string;
  /** Device name for remote sessions; unset = this machine. */
  device?: string;
  /** Stable session/thread id used for resume-based delivery. */
  sessionId: string;
  /** Human-readable title used for @-target matching and UI display. */
  title: string;
  /** Project working directory. Claude resume MUST run with this cwd; '' if unknown. */
  cwd: string;
  /** Last activity, epoch ms. */
  lastActiveAt: number;
  /** CLI/App version that last wrote the session, when the transcript records it.
   *  Compared against the delivering CLI before a headless resume (ADR-025). */
  writerVersion?: string;
}

export interface AgentAdapter {
  readonly agent: string;
  listSessions(): Promise<SessionInfo[]>;
}

export interface DeliveryResult {
  ok: boolean;
  /** Target agent's stdout for the injected turn (reply extraction source). */
  output?: string;
  error?: string;
  /** The message was handed to the target's OWN live runtime (codex queue, zcode
   *  mailbox), which runs it as its own turn — not a separate headless turn. */
  inSession?: boolean;
  /** false = terminal failure, do not auto-retry (e.g. a timeout — the turn
   *  already ran on the target, so re-running it just duplicates the work). */
  retry?: boolean;
  /** The session to resume does not exist (nothing ran) — ADR-056. */
  missingSession?: boolean;
}

/**
 * How to launch the agent for one delivery (ADR-054): the owner's per-agent settings
 * from the dispatch plugin's config. Only the Claude adapter supports them today; every
 * field is optional (unset = the CLI's own default). Validated before it gets here —
 * a bypass-style permission mode never does.
 */
export interface LaunchOptions {
  /** `--permission-mode` (default | acceptEdits | plan | dontAsk). */
  permissionMode?: string;
  /** `--allowedTools` (tool names, or `Bash(<fixed command prefix>:*)`). */
  allowedTools?: string[];
  model?: string;
  effort?: string;
  /** `--append-system-prompt` (with the snapshot off, so resumed sessions see it too). */
  appendSystemPrompt?: string;
  timeoutMs?: number;
  /** Set by the dispatch plugin only (never from config): start a NEW session with this
   *  id (`--session-id`) instead of resuming it — a profile's dedicated session (ADR-056). */
  createSession?: boolean;
}

export interface DeliveryAdapter extends AgentAdapter {
  /** Inject an envelope into the target session (resume-based in Phase 1). */
  deliver(session: SessionInfo, envelope: string, launch?: LaunchOptions): Promise<DeliveryResult>;
  /** Cheap pre-send check (no turn is run): null = deliverable, else a
   *  human-facing error, e.g. `version_mismatch: …` (ADR-025). */
  preflight?(session: SessionInfo): Promise<string | null>;
  /** How the recipient must answer for this delivery: 'marker' (read from the CLI's
   *  stdout, the default) or 'command' (`anyd reply`, when the turn runs inside an
   *  App we can't read output from — ADR-027). */
  replyChannel?(session: SessionInfo): 'marker' | 'command';
}

/** Injectable subprocess runner so adapter contract tests never spawn real CLIs. */
export type ExecFn = (
  cmd: string,
  args: string[],
  /** env: the child's whole environment (unset = this process's). */
  opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number }>;
