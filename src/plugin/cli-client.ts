import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pluginCommandEnv } from '../address-env.js';
import type { CoreClient, LeaseOptions, PluginMessage, ReplyOutcome } from './contract.js';
import type { CoreEvent } from './events.js';

/**
 * The plugin contract over the `morse` command (ADR-052) — what an out-of-process
 * plugin uses. `MORSE_CMD_JSON` (a JSON argv the daemon sets for the plugins it supervises)
 * or `MORSE_CMD` (space-separated) is the exact command to run; default `morse`.
 */

export function morseCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  // MORSE_CMD_JSON (a JSON argv, set by the daemon) survives paths with spaces
  try {
    const v = JSON.parse(env['MORSE_CMD_JSON'] ?? '') as unknown;
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v as string[];
  } catch {
    /* not set */
  }
  return (env['MORSE_CMD'] ?? 'morse').split(' ').filter(Boolean);
}

/** `morse …` commands this process started that have not finished yet. */
const running = new Map<Promise<unknown>, ChildProcess>();
let stopping = false;
export const STOPPING = 'this plugin is stopping — no new morse command is started';

export function runMorse(args: string[], cmd: string[] = morseCommand(), env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  if (stopping) return Promise.resolve({ code: 1, out: '', err: STOPPING });
  let child!: ChildProcess;
  const p = new Promise<{ code: number; out: string; err: string }>((resolve) => {
    // (ADR-088 §4) a plugin works for the whole home: its commands never carry MORSE_ADDRESS, whatever this process inherited
    child = execFile(cmd[0]!, [...cmd.slice(1), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: pluginCommandEnv(env ?? process.env) }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, out: stdout, err: stderr });
    });
  });
  running.set(p, child);
  void p.then(() => running.delete(p));
  return p;
}

/**
 * For a plugin that is stopping (SIGTERM from the daemon): from now on no new `morse`
 * command is started (runMorse answers with an error at once), and this resolves when the
 * ones in flight have finished. A command still running after `timeoutMs` is stopped
 * (SIGTERM; the daemon kills a plugin that has not stopped after 15 s) — so no command of a
 * plugin outlives it. Exiting at once instead left those commands running with nobody to
 * take their answer, still reading and writing the Morse home.
 */
export async function finishCommands(timeoutMs = 2000): Promise<void> {
  stopping = true;
  const settled = (ms: number) => Promise.race([Promise.allSettled([...running.keys()]), new Promise((r) => setTimeout(r, ms))]);
  const end = Date.now() + timeoutMs;
  while (running.size && Date.now() < end) await settled(Math.max(0, end - Date.now()));
  if (!running.size) return;
  for (const child of running.values()) child.kill();
  await settled(500);
}

const parse = <T>(r: { code: number; out: string; err: string }, what: string): T => {
  try {
    return JSON.parse(r.out) as T;
  } catch {
    throw new Error(`morse ${what}: ${r.err.trim() || r.out.trim() || `exit ${r.code}`}`);
  }
};

/** ADR-089: `--lease --pid <the plugin's own pid>` — the claiming `morse` command itself is gone at once. */
const leaseArgs = (lease: LeaseOptions | undefined): string[] =>
  lease ? ['--lease', '--pid', String(lease.pid ?? process.pid), ...(lease.ttlMs ? ['--ttl', String(lease.ttlMs / 1000)] : [])] : [];
const holderArgs = (holder: string | undefined): string[] => (holder ? ['--holder', holder] : []);
/** A report the core refused (`{"error": …}` — e.g. the lease was lost, ADR-089) rejects, as the in-process client does. */
const refused = (body: { error?: string }, what: string): void => {
  if (body.error) throw new Error(`morse ${what}: ${body.error}`);
};

