import type { ExecFn } from './types.js';

/*
 * ADR-025 — check the CLI before a headless resume.
 *
 * Morse resumes sessions with the globally installed CLI, while the sessions themselves are
 * mostly written by a desktop App that ships its own, frequently newer, copy. When the
 * global CLI is behind, the resume fails — often as nothing more than "exit 1" — and the
 * pull hook later picks the message up anyway, so the real cause never surfaces (seen
 * 2026-10-12: CLI 2.1.287 against App 2.1.295, one message dead-lettered after three tries).
 * Comparing the two before sending turns that into one clear error with the fix in it.
 */

/** Every refusal starts with this; the server, the notifier and the prompt hook match on it. */
export const VERSION_MISMATCH = 'version_mismatch';

type Core = [major: number, minor: number, patch: number];

const PROBE_TTL_MS = 60_000;
const ASK_TIMEOUT_MS = 10_000;

/**
 * The `major.minor.patch` numbers in a version string such as "codex-cli 0.157.1" or
 * "2.1.296 (Claude Code)" — the first such triple wins. Prerelease and build tags are not
 * part of the comparison. null when the string holds no triple.
 */
export function parseVersion(raw: string): Core | null {
  const found = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
}

/** Negative, zero or positive as `a` sorts before, with, or after `b`. */
function compare(a: Core, b: Core): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Should this CLI be kept from resuming what `writerVersion` wrote? Only when it is
 * strictly older. Newer CLIs read older sessions fine (the usual state after an update),
 * and if either side cannot be read the delivery is not blocked here — its own error
 * handling deals with whatever happens.
 */
export function isCliOlder(cliVersion: string, writerVersion: string): boolean {
  const [cli, writer] = [cliVersion, writerVersion].map(parseVersion);
  if (!cli || !writer) return false;
  return compare(cli, writer) < 0;
}

/** A sighting: at time `at` (epoch ms), `originator` (say 'Codex Desktop') was at `version`. */
export interface WriterSample {
  originator: string;
  version: string;
  at: number;
}

/**
 * The version that most plausibly wrote a session last. Codex stamps `cli_version` into a
 * thread once, at creation, so a Desktop thread from months ago still claims an old version
 * while today's Desktop keeps writing to it. Every sighting of the same originator up to the
 * session's last activity is a version that may have written it; the highest of those and
 * the session's own record is the answer. With no originator there is nothing to go on but
 * the own record.
 */
export function inferWriterVersion(
  own: string | undefined,
  originator: string | undefined,
  lastActiveAt: number,
  samples: readonly WriterSample[],
): string | undefined {
  if (!originator) return own;
  const candidates = samples.filter((s) => s.originator === originator && s.at <= lastActiveAt).map((s) => s.version);
  let winner = own;
  let winnerCore = own === undefined ? null : parseVersion(own);
  for (const version of candidates) {
    const core = parseVersion(version);
    if (!core) continue;
    if (winnerCore && compare(core, winnerCore) <= 0) continue;
    winner = version;
    winnerCore = core;
  }
  return winner;
}

export type VersionProbe = () => Promise<string | null>;

/**
 * A memoised `<cmd> --version`. Within `ttlMs` of the last ask the remembered answer is
 * returned, so a busy dispatch loop does not spawn per message; after that it asks again,
 * so an upgrade counts within a minute without restarting the daemon. A CLI that is
 * missing, fails or prints nothing answers null, which never blocks a delivery.
 */
export function createVersionProbe(
  exec: ExecFn,
  cmd: string,
  opts: { ttlMs?: number; now?: () => number } = {},
): VersionProbe {
  const ttlMs = opts.ttlMs ?? PROBE_TTL_MS;
  const clock = opts.now ?? Date.now;
  let remembered: { askedAt: number; answer: string | null } | undefined;

  const ask = async (): Promise<string | null> => {
    try {
      const run = await exec(cmd, ['--version'], { timeoutMs: ASK_TIMEOUT_MS });
      const text = run.stdout.trim();
      return run.code === 0 && text !== '' ? text : null;
    } catch {
      return null;
    }
  };

  return async () => {
    if (remembered && clock() - remembered.askedAt <= ttlMs) return remembered.answer;
    const answer = await ask();
    remembered = { askedAt: clock(), answer };
    return answer;
  };
}

/** What the refusal message names for one agent. */
export interface VersionGuardSpec {
  /** The CLI Morse runs for delivery, e.g. 'codex'. */
  cli: string;
  /** What normally writes the sessions, as people know it. */
  app: string;
  /** The command that fixes it, verbatim. */
  upgrade: string;
}

function refusal(spec: VersionGuardSpec, cliVersion: string, writerVersion: string): string {
  const sentences = [
    `${VERSION_MISMATCH}: the ${spec.cli} CLI Morse delivers with (${cliVersion}) is older than the ${spec.app} that last wrote this session (${writerVersion}).`,
    'Resuming it with the older CLI fails (often a bare "exit 1"), so the message was NOT sent.',
    `Ask the operator to upgrade: ${spec.upgrade} — then resend (a dead-lettered one can be retried from the web console: morse console).`,
    'See ADR-025.',
  ];
  return sentences.join(' ');
}

/** null when delivery may go ahead; otherwise the `version_mismatch: …` text for the sender. */
export async function checkCliVersion(
  probe: VersionProbe,
  spec: VersionGuardSpec,
  writerVersion: string | undefined,
): Promise<string | null> {
  // nothing recorded about the writer: nothing to compare, and no reason to spawn the CLI
  if (writerVersion === undefined || writerVersion === '') return null;
  const installed = await probe();
  return installed && isCliOlder(installed, writerVersion) ? refusal(spec, installed, writerVersion) : null;
}
