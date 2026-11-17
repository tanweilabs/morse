import { setTimeout as sleep } from 'node:timers/promises';
import type { Mailbox } from '../mailbox/mailbox.js';
import { sessionOrExit, sessionsInDirectory } from './sessions.js';

/** A session `--pull` / `--wait` reads for, and how it is headed in the output. */
export interface MailTarget {
  id: string;
  label: string;
}

/**
 * The sessions `morse read --pull` / `--wait` act for: the one --session names (or the command ends, see
 * sessionOrExit), else every session whose project directory is this one. `quiet`: say nothing when there is none.
 */
export async function mailTargets(opts: { session?: string; cwd?: string }, quiet?: boolean): Promise<MailTarget[]> {
  const label = (s: { agent: string; title: string }): string => `@${s.agent}:${s.title}`;
  if (opts.session) {
    const one = await sessionOrExit(opts.session);
    return [{ id: one.sessionId, label: label(one) }];
  }
  const cwd = opts.cwd ?? process.cwd();
  const here = await sessionsInDirectory(cwd);
  if (here.length === 0 && !quiet) console.log(`no session found for ${cwd} — open a session here, or pass --session "@<agent>:<fragment>"`);
  return here.map((s) => ({ id: s.sessionId, label: label(s) }));
}

/** Each target's text under its heading (targets without any are left out); true when something was printed. */
export function printPerTarget(targets: MailTarget[], textOf: (target: MailTarget) => string | null): boolean {
  let printed = 0;
  for (const target of targets) {
    const text = textOf(target);
    if (text === null) continue;
    console.log([`===== ${target.label} =====`, text, ''].join('\n'));
    printed++;
  }
  return printed > 0;
}

/**
 * `morse read --pull`: what is new for the targets — or, with `history`, a read-only view of their recent
 * exchange, so what happened stays visible after a headless delivery moved the cursor on.
 */
export async function pullFor(mailbox: Mailbox, targets: MailTarget[], opts: { history?: boolean; limit?: string; quiet?: boolean; fullForeign?: boolean }): Promise<void> {
  const { collectInbox, recentExchange } = await import('../hooks/prompt-hook.js');
  if (opts.history) {
    const limit = Number.parseInt(opts.limit ?? '', 10) || 15;
    const any = printPerTarget(targets, (t) => recentExchange(mailbox, t.id, limit));
    if (!any && !opts.quiet) console.log('no Morse history for this session yet.');
    return;
  }
  // (an explicit read of the Morse mailbox shows other people's text too, labelled)
  const any = printPerTarget(targets, (t) => collectInbox(mailbox, t.id, opts.fullForeign ? { foreign: 'full' } : {}));
  if (!any && !opts.quiet) console.log('no new Morse messages — run `morse read --pull --history` to see the recent exchange (delivered ones included).');
}

/**
 * `morse read --wait`: poll until mail for one of the targets arrives (print it and return, so the agent acts
 * and replies, then waits again) or the window closes. Meanwhile a heartbeat per target tells the daemon not
 * to resume-deliver to them; it is cleared on every way out — a return, Ctrl-C, a kill — so normal delivery
 * resumes at once instead of after the heartbeat goes stale.
 */
export async function waitFor(mailbox: Mailbox, targets: MailTarget[], opts: { timeout?: string; poll?: string }): Promise<void> {
  const { collectInbox } = await import('../hooks/prompt-hook.js');
  const { heartbeat, clearMonitor } = await import('../daemon/monitor.js');
  const windowMs = 1000 * (Number.parseInt(opts.timeout ?? '', 10) || 1800);
  const everyMs = Number.parseInt(opts.poll ?? '', 10) || 1500;
  const until = Date.now() + windowMs;
  const release = (): void => targets.forEach((t) => clearMonitor(t.id));
  process.once('exit', release);
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  console.log(`waiting for messages to ${targets.map((t) => t.label).join(', ')}…`);
  while (true) {
    targets.forEach((t) => heartbeat(t.id));
    if (printPerTarget(targets, (t) => collectInbox(mailbox, t.id))) break;
    if (Date.now() >= until) {
      release();
      console.log('nothing arrived in the window — run `morse read --wait` again to keep waiting.');
      return;
    }
    await sleep(everyMs);
  }
  release();
}