export function createCliClient(opts: { cmd?: string[]; by?: string } = {}): CoreClient {
  const cmd = opts.cmd ?? morseCommand();
  const by = opts.by ?? 'plugin';
  const run = (args: string[]) => runMorse(args, cmd);
  return {
    async claimNext(o = {}) {
      const r = await run(['plugin', 'claim', '--next', '--json', ...leaseArgs(o.lease), ...(o.skipSessions?.length ? ['--skip-session', ...o.skipSessions] : []), ...(o.skipIds?.length ? ['--skip-id', ...o.skipIds] : [])]);
      return parse<{ message: PluginMessage | null }>(r, 'claim').message;
    },
    async claim(id, o = {}) {
      return parse<{ message: PluginMessage | null }>(await run(['plugin', 'claim', id, '--json', ...leaseArgs(o.lease)]), 'claim').message;
    },
    async ack(id, o = {}) {
      refused(parse<{ ok?: boolean; error?: string }>(await run(['plugin', 'ack', id, '--json', '--by', o.by ?? by, ...(o.inSession ? ['--in-session'] : []), ...holderArgs(o.holder)]), 'ack'), 'ack');
    },
    async nack(id, error, o = {}) {
      refused(parse<{ ok?: boolean; error?: string }>(await run(['plugin', 'nack', id, '--json', '--error', error, ...(o.terminal ? ['--terminal'] : []), ...holderArgs(o.holder)]), 'nack'), 'nack');
    },
    async release(id, o = {}) {
      parse(await run(['plugin', 'nack', id, '--json', '--release', ...holderArgs(o.holder)]), 'nack');
    },
    async toMailbox(id, note, o = {}) {
      return parse<{ ok: boolean }>(await run(['plugin', 'nack', id, '--json', '--to-mailbox', '--error', note, ...holderArgs(o.holder)]), 'nack').ok;
    },
    async extend(id, holder, o = {}) {
      const r = await run(['plugin', 'extend', id, '--json', '--holder', holder, ...(o.pid ? ['--pid', String(o.pid)] : []), ...(o.ttlMs !== undefined ? ['--ttl', String(o.ttlMs / 1000)] : []), ...(o.started ? ['--started'] : []), ...(o.maxMs ? ['--max', String(o.maxMs / 1000)] : [])]);
      return parse<{ ok: boolean }>(r, 'extend').ok === true;
    },
    async reply(id, text, o = {}): Promise<ReplyOutcome> {
      const r = await run(['reply', id, text, '--json', '--by', o.by ?? by, ...(o.via ? ['--via', o.via] : [])]);
      let body: { sent?: boolean; reason?: string; error?: string; message?: { id: string } };
      try {
        body = JSON.parse(r.out) as typeof body;
      } catch {
        return { ok: false, error: r.err.trim() || `exit ${r.code}` };
      }
      if (body.sent && body.message) return { ok: true, id: body.message.id };
      return { ok: false, error: body.error ?? `not sent (${body.reason ?? 'unknown'})`, ...(body.reason ? { reason: body.reason } : {}) };
    },
    async recover() {
      return parse<{ recovered: number }>(await run(['plugin', 'claim', '--recover', '--json']), 'claim').recovered;
    },
    async todo() {
      return parse<{ messages: PluginMessage[] }>(await run(['message', '--json']), 'message').messages ?? [];
    },
    async done(ids, o = {}) {
      if (!ids.length) return [];
      return parse<{ done?: string[] }>(await run(['done', ...ids, '--by', o.by ?? by, '--json']), 'done').done ?? [];
    },
  };
}

/** `morse plugin watch --json` as a stream of events. */
export function watchEvents(onEvent: (e: CoreEvent) => void, opts: { cmd?: string[]; since?: string; onExit?: (code: number | null) => void; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const cmd = opts.cmd ?? morseCommand();
  // MORSE_WATCH_PARENT: the watch command ends by itself once this process is gone — also when
  // we are killed and cannot stop it (it would otherwise go on polling with nobody reading)
  const env = { ...pluginCommandEnv(opts.env ?? process.env), MORSE_WATCH_PARENT: String(process.pid) };
  const child = spawn(cmd[0]!, [...cmd.slice(1), 'plugin', 'watch', '--json', ...(opts.since ? ['--since', opts.since] : [])], { stdio: ['ignore', 'pipe', 'inherit'], env });
  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    try {
      onEvent(JSON.parse(line) as CoreEvent);
    } catch {
      /* not an event line */
    }
  });
  child.on('exit', (code) => opts.onExit?.(code));
  return child;
}
