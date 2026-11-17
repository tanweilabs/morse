/**
 * (ADR-088 §4) MORSE_ADDRESS=<name|address> in a process's environment says which of my addresses that process
 * uses when a command names none. It is meant for ONE session. It must never reach what works for the whole
 * home: the daemon, the plugins it supervises (attendant, dispatch, the WeChat bridge …) and the `morse`
 * commands those run. A daemon started from a shell that happens to export it would otherwise hand it on, and
 * every plugin would see — and answer — one address's mail only.
 *
 * Three independent guards:
 *   1. the daemon drops it from its own environment when it starts (so nothing it starts inherits it);
 *   2. every place that starts a plugin, or a `morse` command for a plugin, builds the environment without it;
 *   3. a `morse` command a plugin runs carries MORSE_BY_PLUGIN=1 and ignores the selector even if one is there.
 */

/** What in the environment selects one of my addresses for a process. */
export const ADDRESS_SELECTORS: readonly string[] = ['MORSE_ADDRESS'];

/** Set (to 1) in the environment of a `morse` command that a plugin runs: such a command never reads a selector. */
export const BY_PLUGIN = 'MORSE_BY_PLUGIN';

/** A copy of `env` without the address selectors. */
export function withoutAddressSelectors(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ADDRESS_SELECTORS) delete out[k];
  return out;
}

/** Take the address selectors out of THIS process's environment (the daemon, when it starts). */
export function dropAddressSelectors(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of ADDRESS_SELECTORS) delete env[k];
}

/** The environment of a `morse` command run for a plugin: no selector, and marked. */
export const pluginCommandEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({ ...withoutAddressSelectors(env), [BY_PLUGIN]: '1' });

/** Is this command run by a plugin (then no selector applies)? */
export const runByPlugin = (env: NodeJS.ProcessEnv = process.env): boolean => Boolean(env[BY_PLUGIN]);
