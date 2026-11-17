import type { ExecFn } from '../../src/adapters/types.js';

/** One subprocess an adapter asked for, exactly as it asked for it. */
export interface RecordedRun {
  cmd: string;
  args: string[];
  opts: Parameters<ExecFn>[2];
}

export interface CannedResult {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * A stand-in for `realExec`: nothing is spawned. Every run is recorded, and answered
 * with `answer` (a fixed result, or one picked per run). Missing fields mean an empty
 * stream and exit 0.
 */
export function recordingExec(answer: CannedResult | ((run: RecordedRun) => CannedResult) = {}) {
  const runs: RecordedRun[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    const run: RecordedRun = { cmd, args, opts };
    runs.push(run);
    const picked = typeof answer === 'function' ? answer(run) : answer;
    return { stdout: picked.stdout ?? '', stderr: picked.stderr ?? '', code: picked.code ?? 0 };
  };
  /** Each run as one flat argv: [cmd, ...args]. */
  const argvs = (): string[][] => runs.map((r) => [r.cmd, ...r.args]);
  return { exec, runs, argvs };
}

/** A CLI that reports `version` for `--version` and answers every other run with `turn`. */
export function cliReporting(version: string, turn: CannedResult = { stdout: 'TURN OUTPUT' }) {
  return recordingExec((run) => (run.args[0] === '--version' ? { stdout: `${version}\n` } : turn));
}
