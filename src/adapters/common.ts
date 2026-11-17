import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ExecFn } from './types.js';

/** Default budget for one headless turn when neither the caller nor the owner set one. */
export const DEFAULT_TURN_MS = 300_000;

/** Display titles longer than this are cut. */
export const TITLE_LIMIT = 80;

/** Cut `text` to TITLE_LIMIT characters, marking the cut with an ellipsis. */
export function shortTitle(text: string): string {
  return text.length <= TITLE_LIMIT ? text : `${text.slice(0, TITLE_LIMIT)}…`;
}

/** The last `count` characters of a stream — CLIs print the actual error at the end. */
export const tailOf = (text: string, count = 500): string => text.slice(-count);

/** Spawn options for a turn: the session cwd only when it is known. */
export function runOptions(cwd: string, timeoutMs: number): Parameters<ExecFn>[2] {
  return cwd ? { cwd, timeoutMs } : { timeoutMs };
}

/**
 * An owner-configured per-turn budget (`deliverTimeoutSec` in ~/.morse/config.json), in ms.
 * Only a number of seconds from one minute to one hour counts; anything else is ignored,
 * so a typo can neither starve a turn nor let it run for days.
 */
export function ownerTurnBudgetMs(seconds: unknown): number | null {
  const inRange = typeof seconds === 'number' && seconds >= 60 && seconds <= 3600;
  return inRange ? seconds * 1000 : null;
}

/**
 * Parse a JSON-lines text into its object records. Blank lines, lines that are not JSON
 * (a truncated sample edge, a corrupt write, a banner) and JSON that is not an object are
 * dropped.
 */
export function objectLines<T extends object>(text: string): T[] {
  const records: T[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value !== null && typeof value === 'object') records.push(value as T);
  }
  return records;
}

/** A string field of a loosely typed record, or undefined. */
export function stringField(record: object | undefined, key: string): string | undefined {
  const value = (record as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Where an agent CLI lives. Order: an explicit override from the environment (the first of
 * `envNames` that is set; if it names a missing file the PATH is searched next), then
 * `<dir>/<command>` for each PATH entry, then the agent's own install location.
 */
export function locateCli(spec: { envNames: readonly string[]; command: string; installed: () => string }): string | null {
  const override = spec.envNames.map((name) => process.env[name]).find((value) => !!value);
  const pathHits = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '')
    .map((dir) => join(dir, spec.command));
  for (const candidate of [override, ...pathHits]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const installed = spec.installed();
  return existsSync(installed) ? installed : null;
}
