import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, expect } from 'vitest';

/**
 * ONE rule for the timeout of a test that runs the real CLI (`node --import tsx src/cli.ts …`, a new
 * process each time): a test may take
 *
 *     spawnBudget(n) = SPAWN_BASE_MS + n × SPAWN_MS        n = how many times it starts the CLI
 *
 * - `SPAWN_BASE_MS` (5 s) is vitest's own default: what a test that starts no process gets.
 * - `SPAWN_MS` (5 s) is what ONE start may take. Measured on the machine these tests were written on
 *   (2026-11-14, 12 cores): about 0.13 s wall / 0.22 s CPU for `morse contact --json` when the machine is
 *   idle — and several seconds when the whole suite runs twice back to back (load average 15–35), which
 *   is when tests with three or more starts ran into the flat 5 s. 5 s per start is ~40 × the idle time.
 *
 * Nothing is raised across the board: a test that starts the CLI once gets 10 s, one that starts it
 * twenty times 105 s. A test that already asked for MORE than its budget (it also waits for a daemon or
 * a relay) keeps what it asked for.
 *
 * The rule checks itself: `enforceSpawnBudget()` (once per test file) counts the starts of every test
 * (`countSpawn()`, called by the file's `cliAt`) and fails the test when its timeout is smaller than
 * the budget for the starts it really made — so a start added to a test without raising its `n` is
 * found by the test run, not by a slow machine. Starts made in a `beforeAll` are the hook's: its
 * timeout is given by the same rule (`beforeAll(fn, spawnBudget(n))`, or more when it also starts
 * daemons), and its last line is `checkHookSpawns(n)`.
 *
 * `SPAWN_BUDGET_REPORT=<file>` appends one JSON line per test (name, starts, timeout) — how the `n` of
 * each test was counted.
 */
export const SPAWN_BASE_MS = 5_000;
export const SPAWN_MS = 5_000;
export const spawnBudget = (spawns: number): number => SPAWN_BASE_MS + spawns * SPAWN_MS;

let spawned = 0;
/** One start of the CLI (called by the test file's own `cliAt`). */
export const countSpawn = (): void => {
  spawned++;
};
/**
 * The last line of a `beforeAll` that starts the CLI and whose timeout is `spawnBudget(declared)` (or more):
 * it must not have started it more often than it declared.
 */
export const checkHookSpawns = (declared: number): void => {
  const made = spawned;
  spawned = 0;
  expect(made, `this hook started the CLI ${made} time(s) but its timeout was given for ${declared}: give it spawnBudget(${made}) (test/helpers/spawn-budget.ts)`).toBeLessThanOrEqual(declared);
};

/** Call once at the top of a test file whose tests start the CLI: every test's timeout must cover its starts. */
export function enforceSpawnBudget(): void {
  beforeEach(() => {
    spawned = 0;
  });
  afterEach((ctx) => {
    const made = spawned;
    spawned = 0;
    const timeout = ctx.task.timeout;
    const report = process.env['SPAWN_BUDGET_REPORT'];
    if (report) appendFileSync(report, `${JSON.stringify({ file: ctx.task.file?.name, name: ctx.task.name, spawns: made, timeout })}\n`);
    expect(timeout, `this test started the CLI ${made} time(s): its timeout must be at least spawnBudget(${made}) = ${spawnBudget(made)} ms (test/helpers/spawn-budget.ts)`).toBeGreaterThanOrEqual(spawnBudget(made));
  });
}
