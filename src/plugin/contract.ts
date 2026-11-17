import type { messageView } from '../commands/messaging.js';

/**
 * What a plugin sees and can do (ADR-051, ADR-052; docs/PLUGINS.md). Every method maps
 * to one `morse` command — `cli-client.ts` runs them; `local-client.ts` does the same
 * in-process (tests). A plugin depends on this file only.
 */

/** A message as `morse plugin watch --json` / `morse message --id <id> --json` give it. */
export type PluginMessage = ReturnType<typeof messageView> & {
  /**
   * ADR-089, on a message claimed with a lease: the holder id every later report on it carries (ack, nack,
   * release, extend) and when the lease runs out unless extended. Only a claim's answer has it.
   */
  lease?: { holder: string; expiresAt: number };
};

/** ADR-089: ask for a lease with a claim — `pid`: the process it lives and dies with (default: the caller). */
export interface LeaseOptions {
  pid?: number;
  ttlMs?: number;
}

export interface ClaimNextOptions {
  /** Local session ids to pass over (live / monitored ones the plugin will not deliver into). */
  skipSessions?: string[];
  /** Message ids to pass over (e.g. one just handed back because its session is live). */
  skipIds?: string[];
  /** ADR-089: hold it under a lease (`message.lease` in the answer). Without: the semantics of before. */
  lease?: LeaseOptions;
}

export type ReplyOutcome = { ok: true; id: string } | { ok: false; error: string; reason?: string };

export interface CoreClient {
  /** `morse plugin claim --next --json`: the oldest own-agent message for a session here that is
   *  due (new, or a failed one past its backoff) — now held by the caller ('delivering'). */
  claimNext(opts?: ClaimNextOptions): Promise<PluginMessage | null>;
  /** `morse plugin claim <id> --json`: hold this one, if it is still due (null = someone else has it). */
  claim(id: string, opts?: { lease?: LeaseOptions }): Promise<PluginMessage | null>;
  /** `morse plugin ack <id> [--holder <h>]`: delivered (and processed). Under a lease only the current holder's
   *  counts: a refused one rejects with a LeaseLost error (`isLeaseLost`), nothing changed. */
  ack(id: string, opts?: { inSession?: boolean; by?: string; holder?: string }): Promise<void>;
  /** `morse plugin nack <id> --error …`: failed; retried after a backoff, dead after 3 (or now with terminal). */
  nack(id: string, error: string, opts?: { terminal?: boolean; holder?: string }): Promise<void>;
  /** `morse plugin nack <id> --release`: hand it back untouched (no attempt counted) — e.g. its session went live. */
  release(id: string, opts?: { holder?: string }): Promise<void>;
  /** `morse plugin nack <id> --to-mailbox`: its session is gone — to that agent's mailbox instead. */
  toMailbox(id: string, note: string, opts?: { holder?: string }): Promise<boolean>;
  /** `morse plugin extend <id> --holder <h>` (ADR-089): still at it — the lease lasts another ttl from now, tied
   *  to `pid` from now on when given. false = not the holder any more. */
  /** `started` (`--started`): say it BEFORE you start the agent for this claim — a claim that is taken over without it
   *  was never worked on: it is handed out again unlabelled; with it, the next delivery is a possible repeat.
   *  `maxMs` (`--max`): the turn ends within this from now at the latest (the agent CLI's own time limit) — a
   *  started turn that neither reports nor renews is taken over after it, even if its process is still there. */
  extend(id: string, holder: string, opts?: LeaseOptions & { started?: boolean; maxMs?: number }): Promise<boolean>;
  /** `morse reply <id> <text> --via auto --json`. */
  reply(id: string, text: string, opts?: { via?: string; by?: string }): Promise<ReplyOutcome>;
  /** `morse plugin claim --recover`: messages held by a plugin that died mid-delivery go back in line. */
  recover(): Promise<number>;
  /** `morse message --json`: received and not processed (ADR-061: own mail to an agent's inbox). */
  todo(): Promise<PluginMessage[]>;
  /** `morse done <ids…>`: marked processed (the ids it changed). */
  done(ids: string[], opts?: { by?: string }): Promise<string[]>;
}

/** ADR-089: was this report refused because the caller is not (or no longer) the holder? */
export const isLeaseLost = (e: unknown): boolean => /lease lost/i.test(e instanceof Error ? e.message : String(e));
