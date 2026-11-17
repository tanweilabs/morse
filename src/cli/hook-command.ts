import { text } from 'node:stream/consumers';
import { dataDir } from '../home.js';
import type { Mailbox } from '../mailbox/mailbox.js';
import { CURRENT_SCHEMA_VERSION, mailboxVersion } from '../mailbox/db.js';
import type { PromptHookInput } from '../hooks/prompt-hook.js';
import { isWindows } from '../platform/platform.js';

/** The hooks `morse setup` registers, by the name their command line ends with. */
const HOOK_KINDS = new Set(['claude-prompt-submit', 'codex-prompt-submit']);

/** The hook's JSON on stdin; anything that is not a JSON object counts as an empty one (no context then). */
async function readPayload(stdin: NodeJS.ReadableStream): Promise<PromptHookInput> {
  try {
    const parsed: unknown = JSON.parse(await text(stdin));
    return parsed !== null && typeof parsed === 'object' ? (parsed as PromptHookInput) : {};
  } catch {
    return {};
  }
}

/**
 * `morse hook <kind>`: the UserPromptSubmit hook of Claude Code and Codex. Reads the hook's JSON on stdin,
 * prints the context for the prompt as JSON (`{}`: none). An unknown kind: one line, exit code 1.
 */
export async function runHookCommand(kind: string, openMailbox: () => Mailbox): Promise<void> {
  if (!HOOK_KINDS.has(kind)) {
    console.error(`unknown hook kind: ${kind}`);
    process.exitCode = 1;
    return;
  }
  const input = await readPayload(process.stdin);
  if (isWindows()) {
    // ADR-080: a hook that never runs fails silently — leave a trace `morse status --check` can show
    const { recordHookRun } = await import('../platform/win-hooks.js');
    recordHookRun(kind, dataDir());
  }
  // (ADR-080, ADR-083) The hook has to be quick — Codex gives it 10 s, and the user's prompt waits for it. It is
  // never the process that creates the mailbox, nor the one that performs — or waits behind — a schema
  // migration (a backup, a transaction, up to 30 s on the lock): that is the daemon's, or the next ordinary
  // command's. No mailbox yet, or one of an older schema: no context this time, silently.
  const schema = mailboxVersion();
  if (schema === null || schema < CURRENT_SCHEMA_VERSION) {
    console.log('{}');
    return;
  }
  const { processPromptHook } = await import('../hooks/prompt-hook.js');
  // (ADR-088 §4) MORSE_ADDRESS in the session's environment: the one line about other people's mail counts what was
  // written to that address. Unset — or naming no address here (a hook never fails a prompt over it): everything.
  const env = (await import('../commands/known-as.js')).addressFromEnv();
  const mine = env && !('error' in env) ? env : null;
  console.log(JSON.stringify(processPromptHook(openMailbox(), input, mine ? { mineOnly: mine.address } : {})));
}
